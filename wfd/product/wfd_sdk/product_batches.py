"""Bounded structured batching over the existing product service.

The module is deliberately a thin ledger in the existing
``catalog/product_service`` namespace.  It does not create a second submit
kernel: ``finalize`` reconstructs one deterministic ordinary request and calls
``WFDProductService.submit`` exactly through the public method.  Chunks contain
structured rows only; raw source files remain ordinary custody evidence in the
fixed header.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .product_data_service import (
    DATA_ONLY_MODES, DATA_ONLY_PROTOCOL, FORBIDDEN_EXTERNAL_KEYS,
)
from .writerlock import writer_lock
from . import indexed_bulk as bulk


BATCH_FORMAT = "wfd.product-batch/0.1"
_DIGEST = re.compile(r"^sha256:[0-9a-fA-F]{64}$")
_DATA_ONLY_HEADER_KEYS = {
    "protocol_version", "request_identity", "intent", "producer_namespace",
    "expected_parent_snapshot_id", "outputs", "consistency_groups", "duplicate_policy",
}
_DATA_ONLY_OUTPUT_KEYS = {
    "output_key", "logical_domain", "subject", "definition_mode",
    "definition_ref", "definition", "input_mode", "coverage", "payload",
    "revisions",
}
_BATCH_FORBIDDEN_EXTRA = {
    "source_binding", "source_attribution", "source_conflicts",
    "derived_lineage", "derived_lineage_digest",
}


class BatchError(RuntimeError):
    code = "BATCH_ERROR"

    def __init__(self, message=""):
        text = str(message)
        super().__init__(text)
        self.code = text.split(":", 1)[0] or type(self).code


class BatchConflict(BatchError):
    code = "BATCH_ID_CONFLICT"


class BatchChunkConflict(BatchError):
    code = "BATCH_CHUNK_CONFLICT"


class BatchIncomplete(BatchError):
    code = "BATCH_INCOMPLETE"

    def __init__(self, status):
        super().__init__(self.code)
        self.status = status


class BatchLimit(BatchError):
    code = "BATCH_LIMIT_EXCEEDED"


class BatchPermission(BatchError):
    code = "BATCH_PERMISSION_DENIED"


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha(value):
    return "sha256:" + hashlib.sha256(_canonical(value)).hexdigest()


def _now():
    return datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


class ProductBatchLedger:
    """Persistent, owner-scoped batch ledger over one trusted service instance.

    ``max_chunks``/``max_rows``/``max_bytes`` are trusted constructor limits.
    They are not read from the submitted header or chunk.
    """

    def __init__(self, service, *, ledger_root=None, max_chunks=64,
                 max_rows=20_000, max_bytes=8_000_000):
        if any(not isinstance(value, int) or value <= 0 for value in (max_chunks, max_rows, max_bytes)):
            raise ValueError("BATCH_LIMITS_INVALID")
        self.service = service
        self.profile = getattr(service, "profile", None)
        self.data_only = self.profile == "data_only"
        self.official_root = Path(service.root).resolve()
        if ledger_root is None:
            if self.data_only:
                raise ValueError("BATCH_LEDGER_ROOT_REQUIRED")
            self.root = self.official_root
        else:
            root = Path(ledger_root).resolve()
            if root == self.official_root or self.official_root in root.parents:
                raise ValueError("BATCH_LEDGER_ROOT_INSIDE_STORE")
            if root.exists() and not root.is_dir():
                raise ValueError("BATCH_LEDGER_ROOT_INVALID")
            self.root = root
        self.max_chunks = max_chunks
        self.max_rows = max_rows
        self.max_bytes = max_bytes

    # -- paths/owner -----------------------------------------------------
    @property
    def owner_id(self):
        return str(self.service.caller_id)

    def _key(self, batch_id):
        return hashlib.sha256(_canonical([self.owner_id, batch_id])).hexdigest()[:32]

    def _index_path(self, batch_id):
        return self.root / "catalog/product_service/batches/index" / (self._key(batch_id) + ".json")

    def _record_path(self, batch_id):
        return self.root / "catalog/product_service/batches/records" / (self._key(batch_id) + ".json")

    def _require_write(self):
        self.service.require_permission("submit")

    def _require_read(self):
        self.service.require_permission("read")

    def _owner_ok(self, record):
        return record.get("owner_caller_id") == self.owner_id

    @staticmethod
    def _atomic_json(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = _canonical(value)
        fd, tmp = tempfile.mkstemp(prefix=".wfd_batch_", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def _read_json(self, path):
        return json.loads(path.read_text("utf-8")) if path.is_file() else None

    def _load(self, batch_id):
        self._require_read()
        record = self._read_json(self._record_path(batch_id))
        if record is None:
            return None
        if not self._owner_ok(record):
            raise BatchPermission("BATCH_PERMISSION_DENIED:owner")
        return record

    # -- header/chunk validation ----------------------------------------
    @staticmethod
    def _scan_forbidden(value, path="header", parent=None):
        if isinstance(value, dict):
            for key, child in value.items():
                # P2: `method` is a declaration axis inside price_adjustment
                # (qfq/hfq), not external execution metadata.  The exemption is
                # limited to that exact parent; every other `method` key stays
                # forbidden so external traces cannot ride in on the new field.
                if (key in FORBIDDEN_EXTERNAL_KEYS or key in _BATCH_FORBIDDEN_EXTRA) \
                        and not (key == "method" and parent == "price_adjustment"):
                    raise BatchError("BATCH_EXTERNAL_METADATA_FORBIDDEN:"
                                     + path + "." + str(key))
                ProductBatchLedger._scan_forbidden(child, path + "." + str(key), key)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                ProductBatchLedger._scan_forbidden(child, f"{path}[{index}]", parent)

    @staticmethod
    def _validate_expected_chunks(keys, expected_chunks):
        if not isinstance(expected_chunks, list) or not expected_chunks:
            raise BatchError("BATCH_EXPECTED_CHUNKS_REQUIRED")
        pairs, chunk_ids = [], set()
        for item in expected_chunks:
            if (not isinstance(item, dict) or set(item) != {"output_key", "chunk_id"}
                    or not isinstance(item["output_key"], str)
                    or not isinstance(item["chunk_id"], str)
                    or item["output_key"] not in keys or not item["chunk_id"]):
                raise BatchError("BATCH_EXPECTED_CHUNK_INVALID")
            pair = (item["output_key"], item["chunk_id"])
            if pair in pairs or item["chunk_id"] in chunk_ids:
                raise BatchError("BATCH_EXPECTED_CHUNK_DUPLICATE")
            pairs.append(pair)
            chunk_ids.add(item["chunk_id"])
        if {pair[0] for pair in pairs} != set(keys):
            raise BatchError("BATCH_OUTPUT_CHUNK_MISSING")
        return pairs

    def _validate_data_only_header(self, batch_id, header, expected_chunks):
        if header.get("protocol_version") != DATA_ONLY_PROTOCOL:
            raise BatchError("BATCH_HEADER_INVALID:protocol_version")
        identity = header.get("request_identity")
        if not isinstance(identity, dict):
            raise BatchError("BATCH_IDENTITY_REQUIRED")
        if set(identity) != {"dataset_id", "trusted_actor_namespace",
                             "request_id", "submission_digest"}:
            raise BatchError("BATCH_IDENTITY_INVALID")
        for key in ("dataset_id", "trusted_actor_namespace", "request_id"):
            if not isinstance(identity.get(key), str) or not identity.get(key):
                raise BatchError("BATCH_IDENTITY_INVALID:" + key)
        if identity["request_id"] != batch_id:
            raise BatchError("BATCH_ID_MISMATCH")
        if not isinstance(identity.get("submission_digest"), str) or not _DIGEST.fullmatch(
                identity["submission_digest"]):
            raise BatchError("BATCH_IDENTITY_INVALID:submission_digest")
        if header.get("intent") != "submit":
            raise BatchError("BATCH_INTENT_INVALID")
        extra = sorted(set(header) - _DATA_ONLY_HEADER_KEYS)
        if extra:
            if set(extra) & (FORBIDDEN_EXTERNAL_KEYS | _BATCH_FORBIDDEN_EXTRA):
                raise BatchError("BATCH_EXTERNAL_METADATA_FORBIDDEN:header." + extra[0])
            raise BatchError("BATCH_HEADER_INVALID:" + extra[0])
        if "expected_parent_snapshot_id" not in header:
            raise BatchError("BATCH_HEADER_INVALID:expected_parent_snapshot_id")
        if (header.get("expected_parent_snapshot_id") is not None
                and not isinstance(header.get("expected_parent_snapshot_id"), str)):
            raise BatchError("BATCH_HEADER_INVALID:expected_parent_snapshot_id")
        if not isinstance(header.get("producer_namespace"), str) or not header["producer_namespace"]:
            raise BatchError("BATCH_HEADER_INVALID:producer_namespace")
        self._scan_forbidden(header, "header")
        if "consistency_groups" in header and not isinstance(header["consistency_groups"], dict):
            raise BatchError("BATCH_HEADER_INVALID:consistency_groups")
        outputs = header.get("outputs")
        if not isinstance(outputs, list) or not outputs:
            raise BatchError("BATCH_OUTPUTS_REQUIRED")
        keys = []
        required = {"output_key", "logical_domain", "subject", "definition_mode",
                    "input_mode", "coverage", "payload"}
        for out in outputs:
            if not isinstance(out, dict) or not isinstance(out.get("output_key"), str):
                raise BatchError("BATCH_OUTPUT_INVALID")
            extra = sorted(set(out) - _DATA_ONLY_OUTPUT_KEYS)
            if extra:
                if set(extra) & (FORBIDDEN_EXTERNAL_KEYS | _BATCH_FORBIDDEN_EXTRA):
                    raise BatchError("BATCH_EXTERNAL_METADATA_FORBIDDEN:outputs."
                                     + out["output_key"] + "." + extra[0])
                raise BatchError("BATCH_OUTPUT_INVALID:" + extra[0])
            missing = sorted(required - set(out))
            if missing:
                raise BatchError("BATCH_OUTPUT_INVALID:" + out["output_key"] + "." + missing[0])
            if not isinstance(out.get("logical_domain"), str):
                raise BatchError("BATCH_OUTPUT_INVALID:logical_domain")
            if not isinstance(out.get("subject"), dict):
                raise BatchError("BATCH_OUTPUT_INVALID:subject")
            mode = out.get("definition_mode")
            if mode == "create":
                if not isinstance(out.get("definition"), dict) or out.get("definition_ref") is not None:
                    raise BatchError("BATCH_DEFINITION_REQUIRED")
            elif mode == "reuse":
                if not isinstance(out.get("definition_ref"), dict) or out.get("definition") is not None:
                    raise BatchError("BATCH_DEFINITION_REFERENCE_REQUIRED")
            else:
                raise BatchError("BATCH_DEFINITION_MODE_INVALID")
            if out.get("input_mode") not in DATA_ONLY_MODES:
                raise BatchError("BATCH_INPUT_MODE_NOT_IMPLEMENTED")
            if not isinstance(out.get("coverage"), dict):
                raise BatchError("BATCH_COVERAGE_INVALID")
            payload = out.get("payload")
            if not isinstance(payload, dict) or not isinstance(payload.get("kind"), str):
                raise BatchError("BATCH_PAYLOAD_REQUIRED:" + out["output_key"])
            if set(payload) - {"kind", "rows"}:
                raise BatchError("BATCH_PAYLOAD_INVALID:" + out["output_key"])
            if payload.get("rows") not in (None, []):
                raise BatchError("BATCH_HEADER_MUST_NOT_CONTAIN_ROWS:" + out["output_key"])
            keys.append(out["output_key"])
        if len(keys) != len(set(keys)):
            raise BatchError("BATCH_OUTPUT_DUPLICATE")
        pairs = self._validate_expected_chunks(keys, expected_chunks)
        return keys, pairs

    def _validate_header(self, batch_id, header, expected_chunks):
        if not isinstance(batch_id, str) or not batch_id or not isinstance(header, dict):
            raise BatchError("BATCH_HEADER_INVALID")
        if self.data_only:
            return self._validate_data_only_header(batch_id, header, expected_chunks)
        identity = header.get("request_identity")
        if not isinstance(identity, dict):
            raise BatchError("BATCH_IDENTITY_REQUIRED")
        for key in ("dataset_id", "trusted_actor_namespace", "request_id"):
            if not isinstance(identity.get(key), str) or not identity.get(key):
                raise BatchError("BATCH_IDENTITY_INVALID:" + key)
        if identity["request_id"] != batch_id:
            raise BatchError("BATCH_ID_MISMATCH")
        if header.get("intent") != "submit":
            raise BatchError("BATCH_INTENT_INVALID")
        outputs = header.get("outputs")
        if not isinstance(outputs, list) or not outputs:
            raise BatchError("BATCH_OUTPUTS_REQUIRED")
        keys = []
        for out in outputs:
            if not isinstance(out, dict) or not isinstance(out.get("output_key"), str):
                raise BatchError("BATCH_OUTPUT_INVALID")
            payload = out.get("payload")
            if not isinstance(payload, dict) or not isinstance(payload.get("kind"), str):
                raise BatchError("BATCH_PAYLOAD_REQUIRED:" + out["output_key"])
            if payload.get("rows"):
                raise BatchError("BATCH_HEADER_MUST_NOT_CONTAIN_ROWS:" + out["output_key"])
            keys.append(out["output_key"])
        if len(keys) != len(set(keys)):
            raise BatchError("BATCH_OUTPUT_DUPLICATE")
        pairs = self._validate_expected_chunks(keys, expected_chunks)
        source = header.get("source_bundle")
        if not isinstance(source, dict):
            raise BatchError("BATCH_SOURCE_BUNDLE_REQUIRED")
        return keys, pairs

    def _check_namespace(self, header):
        namespace = header["request_identity"]["trusted_actor_namespace"]
        if not self.service.actor_namespace_allowed(namespace):
            raise BatchPermission("BATCH_NAMESPACE_UNTRUSTED")
        if header.get("producer_namespace") != namespace:
            raise BatchError("BATCH_PRODUCER_NAMESPACE_MISMATCH")

    def _accounting(self, record):
        header_bytes = len(_canonical(record["header"]))
        manifest_bytes = len(_canonical(record["expected_chunks"]))
        chunk_bytes = sum(item.get("bytes", 0) for item in record.get("chunks", {}).values())
        return {
            "budget_bytes": self.max_bytes,
            "header_bytes": header_bytes,
            "manifest_bytes": manifest_bytes,
            "chunk_bytes": chunk_bytes,
            "used_bytes": header_bytes + manifest_bytes + chunk_bytes,
            "basis": "canonical_header+expected_manifest+received_chunks",
        }

    def _preflight_errors(self, doc):
        """Reuse the service's pure source/role/authority/admission helpers.

        This is deliberately not a second authorization implementation and it
        never calls ``_register`` or ``submit``.
        """
        service = self.service
        if self.data_only:
            # Data-only has no external source/evidence admission preflight;
            # the same public service.submit remains the business validator.
            return []
        if not service.has_permission("submit"):
            return [{"code": "CALLER_PERMISSION_DENIED", "message": "Caller lacks submit role"}]
        if not service.can_register:
            return [{"code": "REGISTRATION_PERMISSION_DENIED", "message": "Caller lacks register capability"}]
        source = doc.get("source_bundle", {})
        try:
            policies = service._source_policies(source)
        except ValueError as exc:
            return [{"code": str(exc).split(":", 1)[0], "message": str(exc)}]
        errors = []
        for out in doc.get("outputs", []):
            try:
                selected, _mode = service._output_policies(
                    source, out["output_key"], policies, out.get("new_definition_declaration"))
            except ValueError as exc:
                errors.append({"code": str(exc).split(":", 1)[0], "message": str(exc)})
                continue
            for sid, policy in selected:
                if policy.get("may_submit") is not True:
                    errors.append({"code": "SOURCE_NOT_ADMITTED",
                                   "message": "Explicit may_submit missing: " + sid})
            errors.extend(service._admit_output(out, source, selected))
        return errors

    def _preflight_result(self, record, errors):
        return {
            "format_version": BATCH_FORMAT, "batch_id": record["batch_id"],
            "phase": record.get("phase"), "status": "preflight_rejected",
            "errors": copy.deepcopy(errors), "snapshot_id": None,
            "output_results": [], "preflight_rejected": True,
            "status_detail": self._status_from_record(record),
        }

    def _record_last_attempt(self, record, errors):
        record["last_attempt"] = {"at": _now(), "errors": copy.deepcopy(errors)}
        record["updated_at"] = _now()

    def _bulk_record(self, batch_id):
        record = self._read_json(self._record_path(batch_id))
        return record if record and record.get("format_version") in bulk.PROTOCOLS else None

    def _bulk_status(self, record, offset=0, limit=None):
        if not self._owner_ok(record):
            raise BatchPermission("BATCH_PERMISSION_DENIED:owner")
        if record["binding"] != self.service.binding.to_dict():
            raise BatchConflict("BULK_VOLUME_BINDING_CHANGED")
        declarations = record["expected_chunks"]
        received = record["received"]
        limit = 50 if limit is None else limit
        page = declarations[offset:offset + limit]
        return {"protocol_version": record["format_version"], "batch_id": record["batch_id"],
                "phase": record["phase"], "expected_chunks": len(declarations),
                "received_chunks": len(received), "chunk_offset": offset,
                "chunks": [{**item, "received": str(item["ordinal"]) in received} for item in page],
                "next_chunk_offset": offset + len(page) if offset + len(page) < len(declarations) else None,
                **({"staging_cleanup_required": not record.get("staging_released", False)}
                   if record["phase"] == "finalized" else {}),
                **(record.get("result") or {})}

    def _begin_indexed_bulk(self, batch_id, header, expected):
        if not callable(getattr(type(self.service), "submit_bulk_batch", None)):
            raise BatchError("BULK_VOLUME_REQUIRED")
        bulk.validate_header(batch_id, header, expected)
        self._check_namespace(header)
        self._scan_forbidden(header)
        with writer_lock(self.root):
            prior = self._read_json(self._record_path(batch_id))
            if prior is not None:
                if (prior.get("format_version") != header["protocol_version"]
                        or prior.get("header") != header or prior.get("expected_chunks") != expected):
                    raise BatchConflict("BATCH_ID_CONFLICT")
                return self._bulk_status(prior)
            record = {"format_version": header["protocol_version"], "batch_id": batch_id,
                      "binding": self.service.binding.to_dict(),
                      "owner_caller_id": self.owner_id, "header": header, "expected_chunks": expected,
                      "received": {}, "staged_bytes": 0, "phase": "collecting"}
            self._atomic_json(self._record_path(batch_id), record)
            return self._bulk_status(record)

    def _bulk_chunk_path(self, batch_id, ordinal):
        return self._record_path(batch_id).parent / (self._key(batch_id) + "-chunks") / f"{ordinal}.json"

    def _put_indexed_bulk(self, batch_id, output_key, chunk_id, rows, digest):
        from .volume_publication import _atomic_write

        with writer_lock(self.root):
            record = self._bulk_record(batch_id)
            self._bulk_status(record)
            self._check_namespace(record["header"])
            item = next((item for item in record["expected_chunks"] if item["chunk_id"] == chunk_id), None)
            if item is None or output_key != record["header"]["outputs"][0]["output_key"]:
                raise BatchError("BATCH_CHUNK_UNEXPECTED")
            if digest != item["digest"]:
                raise BatchChunkConflict("BATCH_CHUNK_DIGEST_MISMATCH")
            raw = bulk.cell_matrix(rows, item, len(record["header"]["field_codes"]))
            ordinal = str(item["ordinal"])
            path = self._bulk_chunk_path(batch_id, item["ordinal"])
            if path.is_symlink() or path.parent.is_symlink():
                raise BatchError("BULK_PATH_SYMLINK")
            if ordinal in record["received"]:
                if record["phase"] == "finalized" and not path.exists() and not path.is_symlink():
                    return self._bulk_status(record)
                if not path.is_file() or path.stat().st_size != len(raw) or path.read_bytes() != raw:
                    raise BatchChunkConflict("BATCH_CHUNK_CONFLICT")
                return self._bulk_status(record)
            if record["phase"] not in {"collecting", "ready"}:
                raise BatchError("BATCH_NOT_COLLECTING")
            if record["staged_bytes"] + len(raw) > bulk.MAX_STAGED_BYTES:
                raise BatchLimit("BATCH_LIMIT_EXCEEDED:indexed bulk staged bytes")
            if path.exists():
                if not path.is_file() or path.stat().st_size != len(raw) or path.read_bytes() != raw:
                    raise BatchChunkConflict("BATCH_CHUNK_CONFLICT")
            else:
                _atomic_write(path, raw)
            record["received"][ordinal] = len(raw)
            record["staged_bytes"] += len(raw)
            if len(record["received"]) == len(record["expected_chunks"]):
                record["phase"] = "ready"
            self._atomic_json(self._record_path(batch_id), record)
            return self._bulk_status(record)

    def _finalize_indexed_bulk(self, batch_id):
        with writer_lock(self.root):
            record = self._bulk_record(batch_id)
            status = self._bulk_status(record)
            self._check_namespace(record["header"])
            self.service.require_permission("publish")
            if len(record["received"]) != len(record["expected_chunks"]):
                raise BatchIncomplete(status)
            if record["phase"] in {"finalized", "rejected"}:
                if record["phase"] == "finalized":
                    self._finish_bulk_stage(record)
                    status = self._bulk_status(record)
                return {**status, "idempotent_replay": True}
            if record["phase"] in {"finalizing", "submit_unknown"}:
                proof = self.service.reconcile_bulk_batch(record["header"], for_finalize=True)
                if proof.get("phase") in {"finalized", "rejected"}:
                    record["result"] = {key: value for key, value in proof.items()
                                        if key not in {"phase", "activation_state", "recovery_required"}}
                    record["phase"] = proof["phase"]
                    self._atomic_json(self._record_path(batch_id), record)
                    if record["phase"] == "finalized":
                        self._finish_bulk_stage(record)
                    return {**self._bulk_status(record), "idempotent_replay": True}
            record["phase"] = "finalizing"
            self._atomic_json(self._record_path(batch_id), record)

            def chunks():
                for item in record["expected_chunks"]:
                    path = self._bulk_chunk_path(batch_id, item["ordinal"])
                    if path.is_symlink() or path.parent.is_symlink() or not path.is_file():
                        raise BatchError("BULK_CHUNK_MISSING")
                    with path.open("rb") as stream:
                        raw = stream.read(bulk.MAX_CHUNK_BYTES + 1)
                    if len(raw) > bulk.MAX_CHUNK_BYTES:
                        raise BatchLimit("BATCH_LIMIT_EXCEEDED:indexed bulk chunk bytes")
                    rows = json.loads(raw)
                    if bulk.cell_matrix(rows, item, len(record["header"]["field_codes"])) != raw:
                        raise BatchError("BULK_CHUNK_DIGEST_MISMATCH")
                    yield rows

            try:
                result = self.service.submit_bulk_batch(record["header"], chunks())
            except (ValueError, BatchError) as exc:
                result = {"state": "rejected", "errors": [{"code": str(exc).split(":", 1)[0], "message": str(exc)}]}
            record["result"] = result
            record["phase"] = {"published_formal": "finalized", "unchanged": "finalized",
                               "rejected": "rejected", "conflicts_pending": "rejected"}.get(result["state"], "submit_unknown")
            self._atomic_json(self._record_path(batch_id), record)
            if record["phase"] == "finalized":
                self._finish_bulk_stage(record)
            return self._bulk_status(record)

    def _finish_bulk_stage(self, record):
        if not record.get("staging_released", False):
            self._release_bulk_stage(record)
            record["staging_released"] = True
            self._atomic_json(self._record_path(record["batch_id"]), record)

    def _release_bulk_stage(self, record):
        batch_id = record["batch_id"]
        for item in record["expected_chunks"]:
            path = self._bulk_chunk_path(batch_id, item["ordinal"])
            if path.parent.is_symlink():
                raise BatchError("BULK_PATH_SYMLINK")
            path.unlink(missing_ok=True)
        directory = self._bulk_chunk_path(batch_id, 0).parent
        if directory.is_dir():
            directory.rmdir()
        self.service.release_bulk_prep(record["header"]["request_identity"], record["format_version"])

    def read_source_minute_page(self, **arguments):
        return self.read_bulk_page(**arguments)

    def read_bulk_page(self, **arguments):
        self._require_read()
        if not callable(getattr(type(self.service), "read_bulk_page", None)):
            raise BatchError("BULK_VOLUME_REQUIRED")
        return self.service.read_bulk_page(**arguments)

    # -- public interface ------------------------------------------------
    def begin(self, batch_id, *, header, expected_chunks):
        self._require_write()
        if isinstance(header, dict) and header.get("protocol_version") in bulk.PROTOCOLS:
            return self._begin_indexed_bulk(batch_id, header, expected_chunks)
        if not isinstance(batch_id, str) or not batch_id:
            raise BatchError("BATCH_ID_REQUIRED")
        keys, pairs = self._validate_header(batch_id, header, expected_chunks)
        self._check_namespace(header)
        if len(pairs) > self.max_chunks:
            raise BatchLimit("BATCH_LIMIT_EXCEEDED:chunks")
        header_digest = _sha(header)
        manifest_digest = _sha(expected_chunks)
        header_bytes = len(_canonical(header))
        manifest_bytes = len(_canonical(expected_chunks))
        if header_bytes + manifest_bytes > self.max_bytes:
            raise BatchLimit("BATCH_LIMIT_EXCEEDED:payload_bytes")
        with writer_lock(self.root):
            index = self._read_json(self._index_path(batch_id))
            record = self._read_json(self._record_path(batch_id))
            if index is not None:
                if (index.get("header_digest") != header_digest
                        or index.get("manifest_digest") != manifest_digest):
                    raise BatchConflict("BATCH_ID_CONFLICT")
                if record is None or not self._owner_ok(record):
                    raise BatchError("BATCH_LEDGER_INCONSISTENT")
                return self._status_from_record(record)
            if record is not None:
                if not self._owner_ok(record):
                    raise BatchPermission("BATCH_PERMISSION_DENIED:owner")
                if (record.get("header_digest") != header_digest
                        or record.get("manifest_digest") != manifest_digest):
                    raise BatchConflict("BATCH_ID_CONFLICT")
                self._atomic_json(self._index_path(batch_id), {
                    "format_version": BATCH_FORMAT, "batch_id": batch_id,
                    "owner_caller_id": self.owner_id, "header_digest": header_digest,
                    "manifest_digest": manifest_digest, "record_key": self._key(batch_id),
                })
                return self._status_from_record(record)
            record = {
                "format_version": BATCH_FORMAT,
                "batch_id": batch_id,
                "owner_caller_id": self.owner_id,
                "dataset_id": header["request_identity"]["dataset_id"],
                "namespace": header["request_identity"]["trusted_actor_namespace"],
                "header": copy.deepcopy(header),
                "header_digest": header_digest,
                "manifest_digest": manifest_digest,
                "expected_chunks": copy.deepcopy(expected_chunks),
                "chunks": {},
                "phase": "collecting",
                "created_at": _now(),
                "updated_at": _now(),
                "finalize_attempts": 0,
                "submit": None,
                "limits": {"max_chunks": self.max_chunks, "max_rows": self.max_rows,
                           "max_bytes": self.max_bytes},
                "accounting": {"budget_bytes": self.max_bytes, "header_bytes": header_bytes,
                               "manifest_bytes": manifest_bytes, "chunk_bytes": 0,
                               "used_bytes": header_bytes + manifest_bytes,
                               "basis": "canonical_header+expected_manifest+received_chunks"},
            }
            self._atomic_json(self._record_path(batch_id), record)
            self._atomic_json(self._index_path(batch_id), {
                "format_version": BATCH_FORMAT, "batch_id": batch_id,
                "owner_caller_id": self.owner_id, "header_digest": header_digest,
                "manifest_digest": manifest_digest, "record_key": self._key(batch_id),
            })
            return self._status_from_record(record)

    def put_chunk(self, batch_id, *, output_key, chunk_id, rows, digest=None):
        self._require_write()
        if self._bulk_record(batch_id) is not None:
            return self._put_indexed_bulk(batch_id, output_key, chunk_id, rows, digest)
        if not isinstance(rows, list) or not rows or any(not isinstance(row, dict) for row in rows):
            raise BatchError("BATCH_CHUNK_ROWS_INVALID")
        if self.data_only:
            self._scan_forbidden(rows, "chunk.rows")
        try:
            raw = _canonical(rows)
        except (TypeError, ValueError) as exc:
            raise BatchError("BATCH_CHUNK_ROWS_NOT_JSON") from exc
        actual_digest = "sha256:" + hashlib.sha256(raw).hexdigest()
        if digest is not None and digest != actual_digest:
            raise BatchError("BATCH_CHUNK_DIGEST_MISMATCH")
        with writer_lock(self.root):
            record = self._read_json(self._record_path(batch_id))
            if record is None:
                raise BatchError("BATCH_NOT_FOUND")
            if not self._owner_ok(record):
                raise BatchPermission("BATCH_PERMISSION_DENIED:owner")
            self._check_namespace(record["header"])
            if record.get("phase") in {"finalized", "finalized_partial", "finalized_sandbox",
                                       "finalizing", "submit_unknown", "rejected"}:
                raise BatchError("BATCH_NOT_COLLECTING")
            pair = (output_key, chunk_id)
            if pair not in {(item["output_key"], item["chunk_id"])
                            for item in record["expected_chunks"]}:
                raise BatchError("BATCH_CHUNK_UNEXPECTED")
            chunks = record.get("chunks", {})
            chunk_key = output_key + "\x1f" + chunk_id
            if chunk_key in chunks:
                prior = chunks[chunk_key]
                if prior.get("digest") == actual_digest and prior.get("rows") == rows:
                    return self._status_from_record(record)
                raise BatchChunkConflict("BATCH_CHUNK_CONFLICT")
            total_rows = sum(item.get("rows_count", 0) for item in chunks.values()) + len(rows)
            accounting = self._accounting(record)
            total_bytes = accounting["used_bytes"] + len(raw)
            if total_rows > self.max_rows:
                raise BatchLimit("BATCH_LIMIT_EXCEEDED:rows")
            if total_bytes > self.max_bytes:
                raise BatchLimit("BATCH_LIMIT_EXCEEDED:payload_bytes")
            chunks[chunk_key] = {
                "output_key": output_key, "chunk_id": chunk_id,
                "rows": copy.deepcopy(rows), "rows_count": len(rows),
                "bytes": len(raw), "digest": actual_digest, "received_at": _now(),
            }
            record["chunks"] = chunks
            record["accounting"] = self._accounting(record)
            record["updated_at"] = _now()
            if len(chunks) == len(record["expected_chunks"]):
                record["phase"] = "ready"
            self._atomic_json(self._record_path(batch_id), record)
            return self._status_from_record(record)

    def status(self, batch_id, *, chunk_offset=0, chunk_limit=None):
        self._require_read()
        record = self._bulk_record(batch_id)
        if record is not None:
            status = self._bulk_status(record, chunk_offset, chunk_limit)
            if record["phase"] in {"finalizing", "submit_unknown"}:
                proof = self.service.reconcile_bulk_batch(record["header"])
                if proof.get("phase") == "finalized":
                    proof["staging_cleanup_required"] = True
                return {**status, **proof}
            return status
        record = self._read_json(self._record_path(batch_id))
        if record is None:
            return {"format_version": BATCH_FORMAT, "batch_id": batch_id,
                    "status": "not_found", "phase": "not_found",
                    "received": [], "missing": [], "snapshot_id": None,
                    "chunks_offset": 0, "chunks_included": 0,
                    "chunks_total": 0, "chunks_has_more": False,
                    "next_chunk_offset": None, "submit": None}
        if not self._owner_ok(record):
            raise BatchPermission("BATCH_PERMISSION_DENIED:owner")
        return self._status_from_record(record, chunk_offset=chunk_offset,
                                        chunk_limit=chunk_limit)

    def _status_from_record(self, record, *, chunk_offset=0, chunk_limit=None):
        chunks = record.get("chunks", {})
        expected = record.get("expected_chunks", [])
        total = len(expected)
        offset = max(0, min(int(chunk_offset or 0), total))
        if chunk_limit is None:
            limit = total - offset
        else:
            limit = max(0, int(chunk_limit))
        page = expected[offset:offset + limit]
        received, missing, per_output = [], [], {}
        for index, item in enumerate(expected):
            output_key, chunk_id = item["output_key"], item["chunk_id"]
            chunk = chunks.get(output_key + "\x1f" + chunk_id)
            bucket = per_output.setdefault(output_key, {"expected_chunks": 0,
                                                        "received_chunks": 0,
                                                        "received_rows": 0})
            bucket["expected_chunks"] += 1
            if chunk:
                bucket["received_chunks"] += 1
                bucket["received_rows"] += chunk.get("rows_count", 0)
        for index, item in enumerate(page, start=offset):
            output_key, chunk_id = item["output_key"], item["chunk_id"]
            chunk = chunks.get(output_key + "\x1f" + chunk_id)
            info = {"declared_index": index, "output_key": output_key,
                    "chunk_id": chunk_id}
            if chunk:
                info.update({"rows": chunk.get("rows_count"),
                             "digest": chunk.get("digest"),
                             "received_at": chunk.get("received_at")})
                received.append(info)
            else:
                missing.append(info)
        raw_submit = record.get("submit")
        submit = raw_submit or {}
        if self.data_only:
            state = submit.get("state") or submit.get("status")
            formal_ref = submit.get("formal_publication_ref")
            formal_verified = bool(submit.get("formal_publication_verified"))
            if raw_submit:
                submit_view = {}
                for key in ("state", "status", "snapshot_id", "input_fingerprint",
                            "formal_publication_ref", "formal_publication_verified",
                            "idempotent_replay", "request_key", "service_version",
                            "error"):
                    if key in submit:
                        submit_view[key] = copy.deepcopy(submit[key])
                submit_view["outputs_total"] = len(submit.get("output_results") or [])
                if submit.get("errors"):
                    submit_view["errors"] = copy.deepcopy(submit["errors"])
            else:
                submit_view = None
        else:
            submit_view = copy.deepcopy(submit)
            state = None
            formal_ref = None
            formal_verified = None
        result = {
            "format_version": BATCH_FORMAT, "batch_id": record["batch_id"],
            "status": record.get("phase", "unknown"), "phase": record.get("phase", "unknown"),
            "header_digest": record.get("header_digest"),
            "manifest_digest": record.get("manifest_digest"),
            "received": received, "missing": missing, "per_output": per_output,
            "expected_chunks": total,
            "received_chunks": sum(bucket["received_chunks"] for bucket in per_output.values()),
            "missing_chunks": total - sum(bucket["received_chunks"]
                                          for bucket in per_output.values()),
            "chunks_offset": offset, "chunks_included": len(page),
            "chunks_total": total, "chunks_has_more": offset + len(page) < total,
            "next_chunk_offset": (offset + len(page)
                                  if offset + len(page) < total else None),
            "limits": copy.deepcopy(record.get("limits")),
            "snapshot_id": submit.get("snapshot_id"),
            "submit": submit_view,
            "last_attempt": copy.deepcopy(record.get("last_attempt")),
            "accounting": copy.deepcopy(record.get("accounting") or self._accounting(record)),
            "stored_record_bytes": self._record_path(record["batch_id"]).stat().st_size
                                   if self._record_path(record["batch_id"]).is_file() else None,
            "finalize_attempts": record.get("finalize_attempts", 0),
            "updated_at": record.get("updated_at"),
        }
        if self.data_only:
            result["state"] = state
            result["request_identity"] = copy.deepcopy(
                (record.get("header") or {}).get("request_identity"))
            result["formal_publication_ref"] = formal_ref
            result["formal_publication_verified"] = formal_verified
            result["chunks_paged"] = (limit < total)
        return result

    def _build_doc(self, record):
        chunks = record.get("chunks", {})
        doc = copy.deepcopy(record["header"])
        for out in doc["outputs"]:
            rows = []
            for item in record["expected_chunks"]:
                if item["output_key"] != out["output_key"]:
                    continue
                chunk = chunks.get(out["output_key"] + "\x1f" + item["chunk_id"])
                if chunk is None:
                    raise BatchIncomplete(self._status_from_record(record))
                rows.extend(copy.deepcopy(chunk["rows"]))
            out.setdefault("payload", {})["rows"] = rows
        return doc

    @staticmethod
    def _phase_for_result(status):
        return {"published_formal": "finalized",
                "partially_published_formal": "finalized_partial",
                "published_sandbox": "finalized_sandbox",
                "partially_published_sandbox": "finalized_partial",
                "unchanged": "finalized",
                "conflicts_pending": "finalized_partial",
                "published_commit_pending_head": "finalized_pending",
                "published_commit_pending_formal": "finalized_pending",
                "published_formal_pending_receipt": "finalized_pending",
                "rejected": "rejected",
                "publication_unknown": "submit_unknown",
                "recovery_conflict": "submit_unknown",
                "storage_inconsistent": "submit_unknown",
                "unknown": "submit_unknown",
                "registered_not_published": "rejected"}.get(status, "finalized_other")

    def finalize(self, batch_id):
        self._require_write()
        if self._bulk_record(batch_id) is not None:
            return self._finalize_indexed_bulk(batch_id)
        with writer_lock(self.root):
            record = self._read_json(self._record_path(batch_id))
            if record is None:
                raise BatchError("BATCH_NOT_FOUND")
            if not self._owner_ok(record):
                raise BatchPermission("BATCH_PERMISSION_DENIED:owner")
            if self.data_only:
                return self._finalize_data_only(batch_id, record)
            if record.get("phase") in {"finalized", "finalized_partial", "finalized_sandbox"}:
                return self._final_result(record)
            try:
                self._check_namespace(record["header"])
            except BatchPermission as exc:
                errors = [{"code": "BATCH_NAMESPACE_UNTRUSTED", "message": str(exc)}]
                self._record_last_attempt(record, errors)
                self._atomic_json(self._record_path(batch_id), record)
                return self._preflight_result(record, errors)
            missing = [item for item in record["expected_chunks"]
                       if item["output_key"] + "\x1f" + item["chunk_id"] not in record.get("chunks", {})]
            if missing:
                raise BatchIncomplete(self._status_from_record(record))
            doc = self._build_doc(record)
            identity = record["header"]["request_identity"]
            try:
                prior = self.service.request_status(identity)
            except PermissionError:
                prior = {}
            # Recovery is content-bound: same identity alone is not enough.
            actual_fingerprint = self.service.engine._request_fingerprint(doc)
            prior_fingerprint = prior.get("input_fingerprint")
            prior_caller = prior.get("caller_id")
            if prior_fingerprint is not None:
                if (prior_caller != self.owner_id
                        or prior_fingerprint != actual_fingerprint
                        or prior.get("request_identity") != identity):
                    errors = [{"code": "BATCH_REQUEST_CONFLICT",
                               "message": "Original request identity has different body fingerprint or owner"}]
                    self._record_last_attempt(record, errors)
                    self._atomic_json(self._record_path(batch_id), record)
                    raise BatchConflict("BATCH_REQUEST_CONFLICT")
            if prior.get("state") in {"published_formal", "partially_published_formal",
                                      "published_sandbox", "partially_published_sandbox"}:
                record["submit"] = {"status": prior.get("state"), "snapshot_id": prior.get("snapshot_id"),
                                    "output_results": prior.get("output_results", []),
                                    "recovered_from_request_status": True,
                                    "input_fingerprint": prior_fingerprint}
                record["phase"] = self._phase_for_result(prior.get("state"))
                record["updated_at"] = _now()
                self._atomic_json(self._record_path(batch_id), record)
                return self._final_result(record)
            preflight = self._preflight_errors(doc)
            if preflight:
                self._record_last_attempt(record, preflight)
                self._atomic_json(self._record_path(batch_id), record)
                return self._preflight_result(record, preflight)
            record["phase"] = "finalizing"
            record["finalize_attempts"] = int(record.get("finalize_attempts", 0)) + 1
            record["last_attempt"] = None
            record["updated_at"] = _now()
            self._atomic_json(self._record_path(batch_id), record)
            try:
                result = self.service.submit(doc)
            except Exception as exc:  # preserve chunks and unknown fact; retry checks request_status
                record["phase"] = "submit_unknown"
                record["submit"] = {"status": "publication_unknown",
                                    "snapshot_id": None, "output_results": [],
                                    "error": repr(exc), "input_fingerprint": actual_fingerprint}
                record["updated_at"] = _now()
                self._atomic_json(self._record_path(batch_id), record)
                return self._final_result(record)
            status = result.get("status", "unknown")
            record["submit"] = {
                "status": status, "snapshot_id": result.get("snapshot_id"),
                "output_results": copy.deepcopy(result.get("output_results", [])),
                "errors": copy.deepcopy(result.get("errors", [])),
                "engine_receipt": copy.deepcopy(result.get("engine_receipt")),
                "request_state": result.get("request_state"),
                "production_publishable": result.get("production_publishable"),
                "input_fingerprint": actual_fingerprint,
            }
            record["phase"] = self._phase_for_result(status)
            record["updated_at"] = _now()
            self._atomic_json(self._record_path(batch_id), record)
            return self._final_result(record)

    def _finalize_data_only(self, batch_id, record):
        """Always re-submit the exact assembled document for authoritative state."""
        prior_phase = record.get("phase")
        try:
            self._check_namespace(record["header"])
        except BatchPermission as exc:
            errors = [{"code": "BATCH_NAMESPACE_UNTRUSTED", "message": str(exc)}]
            self._record_last_attempt(record, errors)
            record["phase"] = prior_phase
            self._atomic_json(self._record_path(batch_id), record)
            return self._preflight_result(record, errors)
        missing = [item for item in record["expected_chunks"]
                   if item["output_key"] + "\x1f" + item["chunk_id"]
                   not in record.get("chunks", {})]
        if missing:
            raise BatchIncomplete(self._status_from_record(record))
        doc = self._build_doc(record)
        fingerprint = _sha(doc)
        prior = record.get("submit") or {}
        prior_fingerprint = prior.get("input_fingerprint")
        if prior_fingerprint is not None and prior_fingerprint != fingerprint:
            errors = [{"code": "BATCH_REQUEST_CONFLICT",
                       "message": "Reconstructed document fingerprint differs from the prior attempt"}]
            self._record_last_attempt(record, errors)
            self._atomic_json(self._record_path(batch_id), record)
            raise BatchConflict("BATCH_REQUEST_CONFLICT")
        prior_snapshot = prior.get("snapshot_id")
        record["phase"] = "finalizing"
        record["finalize_attempts"] = int(record.get("finalize_attempts", 0)) + 1
        record["last_attempt"] = None
        record["updated_at"] = _now()
        self._atomic_json(self._record_path(batch_id), record)
        try:
            result = self.service.submit(doc)
        except PermissionError as exc:
            code = str(exc).split(":", 1)[0] or "CALLER_PERMISSION_DENIED"
            errors = [{"code": code, "message": str(exc)}]
            self._record_last_attempt(record, errors)
            record["phase"] = prior_phase
            self._atomic_json(self._record_path(batch_id), record)
            return self._preflight_result(record, errors)
        except Exception as exc:
            record["phase"] = "submit_unknown"
            record["submit"] = {
                "state": "publication_unknown", "status": "publication_unknown",
                "snapshot_id": None, "output_results": [],
                "error": repr(exc), "input_fingerprint": fingerprint,
                "formal_publication_ref": None,
                "formal_publication_verified": False,
                "idempotent_replay": False,
            }
            record["updated_at"] = _now()
            self._atomic_json(self._record_path(batch_id), record)
            return self._final_result(record)
        state = result.get("state") or result.get("status") or "unknown"
        if (prior_snapshot is not None and result.get("snapshot_id") is not None
                and prior_snapshot != result.get("snapshot_id")
                and state in {"published_formal", "partially_published_formal"}):
            errors = [{"code": "BATCH_REQUEST_CONFLICT",
                       "message": "Authoritative submit returned a different snapshot for the same request"}]
            self._record_last_attempt(record, errors)
            record["phase"] = "submit_unknown"
            self._atomic_json(self._record_path(batch_id), record)
            raise BatchConflict("BATCH_REQUEST_CONFLICT")
        formal_verified = bool(result.get("formal_publication_verified"))
        phase = self._phase_for_result(state)
        if phase == "finalized_other":
            phase = "submit_unknown"
        if state == "published_formal" and not formal_verified:
            phase = "finalized_pending"
        record["submit"] = {
            "state": state, "status": state,
            "snapshot_id": result.get("snapshot_id"),
            "output_results": copy.deepcopy(result.get("output_results", [])),
            "errors": copy.deepcopy(result.get("errors", [])),
            "request_state": result.get("request_state"),
            "production_publishable": result.get("production_publishable"),
            "formal_publication_ref": result.get("formal_publication_ref"),
            "formal_publication_verified": formal_verified,
            "idempotent_replay": bool(result.get("idempotent_replay")),
            "recovered_from_request_status": bool(result.get("recovered_from_request_status")),
            "request_key": result.get("request_key"),
            "service_version": result.get("service_version"),
            "input_fingerprint": fingerprint,
        }
        for name in ("duplicate_policy", "row_summary", "new_snapshot_created"):
            if name in result:
                record["submit"][name] = copy.deepcopy(result[name])
        record["phase"] = phase
        record["updated_at"] = _now()
        self._atomic_json(self._record_path(batch_id), record)
        return self._final_result(record)

    def _final_result(self, record):
        submit = copy.deepcopy(record.get("submit") or {})
        result = {
            "format_version": BATCH_FORMAT, "batch_id": record["batch_id"],
            "phase": record.get("phase"), "status": submit.get("status", "unknown"),
            "snapshot_id": submit.get("snapshot_id"),
            "output_results": submit.get("output_results", []),
            "errors": submit.get("errors", []),
            "request_state": submit.get("request_state"),
            "recovered_from_request_status": submit.get("recovered_from_request_status", False),
            "status_detail": self._status_from_record(record),
        }
        if self.data_only:
            result["state"] = submit.get("state") or submit.get("status", "unknown")
            result["status"] = result["state"]
            result["request_identity"] = copy.deepcopy(
                (record.get("header") or {}).get("request_identity"))
            result["formal_publication_ref"] = submit.get("formal_publication_ref")
            result["formal_publication_verified"] = bool(
                submit.get("formal_publication_verified"))
            result["request_key"] = submit.get("request_key")
            result["service_version"] = submit.get("service_version")
            result["status_detail"] = self._status_from_record(
                record, chunk_offset=0, chunk_limit=20)
            for name in ("duplicate_policy", "row_summary", "new_snapshot_created"):
                if name in submit:
                    result[name] = copy.deepcopy(submit[name])
        return result
