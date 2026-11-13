#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Minimal WFD instance-holding facts (P4a2 first segment)."""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from . import row_version_objects

FORMAT = "wfd.product-holdings/1.0"
STAGES = ("acquired", "custodied", "published_readable")
TARGET_INSTANCE_FORMAT = "wfd.target-instance-binding/1.0"
TARGET_STAGE_PROOF_FORMAT = "wfd.p5-target-stage-proof/1.0"
_TARGET_INSTANCE_REL = "catalog/product_service/target_instance_binding.json"
_TARGET_STAGE_PROOF_DIR = "catalog/product_service/target_import_stage_proofs"
_TARGET_INSTANCE_KEYS = {"format_version", "instance_id", "created_at", "content_sha256"}
_P5_BUNDLE_KEYS = {"bundle_id", "format_version", "mode", "logical_state_digest",
                   "source_dataset_id"}
_P5_PROOF_KEYS = {"format_version", "request_key", "request_identity", "instance_id",
                  "snapshot_id", "product_id", "bundle", "records", "stages",
                  "content_sha256"}
_PRODUCTION_PROOF = {"r2_publish", "target_commit_recovery", "p5_import"}
_TEST_MODE = "WFD_HOLDINGS_TEST_MODE"
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_INSTANCE_ID = re.compile(r"^wfi_[0-9a-f]{32}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _canon(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))


def _sha(value: Any) -> str:
    return hashlib.sha256(_canon(value).encode("utf-8")).hexdigest()


def _parse_stamp(value: Any, code: str) -> str:
    if not isinstance(value, str):
        raise HoldingError(code)
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as exc:
        raise HoldingError(code, str(value)) from exc
    return value


def _json_document(path: Path, code: str) -> dict:
    if path.is_symlink() or not path.is_file():
        raise HoldingError(code, path.name)
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as exc:
        raise HoldingError(code, path.name) from exc
    if not isinstance(value, dict):
        raise HoldingError(code, path.name)
    return value


def _normalize_stage_records(records: Sequence[Mapping[str, Any]]) -> list[dict]:
    normalized, seen = [], set()
    for record in records:
        if not isinstance(record, Mapping):
            raise HoldingError("HOLDING_RECORD_INVALID")
        rid = record.get("record_id")
        version = record.get("record_version")
        if not isinstance(rid, str) or not rid or not isinstance(version, str) or not version:
            raise HoldingError("HOLDING_RECORD_INVALID")
        if (rid, version) in seen:
            raise HoldingError("HOLDING_RECORD_DUPLICATE")
        seen.add((rid, version))
        normalized.append({"record_id": rid, "record_version": version})
    if not normalized:
        raise HoldingError("HOLDING_RECORDS_EMPTY")
    return sorted(normalized, key=lambda item: (item["record_id"], item["record_version"]))


def _normalize_bundle_identity(bundle: Any) -> dict:
    if not isinstance(bundle, Mapping) or set(bundle) != _P5_BUNDLE_KEYS:
        raise HoldingError("HOLDING_PROOF_IDENTITY_INVALID")
    out = {key: bundle[key] for key in _P5_BUNDLE_KEYS}
    for key, value in out.items():
        if not isinstance(value, str) or not value:
            raise HoldingError("HOLDING_PROOF_IDENTITY_INVALID", key)
    if out["mode"] not in {"full", "delta"}:
        raise HoldingError("HOLDING_PROOF_IDENTITY_INVALID", "mode")
    return out


def _p5_stage_key(*, instance_id: str, bundle: Mapping[str, Any], snapshot_id: str,
                  product_id: str, records: Sequence[Mapping[str, Any]]) -> str:
    return _sha([TARGET_STAGE_PROOF_FORMAT, instance_id, bundle["bundle_id"],
                 bundle["format_version"], bundle["mode"], bundle["logical_state_digest"],
                 bundle["source_dataset_id"], snapshot_id, product_id,
                 [[item["record_id"], item["record_version"]] for item in records]])


def _target_stage_proof_dir(root: str | Path) -> Path:
    return (Path(root) / _TARGET_STAGE_PROOF_DIR).resolve()


def _existing_target_stage_proof(root: str | Path, key: str) -> Path:
    if not isinstance(key, str) or not _HEX64.fullmatch(key):
        raise HoldingError("HOLDING_STAGE_PROOF_REQUIRED")
    directory = _target_stage_proof_dir(root)
    candidate = directory / f"{key}.json"
    if candidate.is_symlink():
        raise HoldingError("HOLDING_STAGE_PROOF_MISSING")
    path = candidate.resolve()
    if (path.parent != directory or path.name != key + ".json" or not path.is_file()):
        raise HoldingError("HOLDING_STAGE_PROOF_MISSING")
    return path


def _load_target_instance(root: str | Path) -> dict | None:
    path = Path(root) / _TARGET_INSTANCE_REL
    if not path.exists() and not path.is_symlink():
        return None
    data = _json_document(path, "HOLDING_INSTANCE_BINDING_CORRUPT")
    if set(data) != _TARGET_INSTANCE_KEYS:
        raise HoldingError("HOLDING_INSTANCE_BINDING_CORRUPT")
    if data.get("format_version") != TARGET_INSTANCE_FORMAT:
        raise HoldingError("HOLDING_INSTANCE_BINDING_CORRUPT")
    if not isinstance(data.get("instance_id"), str) or not _INSTANCE_ID.fullmatch(data["instance_id"]):
        raise HoldingError("HOLDING_INSTANCE_BINDING_CORRUPT")
    _parse_stamp(data.get("created_at"), "HOLDING_INSTANCE_BINDING_CORRUPT")
    body = {key: value for key, value in data.items() if key != "content_sha256"}
    if data.get("content_sha256") != _sha(body):
        raise HoldingError("HOLDING_INSTANCE_BINDING_CORRUPT")
    return data


def resolve_target_instance(root: str | Path, *, create: bool = False) -> dict:
    """Resolve the target instance identity without inventing a volume binding.

    An existing real volume_binding continues to win, preserving R2 identities.
    Ordinary local targets get one path-free internal binding created once.
    """
    root = Path(root)
    volume_path = root / "catalog/product_service/volume_binding.json"
    local = _load_target_instance(root)
    if volume_path.exists() or volume_path.is_symlink():
        volume = _json_document(volume_path, "HOLDING_INSTANCE_BINDING_CORRUPT")
        instance_id = volume.get("instance_id")
        if not isinstance(instance_id, str) or not _SAFE_ID.fullmatch(instance_id):
            raise HoldingError("HOLDING_INSTANCE_MISMATCH")
        if local is not None and local["instance_id"] != instance_id:
            raise HoldingError("HOLDING_INSTANCE_MISMATCH")
        return {"instance_id": instance_id, "source": "volume_binding",
                "content_sha256": volume.get("content_sha256")}
    if local is not None:
        return {"instance_id": local["instance_id"], "source": "target_instance",
                "content_sha256": local["content_sha256"]}
    if not create:
        raise HoldingError("HOLDING_INSTANCE_UNBOUND")
    instance_id = "wfi_" + secrets.token_hex(16)
    body = {"format_version": TARGET_INSTANCE_FORMAT, "instance_id": instance_id,
            "created_at": _now()}
    body["content_sha256"] = _sha(body)
    _atomic(root / _TARGET_INSTANCE_REL, body)
    return {"instance_id": instance_id, "source": "target_instance",
            "content_sha256": body["content_sha256"]}


def _validate_p5_proof(data: Mapping[str, Any], *, key: str, instance_id: str,
                       bundle: Mapping[str, Any], snapshot_id: str, product_id: str,
                       records: Sequence[Mapping[str, Any]]) -> dict:
    if not isinstance(data, Mapping) or set(data) != _P5_PROOF_KEYS:
        raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
    if data.get("format_version") != TARGET_STAGE_PROOF_FORMAT:
        raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
    if data.get("request_key") != key:
        raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
    if data.get("instance_id") != instance_id:
        raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
    if data.get("snapshot_id") != snapshot_id:
        raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
    if data.get("product_id") != product_id:
        raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
    if _canon(data.get("bundle")) != _canon(bundle):
        raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
    proof_records = _normalize_stage_records(data.get("records") or [])
    if _canon(proof_records) != _canon(data.get("records")):
        raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
    if not {(item["record_id"], item["record_version"]) for item in records}.issubset(
            {(item["record_id"], item["record_version"]) for item in proof_records}):
        raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
    expected_identity = {"dataset_id": bundle["source_dataset_id"],
                         "trusted_actor_namespace": "wfd.target_import",
                         "request_id": "p5_" + key[:32]}
    if data.get("request_identity") != expected_identity:
        raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
    stages = data.get("stages")
    if not isinstance(stages, dict) or not stages or set(stages) - set(STAGES):
        raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
    ordered = []
    for name in STAGES:
        if name in stages:
            ordered.append(_parse_stamp(stages[name], "HOLDING_STAGE_PROOF_MISMATCH"))
    if any(left > right for left, right in zip(ordered, ordered[1:])):
        raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
    body = {name: value for name, value in data.items() if name != "content_sha256"}
    if data.get("content_sha256") != _sha(body):
        raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
    return dict(data)


def target_stage_proof_index(root: str | Path, instance_id: str, snapshot_id: str,
                            product_id: str) -> dict:
    """Index persisted P5 proof times by exact record and stage.

    The index is recovery-only evidence: it never trusts caller-supplied times.
    """
    directory = _target_stage_proof_dir(root)
    if not directory.is_dir():
        return {}
    found = {}
    for path in sorted(directory.glob("*.json")):
        if path.is_symlink():
            raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
        data = _json_document(path, "HOLDING_STAGE_PROOF_MISMATCH")
        if (data.get("instance_id") != instance_id
                or data.get("snapshot_id") != snapshot_id
                or data.get("product_id") != product_id):
            continue
        if set(data) != _P5_PROOF_KEYS or data.get("format_version") != TARGET_STAGE_PROOF_FORMAT:
            raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
        key = path.stem
        if data.get("request_key") != key or not _HEX64.fullmatch(key):
            raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
        body = {name: value for name, value in data.items() if name != "content_sha256"}
        if data.get("content_sha256") != _sha(body):
            raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
        identity = data.get("request_identity")
        if (not isinstance(identity, dict)
                or set(identity) != {"dataset_id", "trusted_actor_namespace", "request_id"}
                or not isinstance(identity.get("dataset_id"), str)
                or not identity["dataset_id"]
                or identity.get("trusted_actor_namespace") != "wfd.target_import"
                or identity.get("request_id") != "p5_" + key[:32]):
            raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
        records = _normalize_stage_records(data.get("records") or [])
        if _canon(records) != _canon(data.get("records")):
            raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
        stages = data.get("stages")
        if not isinstance(stages, dict) or not stages or set(stages) - set(STAGES):
            raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
        ordered = []
        for name in STAGES:
            if name in stages:
                ordered.append(_parse_stamp(stages[name], "HOLDING_STAGE_PROOF_MISMATCH"))
        if any(left > right for left, right in zip(ordered, ordered[1:])):
            raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
        for record in records:
            slot = found.setdefault((record["record_id"], record["record_version"]),
                                    {"stages": {}, "proofs": {}})
            for name in STAGES:
                value = stages.get(name)
                if not value:
                    continue
                if name not in slot["stages"] or value < slot["stages"][name]:
                    slot["stages"][name] = value
                    slot["proofs"][name] = {key}
                elif value == slot["stages"][name]:
                    slot["proofs"][name].add(key)
    return found


def write_target_stage_proof(root: str | Path, *, instance_id: str,
                             bundle: Mapping[str, Any], snapshot_id: str,
                             product_id: str, records: Sequence[Mapping[str, Any]],
                             stages: Mapping[str, Any]) -> dict:
    """Write/merge one internal P5 stage proof; first observed stage wins."""
    root = Path(root)
    binding = resolve_target_instance(root, create=False)
    if binding["instance_id"] != instance_id:
        raise HoldingError("HOLDING_INSTANCE_MISMATCH")
    bundle = _normalize_bundle_identity(bundle)
    if not isinstance(product_id, str) or not _SAFE_ID.fullmatch(product_id):
        raise HoldingError("HOLDING_PRODUCT_INVALID")
    if not isinstance(snapshot_id, str) or not _SAFE_ID.fullmatch(snapshot_id):
        raise HoldingError("HOLDING_SNAPSHOT_INVALID")
    records = _normalize_stage_records(records)
    clean = {}
    for name, value in dict(stages or {}).items():
        if name not in STAGES:
            raise HoldingError("HOLDING_STAGE_INVALID", str(name))
        if value is not None:
            clean[name] = _parse_stamp(value, "HOLDING_STAGE_INVALID:" + str(name))
    if not clean:
        raise HoldingError("HOLDING_STAGES_EMPTY")
    key = _p5_stage_key(instance_id=instance_id, bundle=bundle,
                        snapshot_id=snapshot_id, product_id=product_id,
                        records=records)
    directory = _target_stage_proof_dir(root)
    path = directory / f"{key}.json"
    prior = None
    if path.exists() or path.is_symlink():
        prior = _validate_p5_proof(
            _json_document(path, "HOLDING_STAGE_PROOF_MISMATCH"),
            key=key, instance_id=instance_id, bundle=bundle,
            snapshot_id=snapshot_id, product_id=product_id, records=records)
    merged = dict(prior["stages"]) if prior else {}
    for name in STAGES:
        if name in merged:
            continue
        if name in clean:
            merged[name] = clean[name]
    ordered = [merged[name] for name in STAGES if name in merged]
    if any(left > right for left, right in zip(ordered, ordered[1:])):
        raise HoldingError("HOLDING_STAGE_ORDER_INVALID")
    body = {"format_version": TARGET_STAGE_PROOF_FORMAT, "request_key": key,
            "request_identity": {"dataset_id": bundle["source_dataset_id"],
                                 "trusted_actor_namespace": "wfd.target_import",
                                 "request_id": "p5_" + key[:32]},
            "instance_id": instance_id, "snapshot_id": snapshot_id,
            "product_id": product_id, "bundle": bundle,
            "records": records, "stages": merged}
    body["content_sha256"] = _sha(body)
    if prior is not None and _canon(prior) == _canon(body):
        return prior
    _atomic(path, body)
    return body


def target_holding_summary(root: str | Path, instance_id: str,
                           records_by_product: Mapping[str, Sequence[Mapping[str, Any]]]) -> dict:
    wanted = {(product_id, item["record_id"], item["record_version"])
              for product_id, records in records_by_product.items()
              if records for item in _normalize_stage_records(records)}
    found = {}
    ledger = HoldingLedger(root, instance_id)
    for fact in ledger.facts():
        product_id = fact.get("product_id")
        for record in fact.get("records", []):
            key = (product_id, record.get("record_id"), record.get("record_version"))
            if key not in wanted:
                continue
            slot = found.setdefault(key, {})
            for name, value in (record.get("stages") or {}).items():
                if value and (name not in slot or value < slot[name]):
                    slot[name] = value
    products = {}
    for product_id in sorted(records_by_product):
        rows = []
        for record_id, version in sorted({(item["record_id"], item["record_version"])
                                          for item in records_by_product[product_id]}):
            rows.append({"record_id": record_id, "record_version": version,
                         "stages": {name: found[(product_id, record_id, version)][name]
                                    for name in STAGES
                                    if name in found.get((product_id, record_id, version), {})}})
        products[product_id] = rows
    return {"instance_id": instance_id, "products": products}


def _atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":")).encode("utf-8") + b"\n"
    fd, tmp = tempfile.mkstemp(prefix=".holding_", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


class HoldingError(RuntimeError):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(code + (": " + detail if detail else ""))
        self.code = code
        self.detail = detail


class HoldingLedger:
    def __init__(self, root: str | Path, instance_id: str):
        if not isinstance(instance_id, str) or not _SAFE_ID.fullmatch(instance_id):
            raise HoldingError("HOLDING_INSTANCE_INVALID", str(instance_id))
        self.root = Path(root)
        self.instance_id = instance_id
        self.dir = self.root / "catalog/product_service/holdings" / instance_id

    def _write(self, *, snapshot_id, product_id, records, acquired_at,
               custodied_at, readable_at, proof):
        supplied = {"acquired": acquired_at, "custodied": custodied_at,
                    "published_readable": readable_at}
        known = {}
        for name, value in supplied.items():
            if value is None:
                continue
            if not isinstance(value, str):
                raise HoldingError("HOLDING_STAGE_INVALID:" + name)
            datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
            known[name] = value
        ordered = [known[name] for name in STAGES if name in known]
        if any(left > right for left, right in zip(ordered, ordered[1:])):
            raise HoldingError("HOLDING_STAGE_ORDER_INVALID")
        if not records:
            raise HoldingError("HOLDING_RECORDS_EMPTY")
        normalized = []
        seen = set()
        for record in records:
            rid = record.get("record_id"); version = record.get("record_version")
            if not isinstance(rid, str) or not rid or not isinstance(version, str) or not version:
                raise HoldingError("HOLDING_RECORD_INVALID")
            if (rid, version) in seen:
                raise HoldingError("HOLDING_RECORD_DUPLICATE")
            seen.add((rid, version))
            normalized.append({"record_id": rid, "record_version": version,
                               "stages": dict(known)})
        body = {"format_version": FORMAT, "instance_id": self.instance_id,
                "snapshot_id": snapshot_id, "product_id": product_id,
                "records": normalized, "proof": dict(proof)}
        content_sha = _sha(body)
        batch_id = content_sha[:32]
        body["batch_id"] = batch_id
        body["content_sha256"] = content_sha
        path = self.dir / f"{batch_id}.json"
        if path.is_file():
            return json.loads(path.read_text("utf-8"))
        _atomic(path, body)
        return body

    def record_batch(self, *, snapshot_id: str, product_id: str,
                     records: Sequence[Mapping[str, Any]], acquired_at: str | None = None,
                     custodied_at: str | None = None, readable_at: str | None = None,
                     proof: Mapping[str, Any] | None = None) -> dict:
        proof = dict(proof or {})
        kind = proof.get("kind")
        if kind not in _PRODUCTION_PROOF:
            raise HoldingError("HOLDING_PROOF_UNTRUSTED", str(kind))
        if set(proof) - {"kind", "snapshot_id", "request_key"}:
            raise HoldingError("HOLDING_PROOF_FIELDS_UNEXPECTED")
        request_key = proof.get("request_key")
        if not isinstance(request_key, str) or not _HEX64.fullmatch(request_key):
            raise HoldingError("HOLDING_STAGE_PROOF_REQUIRED")
        if proof.get("snapshot_id") != snapshot_id:
            raise HoldingError("HOLDING_PROOF_SNAPSHOT_MISMATCH")
        if kind == "p5_import":
            if any(value is not None for value in (acquired_at, custodied_at, readable_at)):
                raise HoldingError("HOLDING_STAGE_TIME_AUTHORITY")
            if not isinstance(product_id, str) or not _SAFE_ID.fullmatch(product_id):
                raise HoldingError("HOLDING_PRODUCT_INVALID")
            records = _normalize_stage_records(records)
            proof_path = _existing_target_stage_proof(self.root, request_key)
            stage_proof = _json_document(proof_path, "HOLDING_STAGE_PROOF_MISMATCH")
            bundle = _normalize_bundle_identity(stage_proof.get("bundle"))
            stage_proof = _validate_p5_proof(
                stage_proof, key=request_key, instance_id=self.instance_id,
                bundle=bundle, snapshot_id=snapshot_id, product_id=product_id,
                records=records)
            stages = stage_proof["stages"]
            acquired_at = stages.get("acquired")
            custodied_at = stages.get("custodied")
            readable_at = stages.get("published_readable")
        else:
            proof_dir = (self.root / "catalog/product_service/data_only_stage_proofs").resolve()
            candidate = proof_dir / f"{request_key}.json"
            if candidate.is_symlink():
                raise HoldingError("HOLDING_STAGE_PROOF_MISSING")
            proof_path = candidate.resolve()
            if (proof_path.parent != proof_dir
                    or proof_path.name != request_key + ".json"
                    or not proof_path.is_file()):
                raise HoldingError("HOLDING_STAGE_PROOF_MISSING")
            stage_proof = json.loads(proof_path.read_text("utf-8"))
            identity = stage_proof.get("request_identity") or {}
            expected_key = _sha([identity.get("dataset_id"), identity.get("trusted_actor_namespace"),
                                 identity.get("request_id")])
            if (stage_proof.get("request_key") != request_key
                    or expected_key != request_key
                    or stage_proof.get("instance_id") != self.instance_id
                    or stage_proof.get("snapshot_id") != snapshot_id):
                raise HoldingError("HOLDING_STAGE_PROOF_MISMATCH")
            stage_records = {(r.get("record_id"), r.get("record_version"))
                             for r in stage_proof.get("records", [])}
            wanted_proof = {(r.get("record_id"), r.get("record_version")) for r in records}
            if not wanted_proof.issubset(stage_records):
                raise HoldingError("HOLDING_STAGE_PROOF_RECORD_MISMATCH")
            stages = stage_proof.get("stages") or {}
            resolved = {}
            for name, supplied in (("acquired", acquired_at), ("custodied", custodied_at),
                                   ("published_readable", readable_at)):
                proven = stages.get(name)
                if supplied is not None and supplied != proven:
                    raise HoldingError("HOLDING_STAGE_PROOF_TIME_MISMATCH:" + name)
                resolved[name] = proven if proven is not None else supplied
            acquired_at, custodied_at, readable_at = (resolved["acquired"],
                                                       resolved["custodied"],
                                                       resolved["published_readable"])
        if not any((acquired_at, custodied_at, readable_at)):
            raise HoldingError("HOLDING_STAGES_EMPTY")
        binding = resolve_target_instance(self.root, create=False)
        if binding["instance_id"] != self.instance_id:
            raise HoldingError("HOLDING_INSTANCE_MISMATCH")
        if kind != "p5_import" and binding["source"] != "volume_binding":
            raise HoldingError("HOLDING_INSTANCE_UNBOUND")
        wanted = {(r.get("record_id"), r.get("record_version")) for r in records}
        if not wanted.issubset(self._snapshot_records(snapshot_id, product_id)):
            raise HoldingError("HOLDING_RECORD_NOT_IN_SNAPSHOT")
        commit = self.root / f"catalog/commits/{snapshot_id}.json"
        if commit.is_file() and readable_at is not None:
            commit_at = datetime.fromtimestamp(commit.stat().st_mtime, timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ")
            if readable_at < commit_at:
                raise HoldingError("HOLDING_TIME_BEFORE_COMMIT")
        future = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if readable_at is not None and readable_at > future:
            raise HoldingError("HOLDING_TIME_IN_FUTURE")
        return self._write(snapshot_id=snapshot_id, product_id=product_id,
                           records=records, acquired_at=acquired_at,
                           custodied_at=custodied_at, readable_at=readable_at, proof=proof)

    def record_test_fixture(self, *, snapshot_id: str, product_id: str,
                            records: Sequence[Mapping[str, Any]], acquired_at: str,
                            custodied_at: str, readable_at: str) -> dict:
        """Synthetic boundary fixture; reader accepts only in explicit test mode."""
        if os.environ.get(_TEST_MODE) != "1":
            raise HoldingError("HOLDING_TEST_MODE_REQUIRED")
        return self._write(snapshot_id=snapshot_id, product_id=product_id,
                           records=records, acquired_at=acquired_at,
                           custodied_at=custodied_at, readable_at=readable_at,
                           proof={"kind": "test_fixture", "snapshot_id": snapshot_id})

    def _snapshot_records(self, snapshot_id, product_id):
        engine_commit = self.root / f"catalog/commits/{snapshot_id}.json"
        if not engine_commit.is_file():
            raise HoldingError("HOLDING_SNAPSHOT_UNKNOWN", snapshot_id)
        snap = json.loads((self.root / f"catalog/snapshots/{snapshot_id}.json").read_text("utf-8"))
        row_version_objects.project_snapshot(self.root, snap)
        found = set()
        for entry in snap.get("files", []):
            if entry.get("product_id") != product_id:
                continue
            versions = (entry.get("source_bundle") or {}).get("_wfd_row_versions", {})
            for mapping in versions.values():
                for value in mapping.values():
                    found.add((value.get("logical_key"), value.get("revision_id")))
        return found

    def facts(self) -> list[dict]:
        if not self.dir.is_dir():
            return []
        out = []
        for path in sorted(self.dir.iterdir()):
            if path.name.startswith("._") or path.name == ".DS_Store" or not path.name.endswith(".json"):
                continue
            try:
                data = json.loads(path.read_text("utf-8"))
            except (OSError, ValueError) as exc:
                raise HoldingError("HOLDING_FACT_CORRUPT:" + path.name) from exc
            if data.get("format_version") != FORMAT or data.get("instance_id") != self.instance_id:
                raise HoldingError("HOLDING_FACT_CORRUPT:" + path.name)
            proof = data.get("proof") or {}
            if proof.get("kind") == "test_fixture" and os.environ.get(_TEST_MODE) != "1":
                raise HoldingError("HOLDING_FACT_UNTRUSTED:" + path.name)
            if not re.fullmatch(r"[0-9a-f]{32}", str(data.get("batch_id", ""))):
                raise HoldingError("HOLDING_FACT_CORRUPT:" + path.name)
            body = {k: v for k, v in data.items() if k not in {"batch_id", "content_sha256"}}
            expected = _sha(body)
            if data.get("content_sha256") != expected or data.get("batch_id") != expected[:32]:
                raise HoldingError("HOLDING_FACT_CORRUPT:" + path.name)
            for record in data.get("records", []):
                stages = record.get("stages") or {}
                if set(stages) - set(STAGES):
                    raise HoldingError("HOLDING_FACT_CORRUPT:" + path.name)
                for name, value in stages.items():
                    if value is None:
                        continue
                    try:
                        datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
                    except (TypeError, ValueError):
                        raise HoldingError("HOLDING_FACT_CORRUPT:" + path.name)
                ordered = [stages[name] for name in STAGES if stages.get(name)]
                if any(left > right for left, right in zip(ordered, ordered[1:])):
                    raise HoldingError("HOLDING_FACT_CORRUPT:" + path.name)
            out.append(data)
        return out

    def stage_times(self, *, snapshot_id: str, product_id: str, stage: str) -> dict[tuple[str, str], str]:
        if stage not in STAGES:
            raise HoldingError("HOLDING_STAGE_INVALID", stage)
        found = {}
        for fact in self.facts():
            if fact.get("product_id") != product_id:
                continue
            for record in fact.get("records", []):
                key = (record.get("record_id"), record.get("record_version"))
                value = (record.get("stages") or {}).get(stage)
                if value and (key not in found or value < found[key]):
                    found[key] = value
        return found

    def has_product(self, *, snapshot_id: str, product_id: str) -> bool:
        return any(f.get("product_id") == product_id for f in self.facts())


def record_import_batch(root: str | Path, instance_id: str, *, snapshot_id: str,
                        product_id: str, records: Sequence[Mapping[str, Any]],
                        proof: Mapping[str, Any],
                        acquired_at: str | None = None,
                        custodied_at: str | None = None,
                        readable_at: str | None = None) -> dict:
    """P5 target-instance hook; times come only from the internal stage proof."""
    return HoldingLedger(root, instance_id).record_batch(
        snapshot_id=snapshot_id, product_id=product_id, records=records,
        acquired_at=acquired_at, custodied_at=custodied_at, readable_at=readable_at,
        proof={**dict(proof), "kind": "p5_import"})


__all__ = ["FORMAT", "STAGES", "TARGET_INSTANCE_FORMAT", "TARGET_STAGE_PROOF_FORMAT",
           "HoldingError", "HoldingLedger", "record_import_batch",
           "resolve_target_instance", "target_holding_summary",
           "target_stage_proof_index", "write_target_stage_proof"]
