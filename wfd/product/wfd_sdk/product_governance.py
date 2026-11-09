"""P1 product-contract validation and local permission normalization.

This module deliberately stays below a full identity/unit catalogue.  P1 checks
that a declaration is internally complete and type-safe; P2 supplies the
versioned unit and identity catalogues used by later releases.
"""
from __future__ import annotations

import copy
import re
from .duckdb_sdk import check_time


CONTRACT_VERSION = "wfd.product-contracts/0.3"
CALLER_ROLES = {
    "evidence_write", "register", "submit", "compute", "publish",
    "read", "read_evidence", "export", "redistribute",
}
SOURCE_FLAGS = {
    "may_submit", "may_publish_formal", "may_read", "may_read_evidence",
    "may_export", "may_export_evidence", "may_redistribute",
}
VALID_TYPES = {"decimal", "integer", "text", "boolean"}
VALID_NATURES = {"stock", "flow", "event", "derived", "mixed_observation", "relation"}
NULL_STATES = {
    "unknown", "not_reported", "not_collected", "out_of_coverage",
    "not_applicable", "not_yet_effective", "not_matured",
    "insufficient_warmup", "source_conflict",
}
SOURCE_LINEAGE_ROLES = {"first_publisher", "republisher"}
CONFLICT_MODES = {"preserve", "compare", "select"}
WARMUP_STATUSES = {"sufficient", "partial", "insufficient"}
DERIVED_VALIDITY_STATES = {"valid", "partial", "insufficient_warmup"}
FIELD_CODE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$")
DECIMAL_TEXT = re.compile(r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$")
INTEGER_TEXT = re.compile(r"^-?(?:0|[1-9][0-9]*)$")
MAX_PRECISION = 38
MAX_SCALE = 18

# Only known units receive a cross-check.  Unknown but well-formed codes remain
# admissible until P2 supplies the versioned unit catalogue.
_UNIT_CLASS = {
    "cny": "money", "usd": "money", "money": "money", "cny_100million": "money",
    "share": "quantity", "lot_100_shares": "quantity", "vehicle": "quantity",
    "count": "quantity", "cny_per_share": "money_per_share",
    "cny_per_10_shares": "money_per_share", "ratio": "ratio", "percent": "ratio",
    "date": "date", "day_of_week": "ordinal", "text": "text",
    "identifier": "identifier", "currency_code": "identifier",
    "timezone": "identifier", "boolean": "boolean",
    "not_applicable": "not_applicable",
}
_NUMERIC_CLASSES = {"money", "quantity", "money_per_share", "ratio", "ordinal"}
_TEXT_CLASSES = {"date", "text", "identifier", "not_applicable"}


def issue(code, message, field_path=None):
    result = {"code": code, "message": message}
    if field_path:
        result["field_path"] = field_path
    return result


def normalize_caller_roles(roles):
    if roles is None:
        return frozenset()
    if isinstance(roles, str):
        roles = [roles]
    values = set(roles)
    unknown = values - CALLER_ROLES
    if unknown:
        raise ValueError("CALLER_ROLE_UNKNOWN:" + ",".join(sorted(unknown)))
    return frozenset(values)


def normalize_source_policies(allowed_sources):
    """Explicitly deny every permission that was not granted.

    ``may_publish`` from the 0.2 files is accepted only as an explicit legacy
    alias for ``may_submit``; it never grants formal publication, reads or
    exports.  No source gets a default grant.
    """
    if not isinstance(allowed_sources, dict):
        raise ValueError("SOURCE_POLICIES_INVALID")
    normalized = {}
    for source_id, raw in allowed_sources.items():
        if not isinstance(source_id, str) or not source_id:
            raise ValueError("SOURCE_ID_INVALID")
        if not isinstance(raw, dict):
            raise ValueError("SOURCE_POLICY_INVALID:" + source_id)
        policy = copy.deepcopy(raw)
        unknown_permissions = sorted(
            key for key in policy if key.startswith("may_") and key not in SOURCE_FLAGS | {"may_publish"}
        )
        if unknown_permissions:
            raise ValueError("SOURCE_POLICY_UNKNOWN_PERMISSION:" + source_id + ":" + ",".join(unknown_permissions))
        if policy.get("may_publish") is True and "may_submit" not in policy:
            policy["may_submit"] = True
        for flag in SOURCE_FLAGS:
            policy[flag] = policy.get(flag) is True
        if policy["may_export_evidence"] and not policy["may_export"]:
            raise ValueError("SOURCE_EXPORT_EVIDENCE_REQUIRES_EXPORT:" + source_id)
        if policy["may_export"] and not str(policy.get("export_scope", "")).strip():
            raise ValueError("SOURCE_EXPORT_SCOPE_REQUIRED:" + source_id)
        if any(policy[flag] for flag in SOURCE_FLAGS) and not str(policy.get("usage_scope", "")).strip():
            raise ValueError("SOURCE_USAGE_SCOPE_REQUIRED:" + source_id)
        domains = policy.get("allowed_domains", [])
        if not isinstance(domains, list) or any(not isinstance(x, str) or not x for x in domains):
            raise ValueError("SOURCE_ALLOWED_DOMAINS_INVALID:" + source_id)
        policy["allowed_domains"] = list(domains)
        roles = policy.get("allowed_roles", [])
        valid_roles = {"definer", "first_publisher", "republisher", "deliverer", "compiler", "acquirer"}
        if not isinstance(roles, list) or any(not isinstance(x, str) or x not in valid_roles for x in roles):
            raise ValueError("SOURCE_ALLOWED_ROLES_INVALID:" + source_id)
        policy["allowed_roles"] = list(roles)
        authorities = policy.get("allowed_authorities", [])
        if not isinstance(authorities, list) or any(not isinstance(x, str) or not x for x in authorities):
            raise ValueError("SOURCE_ALLOWED_AUTHORITIES_INVALID:" + source_id)
        policy["allowed_authorities"] = list(authorities)
        normalized[source_id] = policy
    return normalized


def _unit_class(code):
    return _UNIT_CLASS.get(str(code or "").lower())


def source_origin_key(first_publisher_id, first_publication_id, original_content_sha256):
    """Identity of one original publication, not of each re-delivery."""
    import hashlib
    import json
    body = json.dumps([first_publisher_id, first_publication_id, original_content_sha256],
                      ensure_ascii=False, allow_nan=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")
    return "o_" + hashlib.sha256(body).hexdigest()[:32]


def _type_unit_compatible(data_type, unit):
    cls = _unit_class(unit)
    if cls is None:
        return True
    if data_type in {"decimal", "integer"}:
        return cls in _NUMERIC_CLASSES
    if data_type == "text":
        return cls in _TEXT_CLASSES
    if data_type == "boolean":
        return cls in {"boolean", "not_applicable"}
    return False


def _digits_and_scale(value):
    text = str(value).lstrip("-")
    if "." in text:
        whole, scale = text.split(".", 1)
        return len((whole + scale).lstrip("0") or "0"), len(scale)
    return len(text.lstrip("0") or "0"), 0



def normalize_unit_registry(registry):
    """Accept a trusted local mapping/iterable; no universal allow-list."""
    if registry is None:
        return {}
    if isinstance(registry, dict):
        values = registry
    elif isinstance(registry, (list, set, tuple, frozenset)):
        values = {code: {} for code in registry}
    else:
        raise ValueError("UNIT_REGISTRY_INVALID")
    result = {}
    for code, definition in values.items():
        if not isinstance(code, str) or not code or code in {"unknown", "unspecified"}:
            raise ValueError("UNIT_CODE_INVALID")
        if definition is None:
            definition = {}
        if not isinstance(definition, dict):
            raise ValueError("UNIT_DEFINITION_INVALID:" + code)
        result[code] = copy.deepcopy(definition)
    return result


_NUMERIC_DIMENSIONS = {"money", "quantity", "money_per_share", "ratio", "ordinal", "number"}
_TEXT_DIMENSIONS = {"text", "identifier", "date", "datetime", "currency_code", "timezone"}


def _dimension_issue(data_type, unit, definition, path):
    if unit in {"not_applicable", "per_field"}:
        return []
    if unit not in definition:
        return [issue("UNIT_DEFINITION_REQUIRED", "Unit has no trusted definition", path)]
    dimension = str(definition[unit].get("dimension", "")).strip()
    if not dimension:
        return [issue("UNIT_DEFINITION_INCOMPLETE", "Unit definition lacks dimension", path)]
    if data_type in {"decimal", "integer"}:
        compatible = dimension in _NUMERIC_DIMENSIONS
    elif data_type == "text":
        compatible = dimension in _TEXT_DIMENSIONS
    elif data_type == "boolean":
        compatible = dimension in {"boolean", "not_applicable"}
    else:
        compatible = False
    if not compatible:
        return [issue("UNIT_DIMENSION_MISMATCH", "Injected unit dimension is incompatible with data_type", path)]
    return []


def validate_units(declaration, unit_registry):
    """Unknown or incomplete units may be registered but cannot reach formal publication."""
    issues = []
    top = str(declaration.get("unit_code", ""))
    if top not in {"per_field", "not_applicable"}:
        issues.extend(_dimension_issue("decimal", top, unit_registry, "unit_code"))
    for index, field in enumerate(declaration.get("field_definitions", [])):
        if not isinstance(field, dict):
            continue
        unit = str(field.get("unit_code", ""))
        data_type = field.get("data_type")
        issues.extend(_dimension_issue(data_type, unit, unit_registry,
                                       f"field_definitions[{index}].unit_code"))
    return issues

def _integer_scale(value):
    text = str(value).lstrip("-")
    if "." in text:
        whole, fraction = text.split(".", 1)
        return len(whole.lstrip("0") or "0"), len(fraction)
    return len(text.lstrip("0") or "0"), 0


def _column_precision_issues(fields, rows):
    stats = {}
    for row in rows:
        values = row.get("values") if isinstance(row, dict) else None
        if not isinstance(values, dict):
            continue
        for code, cell in values.items():
            field = fields.get(code)
            if not field or field.get("data_type") not in {"decimal", "integer"}:
                continue
            if not isinstance(cell, dict) or cell.get("value_state") not in {"valid_value", "reported_zero"}:
                continue
            value = cell.get("value")
            if not isinstance(value, str):
                continue
            integer_digits, scale = _integer_scale(value)
            previous = stats.get(code, (0, 0))
            stats[code] = (max(previous[0], integer_digits), max(previous[1], scale))
    issues = []
    for code, (integer_digits, scale) in stats.items():
        data_type = fields[code].get("data_type")
        if data_type == "integer" and integer_digits > MAX_PRECISION:
            issues.append(issue("COLUMN_PRECISION_UNSUPPORTED",
                                f"Column needs {integer_digits} integer digits, max {MAX_PRECISION}",
                                f"values.{code}"))
        elif data_type == "decimal" and integer_digits + scale > MAX_PRECISION:
            issues.append(issue("COLUMN_PRECISION_UNSUPPORTED",
                                f"Column needs precision {integer_digits + scale} (integer {integer_digits} + scale {scale}), max {MAX_PRECISION}",
                                f"values.{code}"))
        elif data_type == "decimal" and scale > MAX_SCALE:
            issues.append(issue("COLUMN_SCALE_UNSUPPORTED",
                                f"Column scale {scale} exceeds {MAX_SCALE}", f"values.{code}"))
    return issues




def _scalar_precision_issues(rows):
    integer_digits = scale = 0
    for row in rows:
        if not isinstance(row, dict) or row.get("value_state") not in {"valid_value", "reported_zero"}:
            continue
        value = row.get("value_decimal")
        if not isinstance(value, str):
            continue
        whole, fraction = _integer_scale(value)
        integer_digits = max(integer_digits, whole)
        scale = max(scale, fraction)
    if integer_digits + scale > MAX_PRECISION:
        return [issue("COLUMN_PRECISION_UNSUPPORTED",
                      f"Scalar column needs precision {integer_digits + scale} "
                      f"(integer {integer_digits} + scale {scale}), max {MAX_PRECISION}",
                      "value_decimal")]
    return []
def validate_definition(declaration, payload_kind):
    issues = []
    if not isinstance(declaration, dict):
        return [issue("DEFINITION_REQUIRED", "Definition declaration is required")]
    for field in ("semantic_code", "definition_authority", "time_role"):
        if not str(declaration.get(field, "")).strip():
            issues.append(issue("DEFINITION_INCOMPLETE:" + field, "Definition field is required", field))
    code = str(declaration.get("semantic_code", ""))
    if code and not FIELD_CODE.fullmatch(code):
        issues.append(issue("DEFINITION_SEMANTIC_CODE_INVALID", "semantic_code is not a valid stable code", "semantic_code"))
    nature = declaration.get("measurement_nature")
    if nature not in VALID_NATURES:
        issues.append(issue("DEFINITION_NATURE_INVALID", "measurement_nature is not supported", "measurement_nature"))
    unit = str(declaration.get("unit_code", "")).strip()
    if not unit or unit in {"unknown", "unspecified"}:
        issues.append(issue("UNIT_MEANING_REQUIRED", "A concrete unit or per_field declaration is required", "unit_code"))
    if payload_kind != "tabular_rows" and unit == "per_field":
        issues.append(issue("UNIT_MEANING_REQUIRED", "per_field is only valid for tabular_rows", "unit_code"))
    if payload_kind == "scalar_rows" and unit and unit not in {"unknown", "unspecified"} and not _type_unit_compatible("decimal", unit):
        issues.append(issue("UNIT_DIMENSION_MISMATCH", "Scalar value unit is not a numeric/quantity dimension", "unit_code"))
    fields = declaration.get("field_definitions", [])
    if payload_kind == "tabular_rows" and not fields:
        issues.append(issue("FIELD_DEFINITIONS_REQUIRED", "Tabular products require field definitions", "field_definitions"))
    if not isinstance(fields, list):
        return issues + [issue("FIELD_DEFINITIONS_INVALID", "field_definitions must be a list", "field_definitions")]
    seen = set()
    for index, field in enumerate(fields):
        path = f"field_definitions[{index}]"
        if not isinstance(field, dict):
            issues.append(issue("FIELD_DEFINITION_INVALID", "Field definition must be an object", path))
            continue
        code = str(field.get("field_code", ""))
        if not FIELD_CODE.fullmatch(code):
            issues.append(issue("FIELD_CODE_INVALID", "Invalid field_code", path + ".field_code"))
        elif code in seen:
            issues.append(issue("DUPLICATE_FIELD_DEFINITION", "Duplicate field_code", path + ".field_code"))
        seen.add(code)
        data_type = field.get("data_type")
        if data_type not in VALID_TYPES:
            issues.append(issue("FIELD_TYPE_INVALID", "Unsupported data_type", path + ".data_type"))
        unit_code = str(field.get("unit_code", "")).strip()
        if not unit_code or unit_code in {"unknown", "unspecified", "per_field"}:
            issues.append(issue("FIELD_UNIT_REQUIRED", "Every field needs a concrete unit_code", path + ".unit_code"))
        elif data_type in VALID_TYPES and not _type_unit_compatible(data_type, unit_code):
            issues.append(issue("UNIT_DIMENSION_MISMATCH", "field unit is incompatible with data_type", path + ".unit_code"))
        if field.get("measurement_nature") not in VALID_NATURES:
            issues.append(issue("FIELD_NATURE_INVALID", "Unsupported field measurement_nature", path + ".measurement_nature"))
        if not str(field.get("time_role", "")).strip():
            issues.append(issue("FIELD_TIME_ROLE_REQUIRED", "Every field needs a time_role", path + ".time_role"))
        if "consistency_group" in field and not str(field["consistency_group"]).strip():
            issues.append(issue("FIELD_CONSISTENCY_GROUP_INVALID", "consistency_group must be nonempty", path + ".consistency_group"))
    return issues


def _value_issues(data_type, state, value, path):
    issues = []
    if state in NULL_STATES:
        if value is not None:
            issues.append(issue("VALUE_STATE_MISMATCH", "Null states require a null value", path))
        return issues
    if state not in {"valid_value", "reported_zero"}:
        issues.append(issue("VALUE_STATE_INVALID", "Unsupported value_state", path))
        return issues
    if value is None:
        issues.append(issue("VALUE_REQUIRED", "valid_value/reported_zero require a value", path))
        return issues
    if data_type == "decimal":
        if not isinstance(value, str) or not DECIMAL_TEXT.fullmatch(value):
            issues.append(issue("VALUE_TYPE_MISMATCH", "Decimal values must be canonical decimal strings", path))
        else:
            precision, scale = _digits_and_scale(value)
            if precision > MAX_PRECISION:
                issues.append(issue("VALUE_PRECISION_UNSUPPORTED", f"Decimal precision exceeds {MAX_PRECISION}", path))
            if scale > MAX_SCALE:
                issues.append(issue("VALUE_SCALE_UNSUPPORTED", f"Decimal scale exceeds {MAX_SCALE}", path))
    elif data_type == "integer":
        if not isinstance(value, str) or not INTEGER_TEXT.fullmatch(value):
            issues.append(issue("VALUE_TYPE_MISMATCH", "Integer values must be canonical integer strings", path))
    elif data_type == "text":
        if not isinstance(value, str):
            issues.append(issue("VALUE_TYPE_MISMATCH", "Text values must be strings", path))
    elif data_type == "boolean":
        if not isinstance(value, bool):
            issues.append(issue("VALUE_TYPE_MISMATCH", "Boolean values must be true/false", path))
    if state == "reported_zero" and value not in {"0", 0, False}:
        issues.append(issue("VALUE_STATE_MISMATCH", "reported_zero must carry zero", path))
    return issues


def _time_issues(value, path):
    if not isinstance(value, dict):
        return [issue("SOURCE_TIME_INVALID", "Time object is required", path)]
    out = []
    for error in check_time(value, path):
        out.append(issue(error["code"], error["message"], path))
    return out


def validate_payload(output, declaration):
    issues = []
    payload = output.get("payload", {})
    kind = payload.get("kind")
    rows = payload.get("rows", [])
    fields = {f.get("field_code"): f for f in declaration.get("field_definitions", []) if isinstance(f, dict)}
    key_field = "event_id" if kind == "event_records" else "business_key"
    for index, row in enumerate(rows):
        path = f"rows[{index}]"
        if not isinstance(row, dict):
            issues.append(issue("ROW_INVALID", "Row must be an object", path))
            continue
        key = row.get(key_field)
        if not isinstance(key, str) or not key:
            issues.append(issue("BUSINESS_KEY_REQUIRED", f"{key_field} is required", path))
        for time_field in ("observation_time", "event_time", "public_time", "effective_period"):
            if time_field in row:
                issues.extend(_time_issues(row[time_field], f"{path}.{time_field}"))
        if kind == "tabular_rows":
            values = row.get("values")
            if not isinstance(values, dict):
                issues.append(issue("ROW_VALUES_REQUIRED", "Tabular row values are required", path))
                continue
            if set(values) != set(fields):
                issues.append(issue("FIELD_SET_MISMATCH", "Row fields must exactly match the contract", path + ".values"))
                continue
            for name, cell in values.items():
                if not isinstance(cell, dict):
                    issues.append(issue("VALUE_CELL_INVALID", "Value cell must be an object", f"{path}.values.{name}"))
                    continue
                expected = fields[name].get("data_type")
                if cell.get("data_type") != expected:
                    issues.append(issue("FIELD_TYPE_MISMATCH", "Cell data_type differs from contract", f"{path}.values.{name}.data_type"))
                issues.extend(_value_issues(cell.get("data_type"), cell.get("value_state"), cell.get("value"), f"{path}.values.{name}"))
        elif kind == "scalar_rows":
            if declaration.get("unit_code") == "per_field":
                issues.append(issue("UNIT_MEANING_REQUIRED", "Scalar product cannot use per_field", "unit_code"))
            issues.extend(_value_issues("decimal", row.get("value_state"), row.get("value_decimal"), path + ".value_decimal"))
        elif "values" in row:
            values = row.get("values")
            if not isinstance(values, dict) or set(values) != set(fields):
                issues.append(issue("FIELD_SET_MISMATCH", "Row values must exactly match the contract", path + ".values"))
                continue
            for name, cell in values.items():
                if not isinstance(cell, dict):
                    issues.append(issue("VALUE_CELL_INVALID", "Value cell must be an object", f"{path}.values.{name}"))
                    continue
                expected = fields[name].get("data_type")
                if cell.get("data_type") != expected:
                    issues.append(issue("FIELD_TYPE_MISMATCH", "Cell data_type differs from contract", f"{path}.values.{name}.data_type"))
                issues.extend(_value_issues(cell.get("data_type"), cell.get("value_state"), cell.get("value"), f"{path}.values.{name}"))
    if fields:
        issues.extend(_column_precision_issues(fields, rows))
    if kind == "scalar_rows":
        issues.extend(_scalar_precision_issues(rows))
    return issues


SEMANTIC_CONTEXT_VERSION = "wfd.semantic-context/1.0"
CONTENT_NATURES = {
    "observed_fact", "source_claim", "plan", "forecast",
    "actual_outcome", "deterministic_derived", "definition_rule",
}
PERIOD_TYPES = {"natural", "trading", "accounting", "observation_window", "instant", "unknown"}
PERIOD_AGGREGATIONS = {"instant", "period", "ytd", "quarterly", "ttm",
                       "observation_window", "trailing_twelve_months", "unknown"}
CONSOLIDATION_SCOPES = {"consolidated", "parent", "not_applicable", "unknown"}
_SEMANTIC_AXES = {"identity", "time", "measurement", "content", "statistical",
                  "financial", "relation", "coverage_quality", "source", "version",
                  "derivation"}


def _ref_like(value):
    return isinstance(value, dict) and (
        isinstance(value.get("digest"), str) or isinstance(value.get("ref_id"), str)
        or isinstance(value.get("id"), str))


def _normalize_axis(raw, allowed, axis, issues):
    if raw is None:
        return None
    if not isinstance(raw, dict):
        issues.append(issue("SEMANTIC_CONTEXT_AXIS_INVALID", "Axis must be an object", axis))
        return None
    unknown = set(raw) - set(allowed) - {"status"}
    if unknown:
        issues.append(issue("SEMANTIC_CONTEXT_FIELD_UNSUPPORTED",
                            "Unsupported semantic field: " + sorted(unknown)[0], axis))
    return {key: copy.deepcopy(value) for key, value in raw.items()
            if key in allowed or key == "status"}


def _axis_unknown(raw):
    return raw is None or (isinstance(raw, dict) and raw.get("status") == "unknown")


def normalize_semantic_context(declaration, payload_kind, *, allow_deterministic_without_lineage=False):
    """Normalize an optional versioned semantic context into the declaration.

    Missing axes stay explicitly unknown; no default seasonality, accounting
    scope, price basis or period type is invented.  Field-level overrides are
    limited to declared fields and do not force one scope on every field.
    """
    raw = declaration.get("semantic_context")
    if raw is None and not declaration.get("field_semantic_context"):
        return copy.deepcopy(declaration), []
    issues = []
    if not isinstance(raw, dict):
        return copy.deepcopy(declaration), [issue("SEMANTIC_CONTEXT_INVALID", "semantic_context must be an object")]
    unknown_top = set(raw) - {"version", "content_nature", "measurement_nature", "identity",
                              "time", "measurement", "content", "statistical", "financial",
                              "relation", "coverage_quality", "source", "version_axis",
                              "derivation", "unknown_axes", "notes"}
    if unknown_top:
        issues.append(issue("SEMANTIC_CONTEXT_FIELD_UNSUPPORTED",
                            "Unsupported semantic_context field: " + sorted(unknown_top)[0]))
    if raw.get("version") != SEMANTIC_CONTEXT_VERSION:
        issues.append(issue("SEMANTIC_CONTEXT_VERSION_REQUIRED",
                            "semantic_context.version must be " + SEMANTIC_CONTEXT_VERSION, "semantic_context.version"))
    content_nature = raw.get("content_nature")
    if content_nature not in CONTENT_NATURES:
        issues.append(issue("SEMANTIC_CONTENT_NATURE_REQUIRED",
                            "content_nature must be one of " + ",".join(sorted(CONTENT_NATURES)),
                            "semantic_context.content_nature"))
    measurement_nature = raw.get("measurement_nature")
    if measurement_nature is not None and measurement_nature != declaration.get("measurement_nature"):
        issues.append(issue("SEMANTIC_MEASUREMENT_NATURE_MISMATCH",
                            "semantic context measurement nature differs from declaration",
                            "semantic_context.measurement_nature"))
    axes = {}
    axes["identity"] = _normalize_axis(raw.get("identity"), {
        "subject_kind", "identity_resolution_rule", "alias_scope", "notes"}, "identity", issues)
    time_axis = _normalize_axis(raw.get("time"), {
        "period_type", "frequency", "interval", "calendar_ref",
        "accounting_calendar_ref", "window", "roles", "timezone", "notes"}, "time", issues) or {}
    if time_axis.get("period_type") not in PERIOD_TYPES | {None}:
        issues.append(issue("SEMANTIC_TIME_PERIOD_INVALID", "Unsupported period_type", "semantic_context.time.period_type"))
    if time_axis.get("interval") not in {None, "closed", "open", "half_open"}:
        issues.append(issue("SEMANTIC_TIME_INTERVAL_INVALID", "interval must be closed/open/half_open", "semantic_context.time.interval"))
    if time_axis.get("period_type") == "trading" and not _ref_like(time_axis.get("calendar_ref")):
        issues.append(issue("SEMANTIC_TRADING_CALENDAR_REQUIRED", "Trading period needs calendar_ref", "semantic_context.time.calendar_ref"))
    if time_axis.get("period_type") == "accounting" and not _ref_like(time_axis.get("accounting_calendar_ref")):
        issues.append(issue("SEMANTIC_ACCOUNTING_CALENDAR_REQUIRED", "Accounting period needs accounting_calendar_ref", "semantic_context.time.accounting_calendar_ref"))
    if time_axis.get("period_type") == "observation_window" and not isinstance(time_axis.get("window"), dict):
        issues.append(issue("SEMANTIC_OBSERVATION_WINDOW_REQUIRED", "Observation window needs window declaration", "semantic_context.time.window"))
    if time_axis:
        axes["time"] = time_axis
    measurement_axis = _normalize_axis(raw.get("measurement"), {
        "measurement_nature", "unit_code", "precision", "sign", "aggregation",
        "value_states", "notes"}, "measurement", issues) or {}
    measurement_axis.setdefault("measurement_nature", declaration.get("measurement_nature"))
    if declaration.get("unit_code") not in {None, "", "per_field", "not_applicable"}:
        measurement_axis.setdefault("unit_code", declaration.get("unit_code"))
    axes["measurement"] = measurement_axis
    content_axis = _normalize_axis(raw.get("content"), {
        "assertion_status", "publisher_ref", "target_period", "notes"}, "content", issues) or {}
    content_axis["content_nature"] = content_nature
    axes["content"] = content_axis
    statistical = _normalize_axis(raw.get("statistical"), {
        "sample_scope_ref", "weighting_ref", "price_basis", "base_period_ref",
        "seasonal_adjustment", "period_aggregation", "denominator_ref",
        "coverage_scope_ref", "notes"}, "statistical", issues) or {}
    if statistical.get("price_basis") not in {None, "nominal", "real", "unknown"}:
        issues.append(issue("SEMANTIC_PRICE_BASIS_INVALID", "price_basis must be nominal/real/unknown", "semantic_context.statistical.price_basis"))
    if statistical.get("price_basis") == "real" and not (_ref_like(statistical.get("base_period_ref")) or isinstance(statistical.get("base_period_ref"), str)):
        issues.append(issue("SEMANTIC_REAL_BASE_PERIOD_REQUIRED", "Real values need base_period_ref", "semantic_context.statistical.base_period_ref"))
    seasonal = statistical.get("seasonal_adjustment")
    if seasonal is not None:
        if not isinstance(seasonal, dict):
            issues.append(issue("SEMANTIC_SEASONAL_INVALID", "seasonal_adjustment must be an object", "semantic_context.statistical.seasonal_adjustment"))
        else:
            if seasonal.get("status") not in {"adjusted", "not_adjusted", "unknown"}:
                issues.append(issue("SEMANTIC_SEASONAL_INVALID", "seasonal status must be adjusted/not_adjusted/unknown", "semantic_context.statistical.seasonal_adjustment.status"))
            if seasonal.get("status") == "adjusted" and not _ref_like(seasonal.get("method_ref")):
                issues.append(issue("SEMANTIC_SEASONAL_METHOD_REQUIRED", "Adjusted data need method_ref", "semantic_context.statistical.seasonal_adjustment.method_ref"))
    if statistical.get("period_aggregation") not in PERIOD_AGGREGATIONS | {None}:
        issues.append(issue("SEMANTIC_PERIOD_AGGREGATION_INVALID", "Unsupported period_aggregation", "semantic_context.statistical.period_aggregation"))
    if statistical:
        axes["statistical"] = statistical
    financial = _normalize_axis(raw.get("financial"), {
        "accounting_standard_ref", "consolidation_scope", "mapping_comparability_ref",
        "price_adjustment", "return_definition_ref", "currency_conversion_ref", "notes"},
        "financial", issues) or {}
    if financial.get("consolidation_scope") not in CONSOLIDATION_SCOPES | {None}:
        issues.append(issue("SEMANTIC_CONSOLIDATION_SCOPE_INVALID", "Unsupported consolidation_scope", "semantic_context.financial.consolidation_scope"))
    adjustment = financial.get("price_adjustment")
    if adjustment is not None:
        if not isinstance(adjustment, dict):
            issues.append(issue("SEMANTIC_PRICE_ADJUSTMENT_INVALID", "price_adjustment must be an object", "semantic_context.financial.price_adjustment"))
        else:
            direction = adjustment.get("direction")
            if direction not in {None, "raw", "adjusted", "unknown"}:
                issues.append(issue("SEMANTIC_PRICE_ADJUSTMENT_INVALID", "direction must be raw/adjusted/unknown", "semantic_context.financial.price_adjustment.direction"))
            method = adjustment.get("method")
            anchor = adjustment.get("anchor_ref")
            # P2: a method without an anchor cannot decide whether two series share
            # one caliber, and an anchor without a method cannot either.  A declared
            # method therefore only exists on an `adjusted` declaration.
            if direction == "adjusted":
                if method not in {"qfq", "hfq"}:
                    issues.append(issue("SEMANTIC_ADJUSTMENT_METHOD_REQUIRED",
                                        "Adjusted prices need method=qfq|hfq",
                                        "semantic_context.financial.price_adjustment.method"))
                if not _ref_like(anchor):
                    issues.append(issue("SEMANTIC_ADJUSTMENT_ANCHOR_REQUIRED", "Adjusted prices need anchor_ref", "semantic_context.financial.price_adjustment.anchor_ref"))
            elif direction in {"raw", "unknown"}:
                if anchor is not None:
                    issues.append(issue("SEMANTIC_ADJUSTMENT_ANCHOR_FORBIDDEN",
                                        "Only adjusted prices carry an anchor_ref; "
                                        + direction + " must not declare one",
                                        "semantic_context.financial.price_adjustment.anchor_ref"))
                if method is not None:
                    issues.append(issue("SEMANTIC_ADJUSTMENT_METHOD_FORBIDDEN",
                                        "Only adjusted prices carry a method; "
                                        + direction + " must not declare one",
                                        "semantic_context.financial.price_adjustment.method"))
            elif method is not None or anchor is not None:
                issues.append(issue("SEMANTIC_PRICE_ADJUSTMENT_INVALID",
                                    "method/anchor_ref need an explicit direction",
                                    "semantic_context.financial.price_adjustment"))
    if financial:
        axes["financial"] = financial
    axes["relation"] = _normalize_axis(raw.get("relation"), {
        "relation_type", "direction", "set_completeness", "effective_scope", "notes"},
        "relation", issues)
    axes["coverage_quality"] = _normalize_axis(raw.get("coverage_quality"), {
        "completeness", "absence_means", "validation_ref", "warmup_ref", "notes"},
        "coverage_quality", issues)
    source_axis = _normalize_axis(raw.get("source"), {
        "definition_authority", "publisher_ref", "source_role_requirements",
        "license_ref", "notes"}, "source", issues) or {}
    source_axis.setdefault("definition_authority", declaration.get("definition_authority"))
    axes["source"] = source_axis
    version_axis = _normalize_axis(raw.get("version_axis"), {
        "definition_version", "method_version", "source_version", "parent_version",
        "revision_mode", "notes"}, "version", issues)
    axes["version"] = version_axis
    derivation = _normalize_axis(raw.get("derivation"), {
        "required", "method_ref", "code_digest", "warmup", "validity", "notes"},
        "derivation", issues)
    if isinstance(derivation, dict):
        if derivation.get("required") not in {True, False, None}:
            issues.append(issue("SEMANTIC_DERIVATION_INVALID", "derivation.required must be boolean", "semantic_context.derivation.required"))
        axes["derivation"] = derivation
    if (content_nature == "deterministic_derived"
            and not allow_deterministic_without_lineage
            and not (isinstance(derivation, dict) and derivation.get("required") is True)):
        issues.append(issue("SEMANTIC_DERIVATION_REQUIRED", "Deterministic derived content needs derivation.required=true", "semantic_context.derivation"))
    unknown_axes = set(raw.get("unknown_axes") or [])
    if not isinstance(raw.get("unknown_axes", []), list):
        issues.append(issue("SEMANTIC_UNKNOWN_AXES_INVALID", "unknown_axes must be a list", "semantic_context.unknown_axes"))
        unknown_axes = set()
    public_axes = ["identity", "time", "measurement", "content", "statistical",
                   "financial", "relation", "coverage_quality", "source", "version"]
    for axis_name in public_axes:
        if axis_name in {"content", "measurement"}:
            continue
        raw_axis = raw.get("version_axis") if axis_name == "version" else raw.get(axis_name)
        if _axis_unknown(raw_axis):
            unknown_axes.add(axis_name)
            axes["version" if axis_name == "version" else axis_name] = {"status": "unknown"}
    unknown_axes &= set(public_axes)
    limits = []
    for axis_name in sorted(unknown_axes):
        if axis_name == "time":
            limits.append("time_comparison_limited")
        elif axis_name == "statistical":
            limits.append("statistical_comparison_limited")
        elif axis_name == "financial":
            limits.append("financial_comparison_limited")
        elif axis_name in {"source", "version"}:
            limits.append(axis_name + "_provenance_limited")
        elif axis_name == "coverage_quality":
            limits.append("coverage_completeness_limited")
    normalized_context = {
        "version": SEMANTIC_CONTEXT_VERSION,
        "content_nature": content_nature,
        "measurement_nature": declaration.get("measurement_nature"),
        "identity": axes.get("identity"),
        "time": axes.get("time"),
        "measurement": axes.get("measurement"),
        "content": axes.get("content"),
        "statistical": axes.get("statistical"),
        "financial": axes.get("financial"),
        "relation": axes.get("relation"),
        "coverage_quality": axes.get("coverage_quality"),
        "source": axes.get("source"),
        "version_axis": axes.get("version"),
        "applicability": {
            "axes": sorted(public_axes),
            "unknown_axes": sorted(unknown_axes),
            "limits": sorted(set(limits)),
        },
    }
    if axes.get("derivation") is not None:
        normalized_context["derivation"] = axes.get("derivation")
    normalized = copy.deepcopy(declaration)
    normalized["semantic_context"] = normalized_context
    field_contexts = declaration.get("field_semantic_context")
    if field_contexts is not None:
        if not isinstance(field_contexts, dict):
            issues.append(issue("SEMANTIC_FIELD_CONTEXT_INVALID", "field_semantic_context must be an object"))
        else:
            declared_fields = {f.get("field_code") for f in declaration.get("field_definitions", [])
                               if isinstance(f, dict)}
            normalized_fields = {}
            for field_code, value in sorted(field_contexts.items()):
                if field_code not in declared_fields:
                    issues.append(issue("SEMANTIC_FIELD_CONTEXT_UNKNOWN_FIELD",
                                        "Field context refers to an undeclared field: " + str(field_code)))
                    continue
                if not isinstance(value, dict):
                    issues.append(issue("SEMANTIC_FIELD_CONTEXT_INVALID", "Field context must be an object", field_code))
                    continue
                unknown = set(value) - {"time", "measurement", "content", "statistical",
                                        "financial", "coverage_quality", "notes"}
                if unknown:
                    issues.append(issue("SEMANTIC_FIELD_CONTEXT_INVALID",
                                        "Unsupported field context: " + sorted(unknown)[0], field_code))
                normalized_fields[field_code] = copy.deepcopy(value)
            if normalized_fields:
                normalized["field_semantic_context"] = normalized_fields
            else:
                normalized.pop("field_semantic_context", None)
    return normalized, issues


def normalize_algorithm_definition(declaration):
    """Business meaning of a computed result, without external execution trace.

    Window/constants/definition version are deterministic business semantics.
    Actual input lists, code, runtime parameters/logs and processing traces are
    BD-owned and must not be stored here.
    """
    raw = declaration.get("algorithm_definition")
    if raw is None:
        return copy.deepcopy(declaration), []
    issues = []
    if not isinstance(raw, dict):
        return copy.deepcopy(declaration), [issue("ALGORITHM_DEFINITION_INVALID", "algorithm_definition must be an object")]
    forbidden = set(raw) & {"code", "code_digest", "parameters", "parameter_digest",
                            "inputs", "input_refs", "execution", "processing",
                            "processing_evidence", "processing_record", "lineage",
                            "source", "path", "locator", "bd_ref"}
    if forbidden:
        issues.append(issue("ALGORITHM_EXTERNAL_TRACE_FORBIDDEN",
                            "Algorithm business definition cannot contain external execution trace: "
                            + sorted(forbidden)[0]))
    allowed = {"result_semantics", "mathematical_definition", "window",
               "constants", "definition_version", "algorithm_ref", "notes"}
    unknown = set(raw) - allowed - forbidden
    if unknown:
        issues.append(issue("ALGORITHM_DEFINITION_FIELD_UNSUPPORTED",
                            "Unsupported algorithm_definition field: " + sorted(unknown)[0]))
    normalized = {key: copy.deepcopy(value) for key, value in raw.items()
                  if key in allowed}
    if not isinstance(normalized.get("mathematical_definition"), str) or not normalized["mathematical_definition"].strip():
        issues.append(issue("ALGORITHM_MATHEMATICAL_DEFINITION_REQUIRED",
                            "algorithm_definition.mathematical_definition is required"))
    window = normalized.get("window")
    if window is not None and not isinstance(window, dict):
        issues.append(issue("ALGORITHM_WINDOW_INVALID", "window must be an object"))
    constants = normalized.get("constants")
    if constants is not None and not isinstance(constants, dict):
        issues.append(issue("ALGORITHM_CONSTANTS_INVALID", "constants must be an object"))
    normalized["definition_version"] = str(normalized.get("definition_version") or "1.0")
    result = copy.deepcopy(declaration)
    result["algorithm_definition"] = normalized
    return result, issues
