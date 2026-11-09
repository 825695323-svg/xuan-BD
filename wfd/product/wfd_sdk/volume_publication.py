#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R2a 精简版：把 R1 已准入请求的既有 engine 产物发布到受控 WFD 卷。

本模块**不**定义新的 manifest/snapshot/commit/receipt 协议，也不重新计算
snapshot id。它读取 R1 ``WFDDataOnlyService`` 在本机准备实例中已经完成
准入、登记、合同绑定、固定读回和 formal 记录的**原始** snapshot/manifest/
commit 字节，只做：

1. 真实挂载点/卷 UUID 检测（必须先于目标卷任何 mkdir）；
2. 用 R1 既有 service 复核原 request identity/fingerprint、原 snapshot/
   parent、四合同、已准入产品和本机固定读回；
3. 从准备实例取该请求新增对象闭包，保留原相对路径与原始字节；排除
   data_only_status/intent/plan、失败诊断、激活日志、暂存/缓存/锁等技术文件；
4. 在统一 writer lock 下复核目标卷、目标 HEAD/parent/writer host/epoch；
   copy + target read verify 数据、必要 metadata、manifest、snapshot；
5. 复制**原** commit marker，调用 ``StateStore.activate`` 激活原 snapshot id；
6. 用真实 ``WFDDataOnlyService`` 从目标卷做 fixed read，并复制/核对 R1
   原 formal publication record。

边界：
- 支持目标为空的单批新库；另外支持目标 HEAD 恰为输入 parent、且 parent
  chain 已在目标卷存在的简单增量。需要旧库前驱视图/缺失旧对象的复杂增量
  不在本批，返回明确诊断而不是重建另一套库。
- 本模块不迁移旧含 source 的库；closure 只来自 R1 formal snapshot 的绑定
  和合同/定义引用，不递归复制整个 catalog。
- 本批不改 ``duckdb_sdk/product_service/data_service/query/machine/state/
  writerlock``；共享 core 的精确接缝见报告。
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import plistlib
import re
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

from wfd_sdk.state import StateError, StateStore
from wfd_sdk.writerlock import WriterBusy, writer_lock

FORMAT_BINDING = "wfd.volume_binding/1.0"
_SNAPSHOT_RE = re.compile(r"^s_[0-9a-f]{24}$")
_CONTRACT_ROLES = {"semantic", "read_layout", "algorithm_dependency", "update_release"}
_CONTRACT_ROLE_BODY = {
    "semantic": "semantic",
    "read_layout": "read",
    "algorithm_dependency": "compute_dependencies",
    "update_release": "publication",
}
_TECHNICAL_SUFFIXES = (
    ".sqlite", ".sqlite3", ".db", ".db-wal", ".db-shm", ".wal", ".shm",
    ".log", ".tmp", ".lock",
)
# 仅排除本机活跃 request 状态、镜像日志和技术目录；不做业务字段递归黑名单。
_EXCLUDED_PREFIXES = (
    "catalog/product_service/data_only_status/",
    "catalog/product_service/data_only_intents/",
    "catalog/product_service/data_only_submission_plans/",
    "catalog/activation_log.jsonl",
    "catalog/.writer.lock",
    "catalog/recovery/",
    "catalog/forks/",
    "catalog/lineage/",
    "_staging/",
    "evidence/",
)
_KIND_ORDER = {
    "data": 0, "contract": 1, "definition": 2, "definition_version": 3,
    "contract_bundle": 4, "manifest": 5, "snapshot": 6,
    "commit": 7, "formal_receipt": 8, "retention": 9,
}


class VolumeError(RuntimeError):
    def __init__(self, code: str, detail: str = "", *, path: str | Path | None = None):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail
        self.path = str(path) if path is not None else None

    def as_dict(self) -> dict:
        out = {"code": self.code, "detail": self.detail}
        if self.path is not None:
            out["path"] = self.path
        return out


class PreparationError(RuntimeError):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail

    def as_dict(self) -> dict:
        return {"code": self.code, "detail": self.detail}


class PublicationError(RuntimeError):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail

    def as_dict(self) -> dict:
        return {"code": self.code, "detail": self.detail}


