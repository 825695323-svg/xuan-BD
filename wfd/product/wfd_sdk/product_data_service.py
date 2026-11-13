"""Data-only structured ingress (R1 local isolated boundary).

WFD stores admitted structured data, stable record identity, business time,
data versions and internal definition/contract metadata.  Original files,
source/evidence references, BD locators and external execution traces belong
to BD and are rejected before any write.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from jsonschema import Draft202012Validator
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .duckdb_sdk import canonical, sha, eligibility_at
from .duckdb_storage import selected_rows_page
from .product_service import (
    SERVICE_VERSION, WFDProductService, _second_now, _issue, current_only_business,
)
from .product_governance import validate_payload, validate_units
from . import product_calendar
from . import write_targets
from . import adjustment_anchors
from . import basis_prices
from .writerlock import writer_lock
from .state import COMPAT_FORMATS

_DIGEST_HEX = __import__('re').compile(r'[0-9a-f]{64}')
DATA_ONLY_PROTOCOL = "wfd.structured-ingest/1.0"
DATA_ONLY_PROFILE = "data_only"
DATA_ONLY_STATUS_FORMAT = "wfd.data-only-request-state/1.0"
DATA_ONLY_FORMAL_FORMAT = "wfd.data-only-formal-publication/1.0"
# P2 explicitly selects the additive ingest schema: spec 1.1 = spec 1.0 plus
# `price_adjustment.method`.  The frozen 1.0 file stays untouched and is still
# published for readers that only know that shape.
DATA_ONLY_SCHEMA_ENTRY = "protocol/schemas/wfd-structured-ingest-1.1.schema.json"
DATA_ONLY_SCHEMA_ID = "https://wfd.example/spec/1.1/wfd-structured-ingest.schema.json"
DATA_ONLY_SCHEMA_SAMPLE = "protocol/samples/wfd-structured-ingest.example.json"
DATA_ONLY_MODES = {"complete_snapshot", "partial_observation", "explicit_increment",
                   "source_correction", "processing_repair", "withdrawal"}
FIXED_PAGE_FORMAT = "wfd.fixed-read-page/1"
FIXED_PRODUCT_PAGE_FORMAT = "wfd.fixed-product-page/1"
FIXED_PAGE_DEFAULT_SIZE = 256
FIXED_PAGE_MAX_SIZE = 1000
FIXED_PAGE_DEFAULT_BYTES = 1_048_576
FIXED_PAGE_MAX_BYTES = 4_194_304
FIXED_PAGE_SELECTION_LIMIT = 5000


def fixed_read_page_capabilities():
    return {"supported": True, "format_version": FIXED_PAGE_FORMAT,
            "requires_snapshot": True, "requires_product": True,
            "selection_limit": FIXED_PAGE_SELECTION_LIMIT,
            "selection": "unique record_id/record_version; all must be visible leaves",
            "selection_order": "record_id UTF-8 bytes, then record_version UTF-8 bytes",
            "perspective": "snapshot_contents", "include_history": False,
            "page_size": {"default": FIXED_PAGE_DEFAULT_SIZE, "max": FIXED_PAGE_MAX_SIZE},
            "max_page_bytes": {"default": FIXED_PAGE_DEFAULT_BYTES, "max": FIXED_PAGE_MAX_BYTES,
                               "scope": "complete public result including machine result fields"},
            "payload_kinds": ["scalar_rows", "tabular_rows"],
            "calendar_qualification": {"supported": False,
                                       "roles": ["calendar_ref", "accounting_calendar_ref"]},
            "read_dependencies": "none; calendar/dependency products use existing fixed_read",
            "history_modes": ["snapshot_contents"],
            "whole_product_content_digest": "not computed by selected-row paging",
            "capacity_boundary": "catalog/version metadata remains O(N); target file hashes stream per page"}

def fixed_read_product_page_capabilities():
    caps = fixed_read_page_capabilities()
    for key in ("selection_limit", "selection", "selection_order"):
        caps.pop(key)
    caps.update({"format_version": FIXED_PRODUCT_PAGE_FORMAT, "read_scope": "full_product",
                 "view": "all unique current nonwithdrawn leaves; any branch rejects the view",
                 "order": "record_id UTF-8 bytes, then record_version UTF-8 bytes",
                 "total_rows": "fixed current nonwithdrawn leaf count, not physical row count",
                 "empty_view": "one initial terminal page with intact product metadata",
                 "whole_product_content_digest": "not computed; view/page digests identify records only"})
    return caps


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


def _scan_external_metadata(value, path="", parent=None):
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = (path + "." + str(key)) if path else str(key)
            # P2: price_adjustment.method (qfq/hfq) is a declared caliber, not
            # external execution metadata.  Exempted only at that exact parent.
            if key in FORBIDDEN_EXTERNAL_KEYS and not (key == "method"
                                                      and parent == "price_adjustment"):
                raise ValueError("EXTERNAL_METADATA_FORBIDDEN:" + child_path)
            _scan_external_metadata(child, child_path, key)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _scan_external_metadata(child, f"{path}[{index}]", parent)


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
            _strict_keys(child, {"direction", "method", "anchor_ref"}, child_path)
            if child.get("method") is not None and not isinstance(child["method"], str):
                raise ValueError("SEMANTIC_CONTEXT_AXIS_INVALID:" + child_path + ".method")
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
    """R1 has no general internal ref registry for the remaining semantic refs.

    Scan only the fixed declaration paths (top-level semantic_context and each
    declared field_semantic_context entry).  No recursive dict walk: contract
    bodies may carry settled business payload that is not a ref declaration.

    P2 moved ``price_adjustment.anchor_ref`` out of this reject list: it is now
    resolved against the registered adjustment-anchor catalog by
    ``adjustment_anchors.resolve``.  Every other built-in reference stays here.
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
    # P2 selects the additive ingest schema explicitly (spec 1.1 = 1.0 + method);
    # the frozen 1.0 file is never edited in place.
    structured_schema_entry = DATA_ONLY_SCHEMA_ENTRY

    def __init__(self, engine, *, caller_roles=None, caller_id="local",
                 unit_registry=None, trusted_actor_namespaces=None,
                 write_targets_document=None, write_target_reserved_families=None,
                 adjustment_anchors_document=None, basis_price_catalog=None):
        self._write_targets_document = (copy.deepcopy(write_targets_document)
                                        if write_targets_document is not None else None)
        # A preparation store holds no historical products: the families that
        # already hold records at the *target* must still block an unbound write.
        self._write_target_reserved = copy.deepcopy(write_target_reserved_families or {})
        # Same reasoning for the adjustment-anchor catalog: a volume preparation
        # store resolves anchors from the *target*, never from its own tree.
        self._adjustment_anchors_document = (copy.deepcopy(adjustment_anchors_document)
                                             if adjustment_anchors_document is not None else None)
        # ... and the same again for the basis price an anchor points at (R2).
        self._basis_price_catalog = basis_price_catalog
        super().__init__(engine, allowed_sources={}, can_register=True,
                         caller_roles=caller_roles, caller_id=caller_id,
                         unit_registry=unit_registry,
                         trusted_actor_namespaces=trusted_actor_namespaces)
        self._data_only_schema_path = Path(__file__).resolve().parent.parent / (
            self.structured_schema_entry)
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
            "spec_version": "1.1",
            "additive_over": "https://wfd.example/spec/1.0/wfd-structured-ingest.schema.json",
            "profile": DATA_ONLY_PROFILE,
            "sample_path": DATA_ONLY_SCHEMA_SAMPLE,
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
        caps["usage_governance"] = {
            "format_version": "wfd.usage-suspension/1",
            "catalog_file": "catalog/usage_suspensions.json",
            "writer_lock": "shared with submit",
            "operations": ["usage_status", "usage_audit_read", "usage_suspend",
                           "usage_authorize_repair", "usage_resolve"],
            "default_business_read": "denied_when_suspended",
            "audit_reproduction": "explicit issue_id required; result is publishable=false and compute_eligible=false",
            "legacy_restrictions_retained": True,
            "multi_issue": "restrictions accumulate; resolving one issue never lifts another",
        }
        caps["operations"] = {
            "submit": {"supported": True, "protocol": DATA_ONLY_PROTOCOL,
                       "duplicate_policies": ["skip_identical_append"]},
            "fixed_read": {"supported": True, "requires_snapshot": True,
                           "returns": ["record_id", "record_version", "record_ref"]},
            "fixed_read_page": fixed_read_page_capabilities(),
            "fixed_read_product_page": fixed_read_product_page_capabilities(),
            "request_status": {"supported": True, "key": "original request_identity"},
            "recovery": {"supported": True, "same_identity": True},
            "contract_discovery": {"supported": True},
            "snapshot_status": {"supported": True, "authority": "active_head", "read_only": True},
            "read_product": {"supported": True},
            "resolve_write_target": {"supported": True, "read_only": True,
                                     "statuses": ["bound", "never_registered",
                                                  "family_without_target", "conflict",
                                                  "query_failed"]},
            "register_write_target": {"supported": True, "explicit_only": True,
                                      "requires_roles": ["register", "publish"],
                                      "implicit_rebind": False},
            "resolve_adjustment_anchor": {
                "supported": True, "read_only": True,
                "catalog": adjustment_anchors.RELATIVE_DIR,
                "codes": list(adjustment_anchors.RESOLUTION_CODES),
                "basis_price_codes": list(basis_prices.RESOLUTION_CODES)},
            "register_adjustment_anchor": {
                "supported": True, "explicit_only": True,
                "requires_roles": ["register", "publish"],
                "append_only": True, "implicit_creation": False,
                "methods": sorted(adjustment_anchors.METHODS),
                "catalog": adjustment_anchors.RELATIVE_DIR,
                "basis_price_validated_at_registration": True,
                "basis_price_codes": list(basis_prices.RESOLUTION_CODES)},
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

    def snapshot_status(self):
        """Resolve the already-open instance's authoritative head without repair.

        A null result is restricted to a verifiably initialized empty store;
        invalid or orphaned commits must never become a new-store indication.
        """
        self.require_permission("read")
        engine = self.engine
        before = engine.state.read()
        if (not isinstance(before, dict) or before.get("format_version") not in COMPAT_FORMATS
                or "active_head" not in before
                or before["active_head"] is not None and not re.fullmatch(
                    r"s_[0-9a-f]{24}", str(before["active_head"]))):
            raise ValueError("HEAD_INVALID_FORMAT")
        head = engine.head()  # StateStore.resolve is the existing active-head authority.
        if canonical(engine.state.read()) != canonical(before):
            raise ValueError("HEAD_CHANGED:retry the read-only status request")
        if head is None:
            pristine = (before["active_head"] is None
                        and before.get("head_snapshot_sha256") is None
                        and before.get("update_seq") == 0
                        and before.get("prev_head") is None
                        and not before.get("activation_history"))
            for name in ("commits", "snapshots", "manifests"):
                directory = engine.root / "catalog" / name
                pristine = pristine and directory.is_dir() and not any(
                    item for item in directory.iterdir() if not item.name.startswith("._"))
            try:
                retention = json.loads((engine.root / "catalog/retention.json").read_text("utf-8"))
                pristine = (pristine and retention.get("format_version") == "wfd.retention/1.0"
                            and retention.get("snapshots") == {})
            except (OSError, ValueError, AttributeError):
                pristine = False
            if not pristine:
                raise ValueError("EMPTY_STORE_UNVERIFIED")
        elif head.get("snapshot_id") != before["active_head"]:
            raise ValueError("HEAD_CHANGED:active snapshot did not match resolved authority")
        units = {code: {"definition": definition,
                        "digest": "sha256:" + sha(canonical({"code": code, "definition": definition}))}
                 for code, definition in sorted(self.unit_registry.items())}
        return {"format_version": "wfd.snapshot-status/1", "profile": DATA_ONLY_PROFILE,
                "snapshot_id": head["snapshot_id"] if head is not None else None,
                "empty": head is None, "authority": "active_head",
                "caller_id": self.caller_id, "caller_roles": sorted(self.caller_roles),
                "unit_definitions": self._public_unit_definitions(units)}

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
                   "outputs", "consistency_groups", "duplicate_policy"}
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
        duplicate_policy = doc.get("duplicate_policy")
        if duplicate_policy is not None and duplicate_policy != "skip_identical_append":
            raise ValueError("DUPLICATE_POLICY_INVALID")
        if duplicate_policy and any(item.get("input_mode") not in {
                "partial_observation", "explicit_increment"} or item.get("revisions")
                for item in outputs):
            raise ValueError("DUPLICATE_POLICY_APPEND_ONLY")
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

    @staticmethod
    def _intent_matches(intent, key, identity):
        return (isinstance(intent, dict) and intent.get("format_version") == "wfd.data-only-intent/1.0"
                and intent.get("profile") == DATA_ONLY_PROFILE and intent.get("request_key") == key
                and intent.get("request_identity") == identity
                and isinstance(intent.get("input_fingerprint"), str)
                and re.fullmatch(r"[0-9a-f]{64}", intent["input_fingerprint"]))

    def _plan_path(self, key):
        return f"catalog/product_service/data_only_submission_plans/{key}.json"

    def _load_plan(self, key):
        path = self.root / self._plan_path(key)
        return json.loads(path.read_text("utf-8")) if path.is_file() else None

    def _save_plan(self, key, identity, fingerprint, parent, results, *,
                   prepared_document=None, no_publication_state=None):
        plan = {"format_version": "wfd.data-only-submission-plan/1.0",
                "profile": DATA_ONLY_PROFILE,
                "request_key": key,
                "request_identity": copy.deepcopy(identity),
                "input_fingerprint": fingerprint,
                "parent_snapshot_id": parent,
                "outputs": [{"output_key": item["output_key"],
                             "product_id": item.get("product_id"),
                             "records": copy.deepcopy(item.get("inserted_records", item.get("records", [])))}
                            for item in results if not item.get("errors")
                            and item.get("inserted_records", item.get("records", []))]}
        if no_publication_state is not None or any("row_results" in item for item in results):
            plan.update(duplicate_policy="skip_identical_append",
                        output_results=copy.deepcopy(results),
                        prepared_document=copy.deepcopy(prepared_document),
                        no_publication_state=no_publication_state)
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
        self._restore_duplicate_results(record)
        self._write_status(self._status_path(record["request_key"]), record)

    @staticmethod
    def _terminal(state):
        return state in {"published_formal", "partially_published_formal",
                         "published_sandbox", "partially_published_sandbox", "rejected",
                         "unchanged", "conflicts_pending"}

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
        for name in ("duplicate_policy", "row_summary", "new_snapshot_created"):
            if name in record:
                result[name] = copy.deepcopy(record[name])
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
            if intent is not None:
                valid = self._intent_matches(intent,key,request_identity)
                plan = self._load_plan(key)
                if valid and plan and plan.get("no_publication_state"):
                    return self._finish_no_publication_plan(plan, replay=True)
                return {"protocol_version": DATA_ONLY_PROTOCOL, "profile": DATA_ONLY_PROFILE,
                        "request_key": key, "request_identity": copy.deepcopy(request_identity),
                        "state": "accepted_not_published" if valid else "recovery_conflict",
                        "input_fingerprint": intent.get("input_fingerprint") if valid else None,
                        "snapshot_id": None, "output_results": [], "formal_publication_ref": None,
                        "errors": [] if valid else [_issue("RECOVERY_INTENT_INVALID", "Stored original intent identity is inconsistent")],
                        "production_publishable": False}
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
            if (not self._intent_matches(intent, key, identity)
                    or intent.get("input_fingerprint") != fingerprint
                    or snapshot.get("request_key") != key):
                raise ValueError("RECOVERY_REQUEST_IDENTITY_MISMATCH")
            if plan is not None and (plan.get("request_key") != key
                    or plan.get("request_identity") != identity
                    or plan.get("input_fingerprint") != fingerprint):
                raise ValueError("RECOVERY_PLAN_IDENTITY_MISMATCH")
            if plan is None and any((entry.get("source_bundle") or {}).get("_wfd_duplicate_policy")
                                    for entry in snapshot.get("files", [])
                                    if entry.get("output_key") in (receipt.get("outputs_success") or [])):
                raise ValueError("DUPLICATE_PLAN_UNAVAILABLE")
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
    @staticmethod
    def _row_summary(rows):
        return {state: sum(row.get("state") == state for row in rows)
                for state in ("inserted", "duplicate_skipped", "conflict_pending", "pending_publication")}

    @staticmethod
    def _business_projection(product, row):
        return {"definition_ref": product.get("definition_ref"),
                "subject": product.get("subject"), "payload_kind": product.get("payload_kind"),
                "unit_definitions": product.get("contracts", {}).get("semantic", {}).get("unit_definitions", {}),
                "row": row}

    @staticmethod
    def _difference_fields(left, right, path=""):
        if canonical(left) == canonical(right):
            return []
        if isinstance(left, dict) and isinstance(right, dict):
            result = []
            for key in sorted(set(left) | set(right)):
                field = path + "." + key if path else key
                result.extend([field] if key not in left or key not in right else
                              WFDDataOnlyService._difference_fields(left[key], right[key], field))
                if len(result) >= 32:
                    return result[:32]
            return result
        return [path or "row"]

    def _duplicate_current(self, product, head_id, wanted):
        if not head_id:
            return []
        snapshot = self.engine._valid_snapshot_exact(head_id, verify_payloads=False)
        if not any(entry.get("product_id") == product["product_id"] for entry in snapshot["files"]):
            return []
        declaration = product["declaration"]
        if (product["payload_kind"] in {"scalar_rows", "tabular_rows"}
                and not current_only_business(declaration)
                and not str(declaration.get("semantic_code", "")).startswith("wfd.foundation.calendar.")
                and not self._page_calendar_required(product)
                and not product.get("contracts", {}).get("read", {}).get("dependencies", [])):
            parts, _, selected = self._page_parts(snapshot, product["product_id"])
            self._page_verify_files(parts)
            selected = [{**item, "position": position} for position, item in enumerate(
                (item for item in selected if item["record_id"] in wanted), 1)]
            rows, offset = [], 0
            while offset < len(selected):
                page = selected_rows_page(parts, selected, after_position=offset,
                                          row_limit=FIXED_PAGE_MAX_SIZE, max_row_bytes=FIXED_PAGE_MAX_BYTES)
                if not page:
                    raise ValueError("DUPLICATE_RECORD_READ_INCOMPLETE")
                for item in page:
                    row = item["row"]
                    row["business_key"] = item["record_id"]
                    rows.append({"row": row, "revision": item["revision"],
                                 "record_ref": {"logical_key": item["record_id"],
                                                "revision_id": item["record_version"]},
                                 "_product": parts[item["part_index"]]["product"]})
                offset = page[-1]["position"]
            superseded = {version.get("supersedes") for part in parts
                          for version in (part["source_bundle"]["_wfd_row_versions"][part["output_key"]]).values()}
            for part in parts:
                for version in part["source_bundle"]["_wfd_row_versions"][part["output_key"]].values():
                    if (version["logical_key"] in wanted and version["withdrawn"]
                            and version["revision_id"] not in superseded):
                        rows.append({"row": {}, "revision": version, "_product": part["product"],
                                     "record_ref": {"logical_key": version["logical_key"],
                                                    "revision_id": version["revision_id"]}})
            return rows
        read = self._read(product["product_id"], snapshot_id=head_id, include_history=True)
        by_contract = {(item.get("contract_ref") or {}).get("digest"): item for item in read["products"]}
        return [{**item, "_product": by_contract[(item.get("contract_ref") or {}).get("digest")]}
                for item in read["rows"]]

    def _classify_duplicate_rows(self, prepared, head_id):
        """Classify the entire atomic request before creating any new version."""
        groups, current, intervals = {}, {}, {}
        for internal, product, extension, outcome in prepared:
            key_field = "event_id" if internal["payload"]["kind"] == "event_records" else "business_key"
            outcome["row_results"] = []
            for index, row in enumerate(internal["payload"]["rows"]):
                result = {"row_index": index, "business_key": row[key_field], "state": "pending_publication"}
                outcome["row_results"].append(result)
                groups.setdefault((product["product_id"], row[key_field]), []).append(
                    (internal, product, row, result))
        for internal, product, extension, outcome in prepared:
            pid = product["product_id"]
            if pid not in current:
                wanted = {key for product_id, key in groups if product_id == pid}
                current[pid] = self._duplicate_current(product, head_id, wanted)
        interval_conflicts, interval_previous = set(), {}
        for internal, product, extension, outcome in prepared:
            if not current_only_business(product["declaration"]):
                continue
            pid = product["product_id"]
            for row in internal["payload"]["rows"]:
                key = row["business_key"]
                single = {**internal, "payload": {**internal["payload"], "rows": [row]}}
                try:
                    interval = next(iter(self._check_current_bar_keys(single, product, current[pid], "business_key")))
                    intervals.setdefault((pid, interval), set()).add(key)
                except ValueError:
                    interval_conflicts.add((pid, key))
                    same_interval = []
                    for existing in current[pid]:
                        try:
                            self._check_current_bar_keys(single, product, [existing], "business_key")
                        except ValueError:
                            same_interval.append(existing)
                    interval_previous[(pid, key)] = same_interval
        for (pid, _), keys in intervals.items():
            if len(keys) > 1:
                interval_conflicts.update((pid, key) for key in keys)
        new_rows = {outcome["output_key"]: [] for _, _, _, outcome in prepared}
        for (pid, key), candidates in groups.items():
            previous = [item for item in current[pid] if item["record_ref"]["logical_key"] == key]
            previous = self._version_leaves(previous)
            first = candidates[0]
            projection = self._business_projection(first[1], first[2])
            differences = set()
            for _, product, row, result in candidates[1:]:
                differences.update(self._difference_fields(projection, self._business_projection(product, row)))
            reason = None
            if differences:
                reason = "BATCH_BUSINESS_CONTENT_CONFLICT"
            elif (pid, key) in interval_conflicts:
                reason = "CURRENT_ONLY_BUSINESS_KEY_CONFLICT"
                differences.add("row.observation_time")
            elif previous:
                if len(previous) != 1 or previous[0]["revision"].get("withdrawn"):
                    reason = "EXISTING_RECORD_NOT_UNIQUE_OR_WITHDRAWN"
                    differences.add("record_version")
                else:
                    differences.update(self._difference_fields(
                        projection, self._business_projection(previous[0]["_product"], previous[0]["row"])))
                    if differences:
                        reason = "BUSINESS_CONTENT_CONFLICT"
            matched = interval_previous.get((pid, key), previous)
            existing = [{"product_id": pid, "snapshot_id": head_id,
                         "record_id": item["record_ref"]["logical_key"],
                         "record_version": item["record_ref"]["revision_id"],
                         "definition_ref": copy.deepcopy(item["_product"].get("definition_ref")),
                         "withdrawn": bool(item["revision"].get("withdrawn"))} for item in matched]
            representatives, represented = [], set()
            if reason and len(candidates) > 1:
                for entry in candidates:
                    signature = canonical(self._business_projection(entry[1], entry[2]))
                    if signature not in represented:
                        represented.add(signature)
                        representatives.append({"output_key": entry[0]["output_key"],
                                                "row_index": entry[3]["row_index"]})
                        if len(representatives) == 4:
                            break
            for internal, product, row, result in candidates:
                if reason:
                    result.update(state="conflict_pending", reason=reason,
                                  difference_fields=sorted(differences), existing_records=copy.deepcopy(existing))
                    if len(candidates) > 1:
                        result["conflicting_rows"] = copy.deepcopy(representatives)
                        result["conflicting_rows_total"] = len(candidates)
                elif previous:
                    result.update(state="duplicate_skipped", **copy.deepcopy(existing[0]))
                else:
                    result.update(intended_state="inserted" if result is first[3] else "duplicate_skipped",
                                  publication_output_key=first[0]["output_key"])
            if not reason and not previous:
                new_rows[first[0]["output_key"]].append(first[2])
        for internal, product, extension, outcome in prepared:
            internal["payload"]["rows"] = new_rows[outcome["output_key"]]
            outcome["row_summary"] = self._row_summary(outcome["row_results"])

    def _restore_duplicate_results(self, record):
        plan = self._load_plan(record["request_key"])
        if not plan or plan.get("duplicate_policy") != "skip_identical_append":
            return
        outcomes = copy.deepcopy(plan.get("output_results") or [])
        actual = {item["output_key"]: item for item in record.get("output_results", [])}
        succeeded = {key for key, item in actual.items() if item.get("publication_state") in {
            "published_formal", "published_sandbox"}}
        for item in outcomes:
            value = actual.get(item["output_key"], {})
            for name in ("publication_state", "engine_publication_state", "errors"):
                if name in value:
                    item[name] = copy.deepcopy(value[name])
            for row in item.get("row_results", []):
                if row.get("state") == "pending_publication" and row.get("publication_output_key") in succeeded:
                    row["state"] = row["intended_state"]
                if row.get("state") in {"inserted", "duplicate_skipped"}:
                    row.setdefault("snapshot_id", record.get("snapshot_id") or plan.get("parent_snapshot_id"))
            item["row_summary"] = self._row_summary(item.get("row_results", []))
            item["snapshot_id"] = record.get("snapshot_id") or plan.get("parent_snapshot_id")
        summary = self._row_summary([row for item in outcomes for row in item.get("row_results", [])])
        state = record["state"]
        if state in {"published_formal", "published_sandbox"} and (
                summary["conflict_pending"] or any(item.get("errors") for item in outcomes)):
            state = "partially_" + state
        record.update(output_results=outcomes, state=state,
                      duplicate_policy="skip_identical_append", row_summary=summary,
                      new_snapshot_created=(None if state == "publication_unknown" and not record.get("snapshot_id") else
                                            bool(record.get("snapshot_id") and
                                                 record.get("snapshot_id") != plan.get("parent_snapshot_id"))))

    @staticmethod
    def _publication_results(results):
        return [{**item, "records": copy.deepcopy(item["inserted_records"])}
                if "inserted_records" in item else item for item in results
                if "inserted_records" not in item or item["inserted_records"]]

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

    def _resolved_declaration(self, internal, dataset_id=None):
        if internal.get("definition_mode") == "create":
            return internal.get("new_definition_declaration") or {}
        # D-ERR-03：reuse 复用 WFDProductService._definition() 的权威判定，
        # 使未登记/引用不符/摘要不符在两条路径上给出同一业务错误，不再退化成文件系统错误。
        declaration, _ref = self._definition(internal, dataset_id)
        return declaration

    # ------------------------------------------------------- write-target binding
    # The formal write target is a declared relation, not a re-derived match.
    # One binding per (dataset_id, product_family_id): a submission may only
    # write into a product already bound to it, or create the first product of
    # a family that holds no product records at all.
    def _write_target_doc(self):
        if self._write_targets_document is not None:
            return self._write_targets_document
        try:
            return write_targets.load(self.root)
        except (OSError, ValueError) as exc:
            raise ValueError("WRITE_TARGET_QUERY_FAILED:" + str(exc))

    def _anchor_doc(self):
        """Registered adjustment anchors that this store may use."""
        if self._adjustment_anchors_document is not None:
            return self._adjustment_anchors_document
        try:
            return adjustment_anchors.load(self.root)
        except (OSError, ValueError) as exc:
            code = str(exc).split(":", 1)[0] or "ADJUSTMENT_ANCHOR_UNREGISTERED"
            raise ValueError(code + ":" + str(exc))

    def _basis_catalog(self):
        """Catalog view used to resolve an anchor's basis price (P2-R2).

        Injected when this service prepares a write for a target volume: the
        basis price is then read from the *target* catalog, exactly like the
        anchor and write-target documents.  The injection may be a *factory* so
        that opening the target read service stays lazy: a submission that
        carries no product-anchored basis price never opens it.
        """
        catalog = self._basis_price_catalog
        if catalog is None:
            catalog = basis_prices.StoreCatalog(self.root, self)
        elif not isinstance(catalog, basis_prices.StoreCatalog):
            catalog = catalog()
        self._basis_price_catalog = catalog
        return catalog

    def _admit_basis_price(self, record, *, replay_point, require_verified=False):
        """Resolve ``basis_price_ref`` for real; one code per failing step.

        ``require_verified`` is the formal-write side (P2-R3, item A): a ``rule``
        basis is storable and readable, but it names no price record, so a
        ``direction=adjusted`` write may not lean on it -- refused with
        ``ADJUSTMENT_BASIS_RULE_UNVERIFIED`` instead of being treated as a
        verified anchor price.  Registration passes ``False`` and keeps storing
        the rule with ``state="rule"``.
        """
        report = basis_prices.resolve(
            record.get("basis_price_ref"), basis_at=record.get("basis_at"),
            catalog=self._basis_catalog(), units=self.unit_registry,
            instrument_scope=record.get("instrument_scope"),
            corporate_action_cutoff=record.get("corporate_action_cutoff"),
            replay_point=replay_point,
            dataset_id=record.get("dataset_id"),
            require_verified=require_verified)
        if report.get("state") == "rejected":
            raise ValueError(str(report.get("code")) + ":" + str(report.get("detail")))
        return report

    def _product_records(self, dataset_id):
        """Registered product records of one dataset, keyed by family."""
        families = {}
        product_dir = self.root / "catalog/product_service/products"
        if not product_dir.is_dir():
            return families
        for path in product_dir.rglob("*.json"):
            if path.name.startswith("._"):
                continue
            try:
                candidate = self._read_json(path.relative_to(self.root))
            except (OSError, ValueError):
                continue
            if candidate.get("dataset_id") != dataset_id:
                continue
            family = candidate.get("product_family_id")
            if not isinstance(family, str) or not family:
                continue
            families.setdefault(family, []).append(candidate)
        return families

    def _admit_write_target(self, internal, dataset_id, declaration, definition_ref):
        """Refuse a formal write that is not the bound target.  Pre-derivation."""
        document = self._write_target_doc()
        derived = write_targets.target_of(
            dataset_id=dataset_id, logical_domain=internal["logical_domain"],
            subject=internal["subject"], declaration=declaration,
            definition_ref=definition_ref)
        family = derived["product_family_id"]
        binding = write_targets.latest(document, dataset_id, family)
        if binding is None:
            records = self._product_records(dataset_id).get(family) or []
            if not records:
                reserved = (self._write_target_reserved.get(dataset_id) or {}).get(family)
                records = [{"product_id": product_id} for product_id in reserved or []]
            if records:
                candidates = sorted({f"{record.get('product_id')}@"
                                     f"{(record.get('definition_ref') or {}).get('digest')}"
                                     for record in records})
                raise ValueError("WRITE_TARGET_UNBOUND:family " + family
                                 + " already holds " + ",".join(candidates)
                                 + "; register the formal write target first")
            # A family without any product records may take its first product, but
            # an adjusted declaration still has to name a registered anchor that is
            # applicable and historically eligible at this point of the batch.
            self._admit_adjustment(internal, dataset_id, declaration, derived)
            return derived, True
        issues = write_targets.compare(binding, derived)
        # 同一产品族的加性演进，或只改计量性质（观测→期间流量）的显式修订：
        # 既有绑定锁定的方向/方法/锚点不变，新增字段可随定义新版本进入；只校对
        # 既有字段的单位，不把新增字段误判为单位冲突，也不把该定义新版本误判为
        # 定义漂移。改方向/方法/锚点/频率等仍由后续比较拒绝。
        relationship = "binding_unresolved"
        prior_records = self._product_records(dataset_id).get(family) or []
        prior = next((record for record in prior_records
                      if record.get("product_id") == binding.get("product_id")
                      and (record.get("definition_ref") or {}).get("digest")
                      == (binding.get("definition_ref") or {}).get("digest")), None)
        if prior is None:
            prior = max((record for record in prior_records
                         if record.get("product_id") == binding.get("product_id")),
                        key=lambda item: int(item.get("definition_sequence") or 0), default=None)
        if prior is not None:
            relationship = self._definition_relation(prior, declaration)
        prior_declaration = (prior or {}).get("declaration") or {}
        changed_keys = {key for key in set(prior_declaration) | set(declaration)
                        if prior_declaration.get(key) != declaration.get(key)}
        # 加性演进，或只改计量性质（观测→期间流量）的显式修订：定义新版本本身
        # 不改变既有字段单位与锁定轴；真正改方向/方法/锚点/频率仍走下面的失败。
        evolution_allowed = relationship == "compatible_additive" or (
            relationship == "breaking"
            and changed_keys <= {"measurement_nature", "field_definitions", "field_semantic_context"})
        if evolution_allowed:
            bound_units = dict(binding.get("units") or {})
            issues = [issue for issue in issues if not (
                issue["code"] == "WRITE_TARGET_DEFINITION_DRIFT"
                or (issue["code"] == "WRITE_TARGET_UNIT_MISMATCH"
                    and all(name not in bound_units
                            for name in (issue.get("detail", {}).get("fields") or {}))))]

        def first(codes):
            for issue in issues:
                if issue["code"] in codes:
                    raise ValueError(issue["code"] + ":" + json.dumps(
                        {"bound": binding.get("product_id"), **issue["detail"]},
                        ensure_ascii=False, sort_keys=True))

        # P2 §4 fixed order: binding -> direction -> method -> anchor resolution
        # (identity / method / digest / scope / applicability) -> anchor version
        # applicability -> historical eligibility -> per-field units -> whole
        # definition digest.  Semantics first, units second, identity last, so a
        # unit error can never hide an anchor error.
        first({"WRITE_TARGET_FAMILY_MISMATCH", "WRITE_TARGET_DIRECTION_MISMATCH",
               "WRITE_TARGET_METHOD_MISMATCH"})
        self._admit_adjustment(internal, dataset_id, declaration, derived)
        first({"WRITE_TARGET_UNIT_MISMATCH"})
        first({"WRITE_TARGET_ANCHOR_MISMATCH", "WRITE_TARGET_DEFINITION_DRIFT"})
        return derived, False

    def _admit_adjustment(self, internal, dataset_id, declaration, derived):
        """P2 steps 4-6: resolve the anchor, then its version and history.

        ``raw`` and ``unknown`` never carry a method or an anchor; ``adjusted``
        must resolve to a registered anchor whose dataset/scope/method/business
        window match, whose version still governs new writes, and whose
        corporate-action cutoff is already known at the replay point of this
        batch (see ``adjustment_anchors.observation_facts``).
        """
        declared = adjustment_anchors.declared_adjustment(declaration)
        direction = derived.get("direction")
        ref = derived.get("anchor_ref")
        method = derived.get("method")
        if direction != "adjusted":
            if ref is not None:
                raise ValueError("SEMANTIC_ADJUSTMENT_ANCHOR_FORBIDDEN:"
                                 + str(direction) + " must not declare anchor_ref")
            if method is not None:
                raise ValueError("SEMANTIC_ADJUSTMENT_METHOD_FORBIDDEN:"
                                 + str(direction) + " must not declare method")
            return None
        if method is None:
            raise ValueError("SEMANTIC_ADJUSTMENT_METHOD_REQUIRED:adjusted needs method=qfq|hfq")
        if not isinstance(ref, dict):
            raise ValueError(adjustment_anchors.CODE_UNREGISTERED
                             + ":adjusted requires a resolvable anchor_ref")
        document = self._anchor_doc()
        facts = adjustment_anchors.observation_facts(internal, declaration)
        record = adjustment_anchors.resolve(
            ref, dataset_id, declaration, document=document,
            instruments=facts["instruments"], subjects=facts["subjects"],
            business_dates=facts["business_dates"])
        # P2-R2: the anchor's basis price must really resolve in the store whose
        # catalog governs this write -- after the anchor identity steps and
        # before the anchor version/history steps, so an unresolvable basis is
        # never hidden behind a version mismatch and never hides one either.
        # P2-R3: a formal write additionally requires the basis to be *verified*
        # (a rule basis is refused: ADJUSTMENT_BASIS_RULE_UNVERIFIED).
        basis_report = self._admit_basis_price(record, replay_point=facts["as_of"],
                                               require_verified=True)
        adjustment_anchors.eligible(record, document=document, as_of=facts["as_of"])
        derived["_admitted_anchor"] = {
            "anchor_id": record["anchor_id"],
            "version": record["version"],
            "digest": record["digest"],
            "method": record["method"],
            "basis_at": record["basis_at"],
            "applicability": copy.deepcopy(record["applicability"]),
            "corporate_action_cutoff": record["corporate_action_cutoff"],
            "replay_point": facts["as_of"],
            "replay_point_basis": facts["as_of_basis"],
            "declared_method": declared.get("method"),
            "basis_price": {
                "state": basis_report.get("state"),
                "verified": basis_report.get("verified"),
                "code": basis_report.get("code"),
                "product_id": (basis_report.get("basis") or {}).get("product_id"),
                "field_code": (basis_report.get("basis") or {}).get("field_code"),
                "unit_code": (basis_report.get("basis") or {}).get("unit_code"),
                "currency": (basis_report.get("basis") or {}).get("currency"),
                "instrument_id": (basis_report.get("basis") or {}).get("instrument_id"),
                "snapshot_id": (basis_report.get("basis") or {}).get("snapshot_id"),
                "record_id": (basis_report.get("basis") or {}).get("record_id"),
                "record_version": (basis_report.get("basis") or {}).get("record_version"),
                "value": (basis_report.get("basis") or {}).get("value"),
                "observation_start": (basis_report.get("basis") or {}).get("observation_start"),
                "observation_end": (basis_report.get("basis") or {}).get("observation_end"),
                "timezone": (basis_report.get("basis") or {}).get("timezone"),
                "match_precision": (basis_report.get("basis") or {}).get("match_precision"),
                "tolerance_seconds": (basis_report.get("basis") or {}).get("tolerance_seconds"),
                "tolerance_applied": (basis_report.get("basis") or {}).get("tolerance_applied"),
                "history": (basis_report.get("checks") or {}).get("history"),
            },
        }
        return record

    def _record_write_target(self, dataset_id, derived, *, product_id, snapshot_id,
                             origin, reason):
        document = self._write_target_doc()
        if write_targets.latest(document, dataset_id, derived["product_family_id"]) is not None:
            return None
        entry = write_targets.next_entry(
            doc=document, target=derived, origin=origin, product_id=product_id,
            registered_by=self.caller_id or "local", registered_at=_second_now(),
            reason=reason, bound_snapshot_id=snapshot_id)
        write_targets.write_entry(self.root, document, entry)
        self._write_targets_document = None
        return entry

    def resolve_write_target(self, dataset_id, snapshot_id=None):
        """Read-only: is this dataset bound to a formal write target here?"""
        if not isinstance(dataset_id, str) or not dataset_id:
            raise ValueError("WRITE_TARGET_DATASET_REQUIRED")
        try:
            document = self._write_target_doc()
            visible = write_targets.visible_document(
                self.root, document, dataset_id, snapshot_id)
        except (OSError, ValueError) as exc:
            return {"format_version": write_targets.FORMAT_VERSION,
                    "status": write_targets.STATUS_QUERY_FAILED,
                    "dataset_id": dataset_id, "snapshot_id": snapshot_id,
                    "detail": str(exc), "targets": [], "unbound_families": []}
        families = self._product_records(dataset_id)
        conflicts, targets = [], []
        for family, entry in sorted(visible.items()):
            records = [record for record in families.get(family, [])
                       if record.get("product_id") == entry.get("product_id")]
            digest = (entry.get("definition_ref") or {}).get("digest")
            matched = [record for record in records
                       if (record.get("definition_ref") or {}).get("digest") == digest]
            if not records:
                conflicts.append({"product_family_id": family,
                                  "code": "WRITE_TARGET_PRODUCT_MISSING",
                                  "product_id": entry.get("product_id")})
                continue
            if not matched:
                conflicts.append({"product_family_id": family,
                                  "code": "WRITE_TARGET_DEFINITION_MISSING",
                                  "product_id": entry.get("product_id"),
                                  "definition_digest": digest})
                continue
            targets.append({key: copy.deepcopy(entry.get(key)) for key in
                            ("dataset_id", "product_family_id", "product_id",
                             "definition_ref", "direction", "method", "anchor_ref", "units",
                             "unit_code", "origin", "sequence", "registered_at",
                             "registered_by", "bound_snapshot_id", "reason")})
        unbound = sorted(family for family in families if family not in visible)
        if conflicts:
            status = write_targets.STATUS_CONFLICT
        elif unbound:
            status = write_targets.STATUS_FAMILY_WITHOUT_TARGET
        elif targets:
            status = write_targets.STATUS_BOUND
        else:
            status = write_targets.STATUS_NEVER_REGISTERED
        return {
            "format_version": write_targets.FORMAT_VERSION,
            "status": status,
            "dataset_id": dataset_id,
            "snapshot_id": snapshot_id,
            "targets": targets,
            "unbound_families": unbound,
            "unbound_candidates": {family: sorted({record.get("product_id")
                                                   for record in families[family]
                                                   if record.get("product_id")})
                                   for family in unbound},
            "conflicts": conflicts,
            "note": ("binding is a declared relation; a family without a binding is "
                     "never resolved by resemblance"),
        }

    def register_write_target(self, dataset_id, product_id, definition_ref=None,
                              reason="explicit registration", snapshot_id=None):
        """Explicit first-bind / rebind of one formal write target."""
        self.require_permission("register")
        self.require_permission("publish")
        if getattr(self.engine, "read_only", False):
            raise ValueError("WRITE_TARGET_READ_ONLY_STORE")
        return self._register_write_target_body(
            dataset_id, product_id, definition_ref=definition_ref, reason=reason,
            snapshot_id=snapshot_id)

    def _register_write_target_body(self, dataset_id, product_id, definition_ref=None,
                                    reason="explicit registration", snapshot_id=None):
        if not isinstance(dataset_id, str) or not dataset_id:
            raise ValueError("WRITE_TARGET_DATASET_REQUIRED")
        if not isinstance(product_id, str) or not product_id:
            raise ValueError("WRITE_TARGET_PRODUCT_REQUIRED")
        families = self._product_records(dataset_id)
        records = [record for family in families for record in families[family]
                   if record.get("product_id") == product_id]
        if not records:
            raise ValueError("WRITE_TARGET_PRODUCT_NOT_REGISTERED:" + product_id)
        if definition_ref is not None:
            digest = (definition_ref or {}).get("digest")
            matched = [record for record in records
                       if (record.get("definition_ref") or {}).get("digest") == digest
                       and record.get("definition_ref") == definition_ref]
            if not matched:
                raise ValueError("WRITE_TARGET_DEFINITION_NOT_REGISTERED:" + str(digest))
            record = matched[0]
        else:
            record = max(records, key=lambda item: int(item.get("definition_sequence") or 0))
        declaration = record.get("declaration") or {}
        derived = write_targets.target_of(
            dataset_id=dataset_id, logical_domain=record.get("logical_domain"),
            subject=record.get("subject"), declaration=declaration,
            definition_ref=record.get("definition_ref"))
        if derived["product_family_id"] != record.get("product_family_id"):
            raise ValueError("WRITE_TARGET_FAMILY_DERIVATION_MISMATCH")
        head = self.engine.head()
        bound_snapshot = snapshot_id if isinstance(snapshot_id, str) else (
            head["snapshot_id"] if head else None)
        document = self._write_target_doc()
        prior = write_targets.latest(document, dataset_id, derived["product_family_id"])
        entry = write_targets.next_entry(
            doc=document, target=derived, origin="registered", product_id=product_id,
            registered_by=self.caller_id or "local", registered_at=_second_now(),
            reason=str(reason), bound_snapshot_id=bound_snapshot)
        write_targets.write_entry(self.root, document, entry)
        self._write_targets_document = None
        return {
            "format_version": write_targets.FORMAT_VERSION,
            "state": "registered",
            "dataset_id": dataset_id,
            "product_family_id": entry["product_family_id"],
            "product_id": product_id,
            "definition_ref": copy.deepcopy(entry["definition_ref"]),
            "direction": entry["direction"],
            "method": entry.get("method"),
            "anchor_ref": copy.deepcopy(entry["anchor_ref"]),
            "units": copy.deepcopy(entry["units"]),
            "sequence": entry["sequence"],
            "bound_snapshot_id": entry["bound_snapshot_id"],
            "superseded": (None if prior is None else
                           {"sequence": prior.get("sequence"),
                            "product_id": prior.get("product_id"),
                            "definition_ref": copy.deepcopy(prior.get("definition_ref"))}),
        }

    # ---------------------------------------------------- adjustment anchors (P2)
    # An anchor is a formal, versioned catalog object.  It is created only by the
    # explicit registration operation below: a submission that mentions a digest
    # never creates one, and an old version file is never rewritten.
    def resolve_adjustment_anchor(self, dataset_id, *, anchor_ref=None, anchor_id=None,
                                  version=None):
        """Read-only: report how one anchor reference resolves here."""
        if not isinstance(dataset_id, str) or not dataset_id:
            raise ValueError("ADJUSTMENT_ANCHOR_DATASET_REQUIRED")
        if anchor_ref is None and anchor_id is None:
            raise ValueError("REQUEST_INVALID:anchor_ref or anchor_id is required")
        if anchor_ref is not None and anchor_id is not None:
            raise ValueError("REQUEST_INVALID:send anchor_ref or anchor_id, not both")
        report = adjustment_anchors.inspect(
            anchor_ref, dataset_id, document=self._anchor_doc(),
            anchor_id=anchor_id, version=version,
            basis_catalog=self._basis_catalog(), units=self.unit_registry)
        report["dataset_id"] = dataset_id
        return report

    def register_adjustment_anchor(self, dataset_id, anchor_id, *, method, basis_at,
                                   basis_price_ref, applicability,
                                   corporate_action_cutoff, instrument_scope=None,
                                   status=adjustment_anchors.STATUS_ACTIVE,
                                   supersedes=None, reason="explicit registration"):
        """Explicit append-only registration of one adjustment-anchor version."""
        self.require_permission("register")
        self.require_permission("publish")
        if getattr(self.engine, "read_only", False):
            raise ValueError(adjustment_anchors.CODE_READ_ONLY)
        return self._register_adjustment_anchor_body(
            dataset_id, anchor_id, method=method, basis_at=basis_at,
            basis_price_ref=basis_price_ref, applicability=applicability,
            corporate_action_cutoff=corporate_action_cutoff,
            instrument_scope=instrument_scope, status=status,
            supersedes=supersedes, reason=reason)

    def _register_adjustment_anchor_body(self, dataset_id, anchor_id, *, method, basis_at,
                                         basis_price_ref, applicability,
                                         corporate_action_cutoff, instrument_scope=None,
                                         status=adjustment_anchors.STATUS_ACTIVE,
                                         supersedes=None, reason="explicit registration"):
        # The read-only guard lives in the public operation, exactly like
        # ``_register_write_target_body``: a target-volume service reads with a
        # read-only engine but its catalog (anchors / write targets) is the
        # authoritative writable one, and ``WFDVolumeService`` re-verifies the
        # volume as writable and the caller's register+publish roles before
        # reaching this body.  A read-only data-only store therefore still
        # refuses registration through ``register_adjustment_anchor``.
        # P2-R2 registration-time validation: an anchor whose basis price cannot
        # be resolved in this store's catalog is refused here instead of being
        # registered and only rejected at the first write.  A ``rule`` basis has
        # no catalog object and is reported as such, never as resolved.
        normalised = adjustment_anchors.normalize_basis_price_ref(basis_price_ref)
        self._admit_basis_price({"anchor_id": anchor_id, "dataset_id": dataset_id,
                                 "basis_at": basis_at, "basis_price_ref": normalised,
                                 "instrument_scope": instrument_scope,
                                 "corporate_action_cutoff": corporate_action_cutoff},
                                replay_point=None)
        record = adjustment_anchors.register(
            self.root, dataset_id=dataset_id, anchor_id=anchor_id, method=method,
            basis_at=basis_at, basis_price_ref=normalised,
            applicability=applicability, corporate_action_cutoff=corporate_action_cutoff,
            instrument_scope=instrument_scope, status=status,
            registered_by=self.caller_id or "local", registered_at=_second_now(),
            supersedes=supersedes)
        self._adjustment_anchors_document = None
        return {
            "format_version": adjustment_anchors.FORMAT_VERSION,
            "state": "registered",
            "anchor_id": record["anchor_id"],
            "dataset_id": record["dataset_id"],
            "version": record["version"],
            "digest": record["digest"],
            "method": record["method"],
            "basis_at": record["basis_at"],
            "basis_price_ref": copy.deepcopy(record["basis_price_ref"]),
            "applicability": copy.deepcopy(record["applicability"]),
            "corporate_action_cutoff": record["corporate_action_cutoff"],
            "instrument_scope": copy.deepcopy(record["instrument_scope"]),
            "status": record["status"],
            "supersedes": copy.deepcopy(record["supersedes"]),
            "reason": str(reason),
            "catalog": adjustment_anchors.RELATIVE_DIR,
        }

    def _bind_published_targets(self, identity, results, snapshot_id):
        """First formal publication into an empty family anchors the target."""
        dataset_id = identity["dataset_id"]
        for item in results:
            if item.get("registration_state") != "registered":
                continue
            if item.get("publication_state") != "published_formal":
                continue
            product_id = item.get("product_id")
            digest = ((item.get("definition_ref") or {}).get("digest"))
            record = None
            for family, records in self._product_records(dataset_id).items():
                for candidate in records:
                    if (candidate.get("product_id") == product_id
                            and (candidate.get("definition_ref") or {}).get("digest") == digest):
                        record = candidate
                        break
                if record is not None:
                    break
            if record is None:
                continue
            derived = write_targets.target_of(
                dataset_id=dataset_id, logical_domain=record.get("logical_domain"),
                subject=record.get("subject"),
                declaration=record.get("declaration") or {},
                definition_ref=record.get("definition_ref") or {})
            try:
                self._record_write_target(
                    dataset_id, derived, product_id=product_id, snapshot_id=snapshot_id,
                    origin="first_publication",
                    reason="first formal publication into a family holding no product records")
            except (OSError, ValueError) as exc:
                item.setdefault("write_target_errors", []).append(
                    _issue("WRITE_TARGET_BIND_FAILED", str(exc)))

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
        results = WFDDataOnlyService._publication_results(results)
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
        duplicate_policy = any("row_results" in item for item in results)
        results = self._publication_results(results)
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
            # read_snapshot above has already verified this exact commit,
            # manifest and every declared file. Historical commits add no
            # authority to this fixed publication.
            "valid_commit": snapshot.get("snapshot_id") == sid,
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
            entries = [entry for entry in bindings if entry.get("output_key") == item["output_key"]
                       and entry.get("product_id") == item.get("product_id")]
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
                expected = item.get("records", [])
                if (entry.get("input_mode") in {"partial_observation", "explicit_increment"}
                        and entry.get("payload_kind") in {"scalar_rows", "tabular_rows"}
                        and entry.get("source_bundle", {}).get("_wfd_data_only") is True
                        and 0 < len(expected) <= FIXED_PAGE_SELECTION_LIMIT
                        and all(record.get("withdrawn") is False for record in expected)
                        and not current_only_business(product["declaration"])
                        and not str(product["declaration"].get("semantic_code", "")).startswith("wfd.foundation.calendar.")
                        and not self._page_calendar_required(product)
                        and not product.get("contracts", {}).get("read", {}).get("dependencies", [])):
                    selection = self._page_selection([
                        {"record_id": record["record_id"], "record_version": record["record_version"]}
                        for record in expected])
                    parts, _, selected = self._page_parts(snapshot, product["product_id"], selection)
                    self._page_verify_files(parts)
                    materialized = selected_rows_page(
                        parts, selected, after_position=0, row_limit=len(selection),
                        max_row_bytes=FIXED_PAGE_MAX_BYTES, identities_only=True)
                    actual = {row["record_id"]: row["record_version"] for row in materialized}
                else:
                    read = self._read(product["product_id"], snapshot_id=sid, include_history=True)
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
        if duplicate_policy:
            record["duplicate_policy"] = "skip_identical_append"
        self.engine._write_immutable(formal_path, canonical(record))
        return formal_path, checks, "published_formal"

    def _prepare_bulk_product(self, document, header, prior_product=None):
        from . import indexed_bulk as bulk

        self.require_permission("submit")
        self.require_permission("publish")
        identity = self._validate_document(document)
        dataset_id = identity["dataset_id"]
        internal = self._internal_output(document["outputs"][0])
        declaration, definition_ref = self._definition(internal, dataset_id)
        bulk.adapter(header["protocol_version"]).validate_definition(header, declaration)
        target, first_bind = self._admit_write_target(internal, dataset_id, declaration, definition_ref)
        issues = validate_units(declaration, self.unit_registry)
        if issues:
            raise ValueError(issues[0]["code"] + ":" + issues[0]["message"])
        extension = {"_wfd_data_only": True, "read_dependencies": []}
        product, _ = self._register(internal, dataset_id, extension)
        _reject_unresolved_refs(product.get("declaration") or {})
        return self._bind_contract(product, extension, prior_product), target, first_bind

    def _submit_data(self, doc):
        self.require_permission("submit")
        # A structurally rejected document still has a recoverable request
        # identity when its three identity components are valid and trusted.
        # Check the original fingerprint first: rejection must never overwrite
        # a published request, nor permit changed contents under the same ID.
        candidate = doc.get("request_identity") if isinstance(doc, dict) else None
        identifiable = (isinstance(candidate, dict)
                        and all(isinstance(candidate.get(name), str)
                                and 0 < len(candidate[name]) <= 256
                                for name in ("dataset_id", "trusted_actor_namespace", "request_id"))
                        and candidate.get("trusted_actor_namespace") in self.trusted_actor_namespaces)
        key = self.engine._request_key(doc) if identifiable else None
        fingerprint = sha(canonical(doc)) if identifiable else None
        if key is not None:
            prior = self._load_status(key)
            if prior is not None:
                if prior.get("input_fingerprint") != fingerprint:
                    return {"protocol_version": DATA_ONLY_PROTOCOL, "profile": DATA_ONLY_PROFILE,
                            "status": "rejected", "state": "rejected", "request_key": key,
                            "errors": [_issue("REQUEST_ID_CONFLICT", "Original request contents changed")],
                            "output_results": [], "idempotent_replay": False,
                            "production_publishable": False}
                if self._terminal(prior.get("state")):
                    return self._public_status(prior, replay=True)
        try:
            identity = self._validate_document(doc)
        except ValueError as exc:
            code = str(exc).split(":", 1)[0] or "REQUEST_INVALID"
            if key is not None:
                record = {"format_version": DATA_ONLY_STATUS_FORMAT, "profile": DATA_ONLY_PROFILE,
                          "request_key": key, "request_identity": copy.deepcopy(candidate),
                          "input_fingerprint": fingerprint, "state": "rejected",
                          "snapshot_id": None, "output_results": [],
                          "formal_publication_ref": None, "errors": [_issue(code, str(exc))]}
                self._save_status(record)
                return {**self._public_status(record), "status": "rejected"}
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
        # 新发布/计算取数边界（C7）：submit() 已持 writer_lock，与暂停更新同锁。
        # 幂等重放（含未知结果原号恢复）在上面的 prior 分支返回，不因新限制创建新号。
        from . import usage_suspension
        ticket = usage_suspension.enforce_submit(self.root, doc)
        intent = self._load_intent(key)
        if intent is not None and (not self._intent_matches(intent,key,identity)
                                   or intent.get("input_fingerprint") != fingerprint):
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
        plan = self._load_plan(key)
        if plan and plan.get("duplicate_policy") == "skip_identical_append":
            if plan.get("input_fingerprint") != fingerprint or plan.get("request_identity") != identity:
                raise ValueError("REQUEST_ID_CONFLICT")
            if plan.get("no_publication_state"):
                return self._finish_no_publication_plan(plan, replay=True)
            if plan.get("prepared_document"):
                return self._publish_prepared_data(key, identity, fingerprint,
                                                   copy.deepcopy(plan["output_results"]),
                                                   copy.deepcopy(plan["prepared_document"]))
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
        from .indexed_bulk import indexed_products as load_bulk_products
        indexed_products = load_bulk_products(self.root, head)
        normalized_outputs = []
        bindings, row_versions, resolved = {}, {}, {}
        results, batch_keys, batch_bar_intervals = [], {}, {}
        groups = doc.get("consistency_groups") or {}
        dedupe = doc.get("duplicate_policy") == "skip_identical_append"
        duplicate_prepared = []
        for item in doc["outputs"]:
            internal = self._internal_output(item)
            outcome = {"output_key": item["output_key"], "registration_state": "not_registered",
                       "publication_state": "not_published"}
            try:
                declaration = self._resolved_declaration(internal, identity["dataset_id"])
                if current_only_business(declaration):
                    context = declaration.get("semantic_context") or {}
                    if (internal["payload"].get("kind") != "tabular_rows"
                            or internal["subject"].get("kind") not in {"instrument", "listing"}
                            or context.get("content_nature") != "observed_fact"
                            or (context.get("time") or {}).get("frequency") not in {"day", "minute"}):
                        raise ValueError("CURRENT_ONLY_BUSINESS_SCOPE_INVALID:explicit basic daily/minute bars only")
                declaration, definition_ref = self._definition(
                    internal, identity["dataset_id"])
                write_target, first_bind = self._admit_write_target(
                    internal, identity["dataset_id"], declaration, definition_ref)
                outcome["write_target"] = {
                    "product_family_id": write_target["product_family_id"],
                    "direction": write_target["direction"],
                    "method": write_target.get("method"),
                    "binding": "first_publication" if first_bind else "bound",
                }
                if indexed_products:
                    bound = write_targets.latest(self._write_target_doc(), identity["dataset_id"],
                                                 write_target["product_family_id"])
                    candidate_pid = (bound or {}).get("product_id") or "p_" + sha(canonical(
                        [write_target["product_family_id"], "stable_product"]))[:24]
                    if candidate_pid in indexed_products:
                        raise ValueError("BULK_PARTITION_WRITE_REQUIRED")
                if write_target.get("_admitted_anchor") is not None:
                    # P2: report which registered anchor version admitted the write
                    # and which replay point the history check used.
                    outcome["adjustment_anchor"] = copy.deepcopy(
                        write_target["_admitted_anchor"])
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
                if not dedupe and keys & batch_keys.get(product["product_id"], set()):
                    raise ValueError("DUPLICATE_BATCH_BUSINESS_KEY")
                payload_issues = validate_payload(internal, product["declaration"])
                payload_issues.extend(validate_units(product["declaration"], self.unit_registry))
                if payload_issues:
                    first = payload_issues[0]
                    raise ValueError(first["code"] + ":" + first["message"])
                if dedupe:
                    outcome["contract_ref"] = copy.deepcopy(product.get("contract_ref"))
                    outcome["contract_refs"] = copy.deepcopy(product.get("contract_refs"))
                    outcome["contract_bundle_ref"] = copy.deepcopy(product.get("contract_bundle_ref"))
                    duplicate_prepared.append((internal, product, extension, outcome))
                    results.append(outcome)
                    continue
                bar_intervals = set()
                if current_only_business(product["declaration"]):
                    bar_intervals = self._check_current_bar_keys(internal, product, [], "business_key")
                    if bar_intervals & batch_bar_intervals.get(product["product_id"], set()):
                        raise ValueError("CURRENT_ONLY_BUSINESS_KEY_CONFLICT:one key per interval across batch outputs")
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
                batch_bar_intervals.setdefault(product["product_id"], set()).update(bar_intervals)
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
        if dedupe:
            self._classify_duplicate_rows(duplicate_prepared, head_id)
            new_records = {}
            for internal, product, extension, outcome in duplicate_prepared:
                outcome["inserted_records"] = []
                if not internal["payload"]["rows"]:
                    outcome["publication_state"] = "unchanged" if any(
                        row["state"] == "duplicate_skipped" for row in outcome["row_results"]) else "not_published"
                    continue
                try:
                    engine_out, versions = self._prepare_versions(
                        internal, product, extension, head_id, fingerprint, {"_wfd_data_only": True})
                    engine_out.update(definition_mode="create", definition_ref=None,
                                      new_definition_declaration=product["declaration"])
                    normalized_outputs.append(engine_out)
                    resolved[internal["output_key"]] = product["product_id"]
                    bindings[internal["output_key"]] = {"product": product,
                        "source_role_mode": "data_only", "source_admission": {}}
                    row_versions[internal["output_key"]] = versions
                    outcome["inserted_records"] = [{"record_id": value["logical_key"],
                        "record_version": value["revision_id"], "withdrawn": value["withdrawn"]}
                        for value in versions.values()]
                    for record in outcome["inserted_records"]:
                        new_records[(product["product_id"], record["record_id"])] = record
                except (ValueError, PermissionError) as exc:
                    outcome["errors"] = [_issue(str(exc).split(":")[0], str(exc))]
            grouped_members = {member for members in groups.values() for member in members}
            for outcome in results:
                accepted = {}
                for row in outcome.get("row_results", []):
                    if row["state"] == "pending_publication":
                        record = new_records.get((outcome["product_id"], row["business_key"]))
                        if record:
                            row.update(copy.deepcopy(record))
                    if row.get("record_id"):
                        accepted[(row["record_id"], row["record_version"])] = {
                            name: row[name] for name in ("record_id", "record_version", "withdrawn")}
                outcome["records"] = list(accepted.values())
                if outcome["output_key"] in grouped_members and any(
                        row["state"] == "conflict_pending" for row in outcome.get("row_results", [])):
                    outcome.setdefault("errors", []).append(_issue(
                        "CONSISTENCY_GROUP_FAILED", "An explicitly grouped output has pending row conflicts"))
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
            if dedupe:
                for item in results:
                    if item["output_key"] in failed:
                        item["inserted_records"] = []
                    for row in item.get("row_results", []):
                        if row["state"] == "pending_publication" and row.get("publication_output_key") in failed:
                            row.update(state="conflict_pending", reason="CONSISTENCY_GROUP_FAILED",
                                       difference_fields=[], existing_records=[])
                            for name in ("record_id", "record_version", "withdrawn"):
                                row.pop(name, None)
                    accepted = {(row["record_id"], row["record_version"]):
                                {name: row[name] for name in ("record_id", "record_version", "withdrawn")}
                                for row in item.get("row_results", []) if row.get("record_id")}
                    item["records"] = list(accepted.values())
        if not normalized_outputs:
            if dedupe:
                state = "conflicts_pending" if any(row.get("state") == "conflict_pending"
                    for item in results for row in item.get("row_results", [])) else (
                    "rejected" if failed else "unchanged")
                plan = self._save_plan(key, identity, fingerprint, head_id, results,
                                       no_publication_state=state)
                return self._finish_no_publication_plan(plan)
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
        if dedupe:
            source_bundle["_wfd_duplicate_policy"] = "skip_identical_append"
        for _output in normalized_outputs:
            _output.pop("evidence_refs", None)
        internal_doc = {
            "protocol_version": "wfd.data-only-write/0.1-candidate",
            "request_identity": {"dataset_id": identity["dataset_id"],
                                 "trusted_actor_namespace": identity["trusted_actor_namespace"],
                                 "request_id": identity["request_id"],
                                 "submission_digest": identity["submission_digest"]},
            "intent": "submit", "producer_namespace": doc["producer_namespace"],
            "expected_parent_snapshot_id": head_id,
            "outputs": normalized_outputs,
            "wfd_publish_context": source_bundle,
        }
        self._save_plan(key, identity, fingerprint, head_id, results,
                        prepared_document=internal_doc if dedupe else None)
        # Only the fixed ID is needed after preparation. The engine verifies
        # its authoritative HEAD again before publishing under the writer lock.
        head = None
        return self._publish_prepared_data(key, identity, fingerprint, results, internal_doc)

    def _finish_no_publication_plan(self, plan, replay=False):
        record = {"format_version": DATA_ONLY_STATUS_FORMAT, "profile": DATA_ONLY_PROFILE,
                  "request_key": plan["request_key"], "request_identity": plan["request_identity"],
                  "input_fingerprint": plan["input_fingerprint"], "state": plan["no_publication_state"],
                  "snapshot_id": plan["parent_snapshot_id"], "output_results": copy.deepcopy(plan["output_results"]),
                  "formal_publication_ref": None, "errors": [], "idempotent_replay": replay}
        self._save_status(record)
        return self._public_status(record, replay=replay)

    def _publish_prepared_data(self, key, identity, fingerprint, results, internal_doc):
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
                self._bind_published_targets(identity, results, receipt.get("snapshot_id"))
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
        if perspective != "snapshot_contents" or at is not None or include_history:
            snapshot = self.engine._valid_snapshot_exact(snapshot_id, verify_payloads=False)
            for entry in snapshot.get("files", []):
                if product_id is not None and entry.get("product_id") != product_id:
                    continue
                binding = ((entry.get("source_bundle") or {}).get("_wfd_product_bindings") or {}).get(entry.get("output_key")) or {}
                if current_only_business((binding.get("product") or {}).get("declaration")):
                    raise ValueError("CURRENT_ONLY_BUSINESS_HISTORY_UNSUPPORTED:technical fixed reads do not expose history")
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

    @staticmethod
    def _page_selection(record_refs):
        if not isinstance(record_refs, list) or not 1 <= len(record_refs) <= FIXED_PAGE_SELECTION_LIMIT:
            raise ValueError("PAGE_SELECTION_INVALID")
        seen, selection = set(), []
        for item in record_refs:
            if not isinstance(item, dict) or set(item) != {"record_id", "record_version"}:
                raise ValueError("PAGE_SELECTION_INVALID")
            if any(not isinstance(item[key], str) or not item[key] or "\x00" in item[key]
                   for key in ("record_id", "record_version")):
                raise ValueError("PAGE_SELECTION_INVALID")
            if item["record_id"] in seen:
                raise ValueError("PAGE_SELECTION_DUPLICATE")
            seen.add(item["record_id"])
            selection.append(dict(item))
        try:
            return sorted(selection, key=lambda item: (item["record_id"].encode("utf-8"),
                                                        item["record_version"].encode("utf-8")))
        except UnicodeError as exc:
            raise ValueError("PAGE_SELECTION_INVALID") from exc

    @staticmethod
    def _page_calendar_required(product):
        declaration = product.get("declaration") or {}
        axes = [(declaration.get("semantic_context") or {}).get("time") or {}]
        axes.extend((context or {}).get("time") or {}
                    for context in (declaration.get("field_semantic_context") or {}).values())
        dependencies = (product.get("contracts") or {}).get("read", {}).get("dependencies", [])
        return (any(axis.get("calendar_ref") is not None or axis.get("accounting_calendar_ref") is not None
                    or axis.get("period_type") in {"trading", "accounting"} for axis in axes)
                or any(dep.get("role") in {"calendar_ref", "accounting_calendar_ref"} for dep in dependencies)
                or bool(product_calendar.field_calendar_rules(declaration)))

    def _page_parts(self, snapshot, product_id, selection=None):
        from .indexed_bulk import indexed_products
        if product_id in indexed_products(self.root, snapshot):
            raise ValueError("BULK_PARTITION_LOCATOR_REQUIRED")
        # None is the private complete-view path, never the public selected-ref
        # validator and never a larger external record_refs allowance.
        wanted = (None if selection is None else
                  {item["record_id"]: item["record_version"] for item in selection})
        versions, superseded, parts, products = {}, set(), [], {}
        verified_bindings = {}
        metadata = self._select_metadata(snapshot, product_id, "snapshot_contents", None)
        for entry in snapshot["files"]:
            if entry["product_id"] != product_id:
                continue
            source = entry.get("source_bundle") or {}
            if entry.get("payload_kind") not in {"scalar_rows", "tabular_rows"} or source.get("_wfd_data_only") is not True:
                raise ValueError("PAGED_READ_PRODUCT_UNSUPPORTED")
            binding = (source.get("_wfd_product_bindings") or {}).get(entry["output_key"])
            if not binding or binding.get("product", {}).get("product_id") != product_id:
                raise ValueError("PRODUCT_METADATA_NOT_AVAILABLE")
            binding_key = canonical(binding)
            if binding_key in verified_bindings:
                self._page_verify_cached_contracts(binding["product"])
                product = verified_bindings[binding_key]
            else:
                product = copy.deepcopy(binding["product"])
                self._verify_binding(product)
                self._assert_selected_declarations({"products": [product]})
                if str((product.get("declaration") or {}).get("semantic_code", "")).startswith("wfd.foundation.calendar."):
                    raise ValueError("PAGED_READ_PRODUCT_UNSUPPORTED")
                if self._page_calendar_required(product):
                    raise ValueError("PAGED_READ_CALENDAR_UNSUPPORTED")
                dependencies = product.get("contracts", {}).get("read", {}).get("dependencies", [])
                if dependencies:
                    # R1 only creates calendar dependencies. Other dependency types
                    # need a bounded closure reader, not a hidden full-read fallback.
                    raise ValueError("PAGED_READ_DEPENDENCY_UNSUPPORTED")
                self._check_dependencies(dependencies, product["dataset_id"])
                if metadata:
                    product["coverage"] = copy.deepcopy(metadata.get("coverage"))
                    product["coverage_ref"] = metadata.get("coverage_ref")
                    product["coverage_predecessor_ref"] = metadata.get("predecessor_ref")
                    product["source_admission"] = copy.deepcopy(metadata.get("source_admission"))
                if wanted is None:
                    # Full-product pages preserve the old full public product body,
                    # including its explicit empty admission projection. Keep the
                    # previously frozen selected-page DTO byte-compatible.
                    product["source_admission"] = self._merge_source_admissions(
                        (metadata or {}).get("source_admission"), binding.get("source_admission"))
                # This endpoint never computes or claims the old whole-product row digest.
                product.pop("content_digest", None)
                verified_bindings[binding_key] = product
            products[(product_id, (product.get("contract_ref") or {}).get("digest", "legacy"))] = product
            index = len(parts)
            parts.append({**entry, "product": product})
            row_versions = (source.get("_wfd_row_versions") or {}).get(entry["output_key"])
            if not isinstance(row_versions, dict) or len(row_versions) != entry.get("row_count"):
                raise ValueError("PAGE_VERSION_METADATA_UNAVAILABLE")
            for physical_key, version in row_versions.items():
                if (not isinstance(physical_key, str) or not isinstance(version, dict)
                        or not isinstance(version.get("logical_key"), str)
                        or not isinstance(version.get("revision_id"), str)
                        or type(version.get("withdrawn")) is not bool
                        or (version.get("supersedes") is not None
                            and not isinstance(version["supersedes"], str))):
                    raise ValueError("PAGE_VERSION_METADATA_INVALID")
                if wanted is None:
                    # Auto-derived full views do not pass through the external
                    # selected-ref validator. Validate every metadata identity,
                    # even a superseded/withdrawn one outside this page, without
                    # changing the old selected domain or its 1..5000 guard.
                    identities = [physical_key, version["logical_key"], version["revision_id"]]
                    if version.get("supersedes") is not None:
                        identities.append(version["supersedes"])
                    for value in identities:
                        if not value or "\x00" in value:
                            raise ValueError("PAGE_VERSION_METADATA_INVALID")
                        try:
                            value.encode("utf-8")
                        except UnicodeError as exc:
                            raise ValueError("PAGE_VERSION_METADATA_INVALID") from exc
                if version.get("supersedes") is not None:
                    superseded.add(version["supersedes"])
                if wanted is None or version["logical_key"] in wanted:
                    versions.setdefault(version["logical_key"], []).append({
                        "part_index": index, "physical_key": physical_key, "revision": version})
        if not parts:
            raise ValueError("PAGE_PRODUCT_NOT_FOUND")
        if len({part["product"]["dataset_id"] for part in parts}) != 1:
            raise ValueError("PAGE_DATASET_MISMATCH")
        if selection is None:
            selection = []
            for logical_key, items in versions.items():
                leaves = [item for item in items if item["revision"]["revision_id"] not in superseded]
                if len(leaves) != 1:
                    # Validate the whole view before its first page, including
                    # a fork whose key would otherwise be on a later page.
                    raise ValueError("PAGE_VIEW_BRANCH_CONFLICT:" + logical_key)
                if not leaves[0]["revision"]["withdrawn"]:
                    selection.append({"record_id": logical_key,
                                      "record_version": leaves[0]["revision"]["revision_id"]})
            try:
                selection.sort(key=lambda item: (item["record_id"].encode("utf-8"),
                                                  item["record_version"].encode("utf-8")))
            except UnicodeError as exc:
                raise ValueError("PAGE_VERSION_METADATA_INVALID") from exc
        selected = []
        for position, ref in enumerate(selection, 1):
            leaves = [item for item in versions.get(ref["record_id"], [])
                      if item["revision"]["revision_id"] not in superseded]
            if (len(leaves) != 1 or leaves[0]["revision"]["withdrawn"]
                    or leaves[0]["revision"]["revision_id"] != ref["record_version"]):
                raise ValueError("PAGE_RECORD_NOT_VISIBLE:" + ref["record_id"])
            selected.append({**leaves[0], **ref, "position": position})
        return parts, products, selected

    def _page_verify_cached_contracts(self, product):
        """Identical inline bindings reuse decisions; contract bytes are never cached."""
        for role in ("semantic", "read_layout", "algorithm_dependency", "update_release"):
            ref = (product.get("contract_refs") or {}).get(role)
            if ref is None:
                continue  # Only a previously fully verified binding reaches this helper.
            digest = ref["digest"].removeprefix("sha256:")
            path = self.root / f"catalog/product_service/contracts/{role}/{digest}.json"
            if not path.is_file():
                raise ValueError("CONTRACT_REF_NOT_FOUND:" + role)
            if sha(path.read_bytes()) != digest:
                raise ValueError("CONTRACT_FILE_DIGEST_MISMATCH:" + role)
        bundle = product.get("contract_bundle_ref")
        if bundle:
            digest = bundle["digest"].removeprefix("sha256:")
            path = self.root / f"catalog/product_service/contract_bundles/{digest}.json"
            if not path.is_file() or sha(path.read_bytes()) != digest:
                raise ValueError("CONTRACT_BUNDLE_REF_NOT_FOUND")

    def _page_verify_files(self, parts):
        root = self.root.resolve()
        for part in parts:
            relative = Path(part["file_relpath"])
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("PAGE_ARTIFACT_PATH_INVALID")
            path = (root / relative).resolve(strict=True)
            if not path.is_relative_to(root) or not path.is_file():
                raise ValueError("PAGE_ARTIFACT_PATH_INVALID")
            digest = hashlib.sha256()
            before = path.stat()
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1_048_576), b""):
                    digest.update(block)
            if digest.hexdigest() != str(part["file_sha256"]).removeprefix("sha256:"):
                raise ValueError("CHECKSUM_MISMATCH")
            part["path"] = path
            part["file_stat"] = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)

    def _page_validate_request(self, product_id, snapshot_id, page_size, max_page_bytes):
        self.require_permission("read")
        if not isinstance(snapshot_id, str) or not re.fullmatch(r"s_[0-9a-f]{24}", snapshot_id):
            raise ValueError("PAGE_SNAPSHOT_INVALID")
        if not isinstance(product_id, str) or not re.fullmatch(r"p_[0-9a-f]{24}", product_id):
            raise ValueError("PAGE_PRODUCT_INVALID")
        if type(page_size) is not int or not 1 <= page_size <= FIXED_PAGE_MAX_SIZE:
            raise ValueError("PAGE_SIZE_INVALID")
        if type(max_page_bytes) is not int or not 1 <= max_page_bytes <= FIXED_PAGE_MAX_BYTES:
            raise ValueError("PAGE_BYTES_INVALID")

    def _prepare_versions(self, out, product, extension, head_id, fingerprint, source=None, **options):
        """Append collision checks need identities, not all historical business values."""
        if (head_id and out.get("input_mode") in {"partial_observation", "explicit_increment"}
                and out.get("payload", {}).get("kind") in {"scalar_rows", "tabular_rows"}
                and extension.get("_wfd_data_only") is True
                and not current_only_business(product["declaration"])
                and not str(product["declaration"].get("semantic_code", "")).startswith("wfd.foundation.calendar.")
                and not self._page_calendar_required(product)
                and not product.get("contracts", {}).get("read", {}).get("dependencies", [])):
            snapshot = self.engine._valid_snapshot_exact(head_id, verify_payloads=False)
            wanted = {row["business_key"] for row in out["payload"]["rows"]}
            current = []
            for entry in snapshot["files"]:
                if entry["product_id"] != product["product_id"]:
                    continue
                binding = entry.get("source_bundle") or {}
                if binding.get("_wfd_data_only") is not True:
                    raise ValueError("PAGE_VERSION_METADATA_UNAVAILABLE")
                original = (binding.get("_wfd_product_bindings") or {}).get(entry["output_key"], {}).get("product")
                if not isinstance(original, dict) or original.get("product_id") != product["product_id"]:
                    raise ValueError("PRODUCT_METADATA_NOT_AVAILABLE")
                self._verify_binding(original)
                self._assert_selected_declarations({"products": [original]})
                versions = (binding.get("_wfd_row_versions") or {}).get(entry["output_key"])
                if not isinstance(versions, dict) or len(versions) != entry["row_count"]:
                    raise ValueError("PAGE_VERSION_METADATA_UNAVAILABLE")
                for version in versions.values():
                    if (not isinstance(version, dict) or not isinstance(version.get("logical_key"), str)
                            or not isinstance(version.get("revision_id"), str)
                            or type(version.get("withdrawn")) is not bool
                            or version.get("supersedes") is not None and not isinstance(version["supersedes"], str)):
                        raise ValueError("PAGE_VERSION_METADATA_INVALID")
                    if version["logical_key"] in wanted:
                        current.append({"record_ref": {"logical_key": version["logical_key"],
                                                       "revision_id": version["revision_id"]},
                                        "revision": version})
            # Verify every declared file, including unrelated products. Only row
            # decoding is avoided; no checksum, contract or active version is skipped.
            self._page_verify_files([dict(entry) for entry in snapshot["files"]])
            options["_current_rows"] = current
        return super()._prepare_versions(out, product, extension, head_id, fingerprint, source, **options)

    def read_page(self, product_id, *, snapshot_id, record_refs,
                  page_size=FIXED_PAGE_DEFAULT_SIZE, max_page_bytes=FIXED_PAGE_DEFAULT_BYTES,
                  cursor=None, _machine_result_fields=None, _result_budget=None):
        """R1 selected current identities, bounded SQL and an intact public row projection.

        No history/calendar fallback. Catalog/version JSON is still O(N), and
        immutable target files are streamed for SHA verification on every page.
        """
        self._page_validate_request(product_id, snapshot_id, page_size, max_page_bytes)
        selection = self._page_selection(record_refs)
        selection_digest = "sha256:" + sha(canonical(selection))
        query = {"format_version": FIXED_PAGE_FORMAT, "profile": DATA_ONLY_PROFILE,
                 "snapshot_id": snapshot_id, "product_id": product_id,
                 "selection_digest": selection_digest, "page_size": page_size,
                 "max_page_bytes": max_page_bytes, "perspective": "snapshot_contents",
                 "include_history": False}
        snapshot = self.engine._valid_snapshot_exact(snapshot_id, verify_payloads=False)
        return self._read_fixed_page(product_id, snapshot=snapshot, query=query, selection=selection,
                                     cursor=cursor, _machine_result_fields=_machine_result_fields,
                                     _result_budget=_result_budget)

    def _query_batches_supported(self, *, perspective, entries, products):
        """Metadata-only applicability, not permission or integrity acceptance.

        Call only after the query's normal authorization and budget preflight.
        Unsupported reads retain their existing path; runtime batch failures
        must propagate rather than trigger a full-reader retry.
        """
        if perspective != "snapshot_contents" or not entries or not products:
            return False
        if any(entry.get("payload_kind") not in {"scalar_rows", "tabular_rows"}
               or (entry.get("source_bundle") or {}).get("_wfd_data_only") is not True
               for entry in entries):
            return False
        # Fixed current-leaf pages omit withdrawal diagnostics retained by the
        # generic reader. Keep such products on that reader until bounded
        # diagnostic aggregation is implemented.
        for entry in entries:
            versions = ((entry.get("source_bundle") or {}).get("_wfd_row_versions") or {}).get(
                entry.get("output_key"), {})
            if not isinstance(versions, dict) or any(
                    not isinstance(version, dict) or version.get("withdrawn")
                    for version in versions.values()):
                return False
        return all(product.get("payload_kind") in {"scalar_rows", "tabular_rows"}
                   and not str((product.get("declaration") or {}).get("semantic_code", "")).startswith("wfd.foundation.calendar.")
                   and not self._page_calendar_required(product)
                   and not (product.get("contracts") or {}).get("read", {}).get("dependencies", [])
                   for product in products.values())

    def _iter_query_batches(self, product_id, *, snapshot_id,
                            batch_size=FIXED_PAGE_DEFAULT_SIZE,
                            max_batch_bytes=FIXED_PAGE_DEFAULT_BYTES,
                            before_batch=None):
        """Internal current-leaf batches, not generic query order or history.

        Each page retains the existing service admission/integrity checks.
        The consumer must aggregate/project without collecting all raw batches.
        Metadata and repeated immutable-file verification remain O(N).
        """
        cursor, binding = None, None
        while True:
            if before_batch is not None:
                before_batch()
            page = self.read_product_page(
                product_id, snapshot_id=snapshot_id, page_size=batch_size,
                max_page_bytes=max_batch_bytes, cursor=cursor)
            current = (page["snapshot_id"], page["product_id"],
                       page["dataset_id"], page["integrity"]["manifest_digest"],
                       page["integrity"]["view_digest"],
                       page["integrity"]["query_digest"])
            if binding is not None and current != binding:
                raise ValueError("QUERY_BATCH_BINDING_CHANGED")
            binding = current
            yield page
            cursor = page["pagination"]["next_cursor"]
            if cursor is None:
                break

    def read_product_page(self, product_id, *, snapshot_id,
                          page_size=FIXED_PAGE_DEFAULT_SIZE, max_page_bytes=FIXED_PAGE_DEFAULT_BYTES,
                          cursor=None, _machine_result_fields=None, _result_budget=None):
        """Complete current-leaf view; no external record_refs or selected-page limit.

        Version/view metadata remains O(N). Only bounded business row JSON is
        materialized; all target part hashes are still streamed on every page.
        """
        self._page_validate_request(product_id, snapshot_id, page_size, max_page_bytes)
        snapshot = self.engine._valid_snapshot_exact(snapshot_id, verify_payloads=False)
        prepared = self._page_parts(snapshot, product_id)
        selection = [{"record_id": item["record_id"], "record_version": item["record_version"]}
                     for item in prepared[2]]
        query = {"format_version": FIXED_PRODUCT_PAGE_FORMAT, "profile": DATA_ONLY_PROFILE,
                 "read_scope": "full_product", "snapshot_id": snapshot_id, "product_id": product_id,
                 "view_digest": "sha256:" + sha(canonical(selection)), "page_size": page_size,
                 "max_page_bytes": max_page_bytes, "perspective": "snapshot_contents",
                 "include_history": False}
        return self._read_fixed_page(product_id, snapshot=snapshot, query=query, selection=selection,
                                     cursor=cursor, _machine_result_fields=_machine_result_fields,
                                     _result_budget=_result_budget, _prepared=prepared)

    def _read_fixed_page(self, product_id, *, snapshot, query, selection, cursor,
                         _machine_result_fields=None, _result_budget=None, _prepared=None):
        """Shared bounded projection/rendering, without changing the selected domain."""
        snapshot_id, page_size = query["snapshot_id"], query["page_size"]
        max_page_bytes = query["max_page_bytes"]
        full_product = query["format_version"] == FIXED_PRODUCT_PAGE_FORMAT
        digest_key = "view_digest" if full_product else "selection_digest"
        count_key = "total_rows" if full_product else "selection_count"
        query_digest = "sha256:" + sha(canonical(query))
        manifest_digest = "sha256:" + snapshot["manifest_sha256"]
        binding = {"format_version": query["format_version"], "profile": DATA_ONLY_PROFILE,
                   "snapshot_id": snapshot_id, "product_id": product_id,
                   "query_digest": query_digest, "manifest_digest": manifest_digest,
                   "store_digest": "sha256:" + sha(canonical(str(self.root.resolve())))}
        if full_product:
            binding.update({"read_scope": "full_product", "view_digest": query["view_digest"],
                            "order": "record_id:utf8,record_version:utf8",
                            "page_size": page_size, "max_page_bytes": max_page_bytes})
        after_position = 0
        if cursor is not None:
            try:
                if not isinstance(cursor, str) or not cursor or len(cursor) > 1_048_576:
                    raise ValueError()
                decoded = json.loads(base64.b64decode(cursor + "=" * (-len(cursor) % 4),
                                                      altchars=b"-_", validate=True))
                if not isinstance(decoded, dict) or set(decoded) != {"body", "digest"}:
                    raise ValueError()
                body = decoded["body"]
                if (not isinstance(body, dict) or set(body) != set(binding) | {"after"}
                        or decoded["digest"] != "sha256:" + sha(canonical(body))
                        or any(body.get(key) != value for key, value in binding.items())):
                    raise ValueError()
                after_position = selection.index(body["after"]) + 1
                if after_position >= len(selection):
                    raise ValueError()
            except (ValueError, TypeError, KeyError, UnicodeError) as exc:
                raise ValueError("PAGE_CURSOR_INVALID") from exc
        parts, products, selected = (_prepared if _prepared is not None else
                                     self._page_parts(snapshot, product_id, selection))
        self._page_verify_files(parts)
        fetched = selected_rows_page(parts, selected, after_position=after_position,
                                     row_limit=page_size + 1, max_row_bytes=max_page_bytes)
        raw_rows = []
        for chosen in fetched:
            part = parts[chosen["part_index"]]
            product, source = part["product"], part["source_bundle"]
            row, version = chosen["row"], copy.deepcopy(chosen["revision"])
            row["business_key"] = version["logical_key"]
            time = row.get("public_time", source.get("public_time"))
            time = source.get("row_public_times", {}).get(part["output_key"], {}).get(chosen["physical_key"], time)
            raw_rows.append({"product_id": product_id, "row": row,
                             "subject": row.get("subject", product["subject"]),
                             "definition_ref": product["definition_ref"],
                             "eligibility": eligibility_at(time, None, mode="snapshot_contents"),
                             "evidence_refs": part.get("evidence_refs", []), "source": source,
                             "source_ids": [], "contract_ref": product.get("contract_ref"),
                             "revision": version, "revision_state": "current",
                             "record_ref": {"product_id": product_id, "snapshot_id": snapshot_id,
                                            "logical_key": version["logical_key"],
                                            "revision_id": version["revision_id"]}})
        for part in parts:
            stat = part["path"].stat()
            if (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns) != part["file_stat"]:
                raise ValueError("PAGE_ARTIFACT_CHANGED")
        raw = {"snapshot_id": snapshot_id, "perspective": "snapshot_contents", "at": None,
               "held_scope": None, "include_history": False, "rows": raw_rows,
               "diagnostics": [], "products": list(products.values()), "source_ids": []}
        self._qualify_calendar(raw, perspective="snapshot_contents", at=None, held_scope=None,
                               usable_stage=None, fields=None, business_time_range=None)
        public = self._public_read_result(raw)
        for row in public["rows"]:
            row["record_id"] = row["record_ref"]["logical_key"]
            row["record_version"] = row["record_ref"]["revision_id"]
        extras = dict(_machine_result_fields or {})
        if set(extras) - {"service_identity", "row_projection", "row_projection_note"}:
            raise ValueError("PAGE_RESULT_METADATA_INVALID")
        budget = max_page_bytes if _result_budget is None else min(max_page_bytes, _result_budget)

        def render(count):
            result = {**public, **extras, "profile": DATA_ONLY_PROFILE, "product_id": product_id,
                      "dataset_id": parts[0]["product"]["dataset_id"], "rows": public["rows"][:count]}
            if full_product:
                result["read_scope"] = "full_product"
            visible = {(row["product_id"], (row.get("contract_ref") or {}).get("digest", "legacy"))
                       for row in result["rows"]}
            result["products"] = [product for product in public["products"]
                                  if (product["product_id"], (product.get("contract_ref") or {}).get("digest", "legacy")) in visible]
            if full_product and not selection:
                # A known, fully withdrawn product still has intact contracts,
                # units and public metadata in its sole empty terminal page.
                result["products"] = list(public["products"])
            result["public_projection"] = self._public_projection_metadata(result["products"], [])
            page_refs = [{"record_id": row["record_id"], "record_version": row["record_version"]}
                         for row in result["rows"]]
            last_position = after_position + count
            has_more = last_position < len(selection)
            next_cursor = None
            if has_more and count:
                body = {**binding, "after": page_refs[-1]}
                encoded = canonical({"body": body, "digest": "sha256:" + sha(canonical(body))})
                next_cursor = base64.urlsafe_b64encode(encoded).decode("ascii").rstrip("=")
            result["row_count"], result["product_count"] = count, len(result["products"])
            result["pagination"] = {"format_version": query["format_version"], "page_size": page_size,
                                    "max_page_bytes": max_page_bytes, "returned_rows": count,
                                    count_key: len(selection), "has_more": has_more,
                                    "next_cursor": next_cursor}
            result["integrity"] = {"manifest_digest": manifest_digest, digest_key: query[digest_key],
                                   "query_digest": query_digest,
                                   "page_digest": "sha256:" + sha(canonical(page_refs))}
            return result

        maximum = min(page_size, len(public["rows"]))
        if len(canonical(render(0))) > budget:
            raise ValueError("PAGE_METADATA_TOO_LARGE")
        if full_product and not selection:
            return render(0)
        if not maximum or len(canonical(render(1))) > budget:
            raise ValueError("PAGE_ITEM_TOO_LARGE")
        result = render(maximum)
        if len(canonical(result)) <= budget:
            return result
        low, high = 1, maximum - 1
        while low < high:
            middle = (low + high + 1) // 2
            if len(canonical(render(middle))) <= budget:
                low = middle
            else:
                high = middle - 1
        return render(low)

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
