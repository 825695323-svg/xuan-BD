#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Thin R2 seam: R1 data-only admission -> VolumePublisher -> target read.

No new storage/snapshot protocol is introduced.  The actual volume copy,
activation and target fixed read remain in ``volume_publication``.
"""
from __future__ import annotations

import copy
import json
import re
import shutil
from pathlib import Path
from typing import Any, Mapping

from . import product_calendar, row_version_objects
from .duckdb_sdk import WFDDuckDBPrototype, canonical, load_protocol_validator, sha
from .product_data_service import (
    DATA_ONLY_PROFILE, WFDDataOnlyService, validate_data_only_metadata, fixed_read_page_capabilities,
    fixed_read_product_page_capabilities,
)
from .product_holdings import HoldingLedger
from .volume_publication import (
    PreparationInstance, PrepFile, VolumeBinding, VolumePublisher, VolumeError,
    _add_product_closure, _add_row_version_closure, _atomic_write, _path_within,
    _read_json, _reject_symlink_path, _safe_relpath, _snapshot_fixed_products, sha256_file,
)


_SNAPSHOT_ID_RE = re.compile(r"^s_[0-9a-f]{24}$")


class WFDVolumeService:
    """Machine-facing data-only service bound to one trusted target volume."""

    profile = "data_only"

    def __init__(self, *, binding: VolumeBinding, runtime_root: str | Path,
                 protocol_root: str | Path, prep_root: str | Path | None = None,
                 caller_roles=("read", "register", "submit", "publish"),
                 caller_id: str = "volume-reader",
                 unit_registry: Mapping[str, Any] | None = None,
                 trusted_actor_namespaces=("wfd.local",),
                 detector=None, fault_injector=None):
        self.binding = binding
        self.root = Path(binding.mount_point)
        self.runtime_root = Path(runtime_root)
        if _path_within(self.runtime_root, self.root):
            raise ValueError("VOLUME_RUNTIME_INSIDE_VOLUME")
        self.protocol_root = Path(protocol_root)
        self.prep_root = Path(prep_root or (self.runtime_root / "prep"))
        self.caller_roles = set(caller_roles)
        self.caller_id = caller_id
        self.unit_registry = dict(unit_registry or {})
        self.trusted_actor_namespaces = set(trusted_actor_namespaces)
        self.detector = detector
        self.fault_injector = fault_injector
        from .writerlock import configure_lock_root
        configure_lock_root(self.root, self.runtime_root / "locks" / binding.instance_id)
        self._read_engine = None
        self._read_service = None
        self._validation_service = None
        self.last_hydration = None

    def _verify_volume(self, *, write=False):
        detector = self.detector
        if detector is None:
            from .volume_publication import SystemVolumeDetector
            detector = SystemVolumeDetector()
        try:
            try:
                return detector.verify(self.root, expected_uuid=self.binding.volume_uuid,
                                       filesystem=self.binding.filesystem,
                                       require_writable=write)
            except TypeError:
                return detector.verify(self.root, expected_uuid=self.binding.volume_uuid,
                                       filesystem=self.binding.filesystem)
        except VolumeError as exc:
            if exc.code == "VOLUME_NOT_WRITABLE":
                raise
            raise VolumeError("STORAGE_TIER_UNAVAILABLE", str(exc), path=self.root) from exc
        except Exception as exc:
            raise VolumeError("STORAGE_TIER_UNAVAILABLE", str(exc), path=self.root) from exc

    # ---------------------------------------------------------------- target read
    def _target_service(self):
        self._verify_volume()
        if self._read_service is None:
            engine = WFDDuckDBPrototype.open_existing(
                self.root, load_protocol_validator(self.protocol_root),
                runtime_root=self.runtime_root / "target_read",
                sandbox=False, read_only=True,
            )
            self._read_engine = engine
            self._read_service = WFDDataOnlyService(
                engine, caller_roles=self.caller_roles, caller_id=self.caller_id,
                unit_registry=self.unit_registry,
                trusted_actor_namespaces=self.trusted_actor_namespaces,
            )
        return self._read_service

    @property
    def engine(self):
        return self._target_service().engine

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._target_service(), name)

    def capabilities(self):
        if not (self.root / "catalog/state.json").is_file():
            from .product_service import CONTRACT_VERSION, SERVICE_VERSION
            schema = self.structured_schema_info()
            caps = {
                "format_version": "wfd.product-capabilities/0.3",
                "service_version": SERVICE_VERSION,
                "contract_version": CONTRACT_VERSION,
                "ingest_protocol": "wfd.structured-ingest/1.0",
                "profile": DATA_ONLY_PROFILE,
                "structured_ingest": "wfd.structured-ingest/1.0",
                "structural_validation": {
                    "enforced": True,
                    "schema_id": schema["schema_id"],
                    "schema_sha256": schema["schema_sha256"],
                    "schema_canonical_sha256": schema["schema_canonical_sha256"],
                    "sample_path": schema["sample_path"],
                },
                "operations": {
                    "submit": {"supported": True, "protocol": "wfd.structured-ingest/1.0",
                               "duplicate_policies": ["skip_identical_append"]}, "fixed_read": {"supported": True},
                    "fixed_read_page": fixed_read_page_capabilities(),
                    "fixed_read_product_page": fixed_read_product_page_capabilities(),
                    "request_status": {"supported": True}, "recovery": {"supported": True},
                    "contract_discovery": {"supported": True},
                    "read_product": {"supported": True},
                    "capabilities": {"supported": True}, "schema": {"supported": True},
                },
                "boundary": {"stored_by_wfd": ["admitted structured data"],
                             "not_stored_by_wfd": ["original files", "source/evidence locators"]},
                "unsupported": [{"operation": "evidence_ingest", "reason": "data_only"}],
            }
        else:
            caps = dict(self._target_service().capabilities())
        from . import indexed_bulk as bulk
        caps["profile"] = DATA_ONLY_PROFILE
        caps["bulk_tabular"] = {
            "protocol_version": bulk.tabular.PROTOCOL,
            "read_operation": "batch_read_page",
            "write_scope": "one_complete_partition",
            "max_fields": bulk.tabular.MAX_FIELDS,
            "cell_types": ["text", "null"],
            "mixed_ordinary_snapshot": True,
        }
        caps["volume"] = {
            "binding": self.binding.to_dict(),
            "target_read_only": True,
            "operations": ["submit", "recovery", "request_status", "fixed_read", "fixed_read_page", "fixed_read_product_page",
                           "contract_discovery", "read_product", "query_capabilities"],
            "source_evidence_upload": False,
            "trace": False,
            "required_internal_refs": "R1 unsupported refs remain rejected",
        }
        return caps

    def structured_schema_info(self):
        # P2 selects the additive ingest schema explicitly on the volume seam too,
        # so the reported identity is the same one the preparation store validates.
        entry = WFDDataOnlyService.structured_schema_entry
        raw = (self.protocol_root / Path(entry).relative_to("protocol")).read_bytes()
        data = json.loads(raw)
        return {
            "schema_id": data.get("$id"),
            "schema_sha256": "sha256:" + sha(raw),
            "schema_canonical_sha256": "sha256:" + sha(canonical(data)),
            "protocol_version": "wfd.structured-ingest/1.0",
            "spec_version": "1.1",
            "additive_over": "https://wfd.example/spec/1.0/wfd-structured-ingest.schema.json",
            "profile": DATA_ONLY_PROFILE,
            "sample_path": "protocol/samples/wfd-structured-ingest.example.json",
        }

    def read(self, product_id=None, **kwargs):
        self._require("read")
        self._verify_volume()
        return self._target_service().read(product_id, **kwargs)

    def read_page(self, product_id, **kwargs):
        self._require("read")
        self._verify_volume()
        return self._target_service().read_page(product_id, **kwargs)

    def read_product_page(self, product_id, **kwargs):
        self._require("read")
        self._verify_volume()
        return self._target_service().read_product_page(product_id, **kwargs)

    def discover_products(self, **kwargs):
        from . import indexed_bulk as bulk
        self._require("read")
        self._verify_volume()
        service = self._target_service()
        result = service.discover_products(**kwargs)
        snapshot = service.engine._valid_snapshot_exact(kwargs.get("snapshot_id"), verify_payloads=False)
        indexed = bulk.indexed_products(self.root, snapshot)
        if indexed:
            for protocol, ref in indexed.values():
                product = bulk.read_node(self.root, ref, "product", protocol=protocol)["product"]
                if kwargs.get("subject") is None or kwargs["subject"] == product.get("subject"):
                    service._verify_binding(product)
                    result["products"].append(service._public_product(product))
            result["public_projection"] = service._public_projection_metadata(
                result["products"], result.get("source_ids", []))
        return result

    def snapshot_status(self):
        from . import indexed_bulk as bulk
        self._require("read")
        self._verify_volume()
        state_path = self.root / "catalog/state.json"
        state = _read_json(state_path) if state_path.is_file() else {}
        sid = state.get("active_head")
        if bulk.has_bulk_marker(self.root, sid):
            from .state import StateStore
            snapshot = bulk.read_snapshot(self.root, sid, expected_sha=state["head_snapshot_sha256"])
            resolved = StateStore(self.root).resolve({sid: snapshot})
            if not resolved["ok"]:
                raise ValueError(resolved["code"])
            if _read_json(state_path) != state:
                raise ValueError("HEAD_CHANGED")
            units = {code: {"definition": definition,
                           "digest": "sha256:" + sha(canonical({"code": code, "definition": definition}))}
                     for code, definition in sorted(self.unit_registry.items())}
            return {"format_version": "wfd.snapshot-status/1", "profile": DATA_ONLY_PROFILE,
                    "snapshot_id": sid, "empty": False, "authority": "active_head", "caller_id": self.caller_id,
                    "caller_roles": sorted(self.caller_roles),
                    "unit_definitions": self._target_service()._public_unit_definitions(units)}
        return self._target_service().snapshot_status()

    def trace(self, *args, **kwargs):
        raise ValueError("TRACE_NOT_AVAILABLE_IN_DATA_ONLY_PROFILE")

    # ---------------------------------------------------------------- target status
    def _request_key(self, identity):
        return sha(canonical([identity["dataset_id"], identity["trusted_actor_namespace"],
                              identity["request_id"]]))

    def has_permission(self, role):
        """Pure trusted-role check; no target reader/store access."""
        return role in self.caller_roles

    def require_permission(self, role):
        """Pure trusted-role check; no target reader/store access."""
        if role not in self.caller_roles:
            raise PermissionError("CALLER_PERMISSION_DENIED:" + str(role))
        return True

    def actor_namespace_allowed(self, namespace):
        """Pure trusted namespace check used by the batch ledger."""
        return namespace in self.trusted_actor_namespaces

    def _require(self, role):
        if role not in self.caller_roles:
            raise PermissionError("CALLER_PERMISSION_DENIED:" + role)

    def _new_versions(self, snapshot, parent_id, key_name, product_id):
        parent_paths = set()
        if parent_id:
            parent = self._target_service().engine.read_snapshot(parent_id)
            parent_paths = {entry.get("file_relpath") for entry in parent.get("files", [])}
        found = set()
        for entry in snapshot.get("files", []):
            if entry.get("output_key") != key_name or entry.get("product_id") != product_id:
                continue
            if entry.get("file_relpath") in parent_paths:
                continue
            versions = (entry.get("source_bundle") or {}).get(
                "_wfd_row_versions", {}).get(key_name, {})
            for value in versions.values():
                found.add((value.get("logical_key"), value.get("revision_id")))
        return found

    def _verify_target_formal(self, record):
        """Revalidate the volume objects, not just a formal JSON marker."""
        engine = self._target_service().engine
        sid = record.get("snapshot_id")
        snapshot = engine.read_snapshot(sid)
        state = engine.state.read() or {}
        history = {item.get("snapshot_id") for item in state.get("activation_history", [])
                   if isinstance(item, dict)}
        if state.get("active_head") != sid and sid not in history and sid not in engine._active_ancestry():
            raise ValueError("FORMAL_SNAPSHOT_NEVER_ACTIVATED")
        entries = {(entry.get("output_key"), entry.get("product_id")): entry
                   for entry in snapshot.get("files", [])}
        outputs = record.get("outputs") or []
        if not outputs:
            raise ValueError("FORMAL_OUTPUTS_EMPTY")
        for expected in outputs:
            key_name = expected.get("output_key")
            product_id = expected.get("product_id")
            entry = entries.get((key_name, product_id))
            if entry is None:
                raise ValueError("FORMAL_OUTPUT_NOT_IN_SNAPSHOT:" + str(product_id))
            binding = (entry.get("source_bundle") or {}).get(
                "_wfd_product_bindings", {}).get(key_name)
            product = (binding or {}).get("product")
            if not product or product.get("product_id") != product_id:
                raise ValueError("FORMAL_PRODUCT_BINDING_MISMATCH")
            if (expected.get("contract_refs") or {}) != (product.get("contract_refs") or {}):
                raise ValueError("FORMAL_CONTRACT_MISMATCH")
            versions = (entry.get("source_bundle") or {}).get(
                "_wfd_row_versions", {}).get(key_name, {})
            actual = {(value.get("logical_key"), value.get("revision_id"))
                      for value in versions.values()}
            wanted = {(item.get("record_id"), item.get("record_version"))
                      for item in expected.get("records", [])}
            new_versions = self._new_versions(
                snapshot, snapshot.get("parent_snapshot_id"), key_name, product_id)
            if not wanted or new_versions != wanted:
                raise ValueError("FORMAL_RECORD_SET_MISMATCH:" + str(product_id))
            intent = self._load_target_intent(record.get("request_key"))
            if intent is not None:
                target = next((item for item in intent.get("outputs", [])
                               if item.get("output_key") == key_name
                               and item.get("product_id") == product_id), None)
                if target is None or target.get("records") != expected.get("records"):
                    raise ValueError("FORMAL_INTENT_RECORD_MISMATCH:" + str(product_id))
            # Reuse the real public fixed read so contract bodies/bundles are
            # resolved from the volume, not just ref objects compared.
            read = self._target_service()._read(
                product_id, snapshot_id=sid, perspective="snapshot_contents",
                include_history=True, verify_contract_files=True)
            actual_product = next((item for item in read.get("products", [])
                                   if item.get("product_id") == product_id), None)
            if actual_product is None:
                raise ValueError("FORMAL_PRODUCT_NOT_READABLE:" + str(product_id))
            for field in ("contract_refs", "contract_bundle_ref", "definition_ref"):
                if (actual_product.get(field) or {}) != (expected.get(field) or {}):
                    raise ValueError("FORMAL_" + field.upper() + "_MISMATCH")
            actual_records = set()
            for row in read.get("rows", []):
                ref = row.get("record_ref") or {}
                actual_records.add((ref.get("logical_key") or row.get("record_id"),
                                    ref.get("revision_id") or row.get("record_version")))
            if not wanted.issubset(actual_records):
                raise ValueError("FORMAL_RECORD_SET_MISMATCH:" + str(product_id))
        return True

    def _formal_status(self, identity, document=None):
        self._verify_volume()
        key = self._request_key(identity)
        if not (self.root / "catalog/state.json").is_file():
            return None
        path = self.root / f"catalog/product_service/data_only_formal_publications/{key}.json"
        if not path.is_file():
            return None
        try:
            record = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            return None
        if (record.get("request_key") != key
                or record.get("formal_publication_state") != "published_formal"):
            return None
        from . import indexed_bulk as bulk
        if record.get("protocol_version") in bulk.PROTOCOLS:
            if dict(record.get("request_identity") or {}) != dict(identity) or document is not None:
                return self._rejected_document({"request_identity": identity}, ValueError("REQUEST_ID_CONFLICT"))
            locator = bulk.locator(record)
            snap = bulk.read_snapshot(self.root, locator["snapshot_id"], protocol=record["protocol_version"])
            leaf = bulk.partition_leaf(self.root, snap, locator["product_id"], locator["partition"], locator["result_root"])
            if (leaf["header"]["request_identity"] != identity or snap["request_key"] != key
                    or bulk.locator(snap) != locator):
                return self._rejected_document({"request_identity": identity}, ValueError("BULK_FORMAL_RECEIPT_MISMATCH"))
            return self.reconcile_bulk_batch(leaf["header"])
        if dict(record.get("request_identity") or {}) != dict(identity):
            return {
                "protocol_version": "wfd.structured-ingest/1.0",
                "profile": DATA_ONLY_PROFILE,
                "request_key": key,
                "request_identity": dict(record.get("request_identity") or {}),
                "state": "rejected",
                "snapshot_id": None,
                "output_results": [],
                "formal_publication_ref": None,
                "formal_publication_verified": False,
                "errors": [{"code": "REQUEST_ID_CONFLICT",
                            "message": "full request identity/digest differs from stored formal"}],
            }
        if document is not None and record.get("input_fingerprint") != sha(canonical(document)):
            return {
                "protocol_version": "wfd.structured-ingest/1.0",
                "profile": DATA_ONLY_PROFILE,
                "request_key": key,
                "request_identity": dict(record.get("request_identity") or {}),
                "state": "rejected",
                "snapshot_id": None,
                "output_results": [],
                "formal_publication_ref": None,
                "formal_publication_verified": False,
                "errors": [{"code": "REQUEST_ID_CONFLICT",
                            "message": "canonical document fingerprint differs from stored formal"}],
            }
        try:
            self._verify_target_formal(record)
        except Exception as exc:
            return {
                "protocol_version": "wfd.structured-ingest/1.0",
                "profile": DATA_ONLY_PROFILE,
                "request_key": key,
                "request_identity": dict(record.get("request_identity") or identity),
                "state": "storage_inconsistent",
                "snapshot_id": record.get("snapshot_id"),
                "output_results": [],
                "formal_publication_ref": None,
                "formal_publication_verified": False,
                "errors": [{"code": "FORMAL_STORAGE_INCONSISTENT",
                            "message": type(exc).__name__ + ": " + str(exc)}],
            }
        outputs = []
        for item in record.get("outputs", []):
            outputs.append({
                "output_key": item.get("output_key"),
                "product_id": item.get("product_id"),
                "registration_state": "reused",
                "publication_state": "published_formal",
                "snapshot_id": record.get("snapshot_id"),
                "records": copy.deepcopy(item.get("records") or []),
                "definition_ref": copy.deepcopy(item.get("definition_ref")),
                "contract_ref": copy.deepcopy(item.get("contract_ref")),
                "contract_refs": copy.deepcopy(item.get("contract_refs")),
                "contract_bundle_ref": copy.deepcopy(item.get("contract_bundle_ref")),
            })
        return self._duplicate_status({
            "protocol_version": "wfd.structured-ingest/1.0",
            "profile": DATA_ONLY_PROFILE,
            "service_version": record.get("service_version"),
            "request_key": key,
            "request_identity": dict(identity),
            "state": "published_formal",
            "snapshot_id": record.get("snapshot_id"),
            "output_results": outputs,
            "formal_publication_ref": str(path.relative_to(self.root)),
            "formal_publication_checks": copy.deepcopy(record.get("checks") or {}),
            "formal_publication_verified": True,
            "idempotent_replay": True,
            "errors": [],
            **({"duplicate_policy": record["duplicate_policy"]} if record.get("duplicate_policy") else {}),
            "volume": {"binding": self.binding.to_dict(),
                       "source": "target_immutable_formal_receipt"},
        })

    def request_status(self, request_identity):
        self._require("read")
        self._verify_volume()
        plan = self._duplicate_plan(request_identity)
        if plan and plan["result"].get("state") in {"unchanged", "conflicts_pending", "rejected"}:
            return {**copy.deepcopy(plan["result"]), "idempotent_replay": True}
        return self._duplicate_status(self._request_status(request_identity))

    def _request_status(self, request_identity):
        self._require("read")
        identity = dict(request_identity)
        formal = self._formal_status(identity)
        if formal is not None:
            return formal
        key = self._request_key(identity)
        if not (self.root / "catalog/state.json").is_file():
            return {
                "protocol_version": "wfd.structured-ingest/1.0",
                "profile": DATA_ONLY_PROFILE,
                "request_key": key,
                "request_identity": identity,
                "state": "unknown",
                "snapshot_id": None,
                "output_results": [],
                "formal_publication_ref": None,
                "formal_publication_verified": False,
                "idempotent_replay": False,
                "errors": [],
                "volume": {"binding": self.binding.to_dict(),
                           "source": "target_uninitialized"},
            }
        engine = self._target_service().engine
        known = engine._known_request(key)
        state = engine.state.read() or {}
        if known and known.get("snapshot_id"):
            sid = known.get("snapshot_id")
            intent = self._load_target_intent(key)
            if intent is not None:
                try:
                    snap_check = engine.read_snapshot(sid)
                    for target in intent.get("outputs", []):
                        new_set = self._new_versions(
                            snap_check, snap_check.get("parent_snapshot_id"),
                            target.get("output_key"), target.get("product_id"))
                        wanted = {(r.get("record_id"), r.get("record_version"))
                                  for r in target.get("records", [])}
                        if not wanted or new_set != wanted:
                            raise ValueError("TARGET_RECORD_SET_MISMATCH")
                except Exception as exc:
                    return {
                        "protocol_version": "wfd.structured-ingest/1.0",
                        "profile": DATA_ONLY_PROFILE, "request_key": key,
                        "request_identity": identity, "state": "storage_inconsistent",
                        "snapshot_id": sid, "output_results": [],
                        "formal_publication_ref": None,
                        "formal_publication_verified": False,
                        "errors": [{"code": "FORMAL_STORAGE_INCONSISTENT",
                                    "message": type(exc).__name__ + ": " + str(exc)}],
                    }
            active = state.get("active_head")
            history = {item.get("snapshot_id") for item in state.get("activation_history", [])
                       if isinstance(item, dict)}
            outputs = []
            try:
                snapshot = engine.read_snapshot(sid)
                parent_paths = set()
                if snapshot.get("parent_snapshot_id"):
                    parent = engine.read_snapshot(snapshot["parent_snapshot_id"])
                    parent_paths = {entry.get("file_relpath") for entry in parent.get("files", [])}
                success = set(known.get("outputs_success") or [])
                grouped = {}
                for entry in snapshot.get("files", []):
                    if entry.get("output_key") not in success:
                        continue
                    if entry.get("file_relpath") in parent_paths:
                        continue
                    key_name = entry.get("output_key")
                    binding = (entry.get("source_bundle") or {}).get(
                        "_wfd_product_bindings", {}).get(key_name)
                    product = (binding or {}).get("product")
                    if not product:
                        continue
                    versions = (entry.get("source_bundle") or {}).get(
                        "_wfd_row_versions", {}).get(key_name, {})
                    target = grouped.setdefault((key_name, product.get("product_id")), {
                        "product": product, "records": {}})
                    for value in versions.values():
                        target["records"][(value["logical_key"], value["revision_id"])] = {
                            "record_id": value["logical_key"],
                            "record_version": value["revision_id"],
                            "withdrawn": bool(value.get("withdrawn")),
                        }
                for (key_name, product_id), target in grouped.items():
                    product = target["product"]
                    outputs.append({
                        "output_key": key_name, "product_id": product_id,
                        "registration_state": "reused",
                        "publication_state": "published_commit_pending_formal",
                        "snapshot_id": sid,
                        "records": sorted(target["records"].values(),
                                          key=lambda item: item["record_version"]),
                        "definition_ref": copy.deepcopy(product.get("definition_ref")),
                        "contract_ref": copy.deepcopy(product.get("contract_ref")),
                        "contract_refs": copy.deepcopy(product.get("contract_refs")),
                        "contract_bundle_ref": copy.deepcopy(product.get("contract_bundle_ref")),
                    })
            except (OSError, ValueError, KeyError):
                outputs = []
            st = "published_commit_pending_head"
            if active == sid or sid in history:
                st = "published_commit_pending_formal"
            return {
                "protocol_version": "wfd.structured-ingest/1.0",
                "profile": DATA_ONLY_PROFILE,
                "request_key": key,
                "request_identity": identity,
                "state": st,
                "snapshot_id": sid,
                "output_results": outputs,
                "formal_publication_ref": None,
                "formal_publication_verified": False,
                "idempotent_replay": False,
                "errors": [],
                "volume": {"binding": self.binding.to_dict(),
                           "source": "target_engine_receipt",
                           "head": active,
                           "historically_activated": sid in history},
            }
        return {
            "protocol_version": "wfd.structured-ingest/1.0",
            "profile": DATA_ONLY_PROFILE,
            "request_key": key,
            "request_identity": identity,
            "state": "unknown",
            "snapshot_id": None,
            "output_results": [],
            "formal_publication_ref": None,
            "formal_publication_verified": False,
            "errors": [],
            "volume": {"binding": self.binding.to_dict(),
                       "source": "target_no_commit"},
        }

    # ---------------------------------------------------------------- submit
    def _validation_core(self):
        """Pure schema/identity validator; no target or prep state is mutated."""
        if self._validation_service is not None:
            return self._validation_service
        if (self.root / "catalog/state.json").is_file():
            self._validation_service = self._target_service()
            return self._validation_service
        root = self.runtime_root / "request_validation"
        root.mkdir(parents=True, exist_ok=True)
        engine = WFDDuckDBPrototype(
            root / "store", load_protocol_validator(self.protocol_root),
            runtime_root=root / "runtime", sandbox=False,
            writer_host=self.binding.writer_host)
        self._validation_service = WFDDataOnlyService(
            engine, caller_roles=self.caller_roles, caller_id=self.caller_id,
            unit_registry=self.unit_registry,
            trusted_actor_namespaces=self.trusted_actor_namespaces)
        return self._validation_service

    def _validate_submit_document(self, document):
        """Validate the public document and resolve real fixed declarations.

        Reuse never reads a caller-supplied path or the latest flat registry;
        it reads the exact digest-addressed definition body and verifies both
        the ref and the declaration digest.
        """
        identity = self._validation_core()._validate_document(document)
        outputs = []
        for item in document["outputs"]:
            mode = item.get("definition_mode")
            if mode == "create":
                declaration = copy.deepcopy(item.get("definition"))
                validate_data_only_metadata(declaration)
            elif mode == "reuse":
                ref = item.get("definition_ref")
                if not isinstance(ref, Mapping) or ref.get("kind") != "definition_version":
                    raise ValueError("DEFINITION_REFERENCE_INVALID")
                digest = str(ref.get("digest") or "").removeprefix("sha256:")
                if not re.fullmatch(r"[0-9a-f]{64}", digest):
                    raise ValueError("DEFINITION_DIGEST_REQUIRED")
                rel = f"catalog/product_service/definitions/{digest}.json"
                path = self.root / rel
                if path.is_symlink() or not path.is_file():
                    raise ValueError("DEFINITION_NOT_REGISTERED")
                record = _read_json(path)
                if canonical(record.get("definition_ref")) != canonical(ref):
                    raise ValueError("DEFINITION_REFERENCE_MISMATCH")
                declaration = copy.deepcopy(record.get("declaration"))
                if "sha256:" + sha(canonical(declaration)) != "sha256:" + digest:
                    raise ValueError("DEFINITION_DIGEST_MISMATCH")
            else:
                raise ValueError("DEFINITION_MODE_INVALID")
            calendar_refs = product_calendar.validate_declaration(declaration)
            outputs.append({"item": item, "declaration": declaration,
                            "calendar_refs": calendar_refs, "mode": mode})
        return identity, outputs

    @staticmethod
    def _previous_closure(document):
        """Explicit revision predecessors: full snapshots and exact records."""
        snapshots, records = [], {}

        def walk(value):
            if isinstance(value, Mapping):
                previous = value.get("previous")
                if isinstance(previous, Mapping):
                    sid = previous.get("snapshot_id")
                    if sid:
                        snapshots.append(str(sid))
                    pid = previous.get("product_id")
                    rid = previous.get("logical_key")
                    version = previous.get("revision_id")
                    if all(isinstance(part, str) and part for part in (pid, rid, version)):
                        records.setdefault(pid, set()).add((rid, version))
                for key, child in value.items():
                    if key != "previous":
                        walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)

        for item in document.get("outputs", []):
            walk(item.get("revisions") or {})
        return list(dict.fromkeys(snapshots)), records

    def _source_state(self, expected_parent):
        self._verify_volume(write=True)
        state_path = self.root / "catalog/state.json"
        if not state_path.is_file():
            raise ValueError("FORMAL_VOLUME_NOT_INITIALIZED")
        state = _read_json(state_path)
        if expected_parent != state.get("active_head"):
            raise ValueError("PARENT_CHANGED:target HEAD=" + str(state.get("active_head")))
        if state.get("writer_host") not in (None, self.binding.writer_host):
            raise ValueError("WRITER_NOT_AUTHORIZED")
        if int(state.get("writer_epoch") or 0) != self.binding.writer_epoch:
            raise ValueError("WRITER_EPOCH_MISMATCH")
        head_sha = None
        if expected_parent is not None:
            head_path = self.root / f"catalog/snapshots/{expected_parent}.json"
            if head_path.is_symlink() or not head_path.is_file():
                raise ValueError("TARGET_HEAD_MISSING")
            head_sha = sha256_file(head_path)
        recorded_head_sha = state.get("head_snapshot_sha256")
        if recorded_head_sha is not None and (head_sha is None or recorded_head_sha != "sha256:" + head_sha):
            raise ValueError("TARGET_HEAD_DIGEST_MISMATCH")
        volume_binding = self.root / "catalog/product_service/volume_binding.json"
        if volume_binding.is_file():
            binding_record = _read_json(volume_binding)
            if binding_record.get("instance_id") != self.binding.instance_id:
                raise ValueError("VOLUME_INSTANCE_MISMATCH")
        volume = self._verify_volume(write=True)
        return {
            "state": state, "state_sha256": sha256_file(state_path),
            "head_sha256": head_sha, "active_head": state.get("active_head"),
            "update_seq": state.get("update_seq"),
            "writer_host": state.get("writer_host"),
            "writer_epoch": int(state.get("writer_epoch") or 0),
            "volume": volume.as_dict(),
        }

    def _assert_source_unchanged(self, verified):
        state_path = self.root / "catalog/state.json"
        if not state_path.is_file() or sha256_file(state_path) != verified["state_sha256"]:
            raise ValueError("SOURCE_VOLUME_CHANGED:state")
        state = _read_json(state_path)
        if (state.get("active_head") != verified["active_head"]
                or state.get("update_seq") != verified["update_seq"]
                or state.get("writer_host") != verified["writer_host"]
                or int(state.get("writer_epoch") or 0) != verified["writer_epoch"]):
            raise ValueError("SOURCE_VOLUME_CHANGED:generation")
        if verified["active_head"] is not None:
            head_rel = f"catalog/snapshots/{verified['active_head']}.json"
            if sha256_file(self.root / head_rel) != verified["head_sha256"]:
                raise ValueError("SOURCE_VOLUME_CHANGED:head")
        volume = self._verify_volume(write=True).as_dict()
        for key in ("mount_point", "volume_uuid", "filesystem", "device"):
            if volume.get(key) != verified["volume"].get(key):
                raise ValueError("SOURCE_VOLUME_CHANGED:volume")

    @staticmethod
    def _family_key(dataset_id, output, declaration):
        return (dataset_id, output.get("logical_domain"),
                canonical(output.get("subject")),
                declaration.get("semantic_code"),
                declaration.get("definition_authority"))

    @staticmethod
    def _family_identity(dataset_id, output, declaration):
        family_id = "pf_" + sha(canonical([
            dataset_id, output.get("logical_domain"), output.get("subject"),
            declaration.get("semantic_code"),
            declaration.get("definition_authority")]))[:24]
        stable_pid = "p_" + sha(canonical([family_id, "stable_product"]))[:24]
        return family_id, stable_pid

    def _verify_registry_version(self, record, *, dataset_id, output, family_id,
                                 expected_pid):
        pid = record.get("product_id")
        sequence = record.get("definition_sequence")
        if (not isinstance(pid, str) or pid != expected_pid
                or isinstance(sequence, bool) or not isinstance(sequence, int)
                or sequence < 1):
            raise ValueError("P4B_REUSE_REGISTRY_IDENTITY_INVALID")
        if (record.get("product_family_id") != family_id
                or record.get("dataset_id") != dataset_id
                or record.get("logical_domain") != output.get("logical_domain")
                or canonical(record.get("subject")) != canonical(output.get("subject"))):
            raise ValueError("P4B_REUSE_REGISTRY_SCOPE_MISMATCH")
        ref = record.get("definition_ref")
        declaration = record.get("declaration")
        if not isinstance(ref, Mapping) or not isinstance(declaration, Mapping):
            raise ValueError("P4B_REUSE_REGISTRY_DECLARATION_MISSING")
        if (ref.get("kind") != "definition_version"
                or ref.get("dataset_id") != dataset_id):
            raise ValueError("P4B_REUSE_REGISTRY_REFERENCE_INVALID")
        if "sha256:" + sha(canonical(declaration)) != ref.get("digest"):
            raise ValueError("P4B_REUSE_REGISTRY_DECLARATION_MISMATCH")
        compiled = product_calendar.dependencies(declaration, dataset_id)
        stored = ((record.get("contracts") or {}).get("read") or {}
                  ).get("dependencies")
        if canonical(sorted(stored or [], key=canonical)) != canonical(
                sorted(compiled, key=canonical)):
            raise ValueError("P4B_REUSE_REGISTRY_DEPENDENCY_MISMATCH")
        return sequence, ref

    def _add_reuse_roots(self, output, identity, add, seen):
        """Add the fixed definition and only the requested family's registry.

        Reusing a fixed definition and reusing an already-registered product are
        distinct.  A new subject/family may legally reuse a generic definition
        that is already published under another family; only the definition
        body is copied, and the existing ``_register`` creates this family's
        first sequence.  Foreign same-definition snapshot products are not
        treated as this family's registry.
        """
        item = output["item"]
        ref = item["definition_ref"]
        declaration = output["declaration"]
        digest = str(ref.get("digest") or "").removeprefix("sha256:")
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("P4B_REUSE_DEFINITION_DIGEST_INVALID")
        if ref.get("dataset_id") != identity["dataset_id"]:
            raise ValueError("P4B_REUSE_DEFINITION_DATASET_MISMATCH")
        definition_rel = f"catalog/product_service/definitions/{digest}.json"
        definition_record = _read_json(self.root / definition_rel)
        if (canonical(definition_record.get("definition_ref")) != canonical(ref)
                or "sha256:" + sha(canonical(definition_record.get("declaration")))
                != ref.get("digest")):
            raise ValueError("P4B_REUSE_DEFINITION_MISMATCH")
        add(definition_rel, "definition")

        family_id, stable_pid = self._family_identity(
            identity["dataset_id"], item, declaration)
        def collect_family_product(product):
            product_decl = product.get("declaration") or {}
            computed_family, _ = self._family_identity(
                product.get("dataset_id"), product, product_decl)
            if (product.get("product_family_id") != family_id
                    and computed_family != family_id):
                # Same definition under another subject/family is not this
                # family's registry record; it stays only if parent closure
                # already carries it.
                return
            pid = product.get("product_id")
            sequence = product.get("definition_sequence")
            if isinstance(sequence, bool) or not isinstance(sequence, int):
                raise ValueError("P4B_REUSE_REGISTRY_IDENTITY_INVALID")
            rel = (f"catalog/product_service/products/{pid}/"
                   f"definition_{sequence}.json")
            self._verify_registry_version(
                _read_json(self.root / rel), dataset_id=identity["dataset_id"],
                output=item, family_id=family_id, expected_pid=pid)
            add(rel, "definition_version")

        for entry in seen.values():
            for product in _snapshot_fixed_products(entry["snapshot"]):
                collect_family_product(product)

        # Exact stable-pid directory is the only registry address we may open.
        directory = (self.root / "catalog/product_service/products" / stable_pid)
        if directory.is_dir():
            paths = sorted(directory.glob("definition_*.json"))
            if not paths:
                raise ValueError("P4B_REUSE_REGISTRY_EMPTY")
            for path in paths:
                if path.is_symlink() or not path.is_file():
                    raise ValueError("P4B_REUSE_REGISTRY_FILE_INVALID")
                match = re.fullmatch(r"definition_([0-9]+)\.json", path.name)
                if not match:
                    raise ValueError("P4B_REUSE_REGISTRY_FILE_INVALID")
                record = _read_json(path)
                sequence, _record_ref = self._verify_registry_version(
                    record, dataset_id=identity["dataset_id"], output=item,
                    family_id=family_id, expected_pid=stable_pid)
                if sequence != int(match.group(1)):
                    raise ValueError("P4B_REUSE_REGISTRY_SEQUENCE_MISMATCH")
                add(path.relative_to(self.root).as_posix(), "definition_version")

        # No addressable family registry is a legitimate new family: the
        # verified definition body is sufficient and _register allocates
        # sequence 1.  An existing but empty/corrupt stable-pid directory was
        # rejected above, so it cannot be bypassed as "new".
        return

    def _add_snapshot_closure(self, snapshot_id, payload_required, add, seen):
        """Add one exact commit/snapshot/manifest and optional full payload.

        Metadata may be upgraded to full later.  Ancestors add only immutable
        metadata; they never copy unrelated parent payloads.
        """
        if not _SNAPSHOT_ID_RE.fullmatch(str(snapshot_id)):
            raise ValueError("SNAPSHOT_ID_INVALID:" + str(snapshot_id))
        entry = seen.get(snapshot_id)
        if entry is not None and entry.get("ready"):
            if entry.get("full") or not payload_required:
                return entry["snapshot"]
        if entry is None:
            try:
                snapshot = self._target_service().engine._valid_snapshot_exact(
                    snapshot_id, verify_payloads=False)
            except Exception as exc:
                raise ValueError("PREP_SNAPSHOT_INVALID:" + str(snapshot_id)) from exc
            entry = {"snapshot": snapshot, "full": False, "ready": False,
                     "payload_ready": False, "ancestors_ready": False}
            seen[snapshot_id] = entry
        else:
            snapshot = entry["snapshot"]
        full = entry.get("full") or bool(payload_required)
        entry["full"] = full
        from . import indexed_bulk as bulk
        bulk_snapshot = snapshot.get("format_version") in bulk.SNAPSHOT_FORMATS
        if not entry.get("ready"):
            commit_rel = f"catalog/commits/{snapshot_id}.json"
            commit = _read_json(self.root / commit_rel)
            add(commit_rel, "commit")
            for protocol, ref in bulk.root_nodes(snapshot):
                add(bulk.node_relative(ref, protocol=protocol), "bulk_index_node", ref[7:])
            if not bulk_snapshot:
                add(str(snapshot["manifest_relpath"]), "manifest",
                    snapshot.get("manifest_sha256"))
            add(f"catalog/snapshots/{snapshot_id}.json", "snapshot",
                commit.get("snapshot_sha256"))
            _add_row_version_closure(add, snapshot)
            entry["ready"] = True
        if bulk_snapshot:
            anchor = snapshot["legacy_anchor"]
            if anchor is not None:
                self._add_snapshot_closure(anchor["snapshot_id"], full, add, seen)
            return snapshot
        if full and not entry.get("payload_ready"):
            entry["payload_ready"] = True
            for file_entry in snapshot.get("files", []):
                add(str(file_entry["file_relpath"]), "data",
                    str(file_entry["file_sha256"]))
            products = _snapshot_fixed_products(snapshot)
            for product in products:
                _add_product_closure(add, product, self.root)
            request_key = snapshot.get("request_key")
            if request_key:
                formal_rel = ("catalog/product_service/data_only_formal_publications/"
                              f"{request_key}.json")
                if (self.root / formal_rel).is_file():
                    add(formal_rel, "formal_receipt")
                    formal = _read_json(self.root / formal_rel)
                    if (formal.get("request_key") != request_key
                            or formal.get("snapshot_id") != snapshot_id
                            or formal.get("formal_publication_state") != "published_formal"):
                        raise ValueError("PREP_FORMAL_RECEIPT_MISMATCH:" + str(request_key))
            for product in products:
                dependencies = ((product.get("contracts") or {}).get("read") or {}
                                ).get("dependencies") or []
                for dependency in dependencies:
                    if not isinstance(dependency, Mapping) or dependency.get("required") is not True:
                        raise ValueError("PREP_READ_DEPENDENCY_INVALID")
                    if dependency.get("dataset_id") != product.get("dataset_id"):
                        raise ValueError("PREP_READ_DEPENDENCY_DATASET_MISMATCH")
                    self._add_snapshot_closure(
                        str(dependency.get("snapshot_id")), True, add, seen)
        parent_id = snapshot.get("parent_snapshot_id")
        if parent_id and not entry.get("ancestors_ready"):
            entry["ancestors_ready"] = True
            self._add_snapshot_closure(str(parent_id), False, add, seen)
        return snapshot

    def _add_holding_closure(self, records_by_product, add):
        """Copy only whole facts intersecting required product/record versions."""
        needed = {(pid, rid, version)
                  for pid, records in records_by_product.items()
                  for rid, version in records}
        if not needed:
            return
        instance_id = self.binding.instance_id
        ledger = HoldingLedger(self.root, instance_id)
        for fact in ledger.facts():
            pid = fact.get("product_id")
            fact_records = {(item.get("record_id"), item.get("record_version"))
                            for item in fact.get("records", [])}
            if not any((pid, rid, version) in needed for rid, version in fact_records):
                continue
            rel = (f"catalog/product_service/holdings/{instance_id}/"
                   f"{fact['batch_id']}.json")
            add(rel, "holding_fact")
            proof = fact.get("proof") or {}
            kind = proof.get("kind")
            key = proof.get("request_key")
            if not isinstance(key, str) or not re.fullmatch(r"[0-9a-f]{64}", key):
                raise ValueError("PREP_HOLDING_PROOF_INVALID")
            if kind in {"r2_publish", "target_commit_recovery"}:
                proof_rel = f"catalog/product_service/data_only_stage_proofs/{key}.json"
                add(proof_rel, "stage_proof")
                stage = _read_json(self.root / proof_rel)
                if (stage.get("request_key") != key
                        or stage.get("instance_id") != instance_id
                        or stage.get("snapshot_id") != fact.get("snapshot_id")):
                    raise ValueError("PREP_HOLDING_STAGE_PROOF_MISMATCH")
                stage_records = {(item.get("record_id"), item.get("record_version"))
                                 for item in stage.get("records", [])}
                if not fact_records.issubset(stage_records):
                    raise ValueError("PREP_HOLDING_STAGE_PROOF_RECORDS_MISMATCH")
            elif kind == "p5_import":
                proof_rel = (f"catalog/product_service/target_import_stage_proofs/"
                             f"{key}.json")
                add(proof_rel, "stage_proof")
                stage = _read_json(self.root / proof_rel)
                if (stage.get("request_key") != key
                        or stage.get("instance_id") != instance_id
                        or stage.get("snapshot_id") != fact.get("snapshot_id")
                        or stage.get("product_id") != pid):
                    raise ValueError("PREP_HOLDING_STAGE_PROOF_MISMATCH")
                target_binding = ("catalog/product_service/"
                                  "target_instance_binding.json")
                if (self.root / target_binding).is_file():
                    add(target_binding, "identity")
            else:
                raise ValueError("PREP_HOLDING_PROOF_UNSUPPORTED:" + str(kind))

    def _collect_prep_closure(self, document, expected_parent):
        """Return verified target generation plus exact prep files (no writes)."""
        identity, outputs = self._validate_submit_document(document)
        verified = self._source_state(expected_parent)
        closure: dict[str, PrepFile] = {}

        def add(rel, kind, expected_sha=None):
            rel = _safe_relpath(rel)
            if kind == "row_version_object":
                _reject_symlink_path(self.root, rel)
            source = self.root / rel
            if source.is_symlink():
                raise ValueError("PREP_SOURCE_SYMLINK:" + rel)
            if not source.is_file():
                raise ValueError("PREP_SOURCE_MISSING:" + rel)
            st = source.stat()
            digest = sha256_file(source)
            if expected_sha is not None and digest != expected_sha:
                raise ValueError("PREP_SOURCE_DIGEST_MISMATCH:" + rel)
            prior = closure.get(rel)
            if prior is not None and prior.sha256 != digest:
                raise ValueError("PREP_DUPLICATE_RELPATH_CONFLICT:" + rel)
            closure[rel] = PrepFile(rel, digest, st.st_size, kind)

        add("catalog/state.json", "state")
        if (self.root / "catalog/retention.json").is_file():
            add("catalog/retention.json", "retention")
        for rel in ("catalog/product_service/volume_binding.json",
                    "catalog/product_service/target_instance_binding.json"):
            if (self.root / rel).is_file():
                add(rel, "identity")

        seen: dict[str, dict] = {}
        self._add_snapshot_closure(expected_parent, True, add, seen)

        calendar_dependencies = []
        for output in outputs:
            subject = output["item"].get("subject")
            for item in output["calendar_refs"]:
                ref = item["ref"]
                if ref.get("dataset_id") != identity["dataset_id"]:
                    raise ValueError("CALENDAR_DATASET_MISMATCH:" + item["path"])
                info = product_calendar.verify_fixed(
                    self._target_service().engine, item, subject)
                if item["role"] == product_calendar.CALENDAR_ROLE:
                    product_calendar.trading_rows(info)
                else:
                    product_calendar.accounting_rows(info)
                calendar_dependencies.append((item, ref))
                self._add_snapshot_closure(str(ref["version"]), True, add, seen)

        previous_snapshots, previous_records = self._previous_closure(document)
        for snapshot_id in previous_snapshots:
            self._add_snapshot_closure(snapshot_id, True, add, seen)

        for output in outputs:
            if output.get("mode") == "reuse":
                self._add_reuse_roots(output, identity, add, seen)

        family_keys = {
            self._family_key(identity["dataset_id"], output["item"],
                             output["declaration"])
            for output in outputs
        }
        for entry in list(seen.values()):
            if not entry["snapshot"]["files"] and entry["snapshot"].get("format_version") in ("wfd.source-minute-snapshot/1", "wfd.tabular-snapshot/1"):
                continue  # A bulk-only predecessor has no ordinary family definitions.
            for product in _snapshot_fixed_products(entry["snapshot"]):
                declaration = product.get("declaration") or {}
                if self._family_key(product.get("dataset_id"), product,
                                    declaration) not in family_keys:
                    continue
                sequence = product.get("definition_sequence")
                if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 1:
                    raise ValueError("PREP_FAMILY_SEQUENCE_INVALID")
                add(f"catalog/product_service/products/{product['product_id']}/"
                    f"definition_{sequence}.json", "definition_version")

        records_by_product: dict[str, set] = {}
        for entry in seen.values():
            if not entry.get("full"):
                continue
            for file_entry in entry["snapshot"].get("files", []):
                pid = file_entry.get("product_id")
                key_name = file_entry.get("output_key")
                versions = ((file_entry.get("source_bundle") or {}).get(
                    "_wfd_row_versions", {}) or {}).get(key_name, {})
                for value in versions.values():
                    records_by_product.setdefault(pid, set()).add(
                        (value.get("logical_key"), value.get("revision_id")))
        for pid, records in previous_records.items():
            records_by_product.setdefault(pid, set()).update(records)
        self._add_holding_closure(records_by_product, add)

        self._assert_source_unchanged(verified)
        files = tuple(sorted(closure.values(),
                             key=lambda item: (item.kind, item.relpath)))
        return verified, files

    def _seed_prep_from_target(self, prep_root, expected_parent, document=None):
        """Cold/hot hydrate exact closure; preserve hot pending request state."""
        if document is None:
            raise ValueError("PREP_DOCUMENT_REQUIRED")
        prep_root = Path(prep_root)
        state_path = prep_root / "catalog/state.json"
        hot = state_path.is_file()
        identity, _outputs = self._validate_submit_document(document)
        key = self._request_key(identity)
        if hot:
            try:
                prep_state = _read_json(state_path)
            except Exception as exc:
                raise ValueError("PREP_STATE_INVALID") from exc
            if prep_state.get("writer_host") not in (None, self.binding.writer_host):
                raise ValueError("PREP_WRITER_NOT_AUTHORIZED")
            if int(prep_state.get("writer_epoch") or 0) != self.binding.writer_epoch:
                raise ValueError("PREP_WRITER_EPOCH_MISMATCH")
            if prep_state.get("active_head") != expected_parent:
                plan_rel = ("catalog/product_service/data_only_submission_plans/"
                            f"{key}.json")
                plan_path = prep_root / plan_rel
                plan = None
                if plan_path.is_file() and not plan_path.is_symlink():
                    plan = _read_json(plan_path)
                if plan is None or plan.get("parent_snapshot_id") != expected_parent:
                    raise ValueError("PREP_HEAD_CONFLICT:"
                                     + str(prep_state.get("active_head")))
        verified, files = self._collect_prep_closure(document, expected_parent)
        self._assert_source_unchanged(verified)
        prep_root.mkdir(parents=True, exist_ok=True)
        written = []
        for item in files:
            if hot and item.kind in {"state", "retention"}:
                continue
            if item.kind == "row_version_object":
                _reject_symlink_path(prep_root, item.relpath)
            destination = prep_root / item.relpath
            if destination.exists() or destination.is_symlink():
                if destination.is_symlink() or not destination.is_file():
                    raise ValueError("PREP_DEST_INVALID:" + item.relpath)
                if sha256_file(destination) != item.sha256:
                    raise ValueError("PREP_DEST_CONFLICT:" + item.relpath)
                written.append(item.as_dict())
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            source = self.root / item.relpath
            # Independent copy only.  A prep-side write must never mutate the
            # source volume through a shared inode.
            shutil.copy2(source, destination)
            if sha256_file(destination) != item.sha256:
                raise ValueError("PREP_COPY_DIGEST_MISMATCH:" + item.relpath)
            written.append(item.as_dict())
        self._assert_source_unchanged(verified)
        self.last_hydration = {
            "mode": "hot" if hot else "cold",
            "expected_parent": expected_parent,
            "update_seq": verified["update_seq"],
            "head_sha256": verified["head_sha256"],
            "files": written,
            "file_count": len(written),
            "collected_files": [item.as_dict() for item in files],
            "state_and_retention_skipped": bool(hot),
        }
        return self.last_hydration

    def _authorize_prep_row_versions(self, prep_service, document, adoption, verified):
        from .writerlock import writer_lock

        engine = prep_service.engine
        expected_parent = document.get("expected_parent_snapshot_id")
        with writer_lock(self.root):
            if row_version_objects.adoption_record(self.root, self.runtime_root) != adoption:
                raise ValueError("ROW_VERSION_ADOPTION_CHANGED:target")
            if adoption is None:
                if row_version_objects.writing_enabled(engine.root, engine.runtime_root):
                    raise ValueError("ROW_VERSION_ADOPTION_CHANGED:prep")
                return
            self._assert_source_unchanged(verified)
            prep_adoption = row_version_objects.adoption_record(engine.root, engine.runtime_root)
            if prep_adoption is not None and any(prep_adoption[key] != adoption[key]
                                                for key in ("identity", "adopted_at_utc")):
                raise ValueError("ROW_VERSION_ADOPTION_CHANGED:prep")
            if expected_parent is not None and sha256_file(
                    engine.root / f"catalog/snapshots/{expected_parent}.json") != verified["head_sha256"]:
                raise ValueError("SOURCE_VOLUME_CHANGED:prep head")
            if prep_adoption is not None:
                head = engine.head()
                if head is not None and head["snapshot_id"] != expected_parent:
                    # A retry can reuse the exact pending commit created under this adoption.
                    key = self._request_key(document["request_identity"])
                    plan = _read_json(engine.root / "catalog/product_service/data_only_submission_plans"
                                      / f"{key}.json")
                    if (head.get("request_key") == key and head.get("parent_snapshot_id") == expected_parent
                            and plan.get("input_fingerprint") == sha(canonical(document))):
                        return
            row_version_objects.adopt_writing(
                engine, identity=adoption["identity"], expected_snapshot_id=expected_parent,
                adopted_at_utc=adoption["adopted_at_utc"],
            )

    # ---------------------------------------------------------------- target commit recovery
    def _stage_proof_path(self, key):
        return self.root / "catalog/product_service/data_only_stage_proofs" / f"{key}.json"

    def _write_stage_proof(self, key, identity, snapshot_id, records, stage, at):
        path = self._stage_proof_path(key)
        prior = {}
        if path.is_file():
            try:
                prior = json.loads(path.read_text("utf-8"))
            except (OSError, ValueError):
                prior = {}
        if prior and (prior.get("instance_id") != self.binding.instance_id
                      or prior.get("snapshot_id") != snapshot_id):
            raise ValueError("HOLDING_STAGE_PROOF_MISMATCH")
        stages = dict(prior.get("stages") or {})
        stages[stage] = at
        payload = {"format_version": "wfd.stage-proof/1.0",
                   "request_key": key, "request_identity": dict(identity),
                   "instance_id": self.binding.instance_id,
                   "writer_host": self.binding.writer_host,
                   "snapshot_id": snapshot_id,
                   "records": copy.deepcopy(records), "stages": stages}
        self._verify_volume(write=True)
        _atomic_write(path, canonical(payload) + b"\n")
        return payload

    def _ensure_holdings_from_proof(self, key, status):
        path = self._stage_proof_path(key)
        if not path.is_file():
            return
        proof = json.loads(path.read_text("utf-8"))
        stages = proof.get("stages") or {}
        if not any(stages.get(name) for name in ("acquired", "custodied", "published_readable")):
            return
        from .product_holdings import HoldingLedger
        ledger = HoldingLedger(self.root, self.binding.instance_id)
        for output in WFDDataOnlyService._publication_results(status.get("output_results", [])):
            ledger.record_batch(
                snapshot_id=status.get("snapshot_id"),
                product_id=output.get("product_id"),
                records=output.get("records", []),
                acquired_at=stages.get("acquired"),
                custodied_at=stages.get("custodied"),
                readable_at=stages.get("published_readable"),
                proof={"kind": "r2_publish", "snapshot_id": status.get("snapshot_id"),
                       "request_key": key})

    def _duplicate_plan_path(self, key):
        return self.runtime_root / "duplicate_requests" / self.binding.instance_id / f"{key}.json"

    def _duplicate_plan(self, identity):
        path = self._duplicate_plan_path(self._request_key(identity))
        if not path.is_file():
            return None
        plan = _read_json(path)
        if (plan.get("instance_id") != self.binding.instance_id
                or plan.get("volume_uuid") != self.binding.volume_uuid):
            raise ValueError("DUPLICATE_PLAN_INSTANCE_MISMATCH")
        if plan.get("request_identity") != dict(identity):
            raise ValueError("REQUEST_ID_CONFLICT")
        return plan

    def _save_duplicate_plan(self, identity, document, result):
        from .writerlock import writer_lock
        with writer_lock(self.root):
            return self._save_duplicate_plan_locked(identity, document, result)

    def _save_duplicate_plan_locked(self, identity, document, result):
        self._verify_volume(write=True)
        key = self._request_key(identity)
        fingerprint = sha(canonical(document))
        self._assert_no_bulk_intent(key)
        existing = self._duplicate_plan(identity)
        if existing is not None:
            if existing.get("input_fingerprint") != fingerprint:
                raise ValueError("REQUEST_ID_CONFLICT")
            return existing
        if result.get("new_snapshot_created") is False:
            parent = document.get("expected_parent_snapshot_id")
            if parent is None:
                state_path = self.root / "catalog/state.json"
                if state_path.is_file():
                    if self._target_service().snapshot_status().get("snapshot_id") is not None:
                        raise ValueError("PARENT_CHANGED:target is no longer empty")
                elif any(self.root.iterdir()):
                    raise ValueError("FORMAL_VOLUME_NOT_INITIALIZED:nonempty target cannot be treated as empty")
            else:
                self._source_state(parent)
        plan = {"format_version": "wfd.duplicate-request-plan/1",
                "instance_id": self.binding.instance_id, "volume_uuid": self.binding.volume_uuid,
                "request_identity": dict(identity), "input_fingerprint": fingerprint,
                "parent_snapshot_id": document.get("expected_parent_snapshot_id"),
                "result": copy.deepcopy(result)}
        _atomic_write(self._duplicate_plan_path(key), canonical(plan) + b"\n")
        return plan

    def _duplicate_status(self, status):
        identity = status.get("request_identity") or {}
        plan = self._duplicate_plan(identity)
        if not plan:
            if status.get("duplicate_policy"):
                return {**status, "state": "recovery_conflict", "output_results": [],
                        "errors": [{"code": "DUPLICATE_PLAN_UNAVAILABLE",
                                    "message": "Original row classifications are unavailable in the trusted native request plan"}]}
            return status
        if status.get("state") in {"rejected", "storage_inconsistent", "recovery_conflict"}:
            return status
        result = {**copy.deepcopy(plan["result"]), **copy.deepcopy(status)}
        outcomes = copy.deepcopy(plan["result"].get("output_results") or [])
        actual = {item["output_key"]: item for item in status.get("output_results", [])}
        succeeded = {key for key, item in actual.items()
                     if item.get("publication_state") == "published_formal"}
        for item in outcomes:
            if item.get("inserted_records"):
                item["publication_state"] = ("published_formal" if item["output_key"] in succeeded
                                              else "committed_pending_activation")
            for row in item.get("row_results", []):
                if row.get("publication_output_key"):
                    row["state"] = (row["intended_state"] if row["publication_output_key"] in succeeded
                                    else "pending_publication")
                if row["state"] in {"inserted", "duplicate_skipped"}:
                    row.setdefault("snapshot_id", status.get("snapshot_id") or plan.get("parent_snapshot_id"))
            item["snapshot_id"] = status.get("snapshot_id") or plan.get("parent_snapshot_id")
            item["row_summary"] = WFDDataOnlyService._row_summary(item.get("row_results", []))
        summary = WFDDataOnlyService._row_summary([row for item in outcomes for row in item.get("row_results", [])])
        state = status.get("state")
        if state == "published_formal" and (summary["conflict_pending"] or any(item.get("errors") for item in outcomes)):
            state = "partially_published_formal"
        result.update(output_results=outcomes, row_summary=summary, state=state,
                      new_snapshot_created=bool(status.get("snapshot_id") and
                                                status["snapshot_id"] != plan.get("parent_snapshot_id")))
        return result

    def _intent_path(self, key):
        return self.root / "catalog/product_service/data_only_publication_intents" / f"{key}.json"

    def _load_target_intent(self, key):
        path = self._intent_path(key)
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            return None

    def _write_target_intent(self, key, identity, fingerprint, parent, results, row_version_context=None):
        from .writerlock import writer_lock
        with writer_lock(self.root):
            return self._write_target_intent_locked(
                key, identity, fingerprint, parent, results, row_version_context)

    def _write_target_intent_locked(self, key, identity, fingerprint, parent, results, row_version_context):
        self._assert_no_bulk_intent(key)
        path = self._intent_path(key)
        if path.is_file():
            existing = self._load_target_intent(key)
            if (not existing or existing.get("request_identity") != identity
                    or existing.get("input_fingerprint") != fingerprint):
                raise ValueError("REQUEST_ID_CONFLICT")
            if existing.get("row_version_context") != row_version_context:
                raise ValueError("ROW_VERSION_ADOPTION_CHANGED:publication intent")
            return existing
        payload = {"format_version": "wfd.data-only-publication-intent/1.0",
                   "request_key": key, "request_identity": dict(identity),
                   "input_fingerprint": fingerprint, "parent_snapshot_id": parent,
                   "created_at": __import__("datetime").datetime.now(
                       __import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                   "outputs": [{"output_key": item.get("output_key"),
                                "product_id": item.get("product_id"),
                                "records": copy.deepcopy(item.get("records") or []),
                                "definition_ref": copy.deepcopy(item.get("definition_ref")),
                                "contract_ref": copy.deepcopy(item.get("contract_ref")),
                                "contract_refs": copy.deepcopy(item.get("contract_refs")),
                                "contract_bundle_ref": copy.deepcopy(
                                    item.get("contract_bundle_ref"))}
                               for item in results if not item.get("errors")]}
        if not payload["outputs"]:
            raise ValueError("RECOVERY_PLAN_EMPTY")
        if any("row_results" in item for item in results):
            payload["duplicate_policy"] = "skip_identical_append"
        if row_version_context is not None:
            payload["row_version_context"] = row_version_context
        self._verify_volume(write=True)
        _atomic_write(path, canonical(payload) + b"\n")
        return payload

    def _recover_target_commit(self, identity, document):
        key = self._request_key(identity)
        intent = self._load_target_intent(key)
        if intent is None:
            return None
        if (dict(intent.get("request_identity") or {}) != dict(identity)
                or intent.get("input_fingerprint") != sha(canonical(document))):
            return {"protocol_version": "wfd.structured-ingest/1.0",
                    "profile": DATA_ONLY_PROFILE, "request_key": key,
                    "request_identity": dict(intent.get("request_identity") or identity),
                    "state": "rejected", "snapshot_id": None, "output_results": [],
                    "formal_publication_ref": None, "formal_publication_verified": False,
                    "errors": [{"code": "REQUEST_ID_CONFLICT",
                                "message": "target immutable intent identity/fingerprint differs"}]}
        engine = self._target_service().engine
        known = engine._known_request(key)
        if not known or not known.get("snapshot_id"):
            return None
        sid = known.get("snapshot_id")
        state = engine.state.read() or {}
        history = {item.get("snapshot_id") for item in state.get("activation_history", [])
                   if isinstance(item, dict)}
        if state.get("active_head") != sid and sid not in history:
            context = intent.get("row_version_context") or {}
            parent = document.get("expected_parent_snapshot_id")
            if (context.get("snapshot_id") == sid and parent == intent.get("parent_snapshot_id")
                    and state.get("active_head") == parent):
                # Let the original prep and publisher revalidate the exact committed candidate.
                return None
            return {"protocol_version": "wfd.structured-ingest/1.0",
                    "profile": DATA_ONLY_PROFILE, "request_key": key,
                    "request_identity": dict(identity), "state": "published_commit_pending_head",
                    "snapshot_id": sid, "output_results": [], "formal_publication_ref": None,
                    "formal_publication_verified": False,
                    "errors": [{"code": "RECOVERY_HEAD_CONFLICT",
                                "message": "committed snapshot was never activated"}]}
        try:
            engine.read_snapshot(sid)
            service = self._target_service()
            outputs = []
            for target in intent.get("outputs", []):
                pid = target.get("product_id")
                read = service._read(pid, snapshot_id=sid, perspective="snapshot_contents",
                                     include_history=False, verify_contract_files=True)
                product = next((p for p in read.get("products", []) if p.get("product_id") == pid), None)
                if product is None:
                    raise ValueError("TARGET_PRODUCT_NOT_READABLE")
                actual = set()
                for row in read.get("rows", []):
                    ref = row.get("record_ref") or {}
                    actual.add((ref.get("logical_key") or row.get("record_id"),
                                ref.get("revision_id") or row.get("record_version")))
                wanted = {(r.get("record_id"), r.get("record_version"))
                          for r in target.get("records", [])}
                new_versions = self._new_versions(
                    engine.read_snapshot(sid), engine.read_snapshot(sid).get("parent_snapshot_id"),
                    target.get("output_key"), pid)
                if not wanted or not wanted.issubset(actual) or new_versions != wanted:
                    raise ValueError("TARGET_RECORD_SET_MISMATCH")
                if product.get("contract_refs") != target.get("contract_refs"):
                    raise ValueError("TARGET_CONTRACT_MISMATCH")
                outputs.append({"output_key": target.get("output_key"), "product_id": pid,
                                "records": copy.deepcopy(target.get("records")),
                                "definition_ref": copy.deepcopy(target.get("definition_ref")),
                                "contract_ref": copy.deepcopy(target.get("contract_ref")),
                                "contract_refs": copy.deepcopy(target.get("contract_refs")),
                                "contract_bundle_ref": copy.deepcopy(target.get("contract_bundle_ref"))})
        except Exception as exc:
            return {"protocol_version": "wfd.structured-ingest/1.0",
                    "profile": DATA_ONLY_PROFILE, "request_key": key,
                    "request_identity": dict(identity), "state": "storage_inconsistent",
                    "snapshot_id": sid, "output_results": [],
                    "formal_publication_ref": None, "formal_publication_verified": False,
                    "errors": [{"code": "FORMAL_STORAGE_INCONSISTENT",
                                "message": type(exc).__name__ + ": " + str(exc)}]}
        formal_path = self.root / f"catalog/product_service/data_only_formal_publications/{key}.json"
        if not formal_path.is_file():
            record = {"format_version": "wfd.data-only-formal-publication/1.0",
                      "profile": DATA_ONLY_PROFILE, "request_key": key,
                      "request_identity": dict(identity),
                      "input_fingerprint": intent.get("input_fingerprint"),
                      "snapshot_id": sid, "outputs": outputs,
                      "formal_publication_state": "published_formal",
                      "production_publishable": False,
                      "checks": {"caller_publish_role": True, "snapshot_present": True,
                                 "commit_marker_present": True, "valid_commit": True,
                                 "contracts_verified": True, "record_identity_verified": True,
                                 "fixed_readback_verified": True, "engine_not_sandbox": True,
                                 "active_head_matches": state.get("active_head") == sid,
                                 "historically_activated": sid in history}}
            if intent.get("duplicate_policy"):
                record["duplicate_policy"] = intent["duplicate_policy"]
            self._verify_volume(write=True)
            from .writerlock import writer_lock
            with writer_lock(self.root):
                _atomic_write(formal_path, canonical(record) + b"\n")
        status = self._formal_status(identity, document)
        if status and status.get("state") in {"published_formal", "partially_published_formal"}:
            from datetime import datetime, timezone
            now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            proof_path = self._stage_proof_path(key)
            proof = json.loads(proof_path.read_text("utf-8")) if proof_path.is_file() else {"stages": {}}
            stages = dict(proof.get("stages") or {})
            if not stages.get("published_readable"):
                stages["published_readable"] = now
                self._write_stage_proof(key, identity, sid,
                                        [r for output in WFDDataOnlyService._publication_results(status.get("output_results", []))
                                         for r in output.get("records", [])],
                                        "published_readable", now)
            if any(stages.get(name) for name in ("acquired", "custodied", "published_readable")):
                self._ensure_holdings_from_proof(key, status)
        return status

    def _open_prep(self, prep_root):
        engine = WFDDuckDBPrototype(
            prep_root, load_protocol_validator(self.protocol_root, entry="wfd-data-only-write.schema.json"),
            runtime_root=self.runtime_root / "prep_runtime" / sha(canonical(str(prep_root)))[:16],
            sandbox=False, writer_host=self.binding.writer_host,
        )
        return WFDDataOnlyService(
            engine, caller_roles=self.caller_roles, caller_id=self.caller_id,
            unit_registry=self.unit_registry,
            trusted_actor_namespaces=self.trusted_actor_namespaces,
            write_targets_document=self._target_write_targets(),
            write_target_reserved_families=self._target_reserved_families(),
            adjustment_anchors_document=self._target_adjustment_anchors(),
            basis_price_catalog=self._target_basis_catalog(),
        )

    def _bulk_parent(self, expected):
        from . import indexed_bulk as bulk
        from .state import COMPAT_FORMATS
        state_path = self.root / "catalog/state.json"
        if state_path.is_symlink():
            raise ValueError("HEAD_INVALID_FORMAT")
        state = _read_json(state_path) if state_path.is_file() else {}
        if state and (state.get("format_version") not in COMPAT_FORMATS or "active_head" not in state):
            raise ValueError("HEAD_INVALID_FORMAT")
        if state.get("active_head") != expected:
            raise ValueError("PARENT_CHANGED")
        if state.get("writer_host") not in (None, self.binding.writer_host):
            raise ValueError("WRITER_NOT_AUTHORIZED")
        if int(state.get("writer_epoch") or 0) != self.binding.writer_epoch:
            raise ValueError("WRITER_EPOCH_MISMATCH")
        if expected is None:
            if state.get("head_snapshot_sha256") is not None:
                raise ValueError("TARGET_HEAD_DIGEST_MISMATCH")
            if any((self.root / "catalog/commits").glob("*.json")):
                raise ValueError("EMPTY_STORE_UNVERIFIED")
            return {}, None, None
        path = bulk.checked_path(self.root, bulk.snapshot_relative(expected))
        checksum = "sha256:" + sha256_file(path)
        if state.get("head_snapshot_sha256") not in (None, checksum):
            raise ValueError("TARGET_HEAD_DIGEST_MISMATCH")
        if bulk.has_bulk_marker(self.root, expected):
            from .state import StateStore
            snap = bulk.read_snapshot(self.root, expected, expected_sha=checksum)
            resolved = StateStore(self.root).resolve({expected: snap})
            if not resolved["ok"]:
                raise ValueError(resolved["code"])
            return bulk.index_roots(snap), snap["legacy_anchor"], checksum
        ordinary = self.engine._valid_snapshot_exact(expected, verify_payloads=False)
        resolved = self.engine.state.resolve({expected: ordinary})
        if not resolved["ok"]:
            raise ValueError(resolved["code"])
        return bulk.index_roots(ordinary), {"snapshot_id": expected, "sha256": checksum}, checksum

    def _hydrate_bulk_product(self, prep, output, existing):
        from . import indexed_bulk as bulk
        relatives = {}

        def add(rel, kind, expected=None):
            path = bulk.checked_path(self.root, rel)
            if expected is not None and sha256_file(path) != expected:
                raise ValueError("BULK_CONTRACT_DIGEST_MISMATCH")
            relatives[rel] = path

        if existing is not None:
            _add_product_closure(add, existing, self.root)
        if output.get("definition_mode") == "reuse":
            digest = (output.get("definition_ref") or {}).get("digest", "")
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
                raise ValueError("DEFINITION_DIGEST_REQUIRED")
            add(f"catalog/product_service/definitions/{digest[7:]}.json", "definition")
        for rel, path in relatives.items():
            prep.engine._write_immutable(rel, path.read_bytes())

    def _existing_bulk_product(self, prep, output, identity, roots, protocol, contract_digest):
        from . import indexed_bulk as bulk, write_targets
        self._hydrate_bulk_product(prep, output, None)
        internal = prep._internal_output(output)
        declaration, definition_ref = prep._definition(internal, identity["dataset_id"])
        target = write_targets.target_of(dataset_id=identity["dataset_id"],
            logical_domain=output["logical_domain"], subject=output["subject"],
            declaration=declaration, definition_ref=definition_ref)
        products = bulk.indexed_products(self.root, roots)
        binding = write_targets.latest(self._target_write_targets(), identity["dataset_id"], target["product_family_id"])
        # The persisted immutable product for this family is normally reached by its binding.
        pid = (binding or {}).get("product_id") or "p_" + sha(canonical([target["product_family_id"], "stable_product"]))[:24]
        entry = products.get(pid)
        if entry is None:
            return None, pid
        owner_protocol, ref = entry
        if owner_protocol != protocol:
            raise ValueError("BULK_PRODUCT_PROTOCOL_CONFLICT")
        product_node = bulk.read_node(self.root, ref, "product", protocol=protocol)
        if product_node.get("table_contract_digest") != contract_digest:
            raise ValueError("BULK_TABLE_CONTRACT_MISMATCH")
        product = product_node["product"]
        if product.get("product_family_id") != target["product_family_id"] or product.get("product_id") != pid:
            raise ValueError("BULK_PRODUCT_BINDING_MISMATCH")
        self._hydrate_bulk_product(prep, output, product)
        return product, pid

    def _bulk_summary(self, prep, snap, leaf, identity, node_refs):
        from . import indexed_bulk as bulk
        from .volume_publication import PreparationSummary
        root = prep.engine.root
        files = {}

        def add(rel, kind, expected=None):
            path = bulk.checked_path(root, rel)
            checksum = sha256_file(path)
            if expected is not None and checksum != expected:
                raise ValueError("BULK_PREP_CLOSURE_DIGEST_MISMATCH:" + rel)
            files[rel] = PrepFile(rel, checksum, path.stat().st_size, kind)

        sid = snap["snapshot_id"]
        protocol = bulk.protocol_for_snapshot(snap)
        key = self._request_key(identity)
        snap_rel = bulk.snapshot_relative(sid)
        commit_rel = f"catalog/commits/{sid}.json"
        formal_rel = f"catalog/product_service/data_only_formal_publications/{key}.json"
        result = bulk.summary_result(leaf, snap, duplicate=False)
        record = {**result, "request_key": key, "request_identity": identity,
                  "input_fingerprint": identity["submission_digest"][7:],
                  "formal_publication_state": "published_formal"}
        prep.engine._write_immutable(formal_rel, canonical(record))
        for part in leaf["parts"]:
            add(bulk.part_relative(part["sha256"], protocol=protocol), "data", part["sha256"])
        for ref in node_refs:
            add(bulk.node_relative(ref, protocol=protocol), "bulk_index_node", ref[7:])
        _add_product_closure(add, leaf["product"], root)
        add(snap_rel, "snapshot")
        add(commit_rel, "commit")
        add(formal_rel, "formal_receipt")
        instance = PreparationInstance(root, identity, sid, snap["parent_snapshot_id"], self.protocol_root)
        return PreparationSummary(instance, key, identity["submission_digest"][7:], sid,
                                  snap["parent_snapshot_id"], files[snap_rel].sha256, snap_rel,
                                  files[snap_rel].sha256, commit_rel, files[commit_rel].sha256, formal_rel,
                                  files[formal_rel].sha256, tuple(files.values()), (), {}, snap)

    def _bulk_intent_rel(self, key):
        # One global key space preserves existing intent recovery and prevents
        # request IDs from being reused across bulk formats and ordinary writes.
        return f"catalog/product_service/source_minute/intents/{key}.json"

    def _assert_no_bulk_intent(self, key):
        path = self.root / self._bulk_intent_rel(key)
        if path.exists() or path.is_symlink():
            raise ValueError("REQUEST_ID_CONFLICT")

    def _write_bulk_intent(self, key, intent):
        rel = self._bulk_intent_rel(key)
        _reject_symlink_path(self.root, rel)
        path = self.root / rel
        raw = canonical(intent)
        if path.exists():
            if path.read_bytes() != raw:
                raise ValueError("REQUEST_ID_CONFLICT")
        else:
            _atomic_write(path, raw)

    def _bulk_terminal(self, header, result):
        from . import indexed_bulk as bulk
        identity = header["request_identity"]
        self._write_bulk_intent(self._request_key(identity), {
            "protocol_version": header["protocol_version"], "request_identity": identity,
            "parent_snapshot_id": header["expected_parent_snapshot_id"],
            "owner_caller_id": self.caller_id, "terminal_result": result,
        })
        return result

    def _bulk_holding(self, snap, leaf, formal_sha256):
        from . import indexed_bulk as bulk
        return {**bulk.locator(snap), "format_version": ("wfd.tabular-holding/1" if bulk.protocol_for_snapshot(snap) == bulk.tabular.PROTOCOL
                                                          else "wfd.source-minute-holding/1"),
                "request_key": snap["request_key"], "instance_id": self.binding.instance_id,
                "row_count": leaf["header"]["row_count"], "identities_digest": leaf["identities_digest"],
                "formal_sha256": formal_sha256, "stage": "published_readable"}

    def _bulk_formal_result(self, snap, leaf, *, require_holding):
        from . import indexed_bulk as bulk
        identity = leaf["header"]["request_identity"]
        key = self._request_key(identity)
        if (key != snap["request_key"] or snap["partition_fingerprint"] != identity["submission_digest"]):
            raise ValueError("BULK_REQUEST_BINDING_MISMATCH")
        formal_rel = f"catalog/product_service/data_only_formal_publications/{key}.json"
        formal_path = self.root / formal_rel
        if not formal_path.exists() and not formal_path.is_symlink():
            return None
        raw = bulk.checked_path(self.root, formal_rel).read_bytes()
        result = bulk.summary_result(leaf, snap, duplicate=False)
        expected = {**result, "request_key": key, "request_identity": identity,
                    "input_fingerprint": identity["submission_digest"][7:],
                    "formal_publication_state": "published_formal"}
        if raw != canonical(expected):
            raise ValueError("BULK_FORMAL_RECEIPT_MISMATCH")
        if require_holding:
            holding_rel = f"catalog/product_service/holdings/source_minute/{key}.json"
            holding_path = self.root / holding_rel
            if not holding_path.exists() and not holding_path.is_symlink():
                return None
            holding = self._bulk_holding(snap, leaf, sha(raw))
            if bulk.checked_path(self.root, holding_rel).read_bytes() != canonical(holding):
                raise ValueError("BULK_HOLDING_CONFLICT")
        return {**result, "request_identity": identity, "formal_publication_ref": formal_rel}

    def reconcile_bulk_batch(self, header, *, for_finalize=False):
        """Reconcile a previously attempted finalize against the volume without writes."""
        from . import indexed_bulk as bulk
        from .state import COMPAT_FORMATS, StateStore

        self._require("publish" if for_finalize else "read")
        self._verify_volume()
        identity = header["request_identity"]
        key = self._request_key(identity)
        intent_rel = self._bulk_intent_rel(key)
        intent_path = self.root / intent_rel
        if not intent_path.exists() and not intent_path.is_symlink():
            return {"activation_state": "not_activated", "recovery_required": True}
        intent = _read_json(bulk.checked_path(self.root, intent_rel))
        if (intent.get("protocol_version") != header["protocol_version"] or intent.get("request_identity") != identity
                or intent.get("parent_snapshot_id") != header["expected_parent_snapshot_id"]):
            raise ValueError("BULK_INTENT_MISMATCH")
        if "terminal_result" in intent:
            if intent["owner_caller_id"] != self.caller_id:
                raise ValueError("REQUEST_ID_CONFLICT")
            result = intent["terminal_result"]
            if result["state"] == "unchanged":
                snap = bulk.read_snapshot(self.root, result["snapshot_id"], protocol=header["protocol_version"])
                leaf = bulk.partition_leaf(self.root, snap, result["product_id"], result["partition"], result["result_root"])
                if (bulk.locator(snap) != bulk.locator(result)
                        or not bulk.same_partition_request(leaf["header"], header)
                        or result != bulk.summary_result(leaf, snap, duplicate=True)
                        or self._bulk_formal_result(snap, leaf, require_holding=True) is None):
                    raise ValueError("BULK_FORMAL_RECEIPT_MISMATCH")
                return {**result, "phase": "finalized", "recovery_required": False}
            if result["state"] == "conflicts_pending":
                return {**result, "phase": "rejected", "activation_state": "not_activated", "recovery_required": False}
            raise ValueError("BULK_INTENT_MISMATCH")
        sid = intent["snapshot_id"]
        state_store = StateStore(self.root)
        if state_store.path.is_symlink():
            raise ValueError("HEAD_INVALID_FORMAT")
        state = state_store.read() or {}
        if state and (state.get("format_version") not in COMPAT_FORMATS or "active_head" not in state):
            raise ValueError("HEAD_INVALID_FORMAT")
        active = state.get("active_head")
        history = state.get("activation_history") or []
        activated = active == sid or any(item["snapshot_id"] == sid for item in history)
        if not activated and active is not None:
            # The head retains old partitions even after the bounded activation history rolls over.
            active_path = bulk.checked_path(self.root, bulk.snapshot_relative(active))
            expected_sha = state.get("head_snapshot_sha256")
            if expected_sha is not None and "sha256:" + sha256_file(active_path) != expected_sha:
                raise ValueError("BULK_ACTIVATION_DIGEST_MISMATCH")
            current = self.engine._valid_snapshot_exact(active, verify_payloads=False)
            protocol = header["protocol_version"]
            activated = bulk.partition_ref(self.root, current.get(bulk.root_field(protocol)),
                intent["product_id"], intent["partition"], protocol) == intent["result_root"]
        if not activated:
            if active != intent["parent_snapshot_id"]:
                return {"activation_state": "not_activated", "recovery_required": False,
                        "snapshot_id": sid, "phase": "rejected", "state": "rejected",
                        "errors": [{"code": "PARENT_CHANGED"}]}
            return {"activation_state": "not_activated", "recovery_required": True, "snapshot_id": sid}
        if active == sid and state["head_snapshot_sha256"] != intent["snapshot_sha256"]:
            raise ValueError("BULK_ACTIVATION_DIGEST_MISMATCH")
        snap = bulk.read_snapshot(self.root, sid, expected_sha=intent["snapshot_sha256"], protocol=header["protocol_version"])
        if bulk.locator(snap) != bulk.locator(intent) or snap["parent_snapshot_id"] != intent["parent_snapshot_id"]:
            raise ValueError("BULK_INTENT_MISMATCH")
        leaf = bulk.partition_leaf(self.root, snap, snap["product_id"], snap["partition"], snap["result_root"])
        if leaf["header"] != header:
            raise ValueError("BULK_INTENT_MISMATCH")
        result = self._bulk_formal_result(snap, leaf, require_holding=True)
        if result is None:
            return {"activation_state": "activated", "recovery_required": True, **bulk.locator(snap)}
        self._target_service()._verify_binding(leaf["product"])
        return {**result, "phase": "finalized", "activation_state": "activated", "recovery_required": False}

    def submit_bulk_batch(self, header, chunks):
        from . import indexed_bulk as bulk, usage_suspension
        from .writerlock import writer_lock

        self._require("submit")
        self._require("publish")
        self._verify_volume(write=True)
        identity = header["request_identity"]
        key = self._request_key(identity)
        expected = header["expected_parent_snapshot_id"]
        protocol = header["protocol_version"]
        indexed_field = bulk.root_field(protocol)
        namespace = bulk.storage_namespace(protocol)
        contract_digest = (header.get("table_contract") or {}).get("digest")
        prep_root = self.prep_root / namespace / key
        if prep_root.is_symlink() or _path_within(prep_root, self.root):
            raise ValueError("PREP_ROOT_INVALID")
        prep = self._open_prep(prep_root)
        frozen_targets_digest = bulk.digest(prep._write_targets_document)
        candidate_path = prep_root / f"{namespace}_candidate.json"
        with writer_lock(self.root):
            formal_path = self.root / f"catalog/product_service/data_only_formal_publications/{key}.json"
            if (self._intent_path(key).exists() or self._duplicate_plan_path(key).exists()
                    or formal_path.exists() and not (self.root / self._bulk_intent_rel(key)).exists()):
                raise ValueError("REQUEST_ID_CONFLICT")
            if candidate_path.is_file():
                candidate = _read_json(candidate_path)
                if (candidate["fingerprint"] != identity["submission_digest"]
                        or candidate["owner_caller_id"] != self.caller_id):
                    raise ValueError("REQUEST_ID_CONFLICT")
                snap = bulk.read_snapshot(prep_root, candidate["snapshot_id"], protocol=protocol)
                leaf = bulk.partition_leaf(prep_root, snap, snap["product_id"], snap["partition"], snap["result_root"])
                node_refs = candidate["node_refs"]
                frozen_targets_digest = candidate["write_targets_digest"]
            else:
                roots, legacy, parent_sha = self._bulk_parent(expected)
                self._assert_no_bulk_intent(key)
                output = header["outputs"][0]
                previous_product, expected_pid = self._existing_bulk_product(
                    prep, output, identity, roots, protocol, contract_digest)
                # Validate the existing structured schema with a representative bounded row;
                # the complete source stream is checked against the same fixed product below.
                stream = iter(chunks)
                first = next(stream, None)
                if not first:
                    raise ValueError("BULK_CHUNK_MISSING")
                sample = bulk.structured_document(header, [bulk.semantic_row(header, first[0])[1]])
                usage_suspension.enforce_submit(self.root, {**sample, "outputs": [
                    {**sample["outputs"][0], "product_id": expected_pid}]})
                product, target, first_bind = prep._prepare_bulk_product(
                    sample, header, previous_product)
                pid = product["product_id"]
                if pid != expected_pid:
                    raise ValueError("BULK_PRODUCT_FAMILY_CHANGED")
                if previous_product is not None and previous_product["definition_ref"] != product["definition_ref"]:
                    raise ValueError("BULK_DEFINITION_CHANGED")
                if legacy is not None and previous_product is None:
                    baseline = self.engine._valid_snapshot_exact(legacy["snapshot_id"], verify_payloads=False)
                    if any(entry["product_id"] == pid for entry in baseline["files"]):
                        raise ValueError("BULK_LEGACY_PRODUCT_CONFLICT")
                partition = bulk.partition_value(header)
                branches = bulk.partition_path(self.root, roots.get(indexed_field), pid, partition, protocol=protocol)
                _, partition_key, _, leaf_kind = bulk.partition_keys(partition, protocol)
                existing_ref = branches[2].get(partition_key)
                from itertools import chain
                leaf = bulk.stage_partition(prep.engine, header, chain((first,), stream), product)
                if existing_ref is not None:
                    old = bulk.read_node(self.root, existing_ref, leaf_kind, protocol=protocol)
                    original = old["header"]
                    if (not bulk.same_partition_request(original, header)
                            or old["product"]["contract_refs"] != product["contract_refs"]):
                        return self._bulk_terminal(header, {
                            "state": "conflicts_pending", "errors": [{"code": "BULK_PARTITION_CONFLICT"}],
                            "row_summary": {"inserted": 0, "duplicate_skipped": 0,
                                            "conflict_pending": header["row_count"], "pending_publication": 0}})
                    bulk.verify_partition(self.root, old)
                    original_proof = self.reconcile_bulk_batch(original, for_finalize=True)
                    if original_proof.get("phase") != "finalized":
                        return {"state": "publication_unknown", "errors": [{"code": "BULK_PRIOR_RECOVERY_REQUIRED"}]}
                    old_locator = bulk.locator(original_proof)
                    if (old_locator["product_id"] != pid or old_locator["partition"] != partition
                            or old_locator["result_root"] != existing_ref):
                        raise ValueError("BULK_FORMAL_RECEIPT_MISMATCH")
                    return self._bulk_terminal(header, bulk.summary_result(old, old_locator, duplicate=True))
                node_refs = []

                def write(rel, raw):
                    prep.engine._write_immutable(rel, raw)
                    node_refs.append("sha256:" + sha(raw))

                result_root = bulk.write_node(leaf, write, protocol=protocol)
                new_root = bulk.put_partition(write, branches, product, partition, result_root,
                                              protocol=protocol, contract_digest=contract_digest)
                inherited = {field: ref for field, ref in roots.items() if field != indexed_field}
                for other_protocol, ref in bulk.root_nodes(inherited):
                    rel = bulk.node_relative(ref, protocol=other_protocol)
                    prep.engine._write_immutable(rel, bulk.checked_path(self.root, rel).read_bytes())
                snap = bulk.write_candidate(prep.engine, {**inherited,
                    "format_version": bulk.SNAPSHOT_FORMATS[bulk.PROTOCOLS.index(protocol)],
                    "parent_snapshot_id": expected, "parent_sha256": parent_sha, "legacy_anchor": legacy,
                    "root": new_root, "product_id": pid, "partition": partition, "result_root": result_root,
                    "request_key": key, "partition_fingerprint": identity["submission_digest"]})
                if first_bind:
                    prep._record_write_target(identity["dataset_id"], target, product_id=pid,
                        snapshot_id=snap["snapshot_id"], origin="first_publication", reason="First complete tabular partition" if protocol == bulk.tabular.PROTOCOL else "First complete source-minute date")
                _atomic_write(candidate_path, canonical({"fingerprint": identity["submission_digest"],
                    "snapshot_id": snap["snapshot_id"], "node_refs": node_refs,
                    "owner_caller_id": self.caller_id, "write_targets_digest": frozen_targets_digest}))
            bulk.verify_partition(prep_root, leaf)
            summary = self._bulk_summary(prep, snap, leaf, identity, node_refs)
            intent = {**bulk.locator(snap), "protocol_version": header["protocol_version"], "request_identity": identity,
                      "parent_snapshot_id": expected, "snapshot_sha256": "sha256:" + summary.snapshot_sha256}
            self._write_bulk_intent(key, intent)

        def observe(stage, details):
            if self.fault_injector is not None:
                self.fault_injector(stage, details)
            if stage in {"target_verified", "before_activate"}:
                output = header["outputs"][0]
                usage_suspension.enforce_submit(self.root, {"expected_parent_snapshot_id": expected,
                    "outputs": [{**output, "product_id": snap["product_id"]}]})
                latest_targets = self._target_write_targets()
                if bulk.digest(latest_targets) != frozen_targets_digest:
                    raise ValueError("BULK_WRITE_TARGET_DRIFT")

        publisher = VolumePublisher(binding=self.binding, runtime_root=self.runtime_root,
                                    detector=self.detector, fault_injector=observe,
                                    prep_writer_host=self.binding.writer_host)
        published = publisher.publish_prepared(summary)
        if published.get("status") not in {"activated", "already_activated"}:
            errors = published.get("errors", [])
            if any(item.get("code") in {"PARENT_CHANGED", "HEAD_CONFLICT"} for item in errors):
                proof = self.reconcile_bulk_batch(header, for_finalize=True)
                if proof.get("phase") == "rejected":
                    return {"state": "rejected", "errors": errors}
            return {"state": "publication_unknown", "snapshot_id": snap["snapshot_id"],
                    "errors": published.get("errors", []), "publisher_status": published.get("status")}
        with writer_lock(self.root):
            adoption = self._adopt_prep_write_targets(prep_root)
            if adoption.get("error"):
                raise RuntimeError("BULK_WRITE_TARGET_ADOPTION_FAILED:" + adoption["error"])
            holding = self._bulk_holding(snap, leaf, summary.formal_sha256)
            holding_path = self.root / f"catalog/product_service/holdings/source_minute/{key}.json"
            holding_rel = holding_path.relative_to(self.root).as_posix()
            _reject_symlink_path(self.root, holding_rel)
            if holding_path.exists():
                if _read_json(holding_path) != holding:
                    raise RuntimeError("BULK_HOLDING_CONFLICT")
            else:
                _atomic_write(holding_path, canonical(holding))
        result = bulk.summary_result(leaf, snap, duplicate=False)
        result["request_identity"] = identity
        result["formal_publication_ref"] = summary.formal_relpath
        return result

    def read_bulk_page(self, *, snapshot_id, product_id, partition, result_root, page_size=100, cursor=None,
                       protocol_version=None):
        from . import indexed_bulk as bulk
        self._require("read")
        self._verify_volume()
        if protocol_version not in (None, *bulk.PROTOCOLS):
            raise ValueError("BULK_PROTOCOL_INVALID")
        snap = bulk.read_snapshot(self.root, snapshot_id, protocol=protocol_version)
        protocol = bulk.protocol_for_snapshot(snap)
        leaf = bulk.partition_leaf(self.root, snap, product_id, partition, result_root)
        from . import usage_suspension
        if bulk.locator(snap) != {"snapshot_id": snapshot_id, "product_id": product_id,
                                  "partition": partition, "result_root": result_root}:
            raise ValueError("BULK_LOCATOR_MISMATCH")
        if self._bulk_formal_result(snap, leaf, require_holding=True) is None:
            raise ValueError("BULK_PUBLICATION_NOT_FORMAL")
        self._target_service()._verify_binding(leaf["product"])
        locator = bulk.locator(snap)
        if protocol != bulk.legacy.PROTOCOL:
            locator["protocol_version"] = protocol
        result = bulk.read_page(self.root, leaf, locator, page_size=page_size, cursor=cursor)
        usage_suspension.enforce_read(self.root, {"snapshot_id": snapshot_id, "rows": [
            {"record_ref": {"product_id": product_id, "revision_id": row["record_version"]}}
            for row in result["rows"]]})
        return result

    # The bound machine entry probes this historical method name.
    read_source_minute_page = read_bulk_page

    def release_bulk_prep(self, identity, protocol):
        from . import indexed_bulk as bulk
        key = self._request_key(identity)
        path = self.prep_root / bulk.storage_namespace(protocol) / key
        if path.is_dir() and not path.is_symlink() and not _path_within(path, self.root):
            shutil.rmtree(path)

    def _target_adjustment_anchors(self):
        """The target's own registered anchors: a preparation store never decides them."""
        from . import adjustment_anchors
        try:
            return adjustment_anchors.load(self.root)
        except (OSError, ValueError) as exc:
            code = str(exc).split(":", 1)[0] or "ADJUSTMENT_ANCHOR_UNREGISTERED"
            raise ValueError(code + ":" + str(exc)) from exc

    def _target_basis_catalog(self):
        """The target's own catalog for resolving an anchor's basis price (P2-R2).

        Same rule as the anchor catalog and the write-target bindings: a
        preparation store never decides what the basis price of a target write
        was; it is read from the target volume at the pinned snapshot.  Returned
        as a lazy factory: the target read service is opened only when a write
        actually cites a product-anchored basis price, so a plain submission
        performs exactly the same volume reads as before.
        """
        from . import basis_prices
        return lambda: basis_prices.StoreCatalog(self.root, self._target_service())

    def _target_reserved_families(self):
        """Families already holding product records at the target."""
        reserved = {}
        product_dir = self.root / "catalog/product_service/products"
        if not product_dir.is_dir():
            return reserved
        for path in product_dir.rglob("definition_*.json"):
            if path.name.startswith("._"):
                continue
            try:
                record = _read_json(path)
            except (OSError, ValueError):
                continue
            dataset_id = record.get("dataset_id")
            family = record.get("product_family_id")
            product_id = record.get("product_id")
            if not (isinstance(dataset_id, str) and isinstance(family, str)
                    and isinstance(product_id, str)):
                continue
            ids = reserved.setdefault(dataset_id, {}).setdefault(family, [])
            if product_id not in ids:
                ids.append(product_id)
        for families in reserved.values():
            for ids in families.values():
                ids.sort()
        return reserved

    def register_write_target(self, dataset_id, product_id, definition_ref=None,
                              reason="explicit registration", snapshot_id=None):
        """Explicit first-bind / rebind against the target volume."""
        self._require("register")
        self._require("publish")
        self._verify_volume(write=True)
        result = self._target_service()._register_write_target_body(
            dataset_id, product_id, definition_ref=definition_ref,
            reason=str(reason), snapshot_id=snapshot_id)
        self._read_service = None
        return result

    def register_adjustment_anchor(self, dataset_id, anchor_id, **kwargs):
        """Explicit anchor registration against the target volume catalog."""
        self._require("register")
        self._require("publish")
        self._verify_volume(write=True)
        result = self._target_service()._register_adjustment_anchor_body(
            dataset_id, anchor_id, **kwargs)
        self._read_service = None
        return result

    # ------------------------------------------------------------- write target
    def _target_write_targets(self):
        """The target's own bindings: the prep store never decides them."""
        from . import write_targets as binding_catalog
        try:
            return binding_catalog.load(self.root)
        except (OSError, ValueError) as exc:
            raise ValueError("WRITE_TARGET_QUERY_FAILED:" + str(exc)) from exc

    def _adopt_prep_write_targets(self, prep_root):
        """Carry first-publication bindings into the target catalog.

        Only families that the target does not bind yet are adopted; an
        existing binding is never replaced by a preparation store.
        """
        from . import write_targets as binding_catalog
        prep_path = Path(prep_root) / binding_catalog.RELATIVE_PATH
        if not prep_path.is_file() or prep_path.is_symlink():
            return {"adopted": [], "skipped": []}
        try:
            prep_doc = json.loads(prep_path.read_text("utf-8"))
        except (OSError, ValueError) as exc:
            return {"adopted": [], "skipped": [], "error": str(exc)}
        target_doc = binding_catalog.load(self.root)
        bound = {(entry.get("dataset_id"), entry.get("product_family_id"))
                 for entry in target_doc.get("entries") or [] if isinstance(entry, dict)}
        adopted, skipped = [], []
        for entry in prep_doc.get("entries") or []:
            if not isinstance(entry, dict):
                continue
            key = (entry.get("dataset_id"), entry.get("product_family_id"))
            if key in bound:
                skipped.append({"dataset_id": key[0], "product_family_id": key[1],
                                "reason": "already bound at target"})
                continue
            clone = copy.deepcopy(entry)
            clone["sequence"] = int(target_doc.get("sequence") or 0) + 1
            binding_catalog.write_entry(self.root, target_doc, clone)
            target_doc = binding_catalog.load(self.root)
            bound.add(key)
            adopted.append({"dataset_id": key[0], "product_family_id": key[1],
                            "product_id": clone.get("product_id"),
                            "bound_snapshot_id": clone.get("bound_snapshot_id")})
        return {"adopted": adopted, "skipped": skipped}

    def _rejected_document(self, document, exc):
        identity = (document.get("request_identity")
                    if isinstance(document, Mapping) else {})
        if not isinstance(identity, Mapping):
            identity = {}
        key = None
        if all(isinstance(identity.get(name), str) and identity.get(name)
               for name in ("dataset_id", "trusted_actor_namespace", "request_id")):
            try:
                key = self._request_key(dict(identity))
            except Exception:
                key = None
        code = str(exc).split(":", 1)[0] or "REQUEST_INVALID"
        return {
            "protocol_version": "wfd.structured-ingest/1.0",
            "profile": DATA_ONLY_PROFILE,
            "request_key": key,
            "request_identity": dict(identity),
            "state": "rejected",
            "snapshot_id": None,
            "output_results": [],
            "formal_publication_ref": None,
            "formal_publication_verified": False,
            "idempotent_replay": False,
            "errors": [{"code": code, "message": str(exc)}],
            "production_publishable": False,
        }

    def submit(self, document):
        self._require("submit")
        self._verify_volume(write=True)
        identity = dict(document.get("request_identity") or {})
        if all(identity.get(name) for name in ("dataset_id", "trusted_actor_namespace", "request_id")):
            try:
                self._assert_no_bulk_intent(self._request_key(identity))
            except ValueError as exc:
                return self._rejected_document(document, exc)
        duplicate_plan = self._duplicate_plan(identity)
        if duplicate_plan:
            if (duplicate_plan.get("request_identity") != identity
                    or duplicate_plan.get("input_fingerprint") != sha(canonical(document))):
                return self._rejected_document(document, ValueError("REQUEST_ID_CONFLICT"))
            if duplicate_plan["result"].get("state") in {"unchanged", "conflicts_pending", "rejected"}:
                return {**copy.deepcopy(duplicate_plan["result"]), "idempotent_replay": True}
        existing = self._formal_status(identity, document)
        if existing is not None:
            if existing.get("state") == "published_formal":
                self._ensure_holdings_from_proof(self._request_key(identity), existing)
                existing["idempotent_replay"] = True
            return existing
        self._require("publish")
        recovered = self._recover_target_commit(identity, document)
        if recovered is not None:
            if recovered.get("state") == "published_formal":
                recovered["idempotent_replay"] = True
            return recovered
        try:
            identity, _outputs = self._validate_submit_document(document)
        except (ValueError, OSError, RuntimeError) as exc:
            return self._rejected_document(document, exc)
        key = self._request_key(identity)
        # Native prep is disposable: hydrate the exact parent closure on every
        # submit (cold or hot), then clean it after a successful publication.
        prep_root = self.prep_root / "workspace"
        expected_parent = document.get("expected_parent_snapshot_id")
        try:
            if prep_root.is_symlink() or _path_within(prep_root, self.root):
                raise ValueError("PREP_ROOT_INVALID")
            prep_root.mkdir(parents=True, exist_ok=True)
            adoption = row_version_objects.adoption_record(self.root, self.runtime_root)
            verified = self._source_state(expected_parent) if adoption is not None else None
            if expected_parent is not None:
                hydration = self._seed_prep_from_target(prep_root, expected_parent,
                                                        document=document)
                if adoption is None and any(item["kind"] == "row_version_object"
                                            for item in hydration["collected_files"]):
                    raise ValueError("ROW_VERSION_ADOPTION_CHANGED:target marker missing")
            prep_service = self._open_prep(prep_root)
            self._authorize_prep_row_versions(prep_service, document, adoption, verified)
        except (ValueError, OSError, VolumeError, RuntimeError) as exc:
            return self._rejected_document(document, exc)
        result = prep_service.submit(document)
        if document.get("duplicate_policy") == "skip_identical_append":
            try:
                self._save_duplicate_plan(identity, document, result)
            except ValueError as exc:
                return self._rejected_document(document, exc)
        if result.get("state") not in {"published_formal", "partially_published_formal"}:
            return result
        instance = PreparationInstance(
            prep_root=prep_root,
            request_identity=identity,
            snapshot_id=result["snapshot_id"],
            expected_parent=document.get("expected_parent_snapshot_id"),
            protocol_root=self.protocol_root,
            unit_registry=self.unit_registry,
            trusted_actor_namespaces=tuple(self.trusted_actor_namespaces),
            caller_roles=tuple(sorted(self.caller_roles)),
            caller_id=self.caller_id,
            request_document=document,
            row_version_adoption=adoption,
            target_state_sha256=verified["state_sha256"] if verified is not None else None,
            target_head_sha256=verified["head_sha256"] if verified is not None else None,
        )
        binding_path = self.root / "catalog/product_service/volume_binding.json"
        if not binding_path.is_file():
            self._verify_volume(write=True)
            _atomic_write(binding_path, canonical({
                "format_version": "wfd.volume-binding/1.0",
                "instance_id": self.binding.instance_id,
                "writer_host": self.binding.writer_host,
                "writer_epoch": self.binding.writer_epoch,
                "volume_uuid": self.binding.volume_uuid,
                "filesystem": self.binding.filesystem,
            }) + b"\n")
        fingerprint = sha(canonical(document))
        context = None
        if adoption is not None:
            context = {"snapshot_id": instance.snapshot_id,
                       "adoption_sha256": sha(canonical(adoption)),
                       "state_sha256": verified["state_sha256"],
                       "head_sha256": verified["head_sha256"]}
        try:
            self._write_target_intent(
                key, identity, fingerprint, expected_parent,
                WFDDataOnlyService._publication_results(result.get("output_results", [])),
                row_version_context=context,
            )
        except ValueError as exc:
            return self._rejected_document(document, exc)
        from datetime import datetime, timezone
        stage_times = {}
        proof_records = [record for output in WFDDataOnlyService._publication_results(result.get("output_results", []))
                         for record in output.get("records", [])]
        def observe(stage, details):
            at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            stage_times[stage] = at
            if stage == "after_copy" and "acquired" not in stage_times:
                self._write_stage_proof(key, identity, result["snapshot_id"],
                                        proof_records, "acquired", at)
            elif stage == "target_verified" and "custodied" not in stage_times:
                self._write_stage_proof(key, identity, result["snapshot_id"],
                                        proof_records, "custodied", at)
            if self.fault_injector is not None:
                self.fault_injector(stage, details)
        publisher = VolumePublisher(
            binding=self.binding, runtime_root=self.runtime_root,
            detector=self.detector, fault_injector=observe,
            prep_writer_host=self.binding.writer_host,
        )
        published = publisher.publish(instance)
        if published.get("status") != "activated":
            published = dict(published)
            published["request_identity"] = identity
            published["preparation_root"] = str(prep_root)
            return published
        target = self._formal_status(identity)
        if target is None:
            return {
                "state": "published_formal_pending_receipt",
                "snapshot_id": result.get("snapshot_id"),
                "request_identity": identity,
                "output_results": result.get("output_results", []),
                "idempotent_replay": False,
                "errors": [{"code": "FORMAL_RECEIPT_PENDING",
                            "message": "target activation completed but formal receipt is not readable"}],
                "volume": {"binding": self.binding.to_dict(),
                           "publisher": published},
            }
        write_target_adoption = None
        try:
            write_target_adoption = self._adopt_prep_write_targets(prep_root)
        except (OSError, ValueError, VolumeError) as exc:
            write_target_adoption = {"adopted": [], "skipped": [], "error": str(exc)}
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        records = [record for output in WFDDataOnlyService._publication_results(target.get("output_results", []))
                   for record in output.get("records", [])]
        self._write_stage_proof(key, identity, target.get("snapshot_id"),
                                records, "published_readable", now)
        self._ensure_holdings_from_proof(key, target)
        target["publisher"] = {
            "status": published.get("status"),
            "volume": published.get("volume"),
            "head": published.get("head"),
        }
        if write_target_adoption is not None:
            target["write_target_adoption"] = write_target_adoption
        shutil.rmtree(prep_root, ignore_errors=True)
        return target


__all__ = ["WFDVolumeService"]