# --------------------------------------------------------------------------- 基础
def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def canonical(data: Any) -> bytes:
    return json.dumps(
        data, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _digest_hex(value: str) -> str:
    digest = str(value or "").split(":")[-1]
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise PreparationError("DIGEST_INVALID", str(value))
    return digest


def _path_within(child: str | Path, parent: str | Path) -> bool:
    try:
        c = Path(child).resolve()
        p = Path(parent).resolve()
    except OSError:
        return False
    return c == p or p in c.parents


def _lstat_regular(path: Path) -> os.stat_result:
    st = os.lstat(path)
    if stat.S_ISLNK(st.st_mode):
        raise PreparationError("SYMLINK_NOT_ALLOWED", str(path))
    if not stat.S_ISREG(st.st_mode):
        raise PreparationError("NOT_A_REGULAR_FILE", str(path))
    return st


def _safe_relpath(relpath: str) -> str:
    if not isinstance(relpath, str) or not relpath:
        raise PreparationError("REL_PATH_INVALID", "empty")
    if relpath != relpath.strip() or "\\" in relpath:
        raise PreparationError("REL_PATH_INVALID", relpath)
    p = PurePosixPath(relpath)
    if p.is_absolute() or p.as_posix() != relpath:
        raise PreparationError("REL_PATH_INVALID", relpath)
    if any(part in ("", ".", "..") for part in p.parts):
        raise PreparationError("REL_PATH_INVALID", relpath)
    name = p.name
    if name.startswith("._") or name in (".DS_Store",):
        raise PreparationError("REL_PATH_METADATA_FILE", relpath)
    if name.lower().endswith(_TECHNICAL_SUFFIXES):
        raise PreparationError("REL_PATH_TECHNICAL_FILE", relpath)
    if any(relpath == prefix.rstrip("/") or relpath.startswith(prefix)
           for prefix in _EXCLUDED_PREFIXES):
        raise PreparationError("REL_PATH_LOCAL_STATE", relpath)
    return relpath


def _reject_symlink_path(root: Path, relpath: str) -> None:
    current = root
    for part in PurePosixPath(relpath).parts:
        current = current / part
        if current.is_symlink():
            raise PublicationError("SYMLINK_NOT_ALLOWED", str(current))


def _atomic_write(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise OSError(f"拒绝写入符号链接 {path}")
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as exc:
        raise PreparationError("JSON_UNREADABLE", f"{path}: {exc}") from exc


def _fixed_product_identity(product: Mapping[str, Any]) -> str:
    """Hash only the fields that determine a product's fixed closure files."""
    return sha256_bytes(canonical({
        "product_id": product.get("product_id"),
        "dataset_id": product.get("dataset_id"),
        "declaration": product.get("declaration"),
        "definition_ref": product.get("definition_ref"),
        "definition_parent_ref": product.get("definition_parent_ref"),
        "definition_sequence": product.get("definition_sequence"),
        "contract_ref": product.get("contract_ref"),
        "contract_refs": product.get("contract_refs"),
        "contract_bundle_ref": product.get("contract_bundle_ref"),
        "contracts": product.get("contracts"),
    }))


def _snapshot_fixed_products(snapshot: Mapping[str, Any]) -> list[dict]:
    """Collect the product object pinned by each cumulative snapshot entry.

    A snapshot retains earlier file entries with their original
    ``source_bundle``.  Those entries, not the current request's
    ``output_results`` and not the latest flat registration file, are the
    authority for which contract/definition object belongs to a file.  The
    same product id may legitimately carry more than one fixed contract
    bundle (for example after an accepted definition/contract change), so the
    stable identity here is ``(product_id, contract_bundle digest)`` rather
    than pid alone.
    """
    entries = snapshot.get("files")
    if not isinstance(entries, list):
        raise PreparationError("SNAPSHOT_FILE_LIST_INVALID", "files")
    fixed: dict[tuple[str, str], dict] = {}
    for index, entry in enumerate(entries):
        if not isinstance(entry, Mapping):
            raise PreparationError("SNAPSHOT_FILE_ENTRY_INVALID", f"files[{index}]")
        pid = entry.get("product_id")
        output_key = entry.get("output_key")
        if not isinstance(pid, str) or not pid:
            raise PreparationError("SNAPSHOT_PRODUCT_ID_INVALID", f"files[{index}]")
        if not isinstance(output_key, str) or not output_key:
            raise PreparationError("SNAPSHOT_OUTPUT_KEY_INVALID", f"files[{index}]")
        carrier = entry.get("source_bundle")
        if not isinstance(carrier, Mapping):
            raise PreparationError("SNAPSHOT_PRODUCT_BINDING_MISSING",
                                   f"{pid}:{output_key}")
        bindings = carrier.get("_wfd_product_bindings")
        if not isinstance(bindings, Mapping):
            raise PreparationError("SNAPSHOT_PRODUCT_BINDING_MISSING",
                                   f"{pid}:{output_key}")
        binding = bindings.get(output_key)
        product = binding.get("product") if isinstance(binding, Mapping) else None
        if not isinstance(product, Mapping) or product.get("product_id") != pid:
            raise PreparationError("SNAPSHOT_PRODUCT_BINDING_MISMATCH",
                                   f"{pid}:{output_key}")
        resolved = (carrier.get("_wfd_resolved_product_ids") or {}).get(output_key)
        if resolved is not None and resolved != pid:
            raise PreparationError("SNAPSHOT_PRODUCT_BINDING_MISMATCH",
                                   f"{pid}:{output_key}:resolved={resolved!r}")
        bundle_ref = product.get("contract_bundle_ref")
        try:
            bundle_digest = _digest_hex((bundle_ref or {}).get("digest", ""))
        except PreparationError as exc:
            raise PreparationError(
                "SNAPSHOT_CONTRACT_BUNDLE_DIGEST_INVALID",
                f"{pid}:{output_key}:{exc.detail}",
            ) from exc
        key = (pid, bundle_digest)
        prior = fixed.get(key)
        if prior is not None:
            # Same fixed closure identity is deduplicated even when unrelated
            # entry metadata (for example bundle_target provenance) differs.
            # Any disagreement in contract/definition identity rejects rather
            # than silently taking the first or last entry.
            if _fixed_product_identity(prior) != _fixed_product_identity(product):
                raise PreparationError(
                    "SNAPSHOT_PRODUCT_BINDING_CONFLICT", f"{pid}:{bundle_digest}"
                )
            continue
        fixed[key] = copy.deepcopy(dict(product))
    if not fixed:
        raise PreparationError("SNAPSHOT_PRODUCT_CLOSURE_EMPTY", "snapshot files")
    return [fixed[key] for key in sorted(fixed)]


def _add_product_closure(add, product: Mapping[str, Any], prep_root: Path) -> None:
    """Add one fixed product's real contract/definition files to the closure.

    Everything is located from the product object embedded in the snapshot
    entry.  The function never reads the flat current registration to fill
    gaps and never replaces an earlier fixed object with a later pid record.
    Missing files or a digest/body mismatch reject preparation before any
    target write.
    """
    pid = str(product.get("product_id") or "")
    if not pid:
        raise PreparationError("R1_PRODUCT_ID_MISSING", "fixed product")
    dataset_id = str(product.get("dataset_id") or "")
    if not dataset_id:
        raise PreparationError("R1_DATASET_ID_MISSING", pid)
    refs = product.get("contract_refs")
    if not isinstance(refs, Mapping) or set(refs) != _CONTRACT_ROLES:
        raise PreparationError("R1_FOUR_CONTRACT_ROLES_MISMATCH", pid)
    contracts = product.get("contracts")
    if not isinstance(contracts, Mapping):
        raise PreparationError("R1_CONTRACT_BODY_MISSING", pid)

    bundle_ref = product.get("contract_bundle_ref")
    if not isinstance(bundle_ref, Mapping):
        raise PreparationError("R1_CONTRACT_BUNDLE_REF_MISSING", pid)
    bundle_digest = _digest_hex(bundle_ref.get("digest", ""))
    if sorted(bundle_ref.get("roles") or []) != sorted(refs):
        raise PreparationError("R1_CONTRACT_BUNDLE_ROLES_MISMATCH", pid)
    if (bundle_ref.get("id") != "cb_" + bundle_digest[:24]
            or bundle_ref.get("version") != "v_" + bundle_digest[:16]
            or bundle_ref.get("dataset_id") != dataset_id):
        raise PreparationError("R1_CONTRACT_BUNDLE_REF_MISMATCH", pid)

    for role, ref in refs.items():
        if not isinstance(ref, Mapping):
            raise PreparationError("R1_CONTRACT_REF_INVALID", f"{pid}:{role}")
        digest = _digest_hex(ref.get("digest", ""))
        stable = sha256_bytes(canonical([dataset_id, pid, role]))[:24]
        if (ref.get("role") != role or ref.get("dataset_id") != dataset_id
                or ref.get("kind") != "contract"
                or ref.get("id") != "contract_" + role + "_" + stable
                or ref.get("version") != "v_" + digest[:16]):
            raise PreparationError("R1_CONTRACT_REF_MISMATCH", f"{pid}:{role}")
        rel = f"catalog/product_service/contracts/{role}/{digest}.json"
        add(rel, "contract", digest)
        stored = _read_json(prep_root / rel)
        body_key = _CONTRACT_ROLE_BODY[role]
        if canonical(stored) != canonical(contracts.get(body_key)):
            raise PreparationError("R1_CONTRACT_BODY_MISMATCH", f"{pid}:{role}")

    bundle_rel = f"catalog/product_service/contract_bundles/{bundle_digest}.json"
    add(bundle_rel, "contract_bundle", bundle_digest)
    expected_bundle = {
        "format_version": "wfd.contract-bundle/1.0", "product_id": pid,
        "dataset_id": dataset_id, "roles": sorted(refs),
        "contracts": {role: refs[role] for role in sorted(refs)},
    }
    if canonical(_read_json(prep_root / bundle_rel)) != canonical(expected_bundle):
        raise PreparationError("R1_CONTRACT_BUNDLE_BODY_MISMATCH", pid)

    definition_ref = product.get("definition_ref")
    if not isinstance(definition_ref, Mapping):
        raise PreparationError("R1_DEFINITION_REF_MISSING", pid)
    definition_digest = _digest_hex(definition_ref.get("digest", ""))
    if (definition_ref.get("dataset_id") != dataset_id
            or definition_ref.get("id") != "def_" + definition_digest[:24]
            or definition_ref.get("version") != "v_" + definition_digest[:16]):
        raise PreparationError("R1_DEFINITION_REF_MISMATCH", pid)
    definition_rel = f"catalog/product_service/definitions/{definition_digest}.json"
    add(definition_rel, "definition")
    expected_definition = {
        "definition_ref": definition_ref,
        "declaration": product.get("declaration"),
    }
    if canonical(_read_json(prep_root / definition_rel)) != canonical(expected_definition):
        raise PreparationError("R1_DEFINITION_BODY_MISMATCH", pid)

    parent_ref = product.get("definition_parent_ref") or {}
    if parent_ref.get("digest"):
        parent_digest = _digest_hex(parent_ref.get("digest"))
        parent_rel = f"catalog/product_service/definitions/{parent_digest}.json"
        add(parent_rel, "definition")
        parent_body = _read_json(prep_root / parent_rel)
        if ((parent_body.get("definition_ref") or {}).get("digest")
                != parent_ref.get("digest")
                or "sha256:" + sha256_bytes(canonical(parent_body.get("declaration")))
                != parent_digest):
            raise PreparationError("R1_DEFINITION_PARENT_BINDING_MISMATCH", parent_rel)

    sequence = product.get("definition_sequence")
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 1:
        raise PreparationError("R1_DEFINITION_SEQUENCE_INVALID", f"{pid}:{sequence!r}")
    version_rel = (f"catalog/product_service/products/{pid}/"
                   f"definition_{sequence}.json")
    add(version_rel, "definition_version")
    version_record = _read_json(prep_root / version_rel)
    if (version_record.get("product_id") != pid
            or version_record.get("definition_sequence") != sequence
            or (version_record.get("definition_ref") or {}).get("digest")
            != definition_ref.get("digest")
            or canonical(version_record.get("contracts")) != canonical(contracts)
            or canonical(version_record.get("declaration"))
            != canonical(product.get("declaration"))):
        raise PreparationError("R1_DEFINITION_VERSION_BINDING_MISMATCH", version_rel)

    legacy_ref = product.get("contract_ref")
    if not isinstance(legacy_ref, Mapping):
        raise PreparationError("R1_COMPAT_CONTRACT_REF_MISSING", pid)
    legacy_digest = _digest_hex(legacy_ref.get("digest", ""))
    if legacy_digest != sha256_bytes(canonical(contracts)):
        raise PreparationError("R1_COMPAT_CONTRACT_DIGEST_MISMATCH", pid)
    if (legacy_ref.get("dataset_id") != dataset_id
            or legacy_ref.get("id") != "contract_" + legacy_digest[:24]
            or legacy_ref.get("version") != "v_" + legacy_digest[:16]):
        raise PreparationError("R1_COMPAT_CONTRACT_REF_MISMATCH", pid)
    legacy_rel = f"catalog/product_service/contracts/{legacy_digest}.json"
    add(legacy_rel, "contract")
    expected_legacy = {"contract_ref": legacy_ref, "contracts": contracts}
    if canonical(_read_json(prep_root / legacy_rel)) != canonical(expected_legacy):
        raise PreparationError("R1_COMPAT_CONTRACT_BODY_MISMATCH", pid)


# --------------------------------------------------------------------------- 卷检测
@dataclass(frozen=True)
class DetectedVolume:
    mount_point: str
    volume_uuid: str
    filesystem: str
    device: str | None = None
    identity_source: str = "unknown"
    writable: bool = True

    @property
    def normalized_uuid(self) -> str:
        return str(self.volume_uuid).strip().strip("{}").upper()

    def as_dict(self) -> dict:
        out = {
            "mount_point": self.mount_point, "volume_uuid": self.normalized_uuid,
            "filesystem": self.filesystem.lower(), "identity_source": self.identity_source,
            "writable": self.writable,
        }
        if self.device:
            out["device"] = self.device
        return out


class VolumeDetector:
    def detect(self, mount_point: str | Path) -> DetectedVolume:
        raise NotImplementedError

    def verify(self, mount_point: str | Path, *, expected_uuid: str,
               filesystem: str = "exfat", require_writable: bool = True) -> DetectedVolume:
        det = self.detect(mount_point)
        requested = Path(mount_point).resolve()
        if Path(det.mount_point).resolve() != requested:
            raise VolumeError("VOLUME_MOUNT_MISMATCH", str(det.mount_point), path=mount_point)
        want = str(expected_uuid).strip().strip("{}").upper()
        if det.normalized_uuid != want:
            raise VolumeError("VOLUME_UUID_MISMATCH",
                              f"期望 {want}，实际 {det.normalized_uuid}", path=mount_point)
        if det.filesystem.lower() != str(filesystem).lower():
            raise VolumeError("VOLUME_FILESYSTEM_MISMATCH", det.filesystem, path=mount_point)
        if require_writable and not det.writable:
            raise VolumeError("VOLUME_NOT_WRITABLE", "卷不可写", path=mount_point)
        return det


class SystemVolumeDetector(VolumeDetector):
    """macOS 真实设备检测；其他平台明确不支持，不退回路径存在判断。"""

    def detect(self, mount_point: str | Path) -> DetectedVolume:
        p = Path(mount_point)
        if not p.is_absolute():
            raise VolumeError("VOLUME_PATH_INVALID", "必须绝对路径", path=p)
        try:
            st = p.stat()
        except OSError as exc:
            raise VolumeError("VOLUME_NOT_MOUNTED", str(exc), path=p) from exc
        if not stat.S_ISDIR(st.st_mode):
            raise VolumeError("VOLUME_NOT_MOUNTED", "不是目录", path=p)
        rp = p.resolve()
        if not os.path.ismount(str(rp)):
            raise VolumeError("VOLUME_NOT_MOUNTED", "路径不是挂载点", path=p)
        if sys.platform != "darwin":
            raise VolumeError("VOLUME_DETECTOR_UNSUPPORTED",
                              f"本精简版只实现 macOS diskutil，当前 {sys.platform}", path=p)
        try:
            proc = subprocess.run(
                ["diskutil", "info", "-plist", str(rp)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise VolumeError("VOLUME_IDENTITY_UNAVAILABLE", str(exc), path=rp) from exc
        if proc.returncode != 0:
            raise VolumeError("VOLUME_IDENTITY_UNAVAILABLE",
                              proc.stderr.decode("utf-8", "replace")[:300], path=rp)
        try:
            info = plistlib.loads(proc.stdout)
        except Exception as exc:  # plistlib 异常类型随版本不同
            raise VolumeError("VOLUME_IDENTITY_UNREADABLE", str(exc), path=rp) from exc
        mount_value = info.get("MountPoint")
        if not mount_value:
            raise VolumeError("VOLUME_NOT_MOUNTED", "diskutil 无 MountPoint", path=rp)
        if Path(str(mount_value)).resolve() != rp:
            raise VolumeError("VOLUME_MOUNT_MISMATCH", str(mount_value), path=rp)
        uuid = info.get("VolumeUUID")
        if not uuid:
            raise VolumeError("VOLUME_UUID_UNAVAILABLE", "设备无 VolumeUUID", path=rp)
        fs = str(info.get("FilesystemType") or "").lower()
        if not fs:
            raise VolumeError("VOLUME_FILESYSTEM_UNAVAILABLE", "设备无文件系统", path=rp)
        return DetectedVolume(
            mount_point=str(rp), volume_uuid=str(uuid).strip().strip("{}").upper(),
            filesystem=fs, device=str(info.get("DeviceIdentifier") or "") or None,
            identity_source="diskutil", writable=bool(info.get("WritableVolume") is not False),
        )


# --------------------------------------------------------------------------- 绑定/配置
@dataclass(frozen=True)
class VolumeBinding:
    mount_point: str
    volume_uuid: str
    writer_host: str
    writer_epoch: int = 0
    filesystem: str = "exfat"
    instance_id: str = ""

    def __post_init__(self) -> None:
        p = Path(self.mount_point)
        if not p.is_absolute():
            raise ValueError("VOLUME_MOUNT_INVALID")
        if not self.writer_host or not isinstance(self.writer_host, str):
            raise ValueError("WRITER_HOST_INVALID")
        host = self.writer_host.strip()
        if len(host) > 128 or any(ch in host for ch in ("/", "\\", "\x00")):
            raise ValueError("WRITER_HOST_INVALID")
        if isinstance(self.writer_epoch, bool) or not isinstance(self.writer_epoch, int) or self.writer_epoch < 0:
            raise ValueError("WRITER_EPOCH_INVALID")
        fs = str(self.filesystem).lower()
        if fs != "exfat":
            raise ValueError("VOLUME_FILESYSTEM_UNSUPPORTED")
        uuid = str(self.volume_uuid).strip().strip("{}").upper()
        if not re.fullmatch(r"^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$", uuid):
            raise ValueError("VOLUME_UUID_INVALID")
        if not self.instance_id:
            digest = sha256_bytes(canonical({"mount": str(p.resolve()), "uuid": uuid}))[:16]
            object.__setattr__(self, "instance_id", f"wfd-instance-{digest}")
        elif not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", self.instance_id):
            raise ValueError("INSTANCE_ID_INVALID")
        object.__setattr__(self, "volume_uuid", uuid)
        object.__setattr__(self, "filesystem", fs)
        object.__setattr__(self, "writer_host", host)

    def to_dict(self) -> dict:
        return {
            "mount_point": self.mount_point, "volume_uuid": self.volume_uuid,
            "filesystem": self.filesystem, "writer_host": self.writer_host,
            "writer_epoch": self.writer_epoch, "instance_id": self.instance_id,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "VolumeBinding":
        allowed = {"mount_point", "volume_uuid", "filesystem", "writer_host",
                   "writer_epoch", "instance_id"}
        extra = sorted(set(data) - allowed)
        if extra:
            raise ValueError("VOLUME_BINDING_FIELDS_UNEXPECTED:" + ",".join(extra))
        return cls(
            mount_point=str(data["mount_point"]), volume_uuid=str(data["volume_uuid"]),
            filesystem=str(data.get("filesystem", "exfat")),
            writer_host=str(data["writer_host"]), writer_epoch=int(data["writer_epoch"]),
            instance_id=str(data.get("instance_id", "")),
        )


class VolumeConfigStore:
    """本机卷绑定配置；load/save 都先真实核卷。"""

    def __init__(self, path: str | Path, *, detector: VolumeDetector | None = None):
        self.path = Path(path)
        self.detector = detector or SystemVolumeDetector()

    def save(self, binding: VolumeBinding) -> DetectedVolume:
        det = self.detector.verify(binding.mount_point, expected_uuid=binding.volume_uuid,
                                   filesystem=binding.filesystem)
        if _path_within(self.path, binding.mount_point):
            raise VolumeError("VOLUME_CONFIG_INSIDE_VOLUME", str(self.path), path=self.path)
        payload = {"format_version": FORMAT_BINDING, "binding": binding.to_dict(),
                   "last_verified": det.as_dict(), "verified_at_utc": _now()}
        _atomic_write(self.path, canonical(payload) + b"\n")
        return det

    def load(self) -> VolumeBinding:
        if self.path.is_symlink():
            raise VolumeError("VOLUME_CONFIG_SYMLINK", str(self.path), path=self.path)
        if not self.path.is_file():
            raise VolumeError("VOLUME_CONFIG_MISSING", str(self.path), path=self.path)
        try:
            data = json.loads(self.path.read_text("utf-8"))
        except (OSError, ValueError) as exc:
            raise VolumeError("VOLUME_CONFIG_UNREADABLE", str(exc), path=self.path) from exc
        if data.get("format_version") != FORMAT_BINDING:
            raise VolumeError("VOLUME_CONFIG_FORMAT", str(data.get("format_version")), path=self.path)
        try:
            binding = VolumeBinding.from_dict(data.get("binding") or {})
        except (KeyError, TypeError, ValueError) as exc:
            raise VolumeError("VOLUME_CONFIG_INVALID", str(exc), path=self.path) from exc
        self.detector.verify(binding.mount_point, expected_uuid=binding.volume_uuid,
                             filesystem=binding.filesystem)
        return binding


class LocalMirrorStateStore(StateStore):
    """StateStore 的 activation_history 留在 state.json；镜像日志写本机。"""

    def __init__(self, root: str | Path, runtime_root: str | Path):
        super().__init__(Path(root))
        self.activation_log = Path(runtime_root) / "state" / "activation_log.jsonl"


# --------------------------------------------------------------------------- 输入
@dataclass(frozen=True)
class PreparationInstance:
    """R1 本机准备实例的明确身份；不接收任意 ObjectSpec。"""
    prep_root: Path
    request_identity: Mapping[str, Any]
    snapshot_id: str
    expected_parent: str | None = None
    protocol_root: Path | None = None
    unit_registry: Mapping[str, Any] = field(default_factory=dict)
    trusted_actor_namespaces: tuple[str, ...] = ()
    caller_roles: tuple[str, ...] = ("read",)
    caller_id: str = "volume-prep"
    request_document: Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        prep = Path(self.prep_root)
        if not prep.is_absolute():
            object.__setattr__(self, "prep_root", prep.resolve())
        if not isinstance(self.request_identity, Mapping):
            raise ValueError("REQUEST_IDENTITY_INVALID")
        for key in ("dataset_id", "trusted_actor_namespace", "request_id"):
            if not str(self.request_identity.get(key) or "").strip():
                raise ValueError(f"REQUEST_IDENTITY_MISSING:{key}")
        if not _SNAPSHOT_RE.fullmatch(str(self.snapshot_id)):
            raise ValueError("SNAPSHOT_ID_INVALID")
        if self.expected_parent is not None and not _SNAPSHOT_RE.fullmatch(str(self.expected_parent)):
            raise ValueError("EXPECTED_PARENT_INVALID")
        if self.request_document is not None:
            if not isinstance(self.request_document, Mapping):
                raise ValueError("REQUEST_DOCUMENT_INVALID")
            if dict(self.request_document.get("request_identity") or {}) != dict(self.request_identity):
                raise ValueError("REQUEST_DOCUMENT_IDENTITY_MISMATCH")
            parent = self.request_document.get("expected_parent_snapshot_id")
            if self.expected_parent is not None and parent != self.expected_parent:
                raise ValueError("REQUEST_DOCUMENT_PARENT_MISMATCH")
        protocol = Path(self.protocol_root) if self.protocol_root is not None else (
            Path(__file__).resolve().parent.parent / "protocol"
        )
        object.__setattr__(self, "protocol_root", protocol)
        namespaces = tuple(self.trusted_actor_namespaces) or (
            str(self.request_identity["trusted_actor_namespace"]),
        )
        object.__setattr__(self, "trusted_actor_namespaces", namespaces)


@dataclass(frozen=True)
class PrepFile:
    relpath: str
    sha256: str
    size: int
    kind: str

    def as_dict(self) -> dict:
        return {"relpath": self.relpath, "sha256": self.sha256,
                "size": self.size, "kind": self.kind}


@dataclass(frozen=True)
class PreparationSummary:
    instance: PreparationInstance
    request_key: str
    input_fingerprint: str
    snapshot_id: str
    parent_snapshot_id: str | None
    snapshot_sha256: str
    manifest_relpath: str
    manifest_sha256: str
    commit_relpath: str
    commit_sha256: str
    formal_relpath: str
    formal_sha256: str
    files: tuple[PrepFile, ...]
    output_results: tuple[dict, ...]
    status: Mapping[str, Any]

    def file_map(self) -> dict[str, PrepFile]:
        return {item.relpath: item for item in self.files}


# --------------------------------------------------------------------------- 发布
class VolumePublisher:
    def __init__(self, *, binding: VolumeBinding, runtime_root: str | Path,
                 detector: VolumeDetector | None = None, fault_injector=None,
                 prep_writer_host: str = "volume-prep-read"):
        if not isinstance(binding, VolumeBinding):
            raise TypeError("binding must be VolumeBinding")
        self.binding = binding
        self.root = Path(binding.mount_point)
        self.runtime_root = Path(runtime_root)
        if _path_within(self.runtime_root, self.root):
            raise VolumeError("VOLUME_RUNTIME_INSIDE_VOLUME", str(self.runtime_root),
                              path=self.runtime_root)
        self.detector = detector or SystemVolumeDetector()
        self.fault_injector = fault_injector
        self.prep_writer_host = prep_writer_host
        self.state = LocalMirrorStateStore(self.root, self.runtime_root)

    def _inject(self, stage: str, **details) -> None:
        if self.fault_injector is not None:
            self.fault_injector(stage, details)

    # ------------------------------------------------------------------ 本机准备复核
    def prepare(self, instance: PreparationInstance) -> PreparationSummary:
        if not isinstance(instance, PreparationInstance):
            raise TypeError("instance must be PreparationInstance")
        from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
        from wfd_sdk.product_data_service import WFDDataOnlyService

        prep_root = Path(instance.prep_root)
        if prep_root.is_symlink() or not prep_root.is_dir():
            raise PreparationError("PREP_ROOT_INVALID", str(prep_root))
        if _path_within(prep_root, self.root):
            raise PreparationError("PREP_ROOT_IN_TARGET_VOLUME", str(prep_root))
        prep_runtime = self.runtime_root / "prep_runtime" / sha256_bytes(
            canonical(str(prep_root))
        )[:16]
        try:
            engine = WFDDuckDBPrototype(
                prep_root, load_protocol_validator(Path(instance.protocol_root)),
                runtime_root=prep_runtime, sandbox=False, writer_host=self.prep_writer_host,
            )
            service = WFDDataOnlyService(
                engine, caller_roles=tuple(instance.caller_roles), caller_id=instance.caller_id,
                unit_registry=dict(instance.unit_registry),
                trusted_actor_namespaces=set(instance.trusted_actor_namespaces),
            )
        except Exception as exc:
            raise PreparationError("R1_SERVICE_OPEN_FAILED",
                                   f"{type(exc).__name__}: {exc}") from exc
        identity = dict(instance.request_identity)
        key = engine._request_key({"request_identity": identity})
        try:
            status = service.request_status(identity)
        except Exception as exc:
            raise PreparationError("R1_STATUS_READ_FAILED",
                                   f"{type(exc).__name__}: {exc}") from exc
        if status.get("state") not in {"published_formal", "partially_published_formal"}:
            raise PreparationError(
                "R1_NOT_FORMAL", f"state={status.get('state')!r}, snapshot={status.get('snapshot_id')!r}"
            )
        if status.get("request_key") != key:
            raise PreparationError("R1_REQUEST_KEY_MISMATCH", str(status.get("request_key")))
        if status.get("snapshot_id") != instance.snapshot_id:
            raise PreparationError(
                "R1_SNAPSHOT_MISMATCH",
                f"status={status.get('snapshot_id')!r} input={instance.snapshot_id!r}",
            )
        checks = status.get("formal_publication_checks") or {}
        required_checks = {
            "snapshot_present", "commit_marker_present", "valid_commit",
            "contracts_verified", "record_identity_verified",
            "fixed_readback_verified", "engine_not_sandbox", "caller_publish_role",
        }
        if (not checks
                or not all(checks.get(name) is True for name in required_checks)
                or not (checks.get("active_head_matches") is True
                        or checks.get("historically_activated") is True)):
            raise PreparationError("R1_FORMAL_CHECK_FAILED", str(checks))
        formal_rel = status.get("formal_publication_ref")
        if not formal_rel:
            raise PreparationError("R1_FORMAL_RECEIPT_MISSING", key)

        status_record = _read_json(
            prep_root / f"catalog/product_service/data_only_status/{key}.json")
        intent_record = _read_json(
            prep_root / f"catalog/product_service/data_only_intents/{key}.json")
        plan_record = _read_json(
            prep_root / f"catalog/product_service/data_only_submission_plans/{key}.json")
        fingerprint = str(status_record.get("input_fingerprint") or "")
        if not fingerprint:
            raise PreparationError("R1_FINGERPRINT_MISSING", key)
        if instance.request_document is not None:
            expected_fingerprint = sha256_bytes(canonical(dict(instance.request_document)))
            if expected_fingerprint != fingerprint:
                raise PreparationError(
                    "REQUEST_FINGERPRINT_MISMATCH",
                    f"{expected_fingerprint} != {fingerprint}",
                )
        for label, record in (("intent", intent_record), ("plan", plan_record)):
            if record.get("request_key") != key or record.get("input_fingerprint") != fingerprint:
                raise PreparationError("R1_FINGERPRINT_MISMATCH", label)
            if dict(record.get("request_identity") or {}) != identity:
                raise PreparationError("R1_REQUEST_IDENTITY_MISMATCH", label)

        try:
            snapshot = engine.read_snapshot(instance.snapshot_id)
        except Exception as exc:
            raise PreparationError("R1_SNAPSHOT_READ_FAILED",
                                   f"{type(exc).__name__}: {exc}") from exc
        snapshot_rel = f"catalog/snapshots/{instance.snapshot_id}.json"
        snapshot_raw = (prep_root / snapshot_rel).read_bytes()
        snapshot_sha = sha256_bytes(snapshot_raw)
        commit_rel = f"catalog/commits/{instance.snapshot_id}.json"
        commit_raw = (prep_root / commit_rel).read_bytes()
        commit = json.loads(commit_raw.decode("utf-8"))
        if str(commit.get("snapshot_file", "")).startswith("wfd.snapshot-file/"):
            raise PreparationError("ROW_VERSION_OBJECT_OPERATION_UNSUPPORTED", "volume publication")
        if commit.get("snapshot_id") != instance.snapshot_id:
            raise PreparationError("COMMIT_SNAPSHOT_ID_MISMATCH", str(commit.get("snapshot_id")))
        if commit.get("snapshot_file") != snapshot_rel:
            raise PreparationError("COMMIT_SNAPSHOT_PATH_MISMATCH", str(commit.get("snapshot_file")))
        if commit.get("snapshot_sha256") != snapshot_sha:
            raise PreparationError("COMMIT_SNAPSHOT_DIGEST_MISMATCH", str(commit.get("snapshot_sha256")))
        manifest_rel = snapshot.get("manifest_relpath")
        _safe_relpath(str(manifest_rel))
        manifest_raw = (prep_root / str(manifest_rel)).read_bytes()
        manifest_sha = sha256_bytes(manifest_raw)
        manifest = json.loads(manifest_raw.decode("utf-8"))
        if snapshot.get("manifest_sha256") != manifest_sha:
            raise PreparationError("SNAPSHOT_MANIFEST_DIGEST_MISMATCH", str(manifest_rel))
        if manifest.get("files") != snapshot.get("files"):
            raise PreparationError("MANIFEST_FILE_LIST_MISMATCH", str(manifest_rel))
        if snapshot.get("snapshot_id") != instance.snapshot_id:
            raise PreparationError("SNAPSHOT_ID_MISMATCH", str(snapshot.get("snapshot_id")))
        if str(snapshot.get("request_key") or "") != key:
            raise PreparationError("SNAPSHOT_REQUEST_KEY_MISMATCH", str(snapshot.get("request_key")))
        parent = snapshot.get("parent_snapshot_id")
        if plan_record.get("parent_snapshot_id") != parent:
            raise PreparationError("PLAN_PARENT_MISMATCH", str(plan_record.get("parent_snapshot_id")))
        if instance.expected_parent is not None and instance.expected_parent != parent:
            raise PreparationError(
                "EXPECTED_PARENT_MISMATCH", f"input={instance.expected_parent!r} snapshot={parent!r}"
            )

        output_results = [item for item in service._publication_results(status_record.get("output_results", []))
                          if item.get("publication_state") == "published_formal"]
        if not output_results:
            raise PreparationError("R1_NO_FORMAL_OUTPUTS", key)
        fixed_products = _snapshot_fixed_products(snapshot)
        fixed_by_pid: dict[str, list[dict]] = {}
        for product in fixed_products:
            fixed_by_pid.setdefault(str(product["product_id"]), []).append(product)
        for item in output_results:
            if item.get("errors"):
                raise PreparationError("R1_OUTPUT_ERRORS", item.get("output_key", ""))
            pid = item.get("product_id")
            if not pid:
                raise PreparationError("R1_PRODUCT_ID_MISSING", item.get("output_key", ""))
            fixed_bundles = {
                str((product.get("contract_bundle_ref") or {}).get("digest") or "")
                for product in fixed_by_pid.get(str(pid), [])
            }
            if not fixed_bundles:
                raise PreparationError("R1_OUTPUT_PRODUCT_NOT_FIXED", str(pid))
            try:
                read = service.read(pid, snapshot_id=instance.snapshot_id, include_history=True)
            except Exception as exc:
                raise PreparationError("R1_FIXED_READ_FAILED",
                                       f"{pid}: {type(exc).__name__}: {exc}") from exc
            actual = {(row.get("record_id"), row.get("record_version"))
                      for row in read.get("rows", [])}
            expected = {(record.get("record_id"), record.get("record_version"))
                        for record in item.get("records", [])}
            if not expected or not expected.issubset(actual):
                raise PreparationError("R1_RECORD_IDENTITY_MISMATCH", str(pid))
            # The fixed snapshot entry binding, not an arbitrary first product
            # returned by read(), decides which contract set is published.
            read_bundles = {
                str((product.get("contract_bundle_ref") or {}).get("digest") or "")
                for product in read.get("products", [])
                if product.get("product_id") == pid
            }
            if not read_bundles or not read_bundles.issubset(fixed_bundles):
                raise PreparationError("R1_OUTPUT_BINDING_MISMATCH", str(pid))
            recorded_bundle = str(
                (item.get("contract_bundle_ref") or {}).get("digest") or ""
            )
            if recorded_bundle and recorded_bundle not in fixed_bundles:
                raise PreparationError("R1_OUTPUT_BINDING_MISMATCH", str(pid))

        formal_path = prep_root / str(formal_rel)
        formal_raw = formal_path.read_bytes()
        formal = json.loads(formal_raw.decode("utf-8"))
        if formal.get("format_version") != "wfd.data-only-formal-publication/1.0":
            raise PreparationError("R1_FORMAL_FORMAT_MISMATCH", str(formal_rel))
        if (formal.get("request_key") != key
                or formal.get("snapshot_id") != instance.snapshot_id
                or formal.get("input_fingerprint") != fingerprint
                or formal.get("formal_publication_state") != "published_formal"):
            raise PreparationError("R1_FORMAL_RECORD_MISMATCH", str(formal_rel))
        formal_checks = formal.get("checks") or {}
        if (not formal_checks
                or not all(formal_checks.get(name) is True for name in required_checks)
                or not (formal_checks.get("active_head_matches") is True
                        or formal_checks.get("historically_activated") is True)):
            raise PreparationError("R1_FORMAL_RECORD_CHECK_FAILED", str(formal_rel))
        if dict(formal.get("request_identity") or {}) != identity:
            raise PreparationError("R1_FORMAL_IDENTITY_MISMATCH", str(formal_rel))

        closure: dict[str, PrepFile] = {}

        def add(rel: str, kind: str, expected_sha: str | None = None) -> None:
            rel = _safe_relpath(rel)
            source = prep_root / rel
            if source.is_symlink():
                raise PreparationError("PREP_SYMLINK_NOT_ALLOWED", rel)
            try:
                st = _lstat_regular(source)
            except FileNotFoundError as exc:
                raise PreparationError("PREP_FILE_MISSING", rel) from exc
            digest = sha256_file(source)
            if expected_sha is not None and digest != expected_sha:
                raise PreparationError(
                    "PREP_DIGEST_MISMATCH", f"{rel}: {digest} != {expected_sha}"
                )
            prior = closure.get(rel)
            if prior is not None and prior.sha256 != digest:
                raise PreparationError("PREP_DUPLICATE_RELPATH_CONFLICT", rel)
            closure[rel] = PrepFile(rel, digest, st.st_size, kind)

        for entry in snapshot.get("files", []):
            add(str(entry["file_relpath"]), "data", str(entry["file_sha256"]))
        add(str(manifest_rel), "manifest", snapshot.get("manifest_sha256"))
        add(snapshot_rel, "snapshot", commit.get("snapshot_sha256"))
        add(commit_rel, "commit")
        for product in fixed_products:
            _add_product_closure(add, product, prep_root)
        add(str(formal_rel), "formal_receipt", sha256_bytes(formal_raw))
        if (prep_root / "catalog/retention.json").is_file():
            add("catalog/retention.json", "retention")
        files = tuple(sorted(closure.values(), key=lambda item: (_KIND_ORDER.get(item.kind, 99), item.relpath)))
        return PreparationSummary(
            instance=instance, request_key=key, input_fingerprint=fingerprint,
            snapshot_id=instance.snapshot_id, parent_snapshot_id=parent,
            snapshot_sha256=snapshot_sha, manifest_relpath=str(manifest_rel),
            manifest_sha256=manifest_sha, commit_relpath=commit_rel,
            commit_sha256=sha256_bytes(commit_raw), formal_relpath=str(formal_rel),
            formal_sha256=sha256_bytes(formal_raw), files=files,
            output_results=tuple(output_results), status=dict(status_record),
        )

    def publish(self, instance: PreparationInstance) -> dict:
        try:
            summary = self.prepare(instance)
        except PreparationError as exc:
            return self._result("rejected_preparation", errors=[exc.as_dict()],
                                request_identity=dict(instance.request_identity),
                                snapshot_id=instance.snapshot_id)
        return self.publish_prepared(summary)

    def publish_prepared(self, summary: PreparationSummary) -> dict:
        if not isinstance(summary, PreparationSummary):
            raise TypeError("summary must be PreparationSummary")
        try:
            self._journal(summary, "prepared")
            det = self._require_volume()
        except VolumeError as exc:
            self._journal_error(summary, exc.code, exc.detail)
            return self._result("rejected_volume", summary=summary, errors=[exc.as_dict()])
        try:
            with writer_lock(self.root):
                return self._publish_locked(summary)
        except WriterBusy as exc:
            self._journal_error(summary, "SINGLE_WRITER_BUSY", str(exc))
            return self._result("rejected_locked", summary=summary, volume=det.as_dict(),
                                errors=[{"code": "SINGLE_WRITER_BUSY", "detail": str(exc)}])
        except VolumeError as exc:
            self._journal_error(summary, exc.code, exc.detail)
            return self._result("rejected_volume", summary=summary, errors=[exc.as_dict()])
        except PublicationError as exc:
            self._journal_error(summary, exc.code, exc.detail)
            return self._result("rejected_publication", summary=summary, volume=det.as_dict(),
                                errors=[exc.as_dict()])
        except Exception as exc:
            self._journal_error(summary, "PUBLICATION_INTERRUPTED",
                                f"{type(exc).__name__}: {exc}")
            raise

    # ------------------------------------------------------------------ 目标状态
    def _require_volume(self) -> DetectedVolume:
        return self.detector.verify(self.root, expected_uuid=self.binding.volume_uuid,
                                    filesystem=self.binding.filesystem)

    def _read_state(self) -> dict | None:
        try:
            state = self.state.read()
        except (StateError, OSError) as exc:
            raise PublicationError("HEAD_UNREADABLE", str(exc)) from exc
        if state is not None and state.get("format_version") not in ("wfd.state/1.0", "wfd.host/1.0"):
            raise PublicationError("HEAD_INVALID_FORMAT", str(state.get("format_version")))
        return state

    def _check_writer(self, state: dict | None) -> None:
        if state is None:
            if self.binding.writer_epoch != 0:
                raise PublicationError("WRITER_EPOCH_MISMATCH", "空库首次只接受 epoch=0")
            return
        host = state.get("writer_host")
        if host not in (None, self.binding.writer_host):
            raise PublicationError("WRITER_NOT_AUTHORIZED", f"{host!r} != {self.binding.writer_host!r}")
        epoch = int(state.get("writer_epoch") or 0)
        if epoch != self.binding.writer_epoch:
            raise PublicationError("WRITER_EPOCH_MISMATCH", f"{epoch} != {self.binding.writer_epoch}")

    def _check_new_head(self, state: dict | None, expected_parent: str | None) -> None:
        head = (state or {}).get("active_head")
        if head != expected_parent:
            raise PublicationError(
                "PARENT_CHANGED", f"target HEAD={head!r}, expected_parent={expected_parent!r}"
            )

    def _publish_locked(self, summary: PreparationSummary) -> dict:
        det = self._require_volume()
        state = self._read_state()
        self._check_writer(state)
        commit_path = self.root / summary.commit_relpath
        if commit_path.exists() or commit_path.is_symlink():
            return self._resume(summary, state, det)

        expected_parent = summary.parent_snapshot_id
        self._check_new_head(state, expected_parent)
        parent_paths: set[str] = set()
        if expected_parent is not None:
            parent = self._load_target_snapshot(expected_parent)
            parent_paths = {str(entry["file_relpath"]) for entry in parent.get("files", [])}
        prep_root = Path(summary.instance.prep_root)
        copied: list[str] = []
        reused: list[str] = []
        skipped: list[str] = []
        for item in summary.files:
            if item.kind in {"commit", "formal_receipt"}:
                continue
            if item.kind == "data" and item.relpath in parent_paths:
                reused.append(item.relpath)
                continue
            action = self._copy_or_reuse(item, prep_root,
                                         allow_skip=item.kind == "retention")
            if action == "copied":
                copied.append(item.relpath)
            elif action == "reused":
                reused.append(item.relpath)
            else:
                skipped.append(item.relpath)
            self._inject("after_copy", relpath=item.relpath, action=action)

        self._verify_target_precommit(summary)
        self._inject("target_verified", snapshot_id=summary.snapshot_id)

        commit_file = summary.file_map()[summary.commit_relpath]
        self._copy_or_reuse(commit_file, prep_root)
        self._load_target_snapshot(summary.snapshot_id)
        self._inject("before_activate", snapshot_id=summary.snapshot_id,
                     expected_parent=expected_parent)
        act = self.state.activate(
            summary.snapshot_id, self.root / f"catalog/snapshots/{summary.snapshot_id}.json",
            expected_prev=expected_parent, writer_host=self.binding.writer_host,
            writer_epoch=self.binding.writer_epoch,
        )
        if not act.get("ok"):
            self._journal_error(summary, act.get("code", "HEAD_UPDATE_FAILED"),
                                act.get("detail", ""))
            return self._result(
                "commit_pending_head", summary=summary, volume=det.as_dict(),
                states={"prepared": True, "copied": bool(copied), "verified": True,
                        "committed": True, "activated": False, "receipt": False},
                head=self._head_summary(self._read_state()),
                errors=[{"code": act.get("code", "HEAD_UPDATE_FAILED"),
                         "detail": act.get("detail", "")}],
                extra={"commit_relpath": summary.commit_relpath},
            )
        self._inject("after_activate", snapshot_id=summary.snapshot_id)
        self._inject("before_fixed_read", snapshot_id=summary.snapshot_id)
        fixed = self._target_fixed_read(summary)
        self._cleanup_empty_staging()
        if not fixed.get("ok"):
            return self._result(
                "activated_readback_failed", summary=summary, volume=det.as_dict(),
                states={"prepared": True, "copied": bool(copied), "verified": True,
                        "committed": True, "activated": True, "receipt": False},
                head=self._head_summary(self._read_state()), fixed_readback=fixed,
                formal_receipt=None, errors=[{"code": "FIXED_READBACK_FAILED",
                                              "detail": str(fixed.get("error"))}],
            )
        formal = self._publish_formal_receipt(summary)
        self._journal(summary, "activated", snapshot_id=summary.snapshot_id,
                      head=self._head_summary(self._read_state()))
        return self._result(
            "activated", summary=summary, volume=det.as_dict(),
            states={"prepared": True, "copied": bool(copied), "verified": True,
                    "committed": True, "activated": True, "receipt": True},
            head=self._head_summary(self._read_state()), fixed_readback=fixed,
            formal_receipt=formal,
            extra={"copied": copied, "reused": reused, "skipped": skipped,
                   "commit_relpath": summary.commit_relpath},
        )

    def _resume(self, summary: PreparationSummary, state: dict | None,
                det: DetectedVolume) -> dict:
        sid = summary.snapshot_id
        expected_parent = summary.parent_snapshot_id
        target_snapshot = self._load_target_snapshot(sid)
        if target_snapshot.get("snapshot_id") != sid:
            raise PublicationError("TARGET_SNAPSHOT_ID_MISMATCH", str(target_snapshot.get("snapshot_id")))
        self._verify_target_precommit(summary)
        head = (state or {}).get("active_head")
        history = list((state or {}).get("activation_history") or [])
        activated_before = head == sid or any(item.get("snapshot_id") == sid for item in history)

        if activated_before:
            fixed = self._target_fixed_read(summary)
            self._cleanup_empty_staging()
            if not fixed.get("ok"):
                return self._result(
                    "activated_readback_failed", summary=summary, volume=det.as_dict(),
                    states={"prepared": True, "copied": True, "verified": True,
                            "committed": True, "activated": True, "receipt": False},
                    head=self._head_summary(state), fixed_readback=fixed,
                    formal_receipt=None, errors=[{"code": "FIXED_READBACK_FAILED",
                                                  "detail": str(fixed.get("error"))}],
                )
            formal = self._publish_formal_receipt(summary)
            self._journal(summary, "activated", snapshot_id=sid,
                          head=self._head_summary(state))
            return self._result(
                "already_activated" if head != sid else "activated", summary=summary,
                volume=det.as_dict(),
                states={"prepared": True, "copied": True, "verified": True,
                        "committed": True, "activated": True, "receipt": True},
                head=self._head_summary(state), fixed_readback=fixed,
                formal_receipt=formal,
                extra={"head_unchanged": True, "historical": head != sid,
                       "commit_relpath": summary.commit_relpath},
            )

        if head != expected_parent:
            raise PublicationError(
                "HEAD_CONFLICT",
                f"target HEAD={head!r}, expected_parent={expected_parent!r}；不回滚旧 HEAD",
            )
        formal_path = self.root / summary.formal_relpath
        if formal_path.exists():
            raise PublicationError("FORMAL_RECEIPT_BEFORE_ACTIVATION", summary.formal_relpath)
        self._inject("before_activate", snapshot_id=sid, expected_parent=expected_parent,
                     resume=True)
        act = self.state.activate(
            sid, self.root / f"catalog/snapshots/{sid}.json", expected_prev=expected_parent,
            writer_host=self.binding.writer_host, writer_epoch=self.binding.writer_epoch,
        )
        if not act.get("ok"):
            return self._result(
                "commit_pending_head", summary=summary, volume=det.as_dict(),
                states={"prepared": True, "copied": True, "verified": True,
                        "committed": True, "activated": False, "receipt": False},
                head=self._head_summary(self._read_state()),
                errors=[{"code": act.get("code", "HEAD_UPDATE_FAILED"),
                         "detail": act.get("detail", "")}],
                extra={"commit_relpath": summary.commit_relpath},
            )
        self._inject("after_activate", snapshot_id=sid, resume=True)
        fixed = self._target_fixed_read(summary)
        self._cleanup_empty_staging()
        if not fixed.get("ok"):
            return self._result(
                "activated_readback_failed", summary=summary, volume=det.as_dict(),
                states={"prepared": True, "copied": True, "verified": True,
                        "committed": True, "activated": True, "receipt": False},
                head=self._head_summary(self._read_state()), fixed_readback=fixed,
                formal_receipt=None, errors=[{"code": "FIXED_READBACK_FAILED",
                                              "detail": str(fixed.get("error"))}],
            )
        formal = self._publish_formal_receipt(summary)
        self._journal(summary, "activated", snapshot_id=sid,
                      head=self._head_summary(self._read_state()))
        return self._result(
            "activated", summary=summary, volume=det.as_dict(),
            states={"prepared": True, "copied": True, "verified": True,
                    "committed": True, "activated": True, "receipt": True},
            head=self._head_summary(self._read_state()), fixed_readback=fixed,
            formal_receipt=formal, extra={"reused_commit": True,
                                          "commit_relpath": summary.commit_relpath},
        )

    # ------------------------------------------------------------------ 文件 copy/verify
    def _copy_or_reuse(self, item: PrepFile, prep_root: Path, *, allow_skip: bool = False) -> str:
        _safe_relpath(item.relpath)
        _reject_symlink_path(self.root, item.relpath)
        target = self.root / item.relpath
        if target.exists() or target.is_symlink():
            if target.is_symlink() or not target.is_file():
                raise PublicationError("TARGET_NOT_REGULAR_FILE", str(target))
            if sha256_file(target) == item.sha256:
                return "reused"
            if allow_skip:
                return "skipped"
            raise PublicationError("IMMUTABLE_FILE_COLLISION", str(target))
        prep_source = Path(prep_root) / item.relpath
        if prep_source.is_symlink() or not prep_source.is_file():
            raise PublicationError("PREP_FILE_MISSING", str(prep_source))
        if prep_source.resolve() == target.resolve():
            raise PublicationError("COPY_SOURCE_EQUALS_TARGET", str(target))
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp",
                                   dir=str(target.parent))
        try:
            h = hashlib.sha256()
            size = 0
            with open(prep_source, "rb") as src, os.fdopen(fd, "wb") as out:
                for chunk in iter(lambda: src.read(1 << 20), b""):
                    h.update(chunk)
                    out.write(chunk)
                    size += len(chunk)
                out.flush()
                os.fsync(out.fileno())
            if h.hexdigest() != item.sha256 or size != item.size:
                raise PublicationError("COPY_DIGEST_MISMATCH", item.relpath)
            os.replace(tmp, target)
            self._fsync_dir(target.parent)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        if sha256_file(target) != item.sha256:
            raise PublicationError("TARGET_READBACK_DIGEST_MISMATCH", item.relpath)
        return "copied"

    @staticmethod
    def _fsync_dir(path: Path) -> None:
        try:
            dfd = os.open(str(path), os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except OSError:
            pass

    def _load_target_snapshot(self, sid: str) -> dict:
        if not _SNAPSHOT_RE.fullmatch(str(sid)):
            raise PublicationError("SNAPSHOT_ID_INVALID", str(sid))
        commit_rel = f"catalog/commits/{sid}.json"
        _reject_symlink_path(self.root, commit_rel)
        commit_path = self.root / commit_rel
        if commit_path.is_symlink() or not commit_path.is_file():
            raise PublicationError("TARGET_COMMIT_MISSING", str(commit_path))
        try:
            commit_raw = commit_path.read_bytes()
            commit = json.loads(commit_raw.decode("utf-8"))
        except (OSError, ValueError) as exc:
            raise PublicationError("TARGET_COMMIT_UNREADABLE", str(exc)) from exc
        if commit.get("snapshot_id") != sid:
            raise PublicationError("TARGET_COMMIT_SNAPSHOT_MISMATCH", str(commit.get("snapshot_id")))
        snapshot_rel = commit.get("snapshot_file")
        if str(snapshot_rel).startswith("wfd.snapshot-file/"):
            raise PublicationError("ROW_VERSION_OBJECT_OPERATION_UNSUPPORTED", "volume publication")
        _safe_relpath(str(snapshot_rel))
        _reject_symlink_path(self.root, str(snapshot_rel))
        snapshot_path = self.root / str(snapshot_rel)
        if snapshot_path.is_symlink() or not snapshot_path.is_file():
            raise PublicationError("TARGET_SNAPSHOT_MISSING", str(snapshot_rel))
        snapshot_raw = snapshot_path.read_bytes()
        if sha256_bytes(snapshot_raw) != commit.get("snapshot_sha256"):
            raise PublicationError("TARGET_SNAPSHOT_DIGEST_MISMATCH", str(snapshot_rel))
        snapshot = json.loads(snapshot_raw.decode("utf-8"))
        if snapshot.get("snapshot_id") != sid:
            raise PublicationError("TARGET_SNAPSHOT_ID_MISMATCH", str(snapshot.get("snapshot_id")))
        manifest_rel = snapshot.get("manifest_relpath")
        _safe_relpath(str(manifest_rel))
        _reject_symlink_path(self.root, str(manifest_rel))
        manifest_path = self.root / str(manifest_rel)
        if manifest_path.is_symlink() or not manifest_path.is_file():
            raise PublicationError("TARGET_MANIFEST_MISSING", str(manifest_rel))
        manifest_raw = manifest_path.read_bytes()
        if sha256_bytes(manifest_raw) != snapshot.get("manifest_sha256"):
            raise PublicationError("TARGET_MANIFEST_DIGEST_MISMATCH", str(manifest_rel))
        manifest = json.loads(manifest_raw.decode("utf-8"))
        if manifest.get("files") != snapshot.get("files"):
            raise PublicationError("TARGET_MANIFEST_FILE_LIST_MISMATCH", str(manifest_rel))
        for entry in snapshot.get("files", []):
            rel = _safe_relpath(str(entry["file_relpath"]))
            _reject_symlink_path(self.root, rel)
            path = self.root / rel
            if path.is_symlink() or not path.is_file():
                raise PublicationError("TARGET_DATA_MISSING", rel)
            if sha256_file(path) != entry.get("file_sha256"):
                raise PublicationError("TARGET_DATA_DIGEST_MISMATCH", rel)
        return snapshot

    def _verify_target_precommit(self, summary: PreparationSummary) -> None:
        snapshot_path = self.root / f"catalog/snapshots/{summary.snapshot_id}.json"
        manifest_path = self.root / summary.manifest_relpath
        if snapshot_path.is_symlink() or not snapshot_path.is_file():
            raise PublicationError("TARGET_SNAPSHOT_MISSING", summary.snapshot_id)
        if manifest_path.is_symlink() or not manifest_path.is_file():
            raise PublicationError("TARGET_MANIFEST_MISSING", summary.manifest_relpath)
        if sha256_bytes(snapshot_path.read_bytes()) != summary.snapshot_sha256:
            raise PublicationError("TARGET_SNAPSHOT_BYTES_MISMATCH", summary.snapshot_id)
        if sha256_bytes(manifest_path.read_bytes()) != summary.manifest_sha256:
            raise PublicationError("TARGET_MANIFEST_BYTES_MISMATCH", summary.manifest_relpath)
        snapshot = json.loads(snapshot_path.read_text("utf-8"))
        manifest = json.loads(manifest_path.read_text("utf-8"))
        if snapshot.get("parent_snapshot_id") != summary.parent_snapshot_id:
            raise PublicationError("TARGET_PARENT_MISMATCH", str(snapshot.get("parent_snapshot_id")))
        if manifest.get("files") != snapshot.get("files"):
            raise PublicationError("TARGET_MANIFEST_FILE_LIST_MISMATCH", summary.manifest_relpath)
        # 只核 fixed read 必需的数据/合同/定义/bundle；product/retention 是可复用 metadata。
        required_kinds = {"data", "contract", "definition", "definition_version",
                          "contract_bundle", "manifest", "snapshot"}
        for item in summary.files:
            if item.kind not in required_kinds:
                continue
            path = self.root / item.relpath
            if path.is_symlink() or not path.is_file():
                raise PublicationError("TARGET_CLOSURE_MISSING", item.relpath)
            if sha256_file(path) != item.sha256:
                raise PublicationError("TARGET_CLOSURE_DIGEST_MISMATCH", item.relpath)

    def _publish_formal_receipt(self, summary: PreparationSummary) -> dict:
        item = summary.file_map()[summary.formal_relpath]
        action = self._copy_or_reuse(item, Path(summary.instance.prep_root))
        target = self.root / summary.formal_relpath
        if sha256_file(target) != summary.formal_sha256:
            raise PublicationError("FORMAL_RECEIPT_DIGEST_MISMATCH", summary.formal_relpath)
        record = json.loads(target.read_text("utf-8"))
        if (record.get("request_key") != summary.request_key
                or record.get("snapshot_id") != summary.snapshot_id
                or record.get("formal_publication_state") != "published_formal"):
            raise PublicationError("FORMAL_RECEIPT_CONTENT_MISMATCH", summary.formal_relpath)
        return {"relpath": summary.formal_relpath, "sha256": summary.formal_sha256,
                "action": action, "formal_publication_state": "published_formal"}

    # ------------------------------------------------------------------ 目标 fixed read
    def _cleanup_empty_staging(self) -> None:
        """现有 engine 构造会建空 _staging；只清空目录，不触碰任何文件。"""
        path = self.root / "_staging"
        if path.is_dir() and not path.is_symlink():
            try:
                if not any(path.iterdir()):
                    path.rmdir()
            except OSError:
                pass

    def _target_fixed_read(self, summary: PreparationSummary) -> dict:
        try:
            from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
            from wfd_sdk.product_data_service import WFDDataOnlyService

            runtime = self.runtime_root / "target_read" / summary.snapshot_id
            engine = WFDDuckDBPrototype(
                self.root, load_protocol_validator(Path(summary.instance.protocol_root)),
                runtime_root=runtime, sandbox=False, writer_host=self.binding.writer_host,
            )
            service = WFDDataOnlyService(
                engine, caller_roles=("read",), caller_id="volume-target-read",
                unit_registry=dict(summary.instance.unit_registry),
                trusted_actor_namespaces=set(summary.instance.trusted_actor_namespaces),
            )
            outputs = []
            for item in summary.output_results:
                pid = item.get("product_id")
                read = service.read(pid, snapshot_id=summary.snapshot_id, include_history=True)
                actual = {(row.get("record_id"), row.get("record_version"))
                          for row in read.get("rows", [])}
                expected = {(record.get("record_id"), record.get("record_version"))
                            for record in item.get("records", [])}
                if not expected or not expected.issubset(actual):
                    raise PublicationError("TARGET_RECORD_IDENTITY_MISMATCH", str(pid))
                products = [product for product in read.get("products", [])
                            if product.get("product_id") == pid]
                if not products:
                    raise PublicationError("TARGET_PRODUCT_NOT_READABLE", str(pid))
                roles = sorted({
                    role for product in products
                    for role in (product.get("contract_refs") or {})
                })
                if set(roles) != _CONTRACT_ROLES:
                    raise PublicationError("TARGET_CONTRACT_ROLES_MISMATCH", str(pid))
                outputs.append({
                    "output_key": item.get("output_key"), "product_id": pid,
                    "record_refs": [{"record_id": record.get("record_id"),
                                     "record_version": record.get("record_version")}
                                    for record in item.get("records", [])],
                    "contract_roles": roles,
                })
            return {"ok": True, "snapshot_id": summary.snapshot_id,
                    "service": "WFDDataOnlyService.read", "outputs": outputs,
                    "head": self._head_summary(self._read_state())}
        except PublicationError as exc:
            return {"ok": False, "error": exc.as_dict(), "snapshot_id": summary.snapshot_id}
        except Exception as exc:  # noqa: BLE001 - 读回失败必须显式报告
            return {"ok": False, "error": {"code": "FIXED_READBACK_FAILED",
                                           "detail": f"{type(exc).__name__}: {exc}"},
                    "snapshot_id": summary.snapshot_id}

    # ------------------------------------------------------------------ 本地 request 日志
    def _journal_path(self, summary: PreparationSummary) -> Path:
        return self.runtime_root / "volume_requests" / f"{summary.request_key}.json"

    def _journal(self, summary: PreparationSummary, status: str, **extra) -> None:
        path = self._journal_path(summary)
        prior = {}
        if path.is_file():
            try:
                prior = json.loads(path.read_text("utf-8"))
            except (OSError, ValueError):
                prior = {}
        data = dict(prior)
        data.update({
            "format_version": "wfd.volume-request-local/1.0",
            "request_key": summary.request_key,
            "request_identity": dict(summary.instance.request_identity),
            "input_fingerprint": summary.input_fingerprint,
            "snapshot_id": summary.snapshot_id,
            "parent_snapshot_id": summary.parent_snapshot_id,
            "status": status,
            "updated_at_utc": _now(),
            **extra,
        })
        _atomic_write(path, canonical(data) + b"\n")

    def _journal_error(self, summary: PreparationSummary, code: str, detail: str) -> None:
        try:
            self._journal(summary, "failed", last_error={"code": code, "detail": detail,
                                                          "at_utc": _now()})
        except OSError:
            pass

    # ------------------------------------------------------------------ 结果
    def _head_summary(self, state: dict | None) -> dict | None:
        if state is None:
            return None
        history = list(state.get("activation_history") or [])
        return {"active_head": state.get("active_head"),
                "writer_host": state.get("writer_host"),
                "writer_epoch": state.get("writer_epoch"),
                "update_seq": state.get("update_seq"),
                "last_activation": history[-1] if history else None}

    @staticmethod
    def _result(status: str, *, summary: PreparationSummary | None = None,
                request_identity: Mapping[str, Any] | None = None,
                snapshot_id: str | None = None, volume: dict | None = None,
                states: dict | None = None, head: dict | None = None,
                fixed_readback: dict | None = None, formal_receipt: dict | None = None,
                errors: list[dict] | None = None, extra: dict | None = None) -> dict:
        state_defaults = {"prepared": bool(summary), "copied": False, "verified": False,
                          "committed": False, "activated": False, "receipt": False}
        if states:
            state_defaults.update(states)
        out = {
            "status": status,
            "request_key": summary.request_key if summary else None,
            "request_identity": dict(request_identity or (summary.instance.request_identity if summary else {})),
            "snapshot_id": snapshot_id or (summary.snapshot_id if summary else None),
            "parent_snapshot_id": summary.parent_snapshot_id if summary else None,
            "input_fingerprint": summary.input_fingerprint if summary else None,
            "states": state_defaults,
            "head": head,
            "fixed_readback": fixed_readback,
            "formal_receipt": formal_receipt,
            "volume": volume,
            "errors": errors or [],
        }
        historical = bool(extra and extra.get("historical") is True)
        active = bool(out["snapshot_id"] and head
                      and (head.get("active_head") == out["snapshot_id"] or historical)
                      and (fixed_readback or {}).get("ok")
                      and (formal_receipt or {}).get("formal_publication_state") == "published_formal")
        out["formal"] = bool(status in {"activated", "already_activated"} and active)
        if extra:
            out.update(extra)
        return out


__all__ = [
    "DetectedVolume", "LocalMirrorStateStore", "PreparationError",
    "PreparationInstance", "PreparationSummary", "PrepFile", "PublicationError",
    "SystemVolumeDetector", "VolumeBinding", "VolumeConfigStore", "VolumeDetector",
    "VolumeError", "VolumePublisher",
]
