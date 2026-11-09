"""Precise, fixed-snapshot financial bundles over the unchanged storage layer.

``wfd.financial-bundle/0.2`` is a physical selection bundle.  It does not copy
whole source snapshots and then hide extra products in a read API.  Selected
products, selected rows, selected fields and the necessary read closure are
written into a *new* target snapshot.  ``0.1`` packages produced by the earlier
implementation remain importable (read-only compatibility).

The module deliberately reuses ``ProductQuery`` for fixed-snapshot selection
and the storage engine's existing immutable writes.  It does not modify the
shared service, governance, query or DuckDB SDK modules.
"""
from __future__ import annotations

import copy
import json
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from .duckdb_sdk import WFDDuckDBPrototype, canonical, load_protocol_validator, sha
from .duckdb_storage import parquet_from_rows, rows_from_parquet
from .lineage import Lineage, sha_file
from .product_governance import normalize_source_policies
from .product_holdings import (
    HoldingError, HoldingLedger, STAGES, record_import_batch,
    resolve_target_instance, target_holding_summary, target_stage_proof_index,
    write_target_stage_proof,
)
from .product_query import ProductQuery, ProductQueryError
from .product_service import WFDProductService
from .product_data_service import WFDDataOnlyService
from .transfer import export_package, import_package, object_manifest, verify_package
from .writerlock import writer_lock
from .row_version_objects import reject_unsupported


LEGACY_FORMAT = "wfd.financial-bundle/0.1"
FORMAT = "wfd.financial-bundle/0.2"
TARGET_FORMAT = "wfd.financial-bundle-target/0.2"
SELECTION_FORMAT = "wfd.bundle-selection/0.2"

UNKNOWN_TIME = {
    "status": "unknown", "precision": "unknown",
    "earliest_utc": None, "latest_exclusive_utc": None,
    "source_timezone": "UTC",
}

_ABS_PATH = re.compile(
    r"^(?:/Users/|/Volumes/|/home/|/private/|/tmp/|/var/folders/"
    r"|[A-Za-z]:[\\/]|file://|\\\\[^\\])"
)
_MAX_PAGE = 500
_DEFAULT_LIMITS = {
    "max_scan_bytes": 256 * 1024 * 1024,
    "max_nodes": 200_000,
    "page_size": _MAX_PAGE,
    "max_pages": 400,
}


def _path(root, relative):
    p = PurePosixPath(relative)
    if not relative or p.is_absolute() or ".." in p.parts or "\\" in relative:
        raise ValueError("BUNDLE_PATH_INVALID:" + str(relative))
    target = Path(root) / p
    if not target.resolve().is_relative_to(Path(root).resolve()):
        raise ValueError("BUNDLE_PATH_INVALID:" + str(relative))
    return target


def _json(path):
    return json.loads(Path(path).read_text("utf-8"))


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _bindings(snapshot):
    products = {}
    for entry in snapshot["files"]:
        bound = entry["source_bundle"].get("_wfd_product_bindings", {}).get(entry["output_key"])
        if not bound or bound["product"]["product_id"] != entry["product_id"]:
            raise ValueError("BUNDLE_PRODUCT_BINDING_MISSING:" + entry["product_id"])
        product = bound["product"]
        products.setdefault(product["product_id"], {})[sha(canonical(product))] = product
    return products


def _entry_binding(entry):
    bound = entry.get("source_bundle", {}).get("_wfd_product_bindings", {}).get(entry.get("output_key"))
    if not bound or (bound.get("product") or {}).get("product_id") != entry.get("product_id"):
        raise ValueError("BUNDLE_PRODUCT_BINDING_MISSING:" + str(entry.get("product_id")))
    return bound


def _entry_source_ids(entry):
    bundle = entry.get("source_bundle", {})
    values = list(bundle.get("source_ids", []))
    if bundle.get("source_id"):
        values.append(bundle["source_id"])
    admission = _entry_binding(entry).get("source_admission") or {}
    values.extend(admission.get("source_ids", []))
    for ref in entry.get("evidence_refs", []):
        if ref.get("source_id"):
            values.append(ref["source_id"])
    return list(dict.fromkeys(x for x in values if isinstance(x, str) and x))


def _output_source_ids(entry):
    """Sources that actually describe this output, not unrelated batch sources."""
    admission = (_entry_binding(entry).get("source_admission") or {}).get("source_ids") or []
    if admission:
        return list(dict.fromkeys(x for x in admission if isinstance(x, str) and x))
    return _entry_source_ids(entry)


def _clean_paths(value, trail, found):
    """Replace platform absolute paths with stable, non-revealing locators."""
    if isinstance(value, dict):
        return {key: _clean_paths(item, trail + [str(key)], found) for key, item in value.items()}
    if isinstance(value, list):
        return [_clean_paths(item, trail + [str(index)], found) for index, item in enumerate(value)]
    if isinstance(value, str) and _ABS_PATH.match(value):
        digest = sha(canonical(value))
        alias = "wfd-locator:" + digest[:16]
        found.append({"field": ".".join(trail), "alias": alias, "sha256": "sha256:" + digest})
        return alias
    return value


def _scan_absolute_paths(value, trail=()):
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            found.extend(_scan_absolute_paths(item, trail + (str(key),)))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.extend(_scan_absolute_paths(item, trail + (str(index),)))
    elif isinstance(value, str) and _ABS_PATH.match(value):
        found.append(".".join(trail))
    return found


def _known_time(value):
    return (isinstance(value, dict) and value.get("status") == "known"
            and bool(value.get("earliest_utc")) and bool(value.get("latest_exclusive_utc")))


def _time_bearing(rows):
    keys = ("observation_time", "event_time", "public_time", "expected_time", "effective_period")
    return any(isinstance(row.get(key), dict) for row in rows for key in keys)


def _row_key(row, payload_kind):
    return row.get("event_id") if payload_kind == "event_records" else row.get("business_key")


def _version_for_row(row, payload_kind, source_bundle, output_key, product_id, snapshot_id):
    key_field = "event_id" if payload_kind == "event_records" else "business_key"
    physical = row.get(key_field)
    version = ((source_bundle or {}).get("_wfd_row_versions") or {}).get(output_key, {}).get(physical)
    if version is None:
        version = {
            "logical_key": physical,
            "revision_id": "r_legacy_" + sha(canonical([product_id, row]))[:32],
            "supersedes": None,
            "input_mode": "partial_observation",
            "withdrawn": False,
            "reason": None,
        }
    return copy.deepcopy(version)


def _target_physical_key(version):
    if version.get("supersedes") or version.get("withdrawn"):
        return "revision_" + version["revision_id"]
    return version["logical_key"]


def _source_time_for_row(source_bundle, output_key, physical_key):
    per_row = ((source_bundle or {}).get("row_public_times") or {}).get(output_key, {})
    if physical_key in per_row:
        return copy.deepcopy(per_row[physical_key])
    value = (source_bundle or {}).get("public_time")
    return copy.deepcopy(value) if isinstance(value, dict) else None


def _physical_key_for_revision(source_bundle, output_key, revision):
    mapping = ((source_bundle or {}).get("_wfd_row_versions") or {}).get(output_key, {})
    revision_id = (revision or {}).get("revision_id")
    for physical, version in mapping.items():
        if version.get("revision_id") == revision_id:
            return physical
    return (revision or {}).get("logical_key")


def _sanitize_rows(rows, fields=None, key_field="business_key"):
    cleaned, found = [], []
    for row in rows:
        item = _clean_paths(copy.deepcopy(row), [], found)
        if fields is not None:
            values = item.get("values") or {}
            missing = [code for code in fields if code not in values]
            if missing:
                raise ValueError("BUNDLE_SELECTED_FIELD_MISSING:" + ",".join(sorted(missing)))
            item["values"] = {code: values[code] for code in fields}
        cleaned.append(item)
    return cleaned, found


class _Node:
    __slots__ = ("service", "dataset_id", "snapshot_id", "product_id", "role",
                 "required", "fields", "subject", "business_range", "rows",
                 "source_entry", "source_product", "source_binding",
                 "target_product_id", "target_product", "target_fields",
                 "row_versions", "row_public_times", "_file_relpath",
                 "_file_bytes", "_file_digest", "_output_key", "_target_rows",
                 "_target_versions", "_target_times", "sanitized_paths")

    def __init__(self, *, service, dataset_id, snapshot_id, product_id, role,
                 required=True, fields=None, subject=None, business_range=None):
        self.service = service
        self.dataset_id = dataset_id
        self.snapshot_id = snapshot_id
        self.product_id = product_id
        self.role = role
        self.required = required
        self.fields = fields
        self.subject = subject
        self.business_range = business_range
        self.rows = []
        self.source_entry = None
        self.source_product = None
        self.source_binding = None
        self.target_product_id = None
        self.target_product = None
        self.target_fields = None
        self.row_versions = {}
        self.row_public_times = {}
        self.sanitized_paths = []

    @property
    def identity(self):
        return (self.dataset_id, self.snapshot_id, self.product_id)


def _bundle_snapshot(engine, snapshot_id):
    snapshot = engine.read_snapshot(snapshot_id)
    reject_unsupported(snapshot, "bundle")
    return snapshot


def _dataset_id(service):
    path = Path(service.root) / "catalog/product_service/dataset.json"
    if not path.is_file():
        raise ValueError("BUNDLE_DATASET_IDENTITY_MISSING")
    return _json(path)["dataset_id"]


def _source_product(service, snapshot_id, product_id):
    try:
        snapshot = _bundle_snapshot(service.engine, snapshot_id)
    except (ValueError, OSError) as exc:
        raise ValueError("BUNDLE_SOURCE_SNAPSHOT_UNAVAILABLE:" + snapshot_id) from exc
    entries = [entry for entry in snapshot["files"] if entry.get("product_id") == product_id]
    if not entries:
        raise ValueError("BUNDLE_READ_DEPENDENCY_MISSING:" + snapshot_id + ":" + product_id)
    bindings = [_entry_binding(entry) for entry in entries]
    products = [copy.deepcopy(binding["product"]) for binding in bindings]
    versions = {sha(canonical(product)) for product in products}
    contracts = {(product.get("contract_ref") or {}).get("digest") for product in products}
    if len(versions) != 1 or len(contracts) != 1:
        raise ValueError("BUNDLE_PRODUCT_VERSION_AMBIGUOUS:" + snapshot_id + ":" + product_id)
    entry = entries[0]
    return snapshot, entry, products[0], bindings[0]


def _declaration_fields(product):
    fields = sorted({field["field_code"] for field in
                     (product.get("declaration") or {}).get("field_definitions", [])
                     if isinstance(field, dict) and field.get("field_code")})
    if not fields and product.get("payload_kind") == "scalar_rows":
        return ["value_decimal"]
    return fields


def _read_dependencies(product):
    return copy.deepcopy(((product.get("contracts") or {}).get("read") or {}).get("dependencies") or [])


def _other_dependencies(product):
    dependencies = []
    contracts = product.get("contracts") or {}
    for key in ("compute_dependencies", "regenerate_dependencies", "audit_dependencies"):
        part = contracts.get(key)
        if not isinstance(part, dict):
            continue
        dep_type = {"compute_dependencies": "compute",
                    "regenerate_dependencies": "regenerate",
                    "audit_dependencies": "audit"}[key]
        for dep in part.get("dependencies", []) or []:
            if isinstance(dep, dict):
                dependencies.append({"dependency_type": dep_type, **copy.deepcopy(dep)})
    return dependencies


def _limits(value):
    result = dict(_DEFAULT_LIMITS)
    if isinstance(value, dict):
        result.update({key: value[key] for key in _DEFAULT_LIMITS if key in value})
    for key in ("max_scan_bytes", "max_nodes", "page_size", "max_pages"):
        if not isinstance(result[key], int) or result[key] <= 0:
            raise ValueError("BUNDLE_READ_LIMIT_INVALID:" + key)
    result["page_size"] = min(result["page_size"], _MAX_PAGE)
    return result


def _normalize_selection(selection, product_ids):
    if selection is None:
        return {"products": [{"product_id": pid} for pid in sorted(set(product_ids))],
                "evidence": {"mode": "if_licensed", "require_original": False}}
    if not isinstance(selection, dict) or set(selection) - {"products", "evidence", "at"}:
        raise ValueError("BUNDLE_SELECTION_INVALID")
    raw = selection.get("products")
    if isinstance(raw, dict):
        raw = [{"product_id": key, **value} for key, value in raw.items()]
    if not isinstance(raw, list) or not raw:
        raise ValueError("BUNDLE_SELECTION_EMPTY")
    products = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("BUNDLE_SELECTION_INVALID")
        product_id = item.get("product_id")
        if not isinstance(product_id, str) or not product_id:
            raise ValueError("BUNDLE_SELECTION_INVALID")
        allowed = {"product_id", "fields", "subject", "business_time_range"}
        if set(item) - allowed:
            raise ValueError("BUNDLE_SELECTION_INVALID")
        fields = item.get("fields")
        if fields is not None:
            if (not isinstance(fields, list) or not fields
                    or any(not isinstance(field, str) or not field for field in fields)
                    or len(set(fields)) != len(fields)):
                raise ValueError("BUNDLE_FIELD_SELECTION_INVALID")
            fields = sorted(fields)
        subject = item.get("subject")
        if subject is not None and (not isinstance(subject, dict)
                                    or set(subject) != {"kind", "namespace", "id"}):
            raise ValueError("BUNDLE_SUBJECT_INVALID")
        products.append({"product_id": product_id, "fields": fields,
                         "subject": copy.deepcopy(subject),
                         "business_time_range": copy.deepcopy(item.get("business_time_range"))})
    if len({item["product_id"] for item in products}) != len(products):
        raise ValueError("BUNDLE_SELECTION_DUPLICATE_PRODUCT")
    products.sort(key=lambda item: item["product_id"])
    if product_ids and {item["product_id"] for item in products} != set(product_ids):
        raise ValueError("BUNDLE_SELECTION_PRODUCT_MISMATCH")
    evidence = selection.get("evidence", {"mode": "if_licensed", "require_original": False})
    if not isinstance(evidence, dict) or set(evidence) - {"mode", "require_original"}:
        raise ValueError("BUNDLE_EVIDENCE_SELECTION_INVALID")
    mode = evidence.get("mode", "if_licensed")
    if mode not in {"if_licensed", "reference_only", "required"}:
        raise ValueError("BUNDLE_EVIDENCE_SELECTION_INVALID")
    return {"products": products,
            "at": copy.deepcopy(selection.get("at")),
            "evidence": {"mode": mode,
                         "require_original": bool(evidence.get("require_original", mode == "required"))}}


def _query_request(dataset_id, snapshot_id, product_id, fields, subject,
                   business_range, perspective, at, limits):
    request = {
        "protocol_version": "wfd.read/1.3-product1",
        "dataset_id": dataset_id,
        "operation": "read_product",
        "snapshot_id": snapshot_id,
        "history_mode": perspective,
        "knowledge_cutoff": copy.deepcopy(at) if perspective != "snapshot_contents" else None,
        "held_scope": None,
        "usable_stage": None,
        "subject": copy.deepcopy(subject),
        "max_nodes": limits["max_nodes"],
        "product_id": product_id,
        "fields": list(fields),
        "business_time_range": copy.deepcopy(business_range),
        "page_size": min(limits["page_size"], _MAX_PAGE),
        "max_scan_bytes": limits["max_scan_bytes"],
        "cursor": None,
    }
    return request


def _query_selected_rows(service, node, perspective, at, limits):
    """Use the public P4 query boundary, then recover full rows by record ref."""
    product = node.source_product
    declared = _declaration_fields(product)
    fields = node.fields or declared
    missing = sorted(set(fields) - set(declared))
    if missing:
        raise ValueError("BUNDLE_FIELD_NOT_DECLARED:" + ",".join(missing))
    for source_id in _output_source_ids(node.source_entry):
        if node.service.allowed_sources.get(source_id, {}).get("may_export") is not True:
            raise ValueError("BUNDLE_EXPORT_PERMISSION_MISSING:" + source_id)
    query = ProductQuery(service)
    cross_dataset = any(dep.get("dataset_id") != node.dataset_id
                        for dep in _read_dependencies(node.source_product))
    if cross_dataset:
        normalized_range = (query._business_time_range({"business_time_range": node.business_range})
                            if node.business_range is not None else None)
        service_at = at.get("earliest_utc") if isinstance(at, dict) else at
        full = service.read(node.product_id, snapshot_id=node.snapshot_id,
                            perspective=perspective, at=service_at, subject=node.subject,
                            include_history=True)["rows"]
        selected = []
        for item in full:
            row = item.get("row") or {}
            if node.subject is not None and canonical(item.get("subject")) != canonical(node.subject):
                continue
            if node.business_range is not None:
                role = normalized_range["role"] if normalized_range else "observation"
                business_time, code, _ = query._row_business_time(row, role, node.source_product)
                if code or query._time_decision(business_time, normalized_range) != "contained":
                    continue
            selected.append(item)
        if not selected and node.required:
            raise ValueError("BUNDLE_SELECTION_EMPTY:" + node.product_id)
        return selected, [], normalized_range, fields, 0
    request = _query_request(node.dataset_id, node.snapshot_id, node.product_id,
                             fields, node.subject, node.business_range,
                             perspective, at, limits)
    rows, diagnostics, normalized_range, pages = [], [], None, 0
    while True:
        try:
            result = query.execute(request)
        except ProductQueryError as exc:
            if exc.code == "DEPENDENCY_SNAPSHOT_UNAVAILABLE":
                dependency = (exc.details or {}).get("dependency") or {}
                raise ValueError("BUNDLE_SOURCE_SNAPSHOT_UNAVAILABLE:"
                                 + str(dependency.get("snapshot_id"))) from exc
            if exc.code == "DEPENDENCY_PRODUCT_UNAVAILABLE":
                dependency = (exc.details or {}).get("dependency") or {}
                raise ValueError("BUNDLE_READ_DEPENDENCY_MISSING:"
                                 + str(dependency.get("snapshot_id")) + ":"
                                 + str(dependency.get("product_id"))) from exc
            raise ValueError("BUNDLE_READ_QUERY_FAILED:" + exc.code + ":" + json.dumps(exc.details, ensure_ascii=False)[:800]) from exc
        pages += 1
        normalized_range = result.get("business_time_range") or normalized_range
        rows.extend(copy.deepcopy(result.get("rows", [])))
        diagnostics.extend(copy.deepcopy(result.get("diagnostics", [])))
        page = result.get("page") or {}
        if not page.get("has_more"):
            break
        if pages >= limits["max_pages"]:
            raise ValueError("BUNDLE_SELECTION_TOO_LARGE")
        request["cursor"] = page["next_cursor"]
    for diagnostic in diagnostics:
        code = str(diagnostic.get("code") or "")
        if (code.startswith("FIELD_") or code.startswith("BUSINESS_TIME_")
                or code.startswith("PRODUCT_") or code.startswith("READ_")):
            raise ValueError("BUNDLE_SELECTION_INCOMPLETE:" + code)
    record_refs = {(item["record_ref"]["logical_key"], item["record_ref"]["revision_id"])
                   for item in rows}
    service_at = at.get("earliest_utc") if isinstance(at, dict) else at
    full = service.read(node.product_id, snapshot_id=node.snapshot_id,
                        perspective=perspective, at=service_at, subject=node.subject,
                        include_history=True)["rows"]
    by_ref = {(item["record_ref"]["logical_key"], item["record_ref"]["revision_id"]): item
              for item in full}
    selected = []
    for key, revision in sorted(record_refs):
        item = by_ref.get((key, revision))
        if item is None:
            raise ValueError("BUNDLE_SELECTED_ROW_NOT_FOUND:" + key)
        selected.append(item)
    if not selected and node.required:
        raise ValueError("BUNDLE_SELECTION_EMPTY:" + node.product_id)
    return selected, diagnostics, normalized_range, fields, pages


def _read_dependency_rows(service, node, perspective, at):
    content_rows = service.read(node.product_id, snapshot_id=node.snapshot_id,
                                perspective="snapshot_contents", include_history=False)["rows"]
    if perspective == "snapshot_contents":
        return content_rows
    service_at = at.get("earliest_utc") if isinstance(at, dict) else at
    rows = service.read(node.product_id, snapshot_id=node.snapshot_id,
                        perspective=perspective, at=service_at, include_history=False)["rows"]
    if not rows and content_rows and _time_bearing([item["row"] for item in content_rows]):
        raise ValueError("BUNDLE_PIT_DEPENDENCY_NOT_ELIGIBLE:"
                         + node.dataset_id + ":" + node.snapshot_id + ":" + node.product_id)
    return rows


def _target_product_id(source_product, fields, selection_digest):
    declared = _declaration_fields(source_product)
    if sorted(fields or declared) == declared:
        return source_product["product_id"]
    return "p_" + sha(canonical(["wfd.bundle-field-selection", source_product["product_id"],
                                 sorted(fields), selection_digest]))[:24]


def _rewrite_dependency(dep, node, target_sid):
    return {
        "dataset_id": dep["dataset_id"],
        "product_id": node.target_product_id,
        "snapshot_id": target_sid,
        "role": dep.get("role") or node.role,
        "required": True,
        "dependency_type": "read",
    }


def _source_closure_core(nodes):
    return [{
        "dataset_id": node.dataset_id,
        "snapshot_id": node.snapshot_id,
        "product_id": node.product_id,
        "role": node.role,
        "required": bool(node.required),
        "source_contract_digest": node.source_product.get("contract_ref", {}).get("digest"),
        "source_definition_digest": node.source_product.get("definition_ref", {}).get("digest"),
    } for node in nodes]


def _normalized_selection_digest(selection_core, nodes):
    closure = [{
        "dataset_id": node.dataset_id,
        "product_id": node.product_id,
        "role": node.role,
        "required": bool(node.required),
        "source_contract_digest": node.source_product.get("contract_ref", {}).get("digest"),
        "source_definition_digest": node.source_product.get("definition_ref", {}).get("digest"),
    } for node in nodes]
    return "sha256:" + sha(canonical({"selection": selection_core, "closure": closure}))


def _selection_core(nodes, perspective, at, evidence):
    selected = sorted((node for node in nodes if node.role == "selected"),
                      key=lambda node: node.product_id)
    return {
        "format_version": SELECTION_FORMAT,
        "perspective": perspective,
        "at": copy.deepcopy(at),
        "products": [{
            "product_id": node.product_id,
            "fields": sorted(node.fields or _declaration_fields(node.source_product)),
            "subject": copy.deepcopy(node.subject),
            "business_time_range": copy.deepcopy(node.business_range),
        } for node in selected],
        "evidence": copy.deepcopy(evidence),
    }


def _target_contracts(source_product, target_fields, target_pid, target_sid,
                      node_by_identity, selection_digest, source_identity,
                      dependency_nodes):
    contracts = copy.deepcopy(source_product.get("contracts") or {})
    semantic = contracts.setdefault("semantic", {})
    declaration = copy.deepcopy(source_product.get("declaration") or {})
    field_defs = [copy.deepcopy(field) for field in declaration.get("field_definitions", [])
                  if field.get("field_code") in target_fields]
    field_defs.sort(key=lambda field: field["field_code"])
    declaration["field_definitions"] = field_defs
    semantic["fields"] = copy.deepcopy(field_defs)
    used_units = sorted({field.get("unit_code") for field in field_defs
                         if field.get("unit_code") and field.get("unit_code") != "not_applicable"})
    definitions = copy.deepcopy(semantic.get("unit_definitions") or {})
    if field_defs or source_product.get("payload_kind") != "scalar_rows":
        semantic["unit_definitions"] = {code: definitions[code] for code in used_units if code in definitions}
    read = contracts.setdefault("read", {})
    rewritten = []
    for dep in read.get("dependencies", []) or []:
        if dep.get("required") is not True:
            continue
        identity = (dep.get("dataset_id"), dep.get("snapshot_id"), dep.get("product_id"))
        target_node = node_by_identity.get(identity)
        if target_node is None:
            raise ValueError("BUNDLE_READ_DEPENDENCY_MISSING:"
                             + ":".join(str(part) for part in identity))
        rewritten.append(_rewrite_dependency(dep, target_node, target_sid))
    read["dependencies"] = sorted(rewritten, key=lambda item: canonical(item))
    compute = contracts.get("compute_dependencies")
    if isinstance(compute, dict):
        compute["bundle_status"] = "external_not_self_contained"
    for key, value in (("regenerate_dependencies", "regenerate"),
                       ("audit_dependencies", "audit")):
        part = contracts.get(key)
        if isinstance(part, dict):
            part["bundle_status"] = "not_self_contained" if value == "regenerate" else "requires_carried_evidence"
    contracts["bundle_selection"] = {
        "selection_digest": selection_digest,
        "perspective": source_identity.get("perspective"),
        "at": copy.deepcopy(source_identity.get("at")),
        "source": copy.deepcopy(source_identity.get("source")),
        "role": source_identity.get("role"),
        "carried_dependencies": [
            {"dependency_type": dep.get("dependency_type", "read"),
             **{key: dep[key] for key in ("dataset_id", "snapshot_id", "product_id", "role", "required")}}
            for dep in dependency_nodes
        ],
    }
    parts = {}
    for key in ("semantic", "read", "compute_dependencies", "publication"):
        if key in contracts:
            parts[key] = "sha256:" + sha(canonical(contracts[key]))
    contracts["part_digests"] = parts
    digest = sha(canonical(contracts))
    ref = {"kind": "contract", "dataset_id": source_product["dataset_id"],
           "namespace": "wfd.product", "id": "contract_" + digest[:24],
           "version": "v_" + digest[:16], "digest": "sha256:" + digest,
           "resolution": "pinned", "required": True, "dependency_type": "read"}
    return contracts, ref, declaration


def _target_product(service, node, target_fields, target_sid, target_pid,
                    node_by_identity, selection_digest, source_identity):
    source = node.source_product
    declared = _declaration_fields(source)
    contracts, contract_ref, declaration = _target_contracts(
        source, target_fields, target_pid, target_sid, node_by_identity,
        selection_digest, source_identity, _dependency_nodes_for(source, node_by_identity))
    found_paths = []
    contracts = _clean_paths(contracts, [], found_paths)
    declaration = _clean_paths(declaration, [], found_paths)
    node.sanitized_paths.extend(found_paths)
    if sorted(target_fields) != declared:
        declaration["bundle_derivative"] = {
            "source_dataset_id": source["dataset_id"],
            "source_snapshot_id": node.snapshot_id,
            "source_product_id": source["product_id"],
            "selected_fields": sorted(target_fields),
            "selection_digest": selection_digest,
            "note": "physically narrower field set; not a source official product receipt",
        }
    definition_digest = sha(canonical(declaration))
    definition_ref = {
        "kind": "definition_version", "dataset_id": source["dataset_id"],
        "namespace": "wfd.product", "id": "def_" + definition_digest[:24],
        "version": "v_" + definition_digest[:16],
        "digest": "sha256:" + definition_digest, "resolution": "pinned",
        "required": True, "dependency_type": "read",
    }
    contracts["semantic"]["definition_ref"] = copy.deepcopy(definition_ref)
    # Recompute after the definition ref is finalised.
    contracts["part_digests"] = {
        key: "sha256:" + sha(canonical(contracts[key]))
        for key in ("semantic", "read", "compute_dependencies", "publication")
        if key in contracts
    }
    contract_digest = sha(canonical(contracts))
    contract_ref = {
        "kind": "contract", "dataset_id": source["dataset_id"],
        "namespace": "wfd.product", "id": "contract_" + contract_digest[:24],
        "version": "v_" + contract_digest[:16],
        "digest": "sha256:" + contract_digest, "resolution": "pinned",
        "required": True, "dependency_type": "read",
    }
    coverage = copy.deepcopy(source.get("coverage") or {})
    coverage["bundle_selection"] = {
        "source_snapshot_id": node.snapshot_id,
        "source_product_id": source["product_id"],
        "target_product_id": target_pid,
        "selection_digest": selection_digest,
        "subject": copy.deepcopy(node.subject),
        "business_time_range": copy.deepcopy(node.business_range),
        "fields": sorted(target_fields),
        "row_count": len(node.rows),
        "perspective": source_identity.get("perspective"),
        "at": copy.deepcopy(source_identity.get("at")),
        "role": source_identity.get("role"),
    }
    coverage_ref = "sha256:" + sha(canonical(coverage))
    record = copy.deepcopy(source)
    record = _clean_paths(record, [], [])
    record.update({
        "service_version": TARGET_FORMAT,
        "product_id": target_pid,
        "dataset_id": source["dataset_id"],
        "declaration": declaration,
        "definition_ref": definition_ref,
        "contracts": contracts,
        "contract_ref": contract_ref,
        "coverage": coverage,
        "coverage_ref": coverage_ref,
        "coverage_predecessor_ref": source.get("coverage_ref"),
        "definition_parent_ref": (source.get("definition_ref")
                                  if sorted(target_fields) != declared else source.get("definition_parent_ref")),
        "definition_compatibility": ("breaking" if sorted(target_fields) != declared
                                     else source.get("definition_compatibility", "initial")),
        "definition_sequence": (1 if sorted(target_fields) != declared
                                else source.get("definition_sequence", 1)),
        "product_family_id": ("pf_" + sha(canonical(["wfd.bundle-family",
                                                     source.get("product_family_id"),
                                                     sorted(target_fields)]))[:24]
                              if sorted(target_fields) != declared
                              else source.get("product_family_id")),
        "bundle_target": {
            "format_version": TARGET_FORMAT,
            "target_snapshot_id": target_sid,
            "source_dataset_id": node.dataset_id,
            "source_snapshot_id": node.snapshot_id,
            "source_product_id": source["product_id"],
            "selection_digest": selection_digest,
            "official_source_product": False,
        },
    })
    # The 2026-10-28 four-contract-ref core is being changed in parallel.
    # This batch deliberately emits the old body/contract_ref compatibility path.
    record.pop("contract_refs", None)
    record.pop("contract_bundle_ref", None)
    return record


def _dependency_nodes_for(source, node_by_identity):
    result = []
    for dep in _read_dependencies(source):
        if dep.get("required") is not True:
            continue
        identity = (dep.get("dataset_id"), dep.get("snapshot_id"), dep.get("product_id"))
        target_node = node_by_identity.get(identity)
        if target_node is not None:
            result.append({"dependency_type": "read",
                           "dataset_id": dep["dataset_id"],
                           "snapshot_id": dep["snapshot_id"],
                           "product_id": dep["product_id"],
                           "role": dep.get("role"),
                           "required": True})
    for dep in _other_dependencies(source):
        result.append({"dependency_type": dep.get("dependency_type"),
                       "dataset_id": dep.get("dataset_id"),
                       "snapshot_id": dep.get("snapshot_id"),
                       "product_id": dep.get("product_id"),
                       "role": dep.get("role"),
                       "required": dep.get("required")})
    return result


def _source_bundle_for_entry(entry, source_product, target_product, target_rows,
                             target_versions, target_public_times, dependencies,
                             sources, evidence_carried, selection_digest, output_key):
    bundle = copy.deepcopy(entry.get("source_bundle") or {})
    admission_sources = list((_entry_binding(entry).get("source_admission") or {}).get("source_ids") or [])
    source_ids = list(dict.fromkeys(admission_sources)) or list(dict.fromkeys(
        list(bundle.get("source_ids") or [])
        + ([bundle["source_id"]] if bundle.get("source_id") else [])))
    source_ids = [sid for sid in source_ids if sid in sources]
    if not source_ids:
        raise ValueError("BUNDLE_SOURCE_ID_MISSING")
    admission = copy.deepcopy(_entry_binding(entry).get("source_admission") or {})
    roles = copy.deepcopy(admission.get("roles") or bundle.get("source_roles", {}).get(output_key, []))
    if isinstance(roles, dict):
        roles = [{"source_id": sid, "roles": value} for sid, value in roles.items()]
    roles = [{"source_id": item["source_id"], "roles": list(item["roles"])}
             for item in roles if item.get("source_id") in source_ids]
    if not roles:
        roles = [{"source_id": source_ids[0], "roles": ["deliverer"]}]
    public_times = {}
    for physical, version in target_versions.items():
        value = target_public_times.get(physical)
        if _known_time(value):
            public_times[version["logical_key"]] = copy.deepcopy(value)
            public_times[physical] = copy.deepcopy(value)
    binding = {
        "product": target_product,
        "source_role_mode": admission.get("source_role_mode", "explicit"),
        "source_admission": {
            "source_ids": source_ids,
            "roles": {item["source_id"]: list(item["roles"]) for item in roles},
            "definition_authority": target_product.get("declaration", {}).get("definition_authority"),
        },
    }
    clean = {
        "source_id": source_ids[0] if len(source_ids) == 1 else source_ids[0],
        "source_ids": source_ids,
        "source_roles": {output_key: roles},
        "license": "per_source_declared",
        "usage_scope": "bundle_local_use",
        "public_time": copy.deepcopy(UNKNOWN_TIME),
        "row_public_times": {output_key: public_times},
        "product_service": {
            "version": "wfd.product-service/0.3",
            "outputs": {output_key: {"read_dependencies": copy.deepcopy(dependencies)}},
            "consistency_groups": {},
        },
        "_wfd_product_bindings": {output_key: binding},
        "_wfd_resolved_product_ids": {output_key: target_product["product_id"]},
        "_wfd_received_time": copy.deepcopy(UNKNOWN_TIME),
        "_wfd_service_version": TARGET_FORMAT,
        "_wfd_row_versions": {output_key: copy.deepcopy(target_versions)},
        "_wfd_source_admission": {
            sid: {"source_ids": [sid], "roles": roles}
            for sid in source_ids
        },
        "raw_source_bytes_custodied": bool(evidence_carried),
    }
    if "evidence_refs" in entry:
        clean["evidence_refs"] = copy.deepcopy(entry["evidence_refs"])
    return clean


def _write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical(value))


def _write_product_catalog(target_root, target_product, source_service):
    pid = target_product["product_id"]
    definition = {"definition_ref": target_product["definition_ref"],
                  "declaration": target_product["declaration"]}
    contract = {"contract_ref": target_product["contract_ref"],
                "contracts": target_product["contracts"]}
    definition_digest = target_product["definition_ref"]["digest"].removeprefix("sha256:")
    contract_digest = target_product["contract_ref"]["digest"].removeprefix("sha256:")
    _write_json(target_root / f"catalog/product_service/definitions/{definition_digest}.json", definition)
    _write_json(target_root / f"catalog/product_service/contracts/{contract_digest}.json", contract)
    registration = copy.deepcopy(target_product)
    _write_json(target_root / f"catalog/product_service/products/{pid}.json", registration)
    _write_json(target_root / f"catalog/product_service/products/{pid}/definition_1.json", registration)


def _write_evidence(target_root, source_root, digest, carry, custody):
    if not carry:
        return
    source = Path(source_root) / f"evidence/sha256/{digest}"
    if not source.is_file():
        raise ValueError("BUNDLE_EVIDENCE_MISSING:" + digest)
    raw = source.read_bytes()
    if sha(raw) != digest:
        raise ValueError("BUNDLE_EVIDENCE_MISMATCH:" + digest)
    (Path(target_root) / f"evidence/sha256/{digest}").parent.mkdir(parents=True, exist_ok=True)
    (Path(target_root) / f"evidence/sha256/{digest}").write_bytes(raw)
    if custody is not None:
        _write_json(Path(target_root) / f"catalog/product_service/evidence/{digest}.json", custody)


