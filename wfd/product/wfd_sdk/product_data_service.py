"""Data-only structured ingress (R1 local isolated boundary).

WFD stores admitted structured data, stable record identity, business time,
data versions and internal definition/contract metadata.  Original files,
source/evidence references, BD locators and external execution traces belong
to BD and are rejected before any write.
"""
from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from jsonschema import Draft202012Validator
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .duckdb_sdk import canonical, sha
from .product_service import (
    SERVICE_VERSION, WFDProductService, _second_now, _issue,
)
from .product_governance import validate_payload, validate_units
from . import product_calendar
from .writerlock import writer_lock

DATA_ONLY_PROTOCOL = "wfd.structured-ingest/1.0"
DATA_ONLY_PROFILE = "data_only"
DATA_ONLY_STATUS_FORMAT = "wfd.data-only-request-state/1.0"
DATA_ONLY_FORMAL_FORMAT = "wfd.data-only-formal-publication/1.0"
DATA_ONLY_SCHEMA_ID = "https://wfd.example/spec/1.0/wfd-structured-ingest.schema.json"
DATA_ONLY_MODES = {"complete_snapshot", "partial_observation", "explicit_increment",
                   "source_correction", "processing_repair", "withdrawal"}
FORBIDDEN_EXTERNAL_KEYS = {
    "source_bundle", "source_id", "source_ids", "source_roles", "source_url",
    "evidence_refs", "evidence", "evidence_ref", "custody", "raw_source",
    "original_path", "original_local_path", "local_path", "file_path",
    "storage_path", "path", "url", "provider", "license",
    "processing", "processing_evidence", "processing_record", "lineage",
    "derived_lineage", "execution", "method", "method_id", "parameters",
    "parameter_digest", "code", "code_digest", "bd_ref", "bd_locator",
    "record_locator", "locator", "original_file_name", "original_file",
    "may_read", "may_read_evidence", "may_submit", "may_publish_formal",
}


