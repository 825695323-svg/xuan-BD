#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WFD 增量迁移与受控接管层（P0-4 前置实现）

原则：
  · 增量身份用内容哈希（SHA-256），不用路径；正式记录里不出现 F:\\ 或 /Volumes/...
  · 快进必须验证**完整祖先链**，不是只比一跳 parent；
  · 只用已登记对象做增量：哈希一致才复用，路径相同内容不同即冲突；
  · 分叉不自动合并：检测到即 LINEAGE_FORK_DETECTED，导入物进 quarantine，不激活；
  · 受控接管用持久化 writer_epoch + 交接凭证；离线双写无法实时阻止，只能在重连时检测。
  · 冷层不可用必须显式报 STORAGE_TIER_UNAVAILABLE，不允许返回空表。

包结构（与平台无关）：
  pkg/
    transfer.json          运行/数据源、来源快照、目标快照、时间
    inventory.json         内容寻址对象清单 [{sha256,size}]（去重）
    closure.json           依赖清单：snapshots/manifests/commits/lineage checkpoints
    objects/<sha256>       对象字节
    CHECKSUMS.sha256       包内文件校验
"""
from __future__ import annotations

from wfd_sdk.writerlock import guarded_method, guarded_store_arg, guarded_store_func

import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

from .lineage import Lineage, files_root, sha_file
from .row_version_objects import reject_unsupported


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class TransferError(RuntimeError):
    pass


class StorageTierUnavailable(RuntimeError):
    pass


# ---------------------------------------------------------------- 内容清单
def object_manifest(store: Path, snapshot_id: str, *, include_ancestor_data: bool = False) -> dict:
    """列出该快照（及其祖先闭包）需要传输的对象与元数据。"""
    store = Path(store)
    lineage = Lineage(store)
    snap_path = store / f"catalog/snapshots/{snapshot_id}.json"
    if not snap_path.is_file():
        raise TransferError(f"SNAPSHOT_NOT_FOUND {snapshot_id}")
    snap = json.loads(snap_path.read_text("utf-8"))
    reject_unsupported(snap, "transfer")

    objects, metas = {}, []
    # 元数据：本快照链上的 snapshot/manifest/commit/lineage checkpoint
    chain = lineage.ancestors(snapshot_id)
    if not chain["ok"]:
        raise TransferError(f"LINEAGE_INCOMPLETE {chain}")
    for node in chain["chain"]:
        sid = node["snapshot_id"]
        for rel in (f"catalog/snapshots/{sid}.json", f"catalog/commits/{sid}.json", f"catalog/lineage/{sid}.json"):
            p = store / rel
            if p.is_file():
                metas.append({"rel_path": rel, "sha256": sha_file(p), "size": p.stat().st_size,
                              "kind": "lineage_checkpoint" if "lineage" in rel else "metadata"})
        sp = store / f"catalog/snapshots/{sid}.json"
        if sp.is_file():
            s = json.loads(sp.read_text("utf-8"))
            reject_unsupported(s, "transfer")
            mp = store / s["manifest_relpath"]
            if mp.is_file():
                metas.append({"rel_path": s["manifest_relpath"], "sha256": sha_file(mp), "size": mp.stat().st_size,
                              "kind": "manifest"})

    # 数据对象：本快照必备；可选把祖先数据也带上（首次全量迁移）
    def add_data(sid: str):
        sp = store / f"catalog/snapshots/{sid}.json"
        if not sp.is_file():
            return
        s = json.loads(sp.read_text("utf-8"))
        reject_unsupported(s, "transfer")
        for f in s["files"]:
            rel = f["file_relpath"]
            p = store / rel
            if not p.is_file():
                raise TransferError(f"OBJECT_MISSING {rel}")
            h = sha_file(p)
            if h != f["file_sha256"].split(":")[-1]:
                raise TransferError(f"LOCAL_OBJECT_CORRUPT {rel}")
            objects[h] = {"sha256": h, "size": p.stat().st_size, "rel_paths": sorted(set(
                objects.get(h, {}).get("rel_paths", []) + [rel]))}

    add_data(snapshot_id)
    if include_ancestor_data:
        for node in chain["chain"][1:]:
            add_data(node["snapshot_id"])

    return {
        "format_version": "wfd.transfer.manifest/1.0",
        "generated_at_utc": now(),
        "dataset_id": (snap.get("receipt") or {}).get("dataset_id"),
        "target_snapshot_id": snapshot_id,
        "files_root": files_root(snap["files"]),
        "objects": sorted(objects.values(), key=lambda o: o["sha256"]),
        "metadata": metas,
        "ancestry": [c["snapshot_id"] for c in chain["chain"]],
    }


def export_package(store: Path, snapshot_id: str, pkg_dir: Path, *, include_ancestor_data: bool = False) -> dict:
    store, pkg_dir = Path(store), Path(pkg_dir)
    if pkg_dir.exists():
        shutil.rmtree(pkg_dir)
    (pkg_dir / "objects").mkdir(parents=True)
    man = object_manifest(store, snapshot_id, include_ancestor_data=include_ancestor_data)
    snap = json.loads((store / f"catalog/snapshots/{snapshot_id}.json").read_text("utf-8"))
    reject_unsupported(snap, "transfer")
    for obj in man["objects"]:
        rels = obj["rel_paths"]
        src = store / rels[0]
        data = src.read_bytes()
        if hashlib.sha256(data).hexdigest() != obj["sha256"]:
            raise TransferError(f"EXPORT_OBJECT_HASH_MISMATCH {rels[0]}")
        (pkg_dir / "objects" / obj["sha256"]).write_bytes(data)
    # 元数据（snapshot/commit/manifest/lineage）也必须进内容寻址对象区，否则导入端无法校验
    for m in man["metadata"]:
        target = pkg_dir / "objects" / m["sha256"]
        if target.is_file():
            continue
        data = (store / m["rel_path"]).read_bytes()
        if hashlib.sha256(data).hexdigest() != m["sha256"]:
            raise TransferError(f"EXPORT_METADATA_HASH_MISMATCH {m['rel_path']}")
        target.write_bytes(data)
    (pkg_dir / "inventory.json").write_text(json.dumps(man, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    transfer = {
        "format_version": "wfd.transfer/1.0",
        "transfer_id": "tx_" + hashlib.sha256((snapshot_id + now()).encode()).hexdigest()[:16],
        "created_at_utc": now(),
        "dataset_id": man["dataset_id"],
        "target_snapshot_id": snapshot_id,
        "ancestry": man["ancestry"],
        "object_count": len(man["objects"]),
        "total_bytes": sum(o["size"] for o in man["objects"]),
        "include_ancestor_data": include_ancestor_data,
        # 数据源只用逻辑标识，不写平台绝对路径
        "source": {"dataset_id": man["dataset_id"], "snapshot_id": snapshot_id, "files_root": man["files_root"],
                    "writer_host": (host_state(store) or {}).get("writer_host"),
                    "writer_epoch": (host_state(store) or {}).get("writer_epoch")},
    }
    (pkg_dir / "transfer.json").write_text(json.dumps(transfer, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = []
    for p in sorted(pkg_dir.rglob("*")):
        if p.is_file() and p.name != "CHECKSUMS.sha256":
            lines.append(f"{sha_file(p)}  {p.relative_to(pkg_dir).as_posix()}")
    (pkg_dir / "CHECKSUMS.sha256").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return transfer


def verify_package(pkg_dir: Path) -> dict:
    """包校验。缺文件、缺清单都必须返回结构化拒绝，不能把 FileNotFoundError 抛给调用方。

    （2026-10-26 由 Windows 侧中断注入发现：pkg 只有 objects/ 时原先直接抛 FileNotFoundError。）
    """
    pkg_dir = Path(pkg_dir)
    required = ("transfer.json", "inventory.json")
    absent = [n for n in required if not (pkg_dir / n).is_file()]
    if absent:
        return {"ok": False, "code": "TRANSFER_INTEGRITY_FAILED", "hash_mismatch": [], "missing": [],
                "missing_package_files": absent,
                "detail": f"包不完整，缺 {absent}（半成品包不得被视为可激活包）"}
    try:
        transfer = json.loads((pkg_dir / "transfer.json").read_text("utf-8"))
        inv = json.loads((pkg_dir / "inventory.json").read_text("utf-8"))
    except ValueError as exc:
        return {"ok": False, "code": "TRANSFER_INTEGRITY_FAILED", "hash_mismatch": [], "missing": [],
                "missing_package_files": [], "detail": f"清单不可解析：{exc}"}
    bad, missing = [], []
    for obj in inv["objects"]:
        p = pkg_dir / "objects" / obj["sha256"]
        if not p.is_file():
            missing.append(obj["sha256"]); continue
        if hashlib.sha256(p.read_bytes()).hexdigest() != obj["sha256"]:
            bad.append(obj["sha256"])
    for m in inv["metadata"]:
        p = pkg_dir / "objects" / m["sha256"]
        if not p.is_file():
            missing.append(m["sha256"]); continue
        if hashlib.sha256(p.read_bytes()).hexdigest() != m["sha256"]:
            bad.append(m["sha256"])
    return {"ok": not bad and not missing, "code": None if (not bad and not missing) else "TRANSFER_INTEGRITY_FAILED",
            "hash_mismatch": bad, "missing": missing, "missing_package_files": [],
            "transfer": transfer, "inventory": inv}


# ---------------------------------------------------------------- 导入（增量）
@guarded_store_arg(1)
def import_package(pkg_dir: Path, store: Path, *, interrupt_after: int | None = None) -> dict:
    """把包导入目标库。只拷缺失对象；已有对象必须哈希一致才复用。"""
    pkg_dir, store = Path(pkg_dir), Path(store)
    v = verify_package(pkg_dir)
    if not v["ok"]:
        return {"status": "rejected", "code": "TRANSFER_INTEGRITY_FAILED",
                "hash_mismatch": v["hash_mismatch"][:5], "missing": v["missing"][:5]}
    store.mkdir(parents=True, exist_ok=True)
    for d in ("catalog/manifests", "catalog/snapshots", "catalog/commits", "catalog/lineage", "catalog/forks",
              "observations", "foundation", "events"):
        (store / d).mkdir(parents=True, exist_ok=True)

    copied, reused, conflicts, skipped = [], [], [], []
    for obj in v["inventory"]["objects"]:
        data = (pkg_dir / "objects" / obj["sha256"]).read_bytes()
        for rel in obj["rel_paths"]:
            target = store / rel
            if target.is_file():
                if sha_file(target) == obj["sha256"]:
                    reused.append({"rel_path": rel, "sha256": obj["sha256"]})
                else:
                    conflicts.append({"rel_path": rel, "expected": obj["sha256"], "actual": sha_file(target)})
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            copied.append({"rel_path": rel, "sha256": obj["sha256"], "size": len(data)})
            if interrupt_after is not None and len(copied) >= interrupt_after:
                return {"status": "interrupted", "copied": copied, "reused": reused,
                        "conflicts": conflicts, "metadata_written": 0}

    written = 0
    for m in v["inventory"]["metadata"]:
        target = store / m["rel_path"]
        data = (pkg_dir / "objects" / m["sha256"]).read_bytes()
        if target.is_file() and sha_file(target) == m["sha256"]:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        written += 1

    # 关键：导入方必须自己登记"已导入未激活"，不能依赖调用脚本补写。
    # 否则接手方的 writer 身份停留在上一轮，激活时会误走 same-host 分支而跳过凭证校验。
    if not conflicts:
        st = host_state(store)
        src = (v["transfer"].get("source") or {})
        st.setdefault("format_version", "wfd.host/1.0")
        st["active_head"] = st.get("active_head")          # 保持原值（不得自动激活）
        st["imported_head"] = v["transfer"]["target_snapshot_id"]
        st["imported_from"] = {"host": src.get("writer_host"), "epoch": src.get("writer_epoch"), "at_utc": now()}
        st.setdefault("writer_host", None)
        st.setdefault("writer_epoch", 0)
        st.setdefault("update_seq", 0)
        st["updated_at_utc"] = now()
        st["note"] = "imported, not activated (set by import_package)"
        (store / "catalog/state.json").write_text(json.dumps(st, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    return {"status": "rejected" if conflicts else "imported", "code": "PATH_HASH_CONFLICT" if conflicts else None,
            "copied": copied, "reused": reused, "conflicts": conflicts, "metadata_written": written,
            "transfer": v["transfer"], "state_after_import": host_state(store)}


# ---------------------------------------------------------------- 快进 / 分叉 / 接管
def host_state(store: Path) -> dict:
    p = Path(store) / "catalog/state.json"
    if not p.is_file():
        return {"format_version": "wfd.host/1.0", "writer_host": None, "writer_epoch": 0, "active_head": None}
    return json.loads(p.read_text("utf-8"))


def write_host_state(store: Path, *, writer_host: str, writer_epoch: int, active_head,
                     note: str = "", imported_head: str | None = None,
                     prev_head: str | None = None, update_seq: int | None = None) -> dict:
    """active_head=None 表示"已导入但尚未激活"；imported_head 记录导入来源版本（不等于激活）。"""
    st = {"format_version": "wfd.host/1.0", "writer_host": writer_host, "writer_epoch": writer_epoch,
          "active_head": active_head, "imported_head": imported_head,
          "prev_head": prev_head, "update_seq": int(update_seq or 0),
          "updated_at_utc": now(), "note": note}
    (Path(store) / "catalog/state.json").write_text(json.dumps(st, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return st


def check_fast_forward(store: Path, incoming_sid: str) -> dict:
    """完整祖先验证：local active head 必须位于 incoming 的已验证祖先链上。"""
    store = Path(store)
    lin = Lineage(store)
    st = host_state(store)
    local = st.get("active_head")
    incoming_chain = lin.ancestors(incoming_sid)
    if not incoming_chain["ok"]:
        return {"ok": False, "reason": incoming_chain["reason"], "detail": incoming_chain}
    ids = [c["snapshot_id"] for c in incoming_chain["chain"]]
    if local is None:
        return {"ok": True, "mode": "initial_import", "chain": ids}
    if local == incoming_sid:
        return {"ok": True, "mode": "already_at_target", "chain": ids}
    if local in ids:
        return {"ok": True, "mode": "fast_forward", "chain": ids,
                "steps": ids[:ids.index(local)] and ids[:ids.index(local)][::-1]}
    rel = lin.compare(local, incoming_sid)
    if rel["relation"] == "b_is_ancestor_of_a":
        return {"ok": True, "mode": "local_ahead_noop", "chain": ids}
    return {"ok": False, "reason": "LINEAGE_FORK_DETECTED", "detail": rel, "chain": ids}


@guarded_store_func


def activate(store: Path, incoming_sid: str, *, writer_host: str, writer_epoch: int,
             handover: dict | None = None) -> dict:
    store = Path(store)
    st = host_state(store)
    ff = check_fast_forward(store, incoming_sid)
    if not ff["ok"]:
        if ff.get("reason") == "LINEAGE_FORK_DETECTED":
            (store / "catalog/forks").mkdir(parents=True, exist_ok=True)
            (store / f"catalog/forks/{incoming_sid}.json").write_text(json.dumps(
                {"format_version": "wfd.fork/1.0", "snapshot_id": incoming_sid, "detected_at_utc": now(),
                 "local_head": st.get("active_head"), "detail": ff["detail"]}, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8")
            # 隔离未激活分支：把 incoming 的 commit 标记移出 catalog/commits，
            # 否则本地同时存在两条已提交分支，引擎 head() 会 DIVERGENT_HISTORY（实测过）。
            commit = store / f"catalog/commits/{incoming_sid}.json"
            if commit.is_file():
                commit.replace(store / f"catalog/forks/{incoming_sid}.commit.json")
        return {"status": "rejected", "code": ff.get("reason", "FAST_FORWARD_FAILED"), "detail": ff}

    # 写入主端资格（IMPL-rc1 R-XF-03 修正）：
    #  · 真正空库（无 active_head、无 imported_head）：first_writer 免凭证；
    #  · 有 imported_head 但未激活：必须凭证，base 必须等于 imported_head，旧主端必须等于来源主端；
    #  · 已有 active_head：同主端续写可免凭证；换主端必须凭证且 base == active_head。
    st_now = host_state(store)
    active = st_now.get("active_head")
    imported = st_now.get("imported_head")
    imp_from = st_now.get("imported_from") or {}
    cur_host, cur_epoch = st_now.get("writer_host"), int(st_now.get("writer_epoch") or 0)

    def _check_handover(base_expected: str, old_host: str, old_epoch: int) -> tuple[bool, str]:
        if not handover:
            return False, "WRITER_NOT_AUTHORIZED"
        ok = (handover.get("old_writer_host") == old_host
              and int(handover.get("old_writer_epoch", -1)) == int(old_epoch)
              and handover.get("new_writer_host") == writer_host
              and int(handover.get("new_writer_epoch", 0)) > int(old_epoch)
              and writer_epoch == int(handover.get("new_writer_epoch"))
              and handover.get("base_snapshot_id") == base_expected)
        return (True, "HANDOVER_VERIFIED") if ok else (False, "WRITER_NOT_AUTHORIZED")

    # 合法初始化判定：只有"确认处于合法初始化状态、导入闭包完整、无待恢复正式历史"才免凭证。
    # active_head is None 本身不等于新库——旧库丢 HEAD 也满足它，那种情况必须凭证。
    fresh = False
    if active is None:
        try:
            from wfd_sdk.gc import GC as _GC
            valid = set(_GC(store).valid_snapshots())
            from wfd_sdk.lineage import Lineage as _L
            chain = {c["snapshot_id"] for c in _L(store).ancestors(incoming_sid)["chain"]}
            has_recovery = any((store / "catalog/recovery").glob("*.json"))
            fresh = (int(st_now.get("update_seq") or 0) == 0
                     and not has_recovery
                     and valid.issubset(chain | {incoming_sid}))
        except Exception:  # noqa: BLE001 —— 判定失败一律按"非新库"处理（fail-closed）
            fresh = False

    if fresh:
        authorized, reason = (writer_epoch >= cur_epoch, "FIRST_WRITER_INITIALIZED")
    elif active is None:
        # 指针为空但库中存在非本链历史，或存在恢复记录：不能借"首次写入"绕过凭证
        authorized, reason = False, "HEAD_REQUIRES_RECOVERY"
    elif imported and incoming_sid == imported and (imp_from.get("host") == writer_host) and active is not None:
        # 同主端快进：导入来源主端就是本端主端，且本端已激活过该主端版本 → 属于正常推进，不需要接管凭证。
        # 注意判据是"来源主端 == 本端主端"，他端导入（win-01 收 mac-a 的包）不会命中这里。
        authorized, reason = (writer_epoch >= cur_epoch and ff.get("mode") in ("fast_forward", "local_ahead_noop", "already_at_target"),
                              "SAME_WRITER_FAST_FORWARD")
    elif imported and incoming_sid == imported:
        # 他端导入：必须凭证（这才是 V2 缺陷要守住的路径）
        if imp_from.get("host"):
            authorized, reason = _check_handover(imported, imp_from["host"], int(imp_from.get("epoch") or 0))
        else:
            # 兼容旧包（transfer.json 未带 source.writer_*）：无法核对旧主端，
            # 退化为"base 必须是被导入版本 + epoch 前进"，并在原因码里标明未核验来源身份。
            ok = (bool(handover) and handover.get("base_snapshot_id") == imported
                  and int(handover.get("new_writer_epoch", 0)) >= 1
                  and writer_epoch == int(handover.get("new_writer_epoch", 0)))
            authorized, reason = (ok, "HANDOVER_VERIFIED_WITHOUT_SOURCE_IDENTITY" if ok else "WRITER_NOT_AUTHORIZED")
    elif active is None:
        authorized, reason = (writer_epoch >= cur_epoch, "FIRST_WRITER")
    elif handover:
        authorized, reason = _check_handover(active, cur_host, cur_epoch)
    else:
        authorized = (cur_host == writer_host and writer_epoch >= cur_epoch)
        reason = "SAME_WRITER_CONTINUE" if authorized else "WRITER_NOT_AUTHORIZED"
    if not authorized:
        return {"status": "rejected", "code": reason,
                "detail": {"current": {"host": cur_host, "epoch": cur_epoch, "active_head": active,
                                       "imported_head": imported, "imported_from": imp_from},
                           "requested": {"host": writer_host, "epoch": writer_epoch},
                           "handover": handover}}

    # 物化 commit 标记（引擎按 commit 推导 HEAD），再更新激活指针
    commit = store / f"catalog/commits/{incoming_sid}.json"
    snap = store / f"catalog/snapshots/{incoming_sid}.json"
    if not commit.is_file() and snap.is_file():
        (commit).write_text(json.dumps({"snapshot_id": incoming_sid, "snapshot_file": f"catalog/snapshots/{incoming_sid}.json",
                                        "snapshot_sha256": sha_file(snap)}, ensure_ascii=False, sort_keys=True,
                                       separators=(",", ":")).encode(), encoding="utf-8")
    # 统一进入权威状态机：与引擎发布、显式恢复共用 StateStore.activate（原子写 + 激活历史）
    from wfd_sdk.state import StateStore
    res = StateStore(store).activate(incoming_sid, snap,
                                     expected_prev=st_now.get("active_head"),
                                     writer_host=writer_host, writer_epoch=writer_epoch,
                                     allow_writer_change=True,     # 本函数已完成凭证/同主端/首次写入判定
                                     authorized_by=reason)
    if not res.get("ok"):
        return {"status": "rejected", "code": res.get("code"), "detail": res}
    st = host_state(store)
    return {"status": "activated", "mode": ff["mode"], "active_head": incoming_sid,
            "state": st, "chain": ff["chain"]}



def publish_guard(store: Path, *, host: str, epoch: int) -> dict:
    st = host_state(store)
    ok = st.get("writer_host") == host and int(st.get("writer_epoch") or 0) == epoch
    return {"ok": ok, "code": "OK" if ok else "WRITER_NOT_AUTHORIZED",
            "current": {"host": st.get("writer_host"), "epoch": st.get("writer_epoch")}}


# ---------------------------------------------------------------- 冷热层
def read_guarded(store: Path, snapshot_id: str, rows_loader) -> dict:
    """读前检查对象所在存储层是否可用；冷层未挂载必须显式报错。"""
    store = Path(store)
    mm_path = store / "catalog/mount_map.json"
    tiers = {}
    if mm_path.is_file():
        tiers = json.loads(mm_path.read_text("utf-8")).get("objects", {})
    snap = json.loads((store / f"catalog/snapshots/{snapshot_id}.json").read_text("utf-8"))
    reject_unsupported(snap, "transfer")
    unavailable = []
    for f in snap["files"]:
        h = f["file_sha256"].split(":")[-1]
        info = tiers.get(h)
        if info and info.get("tier") == "EXTERNAL_COLD" and not info.get("mounted"):
            unavailable.append(f["file_relpath"])
    if unavailable:
        raise StorageTierUnavailable(f"STORAGE_TIER_UNAVAILABLE {unavailable[:3]}")
    return rows_loader(store, snapshot_id)