def _write_target_snapshot(target_root, target_sid, entries, metadata_versions,
                           selection_digest, logical_state_digest, source_snapshot_id,
                           source_dataset_id, selected_product_ids, target_receipt,
                           parent_snapshot_id=None):
    manifest = {"parent_snapshot_id": parent_snapshot_id, "files": entries}
    mraw = canonical(manifest)
    mhash = sha(mraw)
    mrel = f"catalog/manifests/manifest_{mhash[:24]}.json"
    (Path(target_root) / mrel).parent.mkdir(parents=True, exist_ok=True)
    (Path(target_root) / mrel).write_bytes(mraw)
    receipt = {
        "status": "bundle_target_sealed",
        "format_version": TARGET_FORMAT,
        "snapshot_id": target_sid,
        "source_dataset_id": source_dataset_id,
        "source_snapshot_id": source_snapshot_id,
        "selected_product_ids": selected_product_ids,
        "selection_digest": selection_digest,
        "logical_state_digest": logical_state_digest,
        "formal_source_receipt": False,
        "official_source_product": False,
        "production_publishable": False,
        "write_authority_granted": False,
        "target_receipt": copy.deepcopy(target_receipt),
        "parent_snapshot_id": parent_snapshot_id,
    }
    snap = {
        "snapshot_id": target_sid,
        "parent_snapshot_id": parent_snapshot_id,
        "manifest_relpath": mrel,
        "manifest_sha256": mhash,
        "files": entries,
        "metadata_versions": copy.deepcopy(metadata_versions),
        "request_key": "bundle_" + selection_digest.removeprefix("sha256:")[:24],
        "request_fingerprint": logical_state_digest,
        "receipt": receipt,
    }
    sraw = canonical(snap)
    srel = f"catalog/snapshots/{target_sid}.json"
    (Path(target_root) / srel).parent.mkdir(parents=True, exist_ok=True)
    (Path(target_root) / srel).write_bytes(sraw)
    craw = canonical({"snapshot_id": target_sid, "snapshot_file": srel,
                      "snapshot_sha256": sha(sraw)})
    (Path(target_root) / f"catalog/commits/{target_sid}.json").write_bytes(craw)
    Lineage(Path(target_root)).ensure(target_sid)
    return snap


def _target_receipt(target_sid, selection_digest, logical_state_digest, source,
                    normalized_selection_digest=None):
    return {
        "format_version": TARGET_FORMAT,
        "snapshot_id": target_sid,
        "selection_digest": selection_digest,
        "normalized_selection_digest": normalized_selection_digest,
        "logical_state_digest": logical_state_digest,
        "source": copy.deepcopy(source),
        "not_source_formal_receipt": True,
        "active_head": None,
        "write_authority_granted": False,
    }


def _protection_write(service, bundle_id, snapshot_id, files, state):
    root = Path(service.root)
    record = {
        "format_version": "wfd.bundle-ref/1.0",
        "bundle_id": bundle_id,
        "kind": "reference" if state != "complete" else "complete",
        "state": state,
        "source_snapshot_id": snapshot_id,
        "created_at_utc": _now(),
        "files": files,
    }
    path = root / f"catalog/bundles/{bundle_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical(record))
    return path


def _source_files_for_protection(nodes):
    result = []
    seen = set()
    for node in nodes:
        for entry in _bundle_snapshot(node.service.engine, node.snapshot_id)["files"]:
            rel = entry["file_relpath"]
            if (node.service.root, rel) in seen:
                continue
            seen.add((node.service.root, rel))
            result.append({"root": str(node.service.root), "rel_path": rel,
                           "sha256": entry["file_sha256"],
                           "product_id": entry["product_id"]})
    return result


def _resolve_nodes(service, selection, snapshot_id, dataset_services, limits,
                   perspective, at):
    primary_dataset = _dataset_id(service)
    nodes, seen, optional_gaps, other_deps = [], set(), [], []

    def add_node(dataset_id, sid, pid, role, required, fields, subject, business_range):
        identity = (dataset_id, sid, pid)
        if identity in seen:
            return next(node for node in nodes if node.identity == identity)
        if dataset_id == primary_dataset:
            svc = service
        else:
            svc = (dataset_services or {}).get(dataset_id)
            if svc is None:
                raise ValueError("BUNDLE_DATASET_SERVICE_MISSING:" + str(dataset_id))
            if Path(svc.root).resolve() == Path(service.root).resolve():
                raise ValueError("BUNDLE_DATASET_SERVICE_FALLBACK_FORBIDDEN:" + str(dataset_id))
            if _dataset_id(svc) != dataset_id:
                raise ValueError("BUNDLE_DATASET_SERVICE_MISMATCH:" + str(dataset_id))
        snapshot, entry, product, binding = _source_product(svc, sid, pid)
        if dataset_id != product.get("dataset_id"):
            raise ValueError("BUNDLE_DEPENDENCY_DATASET_MISMATCH:" + pid)
        node = _Node(service=svc, dataset_id=dataset_id, snapshot_id=sid,
                     product_id=pid, role=role, required=required,
                     fields=fields, subject=subject, business_range=business_range)
        node.source_entry, node.source_product, node.source_binding = entry, product, binding
        nodes.append(node)
        seen.add(identity)
        return node

    for item in selection["products"]:
        node = add_node(primary_dataset, snapshot_id, item["product_id"], "selected",
                        True, item.get("fields"), item.get("subject"),
                        item.get("business_time_range"))
        if node.role != "selected":
            node.role = "selected"
            node.fields = item.get("fields")
            node.subject = item.get("subject")
            node.business_range = item.get("business_time_range")
        node.rows, diagnostics, normalized_range, fields, pages = _query_selected_rows(
            node.service, node, perspective, at, limits)
        node.fields = fields
        node.business_range = normalized_range or node.business_range
        node.target_fields = list(fields)
        node.target_product_id = _target_product_id(
            node.source_product, fields, "PENDING")

    pending = list(nodes)
    while pending:
        node = pending.pop(0)
        for dep in _read_dependencies(node.source_product):
            if dep.get("required") is not True:
                optional_gaps.append({
                    "dataset_id": dep.get("dataset_id"),
                    "snapshot_id": dep.get("snapshot_id"),
                    "product_id": dep.get("product_id"),
                    "role": dep.get("role"),
                    "status": "not_carried_optional",
                })
                continue
            for key in ("dataset_id", "snapshot_id", "product_id"):
                if not isinstance(dep.get(key), str) or not dep.get(key):
                    raise ValueError("BUNDLE_READ_DEPENDENCY_INVALID:" + node.product_id)
            dep_node = add_node(dep["dataset_id"], dep["snapshot_id"],
                                dep["product_id"], dep.get("role") or "dependency",
                                True, None, None, None)
            if dep_node.rows == [] and dep_node.target_fields is None:
                dep_node.rows = _read_dependency_rows(dep_node.service, dep_node,
                                                      perspective, at)
                dep_node.target_fields = _declaration_fields(dep_node.source_product)
                dep_node.target_product_id = _target_product_id(
                    dep_node.source_product, dep_node.target_fields, "PENDING")
                pending.append(dep_node)
        for dep in _other_dependencies(node.source_product):
            other_deps.append({
                "from_dataset_id": node.dataset_id,
                "from_product_id": node.product_id,
                "dependency_type": dep.get("dependency_type"),
                "dataset_id": dep.get("dataset_id"),
                "snapshot_id": dep.get("snapshot_id"),
                "product_id": dep.get("product_id"),
                "required": dep.get("required"),
                "status": "external_not_self_contained",
            })
    return nodes, optional_gaps, other_deps


def _build_target(service, nodes, selection, perspective, at, evidence_selection,
                  target_salt=None):
    closure = _source_closure_core(nodes)
    selection_core = _selection_core(nodes, perspective, at, evidence_selection)
    selection_digest = "sha256:" + sha(canonical({"selection": selection_core,
                                                   "closure": closure}))
    target_body = [TARGET_FORMAT, selection_digest]
    if target_salt:
        target_body.append(target_salt)
    target_sid = "s_" + sha(canonical(target_body))[:24]
    for node in nodes:
        node.target_product_id = _target_product_id(
            node.source_product, node.fields or _declaration_fields(node.source_product),
            selection_digest)
        node.target_fields = sorted(node.fields or _declaration_fields(node.source_product))
    by_identity = {node.identity: node for node in nodes}
    source_identity = {"perspective": perspective, "at": at,
                       "source": {"dataset_id": _dataset_id(service),
                                  "snapshot_id": nodes[0].snapshot_id if nodes else None}}
    for node in nodes:
        source_identity = {
            "perspective": perspective,
            "at": copy.deepcopy(at),
            "source": {"dataset_id": node.dataset_id,
                       "snapshot_id": node.snapshot_id,
                       "product_id": node.product_id},
            "role": node.role,
        }
        node.target_product = _target_product(
            node.service, node, node.target_fields, target_sid,
            node.target_product_id, by_identity, selection_digest, source_identity)
    return selection_core, selection_digest, target_sid, by_identity


def _build_rows_and_entries(service, nodes, target_sid, by_identity,
                            evidence_selection, selection_digest, perspective):
    entries, included_reads, logical_products = [], [], []
    evidence_records, evidence_refs, permissions = {}, {}, {}
    for node in sorted(nodes, key=lambda item: (item.role != "selected",
                                                item.dataset_id, item.product_id)):
        product = node.target_product
        output_key = node.source_entry["output_key"]
        used = {entry["output_key"] for entry in entries}
        if output_key in used:
            output_key = output_key + "@" + product["product_id"]
        key_field = "event_id" if node.source_entry["payload_kind"] == "event_records" else "business_key"
        target_rows, target_versions, target_times = [], {}, {}
        fields = sorted(node.target_fields)
        for item in node.rows:
            source_row = item["row"] if isinstance(item, dict) and "row" in item else item
            revision = copy.deepcopy(item.get("revision") or {})
            if not revision.get("revision_id"):
                revision = _version_for_row(source_row, node.source_entry["payload_kind"],
                                            node.source_entry.get("source_bundle"),
                                            node.source_entry["output_key"],
                                            node.product_id, node.snapshot_id)
            physical_source = _physical_key_for_revision(
                node.source_entry.get("source_bundle"), node.source_entry["output_key"], revision)
            row = copy.deepcopy(source_row)
            row[key_field] = _target_physical_key(revision)
            if node.source_entry["payload_kind"] == "scalar_rows":
                if sorted(fields) != ["value_decimal"]:
                    raise ValueError("BUNDLE_FIELD_SELECTION_INVALID")
            else:
                values = row.get("values") or {}
                missing = [code for code in fields if code not in values]
                if missing:
                    raise ValueError("BUNDLE_SELECTED_FIELD_MISSING:" + ",".join(sorted(missing)))
                row["values"] = {code: values[code] for code in fields}
            cleaned, found = _sanitize_rows([row], fields=None, key_field=key_field)
            node.sanitized_paths.extend(found)
            row = cleaned[0]
            target_rows.append(row)
            target_versions[row[key_field]] = revision
            original_time = _source_time_for_row(node.source_entry.get("source_bundle"),
                                                 node.source_entry["output_key"],
                                                 physical_source)
            if original_time is not None:
                target_times[row[key_field]] = original_time
        if not target_rows:
            raise ValueError("BUNDLE_PRODUCT_EMPTY:" + product["product_id"])
        target_rows.sort(key=lambda row: (str(row.get(key_field) or ""),
                                          str((target_versions.get(row.get(key_field)) or {}).get("revision_id") or "")))
        target_versions = {row[key_field]: target_versions[row[key_field]] for row in target_rows}
        raw = parquet_from_rows(product["product_id"], output_key, product["subject"],
                                node.source_entry["payload_kind"], target_rows)
        digest = sha(raw)
        rel = f"{product['logical_domain']}/product={product['product_id']}/part-{digest[:24]}.parquet"
        domain = product["logical_domain"]
        if domain not in {"foundation", "observations", "events"}:
            raise ValueError("BUNDLE_LOGICAL_DOMAIN_INVALID:" + str(domain))
        # The final file is written into the temporary target store by the caller;
        # carry the bytes on the node for that write.
        node._file_relpath = rel  # type: ignore[attr-defined]
        node._file_bytes = raw  # type: ignore[attr-defined]
        node._file_digest = digest  # type: ignore[attr-defined]
        node._output_key = output_key  # type: ignore[attr-defined]
        node._target_rows = target_rows  # type: ignore[attr-defined]
        node._target_versions = target_versions  # type: ignore[attr-defined]
        node._target_times = target_times  # type: ignore[attr-defined]
        dependencies = [_rewrite_dependency(dep, by_identity[(dep["dataset_id"], dep["snapshot_id"], dep["product_id"])], target_sid)
                        for dep in _read_dependencies(node.source_product)
                        if dep.get("required") is True]
        dependencies = sorted(dependencies, key=lambda item: canonical(item))
        source_ids = _output_source_ids(node.source_entry)
        for sid in source_ids:
            policy = node.service.allowed_sources.get(sid, {})
            if policy.get("may_export") is not True:
                raise ValueError("BUNDLE_EXPORT_PERMISSION_MISSING:" + str(sid))
            if policy.get("may_export_evidence") is not True and evidence_selection["mode"] == "required":
                raise ValueError("BUNDLE_EXPORT_EVIDENCE_PERMISSION_MISSING:" + str(sid))
            permissions[sid] = {
                "source_id": sid,
                "dataset_id": node.dataset_id,
                "export_scope": policy.get("export_scope"),
                "may_export_evidence": policy.get("may_export_evidence") is True,
                "redistribution_granted": policy.get("may_redistribute") is True,
                "usage_scope": policy.get("usage_scope"),
                "policy_source": "operator_trusted",
            }
        carried = False
        for ref in node.source_entry.get("evidence_refs", []):
            ref_digest = (ref.get("content_sha256") or "").removeprefix("sha256:")
            if len(ref_digest) != 64:
                raise ValueError("BUNDLE_EVIDENCE_DIGEST_REQUIRED")
            status = "referenced_only"
            carry = False
            reason = None
            if perspective == "market_known_at":
                reason = "STRICT_PIT_RAW_ORIGINAL_MAY_CONTAIN_FUTURE_CONTENT"
                if evidence_selection["require_original"]:
                    raise ValueError("BUNDLE_PIT_ORIGINAL_REQUIRED:" + ref_digest)
            elif evidence_selection["require_original"]:
                if not all(node.service.allowed_sources.get(sid, {}).get("may_export_evidence") is True
                           for sid in source_ids):
                    raise ValueError("BUNDLE_EXPORT_EVIDENCE_PERMISSION_MISSING:" + ref_digest)
                carry = True
            elif evidence_selection["mode"] == "reference_only":
                reason = "OPERATOR_REQUESTED_REFERENCE_ONLY"
            elif all(node.service.allowed_sources.get(sid, {}).get("may_export_evidence") is True
                     for sid in source_ids):
                carry = True
            else:
                reason = "SOURCE_EVIDENCE_EXPORT_NOT_GRANTED"
            if carry:
                path = Path(node.service.root) / f"evidence/sha256/{ref_digest}"
                if not path.is_file():
                    raise ValueError("BUNDLE_EVIDENCE_MISSING:" + ref_digest)
                status = "carried"
                carried = True
            evidence_refs.setdefault(ref_digest, {
                "digest": ref_digest,
                "status": status,
                "carried": carry,
                "reason": reason,
                "source_ids": source_ids,
                "_source_root": str(node.service.root),
            })
        source_bundle = _source_bundle_for_entry(
            node.source_entry, node.source_product, product, target_rows,
            target_versions, target_times, dependencies, permissions,
            carried, selection_digest, output_key)
        clean_bundle = _clean_paths(source_bundle, [], [])
        clean_evidence_refs = _clean_paths(
            copy.deepcopy(node.source_entry.get("evidence_refs", [])), [], [])
        entry = {
            "product_id": product["product_id"],
            "output_key": output_key,
            "file_relpath": rel,
            "file_sha256": digest,
            "row_count": len(target_rows),
            "definition": copy.deepcopy(product["declaration"]),
            "subject": copy.deepcopy(product["subject"]),
            "source_bundle": clean_bundle,
            "evidence_refs": clean_evidence_refs,
            "input_mode": node.source_entry.get("input_mode", "partial_observation"),
            "payload_kind": node.source_entry["payload_kind"],
        }
        entries.append(entry)
        included_reads.append({
            "dataset_id": product["dataset_id"],
            "snapshot_id": target_sid,
            "product_id": product["product_id"],
            "source_dataset_id": node.dataset_id,
            "source_snapshot_id": node.snapshot_id,
            "source_product_id": node.product_id,
            "fields": fields,
            "row_count": len(target_rows),
            "rows_sha256": "sha256:" + sha(canonical(target_rows)),
            "source_role": node.role,
        })
        logical_products.append({
            "source_dataset_id": node.dataset_id,
            "source_snapshot_id": node.snapshot_id,
            "source_product_id": node.product_id,
            "target_dataset_id": product["dataset_id"],
            "target_snapshot_id": target_sid,
            "target_product_id": product["product_id"],
            "role": node.role,
            "required": bool(node.required),
            "fields": fields,
            "row_count": len(target_rows),
            "rows_sha256": "sha256:" + sha(canonical(target_rows)),
            "source_definition_digest": node.source_product.get("definition_ref", {}).get("digest"),
            "target_definition_digest": product.get("definition_ref", {}).get("digest"),
            "source_contract_digest": node.source_product.get("contract_ref", {}).get("digest"),
            "target_contract_digest": product.get("contract_ref", {}).get("digest"),
            "source_received_time": copy.deepcopy(
                (node.source_entry.get("source_bundle") or {}).get("_wfd_received_time")),
        })
    evidence = []
    for digest in sorted(evidence_refs):
        item = evidence_refs[digest]
        evidence.append({key: item[key] for key in
                         ("digest", "status", "carried", "reason", "source_ids")}
                        | {"_source_root": item["_source_root"]})
    return entries, included_reads, logical_products, evidence, permissions


def _write_target_store(temp_root, nodes, entries, target_sid, metadata_versions,
                        selection_digest, logical_state_digest, source_snapshot_id,
                        source_dataset_id, selected_product_ids, target_receipt,
                        evidence, source_service, parent_snapshot_id=None):
    protocol_root = Path(__file__).resolve().parents[1] / "protocol"
    runtime_root = Path(str(temp_root) + "_runtime")
    engine = WFDDuckDBPrototype(Path(temp_root), load_protocol_validator(protocol_root),
                                runtime_root=runtime_root, sandbox=False, writer_host=None)
    _write_json(Path(temp_root) / "catalog/product_service/dataset.json",
                {"dataset_id": nodes[0].dataset_id if nodes else None})
    if parent_snapshot_id:
        # A parent checkpoint lets export_package validate the target's lineage
        # without carrying the parent's data.  The delta package prunes this
        # baseline checkpoint so the real target keeps its own copy.
        _write_json(Path(temp_root) / f"catalog/lineage/{parent_snapshot_id}.json", {
            "format_version": "wfd.lineage/1.0",
            "snapshot_id": parent_snapshot_id,
            "parent_snapshot_id": None,
            "snapshot_sha256": None,
            "manifest_sha256": None,
            "files_root": "",
            "created_at_utc": _now(),
            "status": "active",
            "bundle_parent_checkpoint": True,
        })
    for node in nodes:
        raw = node._file_bytes  # type: ignore[attr-defined]
        rel = node._file_relpath  # type: ignore[attr-defined]
        engine._write_immutable(rel, raw)
        _write_product_catalog(temp_root, node.target_product, node.service)
    for item in evidence:
        if item["carried"]:
            digest = item["digest"]
            source_root = Path(item["_source_root"])
            custody = None
            custody_file = source_root / f"catalog/product_service/evidence/{digest}.json"
            if custody_file.is_file():
                custody = _clean_paths(_json(custody_file), [], [])
            _write_evidence(temp_root, source_root, digest, True, custody)
    snap = _write_target_snapshot(temp_root, target_sid, entries, metadata_versions,
                                  selection_digest, logical_state_digest,
                                  source_snapshot_id, source_dataset_id,
                                  selected_product_ids, target_receipt,
                                  parent_snapshot_id=parent_snapshot_id)
    return engine, snap


def _metadata_versions_for(nodes, perspective, at):
    result = []
    for node in nodes:
        snapshot = _bundle_snapshot(node.service.engine, node.snapshot_id)
        for item in snapshot.get("metadata_versions", []) or []:
            if item.get("product_id") != node.product_id:
                continue
            if perspective != "snapshot_contents":
                time = item.get("public_time") if perspective == "market_known_at" else item.get("received_time")
                if not _known_time(time):
                    continue
                if not (time["earliest_utc"] <= at < time["latest_exclusive_utc"]):
                    continue
            clean = _clean_paths(copy.deepcopy(item), [], [])
            result.append(clean)
    return result


def _logical_state(selection_core, selection_digest, nodes, logical_products,
                   evidence, other_deps, optional_gaps):
    return {
        "format_version": TARGET_FORMAT,
        "selection_digest": selection_digest,
        "selection": copy.deepcopy(selection_core),
        "products": copy.deepcopy(logical_products),
        "closure": [{
            "dataset_id": node.dataset_id,
            "snapshot_id": node.snapshot_id,
            "product_id": node.product_id,
            "role": node.role,
            "required": bool(node.required),
        } for node in nodes],
        "other_dependencies": copy.deepcopy(other_deps),
        "optional_gaps": copy.deepcopy(optional_gaps),
        "evidence": [{key: value for key, value in item.items()
                      if key != "_source_root"} for item in evidence],
    }


def export_financial_bundle(service, product_ids, destination, *, snapshot_id,
                            mode="full", perspective="snapshot_contents",
                            redistribution_requested=False, selection=None,
                            dataset_services=None, read_limits=None,
                            target_salt=None, parent_snapshot_id=None):
    """Export a precise complete package; return its serializable descriptor.

    ``selection`` supports per-product ``fields``, exact ``subject`` and
    ``business_time_range`` plus an evidence mode.  The output is a new target
    snapshot.  The source snapshot is not copied wholesale and is not reused as
    the target identity.
    """
    service.require_permission("export")
    if redistribution_requested:
        service.require_permission("redistribute")
    if mode != "full":
        raise ValueError("BUNDLE_MODE_NOT_IMPLEMENTED")
    if perspective not in {"snapshot_contents", "market_known_at"}:
        raise ValueError("BUNDLE_PERSPECTIVE_NOT_IMPLEMENTED")
    if perspective != "snapshot_contents" and not isinstance(selection, dict):
        raise ValueError("BUNDLE_AT_REQUIRED")
    at = None
    if perspective != "snapshot_contents":
        at = selection.get("at") if isinstance(selection, dict) else None
        if (not isinstance(at, dict) or at.get("status") != "known"
                or not at.get("earliest_utc") or not at.get("latest_exclusive_utc")):
            raise ValueError("BUNDLE_AT_REQUIRED")
    selected = sorted(set(product_ids or []))
    normalized = _normalize_selection(selection, selected)
    if not normalized["products"]:
        raise ValueError("BUNDLE_FIXED_SELECTION_REQUIRED")
    destination = Path(destination)
    if destination.exists():
        raise ValueError("BUNDLE_DESTINATION_EXISTS")
    if destination.resolve().is_relative_to(Path(service.root).resolve()):
        raise ValueError("BUNDLE_DESTINATION_INSIDE_SOURCE")
    limits = _limits(read_limits)
    for item in normalized["products"]:
        _, selected_entry, _, _ = _source_product(service, snapshot_id, item["product_id"])
        for source_id in _output_source_ids(selected_entry):
            policy = service.allowed_sources.get(source_id, {})
            if policy.get("may_export") is not True:
                raise ValueError("BUNDLE_EXPORT_PERMISSION_MISSING:" + source_id)
            if redistribution_requested and policy.get("may_redistribute") is not True:
                raise ValueError("BUNDLE_REDISTRIBUTION_PERMISSION_MISSING:" + source_id)
            if policy.get("may_read") is not True:
                raise ValueError("BUNDLE_EXPORT_READ_PERMISSION_MISSING:" + source_id)
    with writer_lock(service.root):
        nodes, optional_gaps, other_deps = _resolve_nodes(
            service, normalized, snapshot_id, dataset_services, limits,
            perspective, at)
        if redistribution_requested:
            for node in nodes:
                for source_id in _output_source_ids(node.source_entry):
                    if node.service.allowed_sources.get(source_id, {}).get("may_redistribute") is not True:
                        raise ValueError("BUNDLE_REDISTRIBUTION_PERMISSION_MISSING:" + source_id)
        for node in nodes:
            if node.role == "selected":
                continue
            if node.target_fields is None:
                node.rows = _read_dependency_rows(node.service, node, perspective, at)
                node.target_fields = _declaration_fields(node.source_product)
                node.target_product_id = _target_product_id(
                    node.source_product, node.target_fields, "PENDING")
        selection_core, selection_digest, target_sid, by_identity = _build_target(
            service, nodes, normalized, perspective, at, normalized["evidence"],
            target_salt=target_salt)
        entries, included_reads, logical_products, evidence, permissions = _build_rows_and_entries(
            service, nodes, target_sid, by_identity, normalized["evidence"],
            selection_digest, perspective)
        normalized_selection_digest = _normalized_selection_digest(selection_core, nodes)
        metadata_versions = _metadata_versions_for(nodes, perspective, at)
        logical_state = _logical_state(selection_core, selection_digest, nodes,
                                       logical_products, evidence, other_deps,
                                       optional_gaps)
        logical_state_digest = "sha256:" + sha(canonical(logical_state))
        source_snapshot_id = snapshot_id
        source_dataset_id = _dataset_id(service)
        selected_product_ids = sorted(node.target_product_id for node in nodes
                                      if node.role == "selected")
        target_receipt = _target_receipt(target_sid, selection_digest,
                                         logical_state_digest,
                                         {"dataset_id": source_dataset_id,
                                          "snapshot_id": source_snapshot_id},
                                         normalized_selection_digest=normalized_selection_digest)
        bundle_id = "b_" + sha(canonical([selection_digest, target_sid]))[:24]
        protection_paths = []
        for node in nodes:
            source_files = _source_files_for_protection([node])
            for item in source_files:
                if item["root"] == str(node.service.root):
                    protection_paths.append(item)
        # One building record per source root keeps GC's existing bundle-root
        # mechanism authoritative; no parallel maintenance framework is added.
        roots = {}
        for item in protection_paths:
            roots.setdefault(item["root"], []).append(item)
        for root, items in roots.items():
            _protection_write(type("S", (), {"root": root})(), bundle_id, source_snapshot_id,
                              [{"rel_path": x["rel_path"], "sha256": x["sha256"]}
                               for x in items], "building")
        temp_parent = destination.parent
        temp_parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".wfd_bundle_target_", dir=temp_parent) as temp:
            temp_root = Path(temp) / "store"
            engine, target_snapshot = _write_target_store(
                temp_root, nodes, entries, target_sid, metadata_versions,
                selection_digest, logical_state_digest, source_snapshot_id,
                source_dataset_id, selected_product_ids, target_receipt,
                evidence, service, parent_snapshot_id=parent_snapshot_id)
            destination.mkdir(parents=True)
            storage_rel = "storage/" + target_sid
            export_package(temp_root, target_sid, destination / storage_rel)
            (destination / "objects").mkdir()
            records = _records_for_target(temp_root, nodes, evidence, destination)
            snapshot_map = [{"source_dataset_id": ds, "source_snapshot_id": sid,
                             "target_snapshot_id": target_sid}
                            for ds, sid in sorted({(item["source_dataset_id"],
                                                    item["source_snapshot_id"])
                                                   for item in logical_products})]
            descriptor = {
                "format_version": FORMAT,
                "mode": "full",
                "bundle_id": bundle_id,
                "perspective": perspective,
                "at": copy.deepcopy(at),
                "source_dataset_id": source_dataset_id,
                "source_snapshot_id": source_snapshot_id,
                "selected_product_ids": sorted(set(product_ids or [item["product_id"] for item in normalized["products"]])),
                "target_snapshot_id": target_sid,
                "target_salt": target_salt,
                "target_parent_snapshot_id": parent_snapshot_id,
                "selection": copy.deepcopy(selection_core),
                "source_closure": _source_closure_core(nodes),
                "selection_digest": selection_digest,
                "normalized_selection_digest": normalized_selection_digest,
                "logical_state": logical_state,
                "logical_state_digest": logical_state_digest,
                "source_target_map": {
                    "snapshots": snapshot_map,
                    "products": copy.deepcopy(logical_products),
                },
                "included_reads": copy.deepcopy(included_reads),
                "read_dependencies": [{
                    "dataset_id": item["target_dataset_id"],
                    "snapshot_id": item["target_snapshot_id"],
                    "product_id": item["target_product_id"],
                    "source_dataset_id": item["source_dataset_id"],
                    "source_snapshot_id": item["source_snapshot_id"],
                    "source_product_id": item["source_product_id"],
                    "role": item["role"], "required": True,
                    "dependency_type": "read",
                } for item in logical_products if item["role"] != "selected"],
                "additional_products": [{"snapshot_id": target_sid,
                                         "product_id": item["target_product_id"]}
                                        for item in logical_products
                                        if item["role"] != "selected"],
                "closure": {
                    "read": copy.deepcopy(logical_products),
                    "compute": copy.deepcopy([item for item in other_deps
                                              if item["dependency_type"] == "compute"]),
                    "regenerate": copy.deepcopy([item for item in other_deps
                                                 if item["dependency_type"] == "regenerate"]),
                    "audit": copy.deepcopy([item for item in other_deps
                                            if item["dependency_type"] == "audit"]),
                    "optional_gaps": copy.deepcopy(optional_gaps),
                },
                "evidence": [{key: value for key, value in item.items()
                              if key != "_source_root"} for item in evidence],
                "sanitized_paths": sorted({
                    canonical(item): item for node in nodes for item in node.sanitized_paths
                }.values(), key=lambda item: (item["field"], item["alias"])),
                "permissions": [permissions[key] for key in sorted(permissions)],
                "records": records,
                "storage_packages": [{"snapshot_id": target_sid, "directory": storage_rel}],
                "read_self_contained": True,
                "write_authority_granted": False,
                "not_source_formal_receipt": True,
                "target_receipt": copy.deepcopy(target_receipt),
                "protection": {"bundle_id": bundle_id, "state": "complete",
                               "source_record_count": len(roots),
                               "source_root_aliases": sorted(
                                   "wfd-root:" + sha(canonical(root))[:16] for root in roots)},
                "unsupported": ["delta", "reference_bundle", "incremental",
                                "automatic_takeover"],
            }
            (destination / "financial_bundle.json").write_bytes(canonical(descriptor))
            inventory = [{"path": p.relative_to(destination).as_posix(),
                          "sha256": sha_file(p), "size": p.stat().st_size}
                         for p in sorted(destination.rglob("*")) if p.is_file()]
            (destination / "CHECKSUMS.json").write_bytes(canonical(inventory))
            _verify_bundle(destination)
            for root, items in roots.items():
                _protection_write(type("S", (), {"root": root})(), bundle_id,
                                  source_snapshot_id,
                                  [{"rel_path": x["rel_path"], "sha256": x["sha256"]}
                                   for x in items], "complete")
            return descriptor