def _scan_external_metadata(value, path=""):
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = (path + "." + str(key)) if path else str(key)
            if key in FORBIDDEN_EXTERNAL_KEYS:
                raise ValueError("EXTERNAL_METADATA_FORBIDDEN:" + child_path)
            _scan_external_metadata(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _scan_external_metadata(child, f"{path}[{index}]")


_REF_KEYS = {"kind", "namespace", "id", "version", "digest"}
_IDENTITY_KEYS = {"kind", "namespace", "id", "version"}
_CTX_KEYS = {"version", "content_nature", "measurement_nature", "identity", "time",
             "measurement", "content", "statistical", "financial", "relation",
             "coverage_quality", "source", "version_axis", "derivation",
             "unknown_axes"}
_AXIS_KEYS = {
    "identity": {"subject_kind", "identity_resolution_rule", "alias_scope"},
    "time": {"period_type", "frequency", "interval", "calendar_ref",
             "accounting_calendar_ref", "window", "roles", "timezone"},
    "measurement": {"measurement_nature", "unit_code", "precision", "sign",
                    "aggregation", "value_states"},
    "content": {"assertion_status", "target_period"},
    "statistical": {"sample_scope_ref", "weighting_ref", "price_basis",
                    "base_period_ref", "seasonal_adjustment", "period_aggregation",
                    "denominator_ref", "coverage_scope_ref"},
    "financial": {"accounting_standard_ref", "consolidation_scope",
                  "mapping_comparability_ref", "price_adjustment",
                  "return_definition_ref", "currency_conversion_ref"},
    "relation": {"relation_type", "direction", "set_completeness", "effective_scope"},
    "coverage_quality": {"completeness", "absence_means", "validation_ref", "warmup_ref"},
}
_FIELD_CONTEXT_AXES = {"time", "measurement", "content", "statistical",
                       "financial", "coverage_quality"}
_EXTERNAL_METADATA_KEYS = {
    "source_bundle", "source_id", "source_ids", "source_roles", "license_ref",
    "source_role_requirements", "source_version", "evidence_refs", "evidence",
    "original_path", "original_local_path", "local_path", "file_path",
    "storage_path", "path", "url", "processing_record", "processing_evidence",
    "processing", "derived_lineage", "lineage", "input_refs", "inputs",
    "run_log", "code", "code_digest", "parameters", "parameter_digest",
    "execution", "method", "bd_ref", "bd_locator", "locator", "notes",
}


def _strict_keys(value, allowed, path):
    if not isinstance(value, dict):
        raise ValueError("SEMANTIC_CONTEXT_AXIS_INVALID:" + path)
    unknown = sorted(set(value) - set(allowed))
    if unknown:
        if set(unknown) & _EXTERNAL_METADATA_KEYS:
            raise ValueError("EXTERNAL_METADATA_FORBIDDEN:" + path + "." + unknown[0])
        raise ValueError("SEMANTIC_CONTEXT_FIELD_UNSUPPORTED:" + path + "." + unknown[0])


def _strict_ref(value, path, *, identity=False):
    _strict_keys(value, _IDENTITY_KEYS if identity else _REF_KEYS, path)
    import re as _re
    pattern = _re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
    for key in ("kind", "namespace", "id"):
        if (not isinstance(value.get(key), str) or not value.get(key)
                or not pattern.fullmatch(value[key])):
            raise ValueError("SEMANTIC_CONTEXT_REFERENCE_INVALID:" + path)
    if "version" in value:
        if not isinstance(value["version"], str) or not pattern.fullmatch(value["version"]):
            raise ValueError("SEMANTIC_CONTEXT_REFERENCE_INVALID:" + path)
    if "digest" in value:
        import re as _re
        if (not isinstance(value["digest"], str)
                or not _re.fullmatch(r"sha256:[0-9a-f]{64}", value["digest"])):
            raise ValueError("SEMANTIC_CONTEXT_REFERENCE_INVALID:" + path)


def _strict_axis(axis, value, path):
    _strict_keys(value, _AXIS_KEYS[axis], path)
    for key, child in value.items():
        child_path = path + "." + key
        if key in {"calendar_ref", "accounting_calendar_ref", "sample_scope_ref",
                   "weighting_ref", "base_period_ref", "denominator_ref",
                   "coverage_scope_ref", "accounting_standard_ref",
                   "mapping_comparability_ref", "return_definition_ref",
                   "currency_conversion_ref", "validation_ref", "warmup_ref"}:
            if child is not None:
                if key in {"calendar_ref", "accounting_calendar_ref"}:
                    product_calendar._check_ref(child, child_path,
                                                "calendar_ref" if key == "calendar_ref"
                                                else "accounting_calendar_ref")
                else:
                    _strict_ref(child, child_path)
        elif key == "seasonal_adjustment":
            _strict_keys(child, {"status", "method_ref"}, child_path)
            if child.get("method_ref") is not None:
                _strict_ref(child["method_ref"], child_path + ".method_ref")
        elif key == "price_adjustment":
            _strict_keys(child, {"direction", "anchor_ref"}, child_path)
            if child.get("anchor_ref") is not None:
                _strict_ref(child["anchor_ref"], child_path + ".anchor_ref")
        elif key == "window":
            _strict_keys(child, {"type", "count", "interval", "unit"}, child_path)
            for scalar_key in ("type", "unit", "interval"):
                if scalar_key in child and not isinstance(child[scalar_key], str):
                    raise ValueError("SEMANTIC_CONTEXT_WINDOW_INVALID:" + child_path)
            if "count" in child and (isinstance(child["count"], bool)
                                     or not isinstance(child["count"], (int, str))):
                raise ValueError("SEMANTIC_CONTEXT_WINDOW_INVALID:" + child_path)
        elif key == "value_states":
            if not isinstance(child, list) or any(not isinstance(item, str) for item in child):
                raise ValueError("SEMANTIC_CONTEXT_AXIS_INVALID:" + child_path)
        elif key == "roles":
            if not isinstance(child, dict) or any(not isinstance(k, str) or not isinstance(v, str)
                                                  for k, v in child.items()):
                raise ValueError("SEMANTIC_CONTEXT_AXIS_INVALID:" + child_path)
        elif not isinstance(child, (str, int, bool, type(None))):
            raise ValueError("SEMANTIC_CONTEXT_AXIS_INVALID:" + child_path)


_UNRESOLVED_REF_FIELDS = {
    "statistical": {"sample_scope_ref", "weighting_ref", "base_period_ref",
                    "denominator_ref", "coverage_scope_ref"},
    "financial": {"accounting_standard_ref", "mapping_comparability_ref",
                  "return_definition_ref", "currency_conversion_ref"},
    "coverage_quality": {"validation_ref", "warmup_ref"},
}


def _reject_unresolved_refs(declaration):
    """R1 has no general internal ref registry for required semantic refs.

    Scan only the fixed declaration paths (top-level semantic_context and each
    declared field_semantic_context entry).  No recursive dict walk: contract
    bodies may carry settled business payload that is not a ref declaration.
    """
    def check_context(context, prefix):
        if not isinstance(context, dict):
            return
        for axis, fields in _UNRESOLVED_REF_FIELDS.items():
            value = context.get(axis)
            if not isinstance(value, dict):
                continue
            for field in fields:
                if value.get(field) is not None:
                    raise ValueError("INTERNAL_REFERENCE_NOT_IMPLEMENTED:" + prefix + "."
                                     + axis + "." + field)
        if context.get("calendar_ref") is not None or context.get("accounting_calendar_ref") is not None:
            raise ValueError("CALENDAR_REF_INVALID:" + prefix + ".calendar_ref")
        statistical = context.get("statistical") or {}
        seasonal = statistical.get("seasonal_adjustment") if isinstance(statistical, dict) else None
        if isinstance(seasonal, dict) and seasonal.get("method_ref") is not None:
            raise ValueError("INTERNAL_REFERENCE_NOT_IMPLEMENTED:" + prefix
                             + ".statistical.seasonal_adjustment.method_ref")
        financial = context.get("financial") or {}
        price = financial.get("price_adjustment") if isinstance(financial, dict) else None
        if isinstance(price, dict) and price.get("anchor_ref") is not None:
            raise ValueError("INTERNAL_REFERENCE_NOT_IMPLEMENTED:" + prefix
                             + ".financial.price_adjustment.anchor_ref")
        # The public schema describes a field context as one flat axis object;
        # the service declaration path also accepts nested axes.  Cover both.
        flat_fields = {field for fields in _UNRESOLVED_REF_FIELDS.values()
                       for field in fields}
        for field in sorted(flat_fields):
            if context.get(field) is not None:
                raise ValueError("INTERNAL_REFERENCE_NOT_IMPLEMENTED:"
                                 + prefix + "." + field)
        flat_seasonal = context.get("seasonal_adjustment")
        if isinstance(flat_seasonal, dict) and flat_seasonal.get("method_ref") is not None:
            raise ValueError("INTERNAL_REFERENCE_NOT_IMPLEMENTED:" + prefix
                             + ".seasonal_adjustment.method_ref")
        flat_price = context.get("price_adjustment")
        if isinstance(flat_price, dict) and flat_price.get("anchor_ref") is not None:
            raise ValueError("INTERNAL_REFERENCE_NOT_IMPLEMENTED:" + prefix
                             + ".price_adjustment.anchor_ref")

    check_context(declaration.get("semantic_context") or {}, "semantic_context")
    field_contexts = declaration.get("field_semantic_context") or {}
    if isinstance(field_contexts, dict):
        for field_code in sorted(field_contexts):
            if field_code not in {field.get("field_code")
                                  for field in declaration.get("field_definitions", [])
                                  if isinstance(field, dict)}:
                continue
            check_context(field_contexts[field_code],
                          "field_semantic_context." + str(field_code))
    algorithm = declaration.get("algorithm_definition") or {}
    if isinstance(algorithm, dict) and algorithm.get("algorithm_ref") is not None:
        raise ValueError("INTERNAL_REFERENCE_NOT_IMPLEMENTED:algorithm_definition.algorithm_ref")


def validate_data_only_metadata(declaration):
    """Strict metadata shapes; no blacklist and no arbitrary nested objects."""
    allowed_top = {"semantic_code", "measurement_nature", "unit_code",
                   "definition_authority", "time_role", "field_definitions",
                   "semantic_context", "field_semantic_context", "algorithm_definition"}
    _strict_keys(declaration, allowed_top, "definition")
    for index, field in enumerate(declaration.get("field_definitions", [])):
        _strict_keys(field, {"field_code", "data_type", "unit_code",
                             "measurement_nature", "time_role", "consistency_group"},
                     f"definition.field_definitions[{index}]")
    context = declaration.get("semantic_context")
    if not isinstance(context, dict):
        raise ValueError("SEMANTIC_CONTEXT_REQUIRED")
    _strict_keys(context, _CTX_KEYS, "semantic_context")
    if context.get("version") != "wfd.semantic-context/1.0":
        raise ValueError("SEMANTIC_CONTEXT_VERSION_REQUIRED")
    if context.get("content_nature") not in {
            "observed_fact", "source_claim", "plan", "forecast", "actual_outcome",
            "deterministic_derived", "definition_rule"}:
        raise ValueError("SEMANTIC_CONTENT_NATURE_REQUIRED")
    for axis in ("identity", "time", "measurement", "content", "statistical",
                 "financial", "relation", "coverage_quality"):
        if axis in context and context[axis] is not None:
            _strict_axis(axis, context[axis], "semantic_context." + axis)
    source = context.get("source")
    if source is not None:
        _strict_keys(source, {"definition_authority", "publisher_ref"}, "semantic_context.source")
        if source.get("publisher_ref") is not None:
            _strict_ref(source["publisher_ref"], "semantic_context.source.publisher_ref",
                        identity=True)
        if "definition_authority" in source:
            if not isinstance(source["definition_authority"], str) or not source["definition_authority"]:
                raise ValueError("SEMANTIC_SOURCE_AUTHORITY_MISMATCH")
            if source["definition_authority"] != declaration.get("definition_authority"):
                raise ValueError("SEMANTIC_SOURCE_AUTHORITY_MISMATCH")
    version_axis = context.get("version_axis")
    if version_axis is not None:
        _strict_keys(version_axis, {"definition_version", "method_version",
                                    "parent_version", "revision_mode"},
                     "semantic_context.version_axis")
        for key, value in version_axis.items():
            if not isinstance(value, str) or not value or "/" in value:
                raise ValueError("SEMANTIC_CONTEXT_AXIS_INVALID:semantic_context.version_axis." + key)
    derivation = context.get("derivation")
    if derivation is not None:
        _strict_keys(derivation, {"required"}, "semantic_context.derivation")
        if "required" in derivation and not isinstance(derivation["required"], bool):
            raise ValueError("SEMANTIC_CONTEXT_AXIS_INVALID:semantic_context.derivation.required")
    if (context.get("content_nature") == "deterministic_derived"
            and declaration.get("algorithm_definition") is None):
        raise ValueError("ALGORITHM_DEFINITION_REQUIRED")
    unknown = context.get("unknown_axes")
    if unknown is not None and (not isinstance(unknown, list)
                                or any(not isinstance(item, str) for item in unknown)):
        raise ValueError("SEMANTIC_UNKNOWN_AXES_INVALID")
    field_contexts = declaration.get("field_semantic_context")
    if field_contexts is not None:
        if not isinstance(field_contexts, dict):
            raise ValueError("SEMANTIC_FIELD_CONTEXT_INVALID")
        declared = {field.get("field_code") for field in declaration.get("field_definitions", [])
                    if isinstance(field, dict)}
        for field_code, value in field_contexts.items():
            if field_code not in declared:
                raise ValueError("SEMANTIC_FIELD_CONTEXT_UNKNOWN_FIELD")
            _strict_keys(value, _FIELD_CONTEXT_AXES, "field_semantic_context." + field_code)
            for axis, child in value.items():
                _strict_axis(axis, child, "field_semantic_context." + field_code + "." + axis)
    algorithm = declaration.get("algorithm_definition")
    if algorithm is not None:
        _strict_keys(algorithm, {"result_semantics", "mathematical_definition", "window",
                                 "constants", "definition_version", "algorithm_ref"},
                     "algorithm_definition")
        if not isinstance(algorithm.get("mathematical_definition"), str) or not algorithm["mathematical_definition"].strip():
            raise ValueError("ALGORITHM_MATHEMATICAL_DEFINITION_REQUIRED")
        if algorithm.get("result_semantics") is not None and not isinstance(algorithm["result_semantics"], str):
            raise ValueError("ALGORITHM_DEFINITION_FIELD_UNSUPPORTED")
        window = algorithm.get("window")
        if window is not None:
            _strict_keys(window, {"type", "count", "interval", "unit"}, "algorithm_definition.window")
            for key in ("type", "interval", "unit"):
                if key in window and not isinstance(window[key], str):
                    raise ValueError("ALGORITHM_WINDOW_INVALID")
            if "count" in window and (isinstance(window["count"], bool)
                                      or not isinstance(window["count"], (int, str))):
                raise ValueError("ALGORITHM_WINDOW_INVALID")
        constants = algorithm.get("constants")
        if constants is not None:
            if not isinstance(constants, dict):
                raise ValueError("ALGORITHM_CONSTANTS_INVALID")
            for key, value in constants.items():
                if key in _EXTERNAL_METADATA_KEYS:
                    raise ValueError("EXTERNAL_METADATA_FORBIDDEN:algorithm_definition.constants." + str(key))
                if not isinstance(key, str) or not (
                        isinstance(value, (int, float, bool, type(None)))):
                    raise ValueError("ALGORITHM_CONSTANTS_INVALID:" + str(key))
        if algorithm.get("algorithm_ref") is not None:
            _strict_ref(algorithm["algorithm_ref"], "algorithm_definition.algorithm_ref")
        if "definition_version" in algorithm:
            version = algorithm["definition_version"]
            if (not isinstance(version, str) or not version
                    or "/" in version or not __import__("re").fullmatch(
                        r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", version)):
                raise ValueError("ALGORITHM_DEFINITION_FIELD_UNSUPPORTED")
    _reject_unresolved_refs(declaration)
    product_calendar.validate_declaration(declaration)
    return True


class WFDDataOnlyService(WFDProductService):
    """Structured-data profile with no source/evidence/lineage persistence."""

    profile = DATA_ONLY_PROFILE
    protocol_version = DATA_ONLY_PROTOCOL

    def __init__(self, engine, *, caller_roles=None, caller_id="local",
                 unit_registry=None, trusted_actor_namespaces=None):
        super().__init__(engine, allowed_sources={}, can_register=True,
                         caller_roles=caller_roles, caller_id=caller_id,
                         unit_registry=unit_registry,
                         trusted_actor_namespaces=trusted_actor_namespaces)
        self._data_only_schema_path = Path(__file__).resolve().parent.parent / (
            "protocol/schemas/wfd-structured-ingest.schema.json")
        self._structured_schema = json.loads(self._data_only_schema_path.read_text("utf-8"))
        self._structured_validator = Draft202012Validator(self._structured_schema)

    # ---------------------------------------------------------------- schema/profile
    def structured_schema_info(self):
        raw = self._data_only_schema_path.read_bytes()
        data = json.loads(raw)
        return {
            "schema_id": data.get("$id"),
            "schema_sha256": "sha256:" + sha(raw),
            "schema_canonical_sha256": "sha256:" + sha(canonical(data)),
            "protocol_version": DATA_ONLY_PROTOCOL,
            "profile": DATA_ONLY_PROFILE,
            "sample_path": "protocol/samples/wfd-structured-ingest.example.json",
        }

    def capabilities(self):
        caps = super().capabilities()
        caps["format_version"] = "wfd.product-capabilities/0.3"
        caps["profile"] = DATA_ONLY_PROFILE
        caps["structured_ingest"] = DATA_ONLY_PROTOCOL
        schema = self.structured_schema_info()
        caps["structural_validation"] = {
            "enforced": True,
            "validator": "service data_only structural checks; public schema published for BD",
            "schema_id": schema["schema_id"],
            "schema_sha256": schema["schema_sha256"],
            "schema_canonical_sha256": schema["schema_canonical_sha256"],
            "sample_path": schema["sample_path"],
        }
        caps["boundary"] = {
            "stored_by_wfd": ["admitted structured data", "stable record identity",
                              "business time", "data versions",
                              "internal definition/contract metadata"],
            "not_stored_by_wfd": ["original files", "source/evidence locators",
                                  "BD locators", "external execution code/parameters/logs",
                                  "processing lineage"],
        }
        caps["operations"] = {
            "submit": {"supported": True, "protocol": DATA_ONLY_PROTOCOL},
            "fixed_read": {"supported": True, "requires_snapshot": True,
                           "returns": ["record_id", "record_version", "record_ref"]},
            "request_status": {"supported": True, "key": "original request_identity"},
            "recovery": {"supported": True, "same_identity": True},
            "contract_discovery": {"supported": True},
            "read_product": {"supported": True},
            "capabilities": {"supported": True},
            "schema": {"supported": True},
        }
        caps["unsupported"] = [
            {"operation": "evidence_ingest", "reason": "data_only profile has no source/evidence custody"},
            {"operation": "trace", "reason": "data_only profile has no source/evidence trace"},
            {"operation": "packages", "reason": "P5 package contract remains separate"},
            {"operation": "external_source_permissions", "reason": "source/evidence permissions belong to BD"},
        ]
        caps.pop("source_permissions", None)
        caps.pop("source_role_governance", None)
        return caps

    # ---------------------------------------------------------------- validation
    def _validate_document(self, doc):
        if not isinstance(doc, dict):
            raise ValueError("REQUEST_INVALID:document must be an object")
        schema_errors = sorted(self._structured_validator.iter_errors(doc),
                               key=lambda error: list(map(str, error.path)))
        if schema_errors:
            first = schema_errors[0]
            raise ValueError("SCHEMA_INVALID:" + first.message[:500])
        allowed = {"protocol_version", "request_identity", "intent",
                   "producer_namespace", "expected_parent_snapshot_id",
                   "outputs", "consistency_groups"}
        extra = sorted(set(doc) - allowed)
        if extra:
            raise ValueError("EXTERNAL_METADATA_FORBIDDEN:" + extra[0])
        if doc.get("protocol_version") != DATA_ONLY_PROTOCOL:
            raise ValueError("UNSUPPORTED_PROTOCOL:" + str(doc.get("protocol_version")))
        if doc.get("intent") != "submit":
            raise ValueError("INTENT_UNSUPPORTED")
        identity = doc.get("request_identity")
        if not isinstance(identity, dict) or set(identity) != {
                "dataset_id", "trusted_actor_namespace", "request_id", "submission_digest"}:
            raise ValueError("REQUEST_IDENTITY_INVALID")
        if identity.get("trusted_actor_namespace") not in self.trusted_actor_namespaces:
            raise ValueError("ACTOR_NAMESPACE_UNTRUSTED")
        digest = str(identity.get("submission_digest") or "")
        if not (digest.startswith("sha256:") and len(digest) == 71):
            raise ValueError("REQUEST_IDENTITY_INVALID:submission_digest")
        if not isinstance(doc.get("producer_namespace"), str) or not doc["producer_namespace"]:
            raise ValueError("REQUEST_INVALID:producer_namespace")
        if doc.get("expected_parent_snapshot_id") is not None and not isinstance(
                doc.get("expected_parent_snapshot_id"), str):
            raise ValueError("REQUEST_INVALID:expected_parent_snapshot_id")
        outputs = doc.get("outputs")
        if not isinstance(outputs, list) or not outputs:
            raise ValueError("OUTPUT_KEYS_INVALID")
        if len({item.get("output_key") for item in outputs if isinstance(item, dict)}) != len(outputs):
            raise ValueError("OUTPUT_KEYS_INVALID")
        allowed_output = {"output_key", "logical_domain", "subject", "definition_mode",
                          "definition_ref", "definition", "input_mode", "coverage",
                          "payload", "revisions"}
        for item in outputs:
            if not isinstance(item, dict):
                raise ValueError("REQUEST_INVALID:output fields")
            output_extra = sorted(set(item) - allowed_output)
            if output_extra:
                if set(output_extra) & _EXTERNAL_METADATA_KEYS:
                    raise ValueError("EXTERNAL_METADATA_FORBIDDEN:outputs." + output_extra[0])
                raise ValueError("REQUEST_INVALID:output fields " + ",".join(output_extra))
            if not isinstance(item.get("output_key"), str) or not item["output_key"]:
                raise ValueError("OUTPUT_KEYS_INVALID")
            if item.get("logical_domain") not in {"foundation", "observations", "events"}:
                raise ValueError("LOGICAL_DOMAIN_INVALID")
            if not isinstance(item.get("subject"), dict):
                raise ValueError("SUBJECT_INVALID")
            mode = item.get("definition_mode")
            if mode == "create":
                if not isinstance(item.get("definition"), dict) or item.get("definition_ref") is not None:
                    raise ValueError("DEFINITION_REQUIRED")
                validate_data_only_metadata(item["definition"])
            elif mode == "reuse":
                if not isinstance(item.get("definition_ref"), dict) or item.get("definition") is not None:
                    raise ValueError("DEFINITION_REFERENCE_REQUIRED")
            else:
                raise ValueError("DEFINITION_MODE_INVALID")
            if item.get("input_mode") not in DATA_ONLY_MODES:
                raise ValueError("INPUT_MODE_NOT_IMPLEMENTED:" + str(item.get("input_mode")))
            coverage = item.get("coverage")
            if not isinstance(coverage, dict) or set(coverage) - {
                    "scope", "basis", "completeness", "absence_means"}:
                raise ValueError("COVERAGE_INVALID")
            payload = item.get("payload")
            if not isinstance(payload, dict) or payload.get("kind") not in {
                    "scalar_rows", "tabular_rows", "relation_edges", "event_records"}:
                raise ValueError("PAYLOAD_KIND_UNSUPPORTED")
        groups = doc.get("consistency_groups") or {}
        if not isinstance(groups, dict):
            raise ValueError("CONSISTENCY_GROUP_INVALID")
        keys = {item["output_key"] for item in outputs}
        for members in groups.values():
            if (not isinstance(members, list) or not members
                    or len(set(members)) != len(members)
                    or any(member not in keys for member in members)):
                raise ValueError("CONSISTENCY_GROUP_INVALID")
        return identity

    # ---------------------------------------------------------------- status
    def _status_path(self, key):
        return f"catalog/product_service/data_only_status/{key}.json"

    def _intent_path(self, key):
        return f"catalog/product_service/data_only_intents/{key}.json"

    def _load_intent(self, key):
        path = self.root / self._intent_path(key)
        return json.loads(path.read_text("utf-8")) if path.is_file() else None

    def _plan_path(self, key):
        return f"catalog/product_service/data_only_submission_plans/{key}.json"

    def _load_plan(self, key):
        path = self.root / self._plan_path(key)
        return json.loads(path.read_text("utf-8")) if path.is_file() else None

    def _save_plan(self, key, identity, fingerprint, parent, results):
        plan = {"format_version": "wfd.data-only-submission-plan/1.0",
                "profile": DATA_ONLY_PROFILE,
                "request_key": key,
                "request_identity": copy.deepcopy(identity),
                "input_fingerprint": fingerprint,
                "parent_snapshot_id": parent,
                "outputs": [{"output_key": item["output_key"],
                             "product_id": item.get("product_id"),
                             "records": copy.deepcopy(item.get("records", []))}
                            for item in results if not item.get("errors")]}
        path = self.root / self._plan_path(key)
        if path.is_file():
            existing = json.loads(path.read_text("utf-8"))
            if existing.get("input_fingerprint") != fingerprint:
                raise ValueError("REQUEST_ID_CONFLICT")
            return existing
        self.engine._write_immutable(self._plan_path(key), canonical(plan))
        return plan

    def _save_intent(self, key, identity, fingerprint):
        record = {"format_version": "wfd.data-only-intent/1.0",
                  "profile": DATA_ONLY_PROFILE,
                  "request_key": key,
                  "request_identity": copy.deepcopy(identity),
                  "input_fingerprint": fingerprint}
        self.engine._write_immutable(self._intent_path(key), canonical(record))
        return record

    def _load_status(self, key):
        path = self.root / self._status_path(key)
        return json.loads(path.read_text("utf-8")) if path.is_file() else None

    def _save_status(self, record):
        self._write_status(self._status_path(record["request_key"]), record)

    @staticmethod
    def _terminal(state):
        return state in {"published_formal", "partially_published_formal",
                         "published_sandbox", "rejected"}

    def _public_status(self, record, replay=False):
        result = {
            "protocol_version": DATA_ONLY_PROTOCOL,
            "profile": DATA_ONLY_PROFILE,
            "service_version": SERVICE_VERSION,
            "request_key": record["request_key"],
            "request_identity": copy.deepcopy(record["request_identity"]),
            "state": record["state"],
            "snapshot_id": record.get("snapshot_id"),
            "output_results": copy.deepcopy(record.get("output_results", [])),
            "formal_publication_ref": record.get("formal_publication_ref"),
            "formal_publication_checks": copy.deepcopy(record.get("formal_publication_checks")),
            "formal_publication_verified": bool(record.get("formal_publication_ref")),
            "errors": copy.deepcopy(record.get("errors", [])),
            "idempotent_replay": replay or bool(record.get("idempotent_replay")),
            "production_publishable": False,
        }
        return result

    def request_status(self, request_identity):
        self.require_permission("read")
        key = self._request_identity_key(request_identity)[0]
        record = self._load_status(key)
        if record is None:
            intent = self._load_intent(key)
            known = self.engine._known_request(key)
            if intent is not None and known is not None:
                recovered = self._recover_submission(
                    key, request_identity, intent.get("input_fingerprint"), intent, known)
                if recovered is not None:
                    return recovered
            return {"protocol_version": DATA_ONLY_PROTOCOL, "profile": DATA_ONLY_PROFILE,
                    "request_key": key, "request_identity": copy.deepcopy(request_identity),
                    "state": "unknown", "snapshot_id": None, "output_results": [],
                    "formal_publication_ref": None, "errors": [],
                    "production_publishable": False}
        return self._public_status(record, replay=True)

    @staticmethod
    def _record_equal(left, right):
        return (left.get("record_id") == right.get("record_id")
                and left.get("record_version") == right.get("record_version")
                and bool(left.get("withdrawn")) == bool(right.get("withdrawn")))

    def _records_from_snapshot(self, snapshot, plan=None):
        if plan is not None:
            targets = plan.get("outputs") or []
            if not targets:
                raise ValueError("RECOVERY_PLAN_EMPTY")
            results = []
            seen = set()
            for target in targets:
                key = target.get("output_key")
                product_id = target.get("product_id")
                wanted = target.get("records") or []
                if not key or not product_id or not wanted or (key, product_id) in seen:
                    raise ValueError("RECOVERY_PLAN_INVALID")
                seen.add((key, product_id))
                matching = []
                available = {}
                for entry in snapshot.get("files", []):
                    if entry.get("output_key") != key or entry.get("product_id") != product_id:
                        continue
                    binding = (entry.get("source_bundle") or {}).get(
                        "_wfd_product_bindings", {}).get(key)
                    product = (binding or {}).get("product")
                    if not product or product.get("product_id") != product_id:
                        continue
                    matching.append((entry, product))
                    versions = (entry.get("source_bundle") or {}).get(
                        "_wfd_row_versions", {}).get(key, {})
                    for value in versions.values():
                        available[(value["logical_key"], value["revision_id"])] = value
                if not matching:
                    raise ValueError("RECOVERY_TARGET_PRODUCT_MISSING:" + product_id)
                records = []
                for wanted_record in wanted:
                    identity = (wanted_record.get("record_id"),
                                wanted_record.get("record_version"))
                    value = available.get(identity)
                    if value is None:
                        raise ValueError("RECOVERY_TARGET_RECORD_MISSING:" + key)
                    records.append({"record_id": value["logical_key"],
                                    "record_version": value["revision_id"],
                                    "withdrawn": bool(value.get("withdrawn"))})
                if sorted(records, key=lambda item: item["record_version"]) != sorted(
                        wanted, key=lambda item: item["record_version"]):
                    raise ValueError("RECOVERY_RECORD_SET_MISMATCH:" + key)
                product = matching[0][1]
                results.append({
                    "output_key": key,
                    "registration_state": "reused",
                    "publication_state": "published_sandbox",
                    "product_id": product.get("product_id"),
                    "definition_ref": copy.deepcopy(product.get("definition_ref")),
                    "contract_ref": copy.deepcopy(product.get("contract_ref")),
                    "contract_refs": copy.deepcopy(product.get("contract_refs")),
                    "contract_bundle_ref": copy.deepcopy(product.get("contract_bundle_ref")),
                    "snapshot_id": snapshot.get("snapshot_id"),
                    "records": records,
                })
            if len(results) != len(targets):
                raise ValueError("RECOVERY_PLAN_MISMATCH")
            return results
        parent_id = snapshot.get("parent_snapshot_id")
        parent_paths = set()
        if parent_id:
            try:
                parent = self.engine.read_snapshot(parent_id)
                parent_paths = {entry.get("file_relpath") for entry in parent.get("files", [])}
            except (ValueError, OSError):
                parent_paths = set()
        grouped = {}
        for entry in snapshot.get("files", []):
            if parent_paths and entry.get("file_relpath") in parent_paths:
                continue
            key = entry.get("output_key")
            product_id = entry.get("product_id")
            binding = (entry.get("source_bundle") or {}).get("_wfd_product_bindings", {}).get(key)
            product = (binding or {}).get("product")
            if not product or product.get("product_id") != product_id:
                continue
            versions = (entry.get("source_bundle") or {}).get("_wfd_row_versions", {}).get(key, {})
            records = grouped.setdefault((key, product_id), {
                "product": product, "records": {}})
            for value in versions.values():
                records["records"][(value["logical_key"], value["revision_id"])] = {
                    "record_id": value["logical_key"],
                    "record_version": value["revision_id"],
                    "withdrawn": bool(value.get("withdrawn")),
                }
        results = []
        for (key, product_id), item in grouped.items():
            product = item["product"]
            results.append({
                "output_key": key, "registration_state": "reused",
                "publication_state": "published_sandbox", "product_id": product_id,
                "definition_ref": copy.deepcopy(product.get("definition_ref")),
                "contract_ref": copy.deepcopy(product.get("contract_ref")),
                "contract_refs": copy.deepcopy(product.get("contract_refs")),
                "contract_bundle_ref": copy.deepcopy(product.get("contract_bundle_ref")),
                "snapshot_id": snapshot.get("snapshot_id"),
                "records": sorted(item["records"].values(),
                                  key=lambda value: (value["record_id"], value["record_version"])),
            })
        return results

    def _recover_submission(self, key, identity, fingerprint, intent, known, persist=True):
        receipt = known if isinstance(known, dict) else {}
        sid = receipt.get("snapshot_id")
        if not sid:
            return None
        try:
            snapshot = self.engine.read_snapshot(sid)
        except (ValueError, OSError):
            return None
        plan = self._load_plan(key)
        try:
            results = self._records_from_snapshot(snapshot, plan)
        except ValueError as exc:
            record = {"format_version": DATA_ONLY_STATUS_FORMAT, "profile": DATA_ONLY_PROFILE,
                      "request_key": key, "request_identity": copy.deepcopy(identity),
                      "input_fingerprint": fingerprint, "state": "recovery_conflict",
                      "snapshot_id": sid, "output_results": [],
                      "formal_publication_ref": None,
                      "errors": [_issue(str(exc).split(":")[0], str(exc))],
                      "idempotent_replay": False}
            if persist:
                self._save_status(record)
            return self._public_status(record, replay=True)
        if not results:
            return None
        # Immutable formal receipt is authoritative even after HEAD advances.
        formal_path = f"catalog/product_service/data_only_formal_publications/{key}.json"
        if (self.root / formal_path).is_file():
            formal_path, checks, state = self._formalize(
                key, identity, fingerprint, results, receipt)
            if state == "formal_receipt_conflict":
                record = {"format_version": DATA_ONLY_STATUS_FORMAT, "profile": DATA_ONLY_PROFILE,
                          "request_key": key, "request_identity": copy.deepcopy(identity),
                          "input_fingerprint": fingerprint, "state": "recovery_conflict",
                          "snapshot_id": sid, "output_results": [],
                          "formal_publication_ref": None,
                          "errors": [_issue("FORMAL_RECEIPT_OUTPUT_CONFLICT",
                                            "Existing formal receipt does not match the request plan")],
                          "idempotent_replay": False}
                if persist:
                    self._save_status(record)
                return self._public_status(record, replay=True)
            if state == "published_formal":
                for item in results:
                    item["publication_state"] = "published_formal"
                    item["engine_publication_state"] = "published_verified"
                record = {"format_version": DATA_ONLY_STATUS_FORMAT, "profile": DATA_ONLY_PROFILE,
                          "request_key": key, "request_identity": copy.deepcopy(identity),
                          "input_fingerprint": fingerprint, "state": "published_formal",
                          "snapshot_id": sid, "output_results": results,
                          "formal_publication_ref": formal_path,
                          "formal_publication_checks": checks,
                          "errors": [], "idempotent_replay": False}
                if persist:
                    self._save_status(record)
                return self._public_status(record, replay=True)
        state_doc = self.engine.state.read() or {}
        current = state_doc.get("active_head")
        history = {item.get("snapshot_id") for item in state_doc.get("activation_history", [])
                   if isinstance(item, dict)}
        activated = current == sid or sid in history
        activation_result = None
        if not activated:
            parent = (plan or {}).get("parent_snapshot_id")
            if plan is not None and current == parent and self.has_permission("publish"):
                try:
                    activation_result = self.engine.state.activate(
                        sid, self.root / f"catalog/snapshots/{sid}.json",
                        expected_prev=parent, writer_host=self.engine.writer_host)
                except Exception as exc:
                    activation_result = {"ok": False, "code": "ACTIVATION_EXCEPTION",
                                         "detail": repr(exc)}
                activated = bool(activation_result.get("ok"))
            else:
                activation_result = {"ok": False, "code": "RECOVERY_HEAD_CONFLICT",
                                     "detail": "current HEAD is not the original parent"}
        if activated:
            formal_path, checks, formal_state = self._formalize(
                key, identity, fingerprint, results, receipt,
                historically_activated=(sid in history and current != sid))
            if formal_state == "published_formal":
                for item in results:
                    item["publication_state"] = "published_formal"
                    item["engine_publication_state"] = "published_verified"
                state = "published_formal"
            elif formal_state == "formal_receipt_conflict":
                state = "recovery_conflict"
            else:
                state = "published_sandbox"
        else:
            formal_path, checks = None, None
            for item in results:
                item["publication_state"] = "committed_pending_activation"
                item["engine_publication_state"] = "committed_pending_activation"
            state = "published_commit_pending_head"
        record = {"format_version": DATA_ONLY_STATUS_FORMAT, "profile": DATA_ONLY_PROFILE,
                  "request_key": key, "request_identity": copy.deepcopy(identity),
                  "input_fingerprint": fingerprint, "state": state,
                  "snapshot_id": sid, "output_results": results,
                  "formal_publication_ref": formal_path,
                  "formal_publication_checks": checks,
                  "recovery": copy.deepcopy(activation_result),
                  "errors": [], "idempotent_replay": False}
        if persist:
            self._save_status(record)
        return self._public_status(record, replay=True)

    # ---------------------------------------------------------------- submit
    def submit(self, doc):
        with writer_lock(self.root):
            return self._submit_data(doc)

    def _validate_calendar_main_rows(self, internal, declaration, rule, info):
        """Admission-time completeness against the full retained fixed calendar.

        This is not a cutoff/held qualification: all retained revisions are
        considered so future withdrawal cannot erase valid historical matching.
        """
        rows = (internal.get("payload") or {}).get("rows") or []
        subject = internal.get("subject") or {}
        roles = info.get("roles") or {}
        if rule["role"] == product_calendar.CALENDAR_ROLE:
            fixed, _ = product_calendar.trading_rows(info)
            expected_market = subject.get("id") if subject.get("kind") == "market" else None
            if expected_market is None:
                mapped = (((declaration.get("semantic_context") or {}).get("time") or {})
                          .get("roles") or {}).get("market_code")
                if not mapped:
                    raise ValueError("CALENDAR_APPLICABILITY_UNDETERMINED:"
                                     + rule["field_code"])
            for row in rows:
                required = self._calendar_required_dates({"row": row}, rule.get("timezone"))
                if not required:
                    raise ValueError("CALENDAR_MAIN_DATE_UNKNOWN:" + str(rule["field_code"]))
                market = expected_market
                if market is None:
                    values = row.get("values") if isinstance(row.get("values"), dict) else {}
                    cell = values.get(mapped)
                    market = cell.get("value") if isinstance(cell, dict) else cell
                for day_value in required:
                    if not any(str(item["session_date"]) == day_value
                               and str(item["market_code"]) == str(market) for item in fixed):
                        raise ValueError("CALENDAR_MAIN_MATCH_MISSING:" + day_value)
        else:
            fixed = product_calendar.accounting_rows(info)
            for row in rows:
                required = self._calendar_required_dates({"row": row}, rule.get("timezone"))
                if not required:
                    raise ValueError("CALENDAR_MAIN_DATE_UNKNOWN:" + str(rule["field_code"]))
                labels = product_calendar.main_accounting_labels(declaration, row)
                start = datetime.strptime(required[0], "%Y-%m-%d").date()
                end = datetime.strptime(required[-1], "%Y-%m-%d").date() + timedelta(days=1)
                candidates = []
                for item in fixed:
                    if labels:
                        if any(str(item.get(role)) != str(label)
                               for role, label in labels.items()):
                            continue
                        if not (item["_start"] <= start and item["_end"] >= end):
                            continue
                    elif item["_start"] != start or item["_end"] != end:
                        continue
                    candidates.append(item)
                if not candidates:
                    raise ValueError("CALENDAR_MAIN_MATCH_MISSING:" + str(rule["field_code"]))

    def _resolved_declaration(self, internal):
        if internal.get("definition_mode") == "create":
            return internal.get("new_definition_declaration") or {}
        ref = internal.get("definition_ref") or {}
        digest = (ref.get("digest") or "").removeprefix("sha256:")
        record = self._read_json(f"catalog/product_service/definitions/{digest}.json")
        return record.get("declaration") or {}

    def _internal_output(self, item):
        definition = copy.deepcopy(item.get("definition"))
        if isinstance(definition, dict):
            context = definition.get("semantic_context")
            if isinstance(context, dict):
                # Data-only has no WFD execution lineage.  The deterministic
                # business nature and algorithm definition remain; a
                # derivation flag is not persisted or used to synthesize one.
                context.pop("derivation", None)
        return {
            "output_key": item["output_key"],
            "logical_domain": item["logical_domain"],
            "subject": copy.deepcopy(item["subject"]),
            "definition_mode": item["definition_mode"],
            "definition_ref": copy.deepcopy(item.get("definition_ref")),
            "new_definition_declaration": definition,
            "input_mode": item["input_mode"],
            "coverage": {**copy.deepcopy(item["coverage"]),
                         "coverage_evidence": []},
            "payload": copy.deepcopy(item["payload"]),
            "evidence_refs": [],
        }

    @staticmethod
    def _formal_outputs_match(record, results):
        outputs = record.get("outputs") or []
        if len(outputs) != len(results):
            return False
        by_key = {(item.get("output_key"), item.get("product_id")): item for item in outputs}
        if len(by_key) != len(outputs):
            return False
        for result in results:
            existing = by_key.get((result.get("output_key"), result.get("product_id")))
            if existing is None:
                return False
            left = sorted(existing.get("records") or [],
                          key=lambda item: (item.get("record_id"), item.get("record_version")))
            right = sorted(result.get("records") or [],
                           key=lambda item: (item.get("record_id"), item.get("record_version")))
            if left != right:
                return False
        return True

    def _formalize(self, request_key, identity, fingerprint, results, publication,
                   historically_activated=False):
        sid = publication.get("snapshot_id")
        if not sid:
            return None, None, "registered_not_published"
        snapshot = self.engine.read_snapshot(sid)
        formal_path = f"catalog/product_service/data_only_formal_publications/{request_key}.json"
        existing_path = self.root / formal_path
        if existing_path.is_file():
            existing = json.loads(existing_path.read_text("utf-8"))
            if (existing.get("request_key") == request_key
                    and existing.get("snapshot_id") == sid
                    and existing.get("formal_publication_state") == "published_formal"):
                if self._formal_outputs_match(existing, results):
                    return formal_path, copy.deepcopy(existing.get("checks")), "published_formal"
                return None, {"formal_receipt_matches": False,
                              "recovery_error": "FORMAL_RECEIPT_OUTPUT_CONFLICT"}, "formal_receipt_conflict"
        checks = {
            "caller_publish_role": self.has_permission("publish"),
            "engine_not_sandbox": self.engine.sandbox is False,
            "snapshot_present": (self.root / f"catalog/snapshots/{sid}.json").is_file(),
            "commit_marker_present": (self.root / f"catalog/commits/{sid}.json").is_file(),
            "valid_commit": any(item.get("snapshot_id") == sid
                                for item in self.engine._valid_snapshots()),
            "contracts_verified": True,
            "record_identity_verified": True,
            "fixed_readback_verified": True,
            "active_head_matches": False,
        }
        try:
            active = self.engine.head()
        except Exception:
            active = None
        checks["active_head_matches"] = bool(
            active and active.get("snapshot_id") == sid)
        checks["historically_activated"] = bool(historically_activated)
        if not checks["active_head_matches"] and not checks["historically_activated"]:
            checks["record_identity_verified"] = False
            checks["fixed_readback_verified"] = False
            return None, checks, "published_commit_pending_head"
        output_records = []
        bindings = snapshot.get("files", [])
        for item in results:
            if item.get("publication_state") not in {"published_sandbox", "published_formal"}:
                continue
            entries = [entry for entry in bindings if entry.get("output_key") == item["output_key"]]
            if not entries:
                checks["fixed_readback_verified"] = False
                continue
            entry = entries[-1]
            binding = entry.get("source_bundle", {}).get("_wfd_product_bindings", {}).get(entry["output_key"])
            if not binding or not binding.get("product"):
                checks["contracts_verified"] = False
                continue
            product = binding["product"]
            try:
                self._verify_binding(product)
                if set(product.get("contract_refs") or {}) != {
                        "semantic", "read_layout", "algorithm_dependency", "update_release"}:
                    checks["contracts_verified"] = False
                read = self._read(product["product_id"], snapshot_id=sid, include_history=True)
                expected = item.get("records", [])
                actual = {row["record_ref"]["logical_key"]: row["record_ref"]["revision_id"]
                          for row in read.get("rows", []) if row["product_id"] == product["product_id"]}
                for record in expected:
                    if actual.get(record["record_id"]) != record["record_version"]:
                        checks["record_identity_verified"] = False
                if not expected:
                    checks["record_identity_verified"] = False
            except (ValueError, OSError, PermissionError):
                checks["fixed_readback_verified"] = False
            output_records.append({
                "output_key": item["output_key"],
                "product_id": item.get("product_id"),
                "snapshot_id": sid,
                "definition_ref": copy.deepcopy(item.get("definition_ref")),
                "contract_refs": copy.deepcopy(product.get("contract_refs")),
                "contract_bundle_ref": copy.deepcopy(product.get("contract_bundle_ref")),
                "records": copy.deepcopy(item.get("records", [])),
            })
        activation_ok = checks.get("active_head_matches") or checks.get("historically_activated")
        remaining = {key: value for key, value in checks.items()
                     if key not in {"active_head_matches", "historically_activated"}}
        if not activation_ok or not all(remaining.values()):
            return None, checks, "published_sandbox"
        record = {
            "format_version": DATA_ONLY_FORMAL_FORMAT,
            "profile": DATA_ONLY_PROFILE,
            "request_key": request_key,
            "request_identity": copy.deepcopy(identity),
            "input_fingerprint": fingerprint,
            "snapshot_id": sid,
            "checks": checks,
            "outputs": output_records,
            "formal_publication_state": "published_formal",
            "production_publishable": False,
        }
        self.engine._write_immutable(formal_path, canonical(record))
        return formal_path, checks, "published_formal"

    def _submit_data(self, doc):
        try:
            identity = self._validate_document(doc)
        except ValueError as exc:
            code = str(exc).split(":", 1)[0] or "REQUEST_INVALID"
            try:
                key = self.engine._request_key(doc) if isinstance(doc, dict) else None
            except (KeyError, TypeError, ValueError):
                key = None
            return {"protocol_version": DATA_ONLY_PROTOCOL, "profile": DATA_ONLY_PROFILE,
                    "status": "rejected", "state": "rejected", "request_key": key,
                    "errors": [_issue(code, str(exc))], "output_results": [],
                    "idempotent_replay": False, "production_publishable": False}
        if not self.has_permission("submit"):
            raise PermissionError("CALLER_PERMISSION_DENIED:submit")
        key = self.engine._request_key(doc)
        fingerprint = sha(canonical(doc))
        prior = self._load_status(key)
        if prior:
            if prior.get("input_fingerprint") != fingerprint:
                return {"protocol_version": DATA_ONLY_PROTOCOL, "profile": DATA_ONLY_PROFILE,
                        "status": "rejected", "request_key": key, "state": "rejected",
                        "errors": [_issue("REQUEST_ID_CONFLICT", "Original request contents changed")],
                        "output_results": [], "idempotent_replay": False,
                        "production_publishable": False}
            if self._terminal(prior.get("state")):
                return self._public_status(prior, replay=True)
        intent = self._load_intent(key)
        if intent is not None and intent.get("input_fingerprint") != fingerprint:
            return {"protocol_version": DATA_ONLY_PROTOCOL, "profile": DATA_ONLY_PROFILE,
                    "status": "rejected", "request_key": key, "state": "rejected",
                    "errors": [_issue("REQUEST_ID_CONFLICT", "Original request contents changed")],
                    "output_results": [], "idempotent_replay": False,
                    "production_publishable": False}
        known = self.engine._known_request(key)
        if known is not None and intent is not None and known.get("snapshot_id"):
            recovered = self._recover_submission(key, identity, fingerprint, intent, known)
            if recovered is not None:
                return recovered
        if known is not None and intent is None and known.get("snapshot_id"):
            # A commit exists but the original content fingerprint cannot be
            # verified without the pre-commit intent.  Do not silently bind a
            # different document to the same identity.
            return {"protocol_version": DATA_ONLY_PROTOCOL, "profile": DATA_ONLY_PROFILE,
                    "status": "rejected", "request_key": key, "state": "rejected",
                    "errors": [_issue("REQUEST_ID_CONFLICT", "Commit has no matching original intent")],
                    "output_results": [], "idempotent_replay": False,
                    "production_publishable": False}
        if intent is None:
            self._save_intent(key, identity, fingerprint)
        head = self.engine.head()
        head_id = head["snapshot_id"] if head else None
        if doc.get("expected_parent_snapshot_id") != head_id:
            result = {"protocol_version": DATA_ONLY_PROTOCOL, "profile": DATA_ONLY_PROFILE,
                      "status": "rejected", "request_key": key, "state": "rejected",
                      "errors": [_issue("PARENT_CHANGED", "Expected parent Snapshot differs from current head")],
                      "actual_parent_snapshot_id": head_id, "output_results": [],
                      "production_publishable": False}
            self._save_status({"format_version": DATA_ONLY_STATUS_FORMAT, "profile": DATA_ONLY_PROFILE,
                               "request_key": key, "request_identity": identity,
                               "input_fingerprint": fingerprint, "state": "rejected",
                               "snapshot_id": None, "output_results": [],
                               "formal_publication_ref": None, "errors": result["errors"]})
            return result
        normalized_outputs = []
        bindings, row_versions, resolved = {}, {}, {}
        results, batch_keys = [], {}
        groups = doc.get("consistency_groups") or {}
        for item in doc["outputs"]:
            internal = self._internal_output(item)
            outcome = {"output_key": item["output_key"], "registration_state": "not_registered",
                       "publication_state": "not_published"}
            try:
                declaration = self._resolved_declaration(internal)
                calendar_deps = product_calendar.dependencies(
                    declaration, identity["dataset_id"])
                for calendar_ref in product_calendar.field_calendar_rules(
                        declaration).values():
                    info = product_calendar.verify_fixed(self.engine, calendar_ref, internal.get("subject"))
                    self._validate_calendar_main_rows(internal, declaration, calendar_ref, info)
                extension = {"read_dependencies": calendar_deps,
                             "revisions": copy.deepcopy(item.get("revisions") or {}),
                             "_wfd_data_only": True}
                product, state = self._register(internal, identity["dataset_id"], extension)
                _reject_unresolved_refs(product.get("declaration") or {})
                product_calendar.validate_declaration(product.get("declaration") or {})
                outcome.update(product_id=product["product_id"],
                               definition_ref=copy.deepcopy(product.get("definition_ref")),
                               registration_state=state)
                prior_product = self._head_product_binding(product["product_id"], head)
                product = self._bind_contract(product, extension, prior_product)
                keys = {row.get("business_key", row.get("event_id"))
                        for row in item["payload"].get("rows", [])}
                if keys & batch_keys.get(product["product_id"], set()):
                    raise ValueError("DUPLICATE_BATCH_BUSINESS_KEY")
                payload_issues = validate_payload(internal, product["declaration"])
                payload_issues.extend(validate_units(product["declaration"], self.unit_registry))
                if payload_issues:
                    first = payload_issues[0]
                    raise ValueError(first["code"] + ":" + first["message"])
                engine_out, versions = self._prepare_versions(
                    internal, product, extension, head_id, fingerprint,
                    {"_wfd_data_only": True})
                engine_out.update(definition_mode="create", definition_ref=None,
                                  new_definition_declaration=product["declaration"])
                normalized_outputs.append(engine_out)
                resolved[item["output_key"]] = product["product_id"]
                bindings[item["output_key"]] = {"product": product,
                                                "source_role_mode": "data_only",
                                                "source_admission": {}}
                row_versions[item["output_key"]] = versions
                batch_keys.setdefault(product["product_id"], set()).update(keys)
                outcome["contract_ref"] = copy.deepcopy(product.get("contract_ref"))
                outcome["contract_refs"] = copy.deepcopy(product.get("contract_refs"))
                outcome["contract_bundle_ref"] = copy.deepcopy(product.get("contract_bundle_ref"))
                outcome["records"] = [{"record_id": version["logical_key"],
                                       "record_version": version["revision_id"],
                                       "withdrawn": version["withdrawn"]}
                                      for version in sorted(versions.values(),
                                                            key=lambda value: (value["logical_key"],
                                                                               value["revision_id"]))]
            except (ValueError, PermissionError) as exc:
                outcome["errors"] = [_issue(str(exc).split(":")[0], str(exc))]
            results.append(outcome)
        failed = {item["output_key"] for item in results if item.get("errors")}
        # Propagate group failure to a fixed point, matching the existing
        # WFDProductService semantics.  A single pass in group order can miss
        # a member that becomes failed later through an overlapping group.
        changed = True
        while changed:
            changed = False
            for members in groups.values():
                if not any(member in failed for member in members):
                    continue
                for item in results:
                    if item["output_key"] not in members or item["output_key"] in failed:
                        continue
                    item.setdefault("errors", []).append(
                        _issue("CONSISTENCY_GROUP_FAILED",
                               "Consistency group has a failed member; no member is published"))
                    item["publication_state"] = "not_published"
                    failed.add(item["output_key"])
                    changed = True
        if failed:
            normalized_outputs = [out for out in normalized_outputs
                                  if out["output_key"] not in failed]
        if not normalized_outputs:
            state = "registered_not_published" if any(
                item.get("registration_state") in {"registered", "reused"} for item in results) else "rejected"
            record = {"format_version": DATA_ONLY_STATUS_FORMAT, "profile": DATA_ONLY_PROFILE,
                      "request_key": key, "request_identity": identity,
                      "input_fingerprint": fingerprint, "state": state,
                      "snapshot_id": None, "output_results": results,
                      "formal_publication_ref": None, "errors": [],
                      "idempotent_replay": False}
            self._save_status(record)
            return self._public_status(record)
        self._save_plan(key, identity, fingerprint, head_id, results)
        source_bundle = {
            "_wfd_data_only": True,
            "_wfd_received_time": _second_now(),
            "_wfd_service_version": SERVICE_VERSION,
            "_wfd_product_bindings": bindings,
            "_wfd_resolved_product_ids": resolved,
            "_wfd_row_versions": row_versions,
            "product_service": {"version": SERVICE_VERSION, "outputs": {},
                                "consistency_groups": groups},
        }
        internal_doc = {
            "protocol_version": "wfd.ingest/1.3-candidate",
            "request_identity": {"dataset_id": identity["dataset_id"],
                                 "trusted_actor_namespace": identity["trusted_actor_namespace"],
                                 "request_id": identity["request_id"],
                                 "submission_digest": identity["submission_digest"]},
            "intent": "submit", "producer_namespace": doc["producer_namespace"],
            "expected_parent_snapshot_id": head_id,
            "outputs": normalized_outputs,
            "source_bundle": source_bundle,
        }
        try:
            receipt = self.engine.submit(internal_doc)
        except Exception as exc:
            record = {"format_version": DATA_ONLY_STATUS_FORMAT, "profile": DATA_ONLY_PROFILE,
                      "request_key": key, "request_identity": identity,
                      "input_fingerprint": fingerprint, "state": "publication_unknown",
                      "snapshot_id": None, "output_results": results,
                      "formal_publication_ref": None,
                      "errors": [_issue("PUBLICATION_UNKNOWN", repr(exc))]}
            self._save_status(record)
            return self._public_status(record)
        succeeded = set(receipt.get("outputs_success") or [])
        rejected = {item.get("output_key"): item.get("errors", [])
                    for item in receipt.get("outputs_rejected", []) if isinstance(item, dict)}
        for item in results:
            if item["output_key"] in succeeded:
                item["snapshot_id"] = receipt.get("snapshot_id")
                item["engine_publication_state"] = "published_verified"
                item["publication_state"] = "published_sandbox"
            elif item["output_key"] in rejected:
                item["errors"] = rejected[item["output_key"]]
        engine_errors = list(receipt.get("errors") or [])
        if not succeeded:
            for item in results:
                if not item.get("errors"):
                    item["errors"] = [dict(error) if isinstance(error, dict)
                                      else _issue("ENGINE_REJECTED", str(error))
                                      for error in engine_errors[:5]]
            state = ("registered_not_published" if any(
                item.get("registration_state") in {"registered", "reused"} for item in results)
                else "rejected")
            formal_path, checks = None, None
        else:
            formal_path, checks, state = self._formalize(
                key, identity, fingerprint, results, receipt)
            if state == "published_formal":
                for item in results:
                    if item.get("publication_state") in {"published_sandbox", "published_formal"}:
                        item["publication_state"] = "published_formal"
            elif state == "published_commit_pending_head":
                for item in results:
                    if item.get("publication_state") == "published_sandbox":
                        item["publication_state"] = "committed_pending_activation"
                        item["engine_publication_state"] = "committed_pending_activation"
            elif state == "published_sandbox":
                if any(item.get("errors") for item in results):
                    state = "partially_published_sandbox"
        record = {"format_version": DATA_ONLY_STATUS_FORMAT, "profile": DATA_ONLY_PROFILE,
                  "request_key": key, "request_identity": identity,
                  "input_fingerprint": fingerprint, "state": state,
                  "snapshot_id": receipt.get("snapshot_id"), "output_results": results,
                  "formal_publication_ref": formal_path,
                  "formal_publication_checks": checks,
                  "errors": [], "idempotent_replay": False}
        self._save_status(record)
        return self._public_status(record)

    def _internal_fingerprint(self, doc, key):
        # Sanitized internal documents are deterministic for the same admitted
        # content and original identity; the original fingerprint remains the
        # authoritative replay/conflict check.
        return sha(canonical(doc))

    # ---------------------------------------------------------------- read
    @staticmethod
    def _assert_selected_declarations(result):
        """Only the products actually selected by this fixed read."""
        for product in result.get("products", []):
            _reject_unresolved_refs(product.get("declaration") or {})

    def _calendar_required_dates(self, item, timezone_name):
        """Required dates from this main row's own interval, interpreted in the
        effective calendar timezone.  The request range never replaces this."""
        import re as _re

        def instant(value, label):
            text = str(value)
            if not _re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", text):
                raise ValueError("CALENDAR_BUSINESS_DATE_INVALID:" + label)
            return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)

        if not isinstance(timezone_name, str) or not timezone_name:
            return None
        try:
            zone = ZoneInfo(timezone_name)
        except (ZoneInfoNotFoundError, ValueError):
            return None
        row = item.get("row") or {}
        value = (row.get("observation_time") or row.get("event_time")
                 or row.get("effective_period"))
        if not isinstance(value, dict) or value.get("status") != "known":
            return None
        earliest, latest = value.get("earliest_utc"), value.get("latest_exclusive_utc")
        if not isinstance(earliest, str) or not isinstance(latest, str):
            return None
        start_utc, end_utc = instant(earliest, "row.start"), instant(latest, "row.end")
        if end_utc <= start_utc:
            return None
        first = start_utc.astimezone(zone).date()
        last = (end_utc - timedelta(microseconds=1)).astimezone(zone).date()
        if value.get("precision") == "day":
            last = first
        out, cursor = [], first
        while cursor <= last:
            out.append(cursor.isoformat())
            cursor += timedelta(days=1)
        return out or None

    def _calendar_apply(self, item, field_code, reason, ref, matched,
                        decision="indeterminate", required=None):
        row = item.get("row") or {}
        values = row.get("values")
        if isinstance(values, dict):
            values.pop(field_code, None)
        row.pop(field_code, None)
        record = item.get("record_ref") or {}
        diagnostic = {"product_id": item.get("product_id"), "field": field_code,
                      "record_id": record.get("logical_key"),
                      "record_version": record.get("revision_id"),
                      "decision": decision, "reason": reason, "ref": copy.deepcopy(ref),
                      "matched_calendar_records": copy.deepcopy(matched),
                      "calendar_status": "unknown" if decision == "indeterminate" else "not_yet"}
        if required is not None:
            diagnostic["required_dates"] = copy.deepcopy(required)
        return diagnostic

    def _qualify_calendar(self, result, *, perspective, at, held_scope, usable_stage,
                           fields, business_time_range):
        refs_out, diagnostics, field_states = [], [], {}
        for product in result.get("products", []):
            declaration = product.get("declaration") or {}
            rules = product_calendar.field_calendar_rules(declaration, fields)
            if not rules:
                continue
            rows = result.get("rows", [])
            grouped = {}
            for item in rows:
                grouped.setdefault((item.get("record_ref") or {}).get("logical_key"), []).append(item)
            leaf_ids = {}
            for key, group in grouped.items():
                leaves = self._version_leaves(group)
                leaf_ids[key] = ({leaf.get("record_ref", {}).get("revision_id")
                                  for leaf in leaves}
                                 if len(leaves) == 1 and not (leaves[0].get("revision") or {}).get("withdrawn")
                                 else set())
            cache = {}
            for field_code, rule in sorted(rules.items()):
                ref = rule["ref"]
                cache_key = (ref["id"], ref["version"], rule["role"])
                if cache_key not in cache:
                    info = product_calendar.verify_fixed(self.engine, rule, product.get("subject"))
                    eligible = product_calendar.eligible_leaf_items(
                        self, rule, perspective=perspective, at=at,
                        held_scope=held_scope, usable_stage=usable_stage)
                    cache[cache_key] = (info, eligible["status"], eligible["items"],
                                        eligible.get("reason"))
                info, dep_status, leaf_items, dep_reason = cache[cache_key]
                calendar_tz = (((info["definition"].get("semantic_context") or {}).get("time") or {})
                               .get("timezone"))
                timezone_status = ("ok" if rule.get("timezone") and calendar_tz
                                   and rule["timezone"] == calendar_tz
                                   else "unknown" if not rule.get("timezone") or not calendar_tz
                                   else "mismatch")
                subject = product.get("subject") or {}
                top_roles = ((declaration.get("semantic_context") or {}).get("time") or {}).get("roles") or {}
                mapped_market_field = top_roles.get("market_code")
                row_statuses = []
                for item in rows:
                    record = item.get("record_ref") or {}
                    leaf = record.get("revision_id") in leaf_ids.get(record.get("logical_key"), set())
                    if not leaf:
                        diagnostics.append(self._calendar_apply(
                            item, field_code, "REVISION_NOT_ELIGIBLE_LEAF", ref, [], "indeterminate"))
                        row_statuses.append("unknown")
                        continue
                    if dep_status not in ("eligible", "mixed"):
                        diagnostics.append(self._calendar_apply(
                            item, field_code, "CALENDAR_DEPENDENCY_NOT_ELIGIBLE:" + str(dep_reason),
                            ref, [], "not_yet" if dep_status == "not_yet" else "indeterminate"))
                        row_statuses.append(dep_status)
                        continue
                    if timezone_status != "ok":
                        diagnostics.append(self._calendar_apply(
                            item, field_code, "CALENDAR_TIMEZONE_" + timezone_status.upper(),
                            ref, [], "indeterminate"))
                        row_statuses.append("unknown")
                        continue
                    if rule["role"] == product_calendar.CALENDAR_ROLE:
                        if subject.get("kind") == "market":
                            expected_market = subject.get("id")
                        elif mapped_market_field:
                            expected_market = product_calendar.cell_value(
                                item, mapped_market_field)
                        else:
                            diagnostics.append(self._calendar_apply(
                                item, field_code, "CALENDAR_APPLICABILITY_UNDETERMINED",
                                ref, [], "indeterminate"))
                            row_statuses.append("unknown")
                            continue
                    else:
                        expected_market = None
                    required = self._calendar_required_dates(item, rule.get("timezone"))
                    if required is None:
                        diagnostics.append(self._calendar_apply(
                            item, field_code, "CALENDAR_REQUIRED_DATE_UNKNOWN",
                            ref, [], "indeterminate"))
                        row_statuses.append("unknown")
                        continue
                    matched, failures = [], []
                    if rule["role"] == product_calendar.CALENDAR_ROLE:
                        for day_value in required:
                            candidates = []
                            for leaf_item in leaf_items:
                                session = product_calendar.cell_value(leaf_item, "session_date")
                                market = product_calendar.cell_value(leaf_item, "market_code")
                                if str(session) == day_value and str(market) == str(expected_market):
                                    candidates.append(leaf_item)
                            if not candidates:
                                failures.append((day_value, "CALENDAR_DATE_NOT_COVERED"))
                                continue
                            usable = [c for c in candidates
                                      if c.get("calendar_record_status") == "eligible"]
                            if len(candidates) == 1 and len(usable) == 1:
                                matched.extend(usable)
                                continue
                            record_status = next((c.get("calendar_record_status") for c in candidates
                                                  if c.get("calendar_record_status") != "eligible"),
                                                 "CONFLICT")
                            failures.append((day_value, "CALENDAR_DATE_" + str(record_status).upper()))
                        status = "unknown" if failures else "eligible"
                        reason = (failures[0][1] + ":" + failures[0][0]
                                  if failures else None)
                    else:
                        roles = info.get("roles") or {}
                        periods = []
                        for leaf_item in leaf_items:
                            values = {role: product_calendar.cell_value(leaf_item, code)
                                      for role, code in roles.items()}
                            try:
                                p_start = datetime.strptime(str(values["period_start_date"])[:10], "%Y-%m-%d").date()
                                p_end = datetime.strptime(str(values["period_end_exclusive_date"])[:10], "%Y-%m-%d").date()
                            except (ValueError, KeyError, TypeError):
                                continue
                            if p_start <= datetime.strptime(required[0], "%Y-%m-%d").date()                                     and p_end > datetime.strptime(required[-1], "%Y-%m-%d").date():
                                periods.append(leaf_item)
                        main_labels = product_calendar.main_accounting_labels(
                            declaration, item.get("row") or {})
                        main_end = (datetime.strptime(required[-1], "%Y-%m-%d").date()
                                    + timedelta(days=1))
                        main_start = datetime.strptime(required[0], "%Y-%m-%d").date()
                        exact = not main_labels
                        periods = []
                        for leaf_item in leaf_items:
                            values = {role: product_calendar.cell_value(leaf_item, code)
                                      for role, code in roles.items()}
                            try:
                                p_start = datetime.strptime(str(values["period_start_date"]), "%Y-%m-%d").date()
                                p_end = datetime.strptime(str(values["period_end_exclusive_date"]), "%Y-%m-%d").date()
                            except (ValueError, KeyError, TypeError):
                                continue
                            if exact:
                                if p_start != main_start or p_end != main_end:
                                    continue
                            elif not (p_start <= main_start and p_end >= main_end):
                                continue
                            if any(str(values.get(role)) != str(label)
                                   for role, label in main_labels.items()):
                                continue
                            periods.append(leaf_item)
                        usable = [p for p in periods
                                  if p.get("calendar_record_status") == "eligible"]
                        identity = {product_calendar.accounting_identity({
                            role: product_calendar.cell_value(p, roles.get(role))
                            for role in product_calendar.ACCOUNTING_ROLES})
                            for p in usable}
                        status = "eligible" if len(usable) == 1 and len(identity) == 1 else "unknown"
                        reason = None if status == "eligible" else (
                            "CALENDAR_PERIOD_NOT_COVERED" if not periods
                            else "CALENDAR_PERIOD_CONFLICT")
                        matched = periods
                        failures = [] if status == "eligible" else [(None, reason)]
                    if status == "eligible":
                        row_statuses.append("eligible")
                    else:
                        diagnostics.append(self._calendar_apply(
                            item, field_code, reason, ref,
                            [{"record_id": (m.get("record_ref") or {}).get("logical_key"),
                              "record_version": (m.get("record_ref") or {}).get("revision_id")}
                             for m in matched], "indeterminate", required))
                        row_statuses.append(status)
                aggregate = ("eligible" if row_statuses and all(s == "eligible" for s in row_statuses)
                             else "not_yet" if row_statuses and all(s == "not_yet" for s in row_statuses)
                             else "unknown")
                field_states[field_code] = aggregate
                refs_out.append({"path": rule["path"], "field": field_code,
                                 "role": rule["role"], "ref": copy.deepcopy(ref),
                                 "status": aggregate, "reason": None,
                                 "profile": {"dependency_status": dep_status, "timezone": timezone_status}})
        if refs_out:
            result["calendar_resolution"] = {"refs": refs_out, "fields": field_states}
            result.setdefault("diagnostics", []).extend(diagnostics)
        return result

    def _check_dependencies(self, dependencies, dataset_id, checked=None):
        # Calendar roles are verified by the fixed-calendar helper after field
        # selection; do not force all refs through the generic legacy check.
        remaining = [dep for dep in dependencies
                     if dep.get("role") not in {"calendar_ref", "accounting_calendar_ref"}]
        return super()._check_dependencies(remaining, dataset_id, checked)

    def read(self, product_id=None, *, snapshot_id, perspective="snapshot_contents",
             at=None, subject=None, include_history=False, verify_contract_files=True,
             held_scope=None, usable_stage=None, fields=None, business_time_range=None):
        self.require_permission("read")
        if perspective == "system_held_at":
            return self._read_system_held(
                product_id, snapshot_id=snapshot_id, at=at, subject=subject,
                include_history=include_history, verify_contract_files=verify_contract_files,
                held_scope=held_scope, usable_stage=usable_stage,
                fields=fields, business_time_range=business_time_range)
        result = self._read(product_id, snapshot_id=snapshot_id, perspective=perspective,
                            at=at, subject=subject, include_history=include_history,
                            verify_contract_files=verify_contract_files)
        self._assert_selected_declarations(result)
        self._qualify_calendar(result, perspective=perspective, at=at,
                               held_scope=held_scope, usable_stage=usable_stage,
                               fields=fields, business_time_range=business_time_range)
        public = self._public_read_result(result)
        for row in public.get("rows", []):
            record_ref = row.get("record_ref") or {}
            row["record_id"] = record_ref.get("logical_key")
            row["record_version"] = record_ref.get("revision_id")
        return public

    def _read_system_held(self, product_id, *, snapshot_id, at, subject,
                          include_history, verify_contract_files,
                          held_scope, usable_stage, fields=None,
                          business_time_range=None):
        from .product_holdings import HoldingLedger, HoldingError, STAGES
        if at is None:
            raise ValueError("HISTORICAL_CUTOFF_REQUIRED")
        datetime.strptime(at, "%Y-%m-%dT%H:%M:%SZ")
        if not held_scope or not isinstance(held_scope, str):
            raise ValueError("INSTANCE_HOLDING_UNKNOWN:held_scope required")
        if usable_stage == "readable":
            usable_stage = "published_readable"
        if usable_stage not in STAGES:
            raise ValueError("INSTANCE_HOLDING_UNKNOWN:usable_stage required")
        ledger = HoldingLedger(self.root, held_scope)
        facts = ledger.facts()
        if not facts:
            raise ValueError("INSTANCE_HOLDING_UNKNOWN:" + held_scope)
        base = self._read(product_id, snapshot_id=snapshot_id,
                          perspective="snapshot_contents", subject=subject,
                          include_history=True,
                          verify_contract_files=verify_contract_files)
        self._assert_selected_declarations(base)
        rows = []
        diagnostics = []
        holding_diagnostics = []
        # One ledger read per (snapshot, product, stage) inside this request.
        # The cache is request-local only: no holding facts are persisted or
        # reused across reads, so a later correction is still observed.
        stage_maps = {}

        def stage_map_for(item_product_id):
            cache_key = (snapshot_id, item_product_id, usable_stage)
            if cache_key not in stage_maps:
                stage_maps[cache_key] = ledger.stage_times(
                    snapshot_id=snapshot_id, product_id=item_product_id,
                    stage=usable_stage)
            return stage_maps[cache_key]

        for item in base.get("rows", []):
            ref = item.get("record_ref") or {}
            key = (ref.get("logical_key"), ref.get("revision_id"))
            stage_map = stage_map_for(item.get("product_id"))
            observed_at = stage_map.get(key)
            if observed_at is not None and observed_at <= at:
                item["held_at"] = observed_at
                item["held_scope"] = held_scope
                item["usable_stage"] = usable_stage
                item["eligibility"] = {"decision": "eligible",
                                       "reason": "held_at_usable_stage",
                                       "mode": "system_held_at",
                                       "held_at": observed_at,
                                       "usable_stage": usable_stage}
                rows.append(item)
                continue
            # A record-version that is not eligible at this held cutoff is
            # reported explicitly instead of being silently dropped.  "No
            # holding fact" (unknown) and "observed later than cutoff"
            # (not yet held) stay distinct.  These diagnostics are never fed
            # into version-leaf selection, so a future revision cannot mask an
            # older eligible version.
            if observed_at is not None:
                decision, holding_state = "ineligible", "not_yet_held"
                reason = "HELD_STAGE_AFTER_CUTOFF"
            else:
                decision, holding_state = "indeterminate", "unknown"
                reason = "NO_HOLDING_FACT_FOR_RECORD_VERSION"
            holding_diagnostics.append({
                "product_id": item.get("product_id"),
                "business_key": ref.get("logical_key"),
                "record_id": ref.get("logical_key"),
                "record_version": ref.get("revision_id"),
                "subject": copy.deepcopy(item.get("subject")),
                "object": (item.get("row") or {}).get("object"),
                "relation_type": (item.get("row") or {}).get("relation_type"),
                "contract_ref": copy.deepcopy(item.get("contract_ref")),
                "decision": decision,
                "holding_state": holding_state,
                "reason": reason,
                "observed_stage_at": observed_at,
                "held_cutoff": at,
                "held_scope": held_scope,
                "usable_stage": usable_stage,
                "eligibility": {"decision": decision, "reason": reason,
                                "mode": "system_held_at",
                                "observed_stage_at": observed_at,
                                "held_at_cutoff": at},
            })
        if not rows:
            if not ledger.has_product(snapshot_id=snapshot_id, product_id=product_id or ""):
                if product_id is not None:
                    raise ValueError("INSTANCE_HOLDING_UNKNOWN:product not held")
            if product_id is not None and not stage_map_for(product_id):
                raise ValueError("INSTANCE_HOLDING_UNKNOWN:stage not observed")
            raise ValueError("INSTANCE_HOLDING_NOT_YET_AVAILABLE")
        if include_history:
            selected = rows
        else:
            grouped = {}
            for item in rows:
                grouped.setdefault((item.get("product_id"),
                                    (item.get("record_ref") or {}).get("logical_key")), []).append(item)
            selected = []
            for group in grouped.values():
                leaves = self._version_leaves(group)
                leaf_ids = {(item.get("record_ref") or {}).get("revision_id") for item in leaves}
                for item in group:
                    item["revision_state"] = (
                        "withdrawn" if (item.get("revision") or {}).get("withdrawn") else
                        "current" if (item.get("record_ref") or {}).get("revision_id") in leaf_ids
                        else "superseded")
                if len(leaves) == 1 and not (leaves[0].get("revision") or {}).get("withdrawn"):
                    selected.append(leaves[0])
                elif len(leaves) == 1:
                    item = leaves[0]
                    diagnostics.append({
                        "product_id": item.get("product_id"),
                        "business_key": (item.get("record_ref") or {}).get("logical_key"),
                        "subject": item.get("subject"), "object": (item.get("row") or {}).get("object"),
                        "relation_type": (item.get("row") or {}).get("relation_type"),
                        "contract_ref": item.get("contract_ref"),
                        "decision": "ineligible", "reason": "WITHDRAWN_AT_HELD_CUTOFF",
                        "eligibility": {"decision": "ineligible", "reason": "WITHDRAWN_AT_HELD_CUTOFF"},
                        "held_at": item.get("held_at"), "held_scope": held_scope,
                        "usable_stage": usable_stage,
                    })
                else:
                    for item in leaves:
                        diagnostics.append({
                            "product_id": item.get("product_id"),
                            "business_key": (item.get("record_ref") or {}).get("logical_key"),
                            "subject": item.get("subject"), "object": (item.get("row") or {}).get("object"),
                            "relation_type": (item.get("row") or {}).get("relation_type"),
                            "contract_ref": item.get("contract_ref"),
                            "decision": "indeterminate", "reason": "REVISION_BRANCH_CONFLICT",
                            "held_at": item.get("held_at"), "held_scope": held_scope,
                            "usable_stage": usable_stage,
                        })
        # Per-record-version holding diagnostics: only eligible versions took
        # part in the version decision above.
        diagnostics.extend(holding_diagnostics)
        # Base diagnostics are still relevant, but mark the actual held view.
        for diag in base.get("diagnostics", []):
            if diag.get("calendar_status"):
                continue
            diag = copy.deepcopy(diag)
            diag.setdefault("eligibility", {"decision": diag.get("decision"),
                                            "reason": diag.get("reason")})
            diag["held_scope"] = held_scope
            diag["usable_stage"] = usable_stage
            diagnostics.append(diag)
        visible = {(item.get("product_id"), (item.get("contract_ref") or {}).get("digest", "legacy"))
                   for item in selected + diagnostics}
        product_ids = {key[0] for key in visible}
        result = dict(base)
        result.update({"perspective": "system_held_at", "at": at,
                       "held_scope": held_scope, "usable_stage": usable_stage,
                       "rows": selected,
                       "holding_coverage": {
                           "record_versions_scanned": len(base.get("rows", [])),
                           "record_versions_eligible": len(rows),
                           "record_versions_unknown": sum(
                               1 for item in holding_diagnostics
                               if item["holding_state"] == "unknown"),
                           "record_versions_not_yet_held": sum(
                               1 for item in holding_diagnostics
                               if item["holding_state"] == "not_yet_held"),
                           "selected_rows": len(selected),
                           "selection_diagnostics": len(diagnostics) - len(holding_diagnostics),
                       },
                       "diagnostics": diagnostics + [d for d in base.get("diagnostics", [])
                                                     if d.get("product_id") in product_ids
                                                     and d.get("calendar_status")],
                       "products": [p for p in base.get("products", [])
                                    if p.get("product_id") in product_ids]})
        self._qualify_calendar(result, perspective="system_held_at", at=at,
                               held_scope=held_scope, usable_stage=usable_stage,
                               fields=fields, business_time_range=business_time_range)
        public = self._public_read_result(result)
        for row in public.get("rows", []):
            ref = row.get("record_ref") or {}
            row["record_id"] = ref.get("logical_key")
            row["record_version"] = ref.get("revision_id")
        public["held_scope"] = held_scope
        public["usable_stage"] = usable_stage
        public["held_at"] = at
        return public

    def discover_products(self, *, snapshot_id, subject=None):
        self.require_permission("read")
        result = self._discover_products(snapshot_id=snapshot_id, subject=subject)
        result["products"] = [self._public_product(product)
                              for product in result.get("products", [])]
        result["public_projection"] = self._public_projection_metadata(
            result.get("products", []), result.get("source_ids", []))
        result.pop("source_ids_by_product", None)
        return result

    def trace(self, product_id, *, snapshot_id):
        raise ValueError("TRACE_NOT_AVAILABLE_IN_DATA_ONLY_PROFILE")