def _records_for_target(temp_root, nodes, evidence, destination):
    records = []
    seen = set()
    for path in sorted((Path(temp_root) / "catalog/product_service").rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(temp_root).as_posix()
        if rel in seen:
            continue
        seen.add(rel)
        raw = path.read_bytes()
        digest = sha(raw)
        target = destination / "objects" / digest
        if not target.exists():
            target = destination / "objects" / digest
            target.write_bytes(raw)
        records.append({"relative_path": rel, "sha256": digest,
                        "size": len(raw), "kind": "target_catalog"})
    for item in evidence:
        if not item.get("carried"):
            continue
        digest = item["digest"]
        path = Path(temp_root) / f"evidence/sha256/{digest}"
        if not path.is_file():
            raise ValueError("BUNDLE_EVIDENCE_MISSING:" + digest)
        raw = path.read_bytes()
        if sha(raw) != digest:
            raise ValueError("BUNDLE_EVIDENCE_MISMATCH:" + digest)
        (destination / "objects" / digest).write_bytes(raw)
        records.append({"relative_path": f"evidence/sha256/{digest}",
                        "sha256": digest, "size": len(raw), "kind": "evidence"})
    return records


def _verify_bundle_legacy(bundle):
    bundle = Path(bundle)
    inventory = _json(bundle / "CHECKSUMS.json")
    listed = set()
    for item in inventory:
        path = _path(bundle, item["path"])
        if (path.is_symlink() or not path.is_file() or path.stat().st_size != item["size"]
                or sha_file(path) != item["sha256"] or item["path"] in listed):
            raise ValueError("BUNDLE_INTEGRITY_FAILED:" + item["path"])
        listed.add(item["path"])
    actual = {p.relative_to(bundle).as_posix() for p in bundle.rglob("*") if p.is_file()}
    if actual != listed | {"CHECKSUMS.json"} or "financial_bundle.json" not in listed:
        raise ValueError("BUNDLE_INVENTORY_MISMATCH")
    descriptor = _json(bundle / "financial_bundle.json")
    if (descriptor.get("format_version") != LEGACY_FORMAT or descriptor.get("mode") != "full"
            or descriptor.get("perspective") != "snapshot_contents"):
        raise ValueError("BUNDLE_MODE_NOT_IMPLEMENTED")
    for package in descriptor["storage_packages"]:
        directory = _path(bundle, package["directory"])
        checked = verify_package(directory)
        if not checked["ok"] or checked["transfer"]["target_snapshot_id"] != package["snapshot_id"]:
            raise ValueError("BUNDLE_STORAGE_INTEGRITY_FAILED")
        for obj in checked["inventory"]["objects"]:
            for relative in obj["rel_paths"]:
                if PurePosixPath(relative).parts[0] not in {"foundation", "observations", "events"}:
                    raise ValueError("BUNDLE_DATA_PATH_INVALID")
                _path(bundle, relative)
    for record in descriptor["records"]:
        relative = record["relative_path"]
        if not relative.startswith(("catalog/product_service/", "evidence/sha256/")):
            raise ValueError("BUNDLE_RECORD_PATH_INVALID")
        _path(bundle, relative)
        path = _path(bundle, "objects/" + record["sha256"])
        if not path.is_file() or path.stat().st_size != record["size"] or sha_file(path) != record["sha256"]:
            raise ValueError("BUNDLE_DEPENDENCY_MISSING:" + relative)
    return descriptor


def _verify_bundle(bundle):
    bundle = Path(bundle)
    descriptor = _json(bundle / "financial_bundle.json")
    if descriptor.get("format_version") == LEGACY_FORMAT:
        return _verify_bundle_legacy(bundle)
    if descriptor.get("format_version") != FORMAT:
        raise ValueError("BUNDLE_FORMAT_UNSUPPORTED")
    if descriptor.get("mode") == "reference":
        return _verify_reference_bundle(bundle, descriptor)
    if descriptor.get("mode") == "delta":
        return _verify_delta_bundle(bundle, descriptor)
    inventory = _json(bundle / "CHECKSUMS.json")
    listed = set()
    for item in inventory:
        path = _path(bundle, item["path"])
        if (path.is_symlink() or not path.is_file() or path.stat().st_size != item["size"]
                or sha_file(path) != item["sha256"] or item["path"] in listed):
            raise ValueError("BUNDLE_INTEGRITY_FAILED:" + item["path"])
        listed.add(item["path"])
    actual = {p.relative_to(bundle).as_posix() for p in bundle.rglob("*") if p.is_file()}
    if actual != listed | {"CHECKSUMS.json"}:
        raise ValueError("BUNDLE_INVENTORY_MISMATCH")
    target_sid = descriptor.get("target_snapshot_id")
    if not isinstance(target_sid, str) or not target_sid.startswith("s_"):
        raise ValueError("BUNDLE_TARGET_IDENTITY_INVALID")
    computed_selection = "sha256:" + sha(canonical({
        "selection": descriptor.get("selection"),
        "closure": descriptor.get("source_closure"),
    }))
    if computed_selection != descriptor.get("selection_digest"):
        raise ValueError("BUNDLE_SELECTION_DIGEST_MISMATCH")
    target_body = [TARGET_FORMAT, descriptor["selection_digest"]]
    if descriptor.get("target_salt"):
        target_body.append(descriptor["target_salt"])
    expected_target = "s_" + sha(canonical(target_body))[:24]
    if expected_target != target_sid:
        raise ValueError("BUNDLE_TARGET_ID_MISMATCH")
    expected_logical = "sha256:" + sha(canonical(descriptor.get("logical_state")))
    if expected_logical != descriptor.get("logical_state_digest"):
        raise ValueError("BUNDLE_LOGICAL_STATE_DIGEST_MISMATCH")
    if len(descriptor.get("storage_packages", [])) != 1:
        raise ValueError("BUNDLE_STORAGE_PACKAGE_INVALID")
    package = descriptor["storage_packages"][0]
    if package.get("snapshot_id") != target_sid:
        raise ValueError("BUNDLE_STORAGE_PACKAGE_INVALID")
    directory = _path(bundle, package["directory"])
    checked = verify_package(directory)
    if not checked["ok"] or checked["transfer"]["target_snapshot_id"] != target_sid:
        raise ValueError("BUNDLE_STORAGE_INTEGRITY_FAILED")
    package_files = {}
    for obj in checked["inventory"]["objects"]:
        raw = (directory / "objects" / obj["sha256"]).read_bytes()
        for relative in obj["rel_paths"]:
            package_files[relative] = raw
    for meta in checked["inventory"]["metadata"]:
        package_files[meta["rel_path"]] = (directory / "objects" / meta["sha256"]).read_bytes()
    snapshot_rel = f"catalog/snapshots/{target_sid}.json"
    if snapshot_rel not in package_files:
        raise ValueError("BUNDLE_TARGET_SNAPSHOT_MISSING")
    try:
        snapshot = json.loads(package_files[snapshot_rel].decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValueError("BUNDLE_TARGET_SNAPSHOT_INVALID") from exc
    if snapshot.get("snapshot_id") != target_sid:
        raise ValueError("BUNDLE_TARGET_SNAPSHOT_INVALID")
    if snapshot.get("parent_snapshot_id") != descriptor.get("target_parent_snapshot_id"):
        raise ValueError("BUNDLE_TARGET_PARENT_MISMATCH")
    receipt = snapshot.get("receipt") or {}
    if receipt.get("formal_source_receipt") is not False or receipt.get("write_authority_granted") is not False:
        raise ValueError("BUNDLE_TARGET_RECEIPT_INVALID")
    expected_products = {item["target_product_id"]: item for item in
                         descriptor.get("logical_state", {}).get("products", [])}
    entries_by_product = {}
    for entry in snapshot.get("files", []):
        pid = entry.get("product_id")
        if pid not in expected_products:
            raise ValueError("BUNDLE_UNSELECTED_PRODUCT_PRESENT:" + str(pid))
        binding = entry.get("source_bundle", {}).get("_wfd_product_bindings", {}).get(entry.get("output_key"))
        if not binding or binding.get("product", {}).get("product_id") != pid:
            raise ValueError("BUNDLE_PRODUCT_BINDING_MISSING:" + str(pid))
        source_bundle = entry.get("source_bundle", {})
        only = source_bundle.get("_wfd_product_bindings") or {}
        if set(only) != {entry.get("output_key")}:
            raise ValueError("BUNDLE_SOURCE_BUNDLE_LEAK:" + str(pid))
        for key in ("source_roles", "_wfd_row_versions", "row_public_times"):
            if set(source_bundle.get(key) or {}) != {entry.get("output_key")}:
                raise ValueError("BUNDLE_SOURCE_BUNDLE_LEAK:" + str(pid))
        if set((source_bundle.get("product_service") or {}).get("outputs") or {}) != {entry.get("output_key")}:
            raise ValueError("BUNDLE_SOURCE_BUNDLE_LEAK:" + str(pid))
        row_versions = (source_bundle.get("_wfd_row_versions") or {}).get(entry.get("output_key"), {})
        raw_for_entry = package_files.get(entry.get("file_relpath"))
        if raw_for_entry is None:
            raise ValueError("BUNDLE_TARGET_FILE_MISSING:" + str(pid))
        physical_keys = {_row_key(row, entry.get("payload_kind", "tabular_rows"))
                         for row in rows_from_parquet(raw_for_entry)}
        logical_keys = {version.get("logical_key") for version in row_versions.values()}
        for physical in row_versions:
            if (physical not in (source_bundle.get("row_public_times") or {}).get(entry.get("output_key"), {})
                    and physical not in physical_keys):
                raise ValueError("BUNDLE_ROW_VERSION_LEAK:" + str(pid))
        for key in (source_bundle.get("row_public_times") or {}).get(entry.get("output_key"), {}):
            if key not in physical_keys and key not in logical_keys:
                raise ValueError("BUNDLE_ROW_TIME_LEAK:" + str(pid))
        entries_by_product[pid] = entry
    if set(entries_by_product) != set(expected_products):
        raise ValueError("BUNDLE_PRODUCT_CLOSURE_MISMATCH")
    actual_rows = {}
    for pid, entry in entries_by_product.items():
        raw = package_files.get(entry["file_relpath"])
        if raw is None:
            raise ValueError("BUNDLE_TARGET_FILE_MISSING:" + pid)
        if sha(raw) != entry["file_sha256"].split(":")[-1]:
            raise ValueError("BUNDLE_TARGET_FILE_HASH_MISMATCH:" + pid)
        rows = rows_from_parquet(raw)
        actual_rows[pid] = rows
        expected = expected_products[pid]
        if len(rows) != expected["row_count"] or "sha256:" + sha(canonical(rows)) != expected["rows_sha256"]:
            raise ValueError("BUNDLE_TARGET_ROW_MISMATCH:" + pid)
    for record in descriptor.get("records", []):
        relative = record["relative_path"]
        _path(bundle, relative)
        path = _path(bundle, "objects/" + record["sha256"])
        if not path.is_file() or path.stat().st_size != record["size"] or sha_file(path) != record["sha256"]:
            raise ValueError("BUNDLE_DEPENDENCY_MISSING:" + relative)
    for item in descriptor.get("evidence", []):
        path = _path(bundle, "objects/" + item["digest"])
        if item.get("carried"):
            if not path.is_file() or sha_file(path) != item["digest"]:
                raise ValueError("BUNDLE_EVIDENCE_MISSING:" + item["digest"])
        elif path.exists():
            raise ValueError("BUNDLE_STRICT_EVIDENCE_LEAK:" + item["digest"])
    leaked = _scan_absolute_paths(descriptor)
    if leaked:
        raise ValueError("BUNDLE_ABSOLUTE_PATH_LEAK:" + leaked[0])
    return descriptor


class BundledProductService(WFDProductService):
    """Read-only target service resolving only exact carried dependency identities."""

    def __init__(self, engine, *, allowed_sources, dependency_index,
                 dependency_datasets, caller_roles=None, caller_id="bundle-import",
                 dataset_services=None, allow_local_multi_dataset=False):
        super().__init__(engine, allowed_sources=allowed_sources, can_register=False,
                         caller_roles=caller_roles or {"read", "read_evidence"},
                         caller_id=caller_id)
        self._bundle_dependency_index = frozenset(dependency_index)
        self._bundle_dependency_datasets = frozenset(dependency_datasets)
        self._bundle_dataset_services = dict(dataset_services or {})
        self._bundle_allow_local_multi_dataset = bool(allow_local_multi_dataset)
        try:
            self._bundle_primary_dataset = _dataset_id(self)
        except ValueError:
            self._bundle_primary_dataset = None

    def _check_dependencies(self, dependencies, dataset_id, checked=None):
        checked = set() if checked is None else checked
        pending = list(dependencies)
        while pending:
            dep = pending.pop()
            if not isinstance(dep, dict):
                raise ValueError("READ_DEPENDENCY_INVALID")
            if dep.get("required") is not True:
                continue
            dset = dep.get("dataset_id")
            sid = dep.get("snapshot_id")
            pid = dep.get("product_id")
            identity = (dset, sid, pid)
            if identity in checked:
                continue
            if dset not in self._bundle_dependency_datasets:
                raise ValueError("DEPENDENCY_DATASET_NOT_IN_BUNDLE:" + str(dset))
            if identity not in self._bundle_dependency_index:
                raise ValueError("DEPENDENCY_NOT_IN_BUNDLE:"
                                 + ":".join(str(value) for value in identity))
            engine = self.engine
            if dset != self._bundle_primary_dataset:
                mapped = self._bundle_dataset_services.get(dset)
                if mapped is None and self._bundle_allow_local_multi_dataset:
                    engine = self.engine
                elif mapped is None:
                    raise ValueError("DEPENDENCY_DATASET_SERVICE_MISSING:" + str(dset))
                else:
                    if Path(mapped.root).resolve() == Path(self.root).resolve():
                        raise ValueError("DEPENDENCY_DATASET_SERVICE_FALLBACK_FORBIDDEN:" + str(dset))
                    engine = mapped.engine
            snapshot = _bundle_snapshot(engine, sid)
            entries = [entry for entry in snapshot["files"] if entry.get("product_id") == pid]
            if not entries:
                raise ValueError("DEPENDENCY_PRODUCT_UNAVAILABLE:" + str(pid))
            product = _entry_binding(entries[0])["product"]
            if product.get("dataset_id") != dset:
                raise ValueError("DEPENDENCY_DATASET_MISMATCH:" + str(pid))
            expected = dep.get("contract_digest") or dep.get("digest")
            if expected and product.get("contract_ref", {}).get("digest") != expected:
                raise ValueError("DEPENDENCY_CONTRACT_MISMATCH:" + str(pid))
            checked.add(identity)
            pending.extend(_read_dependencies(product))


def _legacy_import(bundle, destination, runtime_root, protocol_root=None):
    bundle, destination = Path(bundle), Path(destination)
    descriptor = _verify_bundle_legacy(bundle)
    if destination.exists():
        raise ValueError("BUNDLE_DESTINATION_EXISTS")
    protocol_root = Path(protocol_root) if protocol_root is not None else Path(__file__).resolve().parents[1] / "protocol"
    engine = WFDDuckDBPrototype(destination, load_protocol_validator(protocol_root),
                               runtime_root=Path(runtime_root), sandbox=False, writer_host=None)
    packages = sorted(descriptor["storage_packages"], key=lambda p: p["snapshot_id"] == descriptor["source_snapshot_id"])
    with writer_lock(destination):
        for package in packages:
            result = import_package(_path(bundle, package["directory"]), destination)
            if result["status"] != "imported":
                raise ValueError("BUNDLE_IMPORT_FAILED:" + str(result.get("code")))
        for record in descriptor["records"]:
            raw = (bundle / "objects" / record["sha256"]).read_bytes()
            engine._write_immutable(record["relative_path"], raw)
    local_sources = {
        permission["source_id"]: {"may_read": True, "may_read_evidence": True,
                                  "usage_scope": "local_use"}
        for permission in descriptor.get("permissions", [])
        if permission.get("source_id")
    }
    service = WFDProductService(engine, allowed_sources=local_sources, can_register=False,
                                caller_roles={"read", "read_evidence"}, caller_id="bundle-import")
    _, pairs, _ = _closure(service, descriptor["selected_product_ids"], descriptor["source_snapshot_id"])
    expected_pairs = {(r["snapshot_id"], r["product_id"]) for r in descriptor["included_reads"]}
    if pairs != expected_pairs:
        raise ValueError("BUNDLE_READ_CLOSURE_MISMATCH")
    for expected in descriptor["included_reads"]:
        sid, pid = expected["snapshot_id"], expected["product_id"]
        rows = service.read(pid, snapshot_id=sid)["rows"]
        if len(rows) != expected["row_count"] or sha(canonical(rows)) != expected["rows_sha256"]:
            raise ValueError("BUNDLE_FIXED_READ_MISMATCH:" + pid)
        if not all(e["verified"] for e in service.trace(pid, snapshot_id=sid)["evidence"]):
            raise ValueError("BUNDLE_EVIDENCE_UNAVAILABLE:" + pid)
    state = engine.state.read()
    if state.get("active_head") is not None or state.get("writer_host") is not None:
        raise ValueError("BUNDLE_UNEXPECTED_WRITE_AUTHORITY")
    return service, {"status": "imported_readable", "snapshot_id": descriptor["source_snapshot_id"],
        "selected_product_ids": descriptor["selected_product_ids"], "verified_reads": descriptor["included_reads"],
        "additional_products": descriptor["additional_products"], "permissions": descriptor["permissions"],
        "read_self_contained": True, "active_head": None, "write_authority_granted": False}


def import_financial_bundle(bundle, destination, *, runtime_root, protocol_root=None,
                            allowed_sources=None, trusted_actor_namespaces=None):
    """Return ``(read_service, report)`` after actual independent fixed reads.

    New ``0.2`` bundles require an operator-supplied trusted source policy.
    The package's own source names never grant read or redistribution rights.
    Legacy ``0.1`` bundles keep their original local-use compatibility path.
    """
    bundle, destination = Path(bundle), Path(destination)
    descriptor = _verify_bundle(bundle)
    if descriptor.get("format_version") == LEGACY_FORMAT:
        return _legacy_import(bundle, destination, runtime_root, protocol_root)
    if allowed_sources is None:
        raise ValueError("BUNDLE_TRUSTED_POLICY_REQUIRED")
    policies = normalize_source_policies(allowed_sources)
    required_sources = {item["source_id"] for item in descriptor.get("permissions", [])
                        if item.get("source_id")}
    for source_id in sorted(required_sources):
        policy = policies.get(source_id)
        if policy is None or policy.get("may_read") is not True:
            raise ValueError("BUNDLE_TRUSTED_POLICY_REQUIRED:" + source_id)
        if any(item.get("carried") and source_id in item.get("source_ids", [])
               for item in descriptor.get("evidence", [])) and policy.get("may_read_evidence") is not True:
            raise ValueError("BUNDLE_TRUSTED_EVIDENCE_POLICY_REQUIRED:" + source_id)
    if destination.exists():
        raise ValueError("BUNDLE_DESTINATION_EXISTS")
    protocol_root = Path(protocol_root) if protocol_root is not None else Path(__file__).resolve().parents[1] / "protocol"
    import_started = _now()
    engine = WFDDuckDBPrototype(destination, load_protocol_validator(protocol_root),
                               runtime_root=Path(runtime_root), sandbox=False, writer_host=None)
    package = descriptor["storage_packages"][0]
    with writer_lock(destination):
        result = import_package(_path(bundle, package["directory"]), destination)
        if result["status"] != "imported":
            raise ValueError("BUNDLE_IMPORT_FAILED:" + str(result.get("code")))
        for record in descriptor["records"]:
            raw = (bundle / "objects" / record["sha256"]).read_bytes()
            engine._write_immutable(record["relative_path"], raw)
        for item in descriptor.get("evidence", []):
            if item.get("carried"):
                raw = (bundle / "objects" / item["digest"]).read_bytes()
                engine._write_immutable(f"evidence/sha256/{item['digest']}", raw)
    target_sid = descriptor["target_snapshot_id"]
    snapshot = _bundle_snapshot(engine, target_sid)
    dependency_index, datasets = set(), set()
    for entry in snapshot["files"]:
        product = _entry_binding(entry)["product"]
        dependency_index.add((product["dataset_id"], target_sid, product["product_id"]))
        datasets.add(product["dataset_id"])
    service = BundledProductService(
        engine, allowed_sources=policies, dependency_index=dependency_index,
        dependency_datasets=datasets, caller_id="bundle-import",
        caller_roles={"read", "read_evidence"}, allow_local_multi_dataset=True)
    for expected in descriptor["included_reads"]:
        items = service.read(expected["product_id"], snapshot_id=target_sid)["rows"]
        rows = [item["row"] for item in items]
        if len(rows) != expected["row_count"] or "sha256:" + sha(canonical(rows)) != expected["rows_sha256"]:
            raise ValueError("BUNDLE_FIXED_READ_MISMATCH:" + expected["product_id"])
    for item in descriptor.get("evidence", []):
        if not item.get("carried"):
            continue
        path = destination / f"evidence/sha256/{item['digest']}"
        if not path.is_file() or sha_file(path) != item["digest"]:
            raise ValueError("BUNDLE_EVIDENCE_UNAVAILABLE:" + item["digest"])
    read_verified = _now()
    state = engine.state.read()
    if state.get("active_head") is not None or state.get("writer_host") is not None:
        raise ValueError("BUNDLE_UNEXPECTED_WRITE_AUTHORITY")
    source_received = sorted({str(item.get("source_received_time", {}).get("earliest_utc"))
                              for item in descriptor.get("logical_state", {}).get("products", [])
                              if item.get("source_received_time")})
    bundle_id = "b_" + sha(canonical([descriptor["selection_digest"], target_sid]))[:24]
    report = {
        "status": "imported_readable",
        "format_version": FORMAT,
        "bundle_id": bundle_id,
        "source_snapshot_id": descriptor["source_snapshot_id"],
        "target_snapshot_id": target_sid,
        "selected_product_ids": descriptor["selected_product_ids"],
        "verified_reads": descriptor["included_reads"],
        "source_target_map": descriptor["source_target_map"],
        "selection_digest": descriptor["selection_digest"],
        "logical_state_digest": descriptor["logical_state_digest"],
        "source_received_at_utc": source_received,
        "import_started_at_utc": import_started,
        "import_completed_at_utc": read_verified,
        "actual_read_verified_at_utc": read_verified,
        "target_received_at_utc": import_started,
        "source_and_target_received_time_differ": bool(source_received) and import_started not in source_received,
        "read_self_contained": True,
        "closure_gaps": descriptor.get("closure", {}).get("optional_gaps", []),
        "active_head": state.get("active_head"),
        "imported_head": state.get("imported_head"),
        "writer_host": state.get("writer_host"),
        "write_authority_granted": False,
        "trusted_policy_source": "operator",
        "permissions": descriptor.get("permissions"),
        "evidence": descriptor.get("evidence"),
    }
    custody = {
        "format_version": "wfd.bundle-import/0.2",
        "bundle_id": bundle_id,
        "source_snapshot_id": descriptor["source_snapshot_id"],
        "target_snapshot_id": target_sid,
        "selection_digest": descriptor["selection_digest"],
        "logical_state_digest": descriptor["logical_state_digest"],
        "source_target_map": copy.deepcopy(descriptor["source_target_map"]),
        "source_received_at_utc": source_received,
        "target_received_at_utc": import_started,
        "target_readable_at_utc": read_verified,
        "actual_read_verified_at_utc": read_verified,
        "trusted_policy": {source_id: {key: value for key, value in policy.items()
                                        if key in {"may_read", "may_read_evidence",
                                                   "may_export", "may_export_evidence",
                                                   "may_redistribute", "usage_scope",
                                                   "export_scope"}}
                           for source_id, policy in policies.items()},
        "active_head": state.get("active_head"),
        "write_authority_granted": False,
    }
    with writer_lock(destination):
        engine._write_immutable(f"catalog/product_service/bundles/{bundle_id}.json",
                                canonical(custody))
        engine._write_immutable(f"catalog/bundles/{bundle_id}.json",
                                canonical({"format_version": "wfd.bundle-ref/1.0",
                                           "bundle_id": bundle_id, "kind": "complete",
                                           "state": "imported_not_activated",
                                           "source_snapshot_id": target_sid,
                                           "target_snapshot_id": target_sid,
                                           "files": [],
                                           "created_at_utc": _now()}))
    return service, report



# ---------------------------------------------------------------------------
# P5b first batch: delta and reference bundles over the same 0.2 manifest.
# ---------------------------------------------------------------------------

def _check_inventory(bundle):
    bundle = Path(bundle)
    inventory = _json(bundle / "CHECKSUMS.json")
    listed = set()
    for item in inventory:
        path = _path(bundle, item["path"])
        if (path.is_symlink() or not path.is_file()
                or path.stat().st_size != item["size"]
                or sha_file(path) != item["sha256"]
                or item["path"] in listed):
            raise ValueError("BUNDLE_INTEGRITY_FAILED:" + item["path"])
        listed.add(item["path"])
    actual = {p.relative_to(bundle).as_posix() for p in bundle.rglob("*") if p.is_file()}
    if actual != listed | {"CHECKSUMS.json"}:
        raise ValueError("BUNDLE_INVENTORY_MISMATCH")
    return inventory


def _package_files(package_dir):
    checked = verify_package(package_dir)
    if not checked["ok"]:
        raise ValueError("BUNDLE_STORAGE_INTEGRITY_FAILED")
    files = {}
    for obj in checked["inventory"]["objects"]:
        raw = (Path(package_dir) / "objects" / obj["sha256"]).read_bytes()
        for relative in obj["rel_paths"]:
            files[relative] = raw
    for meta in checked["inventory"]["metadata"]:
        files[meta["rel_path"]] = (Path(package_dir) / "objects" / meta["sha256"]).read_bytes()
    return checked, files


def _verify_delta_bundle(bundle, descriptor):
    bundle = Path(bundle)
    _check_inventory(bundle)
    if descriptor.get("mode") != "delta":
        raise ValueError("BUNDLE_MODE_NOT_IMPLEMENTED")
    target_sid = descriptor.get("target_snapshot_id")
    baseline = descriptor.get("baseline") or {}
    baseline_sid = baseline.get("target_snapshot_id")
    if not isinstance(target_sid, str) or not target_sid.startswith("s_"):
        raise ValueError("BUNDLE_TARGET_IDENTITY_INVALID")
    if not isinstance(baseline_sid, str) or not baseline_sid.startswith("s_"):
        raise ValueError("BUNDLE_BASELINE_MISSING")
    if target_sid == baseline_sid:
        raise ValueError("BUNDLE_TARGET_REUSES_BASELINE")
    computed = "sha256:" + sha(canonical({
        "selection": descriptor.get("selection"),
        "closure": descriptor.get("source_closure"),
    }))
    if computed != descriptor.get("selection_digest"):
        raise ValueError("BUNDLE_SELECTION_DIGEST_MISMATCH")
    body = [TARGET_FORMAT, descriptor["selection_digest"], baseline_sid]
    if descriptor.get("target_salt") != baseline_sid:
        raise ValueError("BUNDLE_BASELINE_MISSING")
    if "s_" + sha(canonical(body))[:24] != target_sid:
        raise ValueError("BUNDLE_TARGET_ID_MISMATCH")
    if "sha256:" + sha(canonical(descriptor.get("logical_state"))) != descriptor.get("logical_state_digest"):
        raise ValueError("BUNDLE_LOGICAL_STATE_DIGEST_MISMATCH")
    if len(descriptor.get("storage_packages", [])) != 1:
        raise ValueError("BUNDLE_STORAGE_PACKAGE_INVALID")
    package = descriptor["storage_packages"][0]
    if package.get("snapshot_id") != target_sid:
        raise ValueError("BUNDLE_STORAGE_PACKAGE_INVALID")
    _, files = _package_files(_path(bundle, package["directory"]))
    snapshot_rel = f"catalog/snapshots/{target_sid}.json"
    if snapshot_rel not in files:
        raise ValueError("BUNDLE_TARGET_SNAPSHOT_MISSING")
    snapshot = json.loads(files[snapshot_rel].decode("utf-8"))
    if snapshot.get("snapshot_id") != target_sid:
        raise ValueError("BUNDLE_TARGET_SNAPSHOT_INVALID")
    if snapshot.get("parent_snapshot_id") != baseline_sid:
        raise ValueError("BUNDLE_TARGET_PARENT_MISMATCH")
    receipt = snapshot.get("receipt") or {}
    if receipt.get("formal_source_receipt") is not False:
        raise ValueError("BUNDLE_TARGET_RECEIPT_INVALID")
    reused = {item["relative_path"]: item["sha256"]
              for item in descriptor.get("baseline_reused_files", [])}
    for entry in snapshot.get("files", []):
        rel = entry["file_relpath"]
        if rel in files:
            if sha(files[rel]) != entry["file_sha256"].split(":")[-1]:
                raise ValueError("BUNDLE_TARGET_FILE_HASH_MISMATCH:" + rel)
        elif reused.get(rel) != entry["file_sha256"].split(":")[-1]:
            raise ValueError("BUNDLE_BASELINE_OBJECT_MISSING:" + rel)
    if set(reused) - {entry["file_relpath"] for entry in snapshot.get("files", [])}:
        raise ValueError("BUNDLE_BASELINE_REUSE_EXTRA")
    for record in descriptor.get("records", []):
        path = _path(bundle, "objects/" + record["sha256"])
        if not path.is_file() or sha_file(path) != record["sha256"]:
            raise ValueError("BUNDLE_DEPENDENCY_MISSING:" + record["relative_path"])
    for item in descriptor.get("evidence", []):
        if item.get("carried"):
            path = _path(bundle, "objects/" + item["digest"])
            if not path.is_file() or sha_file(path) != item["digest"]:
                raise ValueError("BUNDLE_EVIDENCE_MISSING:" + item["digest"])
    leaked = _scan_absolute_paths(descriptor)
    if leaked:
        raise ValueError("BUNDLE_ABSOLUTE_PATH_LEAK:" + leaked[0])
    return descriptor


def _verify_reference_bundle(bundle, descriptor):
    _check_inventory(Path(bundle))
    if descriptor.get("mode") != "reference":
        raise ValueError("BUNDLE_MODE_NOT_IMPLEMENTED")
    if descriptor.get("read_self_contained") is not False:
        raise ValueError("BUNDLE_REFERENCE_CLAIMS_SELF_CONTAINED")
    if descriptor.get("storage_packages"):
        raise ValueError("BUNDLE_REFERENCE_HAS_STORAGE_PACKAGE")
    computed = "sha256:" + sha(canonical({
        "selection": descriptor.get("selection"),
        "closure": descriptor.get("source_closure"),
    }))
    if computed != descriptor.get("selection_digest"):
        raise ValueError("BUNDLE_SELECTION_DIGEST_MISMATCH")
    external = descriptor.get("external_objects")
    if not isinstance(external, list) or not external:
        raise ValueError("BUNDLE_REFERENCE_EMPTY")
    for item in external:
        if item.get("required") is not True:
            raise ValueError("BUNDLE_REFERENCE_OPTIONAL_NOT_IMPLEMENTED")
        for key in ("dataset_id", "snapshot_id", "product_id"):
            if not isinstance(item.get(key), str) or not item[key]:
                raise ValueError("BUNDLE_REFERENCE_IDENTITY_INVALID")
        if not item.get("purposes"):
            raise ValueError("BUNDLE_REFERENCE_PURPOSE_MISSING")
    leaked = _scan_absolute_paths(descriptor)
    if leaked:
        raise ValueError("BUNDLE_ABSOLUTE_PATH_LEAK:" + leaked[0])
    return descriptor


def _full_descriptor_snapshot(full_bundle, descriptor):
    package = full_bundle / descriptor["storage_packages"][0]["directory"]
    _, files = _package_files(package)
    sid = descriptor["target_snapshot_id"]
    return json.loads(files[f"catalog/snapshots/{sid}.json"].decode("utf-8")), files


def export_delta_bundle(service, product_ids, destination, *, snapshot_id,
                        baseline_store, baseline_snapshot_id, selection=None,
                        perspective="snapshot_contents", dataset_services=None,
                        read_limits=None, redistribution_requested=False):
    """Export a delta over an existing target baseline; only missing objects travel."""
    service.require_permission("export")
    baseline_store = Path(baseline_store)
    if not baseline_store.is_dir():
        raise ValueError("BUNDLE_BASELINE_STORE_MISSING")
    protocol_root = Path(__file__).resolve().parents[1] / "protocol"
    baseline_engine = WFDDuckDBPrototype(
        baseline_store, load_protocol_validator(protocol_root),
        runtime_root=baseline_store.parent / (baseline_store.name + "_delta_runtime"),
        sandbox=False, writer_host=None)
    try:
        baseline_snapshot = _bundle_snapshot(baseline_engine, baseline_snapshot_id)
    except (ValueError, OSError) as exc:
        raise ValueError("BUNDLE_BASELINE_UNAVAILABLE:" + str(baseline_snapshot_id)) from exc
    baseline_receipt = baseline_snapshot.get("receipt") or {}
    baseline_target_receipt = baseline_receipt.get("target_receipt") or {}
    baseline_selection = (baseline_target_receipt.get("normalized_selection_digest")
                          or baseline_target_receipt.get("selection_digest")
                          or baseline_receipt.get("normalized_selection_digest")
                          or baseline_receipt.get("selection_digest"))
    baseline_logical = (baseline_target_receipt.get("logical_state_digest")
                        or baseline_receipt.get("logical_state_digest"))
    if not baseline_selection or not baseline_logical:
        raise ValueError("BUNDLE_BASELINE_STATE_UNKNOWN")
    destination = Path(destination)
    if destination.exists():
        raise ValueError("BUNDLE_DESTINATION_EXISTS")
    with tempfile.TemporaryDirectory(prefix=".wfd_delta_full_", dir=destination.parent) as temp:
        full_dir = Path(temp) / "full"
        full = export_financial_bundle(
            service, product_ids, full_dir, snapshot_id=snapshot_id,
            mode="full", perspective=perspective, selection=selection,
            dataset_services=dataset_services, read_limits=read_limits,
            redistribution_requested=redistribution_requested,
            target_salt=baseline_snapshot_id,
            parent_snapshot_id=baseline_snapshot_id)
        if (full.get("normalized_selection_digest") or full["selection_digest"]) != baseline_selection:
            raise ValueError("BUNDLE_BASELINE_SELECTION_MISMATCH")
        full_snapshot, full_files = _full_descriptor_snapshot(full_dir, full)
        baseline_files = {entry["file_relpath"]: entry["file_sha256"].split(":")[-1]
                          for entry in baseline_snapshot["files"]}
        target_sid = full["target_snapshot_id"]
        reused, new_entries = [], []
        for entry in full_snapshot["files"]:
            rel = entry["file_relpath"]
            digest = entry["file_sha256"].split(":")[-1]
            if baseline_files.get(rel) == digest:
                reused.append({"relative_path": rel, "sha256": digest})
            else:
                new_entries.append(entry)
        full_package = full_dir / full["storage_packages"][0]["directory"]
        checked, package_files = _package_files(full_package)
        delta_dir = destination
        (delta_dir / "objects").mkdir(parents=True, exist_ok=True)
        package_dir = delta_dir / "storage" / target_sid
        (package_dir / "objects").mkdir(parents=True, exist_ok=True)
        included_objects, included_metadata = [], []
        new_hits = {entry["file_relpath"]: entry["file_sha256"].split(":")[-1]
                    for entry in new_entries}
        for obj in checked["inventory"]["objects"]:
            rels = list(obj["rel_paths"])
            if all(baseline_files.get(rel) == obj["sha256"] for rel in rels):
                continue
            (package_dir / "objects" / obj["sha256"]).write_bytes(
                (full_package / "objects" / obj["sha256"]).read_bytes())
            included_objects.append(obj)
        for meta in checked["inventory"]["metadata"]:
            if baseline_snapshot_id in meta["rel_path"]:
                continue
            (package_dir / "objects" / meta["sha256"]).write_bytes(
                (full_package / "objects" / meta["sha256"]).read_bytes())
            included_metadata.append(meta)
        transfer = {
            "format_version": "wfd.transfer/1.0",
            "transfer_id": "delta_" + target_sid,
            "created_at_utc": _now(),
            "dataset_id": full.get("source_dataset_id"),
            "target_snapshot_id": target_sid,
            "ancestry": [baseline_snapshot_id, target_sid],
            "object_count": len(included_objects),
            "total_bytes": sum(int(obj.get("size") or 0) for obj in included_objects),
            "include_ancestor_data": False,
            "partial": True,
            "baseline_snapshot_id": baseline_snapshot_id,
            "source": {"dataset_id": full.get("source_dataset_id"),
                       "snapshot_id": full.get("source_snapshot_id"),
                       "files_root": checked["inventory"].get("files_root"),
                       "writer_host": None, "writer_epoch": 0},
        }
        (package_dir / "transfer.json").write_text(
            json.dumps(transfer, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        inventory = {
            "format_version": "wfd.transfer.manifest/1.0",
            "generated_at_utc": _now(),
            "dataset_id": full.get("source_dataset_id"),
            "target_snapshot_id": target_sid,
            "files_root": checked["inventory"].get("files_root"),
            "objects": included_objects,
            "metadata": included_metadata,
            "ancestry": [baseline_snapshot_id, target_sid],
            "partial": True,
            "baseline_snapshot_id": baseline_snapshot_id,
        }
        (package_dir / "inventory.json").write_text(
            json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        lines = []
        for path in sorted(package_dir.rglob("*")):
            if path.is_file() and path.name != "CHECKSUMS.sha256":
                lines.append(f"{sha_file(path)}  {path.relative_to(package_dir).as_posix()}")
        (package_dir / "CHECKSUMS.sha256").write_text("\n".join(lines) + "\n", encoding="utf-8")
        # Catalog/evidence objects already present in the target are not repeated.
        delta_records, stale_registration = [], []
        for record in full.get("records", []):
            existing = baseline_store / record["relative_path"]
            if existing.is_file() and sha_file(existing) == record["sha256"]:
                continue
            if (existing.is_file()
                    and record["relative_path"].startswith("catalog/product_service/products/")):
                # The authoritative product body is carried in the new snapshot
                # binding.  The flat registry path is not overwritten in-place;
                # record the stale compatibility file instead of hiding it.
                stale_registration.append({
                    "relative_path": record["relative_path"],
                    "existing_sha256": sha_file(existing),
                    "desired_sha256": record["sha256"],
                })
                continue
            raw = (full_dir / "objects" / record["sha256"]).read_bytes()
            (delta_dir / "objects" / record["sha256"]).write_bytes(raw)
            delta_records.append(copy.deepcopy(record))
        delta_evidence = []
        for item in full.get("evidence", []):
            if not item.get("carried"):
                delta_evidence.append(copy.deepcopy(item))
                continue
            existing = baseline_store / f"evidence/sha256/{item['digest']}"
            if existing.is_file() and sha_file(existing) == item["digest"]:
                continue
            raw = (full_dir / "objects" / item["digest"]).read_bytes()
            (delta_dir / "objects" / item["digest"]).write_bytes(raw)
            delta_evidence.append(copy.deepcopy(item))
        descriptor = copy.deepcopy(full)
        descriptor.update({
            "mode": "delta",
            "baseline": {
                "target_snapshot_id": baseline_snapshot_id,
                "selection_digest": baseline_selection,
                "normalized_selection_digest": baseline_selection,
                "logical_state_digest": baseline_logical,
                "source_dataset_id": baseline_receipt.get("source_dataset_id"),
                "source_snapshot_id": baseline_receipt.get("source_snapshot_id"),
            },
            "baseline_reused_files": reused,
            "storage_packages": [{"snapshot_id": target_sid,
                                  "directory": f"storage/{target_sid}"}],
            "records": delta_records,
            "baseline_stale_registration": stale_registration,
            "evidence": delta_evidence,
            "unsupported": ["reference_bundle", "automatic_takeover", "maintenance"],
        })
        (delta_dir / "financial_bundle.json").write_bytes(canonical(descriptor))
        inventory2 = [{"path": p.relative_to(delta_dir).as_posix(),
                       "sha256": sha_file(p), "size": p.stat().st_size}
                      for p in sorted(delta_dir.rglob("*")) if p.is_file()]
        (delta_dir / "CHECKSUMS.json").write_bytes(canonical(inventory2))
        _verify_delta_bundle(delta_dir, descriptor)
        return descriptor


def apply_delta_bundle(bundle, target_store, *, runtime_root, allowed_sources,
                       protocol_root=None, interrupt_after=None):
    """Validate a delta, stage/commit it atomically, and keep the baseline readable."""
    bundle, target_store = Path(bundle), Path(target_store)
    descriptor = _verify_delta_bundle(bundle, _json(bundle / "financial_bundle.json"))
    if not target_store.is_dir():
        raise ValueError("BUNDLE_TARGET_STORE_MISSING")
    if allowed_sources is None:
        raise ValueError("BUNDLE_TRUSTED_POLICY_REQUIRED")
    policies = normalize_source_policies(allowed_sources)
    baseline = descriptor["baseline"]
    baseline_sid = baseline["target_snapshot_id"]
    baseline_path = target_store / f"catalog/snapshots/{baseline_sid}.json"
    if not baseline_path.is_file():
        raise ValueError("BUNDLE_BASELINE_UNAVAILABLE:" + baseline_sid)
    baseline_snapshot = _json(baseline_path)
    baseline_receipt = baseline_snapshot.get("receipt") or {}
    baseline_target_receipt = baseline_receipt.get("target_receipt") or {}
    baseline_selection_now = (baseline_target_receipt.get("normalized_selection_digest")
                              or baseline_target_receipt.get("selection_digest")
                              or baseline_receipt.get("normalized_selection_digest")
                              or baseline_receipt.get("selection_digest"))
    if baseline_selection_now != (baseline.get("normalized_selection_digest")
                                  or baseline.get("selection_digest")):
        raise ValueError("BUNDLE_BASELINE_SELECTION_MISMATCH")
    if ((baseline_target_receipt.get("logical_state_digest")
         or baseline_receipt.get("logical_state_digest")) != baseline.get("logical_state_digest")):
        raise ValueError("BUNDLE_BASELINE_STATE_MISMATCH")
    for item in descriptor.get("baseline_reused_files", []):
        path = target_store / item["relative_path"]
        if not path.is_file() or sha_file(path) != item["sha256"]:
            raise ValueError("BUNDLE_BASELINE_OBJECT_MISSING:" + item["relative_path"])
    package = bundle / descriptor["storage_packages"][0]["directory"]
    checked, files = _package_files(package)
    snapshot = json.loads(files[f"catalog/snapshots/{descriptor['target_snapshot_id']}.json"].decode("utf-8"))
    for obj in checked["inventory"]["objects"]:
        for relative in obj["rel_paths"]:
            existing = target_store / relative
            if existing.is_file() and sha_file(existing) != obj["sha256"]:
                raise ValueError("BUNDLE_PATH_HASH_CONFLICT:" + relative)
    for entry in snapshot["files"]:
        rel = entry["file_relpath"]
        digest = entry["file_sha256"].split(":")[-1]
        if rel in files:
            if sha(files[rel]) != digest:
                raise ValueError("BUNDLE_TARGET_FILE_HASH_MISMATCH:" + rel)
            continue
        existing = target_store / rel
        if not existing.is_file() or sha_file(existing) != digest:
            raise ValueError("BUNDLE_DEPENDENCY_MISSING:" + rel)
    required_sources = {item["source_id"] for item in descriptor.get("permissions", [])
                        if item.get("source_id")}
    for source_id in sorted(required_sources):
        policy = policies.get(source_id)
        if policy is None or policy.get("may_read") is not True:
            raise ValueError("BUNDLE_TRUSTED_POLICY_REQUIRED:" + source_id)
        if any(item.get("carried") and source_id in item.get("source_ids", [])
               for item in descriptor.get("evidence", [])) and policy.get("may_read_evidence") is not True:
            raise ValueError("BUNDLE_TRUSTED_EVIDENCE_POLICY_REQUIRED:" + source_id)
    target_sid = descriptor["target_snapshot_id"]
    bundle_id = "b_" + sha(canonical([descriptor["selection_digest"], target_sid]))[:24]
    record_path = target_store / f"catalog/bundles/{bundle_id}.json"
    record_path.parent.mkdir(parents=True, exist_ok=True)
    active_before = (_json(target_store / "catalog/state.json").get("active_head")
                     if (target_store / "catalog/state.json").is_file() else None)
    import_started = _now()
    staging = {
        "format_version": "wfd.bundle-delta/0.1",
        "bundle_id": bundle_id,
        "kind": "delta",
        "state": "staging",
        "baseline": copy.deepcopy(baseline),
        "target_snapshot_id": target_sid,
        "selection_digest": descriptor["selection_digest"],
        "logical_state_digest": descriptor["logical_state_digest"],
        "verified_objects": [{"relative_path": rel, "sha256": sha(files[rel])}
                             for rel in sorted(files)
                             if rel.startswith(("foundation/", "observations/", "events/"))],
        "created_at_utc": import_started,
        "verified_reads": descriptor["included_reads"],
    }
    record_path.write_bytes(canonical(staging))
    with writer_lock(target_store):
        commit_path = target_store / f"catalog/commits/{target_sid}.json"
        if commit_path.is_file():
            engine = WFDDuckDBPrototype(
                target_store, load_protocol_validator(Path(protocol_root) if protocol_root
                                                      else Path(__file__).resolve().parents[1] / "protocol"),
                runtime_root=Path(runtime_root), sandbox=False, writer_host=None)
            _bundle_snapshot(engine, target_sid)
            staging.update({"state": "applied", "applied_at_utc": _now(),
                            "active_head": engine.state.read().get("active_head"),
                            "write_authority_granted": False})
            record_path.write_bytes(canonical(staging))
            return {"status": "already_applied", "bundle_id": bundle_id,
                    "target_snapshot_id": target_sid, "baseline_snapshot_id": baseline_sid,
                    "selection_digest": descriptor["selection_digest"],
                    "logical_state_digest": descriptor["logical_state_digest"],
                    "active_head": engine.state.read().get("active_head"),
                    "write_authority_granted": False}
        result = import_package(package, target_store, interrupt_after=interrupt_after)
        if result["status"] == "interrupted":
            staging.update({"state": "staging", "copied": result.get("copied", []),
                            "reused": result.get("reused", []),
                            "updated_at_utc": _now()})
            record_path.write_bytes(canonical(staging))
            return {"status": "interrupted", "bundle_id": bundle_id,
                    "target_snapshot_id": target_sid, "baseline_snapshot_id": baseline_sid,
                    "copied": result.get("copied", []), "reused": result.get("reused", []),
                    "staging_record": str(record_path.relative_to(target_store))}
        if result["status"] != "imported":
            raise ValueError("BUNDLE_IMPORT_FAILED:" + str(result.get("code")))
        engine = WFDDuckDBPrototype(
            target_store, load_protocol_validator(Path(protocol_root) if protocol_root
                                                  else Path(__file__).resolve().parents[1] / "protocol"),
            runtime_root=Path(runtime_root), sandbox=False, writer_host=None)
        for record in descriptor.get("records", []):
            raw = (bundle / "objects" / record["sha256"]).read_bytes()
            engine._write_immutable(record["relative_path"], raw)
        for item in descriptor.get("evidence", []):
            if item.get("carried"):
                raw = (bundle / "objects" / item["digest"]).read_bytes()
                engine._write_immutable(f"evidence/sha256/{item['digest']}", raw)
        _bundle_snapshot(engine, target_sid)
        dependency_index, datasets = set(), set()
        for entry in _bundle_snapshot(engine, target_sid)["files"]:
            product = _entry_binding(entry)["product"]
            dependency_index.add((product["dataset_id"], target_sid, product["product_id"]))
            datasets.add(product["dataset_id"])
        service = BundledProductService(
            engine, allowed_sources=policies, dependency_index=dependency_index,
            dependency_datasets=datasets, caller_id="bundle-delta-import",
            caller_roles={"read", "read_evidence"}, allow_local_multi_dataset=True)
        for expected in descriptor["included_reads"]:
            items = service.read(expected["product_id"], snapshot_id=target_sid)["rows"]
            rows = [item["row"] for item in items]
            if len(rows) != expected["row_count"] or "sha256:" + sha(canonical(rows)) != expected["rows_sha256"]:
                raise ValueError("BUNDLE_FIXED_READ_MISMATCH:" + expected["product_id"])
        state = engine.state.read()
        if state.get("active_head") != active_before:
            raise ValueError("BUNDLE_UNEXPECTED_HEAD_ACTIVATION")
        if state.get("writer_host") is not None:
            raise ValueError("BUNDLE_UNEXPECTED_WRITE_AUTHORITY")
        staging.update({"state": "applied", "applied_at_utc": _now(),
                        "verified_reads": descriptor["included_reads"],
                        "active_head": state.get("active_head"),
                        "imported_head": state.get("imported_head"),
                        "write_authority_granted": False})
        record_path.write_bytes(canonical(staging))
    return {"status": "applied", "bundle_id": bundle_id,
            "target_snapshot_id": target_sid, "baseline_snapshot_id": baseline_sid,
            "selection_digest": descriptor["selection_digest"],
            "logical_state_digest": descriptor["logical_state_digest"],
            "verified_reads": descriptor["included_reads"],
            "active_head": state.get("active_head"),
            "imported_head": state.get("imported_head"),
            "write_authority_granted": False}


def _reference_protection_files(nodes):
    result, seen = [], set()
    for node in nodes:
        snapshot = _bundle_snapshot(node.service.engine, node.snapshot_id)
        for entry in snapshot["files"]:
            rel = entry["file_relpath"]
            if (node.service.root, rel) not in seen:
                seen.add((node.service.root, rel))
                result.append({"root": str(node.service.root), "rel_path": rel,
                               "sha256": entry["file_sha256"]})
        product = node.source_product
        pid = product["product_id"]
        candidates = [f"catalog/product_service/products/{pid}.json"]
        candidates.extend(p.relative_to(node.service.root).as_posix()
                          for p in (Path(node.service.root) / "catalog/product_service/products" / pid).glob("definition_*.json"))
        candidates.append(f"catalog/product_service/definitions/{product['definition_ref']['digest'].removeprefix('sha256:')}.json")
        candidates.append(f"catalog/product_service/contracts/{product['contract_ref']['digest'].removeprefix('sha256:')}.json")
        for entry in snapshot["files"]:
            for ref in entry.get("evidence_refs", []):
                digest = (ref.get("content_sha256") or "").removeprefix("sha256:")
                if len(digest) == 64:
                    candidates.append(f"catalog/product_service/evidence/{digest}.json")
                    candidates.append(f"evidence/sha256/{digest}")
        for rel in candidates:
            path = Path(node.service.root) / rel
            if not path.is_file():
                continue
            key = (str(node.service.root), rel)
            if key in seen:
                continue
            seen.add(key)
            result.append({"root": str(node.service.root), "rel_path": rel,
                           "sha256": sha_file(path)})
    return result


def export_reference_bundle(service, product_ids, destination, *, snapshot_id,
                            selection=None, dataset_services=None,
                            read_limits=None, perspective="snapshot_contents"):
    """Export a metadata-only reference manifest; no business data or original travels."""
    service.require_permission("export")
    service.require_permission("read")
    destination = Path(destination)
    if destination.exists():
        raise ValueError("BUNDLE_DESTINATION_EXISTS")
    normalized = _normalize_selection(selection, sorted(set(product_ids or [])))
    if not normalized["products"]:
        raise ValueError("BUNDLE_FIXED_SELECTION_REQUIRED")
    at = None
    if perspective != "snapshot_contents":
        at = selection.get("at") if isinstance(selection, dict) else None
        if not isinstance(at, dict) or at.get("status") != "known":
            raise ValueError("BUNDLE_AT_REQUIRED")
    limits = _limits(read_limits)
    with writer_lock(service.root):
        nodes, optional_gaps, other_deps = _resolve_nodes(
            service, normalized, snapshot_id, dataset_services, limits,
            perspective, at)
        selection_core = _selection_core(nodes, perspective, at, normalized["evidence"])
        selection_digest = "sha256:" + sha(canonical({
            "selection": selection_core,
            "closure": _source_closure_core(nodes),
        }))
        external = []
        for node in nodes:
            full_rows = [item["row"] for item in node.service.read(
                node.product_id, snapshot_id=node.snapshot_id, include_history=False)["rows"]]
            purposes = {"read"}
            for dep in _other_dependencies(node.source_product):
                if dep.get("product_id") == node.product_id:
                    purposes.add(dep.get("dependency_type"))
            external.append({
                "kind": "product",
                "dataset_id": node.dataset_id,
                "snapshot_id": node.snapshot_id,
                "product_id": node.product_id,
                "definition_digest": node.source_product["definition_ref"]["digest"],
                "contract_digest": node.source_product["contract_ref"]["digest"],
                "required": True,
                "purposes": sorted(purposes),
                "role": node.role,
                "row_count": len(full_rows),
                "rows_sha256": "sha256:" + sha(canonical(full_rows)),
                "fields": _declaration_fields(node.source_product),
                "selected_fields": sorted(node.target_fields or _declaration_fields(node.source_product)),
            })
        permissions = []
        seen_sources = set()
        for node in nodes:
            for source_id in _output_source_ids(node.source_entry):
                if source_id in seen_sources:
                    continue
                seen_sources.add(source_id)
                policy = node.service.allowed_sources.get(source_id, {})
                permissions.append({
                    "source_id": source_id,
                    "dataset_id": node.dataset_id,
                    "may_read": policy.get("may_read") is True,
                    "may_read_evidence": policy.get("may_read_evidence") is True,
                    "may_export": policy.get("may_export") is True,
                    "may_export_evidence": policy.get("may_export_evidence") is True,
                    "may_redistribute": policy.get("may_redistribute") is True,
                    "usage_scope": policy.get("usage_scope"),
                    "policy_source": "operator_trusted",
                })
        descriptor = {
            "format_version": FORMAT,
            "mode": "reference",
            "perspective": perspective,
            "at": copy.deepcopy(at),
            "source_dataset_id": _dataset_id(service),
            "source_snapshot_id": snapshot_id,
            "target_snapshot_id": None,
            "selection": copy.deepcopy(selection_core),
            "source_closure": _source_closure_core(nodes),
            "selection_digest": selection_digest,
            "external_objects": external,
            "closure": {"other_dependencies": copy.deepcopy(other_deps),
                        "optional_gaps": copy.deepcopy(optional_gaps)},
            "permissions": permissions,
            "storage_packages": [],
            "records": [],
            "included_reads": [],
            "read_self_contained": False,
            "write_authority_granted": False,
            "not_source_formal_receipt": True,
            "unsupported": ["reference_data_carry", "maintenance", "automatic_takeover"],
        }
        bundle_id = "b_" + sha(canonical([selection_digest, "reference"]))[:24]
        descriptor["bundle_id"] = bundle_id
        destination.mkdir(parents=True)
        (destination / "financial_bundle.json").write_bytes(canonical(descriptor))
        inventory = [{"path": p.relative_to(destination).as_posix(),
                      "sha256": sha_file(p), "size": p.stat().st_size}
                     for p in sorted(destination.rglob("*"))
                     if p.is_file() and p.name != "CHECKSUMS.json"]
        (destination / "CHECKSUMS.json").write_bytes(canonical(inventory))
        _verify_reference_bundle(destination, descriptor)
        roots = {}
        for item in _reference_protection_files(nodes):
            roots.setdefault(item["root"], []).append(
                {"rel_path": item["rel_path"], "sha256": item["sha256"]})
        for root, files in roots.items():
            _protection_write(type("S", (), {"root": root})(), bundle_id,
                              snapshot_id, files, "active")
        descriptor["protection"] = {"bundle_id": bundle_id, "state": "active",
                                    "source_record_count": len(roots)}
        (destination / "financial_bundle.json").write_bytes(canonical(descriptor))
        inventory = [{"path": p.relative_to(destination).as_posix(),
                      "sha256": sha_file(p), "size": p.stat().st_size}
                     for p in sorted(destination.rglob("*"))
                     if p.is_file() and p.name != "CHECKSUMS.json"]
        (destination / "CHECKSUMS.json").write_bytes(canonical(inventory))
        _verify_reference_bundle(destination, descriptor)
        return descriptor


def register_reference_bundle(bundle, target_store, *, resolvers, allowed_sources=None,
                              runtime_root=None, protocol_root=None):
    """Register a reference manifest and prove reachable/unreachable external objects."""
    bundle, target_store = Path(bundle), Path(target_store)
    descriptor = _verify_reference_bundle(bundle, _json(bundle / "financial_bundle.json"))
    target_store.mkdir(parents=True, exist_ok=True)
    protocol_root = Path(protocol_root) if protocol_root else Path(__file__).resolve().parents[1] / "protocol"
    runtime_root = Path(runtime_root) if runtime_root else target_store.parent / (target_store.name + "_ref_runtime")
    engine = WFDDuckDBPrototype(target_store, load_protocol_validator(protocol_root),
                                runtime_root=runtime_root, sandbox=False, writer_host=None)
    active_before = (engine.state.read() or {}).get("active_head")
    resolved = []
    for item in descriptor["external_objects"]:
        status, detail = "missing_resolver", {}
        resolver = (resolvers or {}).get(item["dataset_id"])
        if resolver is not None:
            try:
                resolver_dataset = _dataset_id(resolver)
            except ValueError:
                resolver_dataset = None
            if Path(resolver.root).resolve() == target_store.resolve():
                status = "fallback_forbidden"
            elif resolver_dataset != item["dataset_id"]:
                status = "wrong_dataset"
                detail = {"resolver_dataset_id": resolver_dataset}
            else:
                try:
                    _, _, product, _ = _source_product(
                        resolver, item["snapshot_id"], item["product_id"])
                    if (product["definition_ref"]["digest"] != item["definition_digest"]
                            or product["contract_ref"]["digest"] != item["contract_digest"]):
                        status = "identity_mismatch"
                    else:
                        service_at = (descriptor.get("at") or {}).get("earliest_utc")
                        rows = resolver.read(
                            item["product_id"], snapshot_id=item["snapshot_id"],
                            perspective=descriptor["perspective"], at=service_at)["rows"]
                        bodies = [row["row"] for row in rows]
                        if ("sha256:" + sha(canonical(bodies))) != item["rows_sha256"]:
                            status = "content_mismatch"
                            detail = {"actual_rows": len(bodies)}
                        else:
                            status = "reachable"
                            detail = {"actual_rows": len(bodies),
                                      "snapshot_verified": True,
                                      "contract_verified": True,
                                      "rows_sha256_match": True}
                except (ValueError, PermissionError, OSError) as exc:
                    status = "unreachable"
                    detail = {"reason": str(exc)}
        resolved.append({**copy.deepcopy(item), "resolution": status, **detail})
    required_unreachable = [item for item in resolved
                            if item.get("required") is True and item.get("resolution") != "reachable"]
    read_self_contained = not required_unreachable
    bundle_id = descriptor.get("bundle_id") or ("b_" + sha(canonical(
        [descriptor["selection_digest"], "reference"]))[:24])
    report = {
        "status": "registered_reference" if read_self_contained else "registered_reference_incomplete",
        "bundle_id": bundle_id,
        "format_version": FORMAT,
        "mode": "reference",
        "source_snapshot_id": descriptor.get("source_snapshot_id"),
        "target_snapshot_id": None,
        "selection_digest": descriptor["selection_digest"],
        "external_objects": resolved,
        "required_unreachable": required_unreachable,
        "read_self_contained": read_self_contained,
        "active_head": (engine.state.read() or {}).get("active_head"),
        "write_authority_granted": False,
    }
    record = {
        "format_version": "wfd.bundle-ref/1.0",
        "bundle_id": bundle_id,
        "kind": "reference",
        "state": "registered" if read_self_contained else "incomplete",
        "source_snapshot_id": descriptor.get("source_snapshot_id"),
        "selection_digest": descriptor["selection_digest"],
        "external_objects": resolved,
        "read_self_contained": read_self_contained,
        "registered_at_utc": _now(),
        "files": [],
    }
    with writer_lock(target_store):
        engine._write_immutable(f"catalog/bundles/{bundle_id}.json", canonical(record))
    if (engine.state.read() or {}).get("active_head") != active_before:
        raise ValueError("BUNDLE_UNEXPECTED_HEAD_ACTIVATION")
    return report


def maintain_financial_bundle(*args, **kwargs):
    """P5b maintenance is deliberately closed until a supported entry exists."""
    raise ValueError("BUNDLE_MAINTENANCE_NOT_IMPLEMENTED")



# ---------------------------------------------------------------------------
# R2b structured-data-only package profile (WFD-BASE/1.2 boundary).
# ---------------------------------------------------------------------------

STRUCTURED_BUNDLE_FORMAT = "wfd.structured-bundle/1.0"
STRUCTURED_PROFILE = "wfd.data-only/1.0"
STRUCTURED_TARGET_FORMAT = "wfd.structured-target/1.0"
_STRUCTURED_ROLE_BODY = {
    "semantic": "semantic",
    "read_layout": "read",
    "algorithm_dependency": "compute_dependencies",
    "update_release": "publication",
}
_STRUCTURED_FORBIDDEN = {
    "source_id", "source_ids", "source_roles", "source_url", "license",
    "custody", "raw_source", "raw_source_bytes_custodied", "original_path",
    "original_local_path", "local_path", "file_path", "storage_path", "path",
    "url", "provider", "evidence", "evidence_ref", "processing",
    "processing_evidence", "processing_record", "derived_lineage",
    "bd_ref", "bd_locator", "record_locator", "locator", "original_file_name",
    "original_file", "source_admission", "_wfd_source_admission",
    "may_read", "may_read_evidence", "may_submit", "may_publish_formal",
    "license_ref", "input_refs", "run_log",
}
_STRUCTURED_ALLOWED_CARRIER = {
    "_wfd_data_only", "_wfd_received_time", "_wfd_service_version",
    "_wfd_product_bindings", "_wfd_resolved_product_ids", "_wfd_row_versions",
    "product_service",
}
STRUCTURED_LINEAGE_FORMAT = "wfd.structured-lineage/1.0"
_STRUCTURED_LINEAGE_KEYS = {
    "format_version", "profile", "snapshot_id", "parent_snapshot_id",
    "snapshot_sha256", "manifest_sha256", "files_root",
    "source_dataset_id", "source_snapshot_id", "selection_digest",
    "logical_state_digest", "record_set_digest", "status", "wfd_internal",
}


def _structured_record_set_digest(entries):
    rows = []
    for entry in entries:
        carrier = entry.get("source_bundle") or {}
        product = carrier.get("_wfd_product_bindings", {}).get(entry["output_key"], {}).get("product") or {}
        versions = (carrier.get("_wfd_row_versions") or {}).get(entry["output_key"], {})
        for value in versions.values():
            rows.append([product.get("dataset_id"), entry["product_id"],
                         value.get("logical_key"), value.get("revision_id")])
    return "sha256:" + sha(canonical(sorted(rows, key=canonical)))


def _structured_lineage_body(entries, target_sid, snapshot_bytes, manifest_bytes,
                             source_dataset_id, source_snapshot_id,
                             selection_digest, logical_state_digest,
                             parent_snapshot_id=None, baseline_snapshot_id=None):
    files = sorted([[entry["file_relpath"], entry["file_sha256"]]
                    for entry in entries], key=canonical)
    return {
        "format_version": STRUCTURED_LINEAGE_FORMAT,
        "profile": STRUCTURED_PROFILE,
        "snapshot_id": target_sid,
        "parent_snapshot_id": parent_snapshot_id,
        "snapshot_sha256": "sha256:" + sha(snapshot_bytes),
        "manifest_sha256": "sha256:" + sha(manifest_bytes),
        "files_root": "sha256:" + sha(canonical(files)),
        "source_dataset_id": source_dataset_id,
        "source_snapshot_id": source_snapshot_id,
        "selection_digest": selection_digest,
        "logical_state_digest": logical_state_digest,
        "record_set_digest": _structured_record_set_digest(entries),
        "status": "structured_target_sealed",
        "wfd_internal": True,
        **({"baseline_snapshot_id": baseline_snapshot_id}
           if baseline_snapshot_id is not None else {}),
    }


def _structured_validate_lineage(body, entries, snapshot_bytes, manifest_bytes,
                                 descriptor, *, delta=False):
    if not isinstance(body, dict):
        raise ValueError("STRUCTURED_LINEAGE_TYPE_INVALID")
    allowed = set(_STRUCTURED_LINEAGE_KEYS)
    if delta:
        allowed.add("baseline_snapshot_id")
    unknown = sorted(set(body) - allowed)
    if unknown:
        raise ValueError("STRUCTURED_LINEAGE_FIELD_UNKNOWN:" + unknown[0])
    missing = sorted(allowed - set(body))
    if missing:
        raise ValueError("STRUCTURED_LINEAGE_FIELD_MISSING:" + missing[0])
    string_keys = ("format_version", "profile", "snapshot_id", "snapshot_sha256",
                   "manifest_sha256", "files_root", "source_dataset_id",
                   "source_snapshot_id", "selection_digest", "logical_state_digest",
                   "record_set_digest", "status")
    for key in string_keys:
        if not isinstance(body.get(key), str):
            raise ValueError("STRUCTURED_LINEAGE_TYPE_INVALID:" + key)
    for key in ("snapshot_sha256", "manifest_sha256", "files_root",
                "selection_digest", "logical_state_digest", "record_set_digest"):
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", body[key]):
            raise ValueError("STRUCTURED_LINEAGE_DIGEST_INVALID:" + key)
    expected_parent = (descriptor.get("baseline", {}).get("target_snapshot_id")
                       if delta else None)
    if body.get("parent_snapshot_id") != expected_parent:
        raise ValueError("STRUCTURED_LINEAGE_PARENT_INVALID")
    if body.get("wfd_internal") is not True:
        raise ValueError("STRUCTURED_LINEAGE_INTERNAL_FLAG_INVALID")
    expected = _structured_lineage_body(
        entries, descriptor["target_snapshot_id"], snapshot_bytes, manifest_bytes,
        descriptor["source_dataset_id"], descriptor["source_snapshot_id"],
        descriptor["selection_digest"], descriptor["logical_state_digest"],
        parent_snapshot_id=expected_parent,
        baseline_snapshot_id=(descriptor.get("baseline", {}).get("target_snapshot_id")
                              if delta else None))
    for key, value in expected.items():
        if canonical(body.get(key)) != canonical(value):
            raise ValueError("STRUCTURED_LINEAGE_MISMATCH:" + key)


_STRUCTURED_EXCLUDED = [
    "bd_original_files", "bd_original_paths", "bd_source_ids_refs",
    "bd_evidence_relations", "bd_processing_trace", "bd_method_code_parameters",
    "bd_association_tables", "bd_network_paths", "subject_memory",
]


def _structured_scan_json(value, path="", *, allow_carrier=False):
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = (path + "." + str(key)) if path else str(key)
            if key == "source_bundle":
                if not allow_carrier or not isinstance(child, dict):
                    raise ValueError("BUNDLE_EXTERNAL_METADATA_FORBIDDEN:" + child_path)
                _structured_scan_json(child, child_path, allow_carrier=True)
                continue
            if key == "evidence_refs" and child == []:
                continue
            if key == "source_admission" and child == {}:
                continue
            if key in _STRUCTURED_FORBIDDEN:
                raise ValueError("BUNDLE_EXTERNAL_METADATA_FORBIDDEN:" + child_path)
            _structured_scan_json(child, child_path, allow_carrier=False)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _structured_scan_json(child, f"{path}[{index}]", allow_carrier=False)
    elif isinstance(value, str) and _ABS_PATH.match(value):
        raise ValueError("BUNDLE_ABSOLUTE_PATH_LEAK:" + path)


def _structured_scan_store(root):
    root = Path(root)
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.name.startswith("._"):
            continue
        rel = path.relative_to(root).as_posix()
        if rel.startswith("evidence/") or rel.startswith("catalog/product_service/evidence/"):
            raise ValueError("BUNDLE_EXTERNAL_METADATA_FORBIDDEN:" + rel)
        if rel.endswith(".parquet"):
            for row in rows_from_parquet(path.read_bytes()):
                _structured_scan_json(row, rel + ":row")
        elif rel.endswith(".json") or rel.endswith(".jsonl"):
            if rel.startswith("catalog/lineage/"):
                continue
            try:
                value = _json(path)
            except ValueError as exc:
                raise ValueError("BUNDLE_JSON_INVALID:" + rel) from exc
            if isinstance(value, dict) and isinstance(value.get("files"), list):
                _structured_scan_json({key: item for key, item in value.items()
                                       if key != "files"}, rel)
                for index, entry in enumerate(value["files"]):
                    carrier = entry.get("source_bundle") or {}
                    if set(carrier) - _STRUCTURED_ALLOWED_CARRIER:
                        raise ValueError("BUNDLE_EXTERNAL_METADATA_FORBIDDEN:"
                                         + rel + f".files[{index}].source_bundle")
                    _structured_scan_json({key: item for key, item in entry.items()
                                           if key not in {"source_bundle", "evidence_refs"}},
                                          rel + f".files[{index}]")
                    _structured_scan_json(carrier, rel + f".files[{index}].source_bundle",
                                          allow_carrier=True)
            elif isinstance(value, dict) and "source_bundle" in value:
                carrier = value.get("source_bundle") or {}
                if set(carrier) - _STRUCTURED_ALLOWED_CARRIER:
                    raise ValueError("BUNDLE_EXTERNAL_METADATA_FORBIDDEN:"
                                     + rel + ".source_bundle")
                _structured_scan_json({key: item for key, item in value.items()
                                       if key != "source_bundle"}, rel)
                _structured_scan_json(carrier, rel + ".source_bundle", allow_carrier=True)
            else:
                _structured_scan_json(value, rel)


def _structured_contract_files(dataset_id, product_id, contracts):
    refs, bodies = {}, {}
    for role, body_key in _STRUCTURED_ROLE_BODY.items():
        body = contracts[body_key]
        digest = sha(canonical(body))
        stable = sha(canonical([dataset_id, product_id, role]))[:24]
        ref = {"kind": "contract", "role": role, "dataset_id": dataset_id,
               "namespace": "wfd.product", "id": "contract_" + role + "_" + stable,
               "version": "v_" + digest[:16], "digest": "sha256:" + digest,
               "resolution": "pinned", "required": True, "dependency_type": "read"}
        refs[role] = ref
        bodies[role] = {"digest": digest, "body": copy.deepcopy(body)}
    bundle = {"format_version": "wfd.contract-bundle/1.0",
              "product_id": product_id, "dataset_id": dataset_id,
              "roles": sorted(refs), "contracts": copy.deepcopy(refs)}
    bundle_digest = sha(canonical(bundle))
    bundle_ref = {"kind": "contract_bundle", "dataset_id": dataset_id,
                  "namespace": "wfd.product", "id": "cb_" + bundle_digest[:24],
                  "version": "v_" + bundle_digest[:16],
                  "digest": "sha256:" + bundle_digest, "roles": sorted(refs),
                  "resolution": "pinned", "required": True, "dependency_type": "read"}
    return refs, bundle_ref, bundle, bodies


def _structured_target_product(source, target_pid, fields, selection_digest,
                               source_snapshot_id):
    declared = _declaration_fields(source)
    changed = sorted(fields) != declared
    product = copy.deepcopy(source)
    declaration = copy.deepcopy(source["declaration"])
    contracts = copy.deepcopy(source["contracts"])
    if changed:
        declaration["field_definitions"] = [
            copy.deepcopy(field) for field in declaration.get("field_definitions", [])
            if field.get("field_code") in fields]
        semantic = contracts["semantic"]
        semantic["fields"] = copy.deepcopy(declaration["field_definitions"])
        used = {field.get("unit_code") for field in declaration["field_definitions"]
                if field.get("unit_code") and field.get("unit_code") != "not_applicable"}
        semantic["unit_definitions"] = {
            code: value for code, value in (semantic.get("unit_definitions") or {}).items()
            if code in used}
        definition_digest = sha(canonical(declaration))
        definition_ref = {"kind": "definition_version", "dataset_id": source["dataset_id"],
                          "namespace": "wfd.product", "id": "def_" + definition_digest[:24],
                          "version": "v_" + definition_digest[:16],
                          "digest": "sha256:" + definition_digest,
                          "resolution": "pinned", "required": True,
                          "dependency_type": "read"}
        semantic["definition_ref"] = copy.deepcopy(definition_ref)
        contracts["part_digests"] = {
            key: "sha256:" + sha(canonical(contracts[key]))
            for key in ("semantic", "read", "compute_dependencies", "publication")
            if key in contracts}
        product["definition_ref"] = definition_ref
        product["definition_parent_ref"] = source.get("definition_ref")
        product["definition_compatibility"] = "breaking"
        product["definition_sequence"] = 1
        product["product_family_id"] = "pf_" + sha(canonical(
            ["wfd.structured-field-selection", source.get("product_family_id"),
             sorted(fields), selection_digest]))[:24]
    refs, bundle_ref, bundle, bodies = _structured_contract_files(
        source["dataset_id"], target_pid, contracts)
    legacy_digest = sha(canonical(contracts))
    legacy_ref = {"kind": "contract", "dataset_id": source["dataset_id"],
                  "namespace": "wfd.product", "id": "contract_" + legacy_digest[:24],
                  "version": "v_" + legacy_digest[:16],
                  "digest": "sha256:" + legacy_digest,
                  "resolution": "pinned", "required": True,
                  "dependency_type": "read"}
    product.update({
        "product_id": target_pid,
        "declaration": declaration,
        "contracts": contracts,
        "contract_refs": refs,
        "contract_bundle_ref": bundle_ref,
        "contract_ref": legacy_ref,
        "service_version": STRUCTURED_TARGET_FORMAT,
        "bundle_target": {
            "source_dataset_id": source["dataset_id"],
            "source_snapshot_id": source_snapshot_id,
            "source_product_id": source["product_id"],
            "target_product_id": target_pid,
            "selection_digest": selection_digest,
        },
    })
    return product, bodies, bundle, legacy_ref, changed


def _structured_write_catalog(root, product, bodies, bundle, legacy_ref, dataset_id):
    root = Path(root)
    _write_json(root / "catalog/product_service/dataset.json", {"dataset_id": dataset_id})
    definition = {"definition_ref": product["definition_ref"],
                  "declaration": product["declaration"]}
    definition_digest = product["definition_ref"]["digest"].removeprefix("sha256:")
    _write_json(root / f"catalog/product_service/definitions/{definition_digest}.json", definition)
    for role, item in bodies.items():
        _write_json(root / f"catalog/product_service/contracts/{role}/{item['digest']}.json",
                    item["body"])
    bundle_digest = product["contract_bundle_ref"]["digest"].removeprefix("sha256:")
    _write_json(root / f"catalog/product_service/contract_bundles/{bundle_digest}.json", bundle)
    legacy_digest = legacy_ref["digest"].removeprefix("sha256:")
    _write_json(root / f"catalog/product_service/contracts/{legacy_digest}.json",
                {"contract_ref": legacy_ref, "contracts": product["contracts"]})
    _write_json(root / f"catalog/product_service/products/{product['product_id']}.json", product)
    _write_json(root / f"catalog/product_service/products/{product['product_id']}/definition_1.json",
                product)


def _structured_rows(service, product, rows, fields, business_range, source_product_id,
                     selected_subject=None, version_overrides=None):
    query = ProductQuery(service)
    normalized = (query._business_time_range({"business_time_range": business_range})
                  if business_range is not None else None)
    selected, record_map = [], []
    expected_subject = selected_subject or product.get("subject")
    for item in rows:
        if item.get("subject") != expected_subject:
            continue
        if normalized is not None:
            role = normalized["role"] if normalized else "observation"
            business_time, code, _ = query._row_business_time(
                item.get("row") or {}, role, product)
            if code or query._time_decision(business_time, normalized) != "contained":
                continue
        row = copy.deepcopy(item["row"] or {})
        if product.get("payload_kind") == "scalar_rows":
            if sorted(fields) != ["value_decimal"]:
                raise ValueError("STRUCTURED_FIELD_SELECTION_INVALID")
        else:
            values = row.get("values") or {}
            missing = [code for code in fields if code not in values]
            if missing:
                raise ValueError("STRUCTURED_FIELD_MISSING:" + ",".join(sorted(missing)))
            row["values"] = {code: values[code] for code in fields}
        revision = copy.deepcopy(item.get("revision") or {})
        override = (version_overrides or {}).get(revision.get("logical_key"))
        if override is not None:
            revision = copy.deepcopy(override)
        key_field = "event_id" if product.get("payload_kind") == "event_records" else "business_key"
        physical = _target_physical_key(revision)
        row[key_field] = physical
        clean, _ = _sanitize_rows([row], fields=None, key_field=key_field)
        row = clean[0]
        selected.append((row, revision, physical))
        record_map.append({
            "source_dataset_id": product["dataset_id"],
            "source_product_id": source_product_id,
            "source_record_id": item.get("record_id") or revision.get("logical_key"),
            "source_record_version": item.get("record_version") or revision.get("revision_id"),
            "target_product_id": None,
            "target_record_id": revision.get("logical_key"),
            "target_record_version": revision.get("revision_id"),
            "target_snapshot_id": None,
        })
    if not selected:
        raise ValueError("STRUCTURED_SELECTION_EMPTY:" + product["product_id"])
    return selected, normalized, record_map


def export_structured_bundle(service, product_ids, destination, *, snapshot_id,
                             selection=None, perspective="snapshot_contents"):
    """Export only WFD structured records plus internal definitions/contracts."""
    if service.has_permission("export") is not True:
        raise PermissionError("WFD_EXPORT_PERMISSION_REQUIRED")
    if perspective != "snapshot_contents":
        raise ValueError("STRUCTURED_PERSPECTIVE_NOT_IMPLEMENTED")
    destination = Path(destination)
    if destination.exists():
        raise ValueError("BUNDLE_DESTINATION_EXISTS")
    snapshot = _bundle_snapshot(service.engine, snapshot_id)
    discovered = service.discover_products(snapshot_id=snapshot_id)["products"]
    by_id = {product["product_id"]: product for product in discovered}
    raw_selection = _normalize_selection(selection, sorted(set(product_ids or [])))
    selection_products = []
    for item in raw_selection["products"]:
        product = by_id.get(item["product_id"])
        if product is None:
            raise ValueError("STRUCTURED_PRODUCT_NOT_FOUND:" + item["product_id"])
        if _read_dependencies(product):
            raise ValueError("STRUCTURED_READ_DEPENDENCY_NOT_IMPLEMENTED:"
                             + item["product_id"])
        fields = item["fields"] or _declaration_fields(product)
        selection_products.append({**item, "fields": sorted(fields),
                                   "product": product})
    selection_core = {
        "profile": STRUCTURED_PROFILE,
        "perspective": perspective,
        "source_dataset_id": (snapshot.get("receipt", {}).get("dataset_id")
                             or (selection_products[0]["product"].get("dataset_id")
                                 if selection_products else None)
                             or _dataset_id(service)),
        "source_snapshot_id": snapshot_id,
        "products": [{
            "product_id": item["product_id"],
            "fields": item["fields"],
            "subject": copy.deepcopy(item["subject"]),
            "business_time_range": copy.deepcopy(item["business_time_range"]),
        } for item in sorted(selection_products, key=lambda value: value["product_id"])],
    }
    selection_digest = "sha256:" + sha(canonical(selection_core))
    normalized_digest = _structured_normalized_digest(selection_core)
    target_sid = "s_" + sha(canonical([STRUCTURED_BUNDLE_FORMAT, selection_digest]))[:24]
    target_products, target_entries, included_reads, record_map = [], [], [], []
    temp_parent = destination.parent
    temp_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".wfd_structured_target_", dir=temp_parent) as temp:
        root = Path(temp) / "store"
        engine = WFDDuckDBPrototype(root, load_protocol_validator(
            Path(__file__).resolve().parents[1] / "protocol"),
            runtime_root=Path(str(root) + "_runtime"), sandbox=False, writer_host=None)
        for item in sorted(selection_products, key=lambda value: value["product_id"]):
            source = item["product"]
            fields = item["fields"]
            target_pid = source["product_id"]
            if sorted(fields) != _declaration_fields(source):
                target_pid = "p_" + sha(canonical([
                    "wfd.structured-field-selection", source["product_id"],
                    sorted(fields), selection_digest]))[:24]
            target_product, bodies, bundle, legacy_ref, changed = _structured_target_product(
                source, target_pid, fields, selection_digest, snapshot_id)
            _structured_write_catalog(root, target_product, bodies, bundle, legacy_ref,
                                      source["dataset_id"])
            rows = service.read(source["product_id"], snapshot_id=snapshot_id,
                                include_history=False)["rows"]
            selected_subject = item.get("subject")
            if selected_subject is not None and selected_subject != source.get("subject"):
                raise ValueError("STRUCTURED_SUBJECT_NOT_IN_PRODUCT_SCOPE:"
                                 + str(selected_subject))
            selected, normalized, row_map = _structured_rows(
                service, target_product, rows, fields, item["business_time_range"],
                source["product_id"], selected_subject=selected_subject)
            output_key = next(entry["output_key"] for entry in snapshot["files"]
                              if entry["product_id"] == source["product_id"])
            parquet_rows = [row for row, _, _ in selected]
            raw = parquet_from_rows(target_pid, output_key, target_product["subject"],
                                    target_product["payload_kind"], parquet_rows)
            digest = sha(raw)
            rel = f"{target_product['logical_domain']}/product={target_pid}/part-{digest[:24]}.parquet"
            engine._write_immutable(rel, raw)
            versions = {physical: revision for _, revision, physical in selected}
            target_product = _clean_paths(target_product, [], [])
            carrier = {
                "_wfd_data_only": True,
                "_wfd_received_time": copy.deepcopy(UNKNOWN_TIME),
                "_wfd_service_version": STRUCTURED_TARGET_FORMAT,
                "_wfd_product_bindings": {output_key: {
                    "product": target_product, "source_role_mode": "data_only",
                    "source_admission": {}}},
                "_wfd_resolved_product_ids": {output_key: target_pid},
                "_wfd_row_versions": {output_key: versions},
                "product_service": {"version": "wfd.product-service/0.3",
                                    "outputs": {}, "consistency_groups": {}},
            }
            entry = {
                "product_id": target_pid,
                "output_key": output_key,
                "file_relpath": rel,
                "file_sha256": digest,
                "row_count": len(parquet_rows),
                "definition": copy.deepcopy(target_product["declaration"]),
                "subject": copy.deepcopy(target_product["subject"]),
                "source_bundle": carrier,
                "evidence_refs": [],
                "input_mode": "partial_observation",
                "payload_kind": target_product["payload_kind"],
            }
            target_entries.append(entry)
            target_products.append(target_product)
            for record in row_map:
                if record["source_product_id"] == source["product_id"]:
                    record["target_product_id"] = target_pid
                    record["target_snapshot_id"] = target_sid
                    record_map.append(record)
            included_reads.append({
                "source_dataset_id": source["dataset_id"],
                "source_product_id": source["product_id"],
                "target_dataset_id": target_product["dataset_id"],
                "target_snapshot_id": target_sid,
                "target_product_id": target_pid,
                "fields": sorted(fields),
                "row_count": len(parquet_rows),
                "rows_sha256": "sha256:" + sha(canonical(parquet_rows)),
                "record_ids": sorted(version["logical_key"] for version in versions.values()),
                "record_versions": sorted(version["revision_id"] for version in versions.values()),
            })
        # source WFD publication proof is internal, not a BD evidence/lineage closure
        proof_records = []
        proof_ref = None
        source_key = snapshot.get("request_key")
        source_proof = Path(service.root) / f"catalog/product_service/data_only_formal_publications/{source_key}.json"
        if source_proof.is_file():
            raw = source_proof.read_bytes()
            _structured_scan_json(json.loads(raw), "source_publication_proof")
            proof_rel = f"catalog/product_service/source_wfd_publication_proofs/{source_key}.json"
            engine._write_immutable(proof_rel, raw)
            proof_records.append({"relative_path": proof_rel, "sha256": sha(raw),
                                  "size": len(raw), "kind": "source_wfd_publication_proof"})
            proof_ref = {"request_key": source_key, "digest": "sha256:" + sha(raw),
                         "relative_path": proof_rel}
        logical_state = {
            "profile": STRUCTURED_PROFILE,
            "selection_digest": selection_digest,
            "target_snapshot_id": target_sid,
            "products": [{"target_product_id": product["product_id"],
                          "definition_digest": product["definition_ref"]["digest"],
                          "contract_bundle_digest": product["contract_bundle_ref"]["digest"],
                          "row_count": entry["row_count"],
                          "rows_sha256": "sha256:" + sha(canonical(
                              rows_from_parquet((root / entry["file_relpath"]).read_bytes())))}
                         for product, entry in zip(target_products, target_entries)],
            "record_map": record_map,
        }
        logical_digest = "sha256:" + sha(canonical(logical_state))
        receipt = {
            "format_version": STRUCTURED_TARGET_FORMAT, "profile": STRUCTURED_PROFILE,
            "status": "structured_target_sealed", "snapshot_id": target_sid,
            "source_dataset_id": selection_core["source_dataset_id"],
            "source_snapshot_id": snapshot_id,
            "source_product_ids": [item["product_id"] for item in selection_products],
            "target_product_ids": [product["product_id"] for product in target_products],
            "selection_digest": selection_digest,
            "normalized_selection_digest": normalized_digest,
            "logical_state_digest": logical_digest,
            "record_map": record_map, "bd_required": False,
            "source_permission_required": False,
            "formal_source_receipt": False, "write_authority_granted": False,
            "excluded": copy.deepcopy(_STRUCTURED_EXCLUDED),
        }
        manifest = {"parent_snapshot_id": None, "files": target_entries}
        mraw = canonical(manifest)
        mhash = sha(mraw)
        mrel = f"catalog/manifests/manifest_{mhash[:24]}.json"
        engine._write_immutable(mrel, mraw)
        snap = {"snapshot_id": target_sid, "parent_snapshot_id": None,
                "manifest_relpath": mrel, "manifest_sha256": mhash,
                "files": target_entries, "metadata_versions": [],
                "request_key": "structured_" + selection_digest.removeprefix("sha256:")[:24],
                "request_fingerprint": logical_digest, "receipt": receipt}
        sraw = canonical(snap)
        srel = f"catalog/snapshots/{target_sid}.json"
        engine._write_immutable(srel, sraw)
        engine._write_immutable(f"catalog/commits/{target_sid}.json",
                                canonical({"snapshot_id": target_sid,
                                           "snapshot_file": srel,
                                           "snapshot_sha256": sha(sraw)}))
        engine._write_immutable(
            f"catalog/lineage/{target_sid}.json",
            canonical(_structured_lineage_body(
                target_entries, target_sid, sraw, mraw,
                selection_core["source_dataset_id"], snapshot_id,
                selection_digest, logical_digest)))
        destination.mkdir(parents=True)
        storage_rel = "storage/" + target_sid
        export_package(root, target_sid, destination / storage_rel)
        (destination / "objects").mkdir()
        records = []
        for path in sorted((root / "catalog/product_service").rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(root).as_posix()
            raw = path.read_bytes()
            digest = sha(raw)
            (destination / "objects" / digest).write_bytes(raw)
            records.append({"relative_path": rel, "sha256": digest,
                            "size": len(raw), "kind": "wfd_internal_catalog"})
        if proof_records:
            records = [record for record in records
                       if record["relative_path"] != proof_records[0]["relative_path"]]
            records.extend(proof_records)
        descriptor = {
            "format_version": STRUCTURED_BUNDLE_FORMAT,
            "profile": STRUCTURED_PROFILE,
            "mode": "full",
            "bundle_id": "sb_" + sha(canonical([selection_digest, target_sid]))[:24],
            "perspective": perspective,
            "selection": copy.deepcopy(selection_core),
            "selection_digest": selection_digest,
            "normalized_selection_digest": normalized_digest,
            "logical_state": logical_state,
            "logical_state_digest": logical_digest,
            "source_dataset_id": selection_core["source_dataset_id"],
            "source_snapshot_id": snapshot_id,
            "selected_source_product_ids": [item["product_id"] for item in selection_products],
            "target_snapshot_id": target_sid,
            "source_target_map": {
                "snapshots": [{"source_dataset_id": selection_core["source_dataset_id"],
                               "source_snapshot_id": snapshot_id,
                               "target_snapshot_id": target_sid}],
                "products": [{"source_product_id": source, "target_product_id": target}
                             for source, target in sorted({
                                 (item["source_product_id"], item["target_product_id"])
                                 for item in record_map if item["target_product_id"]})],
            },
            "record_map": record_map,
            "bd_association_scope": {
                "source_dataset_id": selection_core["source_dataset_id"],
                "source_product_ids": sorted({item["source_product_id"] for item in record_map}),
                "record_ids": sorted({item["source_record_id"] for item in record_map}),
                "record_versions": sorted({item["source_record_version"] for item in record_map}),
                "note": "BD restores its own source/evidence mapping from these WFD identities; "
                        "no BD mapping table is carried.",
            },
            "included_reads": included_reads,
            "read_dependencies": [],
            "records": records,
            "storage_packages": [{"snapshot_id": target_sid, "directory": storage_rel}],
            "source_publication_proof": proof_ref,
            "carrier": {
                "engine_key": "source_bundle",
                "purpose": "internal engine carrier only; no external source, evidence or BD lineage",
                "allowed_keys": sorted(_STRUCTURED_ALLOWED_CARRIER),
            },
            "wfd_permissions": {
                "export_role_checked": True,
                "import_requires_wfd_read_role": True,
                "source_permissions_required": False,
                "redistribution_permissions_in_package": False,
            },
            "read_self_contained": True,
            "bd_required": False,
            "source_permission_required": False,
            "write_authority_granted": False,
            "excluded": copy.deepcopy(_STRUCTURED_EXCLUDED),
        }
        (destination / "financial_bundle.json").write_bytes(canonical(descriptor))
        inventory = [{"path": p.relative_to(destination).as_posix(),
                      "sha256": sha_file(p), "size": p.stat().st_size}
                     for p in sorted(destination.rglob("*"))
                     if p.is_file() and p.name != "CHECKSUMS.json"]
        (destination / "CHECKSUMS.json").write_bytes(canonical(inventory))
        _verify_structured_bundle(destination)
        return descriptor


_STRUCTURED_HEX = re.compile(r"^[0-9a-f]{64}$")
_STRUCTURED_PID = re.compile(r"^p_[a-zA-Z0-9_.:-]{1,120}$")


def _structured_safe_rel(rel, *, prefixes=None, allow_empty=False):
    if not isinstance(rel, str) or (not rel and not allow_empty):
        raise ValueError("STRUCTURED_PATH_INVALID:" + repr(rel))
    if "\\" in rel or rel.startswith("/") or re.match(r"^[A-Za-z]:", rel):
        raise ValueError("STRUCTURED_PATH_INVALID:" + rel)
    parts = PurePosixPath(rel).parts
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("STRUCTURED_PATH_INVALID:" + rel)
    if prefixes and not any(rel == prefix or rel.startswith(prefix if prefix.endswith("/") else prefix + "/")
                            for prefix in prefixes):
        raise ValueError("STRUCTURED_PATH_NOT_ALLOWED:" + rel)
    return rel


def _structured_safe_target(root, rel, *, prefixes=None):
    _structured_safe_rel(rel, prefixes=prefixes)
    root = Path(root).resolve()
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise ValueError("STRUCTURED_PATH_ESCAPE:" + rel)
    cursor = root
    for part in PurePosixPath(rel).parts:
        cursor = cursor / part
        if cursor.exists() and cursor.is_symlink():
            raise ValueError("STRUCTURED_SYMLINK_FORBIDDEN:" + rel)
    return target


def _structured_record_allowed(rel):
    hex64 = r"[0-9a-f]{64}"
    pid = r"p_[a-zA-Z0-9_.:-]{1,120}"
    if rel == "catalog/product_service/dataset.json":
        return True
    patterns = [
        rf"catalog/product_service/definitions/{hex64}\.json",
        rf"catalog/product_service/contracts/{hex64}\.json",
        rf"catalog/product_service/contracts/(semantic|read_layout|algorithm_dependency|update_release)/{hex64}\.json",
        rf"catalog/product_service/contract_bundles/{hex64}\.json",
        rf"catalog/product_service/products/{pid}\.json",
        rf"catalog/product_service/products/{pid}/definition_[0-9]+\.json",
        rf"catalog/product_service/source_wfd_publication_proofs/{hex64}\.json",
    ]
    return any(re.fullmatch(pattern, rel) for pattern in patterns)


def _structured_scan_bytes(rel, raw):
    if rel.endswith(".parquet"):
        for row in rows_from_parquet(raw):
            _structured_scan_json(row, rel + ":row")
        return
    if rel.endswith(".json"):
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ValueError("STRUCTURED_JSON_INVALID:" + rel) from exc
        if rel.startswith("catalog/lineage/"):
            # Exact WFD internal checkpoint schema is validated separately
            # against the actual snapshot/manifest/record set.
            return
        if (rel.startswith(("catalog/snapshots/", "catalog/manifests/"))
                and isinstance(value, dict) and isinstance(value.get("files"), list)):
            _structured_scan_json({key: item for key, item in value.items()
                                   if key != "files"}, rel)
            for index, entry in enumerate(value["files"]):
                carrier = entry.get("source_bundle") or {}
                if set(carrier) - _STRUCTURED_ALLOWED_CARRIER:
                    raise ValueError("BUNDLE_EXTERNAL_METADATA_FORBIDDEN:"
                                     + rel + f".files[{index}].source_bundle")
                _structured_scan_json({key: item for key, item in entry.items()
                                       if key not in {"source_bundle", "evidence_refs"}},
                                      rel + f".files[{index}]")
                _structured_scan_json(carrier, rel + f".files[{index}].source_bundle",
                                      allow_carrier=True)
            return
        _structured_scan_json(value, rel)
        return
    raise ValueError("STRUCTURED_OBJECT_ROLE_UNKNOWN:" + rel)


def _structured_products_from_snapshot(snap):
    products = {}
    for entry in snap.get("files", []):
        carrier = entry.get("source_bundle") or {}
        product = carrier.get("_wfd_product_bindings", {}).get(entry["output_key"], {}).get("product")
        if product:
            products[entry["product_id"]] = product
    return products


def _structured_assert_no_read_dependencies(descriptor, products):
    declared = descriptor.get("read_dependencies", [])
    if not isinstance(declared, list):
        raise ValueError("STRUCTURED_READ_DEPENDENCY_INVALID")
    if declared:
        raise ValueError("STRUCTURED_READ_DEPENDENCY_NOT_IMPLEMENTED")
    for pid, product in products.items():
        read = (product.get("contracts") or {}).get("read") or {}
        dependencies = read.get("dependencies", [])
        if not isinstance(dependencies, list):
            raise ValueError("STRUCTURED_READ_DEPENDENCY_INVALID:" + pid)
        if dependencies:
            raise ValueError("STRUCTURED_READ_DEPENDENCY_NOT_IMPLEMENTED:inner:" + pid)
        if not (product.get("contract_refs") or {}).get("read_layout"):
            raise ValueError("STRUCTURED_READ_LAYOUT_REF_MISSING:" + pid)


def _structured_verified(descriptor, snap, files, catalog):
    target_sid = snap["snapshot_id"]
    _structured_assert_no_read_dependencies(
        descriptor, _structured_products_from_snapshot(snap))
    products, records_by_product = {}, {}
    for entry in snap.get("files", []):
        pid = entry["product_id"]
        carrier = entry.get("source_bundle") or {}
        product = carrier.get("_wfd_product_bindings", {}).get(entry["output_key"], {}).get("product")
        if not product or product.get("product_id") != pid:
            raise ValueError("STRUCTURED_PRODUCT_BINDING_MISSING")
        products[pid] = product
        versions = (carrier.get("_wfd_row_versions") or {}).get(entry["output_key"], {})
        records_by_product[pid] = {
            (value.get("logical_key"), value.get("revision_id")): value
            for value in versions.values()}
    product_map = {}
    for pid, product in products.items():
        target = product.get("bundle_target") or {}
        if (target.get("target_product_id") != pid
                or target.get("source_snapshot_id") != descriptor.get("source_snapshot_id")
                or target.get("selection_digest") != descriptor.get("selection_digest")):
            raise ValueError("STRUCTURED_BUNDLE_TARGET_PROOF_MISMATCH:" + pid)
        source_pid = target.get("source_product_id")
        if source_pid not in set(descriptor.get("selected_source_product_ids") or []):
            raise ValueError("STRUCTURED_SOURCE_PRODUCT_SCOPE_MISMATCH:" + pid)
        if source_pid in product_map:
            raise ValueError("STRUCTURED_PRODUCT_MAP_DUPLICATE:" + source_pid)
        product_map[source_pid] = pid
    expected_map, seen = [], set()
    for source_pid, target_pid in product_map.items():
        for (record_id, version) in records_by_product[target_pid]:
            key = (source_pid, record_id, version)
            if key in seen:
                raise ValueError("STRUCTURED_RECORD_MAP_DUPLICATE")
            seen.add(key)
            expected_map.append({
                "source_dataset_id": descriptor["source_dataset_id"],
                "source_product_id": source_pid,
                "source_record_id": record_id,
                "source_record_version": version,
                "target_product_id": target_pid,
                "target_record_id": record_id,
                "target_record_version": version,
                "target_snapshot_id": target_sid,
            })
    claimed = descriptor.get("record_map") or []
    if canonical(sorted(expected_map, key=canonical)) != canonical(sorted(claimed, key=canonical)):
        raise ValueError("STRUCTURED_RECORD_MAP_MISMATCH")
    claimed_products = descriptor.get("source_target_map", {}).get("products") or []
    expected_products = [{"source_product_id": source, "target_product_id": target}
                         for source, target in sorted(product_map.items())]
    if canonical(sorted(expected_products, key=canonical)) != canonical(sorted(claimed_products, key=canonical)):
        raise ValueError("STRUCTURED_SOURCE_TARGET_MAP_MISMATCH")
    derived_scope = {
        "source_dataset_id": descriptor["source_dataset_id"],
        "source_product_ids": sorted(product_map),
        "record_ids": sorted({item["source_record_id"] for item in expected_map}),
        "record_versions": sorted({item["source_record_version"] for item in expected_map}),
        "note": "BD restores its own source/evidence mapping from these WFD identities; "
                "no BD mapping table is carried.",
    }
    claimed_scope = descriptor.get("bd_association_scope") or {}
    if (claimed_scope.get("source_dataset_id") != derived_scope["source_dataset_id"]
            or sorted(claimed_scope.get("source_product_ids") or []) != derived_scope["source_product_ids"]
            or sorted(claimed_scope.get("record_ids") or []) != derived_scope["record_ids"]
            or sorted(claimed_scope.get("record_versions") or []) != derived_scope["record_versions"]):
        raise ValueError("STRUCTURED_BD_SCOPE_MISMATCH")
    # Contract/definition/product files are checked from their actual bodies,
    # not from descriptor checksums alone.
    dataset_rel = "catalog/product_service/dataset.json"
    if dataset_rel not in catalog or _json_bytes(catalog[dataset_rel]).get("dataset_id") != descriptor["source_dataset_id"]:
        raise ValueError("STRUCTURED_DATASET_FILE_MISMATCH")
    expected_files = {dataset_rel}
    proof = descriptor.get("source_publication_proof") or {}
    if proof.get("relative_path"):
        _structured_safe_rel(proof["relative_path"])
        expected_files.add(proof["relative_path"])
    for pid, product in products.items():
        definition = product["definition_ref"]
        dd = definition["digest"].removeprefix("sha256:")
        drel = f"catalog/product_service/definitions/{dd}.json"
        expected_files.add(drel)
        if drel not in catalog:
            raise ValueError("STRUCTURED_DEFINITION_FILE_MISSING:" + pid)
        body = _json_bytes(catalog[drel])
        if canonical(body) != canonical({"definition_ref": definition,
                                         "declaration": product["declaration"]}):
            raise ValueError("STRUCTURED_DEFINITION_BODY_MISMATCH:" + pid)
        roles = product.get("contract_refs") or {}
        if set(roles) != set(_STRUCTURED_ROLE_BODY):
            raise ValueError("STRUCTURED_CONTRACT_ROLE_SET_MISMATCH:" + pid)
        for role, body_key in _STRUCTURED_ROLE_BODY.items():
            ref = roles[role]
            digest = ref["digest"].removeprefix("sha256:")
            rel = f"catalog/product_service/contracts/{role}/{digest}.json"
            expected_files.add(rel)
            if rel not in catalog:
                raise ValueError("STRUCTURED_CONTRACT_FILE_MISSING:" + role)
            contract_body = _json_bytes(catalog[rel])
            if canonical(contract_body) != canonical(product["contracts"][body_key]):
                raise ValueError("STRUCTURED_CONTRACT_BODY_MISMATCH:" + role)
            if role == "read_layout" and contract_body.get("dependencies", []):
                raise ValueError("STRUCTURED_READ_DEPENDENCY_NOT_IMPLEMENTED:read_layout")
            stable = sha(canonical([product["dataset_id"], pid, role]))[:24]
            if (ref.get("role") != role or ref.get("dataset_id") != product["dataset_id"]
                    or ref.get("id") != "contract_" + role + "_" + stable
                    or ref.get("version") != "v_" + digest[:16]):
                raise ValueError("STRUCTURED_CONTRACT_REF_MISMATCH:" + role)
        bundle_ref = product["contract_bundle_ref"]
        bd = bundle_ref["digest"].removeprefix("sha256:")
        brel = f"catalog/product_service/contract_bundles/{bd}.json"
        expected_files.add(brel)
        if brel not in catalog:
            raise ValueError("STRUCTURED_CONTRACT_BUNDLE_MISSING:" + pid)
        bundle_body = _json_bytes(catalog[brel])
        expected_bundle = {"format_version": "wfd.contract-bundle/1.0",
                           "product_id": pid, "dataset_id": product["dataset_id"],
                           "roles": sorted(roles), "contracts": copy.deepcopy(roles)}
        if canonical(bundle_body) != canonical(expected_bundle):
            raise ValueError("STRUCTURED_CONTRACT_BUNDLE_BODY_MISMATCH:" + pid)
        legacy = product["contract_ref"]["digest"].removeprefix("sha256:")
        lrel = f"catalog/product_service/contracts/{legacy}.json"
        expected_files.add(lrel)
        if lrel not in catalog or canonical(_json_bytes(catalog[lrel])) != canonical(
                {"contract_ref": product["contract_ref"], "contracts": product["contracts"]}):
            raise ValueError("STRUCTURED_LEGACY_CONTRACT_MISMATCH:" + pid)
        prel = f"catalog/product_service/products/{pid}.json"
        expected_files.add(prel)
        if prel not in catalog or canonical(_json_bytes(catalog[prel])) != canonical(product):
            raise ValueError("STRUCTURED_PRODUCT_FILE_MISMATCH:" + pid)
        pdrel = f"catalog/product_service/products/{pid}/definition_1.json"
        expected_files.add(pdrel)
        if pdrel not in catalog or canonical(_json_bytes(catalog[pdrel])) != canonical(product):
            raise ValueError("STRUCTURED_PRODUCT_DEFINITION_FILE_MISMATCH:" + pid)
    if set(catalog) != expected_files:
        raise ValueError("STRUCTURED_CATALOG_RECORD_SET_MISMATCH")
    return expected_map, product_map, derived_scope


def _json_bytes(raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValueError("STRUCTURED_JSON_INVALID") from exc


def _verify_structured_bundle(bundle):
    bundle = Path(bundle)
    for path in bundle.rglob("*"):
        if path.is_symlink():
            raise ValueError("STRUCTURED_SYMLINK_FORBIDDEN:" + path.relative_to(bundle).as_posix())
    descriptor = _json(bundle / "financial_bundle.json")
    if (descriptor.get("format_version") != STRUCTURED_BUNDLE_FORMAT
            or descriptor.get("profile") != STRUCTURED_PROFILE
            or descriptor.get("mode") != "full"):
        raise ValueError("STRUCTURED_BUNDLE_PROFILE_INVALID")
    _structured_scan_json(descriptor, "financial_bundle")
    inventory = _json(bundle / "CHECKSUMS.json")
    listed = set()
    for item in inventory:
        rel = _structured_safe_rel(item["path"])
        path = _structured_safe_target(bundle, rel)
        if (not path.is_file() or path.is_symlink() or path.stat().st_size != item["size"]
                or sha_file(path) != item["sha256"] or rel in listed):
            raise ValueError("BUNDLE_INTEGRITY_FAILED:" + rel)
        listed.add(rel)
    actual = {p.relative_to(bundle).as_posix() for p in bundle.rglob("*") if p.is_file()}
    if actual != listed | {"CHECKSUMS.json"}:
        raise ValueError("BUNDLE_INVENTORY_MISMATCH")
    selection = descriptor.get("selection") or {}
    selection_digest = "sha256:" + sha(canonical(selection))
    if selection_digest != descriptor.get("selection_digest"):
        raise ValueError("STRUCTURED_SELECTION_DIGEST_MISMATCH")
    target_sid = "s_" + sha(canonical([STRUCTURED_BUNDLE_FORMAT, selection_digest]))[:24]
    if target_sid != descriptor.get("target_snapshot_id"):
        raise ValueError("STRUCTURED_TARGET_ID_MISMATCH")
    if "sha256:" + sha(canonical(descriptor.get("logical_state"))) != descriptor.get(
            "logical_state_digest"):
        raise ValueError("STRUCTURED_LOGICAL_STATE_MISMATCH")
    if descriptor.get("source_permission_required") is not False:
        raise ValueError("STRUCTURED_SOURCE_PERMISSION_CLAIM")
    if len(descriptor.get("storage_packages", [])) != 1:
        raise ValueError("STRUCTURED_STORAGE_PACKAGE_INVALID")
    package = descriptor["storage_packages"][0]
    directory = _structured_safe_target(bundle, package["directory"])
    checked = verify_package(directory)
    if not checked["ok"] or checked["transfer"]["target_snapshot_id"] != target_sid:
        raise ValueError("BUNDLE_STORAGE_INTEGRITY_FAILED")
    seen_objects, seen_meta, seen_rels = set(), set(), set()
    lineage_raw = None
    for obj in checked["inventory"]["objects"]:
        if not _STRUCTURED_HEX.match(str(obj.get("sha256"))) or obj["sha256"] in seen_objects:
            raise ValueError("STRUCTURED_OBJECT_ID_INVALID")
        seen_objects.add(obj["sha256"])
        raw = (directory / "objects" / obj["sha256"]).read_bytes()
        if sha(raw) != obj["sha256"]:
            raise ValueError("STRUCTURED_OBJECT_HASH_MISMATCH")
        roles = set()
        for rel in obj.get("rel_paths") or []:
            _structured_safe_rel(rel, prefixes=("observations/", "foundation/", "events/"))
            if rel in seen_rels:
                raise ValueError("STRUCTURED_DUPLICATE_ALIAS:" + rel)
            seen_rels.add(rel)
            if not rel.endswith(".parquet"):
                raise ValueError("STRUCTURED_OBJECT_ROLE_UNKNOWN:" + rel)
            roles.add("parquet")
        if len(roles) != 1:
            raise ValueError("STRUCTURED_OBJECT_ROLE_MIXED")
        _structured_scan_bytes(sorted(obj["rel_paths"])[0], raw)
    for meta in checked["inventory"]["metadata"]:
        rel = _structured_safe_rel(meta["rel_path"])
        if not _STRUCTURED_HEX.match(str(meta.get("sha256"))) or rel in seen_meta:
            raise ValueError("STRUCTURED_METADATA_ID_INVALID")
        seen_meta.add(rel)
        if not (rel == f"catalog/snapshots/{target_sid}.json"
                or rel == f"catalog/commits/{target_sid}.json"
                or rel == f"catalog/lineage/{target_sid}.json"
                or re.match(r"^catalog/manifests/manifest_[0-9a-f]{24}\.json$", rel)):
            raise ValueError("STRUCTURED_METADATA_PATH_NOT_ALLOWED:" + rel)
        raw = (directory / "objects" / meta["sha256"]).read_bytes()
        if sha(raw) != meta["sha256"]:
            raise ValueError("STRUCTURED_METADATA_HASH_MISMATCH")
        if rel == f"catalog/lineage/{target_sid}.json":
            lineage_raw = raw
        _structured_scan_bytes(rel, raw)
    snap_rel = f"catalog/snapshots/{target_sid}.json"
    _, files = _package_files(directory)
    snap = _json_bytes(files[snap_rel])
    if snap.get("snapshot_id") != target_sid or snap.get("parent_snapshot_id") is not None:
        raise ValueError("STRUCTURED_TARGET_SNAPSHOT_INVALID")
    _structured_assert_no_read_dependencies(descriptor,
                                            _structured_products_from_snapshot(snap))
    if lineage_raw is None:
        raise ValueError("STRUCTURED_LINEAGE_MISSING")
    manifest_bytes = files[snap["manifest_relpath"]]
    manifest = _json_bytes(manifest_bytes)
    commit = _json_bytes(files[f"catalog/commits/{target_sid}.json"])
    _structured_validate_full_metadata(manifest, snap, commit, files, descriptor)
    _structured_validate_lineage(_json_bytes(lineage_raw), snap["files"],
                                 files[snap_rel], manifest_bytes, descriptor)
    expected = {item["target_product_id"]: item for item in descriptor["included_reads"]}
    seen = set()
    for entry in snap.get("files", []):
        pid = entry["product_id"]
        if pid not in expected or pid in seen:
            raise ValueError("STRUCTURED_PRODUCT_SET_MISMATCH")
        seen.add(pid)
        rel = _structured_safe_rel(entry["file_relpath"],
                                   prefixes=("observations/", "foundation/", "events/"))
        if not rel.endswith(".parquet") or rel not in seen_rels:
            raise ValueError("STRUCTURED_DATA_PATH_INVALID:" + rel)
        carrier = entry.get("source_bundle") or {}
        if set(carrier) - _STRUCTURED_ALLOWED_CARRIER:
            raise ValueError("BUNDLE_EXTERNAL_METADATA_FORBIDDEN:source_bundle")
        if entry.get("evidence_refs") != []:
            raise ValueError("BUNDLE_EXTERNAL_METADATA_FORBIDDEN:evidence_refs")
        raw = files.get(rel)
        if raw is None or sha(raw) != entry["file_sha256"]:
            raise ValueError("STRUCTURED_FILE_HASH_MISMATCH:" + pid)
        rows = rows_from_parquet(raw)
        item = expected[pid]
        if len(rows) != item["row_count"] or "sha256:" + sha(canonical(rows)) != item["rows_sha256"]:
            raise ValueError("STRUCTURED_ROW_MISMATCH:" + pid)
        for row in rows:
            _structured_scan_json(row, f"{pid}:row")
            if set(row.get("values") or {}) - set(item["fields"]):
                raise ValueError("STRUCTURED_FIELD_LEAK:" + pid)
    if seen != set(expected):
        raise ValueError("STRUCTURED_PRODUCT_SET_MISMATCH")
    catalog = {}
    for record in descriptor.get("records", []):
        rel = _structured_safe_rel(record["relative_path"])
        if not _structured_record_allowed(rel) or rel in catalog:
            raise ValueError("STRUCTURED_RECORD_PATH_NOT_ALLOWED:" + rel)
        obj = _structured_safe_target(bundle, "objects/" + str(record["sha256"]))
        if not obj.is_file() or obj.is_symlink() or sha_file(obj) != record["sha256"]:
            raise ValueError("STRUCTURED_RECORD_MISSING:" + rel)
        raw = obj.read_bytes()
        _structured_scan_bytes(rel, raw)
        catalog[rel] = raw
    expected_map, product_map, scope = _structured_verified(
        descriptor, snap, files, catalog)
    descriptor["_verified_record_map"] = expected_map
    descriptor["_verified_product_map"] = product_map
    descriptor["_verified_bd_scope"] = scope
    _structured_scan_store(directory)
    if any(rel.startswith("evidence/") for rel in files):
        raise ValueError("BUNDLE_EXTERNAL_METADATA_FORBIDDEN:evidence/")
    return descriptor


_TARGET_IMPORT_FORMAT = "wfd.structured-target-import/1.0"
_TARGET_IMPORT_KEYS = {
    "format_version", "state", "bundle", "target_snapshot_id",
    "source_snapshot_id", "instance_id", "created_at", "updated_at",
    "content_sha256",
}
_TARGET_IMPORT_STATES = {"staging", "imported"}
_TARGET_INSTANCE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


_TARGET_INTERNAL_PREFIXES = (
    "catalog/product_service/target_imports/",
    "catalog/product_service/target_import_stage_proofs/",
    "catalog/product_service/holdings/",
)
_TARGET_INTERNAL_FILES = {
    "catalog/product_service/target_instance_binding.json",
    "catalog/product_service/volume_binding.json",
}


def _is_target_internal_rel(rel):
    return rel in _TARGET_INTERNAL_FILES or rel.startswith(_TARGET_INTERNAL_PREFIXES)


def _target_bundle_identity(descriptor):
    return {"bundle_id": descriptor["bundle_id"],
            "format_version": descriptor["format_version"],
            "mode": descriptor["mode"],
            "logical_state_digest": descriptor["logical_state_digest"],
            "source_dataset_id": descriptor["source_dataset_id"]}


def _target_import_marker_path(root, bundle_id):
    if not isinstance(bundle_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", bundle_id):
        raise ValueError("STRUCTURED_BUNDLE_ID_INVALID")
    return (Path(root) / "catalog/product_service/target_imports"
            / f"{bundle_id}.json")


def _load_target_import_marker(root, bundle_id):
    path = _target_import_marker_path(root, bundle_id)
    if not path.exists() and not path.is_symlink():
        return None
    if path.is_symlink() or not path.is_file():
        raise ValueError("STRUCTURED_TARGET_MARKER_CORRUPT")
    data = _json(path)
    if not isinstance(data, dict) or set(data) != _TARGET_IMPORT_KEYS:
        raise ValueError("STRUCTURED_TARGET_MARKER_CORRUPT")
    if data.get("format_version") != _TARGET_IMPORT_FORMAT:
        raise ValueError("STRUCTURED_TARGET_MARKER_CORRUPT")
    if data.get("state") not in _TARGET_IMPORT_STATES:
        raise ValueError("STRUCTURED_TARGET_MARKER_CORRUPT")
    body = {key: value for key, value in data.items() if key != "content_sha256"}
    if data.get("content_sha256") != sha(canonical(body)):
        raise ValueError("STRUCTURED_TARGET_MARKER_CORRUPT")
    if not isinstance(data.get("instance_id"), str) or not _TARGET_INSTANCE_ID.fullmatch(
            data["instance_id"]):
        raise ValueError("STRUCTURED_TARGET_MARKER_CORRUPT")
    bundle = data.get("bundle")
    if not isinstance(bundle, dict) or set(bundle) != {
            "bundle_id", "format_version", "mode", "logical_state_digest",
            "source_dataset_id"}:
        raise ValueError("STRUCTURED_TARGET_MARKER_CORRUPT")
    if bundle.get("bundle_id") != bundle_id or bundle.get("mode") not in {"full", "delta"}:
        raise ValueError("STRUCTURED_TARGET_MARKER_CORRUPT")
    for key in ("target_snapshot_id", "source_snapshot_id", "created_at", "updated_at"):
        if not isinstance(data.get(key), str) or not data[key]:
            raise ValueError("STRUCTURED_TARGET_MARKER_CORRUPT")
    for key in ("created_at", "updated_at"):
        try:
            datetime.strptime(data[key], "%Y-%m-%dT%H:%M:%SZ")
        except ValueError as exc:
            raise ValueError("STRUCTURED_TARGET_MARKER_CORRUPT") from exc
    return data


def _write_target_import_marker(root, descriptor, instance_id, state):
    if state not in _TARGET_IMPORT_STATES:
        raise ValueError("STRUCTURED_TARGET_MARKER_STATE_INVALID")
    path = _target_import_marker_path(root, descriptor["bundle_id"])
    prior = _load_target_import_marker(root, descriptor["bundle_id"])
    now = _now()
    body = {"format_version": _TARGET_IMPORT_FORMAT, "state": state,
            "bundle": _target_bundle_identity(descriptor),
            "target_snapshot_id": descriptor["target_snapshot_id"],
            "source_snapshot_id": descriptor["source_snapshot_id"],
            "instance_id": instance_id,
            "created_at": (prior or {}).get("created_at") or now,
            "updated_at": now}
    body["content_sha256"] = sha(canonical(body))
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(canonical(body))
    tmp.replace(path)
    return body


def _target_marker_matches(marker, descriptor):
    if marker.get("bundle") != _target_bundle_identity(descriptor):
        raise ValueError("BUNDLE_DESTINATION_EXISTS")
    if (marker.get("target_snapshot_id") != descriptor["target_snapshot_id"]
            or marker.get("source_snapshot_id") != descriptor["source_snapshot_id"]):
        raise ValueError("BUNDLE_DESTINATION_EXISTS")


def _target_store_uninitialized(destination):
    allowed = {"catalog/product_service/target_instance_binding.json",
               "catalog/product_service/volume_binding.json",
               "catalog/.writer.lock"}
    for path in Path(destination).rglob("*"):
        if path.is_symlink():
            return False
        if not path.is_file():
            continue
        rel = path.relative_to(destination).as_posix()
        if rel in allowed or path.name in {".DS_Store"} or rel.endswith(".tmp"):
            continue
        return False
    return True


def _structured_verify_target_identity(root, descriptor, instance_id):
    target_sid = descriptor["target_snapshot_id"]
    snap_path = Path(root) / f"catalog/snapshots/{target_sid}.json"
    commit_path = Path(root) / f"catalog/commits/{target_sid}.json"
    if not snap_path.is_file() or not commit_path.is_file():
        raise ValueError("STRUCTURED_TARGET_INCOMPLETE")
    snap_raw = snap_path.read_bytes()
    snapshot = _json_bytes(snap_raw)
    commit = _json(commit_path)
    if (commit.get("snapshot_id") != target_sid
            or commit.get("snapshot_file") != f"catalog/snapshots/{target_sid}.json"
            or commit.get("snapshot_sha256") != sha(snap_raw)):
        raise ValueError("STRUCTURED_TARGET_COMMIT_MISMATCH")
    receipt = snapshot.get("receipt") or {}
    if (receipt.get("snapshot_id") != target_sid
            or receipt.get("selection_digest") != descriptor["selection_digest"]
            or receipt.get("logical_state_digest") != descriptor["logical_state_digest"]
            or receipt.get("source_snapshot_id") != descriptor["source_snapshot_id"]):
        raise ValueError("STRUCTURED_TARGET_IDENTITY_CONFLICT")
    if sorted(receipt.get("target_product_ids") or []) != sorted(
            item["target_product_id"] for item in descriptor["included_reads"]):
        raise ValueError("STRUCTURED_TARGET_IDENTITY_CONFLICT")
    binding = resolve_target_instance(root, create=False)
    if binding["instance_id"] != instance_id:
        raise ValueError("STRUCTURED_TARGET_IDENTITY_CONFLICT")
    return snapshot


def _structured_verify_target_files(root, snapshot):
    for entry in snapshot.get("files", []):
        rel = _structured_safe_rel(entry["file_relpath"],
                                   prefixes=("observations/", "foundation/", "events/"))
        path = Path(root) / rel
        if not path.is_file() or sha_file(path) != entry["file_sha256"]:
            raise ValueError("STRUCTURED_TARGET_FILE_MISMATCH:" + entry["product_id"])


def _structured_snapshot_holding_groups(snapshot):
    groups = {}
    for entry in snapshot.get("files", []):
        versions = ((entry.get("source_bundle") or {}).get("_wfd_row_versions") or {}).get(
            entry["output_key"], {})
        records = sorted({(value.get("logical_key"), value.get("revision_id"))
                          for value in versions.values()},
                         key=lambda item: (item[0] or "", item[1] or ""))
        normalized = [{"record_id": record_id, "record_version": version}
                      for record_id, version in records if record_id and version]
        if int(entry.get("row_count") or 0) > 0 and not normalized:
            raise ValueError("STRUCTURED_HOLDING_RECORDS_MISSING:" + entry["product_id"])
        groups[entry["product_id"]] = normalized
    return groups


def _structured_snapshot_record_keys(root, snapshot_id):
    snapshot = _json(Path(root) / f"catalog/snapshots/{snapshot_id}.json")
    out = {}
    for entry in snapshot.get("files", []):
        versions = ((entry.get("source_bundle") or {}).get("_wfd_row_versions") or {}).get(
            entry["output_key"], {})
        out[entry["product_id"]] = {(value.get("logical_key"), value.get("revision_id"))
                                    for value in versions.values()}
    return out


def _structured_holdable_groups(root, instance_id, snapshot_id, groups, baseline_records):
    """Skip legacy baseline rows that have neither early proof nor holding facts."""
    if baseline_records is None:
        return groups
    ledger = HoldingLedger(root, instance_id)
    out = {}
    for product_id, records in groups.items():
        keep = []
        for record in records:
            key = (record["record_id"], record["record_version"])
            if key in baseline_records.get(product_id, set()):
                present = any(ledger.stage_times(
                    snapshot_id=snapshot_id, product_id=product_id,
                    stage=stage).get(key) for stage in STAGES)
                if not present:
                    continue
            keep.append(record)
        out[product_id] = keep
    return out


def _record_target_holdings(root, instance_id, snapshot_id, groups, bundle_identity,
                            current, baseline_records=None):
    ledger = HoldingLedger(root, instance_id)
    for product_id, records in groups.items():
        if not records:
            continue
        ledger_stages = {stage: ledger.stage_times(snapshot_id=snapshot_id,
                                                   product_id=product_id, stage=stage)
                         for stage in STAGES}
        proof_index = target_stage_proof_index(
            root, instance_id, snapshot_id, product_id)
        buckets = {}
        for record in records:
            key = (record["record_id"], record["record_version"])
            proof_slot = proof_index.get(key, {"stages": {}, "proofs": {}})
            stages = {}
            for name in STAGES:
                candidates = [value for value in (ledger_stages[name].get(key),
                                                  proof_slot["stages"].get(name)) if value]
                if candidates:
                    stages[name] = min(candidates)
            if (baseline_records is not None
                    and key in baseline_records.get(product_id, set()) and not stages):
                # A pre-P5 target has no early proof; never backfill its old rows.
                continue
            if stages:
                latest = max(index for index, name in enumerate(STAGES) if name in stages)
                fillable = {name: current[name] for name in STAGES[latest + 1:]
                            if name not in stages}
            else:
                fillable = {name: current[name] for name in STAGES}
            merged = {**stages, **fillable}
            if not merged:
                continue
            ledger_same = all(ledger_stages[name].get(key) == merged.get(name)
                              for name in STAGES)
            if not fillable and ledger_same:
                continue
            signature = tuple((name, merged[name]) for name in STAGES if name in merged)
            bucket = buckets.setdefault(signature, {"stages": merged, "records": []})
            bucket["records"].append(record)
        for bucket in buckets.values():
            proof_key = None
            # Reuse one persisted proof only when it covers every record and stage.
            candidates = None
            for record in bucket["records"]:
                slot = proof_index.get((record["record_id"], record["record_version"]),
                                       {"stages": {}, "proofs": {}})
                for name in bucket["stages"]:
                    keys = set(slot["proofs"].get(name, set()))
                    candidates = keys if candidates is None else candidates & keys
            if candidates:
                proof_key = sorted(candidates)[0]
            if proof_key is None:
                proof = write_target_stage_proof(
                    root, instance_id=instance_id, bundle=bundle_identity,
                    snapshot_id=snapshot_id, product_id=product_id,
                    records=bucket["records"], stages=bucket["stages"])
                proof_key = proof["request_key"]
            record_import_batch(
                root, instance_id, snapshot_id=snapshot_id, product_id=product_id,
                records=bucket["records"],
                proof={"request_key": proof_key, "snapshot_id": snapshot_id})



def import_structured_bundle(bundle, destination, *, runtime_root,
                             protocol_root=None, caller_roles=None,
                             interrupt_after=None, fault_hook=None):
    """Open a structured package and bind its real target instance.

    A fresh destination is initialized once. An existing destination is accepted
    only when its WFD import marker proves the same package identity, so retries
    recover the same instance instead of trusting an arbitrary directory.
    """
    bundle, destination = Path(bundle), Path(destination)
    descriptor = _verify_structured_bundle(bundle)
    roles = set(["read", "read_evidence"] if caller_roles is None else caller_roles)
    if "read" not in roles:
        raise PermissionError("WFD_READ_PERMISSION_REQUIRED")
    for record in descriptor.get("records", []):
        _structured_safe_rel(record["relative_path"])
        _structured_safe_target(destination, record["relative_path"],
                                prefixes=("catalog/product_service/",))
    target_sid = descriptor["target_snapshot_id"]
    protocol_root = (Path(protocol_root) if protocol_root
                     else Path(__file__).resolve().parents[1] / "protocol")
    marker = None
    if destination.exists():
        if destination.is_symlink() or not destination.is_dir():
            raise ValueError("BUNDLE_DESTINATION_EXISTS")
        marker = _load_target_import_marker(destination, descriptor["bundle_id"])
        if marker is not None:
            _target_marker_matches(marker, descriptor)
        elif not _target_store_uninitialized(destination):
            raise ValueError("BUNDLE_DESTINATION_EXISTS")
    destination.mkdir(parents=True, exist_ok=True)
    instance = resolve_target_instance(destination, create=True)
    instance_id = instance["instance_id"]
    if marker is not None and marker["instance_id"] != instance_id:
        raise ValueError("STRUCTURED_TARGET_IDENTITY_CONFLICT")
    marker = _write_target_import_marker(destination, descriptor, instance_id, "staging")
    bundle_identity = _target_bundle_identity(descriptor)
    engine = WFDDuckDBPrototype(destination, load_protocol_validator(protocol_root),
                                runtime_root=Path(runtime_root), sandbox=False,
                                writer_host=None)
    status = "imported_structured_readable"
    with writer_lock(destination):
        commit = destination / f"catalog/commits/{target_sid}.json"
        recovered = commit.is_file()
        if recovered:
            snapshot = _structured_verify_target_identity(
                destination, descriptor, instance_id)
            status = "already_imported"
        else:
            package = descriptor["storage_packages"][0]
            result = import_package(_path(bundle, package["directory"]), destination,
                                    interrupt_after=interrupt_after)
            if result["status"] == "interrupted":
                return {
                    "status": "interrupted", "format_version": STRUCTURED_BUNDLE_FORMAT,
                    "profile": STRUCTURED_PROFILE,
                    "target_snapshot_id": target_sid,
                    "source_snapshot_id": descriptor["source_snapshot_id"],
                    "instance_id": instance_id,
                    "copied_count": len(result.get("copied", [])),
                    "reused_count": len(result.get("reused", [])),
                    "target_import_marker": marker["state"],
                    "write_authority_granted": False,
                }
            if result["status"] != "imported":
                raise ValueError("BUNDLE_IMPORT_FAILED:" + str(result.get("code")))
            snapshot = _structured_verify_target_identity(
                destination, descriptor, instance_id)
        for record in descriptor["records"]:
            if _is_target_internal_rel(record["relative_path"]):
                # A package exported from another target must not overwrite this
                # target's own instance identity, import markers or holdings.
                continue
            target = destination / record["relative_path"]
            raw = (bundle / "objects" / record["sha256"]).read_bytes()
            if target.is_file():
                if sha_file(target) != record["sha256"]:
                    raise ValueError("STRUCTURED_TARGET_RECORD_CONFLICT:"
                                     + record["relative_path"])
                continue
            engine._write_immutable(record["relative_path"], raw)
        groups = _structured_snapshot_holding_groups(snapshot)
        acquired_at = _now()
        if not recovered:
            for product_id, records in groups.items():
                if records:
                    write_target_stage_proof(
                        destination, instance_id=instance_id, bundle=bundle_identity,
                        snapshot_id=target_sid, product_id=product_id, records=records,
                        stages={"acquired": acquired_at})
            if fault_hook is not None:
                fault_hook("after_copy")
        _structured_verify_target_files(destination, snapshot)
        custodied_at = _now()
        if not recovered:
            for product_id, records in groups.items():
                if records:
                    write_target_stage_proof(
                        destination, instance_id=instance_id, bundle=bundle_identity,
                        snapshot_id=target_sid, product_id=product_id, records=records,
                        stages={"custodied": custodied_at})
            if fault_hook is not None:
                fault_hook("after_custody")
        engine = WFDDuckDBPrototype(destination, load_protocol_validator(protocol_root),
                                    runtime_root=Path(runtime_root), sandbox=False,
                                    writer_host=None)
        service = WFDDataOnlyService(engine, caller_roles=roles,
                                     caller_id="structured-bundle-import")
        for expected in descriptor["included_reads"]:
            result = service.read(expected["target_product_id"], snapshot_id=target_sid)
            rows = [item["row"] for item in result["rows"]]
            if (len(rows) != expected["row_count"]
                    or "sha256:" + sha(canonical(rows)) != expected["rows_sha256"]):
                raise ValueError("STRUCTURED_FIXED_READ_MISMATCH:"
                                 + expected["target_product_id"])
            for item in result["rows"]:
                if item.get("record_id") not in expected["record_ids"]:
                    raise ValueError("STRUCTURED_RECORD_ID_MISMATCH")
                if item.get("record_version") not in expected["record_versions"]:
                    raise ValueError("STRUCTURED_RECORD_VERSION_MISMATCH")
        readable_at = _now()
        if not recovered:
            for product_id, records in groups.items():
                if records:
                    write_target_stage_proof(
                        destination, instance_id=instance_id, bundle=bundle_identity,
                        snapshot_id=target_sid, product_id=product_id, records=records,
                        stages={"published_readable": readable_at})
            if fault_hook is not None:
                fault_hook("before_holdings")
        _record_target_holdings(
            destination, instance_id, target_sid, groups, bundle_identity,
            {"acquired": acquired_at, "custodied": custodied_at,
             "published_readable": readable_at})
        marker = _write_target_import_marker(destination, descriptor, instance_id, "imported")
        _structured_scan_store(destination)
        state = engine.state.read()
        if state.get("active_head") is not None or state.get("writer_host") is not None:
            raise ValueError("BUNDLE_UNEXPECTED_WRITE_AUTHORITY")
    held = target_holding_summary(destination, instance_id, groups)
    return service, {
        "status": status,
        "format_version": STRUCTURED_BUNDLE_FORMAT,
        "profile": STRUCTURED_PROFILE,
        "target_snapshot_id": target_sid,
        "source_snapshot_id": descriptor["source_snapshot_id"],
        "selection_digest": descriptor["selection_digest"],
        "logical_state_digest": descriptor["logical_state_digest"],
        "record_map": descriptor["_verified_record_map"],
        "bd_association_scope": descriptor["_verified_bd_scope"],
        "instance_id": instance_id,
        "target_instance_binding": instance["source"],
        "held_stages": held,
        "target_instance_held_time": "recorded per record at target import; see held_stages",
        "target_import_marker": marker["state"],
        "read_self_contained": True,
        "bd_required": False,
        "source_permission_required": False,
        "active_head": state.get("active_head"),
        "imported_head": state.get("imported_head"),
        "write_authority_granted": False,
        "wfd_callers_have_read": "read" in roles,
        "excluded": descriptor["excluded"],
    }



# ---------------------------------------------------------------------------
# R2b structured delta over an existing structured full target baseline.
# ---------------------------------------------------------------------------

STRUCTURED_DELTA_FORMAT = "wfd.structured-delta/1.0"


def _structured_normalized_digest(selection_core):
    body = copy.deepcopy(selection_core)
    body.pop("source_snapshot_id", None)
    return "sha256:" + sha(canonical(body))


def _structured_baseline_products(store, baseline_sid):
    engine = WFDDuckDBPrototype(
        Path(store), load_protocol_validator(Path(__file__).resolve().parents[1] / "protocol"),
        runtime_root=Path(store).parent / (Path(store).name + "_delta_base_runtime"),
        sandbox=False, writer_host=None)
    snapshot = _bundle_snapshot(engine, baseline_sid)
    products = {}
    for entry in snapshot["files"]:
        product = entry["source_bundle"]["_wfd_product_bindings"][entry["output_key"]]["product"]
        source_pid = (product.get("bundle_target") or {}).get("source_product_id")
        if source_pid in products:
            raise ValueError("STRUCTURED_BASELINE_PRODUCT_DUPLICATE:" + str(source_pid))
        products[source_pid] = {"product": product, "entry": entry}
    return products, snapshot


def _structured_delta_record_map(descriptor, snap, files):
    products = {}
    target_rows = {}
    target_versions = {}
    for entry in snap["files"]:
        product = entry["source_bundle"]["_wfd_product_bindings"][entry["output_key"]]["product"]
        source_pid = (product.get("bundle_target") or {}).get("source_product_id")
        if not source_pid:
            raise ValueError("STRUCTURED_BASELINE_PRODUCT_PROOF_MISSING")
        products[entry["product_id"]] = product
        rows = rows_from_parquet(files[entry["file_relpath"]])
        target_rows[entry["product_id"]] = {
            row.get("business_key", row.get("event_id")): row for row in rows}
        target_versions[entry["product_id"]] = {
            value["logical_key"]: value for value in (
                entry["source_bundle"].get("_wfd_row_versions") or {}
            ).get(entry["output_key"], {}).values()}
    bindings = descriptor.get("source_record_bindings") or []
    if "sha256:" + sha(canonical(bindings)) != descriptor.get("source_record_bindings_digest"):
        raise ValueError("STRUCTURED_SOURCE_BINDING_DIGEST_MISMATCH")
    expected = []
    for binding in bindings:
        target_pid = binding["target_product_id"]
        if target_pid not in products:
            raise ValueError("STRUCTURED_TARGET_PRODUCT_MISSING")
        version = target_versions[target_pid].get(binding["target_record_id"])
        if version is None or version["revision_id"] != binding["target_record_version"]:
            raise ValueError("STRUCTURED_TARGET_RECORD_VERSION_MISMATCH")
        row = target_rows[target_pid].get(binding["target_record_id"])
        if row is None or "sha256:" + sha(canonical(row)) != binding["target_row_sha256"]:
            raise ValueError("STRUCTURED_TARGET_ROW_MISMATCH")
        expected.append({
            "source_dataset_id": binding["source_dataset_id"],
            "source_product_id": binding["source_product_id"],
            "source_record_id": binding["source_record_id"],
            "source_record_version": binding["source_record_version"],
            "target_product_id": target_pid,
            "target_record_id": binding["target_record_id"],
            "target_record_version": binding["target_record_version"],
            "target_snapshot_id": snap["snapshot_id"],
        })
    claimed = descriptor.get("record_map") or []
    if canonical(sorted(expected, key=canonical)) != canonical(sorted(claimed, key=canonical)):
        raise ValueError("STRUCTURED_RECORD_MAP_MISMATCH")
    claimed_products = descriptor.get("source_target_map", {}).get("products") or []
    expected_products = [{"source_product_id": source, "target_product_id": target}
                         for source, target in sorted({
                             (binding["source_product_id"], binding["target_product_id"])
                             for binding in bindings})]
    if canonical(sorted(expected_products, key=canonical)) != canonical(sorted(claimed_products, key=canonical)):
        raise ValueError("STRUCTURED_SOURCE_TARGET_MAP_MISMATCH")
    target_state = {
        "baseline_snapshot_id": descriptor["baseline"]["target_snapshot_id"],
        "normalized_selection_digest": descriptor["selection_digest"],
        "source_snapshot_id": descriptor["source_snapshot_id"],
        "source_record_bindings_digest": descriptor["source_record_bindings_digest"],
        "products": [{"target_product_id": pid,
                      "definition_digest": product["definition_ref"]["digest"],
                      "contract_bundle_digest": product["contract_bundle_ref"]["digest"],
                      "rows_sha256": "sha256:" + sha(canonical(
                          rows_from_parquet(files[next(e["file_relpath"] for e in snap["files"]
                                                      if e["product_id"] == pid)])))}
                     for pid, product in sorted(products.items())],
        "record_versions": sorted([[b["target_product_id"], b["target_record_id"],
                                    b["target_record_version"]] for b in bindings]),
    }
    target_state_digest = "sha256:" + sha(canonical(target_state))
    if target_state_digest != descriptor.get("target_state_digest"):
        raise ValueError("STRUCTURED_TARGET_STATE_DIGEST_MISMATCH")
    expected_target = "s_" + sha(canonical([STRUCTURED_BUNDLE_FORMAT, "delta",
                                            descriptor["selection_digest"],
                                            descriptor["baseline"]["target_snapshot_id"],
                                            target_state_digest]))[:24]
    if expected_target != descriptor["target_snapshot_id"]:
        raise ValueError("STRUCTURED_TARGET_ID_MISMATCH")
    return expected, {b["source_product_id"]: b["target_product_id"] for b in bindings}


_STRUCTURED_FULL_DESCRIPTOR_KEYS = {
    "bd_association_scope", "bd_required", "bundle_id", "carrier", "excluded",
    "format_version", "included_reads", "logical_state", "logical_state_digest",
    "mode", "normalized_selection_digest", "perspective", "profile",
    "read_dependencies", "read_self_contained", "record_map", "records",
    "selected_source_product_ids", "selection", "selection_digest",
    "source_dataset_id", "source_permission_required", "source_publication_proof",
    "source_snapshot_id", "source_target_map", "storage_packages",
    "target_snapshot_id", "wfd_permissions", "write_authority_granted",
}
_STRUCTURED_FULL_RECEIPT_KEYS = {
    "format_version", "profile", "status", "snapshot_id", "source_dataset_id",
    "source_snapshot_id", "source_product_ids", "target_product_ids",
    "normalized_selection_digest", "selection_digest", "logical_state_digest",
    "record_map", "bd_required", "source_permission_required",
    "formal_source_receipt", "write_authority_granted", "excluded",
}


def _structured_validate_full_metadata(manifest, snap, commit, files, descriptor):
    _structured_exact_keys(descriptor, _STRUCTURED_FULL_DESCRIPTOR_KEYS, "descriptor")
    _structured_exact_keys(manifest, {"parent_snapshot_id", "files"}, "manifest")
    if manifest["parent_snapshot_id"] is not None:
        raise ValueError("STRUCTURED_MANIFEST_PARENT_MISMATCH")
    _structured_exact_keys(snap, _STRUCTURED_DELTA_SNAPSHOT_KEYS, "snapshot")
    if snap["parent_snapshot_id"] is not None:
        raise ValueError("STRUCTURED_SNAPSHOT_PARENT_MISMATCH")
    if snap["metadata_versions"] != []:
        raise ValueError("STRUCTURED_METADATA_FIELD_NOT_ALLOWED:metadata_versions")
    for entry in manifest["files"]:
        _structured_validate_delta_entry(entry)
    if canonical(manifest["files"]) != canonical(snap["files"]):
        raise ValueError("STRUCTURED_MANIFEST_SNAPSHOT_MISMATCH")
    _structured_exact_keys(commit, {"snapshot_id", "snapshot_file", "snapshot_sha256"},
                           "commit")
    if commit["snapshot_id"] != snap["snapshot_id"]             or commit["snapshot_file"] != f"catalog/snapshots/{snap['snapshot_id']}.json"             or commit["snapshot_sha256"] != sha(files[commit["snapshot_file"]]):
        raise ValueError("STRUCTURED_COMMIT_MISMATCH")
    if snap["manifest_sha256"] != sha(files[snap["manifest_relpath"]]):
        raise ValueError("STRUCTURED_SNAPSHOT_MANIFEST_HASH_MISMATCH")
    _structured_exact_keys(snap["receipt"], _STRUCTURED_FULL_RECEIPT_KEYS, "receipt")
    receipt = snap["receipt"]
    expected = {
        "format_version": STRUCTURED_TARGET_FORMAT, "profile": STRUCTURED_PROFILE,
        "status": "structured_target_sealed", "snapshot_id": snap["snapshot_id"],
        "source_dataset_id": descriptor["source_dataset_id"],
        "source_snapshot_id": descriptor["source_snapshot_id"],
        "normalized_selection_digest": descriptor["normalized_selection_digest"],
        "selection_digest": descriptor["selection_digest"],
        "logical_state_digest": descriptor["logical_state_digest"],
        "bd_required": False, "source_permission_required": False,
        "formal_source_receipt": False, "write_authority_granted": False,
        "excluded": _STRUCTURED_EXCLUDED,
    }
    for key, value in expected.items():
        if canonical(receipt.get(key)) != canonical(value):
            raise ValueError("STRUCTURED_RECEIPT_MISMATCH:" + key)
    if sorted(receipt["source_product_ids"]) != sorted(descriptor["selected_source_product_ids"]):
        raise ValueError("STRUCTURED_RECEIPT_SOURCE_PRODUCTS_MISMATCH")
    if sorted(receipt["target_product_ids"]) != sorted(
            {entry["product_id"] for entry in snap["files"]}):
        raise ValueError("STRUCTURED_RECEIPT_TARGET_PRODUCTS_MISMATCH")
    if canonical(receipt["record_map"]) != canonical(descriptor["record_map"]):
        raise ValueError("STRUCTURED_RECORD_MAP_MISMATCH")


_STRUCTURED_DELTA_DESCRIPTOR_KEYS = {
    "baseline", "baseline_reused_files", "bd_association_scope", "bd_required",
    "bundle_id", "carrier", "delta_format", "excluded", "format_version",
    "included_reads", "logical_state", "logical_state_digest", "missing_objects",
    "mode", "normalized_selection_digest", "perspective", "profile",
    "read_dependencies", "read_self_contained", "record_map", "records",
    "selected_source_product_ids", "selection", "selection_digest",
    "source_dataset_id", "source_permission_required", "source_record_bindings",
    "source_record_bindings_digest", "source_snapshot_id", "source_target_map",
    "storage_packages", "target_instance_held_time", "target_snapshot_id",
    "target_state_digest", "wfd_permissions", "write_authority_granted",
}
_STRUCTURED_ENTRY_KEYS = {
    "product_id", "output_key", "file_relpath", "file_sha256", "row_count",
    "definition", "subject", "source_bundle", "evidence_refs", "input_mode",
    "payload_kind",
}
_STRUCTURED_PRODUCT_KEYS = {
    "bundle_target", "contract_bundle_ref", "contract_ref", "contract_refs",
    "contracts", "dataset_id", "declaration", "definition_compatibility",
    "definition_parent_ref", "definition_ref", "definition_sequence",
    "field_semantic_context", "logical_domain", "payload_kind", "product_family_id",
    "product_id", "semantic_context", "semantic_context_digest",
    "semantic_context_version", "service_version", "subject",
}
_STRUCTURED_CONTRACT_KEYS = {
    "semantic", "read", "compute_dependencies", "publication",
    "contract_set_version", "part_digests",
}
_STRUCTURED_DELTA_RECEIPT_KEYS = {
    "format_version", "profile", "status", "snapshot_id", "parent_snapshot_id",
    "baseline_snapshot_id", "source_dataset_id", "source_snapshot_id",
    "source_product_ids", "target_product_ids", "normalized_selection_digest",
    "selection_digest", "logical_state_digest", "target_state_digest",
    "source_record_bindings_digest", "bundle_id", "record_map", "bd_required",
    "source_permission_required", "formal_source_receipt",
    "write_authority_granted", "target_instance_held_time", "excluded",
}
_STRUCTURED_DELTA_SNAPSHOT_KEYS = {
    "snapshot_id", "parent_snapshot_id", "manifest_relpath", "manifest_sha256",
    "files", "metadata_versions", "request_key", "request_fingerprint", "receipt",
}


def _structured_exact_keys(value, expected, label):
    if not isinstance(value, dict):
        raise ValueError("STRUCTURED_METADATA_TYPE_INVALID:" + label)
    unknown = sorted(set(value) - expected)
    if unknown:
        raise ValueError("STRUCTURED_METADATA_FIELD_UNKNOWN:" + label + ":" + unknown[0])
    missing = sorted(expected - set(value))
    if missing:
        raise ValueError("STRUCTURED_METADATA_FIELD_MISSING:" + label + ":" + missing[0])


def _structured_validate_delta_descriptor(descriptor):
    _structured_exact_keys(descriptor, _STRUCTURED_DELTA_DESCRIPTOR_KEYS, "descriptor")
    if descriptor.get("read_dependencies") != []:
        raise ValueError("STRUCTURED_READ_DEPENDENCY_NOT_IMPLEMENTED")
    for item in descriptor.get("source_record_bindings") or []:
        _structured_exact_keys(item, {
            "source_dataset_id", "source_product_id", "source_record_id",
            "source_record_version", "source_row_sha256", "target_product_id",
            "target_record_id", "target_record_version", "target_row_sha256"},
            "source_record_binding")
    for key in ("missing_objects", "baseline_reused_files"):
        for item in descriptor.get(key) or []:
            _structured_exact_keys(item, {"relative_path", "sha256"}, key)
    for item in descriptor.get("storage_packages") or []:
        _structured_exact_keys(item, {"snapshot_id", "directory"}, "storage_package")
    _structured_exact_keys(descriptor.get("baseline") or {},
                           {"target_snapshot_id", "normalized_selection_digest"}, "baseline")


def _structured_validate_delta_entry(entry):
    _structured_exact_keys(entry, _STRUCTURED_ENTRY_KEYS, "entry")
    carrier = entry.get("source_bundle")
    _structured_exact_keys(carrier, _STRUCTURED_ALLOWED_CARRIER, "carrier")
    if entry.get("evidence_refs") != []:
        raise ValueError("STRUCTURED_METADATA_FIELD_NOT_ALLOWED:evidence_refs")
    bindings = carrier.get("_wfd_product_bindings") or {}
    if set(bindings) != {entry["output_key"]}:
        raise ValueError("STRUCTURED_BINDING_SET_MISMATCH")
    binding = bindings[entry["output_key"]]
    _structured_exact_keys(binding, {"product", "source_role_mode", "source_admission"},
                           "binding")
    if binding.get("source_admission") != {}:
        raise ValueError("STRUCTURED_METADATA_FIELD_NOT_ALLOWED:source_admission")
    product = binding.get("product")
    _structured_exact_keys(product, _STRUCTURED_PRODUCT_KEYS, "product")
    if product.get("product_id") != entry["product_id"]:
        raise ValueError("STRUCTURED_PRODUCT_BINDING_MISMATCH")
    if canonical(entry.get("definition")) != canonical(product.get("declaration"))             or canonical(entry.get("subject")) != canonical(product.get("subject")):
        raise ValueError("STRUCTURED_ENTRY_PRODUCT_MISMATCH")
    _structured_exact_keys(product.get("contracts") or {},
                           _STRUCTURED_CONTRACT_KEYS, "contracts")
    if product["contracts"]["read"].get("dependencies"):
        raise ValueError("STRUCTURED_READ_DEPENDENCY_NOT_IMPLEMENTED")
    for key in ("_wfd_received_time", "_wfd_service_version", "_wfd_resolved_product_ids",
                "_wfd_row_versions", "product_service"):
        if key not in carrier:
            raise ValueError("STRUCTURED_METADATA_FIELD_MISSING:carrier:" + key)
    if carrier.get("product_service") != {"version": "wfd.product-service/0.3",
                                          "outputs": {}, "consistency_groups": {}}:
        raise ValueError("STRUCTURED_PRODUCT_SERVICE_INVALID")
    if carrier.get("_wfd_received_time") != UNKNOWN_TIME:
        raise ValueError("STRUCTURED_HELD_TIME_FORGERY")
    if set(carrier["_wfd_resolved_product_ids"]) != {entry["output_key"]}:
        raise ValueError("STRUCTURED_RESOLVED_PRODUCT_SET_MISMATCH")
    if set(carrier["_wfd_row_versions"]) != {entry["output_key"]}:
        raise ValueError("STRUCTURED_ROW_VERSION_SET_MISMATCH")


def _structured_validate_delta_metadata(manifest, snap, commit, files, descriptor):
    _structured_exact_keys(manifest, {"parent_snapshot_id", "files"}, "manifest")
    if manifest["parent_snapshot_id"] != descriptor["baseline"]["target_snapshot_id"]:
        raise ValueError("STRUCTURED_MANIFEST_PARENT_MISMATCH")
    _structured_exact_keys(snap, _STRUCTURED_DELTA_SNAPSHOT_KEYS, "snapshot")
    if snap["parent_snapshot_id"] != descriptor["baseline"]["target_snapshot_id"]:
        raise ValueError("STRUCTURED_SNAPSHOT_PARENT_MISMATCH")
    if snap["metadata_versions"] != []:
        raise ValueError("STRUCTURED_METADATA_FIELD_NOT_ALLOWED:metadata_versions")
    for entry in manifest["files"]:
        _structured_validate_delta_entry(entry)
    if canonical(manifest["files"]) != canonical(snap["files"]):
        raise ValueError("STRUCTURED_MANIFEST_SNAPSHOT_MISMATCH")
    _structured_exact_keys(commit, {"snapshot_id", "snapshot_file", "snapshot_sha256"},
                           "commit")
    if commit["snapshot_id"] != snap["snapshot_id"]:
        raise ValueError("STRUCTURED_COMMIT_SNAPSHOT_MISMATCH")
    if commit["snapshot_file"] != f"catalog/snapshots/{snap['snapshot_id']}.json":
        raise ValueError("STRUCTURED_COMMIT_PATH_MISMATCH")
    if commit["snapshot_sha256"] != sha(files[commit["snapshot_file"]]):
        raise ValueError("STRUCTURED_COMMIT_HASH_MISMATCH")
    if snap["manifest_sha256"] != sha(files[snap["manifest_relpath"]]):
        raise ValueError("STRUCTURED_SNAPSHOT_MANIFEST_HASH_MISMATCH")
    _structured_exact_keys(snap["receipt"], _STRUCTURED_DELTA_RECEIPT_KEYS, "receipt")
    receipt = snap["receipt"]
    expected = {
        "format_version": STRUCTURED_TARGET_FORMAT, "profile": STRUCTURED_PROFILE,
        "status": "structured_delta_target_sealed", "snapshot_id": snap["snapshot_id"],
        "parent_snapshot_id": descriptor["baseline"]["target_snapshot_id"],
        "baseline_snapshot_id": descriptor["baseline"]["target_snapshot_id"],
        "source_dataset_id": descriptor["source_dataset_id"],
        "source_snapshot_id": descriptor["source_snapshot_id"],
        "normalized_selection_digest": descriptor["selection_digest"],
        "selection_digest": descriptor["selection_digest"],
        "logical_state_digest": descriptor["logical_state_digest"],
        "target_state_digest": descriptor["target_state_digest"],
        "source_record_bindings_digest": descriptor["source_record_bindings_digest"],
        "bundle_id": descriptor["bundle_id"],
        "bd_required": False, "source_permission_required": False,
        "formal_source_receipt": False, "write_authority_granted": False,
        "target_instance_held_time": "unknown; target acquisition is recorded only on import",
        "excluded": _STRUCTURED_EXCLUDED,
    }
    for key, value in expected.items():
        if canonical(receipt.get(key)) != canonical(value):
            raise ValueError("STRUCTURED_RECEIPT_MISMATCH:" + key)
    if sorted(receipt["source_product_ids"]) != sorted(descriptor["selected_source_product_ids"]):
        raise ValueError("STRUCTURED_RECEIPT_SOURCE_PRODUCTS_MISMATCH")
    if sorted(receipt["target_product_ids"]) != sorted(
            {entry["product_id"] for entry in snap["files"]}):
        raise ValueError("STRUCTURED_RECEIPT_TARGET_PRODUCTS_MISMATCH")
    if canonical(receipt["record_map"]) != canonical(descriptor["record_map"]):
        raise ValueError("STRUCTURED_RECORD_MAP_MISMATCH")


def _structured_delta_scan_package(bundle, descriptor):
    _structured_scan_json(descriptor, "financial_bundle")
    if descriptor.get("read_dependencies"):
        raise ValueError("STRUCTURED_READ_DEPENDENCY_NOT_IMPLEMENTED")
    if descriptor.get("source_permission_required") is not False or descriptor.get("bd_required") is not False:
        raise ValueError("STRUCTURED_SOURCE_PERMISSION_CLAIM")
    package = descriptor["storage_packages"][0]
    directory = _structured_safe_target(bundle, package["directory"])
    checked = verify_package(directory)
    if not checked["ok"] or checked["transfer"]["target_snapshot_id"] != descriptor["target_snapshot_id"]:
        raise ValueError("BUNDLE_STORAGE_INTEGRITY_FAILED")
    _, files = _package_files(directory)
    lineage_raw = None
    for meta in checked["inventory"]["metadata"]:
        if meta["rel_path"] == f"catalog/lineage/{descriptor['target_snapshot_id']}.json":
            lineage_raw = (directory / "objects" / meta["sha256"]).read_bytes()
    snap = _json_bytes(files[f"catalog/snapshots/{descriptor['target_snapshot_id']}.json"])
    manifest_path = snap.get("manifest_relpath")
    manifest = _json_bytes(files[manifest_path])
    commit = _json_bytes(files[f"catalog/commits/{descriptor['target_snapshot_id']}.json"])
    _structured_validate_delta_descriptor(descriptor)
    _structured_validate_delta_metadata(manifest, snap, commit, files, descriptor)
    if snap.get("parent_snapshot_id") != descriptor["baseline"]["target_snapshot_id"]:
        raise ValueError("STRUCTURED_DELTA_PARENT_MISMATCH")
    products = _structured_products_from_snapshot(snap)
    _structured_assert_no_read_dependencies(descriptor, products)
    if lineage_raw is None:
        raise ValueError("STRUCTURED_LINEAGE_MISSING")
    _structured_validate_lineage(
        _json_bytes(lineage_raw), snap["files"],
        files[f"catalog/snapshots/{descriptor['target_snapshot_id']}.json"],
        files[snap["manifest_relpath"]], descriptor, delta=True)
    for obj in checked["inventory"]["objects"]:
        for rel in obj["rel_paths"]:
            _structured_safe_rel(rel, prefixes=("observations/", "foundation/", "events/"))
            if rel not in files:
                raise ValueError("STRUCTURED_OBJECT_ROLE_UNKNOWN:" + rel)
            _structured_scan_bytes(rel, files[rel])
    for meta in checked["inventory"]["metadata"]:
        rel = _structured_safe_rel(meta["rel_path"])
        if not (rel == f"catalog/snapshots/{descriptor['target_snapshot_id']}.json"
                or rel == f"catalog/commits/{descriptor['target_snapshot_id']}.json"
                or rel == f"catalog/lineage/{descriptor['target_snapshot_id']}.json"
                or re.fullmatch(r"catalog/manifests/manifest_[0-9a-f]{24}\.json", rel)):
            raise ValueError("STRUCTURED_METADATA_PATH_NOT_ALLOWED:" + rel)
    _structured_scan_bytes(f"catalog/snapshots/{descriptor['target_snapshot_id']}.json",
                           files[f"catalog/snapshots/{descriptor['target_snapshot_id']}.json"])
    _structured_scan_store(directory)
    return snap, products, checked, files


def _structured_export_selection(service, product_ids, snapshot_id, selection, perspective):
    snapshot = _bundle_snapshot(service.engine, snapshot_id)
    discovered = service.discover_products(snapshot_id=snapshot_id)["products"]
    by_id = {p["product_id"]: p for p in discovered}
    normalized = _normalize_selection(selection, sorted(set(product_ids or [])))
    selection_products = []
    for item in normalized["products"]:
        product = by_id.get(item["product_id"])
        if product is None:
            raise ValueError("STRUCTURED_PRODUCT_NOT_FOUND:" + item["product_id"])
        if _read_dependencies(product):
            raise ValueError("STRUCTURED_READ_DEPENDENCY_NOT_IMPLEMENTED")
        fields = sorted(item["fields"] or _declaration_fields(product))
        if item.get("subject") is not None and item["subject"] != product.get("subject"):
            raise ValueError("STRUCTURED_SUBJECT_NOT_IN_PRODUCT_SCOPE")
        selection_products.append({**item, "fields": fields, "product": product})
    source_dataset_id = (snapshot.get("receipt", {}).get("dataset_id")
                         or selection_products[0]["product"]["dataset_id"])
    selection_core = {
        "profile": STRUCTURED_PROFILE, "perspective": perspective,
        "source_dataset_id": source_dataset_id, "source_snapshot_id": snapshot_id,
        "products": [{"product_id": item["product_id"], "fields": item["fields"],
                      "subject": copy.deepcopy(item["subject"]),
                      "business_time_range": copy.deepcopy(item["business_time_range"])}
                     for item in sorted(selection_products, key=lambda x: x["product_id"])],
    }
    return selection_products, selection_core


def export_structured_delta_bundle(service, product_ids, destination, *, snapshot_id,
                                   baseline_store, baseline_snapshot_id,
                                   selection=None, perspective="snapshot_contents"):
    """Export only missing WFD structured objects over an existing target baseline."""
    if service.has_permission("export") is not True:
        raise PermissionError("WFD_EXPORT_PERMISSION_REQUIRED")
    if perspective != "snapshot_contents":
        raise ValueError("STRUCTURED_PERSPECTIVE_NOT_IMPLEMENTED")
    destination = Path(destination)
    if destination.exists():
        raise ValueError("BUNDLE_DESTINATION_EXISTS")
    baseline_products, baseline_snap = _structured_baseline_products(
        baseline_store, baseline_snapshot_id)
    baseline_receipt = baseline_snap.get("receipt") or {}
    baseline_selection = (baseline_receipt.get("normalized_selection_digest")
                          or baseline_receipt.get("selection_digest"))
    if not baseline_selection:
        raise ValueError("STRUCTURED_BASELINE_STATE_UNKNOWN")
    selection_products, selection_core = _structured_export_selection(
        service, product_ids, snapshot_id, selection, perspective)
    source_dataset_id = selection_core["source_dataset_id"]
    normalized_digest = _structured_normalized_digest(selection_core)
    if normalized_digest != baseline_selection:
        raise ValueError("STRUCTURED_BASELINE_SELECTION_MISMATCH")
    target_sid = None
    target_entries, included_reads, record_map, target_products = [], [], [], []
    source_bindings = []
    with tempfile.TemporaryDirectory(prefix=".wfd_structured_delta_", dir=destination.parent) as temp:
        root = Path(temp) / "store"
        engine = WFDDuckDBPrototype(root, load_protocol_validator(
            Path(__file__).resolve().parents[1] / "protocol"),
            runtime_root=Path(str(root) + "_runtime"), sandbox=False, writer_host=None)
        for item in sorted(selection_products, key=lambda x: x["product_id"]):
            source = item["product"]
            base = baseline_products.get(source["product_id"])
            if base is None:
                raise ValueError("STRUCTURED_BASELINE_PRODUCT_MISSING:" + source["product_id"])
            base_product = base["product"]
            candidate, _, _, _, _ = _structured_target_product(
                source, base_product["product_id"], item["fields"],
                normalized_digest, snapshot_id)
            if (candidate.get("definition_ref", {}).get("digest")
                    != base_product.get("definition_ref", {}).get("digest")
                    or candidate.get("contract_bundle_ref", {}).get("digest")
                    != base_product.get("contract_bundle_ref", {}).get("digest")):
                raise ValueError("STRUCTURED_DELTA_CONTRACT_CHANGED:" + source["product_id"])
            rows = service.read(source["product_id"], snapshot_id=snapshot_id,
                                include_history=False)["rows"]
            base_engine = WFDDuckDBPrototype(
                Path(baseline_store), load_protocol_validator(
                    Path(__file__).resolve().parents[1] / "protocol"),
                runtime_root=Path(baseline_store).parent / (Path(baseline_store).name + "_delta_base_read"),
                sandbox=False, writer_host=None)
            base_service = WFDDataOnlyService(base_engine, caller_roles={"read"},
                                              caller_id="structured-delta-base")
            base_rows = {item2["record_id"]: item2["row"] for item2 in base_service.read(
                base_product["product_id"], snapshot_id=baseline_snapshot_id)["rows"]}
            base_versions = {v["logical_key"]: v for v in (
                base["entry"]["source_bundle"].get("_wfd_row_versions") or {}
            ).get(base["entry"]["output_key"], {}).values()}
            overrides, source_rows = {}, {}
            for item2 in rows:
                row = copy.deepcopy(item2["row"] or {})
                if base_product.get("payload_kind") == "scalar_rows":
                    pass
                else:
                    values = row.get("values") or {}
                    row["values"] = {code: values[code] for code in item["fields"]
                                     if code in values}
                record_id = item2.get("record_id") or (item2.get("revision") or {}).get("logical_key")
                source_rows[record_id] = {
                    "row_sha256": "sha256:" + sha(canonical(row)),
                    "record_version": item2.get("record_version")
                                      or (item2.get("revision") or {}).get("revision_id"),
                }
                if record_id in base_rows and canonical(row) == canonical(base_rows[record_id]):
                    overrides[record_id] = base_versions.get(record_id)
            selected, normalized_range, row_map = _structured_rows(
                service, base_product, rows, item["fields"], item["business_time_range"],
                source["product_id"], selected_subject=item.get("subject"),
                version_overrides=overrides)
            target_pid = base_product["product_id"]
            output_key = base["entry"]["output_key"]
            parquet_rows = [row for row, _, _ in selected]
            raw = parquet_from_rows(target_pid, output_key, base_product["subject"],
                                    base_product["payload_kind"], parquet_rows)
            digest = sha(raw)
            rel = f"{base_product['logical_domain']}/product={target_pid}/part-{digest[:24]}.parquet"
            engine._write_immutable(rel, raw)
            product = copy.deepcopy(base_product)
            product["bundle_target"] = {
                "source_dataset_id": source["dataset_id"],
                "source_snapshot_id": snapshot_id,
                "source_product_id": source["product_id"],
                "target_product_id": target_pid,
                "selection_digest": normalized_digest,
            }
            versions = {physical: revision for _, revision, physical in selected}
            carrier = {
                "_wfd_data_only": True,
                "_wfd_received_time": copy.deepcopy(UNKNOWN_TIME),
                "_wfd_service_version": STRUCTURED_TARGET_FORMAT,
                "_wfd_product_bindings": {output_key: {
                    "product": product, "source_role_mode": "data_only",
                    "source_admission": {}}},
                "_wfd_resolved_product_ids": {output_key: target_pid},
                "_wfd_row_versions": {output_key: versions},
                "product_service": {"version": "wfd.product-service/0.3",
                                    "outputs": {}, "consistency_groups": {}},
            }
            entry = {
                "product_id": target_pid, "output_key": output_key,
                "file_relpath": rel, "file_sha256": digest,
                "row_count": len(parquet_rows),
                "definition": copy.deepcopy(product["declaration"]),
                "subject": copy.deepcopy(product["subject"]),
                "source_bundle": carrier, "evidence_refs": [],
                "input_mode": "partial_observation",
                "payload_kind": product["payload_kind"],
            }
            target_entries.append(entry)
            target_products.append(product)
            target_rows_by_record = {
                revision["logical_key"]: row for row, revision, _ in selected}
            for record in row_map:
                if record["source_product_id"] == source["product_id"]:
                    record["target_product_id"] = target_pid
                    record["target_snapshot_id"] = None
                    record_map.append(record)
                    binding = source_rows.get(record["source_record_id"]) or {}
                    target_row = target_rows_by_record.get(record["target_record_id"])
                    source_bindings.append({
                        "source_dataset_id": source["dataset_id"],
                        "source_product_id": source["product_id"],
                        "source_record_id": record["source_record_id"],
                        "source_record_version": binding.get("record_version"),
                        "source_row_sha256": binding.get("row_sha256"),
                        "target_product_id": target_pid,
                        "target_record_id": record["target_record_id"],
                        "target_record_version": record["target_record_version"],
                        "target_row_sha256": "sha256:" + sha(canonical(target_row))
                                             if target_row is not None else None,
                    })
            included_reads.append({
                "source_dataset_id": source["dataset_id"],
                "source_product_id": source["product_id"],
                "target_dataset_id": product["dataset_id"],
                "target_snapshot_id": None,
                "target_product_id": target_pid,
                "fields": item["fields"], "row_count": len(parquet_rows),
                "rows_sha256": "sha256:" + sha(canonical(parquet_rows)),
                "record_ids": sorted(v["logical_key"] for v in versions.values()),
                "record_versions": sorted(v["revision_id"] for v in versions.values()),
            })
        source_bindings = sorted(source_bindings, key=canonical)
        source_bindings_digest = "sha256:" + sha(canonical(source_bindings))
        target_state = {
            "baseline_snapshot_id": baseline_snapshot_id,
            "normalized_selection_digest": normalized_digest,
            "source_snapshot_id": snapshot_id,
            "source_record_bindings_digest": source_bindings_digest,
            "products": [{"target_product_id": p["product_id"],
                          "definition_digest": p["definition_ref"]["digest"],
                          "contract_bundle_digest": p["contract_bundle_ref"]["digest"],
                          "rows_sha256": e["rows_sha256"]}
                         for p, e in zip(target_products, included_reads)],
            "record_versions": sorted(
                [x["target_product_id"], x["target_record_id"], x["target_record_version"]]
                for values in [source_bindings]
                for x in values
            ) if source_bindings else [],
        }
        target_state_digest = "sha256:" + sha(canonical(target_state))
        target_sid = "s_" + sha(canonical([STRUCTURED_BUNDLE_FORMAT, "delta",
                                           normalized_digest, baseline_snapshot_id,
                                           target_state_digest]))[:24]
        for record in record_map:
            record["target_snapshot_id"] = target_sid
        for item in included_reads:
            item["target_snapshot_id"] = target_sid
        logical_state = {
            "profile": STRUCTURED_PROFILE, "mode": "delta",
            "normalized_selection_digest": normalized_digest,
            "target_snapshot_id": target_sid,
            "baseline_snapshot_id": baseline_snapshot_id,
            "products": [{"target_product_id": p["product_id"],
                          "definition_digest": p["definition_ref"]["digest"],
                          "contract_bundle_digest": p["contract_bundle_ref"]["digest"],
                          "row_count": e["row_count"],
                          "rows_sha256": "sha256:" + sha(canonical(
                              rows_from_parquet((root / e["file_relpath"]).read_bytes())))}
                         for p, e in zip(target_products, target_entries)],
            "record_map": record_map,
        }
        logical_digest = "sha256:" + sha(canonical(logical_state))
        receipt = {
            "format_version": STRUCTURED_TARGET_FORMAT, "profile": STRUCTURED_PROFILE,
            "status": "structured_delta_target_sealed", "snapshot_id": target_sid,
            "parent_snapshot_id": baseline_snapshot_id,
            "baseline_snapshot_id": baseline_snapshot_id,
            "source_dataset_id": source_dataset_id, "source_snapshot_id": snapshot_id,
            "source_product_ids": [i["product_id"] for i in selection_products],
            "target_product_ids": [p["product_id"] for p in target_products],
            "normalized_selection_digest": normalized_digest,
            "selection_digest": normalized_digest, "logical_state_digest": logical_digest,
            "target_state_digest": target_state_digest,
            "source_record_bindings_digest": source_bindings_digest,
            "bundle_id": "sd_" + sha(canonical([normalized_digest, target_sid,
                                                target_state_digest]))[:24],
            "record_map": record_map, "bd_required": False,
            "source_permission_required": False,
            "formal_source_receipt": False, "write_authority_granted": False,
            "target_instance_held_time": "unknown; target acquisition is recorded only on import",
            "excluded": copy.deepcopy(_STRUCTURED_EXCLUDED),
        }
        manifest = {"parent_snapshot_id": baseline_snapshot_id, "files": target_entries}
        mraw = canonical(manifest); mhash = sha(mraw)
        mrel = f"catalog/manifests/manifest_{mhash[:24]}.json"
        engine._write_immutable(mrel, mraw)
        snap = {"snapshot_id": target_sid, "parent_snapshot_id": baseline_snapshot_id,
                "manifest_relpath": mrel, "manifest_sha256": mhash,
                "files": target_entries, "metadata_versions": [],
                "request_key": "structured_delta_" + normalized_digest.removeprefix("sha256:")[:24],
                "request_fingerprint": logical_digest, "receipt": receipt}
        sraw = canonical(snap)
        srel = f"catalog/snapshots/{target_sid}.json"
        engine._write_immutable(srel, sraw)
        engine._write_immutable(f"catalog/commits/{target_sid}.json",
                                canonical({"snapshot_id": target_sid,
                                           "snapshot_file": srel,
                                           "snapshot_sha256": sha(sraw)}))
        engine._write_immutable(
            f"catalog/lineage/{baseline_snapshot_id}.json",
            canonical({"format_version": "wfd.structured-lineage-baseline/1.0",
                       "snapshot_id": baseline_snapshot_id,
                       "parent_snapshot_id": None,
                       "files_root": "",
                       "status": "baseline_ref"}))
        lineage = _structured_lineage_body(
            target_entries, target_sid, sraw, mraw, source_dataset_id, snapshot_id,
            normalized_digest, logical_digest,
            parent_snapshot_id=baseline_snapshot_id,
            baseline_snapshot_id=baseline_snapshot_id)
        engine._write_immutable(f"catalog/lineage/{target_sid}.json", canonical(lineage))
        destination.mkdir(parents=True)
        full_dir = destination / "storage" / target_sid
        export_package(root, target_sid, full_dir)
        checked, full_files = _package_files(full_dir)
        baseline_engine = WFDDuckDBPrototype(
            Path(baseline_store), load_protocol_validator(
                Path(__file__).resolve().parents[1] / "protocol"),
            runtime_root=Path(baseline_store).parent / (Path(baseline_store).name + "_delta_base_runtime"),
            sandbox=False, writer_host=None)
        baseline_entries = {e["file_relpath"]: e["file_sha256"].split(":")[-1]
                            for e in _bundle_snapshot(baseline_engine, baseline_snapshot_id)["files"]}
        reused, missing_objects = [], []
        objects = []
        for obj in checked["inventory"]["objects"]:
            rels = list(obj["rel_paths"])
            if all(baseline_entries.get(rel) == obj["sha256"] for rel in rels):
                reused.extend({"relative_path": rel, "sha256": obj["sha256"]} for rel in rels)
            else:
                objects.append(obj)
                missing_objects.extend({"relative_path": rel, "sha256": obj["sha256"]} for rel in rels)
        # rebuild a partial transfer package containing only missing data objects
        # and the target metadata; the full package is discarded.
        object_bytes = {obj["sha256"]: (full_dir / "objects" / obj["sha256"]).read_bytes()
                        for obj in objects}
        metadata_items = [meta for meta in checked["inventory"]["metadata"]
                          if baseline_snapshot_id not in meta["rel_path"]]
        metadata_bytes = {meta["sha256"]: (full_dir / "objects" / meta["sha256"]).read_bytes()
                          for meta in metadata_items}
        partial = destination / "storage" / target_sid
        shutil.rmtree(partial)
        (partial / "objects").mkdir(parents=True)
        for digest, raw in {**object_bytes, **metadata_bytes}.items():
            (partial / "objects" / digest).write_bytes(raw)
        inventory = {
            "format_version": "wfd.transfer.manifest/1.0", "generated_at_utc": _now(),
            "dataset_id": source_dataset_id, "target_snapshot_id": target_sid,
            "files_root": checked["inventory"].get("files_root"),
            "objects": objects, "metadata": metadata_items,
            "ancestry": [baseline_snapshot_id, target_sid], "partial": True,
            "baseline_snapshot_id": baseline_snapshot_id,
        }
        (partial / "inventory.json").write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n")
        transfer = {"format_version": "wfd.transfer/1.0",
                    "transfer_id": "structured_delta_" + target_sid,
                    "created_at_utc": _now(), "dataset_id": source_dataset_id,
                    "target_snapshot_id": target_sid,
                    "ancestry": [baseline_snapshot_id, target_sid],
                    "object_count": len(objects),
                    "total_bytes": sum(int(o.get("size") or 0) for o in objects),
                    "include_ancestor_data": False, "partial": True,
                    "baseline_snapshot_id": baseline_snapshot_id,
                    "source": {"dataset_id": source_dataset_id,
                               "snapshot_id": snapshot_id,
                               "files_root": checked["inventory"].get("files_root"),
                               "writer_host": None, "writer_epoch": 0}}
        (partial / "transfer.json").write_text(json.dumps(transfer, ensure_ascii=False, indent=2) + "\n")
        lines = []
        for path in sorted(partial.rglob("*")):
            if path.is_file() and path.name != "CHECKSUMS.sha256":
                lines.append(f"{sha_file(path)}  {path.relative_to(partial).as_posix()}")
        (partial / "CHECKSUMS.sha256").write_text("\n".join(lines) + "\n")
        descriptor = {
            "format_version": STRUCTURED_BUNDLE_FORMAT, "profile": STRUCTURED_PROFILE,
            "mode": "delta", "delta_format": STRUCTURED_DELTA_FORMAT,
            "bundle_id": "sd_" + sha(canonical([normalized_digest, target_sid,
                                                target_state_digest]))[:24],
            "perspective": perspective,
            "selection": copy.deepcopy(selection_core),
            "selection_digest": normalized_digest,
            "normalized_selection_digest": normalized_digest,
            "logical_state": logical_state, "logical_state_digest": logical_digest,
            "target_state_digest": target_state_digest,
            "source_record_bindings": copy.deepcopy(source_bindings),
            "source_record_bindings_digest": source_bindings_digest,
            "source_dataset_id": source_dataset_id, "source_snapshot_id": snapshot_id,
            "selected_source_product_ids": [i["product_id"] for i in selection_products],
            "target_snapshot_id": target_sid,
            "baseline": {"target_snapshot_id": baseline_snapshot_id,
                         "normalized_selection_digest": baseline_selection},
            "baseline_reused_files": reused,
            "missing_objects": missing_objects,
            "source_target_map": {"snapshots": [
                {"source_dataset_id": source_dataset_id, "source_snapshot_id": snapshot_id,
                 "target_snapshot_id": target_sid},
                {"source_dataset_id": source_dataset_id,
                 "source_snapshot_id": baseline_receipt.get("source_snapshot_id"),
                 "target_snapshot_id": baseline_snapshot_id}],
                "products": [{"source_product_id": source, "target_product_id": target}
                             for source, target in sorted({
                                 (x["source_product_id"], x["target_product_id"])
                                 for x in record_map})]},
            "record_map": record_map,
            "bd_association_scope": {
                "source_dataset_id": source_dataset_id,
                "source_product_ids": sorted({x["source_product_id"] for x in record_map}),
                "record_ids": sorted({x["source_record_id"] for x in record_map}),
                "record_versions": sorted({x["source_record_version"] for x in record_map}),
                "note": "BD restores its own source/evidence mapping from these WFD identities; "
                        "no BD mapping table is carried."},
            "included_reads": included_reads, "read_dependencies": [],
            "records": [], "storage_packages": [{"snapshot_id": target_sid,
                                                  "directory": f"storage/{target_sid}"}],
            "carrier": {"engine_key": "source_bundle",
                        "purpose": "internal engine carrier only; no external source, evidence or BD lineage",
                        "allowed_keys": sorted(_STRUCTURED_ALLOWED_CARRIER)},
            "wfd_permissions": {"export_role_checked": True,
                                "import_requires_wfd_read_role": True,
                                "source_permissions_required": False,
                                "redistribution_permissions_in_package": False},
            "read_self_contained": True, "bd_required": False,
            "source_permission_required": False, "write_authority_granted": False,
            "target_instance_held_time": "unknown; P4a2 target holding ledger not implemented",
            "excluded": copy.deepcopy(_STRUCTURED_EXCLUDED),
        }
        (destination / "financial_bundle.json").write_bytes(canonical(descriptor))
        inv = [{"path": p.relative_to(destination).as_posix(), "sha256": sha_file(p),
                "size": p.stat().st_size}
               for p in sorted(destination.rglob("*"))
               if p.is_file() and p.name != "CHECKSUMS.json"]
        (destination / "CHECKSUMS.json").write_bytes(canonical(inv))
        _verify_structured_delta_bundle(destination)
        return descriptor


def _verify_structured_delta_bundle(bundle):
    bundle = Path(bundle)
    descriptor = _json(bundle / "financial_bundle.json")
    if (descriptor.get("format_version") != STRUCTURED_BUNDLE_FORMAT
            or descriptor.get("profile") != STRUCTURED_PROFILE
            or descriptor.get("mode") != "delta"):
        raise ValueError("STRUCTURED_BUNDLE_PROFILE_INVALID")
    if descriptor.get("read_dependencies"):
        raise ValueError("STRUCTURED_READ_DEPENDENCY_NOT_IMPLEMENTED")
    inventory = _json(bundle / "CHECKSUMS.json")
    listed = set()
    for item in inventory:
        rel = _structured_safe_rel(item["path"])
        path = _structured_safe_target(bundle, rel)
        if not path.is_file() or path.is_symlink() or path.stat().st_size != item["size"] \
                or sha_file(path) != item["sha256"] or rel in listed:
            raise ValueError("BUNDLE_INTEGRITY_FAILED:" + rel)
        listed.add(rel)
    actual = {p.relative_to(bundle).as_posix() for p in bundle.rglob("*") if p.is_file()}
    if actual != listed | {"CHECKSUMS.json"}:
        raise ValueError("BUNDLE_INVENTORY_MISMATCH")
    selection = descriptor.get("selection") or {}
    selection_digest = _structured_normalized_digest(selection)
    if selection_digest != descriptor.get("selection_digest"):
        raise ValueError("STRUCTURED_SELECTION_DIGEST_MISMATCH")
    baseline_sid = (descriptor.get("baseline") or {}).get("target_snapshot_id")
    target_sid = "s_" + sha(canonical([STRUCTURED_BUNDLE_FORMAT, "delta",
                                       selection_digest, baseline_sid,
                                       descriptor.get("target_state_digest")]))[:24]
    if target_sid != descriptor.get("target_snapshot_id"):
        raise ValueError("STRUCTURED_TARGET_ID_MISMATCH")
    expected_bundle = "sd_" + sha(canonical([selection_digest, target_sid,
                                             descriptor.get("target_state_digest")]))[:24]
    if expected_bundle != descriptor.get("bundle_id"):
        raise ValueError("STRUCTURED_BUNDLE_ID_MISMATCH")
    if "sha256:" + sha(canonical(descriptor.get("logical_state"))) != descriptor.get("logical_state_digest"):
        raise ValueError("STRUCTURED_LOGICAL_STATE_MISMATCH")
    snap, products, checked, files = _structured_delta_scan_package(bundle, descriptor)
    _structured_delta_record_map(descriptor, snap, files)
    for entry in snap["files"]:
        rel = entry["file_relpath"]
        if rel in files:
            if sha(files[rel]) != entry["file_sha256"]:
                raise ValueError("STRUCTURED_FILE_HASH_MISMATCH:" + entry["product_id"])
        elif not any(item["relative_path"] == rel and item["sha256"] == entry["file_sha256"]
                     for item in descriptor.get("baseline_reused_files", [])):
            raise ValueError("STRUCTURED_BASELINE_OBJECT_MISSING:" + rel)
    if not descriptor.get("missing_objects"):
        raise ValueError("STRUCTURED_DELTA_NO_MISSING_OBJECTS")
    _structured_scan_json(descriptor, "financial_bundle")
    return descriptor


def apply_structured_delta_bundle(bundle, target_store, *, runtime_root,
                                  caller_roles=None, protocol_root=None,
                                  interrupt_after=None):
    """Apply a structured delta to an existing target; old snapshot remains readable."""
    bundle, target_store = Path(bundle), Path(target_store)
    descriptor = _verify_structured_delta_bundle(bundle)
    roles = set(["read", "read_evidence"] if caller_roles is None else caller_roles)
    if "read" not in roles:
        raise PermissionError("WFD_READ_PERMISSION_REQUIRED")
    if not target_store.is_dir():
        raise ValueError("STRUCTURED_TARGET_STORE_MISSING")
    baseline_sid = descriptor["baseline"]["target_snapshot_id"]
    baseline_path = target_store / f"catalog/snapshots/{baseline_sid}.json"
    if not baseline_path.is_file():
        raise ValueError("STRUCTURED_BASELINE_UNAVAILABLE:" + baseline_sid)
    baseline_snap = _json(baseline_path)
    baseline_receipt = baseline_snap.get("receipt") or {}
    baseline_selection = (baseline_receipt.get("normalized_selection_digest")
                          or baseline_receipt.get("selection_digest"))
    if baseline_selection != descriptor["baseline"].get("normalized_selection_digest"):
        raise ValueError("STRUCTURED_BASELINE_SELECTION_MISMATCH")
    package = bundle / descriptor["storage_packages"][0]["directory"]
    checked, files = _package_files(package)
    snap = _json_bytes(files[f"catalog/snapshots/{descriptor['target_snapshot_id']}.json"])
    # Verify definition/contract files and four role bodies from the baseline target.
    catalog = {}
    for entry in snap["files"]:
        product = entry["source_bundle"]["_wfd_product_bindings"][entry["output_key"]]["product"]
        _structured_assert_no_read_dependencies(descriptor, {entry["product_id"]: product})
        definition = product["definition_ref"]
        dd = definition["digest"].removeprefix("sha256:")
        drel = f"catalog/product_service/definitions/{dd}.json"
        dpath = target_store / drel
        if not dpath.is_file() or canonical(_json_bytes(dpath.read_bytes())) != canonical(
                {"definition_ref": definition, "declaration": product["declaration"]}):
            raise ValueError("STRUCTURED_DEFINITION_FILE_MISMATCH:" + entry["product_id"])
        for role, body_key in _STRUCTURED_ROLE_BODY.items():
            ref = product["contract_refs"][role]
            digest = ref["digest"].removeprefix("sha256:")
            path = target_store / f"catalog/product_service/contracts/{role}/{digest}.json"
            if not path.is_file() or canonical(_json_bytes(path.read_bytes())) != canonical(
                    product["contracts"][body_key]):
                raise ValueError("STRUCTURED_CONTRACT_BODY_MISMATCH:" + role)
        bundle_ref = product["contract_bundle_ref"]
        bd = bundle_ref["digest"].removeprefix("sha256:")
        bpath = target_store / f"catalog/product_service/contract_bundles/{bd}.json"
        if not bpath.is_file():
            raise ValueError("STRUCTURED_CONTRACT_BUNDLE_MISSING")
        for obj in checked["inventory"]["objects"]:
            for rel in obj["rel_paths"]:
                existing = target_store / rel
                if existing.is_file() and sha_file(existing) != obj["sha256"]:
                    raise ValueError("STRUCTURED_PATH_HASH_CONFLICT:" + rel)
        for entry in snap["files"]:
            rel = entry["file_relpath"]
            if rel in files:
                if sha(files[rel]) != entry["file_sha256"]:
                    raise ValueError("STRUCTURED_FILE_HASH_MISMATCH")
            else:
                path = target_store / rel
                if not path.is_file() or sha_file(path) != entry["file_sha256"]:
                    raise ValueError("STRUCTURED_DEPENDENCY_MISSING:" + rel)
    bundle_id = descriptor["bundle_id"]
    record_path = target_store / f"catalog/bundles/{bundle_id}.json"
    record_path.parent.mkdir(parents=True, exist_ok=True)
    prior_record = _json(record_path) if record_path.is_file() else None
    commit_path = target_store / f"catalog/commits/{descriptor['target_snapshot_id']}.json"
    legacy_applied = commit_path.is_file() and (
        not isinstance(prior_record, dict) or not prior_record.get("instance_id"))
    instance_id = None
    instance_source = None
    if not legacy_applied:
        instance = resolve_target_instance(target_store, create=True)
        instance_id = instance["instance_id"]
        instance_source = instance["source"]
    active_before = (_json(target_store / "catalog/state.json").get("active_head")
                     if (target_store / "catalog/state.json").is_file() else None)
    staging = {"format_version": "wfd.structured-delta/1.0", "bundle_id": bundle_id,
               "kind": "structured_delta", "state": "staging",
               "baseline": copy.deepcopy(descriptor["baseline"]),
               "target_snapshot_id": descriptor["target_snapshot_id"],
               "selection_digest": descriptor["selection_digest"],
               "logical_state_digest": descriptor["logical_state_digest"],
               "instance_id": instance_id,
               "verified_objects": descriptor["missing_objects"],
               "created_at_utc": _now(),
               "target_instance_held_time": "recorded per record at target import; see held_stages"}
    record_path.write_bytes(canonical(staging))
    bundle_identity = _target_bundle_identity(descriptor)
    with writer_lock(target_store):
        commit = target_store / f"catalog/commits/{descriptor['target_snapshot_id']}.json"
        if commit.is_file():
            engine = WFDDuckDBPrototype(target_store, load_protocol_validator(
                Path(protocol_root) if protocol_root else Path(__file__).resolve().parents[1] / "protocol"),
                runtime_root=Path(runtime_root), sandbox=False, writer_host=None)
            existing = _bundle_snapshot(engine, descriptor["target_snapshot_id"])
            receipt = existing.get("receipt") or {}
            if (receipt.get("bundle_id") != descriptor.get("bundle_id")
                    or receipt.get("target_state_digest") != descriptor.get("target_state_digest")
                    or receipt.get("source_record_bindings_digest")
                    != descriptor.get("source_record_bindings_digest")
                    or receipt.get("baseline_snapshot_id") != descriptor["baseline"]["target_snapshot_id"]
                    or receipt.get("source_snapshot_id") != descriptor["source_snapshot_id"]):
                raise ValueError("STRUCTURED_TARGET_IDENTITY_CONFLICT")
            if instance_id is None:
                staging.update({"state": "applied", "applied_at_utc": _now()})
                record_path.write_bytes(canonical(staging))
                return {"status": "already_applied", "bundle_id": bundle_id,
                        "target_snapshot_id": descriptor["target_snapshot_id"],
                        "baseline_snapshot_id": baseline_sid,
                        "instance_id": None,
                        "held_stages": None,
                        "target_instance_held_time": "not_recorded_legacy_target",
                        "active_head": engine.state.read().get("active_head"),
                        "write_authority_granted": False}
            groups = _structured_snapshot_holding_groups(existing)
            baseline_records = _structured_snapshot_record_keys(target_store, baseline_sid)
            holdable = _structured_holdable_groups(
                target_store, instance_id, descriptor["target_snapshot_id"], groups,
                baseline_records)
            recovered_at = _now()
            current = {"acquired": recovered_at, "custodied": recovered_at,
                       "published_readable": recovered_at}
            _record_target_holdings(
                target_store, instance_id, descriptor["target_snapshot_id"], holdable,
                bundle_identity, current, baseline_records=baseline_records)
            held = target_holding_summary(target_store, instance_id, groups)
            staging.update({"state": "applied", "applied_at_utc": _now(),
                            "holdings_recorded_at": recovered_at})
            record_path.write_bytes(canonical(staging))
            return {"status": "already_applied", "bundle_id": bundle_id,
                    "target_snapshot_id": descriptor["target_snapshot_id"],
                    "baseline_snapshot_id": baseline_sid,
                    "instance_id": instance_id,
                    "target_instance_binding": instance_source,
                    "held_stages": held,
                    "target_instance_held_time": "preserved from first target import",
                    "active_head": engine.state.read().get("active_head"),
                    "write_authority_granted": False}
        result = import_package(package, target_store, interrupt_after=interrupt_after)
        if result["status"] == "interrupted":
            staging.update({"state": "staging", "copied": result.get("copied", []),
                            "reused": result.get("reused", []), "updated_at_utc": _now()})
            record_path.write_bytes(canonical(staging))
            return {"status": "interrupted", "bundle_id": bundle_id,
                    "target_snapshot_id": descriptor["target_snapshot_id"],
                    "baseline_snapshot_id": baseline_sid,
                    "instance_id": instance_id,
                    "copied": result.get("copied", []),
                    "staging_record": str(record_path.relative_to(target_store))}
        if result["status"] != "imported":
            raise ValueError("BUNDLE_IMPORT_FAILED:" + str(result.get("code")))
        acquired_at = _now()
        engine = WFDDuckDBPrototype(target_store, load_protocol_validator(
            Path(protocol_root) if protocol_root else Path(__file__).resolve().parents[1] / "protocol"),
            runtime_root=Path(runtime_root), sandbox=False, writer_host=None)
        snapshot = _bundle_snapshot(engine, descriptor["target_snapshot_id"])
        groups = _structured_snapshot_holding_groups(snapshot)
        baseline_records = _structured_snapshot_record_keys(target_store, baseline_sid)
        holdable = _structured_holdable_groups(
            target_store, instance_id, descriptor["target_snapshot_id"], groups,
            baseline_records)
        for product_id, records in holdable.items():
            if records:
                write_target_stage_proof(
                    target_store, instance_id=instance_id, bundle=bundle_identity,
                    snapshot_id=descriptor["target_snapshot_id"],
                    product_id=product_id, records=records,
                    stages={"acquired": acquired_at})
        custodied_at = _now()
        for product_id, records in holdable.items():
            if records:
                write_target_stage_proof(
                    target_store, instance_id=instance_id, bundle=bundle_identity,
                    snapshot_id=descriptor["target_snapshot_id"],
                    product_id=product_id, records=records,
                    stages={"custodied": custodied_at})
        service = WFDDataOnlyService(engine, caller_roles=roles,
                                     caller_id="structured-delta-import")
        for expected in descriptor["included_reads"]:
            rows = [item["row"] for item in service.read(
                expected["target_product_id"], snapshot_id=descriptor["target_snapshot_id"])["rows"]]
            if len(rows) != expected["row_count"] or "sha256:" + sha(canonical(rows)) != expected["rows_sha256"]:
                raise ValueError("STRUCTURED_FIXED_READ_MISMATCH:" + expected["target_product_id"])
        readable_at = _now()
        for product_id, records in holdable.items():
            if records:
                write_target_stage_proof(
                    target_store, instance_id=instance_id, bundle=bundle_identity,
                    snapshot_id=descriptor["target_snapshot_id"],
                    product_id=product_id, records=records,
                    stages={"published_readable": readable_at})
        _record_target_holdings(
            target_store, instance_id, descriptor["target_snapshot_id"], holdable,
            bundle_identity,
            {"acquired": acquired_at, "custodied": custodied_at,
             "published_readable": readable_at},
            baseline_records=baseline_records)
        held = target_holding_summary(target_store, instance_id, groups)
        old = service.read(descriptor["included_reads"][0]["target_product_id"],
                           snapshot_id=baseline_sid)
        if old.get("rows") is None:
            raise ValueError("STRUCTURED_BASELINE_READ_FAILED")
        state = engine.state.read()
        if state.get("active_head") != active_before:
            raise ValueError("STRUCTURED_UNEXPECTED_HEAD_ACTIVATION")
        if state.get("writer_host") is not None:
            raise ValueError("STRUCTURED_UNEXPECTED_WRITE_AUTHORITY")
        staging.update({"state": "applied", "applied_at_utc": _now(),
                        "holdings_recorded_at": readable_at,
                        "active_head": state.get("active_head"),
                        "imported_head": state.get("imported_head"),
                        "write_authority_granted": False})
        record_path.write_bytes(canonical(staging))
    return {"status": "applied", "bundle_id": bundle_id,
            "target_snapshot_id": descriptor["target_snapshot_id"],
            "baseline_snapshot_id": baseline_sid,
            "selection_digest": descriptor["selection_digest"],
            "logical_state_digest": descriptor["logical_state_digest"],
            "record_map": descriptor["record_map"],
            "verified_reads": descriptor["included_reads"],
            "instance_id": instance_id,
            "target_instance_binding": instance_source,
            "held_stages": held,
            "target_instance_held_time": "recorded per record at target import; see held_stages",
            "active_head": state.get("active_head"),
            "imported_head": state.get("imported_head"),
            "write_authority_granted": False}


# R2b structured reference package (WFD internal fixed data dependency only).
# ---------------------------------------------------------------------------

STRUCTURED_REFERENCE_FORMAT = "wfd.structured-reference/1.0"
_STRUCTURED_REFERENCE_DESCRIPTOR_KEYS = {
    "format_version", "profile", "mode", "reference_format", "reference_id",
    "perspective", "selection", "selection_digest", "normalized_selection_digest",
    "source_dataset_id", "source_snapshot_id", "external_objects",
    "record_bindings_digest", "read_self_contained", "source_permission_required",
    "bd_required", "wfd_permissions", "storage_packages", "records",
    "target_snapshot_id", "included_reads", "target_instance_held_time",
    "write_authority_granted", "excluded",
}
_STRUCTURED_REFERENCE_EXTERNAL_KEYS = {
    "kind", "dataset_id", "snapshot_id", "product_id", "definition_digest",
    "definition_ref", "contract_bundle_digest", "contract_bundle_ref",
    "contract_refs", "contracts_digest", "required",
    "purposes", "role", "fields", "subject", "business_time_range",
    "row_count", "rows_sha256", "record_bindings",
}
_STRUCTURED_REFERENCE_BINDING_KEYS = {
    "record_id", "record_version", "row_sha256",
}
_STRUCTURED_REFERENCE_PERMISSION_KEYS = {
    "target_wfd_read_required", "source_resolver_read_permission_required",
    "package_grants_source_or_redistribution", "resolver_location_in_package",
}


def _structured_reference_rows(service, product, fields, subject, business_range):
    query = ProductQuery(service)
    normalized = (query._business_time_range({"business_time_range": business_range})
                  if business_range is not None else None)
    expected_subject = subject or product.get("subject")
    bindings, selected_rows = [], []
    for item in service.read(product["product_id"], snapshot_id=product["_snapshot_id"],
                             include_history=False)["rows"]:
        if item.get("subject") != expected_subject:
            continue
        if normalized is not None:
            role = normalized["role"] if normalized else "observation"
            business_time, code, _ = query._row_business_time(
                item.get("row") or {}, role, product)
            if code or query._time_decision(business_time, normalized) != "contained":
                continue
        row = copy.deepcopy(item["row"] or {})
        if product.get("payload_kind") == "scalar_rows":
            pass
        else:
            values = row.get("values") or {}
            row["values"] = {code: values[code] for code in fields if code in values}
        revision = copy.deepcopy(item.get("revision") or {})
        bindings.append({
            "record_id": revision.get("logical_key"),
            "record_version": revision.get("revision_id"),
            "row_sha256": "sha256:" + sha(canonical(row)),
        })
        selected_rows.append({"record_id": revision.get("logical_key"),
                              "record_version": revision.get("revision_id"),
                              "row": copy.deepcopy(row)})
    return bindings, normalized, selected_rows


def _structured_reference_path(root, rel):
    if not isinstance(rel, str) or not rel or "\\" in rel or rel.startswith("/") \
            or re.match(r"^[A-Za-z]:", rel):
        raise ValueError("STRUCTURED_PATH_INVALID:" + repr(rel))
    parts = PurePosixPath(rel).parts
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("STRUCTURED_PATH_INVALID:" + rel)
    root = Path(root).resolve()
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise ValueError("STRUCTURED_PATH_ESCAPE:" + rel)
    cursor = root
    for part in parts:
        cursor = cursor / part
        if cursor.exists() and cursor.is_symlink():
            raise ValueError("STRUCTURED_SYMLINK_FORBIDDEN:" + rel)
    return target


def export_structured_reference_bundle(service, product_ids, destination, *, snapshot_id,
                                       selection=None, perspective="snapshot_contents"):
    """Export metadata-only reference to fixed external WFD structured product(s)."""
    if service.has_permission("read") is not True:
        raise PermissionError("WFD_READ_PERMISSION_REQUIRED")
    if perspective != "snapshot_contents":
        raise ValueError("STRUCTURED_PERSPECTIVE_NOT_IMPLEMENTED")
    destination = Path(destination)
    if destination.exists():
        raise ValueError("BUNDLE_DESTINATION_EXISTS")
    selection_products, selection_core = _structured_export_selection(
        service, product_ids, snapshot_id, selection, perspective)
    source_dataset_id = selection_core["source_dataset_id"]
    normalized_digest = _structured_normalized_digest(selection_core)
    external = []
    for item in sorted(selection_products, key=lambda x: x["product_id"]):
        product = item["product"]
        product = copy.deepcopy(product)
        product["_snapshot_id"] = snapshot_id
        bindings, normalized_range, _ = _structured_reference_rows(
            service, product, item["fields"], item.get("subject"),
            item["business_time_range"])
        external.append({
            "kind": "wfd_internal_product_reference",
            "dataset_id": product["dataset_id"],
            "snapshot_id": snapshot_id,
            "product_id": product["product_id"],
            "definition_digest": product["definition_ref"]["digest"],
            "definition_ref": copy.deepcopy(product["definition_ref"]),
            "contract_bundle_digest": product["contract_bundle_ref"]["digest"],
            "contract_bundle_ref": copy.deepcopy(product["contract_bundle_ref"]),
            "contract_refs": copy.deepcopy(product["contract_refs"]),
            "contracts_digest": "sha256:" + sha(canonical(product["contracts"])),
            "required": True,
            "purposes": ["read"],
            "role": item.get("role") or "selected",
            "fields": item["fields"],
            "subject": copy.deepcopy(item.get("subject") or product.get("subject")),
            "business_time_range": copy.deepcopy(normalized_range),
            "row_count": len(bindings),
            "rows_sha256": "sha256:" + sha(canonical([b["row_sha256"] for b in bindings])),
            "record_bindings": bindings,
        })
    record_bindings = [{"dataset_id": obj["dataset_id"], "snapshot_id": obj["snapshot_id"],
                        "product_id": obj["product_id"], **binding}
                       for obj in external for binding in obj["record_bindings"]]
    bindings_digest = "sha256:" + sha(canonical(record_bindings))
    reference_id = _structured_reference_identity(
        {"selection": selection_core, "source_dataset_id": source_dataset_id,
         "source_snapshot_id": snapshot_id, "external_objects": external})
    descriptor = {
        "format_version": STRUCTURED_BUNDLE_FORMAT,
        "profile": STRUCTURED_PROFILE,
        "mode": "reference",
        "reference_format": STRUCTURED_REFERENCE_FORMAT,
        "reference_id": reference_id,
        "perspective": perspective,
        "selection": copy.deepcopy(selection_core),
        "selection_digest": normalized_digest,
        "normalized_selection_digest": normalized_digest,
        "source_dataset_id": source_dataset_id,
        "source_snapshot_id": snapshot_id,
        "external_objects": external,
        "record_bindings_digest": bindings_digest,
        "read_self_contained": False,
        "source_permission_required": True,
        "bd_required": False,
        "wfd_permissions": {
            "target_wfd_read_required": True,
            "source_resolver_read_permission_required": True,
            "package_grants_source_or_redistribution": False,
            "resolver_location_in_package": False,
        },
        "storage_packages": [],
        "records": [],
        "target_snapshot_id": None,
        "included_reads": [],
        "target_instance_held_time": "unknown; P4a2 target holding ledger not implemented",
        "write_authority_granted": False,
        "excluded": copy.deepcopy(_STRUCTURED_EXCLUDED),
    }
    destination.mkdir(parents=True)
    (destination / "financial_bundle.json").write_bytes(canonical(descriptor))
    inventory = [{"path": p.relative_to(destination).as_posix(),
                  "sha256": sha_file(p), "size": p.stat().st_size}
                 for p in sorted(destination.rglob("*"))
                 if p.is_file() and p.name != "CHECKSUMS.json"]
    (destination / "CHECKSUMS.json").write_bytes(canonical(inventory))
    _verify_structured_reference_bundle(destination)
    return descriptor


def _structured_reference_identity(body):
    return "sr_" + sha(canonical(body))[:24]


def _structured_reference_ref_shape(ref, *, role=None, bundle=False):
    keys = {"dataset_id", "dependency_type", "digest", "id", "kind", "namespace",
            "required", "resolution", "version"}
    if role is not None:
        keys.add("role")
    if bundle:
        keys.add("roles")
    _structured_exact_keys(ref, keys, "reference_ref")
    digest = ref["digest"]
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("STRUCTURED_REFERENCE_REF_DIGEST_INVALID")
    if ref["kind"] != ("contract_bundle" if bundle else
                      ("definition_version" if role is None else "contract")):
        raise ValueError("STRUCTURED_REFERENCE_REF_KIND_INVALID")
    if ref["namespace"] != "wfd.product" or ref["required"] is not True \
            or ref["resolution"] != "pinned" or ref["dependency_type"] != "read":
        raise ValueError("STRUCTURED_REFERENCE_REF_SHAPE_INVALID")
    if not isinstance(ref["dataset_id"], str) or not ref["dataset_id"]:
        raise ValueError("STRUCTURED_REFERENCE_REF_DATASET_INVALID")
    if not isinstance(ref["id"], str) or not re.fullmatch(
            r"(?:def_[0-9a-f]{24}|cb_[0-9a-f]{24}|contract_[a-z0-9_]+[0-9a-f]{24})", ref["id"]):
        raise ValueError("STRUCTURED_REFERENCE_REF_ID_INVALID")
    if ref["version"] != "v_" + digest.removeprefix("sha256:")[:16]:
        raise ValueError("STRUCTURED_REFERENCE_REF_VERSION_INVALID")
    if role is not None and ref["role"] != role:
        raise ValueError("STRUCTURED_REFERENCE_REF_ROLE_INVALID")
    if bundle and set(ref["roles"]) != set(_STRUCTURED_ROLE_BODY):
        raise ValueError("STRUCTURED_REFERENCE_REF_ROLES_INVALID")


def _structured_reference_scalar(value, label, pattern=r"^[A-Za-z0-9_.:-]{1,200}$"):
    if not isinstance(value, str) or not value or not re.fullmatch(pattern, value):
        raise ValueError("STRUCTURED_REFERENCE_SCALAR_INVALID:" + label)
    return value


def _structured_validate_reference_subject(value, label="reference_subject"):
    _structured_exact_keys(value, {"kind", "namespace", "id"}, label)
    _structured_reference_scalar(value["kind"], label + ".kind")
    _structured_reference_scalar(value["namespace"], label + ".namespace")
    _structured_reference_scalar(value["id"], label + ".id")


def _structured_validate_reference_time_range(value, label="reference_time_range"):
    allowed = {"role", "start", "end", "timezone", "start_utc", "end_utc",
               "boundary_rule", "dst_rule"}
    _structured_exact_keys(value, allowed, label)
    if value.get("role") != "observation" or any(
            not isinstance(value.get(key), str) or not value.get(key)
            for key in ("start", "end", "timezone", "start_utc", "end_utc",
                        "boundary_rule", "dst_rule")):
        raise ValueError("STRUCTURED_REFERENCE_TIME_RANGE_INVALID")
    if value["start"] > value["end"]:
        raise ValueError("STRUCTURED_REFERENCE_TIME_RANGE_INVALID")


def _structured_validate_reference_selection(selection):
    _structured_exact_keys(selection, {
        "profile", "perspective", "source_dataset_id", "source_snapshot_id",
        "products"}, "reference_selection")
    if selection["profile"] != STRUCTURED_PROFILE \
            or selection["perspective"] != "snapshot_contents":
        raise ValueError("STRUCTURED_REFERENCE_SELECTION_INVALID")
    _structured_reference_scalar(selection["source_dataset_id"],
                                 "selection.source_dataset_id")
    _structured_reference_scalar(selection["source_snapshot_id"],
                                 "selection.source_snapshot_id",
                                 r"^s_[0-9a-f]{24}$")
    products = selection.get("products")
    if not isinstance(products, list) or not products:
        raise ValueError("STRUCTURED_REFERENCE_SELECTION_INVALID")
    selectors = {}
    for item in products:
        _structured_exact_keys(item, {
            "product_id", "fields", "subject", "business_time_range"},
            "reference_selection_product")
        _structured_reference_scalar(item["product_id"], "selection.product_id",
                                     r"^p_[A-Za-z0-9_.:-]{1,120}$")
        if item["product_id"] in selectors:
            raise ValueError("STRUCTURED_REFERENCE_SELECTION_DUPLICATE")
        fields = item.get("fields")
        if not isinstance(fields, list) or not fields \
                or fields != sorted(set(fields)) \
                or any(not isinstance(field, str) or not re.fullmatch(
                    r"^[A-Za-z0-9_.:-]{1,120}$", field) for field in fields):
            raise ValueError("STRUCTURED_REFERENCE_FIELDS_INVALID")
        subject = item.get("subject")
        if subject is not None:
            _structured_validate_reference_subject(subject, "selection.subject")
        tr = item.get("business_time_range")
        if tr is not None:
            if not isinstance(tr, dict) or set(tr) not in (
                    {"role", "start", "end", "timezone"},
                    {"role", "start", "end", "timezone", "start_utc", "end_utc",
                     "boundary_rule", "dst_rule"}):
                raise ValueError("STRUCTURED_REFERENCE_TIME_RANGE_INVALID")
            if set(tr) == {"role", "start", "end", "timezone"}:
                if tr.get("role") != "observation" or any(
                        not isinstance(tr.get(key), str) or not tr.get(key)
                        for key in ("start", "end", "timezone")):
                    raise ValueError("STRUCTURED_REFERENCE_TIME_RANGE_INVALID")
                if tr["start"] > tr["end"]:
                    raise ValueError("STRUCTURED_REFERENCE_TIME_RANGE_INVALID")
            else:
                _structured_validate_reference_time_range(tr, "selection.time_range")
        selectors[item["product_id"]] = item
    return selectors


def _normalized_reference_time_range(value):
    if value is None:
        return None
    try:
        normalizer = object.__new__(ProductQuery)
        return normalizer._business_time_range({"business_time_range": value})
    except (ProductQueryError, KeyError, TypeError, ValueError) as exc:
        raise ValueError("STRUCTURED_REFERENCE_TIME_RANGE_INVALID") from exc


def _structured_validate_reference_external(obj, descriptor):
    _structured_exact_keys(obj, _STRUCTURED_REFERENCE_EXTERNAL_KEYS, "external_object")
    if obj.get("required") is not True or obj.get("purposes") != ["read"] \
            or obj.get("kind") != "wfd_internal_product_reference":
        raise ValueError("STRUCTURED_REFERENCE_PURPOSE_INVALID")
    if obj.get("role") != "selected":
        raise ValueError("STRUCTURED_REFERENCE_ROLE_INVALID")
    _structured_reference_scalar(obj["dataset_id"], "external.dataset_id")
    _structured_reference_scalar(obj["snapshot_id"], "external.snapshot_id",
                                 r"^s_[0-9a-f]{24}$")
    _structured_reference_scalar(obj["product_id"], "external.product_id",
                                 r"^p_[A-Za-z0-9_.:-]{1,120}$")
    if obj.get("dataset_id") != descriptor["source_dataset_id"]:
        raise ValueError("STRUCTURED_REFERENCE_DATASET_MISMATCH")
    if obj.get("snapshot_id") != descriptor["source_snapshot_id"]:
        raise ValueError("STRUCTURED_REFERENCE_SNAPSHOT_MISMATCH")
    for key in ("definition_digest", "contract_bundle_digest", "contracts_digest"):
        if not isinstance(obj.get(key), str) or not re.fullmatch(
                r"sha256:[0-9a-f]{64}", obj[key]):
            raise ValueError("STRUCTURED_REFERENCE_DIGEST_INVALID:" + key)
    _structured_reference_ref_shape(obj["definition_ref"])
    _structured_reference_ref_shape(obj["contract_bundle_ref"], bundle=True)
    if obj["definition_ref"]["digest"] != obj["definition_digest"] \
            or obj["contract_bundle_ref"]["digest"] != obj["contract_bundle_digest"]:
        raise ValueError("STRUCTURED_REFERENCE_REF_DIGEST_MISMATCH")
    _structured_validate_reference_subject(obj.get("subject"))
    if obj.get("business_time_range") is not None:
        _structured_validate_reference_time_range(obj.get("business_time_range"))
    if not isinstance(obj.get("fields"), list) or not obj["fields"] \
            or obj["fields"] != sorted(set(obj["fields"])) \
            or any(not isinstance(field, str) or not re.fullmatch(
                r"^[A-Za-z0-9_.:-]{1,120}$", field) for field in obj["fields"]):
        raise ValueError("STRUCTURED_REFERENCE_FIELDS_INVALID")
    if set(obj.get("contract_refs") or {}) != set(_STRUCTURED_ROLE_BODY):
        raise ValueError("STRUCTURED_REFERENCE_CONTRACT_ROLE_MISMATCH")
    for role in _STRUCTURED_ROLE_BODY:
        _structured_reference_ref_shape(obj["contract_refs"][role], role=role)
        if obj["contract_refs"][role]["dataset_id"] != obj["dataset_id"]:
            raise ValueError("STRUCTURED_REFERENCE_CONTRACT_DATASET_MISMATCH")
    seen = set()
    for binding in obj.get("record_bindings") or []:
        _structured_exact_keys(binding, _STRUCTURED_REFERENCE_BINDING_KEYS,
                               "reference_record_binding")
        _structured_reference_scalar(binding["record_id"],
                                     "record_binding.record_id")
        if not isinstance(binding["record_version"], str) \
                or not re.fullmatch(r"r_[0-9a-f]{32}", binding["record_version"]) \
                or not isinstance(binding["row_sha256"], str) \
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", binding["row_sha256"]):
            raise ValueError("STRUCTURED_REFERENCE_RECORD_BINDING_INVALID")
        if binding["record_id"] in seen:
            raise ValueError("STRUCTURED_REFERENCE_RECORD_BINDING_DUPLICATE")
        seen.add(binding["record_id"])
    bindings = obj.get("record_bindings") or []
    if obj.get("row_count") != len(bindings) \
            or obj.get("rows_sha256") != "sha256:" + sha(canonical(
                [binding["row_sha256"] for binding in bindings])):
        raise ValueError("STRUCTURED_REFERENCE_ROW_DIGEST_MISMATCH")


def _verify_structured_reference_bundle(bundle):
    bundle = Path(bundle)
    for path in bundle.rglob("*"):
        if path.is_symlink():
            raise ValueError("STRUCTURED_SYMLINK_FORBIDDEN:" + path.relative_to(bundle).as_posix())
    descriptor = _json(bundle / "financial_bundle.json")
    if (descriptor.get("format_version") != STRUCTURED_BUNDLE_FORMAT
            or descriptor.get("profile") != STRUCTURED_PROFILE
            or descriptor.get("mode") != "reference"
            or descriptor.get("reference_format") != STRUCTURED_REFERENCE_FORMAT):
        raise ValueError("STRUCTURED_REFERENCE_PROFILE_INVALID")
    _structured_exact_keys(descriptor, _STRUCTURED_REFERENCE_DESCRIPTOR_KEYS, "reference_descriptor")
    if descriptor.get("read_self_contained") is not False:
        raise ValueError("STRUCTURED_REFERENCE_CLAIMS_SELF_CONTAINED")
    if descriptor.get("source_permission_required") is not True:
        raise ValueError("STRUCTURED_REFERENCE_SOURCE_PERMISSION_CLAIM")
    if descriptor.get("bd_required") is not False:
        raise ValueError("STRUCTURED_REFERENCE_BD_CLAIM")
    if descriptor.get("storage_packages") != [] or descriptor.get("records") != []:
        raise ValueError("STRUCTURED_REFERENCE_HAS_STORAGE")
    if descriptor.get("target_snapshot_id") is not None:
        raise ValueError("STRUCTURED_REFERENCE_HAS_TARGET_SNAPSHOT")
    _structured_exact_keys(descriptor.get("wfd_permissions") or {},
                           _STRUCTURED_REFERENCE_PERMISSION_KEYS, "reference_permissions")
    if descriptor["wfd_permissions"] != {
            "target_wfd_read_required": True,
            "source_resolver_read_permission_required": True,
            "package_grants_source_or_redistribution": False,
            "resolver_location_in_package": False}:
        raise ValueError("STRUCTURED_REFERENCE_PERMISSION_INVALID")
    selection = descriptor.get("selection") or {}
    selectors = _structured_validate_reference_selection(selection)
    if selection["source_dataset_id"] != descriptor["source_dataset_id"] \
            or selection["source_snapshot_id"] != descriptor["source_snapshot_id"]:
        raise ValueError("STRUCTURED_REFERENCE_SELECTION_SOURCE_MISMATCH")
    if _structured_normalized_digest(selection) != descriptor.get("selection_digest"):
        raise ValueError("STRUCTURED_REFERENCE_SELECTION_MISMATCH")
    external = descriptor.get("external_objects")
    if not isinstance(external, list) or not external:
        raise ValueError("STRUCTURED_REFERENCE_EMPTY")
    reference_id = descriptor.get("reference_id")
    if not isinstance(reference_id, str) or not re.fullmatch(r"sr_[0-9a-f]{24}", reference_id):
        raise ValueError("STRUCTURED_REFERENCE_ID_FORMAT_INVALID")
    expected_id = _structured_reference_identity({
        "selection": descriptor["selection"],
        "source_dataset_id": descriptor["source_dataset_id"],
        "source_snapshot_id": descriptor["source_snapshot_id"],
        "external_objects": external,
    })
    if reference_id != expected_id:
        raise ValueError("STRUCTURED_REFERENCE_ID_MISMATCH")
    record_bindings = []
    seen_products = set()
    for obj in external:
        _structured_validate_reference_external(obj, descriptor)
        selector = selectors.get(obj["product_id"])
        if selector is None or obj["product_id"] in seen_products:
            raise ValueError("STRUCTURED_REFERENCE_SELECTION_PRODUCT_MISMATCH")
        seen_products.add(obj["product_id"])
        if canonical(obj["fields"]) != canonical(selector["fields"]):
            raise ValueError("STRUCTURED_REFERENCE_FIELDS_MISMATCH")
        if selector.get("subject") is not None \
                and canonical(obj["subject"]) != canonical(selector["subject"]):
            raise ValueError("STRUCTURED_REFERENCE_SUBJECT_MISMATCH")
        if canonical(obj.get("business_time_range")) != canonical(
                _normalized_reference_time_range(selector.get("business_time_range"))):
            raise ValueError("STRUCTURED_REFERENCE_TIME_RANGE_MISMATCH")
        record_bindings.extend({"dataset_id": obj["dataset_id"],
                                "snapshot_id": obj["snapshot_id"],
                                "product_id": obj["product_id"], **binding}
                               for binding in obj.get("record_bindings") or [])
    if seen_products != set(selectors):
        raise ValueError("STRUCTURED_REFERENCE_SELECTION_PRODUCT_MISMATCH")
    if "sha256:" + sha(canonical(record_bindings)) != descriptor.get("record_bindings_digest"):
        raise ValueError("STRUCTURED_REFERENCE_RECORD_BINDING_DIGEST_MISMATCH")
    inventory = _json(bundle / "CHECKSUMS.json")
    listed = set()
    for item in inventory:
        rel = item["path"]
        path = _structured_reference_path(bundle, rel)
        if not path.is_file() or path.is_symlink() or path.stat().st_size != item["size"] \
                or sha_file(path) != item["sha256"] or rel in listed:
            raise ValueError("BUNDLE_INTEGRITY_FAILED:" + rel)
        listed.add(rel)
    actual = {p.relative_to(bundle).as_posix() for p in bundle.rglob("*") if p.is_file()}
    if actual != listed | {"CHECKSUMS.json"}:
        raise ValueError("BUNDLE_INVENTORY_MISMATCH")
    return descriptor


def _structured_resolver_dataset(resolver):
    path = Path(resolver.root) / "catalog/product_service/dataset.json"
    if path.is_file():
        try:
            return _json(path).get("dataset_id")
        except ValueError:
            return None
    try:
        state = resolver.engine.state.read() or {}
        sid = state.get("active_head") or state.get("imported_head")
        if not sid:
            return None
        snap = _bundle_snapshot(resolver.engine, sid)
        for entry in snap.get("files", []):
            product = entry.get("source_bundle", {}).get("_wfd_product_bindings", {}).get(
                entry.get("output_key"), {}).get("product")
            if product and product.get("dataset_id"):
                return product["dataset_id"]
    except (ValueError, OSError):
        return None
    return None


class StructuredReferenceHandle:
    """Read-only reference handle; no target snapshot or independent copy exists."""

    def __init__(self, target_store, descriptor, resolvers, caller_roles):
        self.target_store = Path(target_store)
        self.descriptor = copy.deepcopy(descriptor)
        self.resolvers = dict(resolvers or {})
        self.caller_roles = set(caller_roles or [])

    def _read(self):
        if "read" not in self.caller_roles:
            raise PermissionError("WFD_READ_PERMISSION_REQUIRED")
        rows, proofs, gaps = [], [], []
        for obj in self.descriptor["external_objects"]:
            resolver = self.resolvers.get(obj["dataset_id"])
            if resolver is None:
                gaps.append({"dataset_id": obj["dataset_id"], "product_id": obj["product_id"],
                             "snapshot_id": obj["snapshot_id"], "gap": "missing_resolver"})
                continue
            if Path(resolver.root).resolve() == self.target_store.resolve():
                gaps.append({"dataset_id": obj["dataset_id"], "product_id": obj["product_id"],
                             "snapshot_id": obj["snapshot_id"], "gap": "fallback_forbidden"})
                continue
            try:
                resolver_dataset = _structured_resolver_dataset(resolver)
                if resolver_dataset is not None and resolver_dataset != obj["dataset_id"]:
                    gaps.append({"dataset_id": obj["dataset_id"], "product_id": obj["product_id"],
                                 "snapshot_id": obj["snapshot_id"], "gap": "wrong_dataset"})
                    continue
                _, _, product, _ = _source_product(resolver, obj["snapshot_id"],
                                                   obj["product_id"])
                if product.get("dataset_id") != obj["dataset_id"]:
                    gaps.append({"dataset_id": obj["dataset_id"], "product_id": obj["product_id"],
                                 "snapshot_id": obj["snapshot_id"], "gap": "wrong_dataset"})
                    continue
                if (product.get("definition_ref", {}).get("digest") != obj["definition_digest"]
                        or product.get("contract_bundle_ref", {}).get("digest") != obj["contract_bundle_digest"]
                        or canonical(product.get("contract_refs")) != canonical(obj["contract_refs"])
                        or "sha256:" + sha(canonical(product.get("contracts"))) != obj["contracts_digest"]):
                    gaps.append({"dataset_id": obj["dataset_id"], "product_id": obj["product_id"],
                                 "snapshot_id": obj["snapshot_id"], "gap": "identity_or_digest_mismatch"})
                    continue
                if (product.get("contracts", {}).get("read", {}).get("dependencies")
                        or _read_dependencies(product)):
                    gaps.append({"dataset_id": obj["dataset_id"], "product_id": obj["product_id"],
                                 "snapshot_id": obj["snapshot_id"], "gap": "read_dependency_not_supported"})
                    continue
                product = copy.deepcopy(product)
                product["_snapshot_id"] = obj["snapshot_id"]
                bindings, normalized, selected_rows = _structured_reference_rows(
                    resolver, product, obj["fields"], obj.get("subject"),
                    obj.get("business_time_range"))
                if (canonical(bindings) != canonical(obj["record_bindings"])
                        or obj["row_count"] != len(bindings)
                        or obj["rows_sha256"] != "sha256:" + sha(canonical(
                            [binding["row_sha256"] for binding in bindings]))):
                    gaps.append({"dataset_id": obj["dataset_id"], "product_id": obj["product_id"],
                                 "snapshot_id": obj["snapshot_id"], "gap": "content_or_record_version_mismatch"})
                    continue
                for item2 in selected_rows:
                    rows.append(item2)
                proofs.append({"dataset_id": obj["dataset_id"],
                               "snapshot_id": obj["snapshot_id"],
                               "product_id": obj["product_id"],
                               "row_count": len(bindings),
                               "rows_sha256": obj["rows_sha256"],
                               "record_bindings": bindings})
            except PermissionError as exc:
                gaps.append({"dataset_id": obj["dataset_id"], "product_id": obj["product_id"],
                             "snapshot_id": obj["snapshot_id"], "gap": "source_permission_denied",
                             "detail": str(exc)})
            except (ValueError, OSError) as exc:
                gaps.append({"dataset_id": obj["dataset_id"], "product_id": obj["product_id"],
                             "snapshot_id": obj["snapshot_id"], "gap": "unreachable",
                             "detail": str(exc)})
        return rows, proofs, gaps

    def read(self):
        rows, proofs, gaps = self._read()
        if gaps:
            raise ValueError("STRUCTURED_REFERENCE_UNREADABLE:" + json.dumps(gaps, sort_keys=True))
        return {"status": "reference_fixed_read", "read_self_contained": False,
                "source_permission_required": True, "bd_required": False,
                "rows": rows, "proof": proofs,
                "target_instance_held_time": "unknown; P4a2 not implemented"}

    def status(self):
        _, proofs, gaps = self._read()
        return {"readable": not gaps, "read_self_contained": False,
                "dependency_gaps": gaps, "proof": proofs,
                "target_instance_held_time": "unknown; P4a2 not implemented"}


def register_structured_reference_bundle(bundle, target_store, *, resolvers,
                                         runtime_root, protocol_root=None,
                                         caller_roles=None):
    """Register a reference record; target store holds metadata only, no snapshot."""
    bundle, target_store = Path(bundle), Path(target_store)
    descriptor = _verify_structured_reference_bundle(bundle)
    roles = set(["read", "read_evidence"] if caller_roles is None else caller_roles)
    if "read" not in roles:
        raise PermissionError("WFD_READ_PERMISSION_REQUIRED")
    target_store.mkdir(parents=True, exist_ok=True)
    protocol_root = Path(protocol_root) if protocol_root else Path(__file__).resolve().parents[1] / "protocol"
    engine = WFDDuckDBPrototype(target_store, load_protocol_validator(protocol_root),
                                runtime_root=Path(runtime_root), sandbox=False, writer_host=None)
    active_before = (engine.state.read() or {}).get("active_head")
    handle = StructuredReferenceHandle(target_store, descriptor, resolvers, roles)
    status = handle.status()
    record = {
        "format_version": "wfd.structured-reference-registration/1.0",
        "profile": STRUCTURED_PROFILE,
        "reference_format": STRUCTURED_REFERENCE_FORMAT,
        "reference_id": descriptor["reference_id"],
        "descriptor_sha256": "sha256:" + sha(canonical(descriptor)),
        "selection_digest": descriptor["selection_digest"],
        "source_dataset_id": descriptor["source_dataset_id"],
        "source_snapshot_id": descriptor["source_snapshot_id"],
        "external_objects": descriptor["external_objects"],
        "readable": status["readable"],
        "read_self_contained": False,
        "source_permission_required": True,
        "bd_required": False,
        "dependency_gaps": status["dependency_gaps"],
        "proof": status["proof"],
        "registered_at_utc": _now(),
        "target_instance_held_time": "unknown; P4a2 not implemented",
        "active_head": active_before,
        "write_authority_granted": False,
    }
    rel = f"catalog/bundles/{descriptor['reference_id']}.json"
    target_path = _structured_reference_path(target_store, rel)
    body = canonical(record)
    already = False
    with writer_lock(target_store):
        if target_path.exists():
            if target_path.is_symlink() or target_path.read_bytes() != body:
                raise ValueError("STRUCTURED_REFERENCE_IDENTITY_CONFLICT")
            already = True
        else:
            engine._write_immutable(rel, body)
    state = engine.state.read()
    if state.get("active_head") != active_before:
        raise ValueError("STRUCTURED_REFERENCE_UNEXPECTED_HEAD_ACTIVATION")
    if state.get("writer_host") is not None:
        raise ValueError("STRUCTURED_REFERENCE_UNEXPECTED_WRITE_AUTHORITY")
    report = {
        "status": ("reference_already_registered" if already else
                   ("registered_reference_readable" if status["readable"]
                    else "registered_reference_unavailable")),
        "reference_id": descriptor["reference_id"],
        "source_dataset_id": descriptor["source_dataset_id"],
        "source_snapshot_id": descriptor["source_snapshot_id"],
        "readable": status["readable"],
        "read_self_contained": False,
        "source_permission_required": True,
        "bd_required": False,
        "dependency_gaps": status["dependency_gaps"],
        "proof": status["proof"],
        "target_instance_held_time": "unknown; P4a2 not implemented",
        "active_head": state.get("active_head"),
        "write_authority_granted": False,
    }
    return handle, report
