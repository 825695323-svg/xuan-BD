"""P4B fixed trading/accounting calendar references.

Only the two explicit product_snapshot refs are resolved.  Every other
semantic ref remains unsupported and is rejected by the data-only declaration
gate.  This module is intentionally small: it validates the fixed ref shape,
binds the existing five-key read dependency, and verifies the pinned product
content/purpose.  It does not infer markets, fiscal years or 4-4-5 calendars.
"""
from __future__ import annotations

import copy
import re
from datetime import date, datetime, timedelta

from .duckdb_sdk import canonical, product_content_digest, sha

CALENDAR_ROLE = "calendar_ref"
ACCOUNTING_ROLE = "accounting_calendar_ref"
TRADING_SEMANTIC = "wfd.foundation.calendar.trading_days"
ACCOUNTING_SEMANTIC = "wfd.foundation.calendar.accounting_periods"
TRADING_FIELDS = ("session_date", "is_open", "market_code", "day_type")
ACCOUNTING_ROLES = ("fiscal_year_label", "period_label", "period_start_date",
                    "period_end_exclusive_date", "report_type")
REF_KEYS = {"kind", "namespace", "id", "version", "digest", "dataset_id",
            "resolution", "required", "dependency_type"}
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_DATE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")


def strict_date(value):
    if not isinstance(value, str) or not _DATE.fullmatch(value):
        raise ValueError("CALENDAR_DATE_INVALID:" + str(value))
    date.fromisoformat(value)
    return value


def merged_time_axis(declaration, field_code=None):
    """Effective top time context plus this field's explicit override."""
    top = ((declaration.get("semantic_context") or {}).get("time") or {})
    merged = copy.deepcopy(top) if isinstance(top, dict) else {}
    if field_code is not None:
        override = ((declaration.get("field_semantic_context") or {})
                    .get(field_code) or {}).get("time")
        if isinstance(override, dict):
            merged.update(copy.deepcopy(override))
    return merged


def field_calendar_rules(declaration, fields=None):
    """One effective rule per selected field; top ref applies unless overridden."""
    declared = [field.get("field_code") for field in declaration.get("field_definitions", [])
                if isinstance(field, dict) and field.get("field_code")]
    if not declared and not fields:
        top = ((declaration.get("semantic_context") or {}).get("time") or {})
        if top.get(CALENDAR_ROLE) is not None or top.get(ACCOUNTING_ROLE) is not None:
            declared = ["value_decimal"]
    selected = list(fields) if fields else declared
    rules = {}
    for field_code in selected:
        axis = merged_time_axis(declaration, field_code)
        role = None
        if axis.get("accounting_calendar_ref") is not None:
            role = ACCOUNTING_ROLE
        elif axis.get(CALENDAR_ROLE) is not None:
            role = CALENDAR_ROLE
        elif axis.get("period_type") in ("trading", "accounting"):
            raise _err("CALENDAR_REF_REQUIRED",
                       "field_semantic_context." + field_code + ".time." +
                       ("calendar_ref" if axis.get("period_type") == "trading"
                        else "accounting_calendar_ref"))
        if role is None:
            continue
        ref = axis.get(role)
        override_time = (((declaration.get("field_semantic_context") or {})
                          .get(field_code) or {}).get("time") or {})
        path = ("field_semantic_context." + field_code + ".time." + role
                if override_time.get(role) is not None
                else "semantic_context.time." + role)
        item = {"path": path, "field_code": field_code, "role": role,
                "ref": _check_ref(ref, path, role), "timezone": axis.get("timezone"),
                "calendar_ref": copy.deepcopy(axis.get(CALENDAR_ROLE)),
                "accounting_calendar_ref": copy.deepcopy(axis.get(ACCOUNTING_ROLE))}
        rules[field_code] = item
    return rules


def _err(code, path, detail=""):
    return ValueError(code + ":" + path + (":" + detail if detail else ""))


def _check_ref(ref, path, role):
    if not isinstance(ref, dict) or set(ref) != REF_KEYS:
        raise _err("CALENDAR_REF_INVALID", path, "exact fixed shape required")
    for key in ("kind", "namespace", "id", "version", "dataset_id", "resolution",
                "dependency_type"):
        if not isinstance(ref.get(key), str) or not _ID.fullmatch(ref[key]):
            raise _err("CALENDAR_REF_INVALID", path, key)
    if not isinstance(ref.get("digest"), str) or not __import__("re").fullmatch(
            r"sha256:[0-9a-f]{64}", ref["digest"]):
        raise _err("CALENDAR_REF_INVALID", path, "digest")
    if ref["kind"] != "product_snapshot" or ref["namespace"] != "wfd.product":
        raise _err("CALENDAR_REF_INVALID", path, "kind/namespace")
    if ref["resolution"] != "pinned" or ref["required"] is not True:
        raise _err("CALENDAR_REF_UNPINNED", path)
    if ref["dependency_type"] != "read":
        raise _err("CALENDAR_REF_INVALID", path, "dependency_type")
    if role == CALENDAR_ROLE and ref["kind"] != "product_snapshot":
        raise _err("CALENDAR_PURPOSE_UNSUPPORTED", path)
    return copy.deepcopy(ref)


def _time_axis(declaration, field_code=None):
    if field_code is None:
        return ((declaration.get("semantic_context") or {}).get("time") or {})
    value = (declaration.get("field_semantic_context") or {}).get(field_code) or {}
    return value.get("time") or {}


def extract(declaration):
    """Return fixed calendar refs in declaration order (top first, then fields)."""
    refs = []
    for role in (CALENDAR_ROLE, ACCOUNTING_ROLE):
        axis = _time_axis(declaration)
        ref = axis.get(role)
        if ref is not None:
            refs.append({"path": "semantic_context.time." + role, "field_code": None,
                         "role": role, "ref": _check_ref(ref, "semantic_context.time." + role, role),
                         "timezone": axis.get("timezone")})
    fields = declaration.get("field_semantic_context") or {}
    if isinstance(fields, dict):
        for field_code in sorted(fields):
            for role in (CALENDAR_ROLE, ACCOUNTING_ROLE):
                axis = _time_axis(declaration, field_code)
                ref = axis.get(role)
                if ref is not None:
                    path = "field_semantic_context." + field_code + ".time." + role
                    refs.append({"path": path, "field_code": field_code, "role": role,
                                 "ref": _check_ref(ref, path, role),
                                 "timezone": axis.get("timezone")})
    for item in refs:
        period_type = _time_axis(declaration, item["field_code"]).get("period_type")
        if item["role"] == ACCOUNTING_ROLE:
            if period_type not in (None, "accounting"):
                raise _err("CALENDAR_PERIOD_TYPE_MISMATCH", item["path"])
        elif period_type not in (None, "trading"):
            raise _err("CALENDAR_PERIOD_TYPE_MISMATCH", item["path"])
    return refs


def validate_declaration(declaration):
    """Create/reuse gate: shapes, purpose and period_type/ref coupling."""
    refs = extract(declaration)
    # period_type trading/accounting requires the corresponding ref
    for field_code in [None] + sorted((declaration.get("field_semantic_context") or {})):
        axis = merged_time_axis(declaration, field_code)
        prefix = ("semantic_context" if field_code is None
                  else "field_semantic_context." + field_code) + ".time."
        if axis.get("period_type") == "trading" and axis.get(CALENDAR_ROLE) is None:
            raise _err("CALENDAR_REF_REQUIRED", prefix + CALENDAR_ROLE)
        if axis.get("period_type") == "accounting" and axis.get(ACCOUNTING_ROLE) is None:
            raise _err("CALENDAR_REF_REQUIRED", prefix + ACCOUNTING_ROLE)
    return refs


def dependencies(declaration, dataset_id):
    """Existing five-key read_dependencies for the actual fixed refs."""
    deps, seen = [], set()
    for item in validate_declaration(declaration):
        ref = item["ref"]
        if ref["dataset_id"] != dataset_id:
            raise _err("CALENDAR_DATASET_MISMATCH", item["path"], ref["dataset_id"])
        identity = (ref["dataset_id"], ref["id"], ref["version"], item["role"])
        if identity in seen:
            continue
        seen.add(identity)
        deps.append({"dataset_id": ref["dataset_id"], "product_id": ref["id"],
                     "snapshot_id": ref["version"], "role": item["role"],
                     "required": True})
    return deps


def _snapshot_products(engine, snapshot_id, product_id):
    snapshot = engine.read_snapshot(snapshot_id)
    entries = [entry for entry in snapshot["files"] if entry["product_id"] == product_id]
    if not entries:
        raise ValueError("CALENDAR_PRODUCT_UNAVAILABLE:" + product_id)
    blocks = engine.read_product(product_id, snapshot_id=snapshot_id)
    parts = [{"output_key": entry["output_key"], "payload_kind": entry.get("payload_kind"),
              "rows": block["rows"], "source": block["source"]}
             for entry, block in zip(entries, blocks)]
    digest = product_content_digest(product_id, parts)
    definition = entries[0].get("definition") or {}
    return snapshot, entries, parts, digest, definition


def verify_fixed(engine, item, subject=None):
    """Verify pinned identity/digest/purpose.  Digest is full fixed product content,
    never a cutoff-filtered subset."""
    ref = item["ref"]
    snapshot, entries, parts, digest, definition = _snapshot_products(
        engine, ref["version"], ref["id"])
    if digest != ref["digest"]:
        raise _err("CALENDAR_DIGEST_MISMATCH", item["path"])
    calendar_subject = entries[0].get("subject") or {}
    if isinstance(subject, dict) and subject.get("kind") == "market":
        if calendar_subject != subject:
            raise _err("CALENDAR_MARKET_SUBJECT_MISMATCH", item["path"])
    elif (item["role"] == ACCOUNTING_ROLE and isinstance(subject, dict)
          and calendar_subject != subject):
        raise _err("CALENDAR_ACCOUNTING_SUBJECT_MISMATCH", item["path"])
    calendar_timezone = (((definition.get("semantic_context") or {}).get("time") or {})
                         .get("timezone"))
    if item.get("timezone") and calendar_timezone and item["timezone"] != calendar_timezone:
        raise _err("CALENDAR_TIMEZONE_MISMATCH", item["path"])
    semantic = str(definition.get("semantic_code") or "")
    if item["role"] == CALENDAR_ROLE:
        if semantic != TRADING_SEMANTIC:
            raise _err("CALENDAR_PURPOSE_UNSUPPORTED", item["path"], semantic)
        declared = {field.get("field_code") for field in definition.get("field_definitions", [])
                    if isinstance(field, dict)}
        missing = [field for field in TRADING_FIELDS if field not in declared]
        if missing:
            raise _err("CALENDAR_TRADING_FIELDS_INCOMPLETE", item["path"], ",".join(missing))
    else:
        roles = ((definition.get("semantic_context") or {}).get("time") or {}).get("roles") or {}
        if semantic != ACCOUNTING_SEMANTIC:
            raise _err("CALENDAR_PURPOSE_UNSUPPORTED", item["path"], semantic)
        missing = [role for role in ACCOUNTING_ROLES if not isinstance(roles.get(role), str)]
        if missing:
            raise _err("CALENDAR_ACCOUNTING_PROFILE_INCOMPLETE", item["path"], ",".join(missing))
        declared = {field.get("field_code") for field in definition.get("field_definitions", [])
                    if isinstance(field, dict)}
        missing = [roles[role] for role in ACCOUNTING_ROLES if roles[role] not in declared]
        if missing:
            raise _err("CALENDAR_ACCOUNTING_FIELDS_INCOMPLETE", item["path"], ",".join(missing))
    return {"snapshot": snapshot, "entries": entries, "parts": parts,
            "digest": digest, "definition": definition, "roles": ((definition.get(
                "semantic_context") or {}).get("time") or {}).get("roles") or {}}


def _row_value(row, field_code):
    values = row.get("values") if isinstance(row.get("values"), dict) else {}
    cell = values.get(field_code)
    return cell.get("value") if isinstance(cell, dict) else cell


def trading_rows(info):
    rows = []
    for part in info["parts"]:
        rows.extend(part["rows"])
    out, markets = [], set()
    for row in rows:
        value = {field: _row_value(row, field) for field in TRADING_FIELDS}
        try:
            date.fromisoformat(str(value["session_date"])[:10])
        except ValueError as exc:
            raise ValueError("CALENDAR_TRADING_DATE_INVALID") from exc
        if not isinstance(value["is_open"], bool):
            raise ValueError("CALENDAR_TRADING_OPEN_INVALID")
        markets.add(value["market_code"])
        out.append(value)
    if len(markets) != 1:
        raise ValueError("CALENDAR_MARKET_AMBIGUOUS:" + ",".join(sorted(str(m) for m in markets)))
    return out, next(iter(markets))


def accounting_rows(info):
    roles = info["roles"]
    rows = []
    for part in info["parts"]:
        rows.extend(part["rows"])
    out = []
    for row in rows:
        value = {role: _row_value(row, roles[role]) for role in ACCOUNTING_ROLES}
        for label_role in ("fiscal_year_label", "period_label", "report_type"):
            if not isinstance(value[label_role], str) or not value[label_role].strip():
                raise ValueError("CALENDAR_ACCOUNTING_LABEL_REQUIRED:" + label_role)
        try:
            start = date.fromisoformat(str(value["period_start_date"]))
            end = date.fromisoformat(str(value["period_end_exclusive_date"]))
        except ValueError as exc:
            raise ValueError("CALENDAR_PERIOD_DATE_INVALID") from exc
        if start >= end:
            raise ValueError("CALENDAR_PERIOD_RANGE_INVALID")
        value["_start"], value["_end"] = start, end
        out.append(value)
    return sorted(out, key=lambda item: item["_start"])


def accounting_identity(value):
    return (value.get("fiscal_year_label"), value.get("period_label"),
            value.get("report_type"))


def main_accounting_labels(declaration, row):
    roles = ((declaration.get("semantic_context") or {}).get("time") or {}).get("roles") or {}
    values = row.get("values") if isinstance(row.get("values"), dict) else {}
    labels = {}
    for role in ("fiscal_year_label", "period_label", "report_type"):
        field_code = roles.get(role)
        if isinstance(field_code, str):
            cell = values.get(field_code)
            labels[role] = cell.get("value") if isinstance(cell, dict) else None
    financial = (declaration.get("semantic_context") or {}).get("financial") or {}
    report_field = financial.get("report_type")
    if isinstance(report_field, str) and labels.get("report_type") is None:
        cell = values.get(report_field)
        labels["report_type"] = cell.get("value") if isinstance(cell, dict) else None
    return {key: value for key, value in labels.items() if value is not None}


def check_trading_coverage(rows, start, end):
    """Required dates (inclusive) must be declared by the fixed calendar rows."""
    wanted, cursor = set(), date.fromisoformat(start)
    stop = date.fromisoformat(end)
    while cursor <= stop:
        wanted.add(cursor.isoformat())
        cursor += timedelta(days=1)
    seen = {str(row["session_date"])[:10] for row in rows}
    missing = sorted(wanted - seen)
    if missing:
        raise ValueError("CALENDAR_DATE_COVERAGE_MISSING:" + missing[0])
    return sorted(wanted)


def check_accounting_coverage(rows, start, end):
    wanted, matches = date.fromisoformat(start), []
    for row in rows:
        if row["_start"] <= wanted < row["_end"]:
            matches.append(row)
    if len(matches) != 1:
        raise ValueError("CALENDAR_PERIOD_COVERAGE_" + ("MISSING" if not matches else "AMBIGUOUS"))
    return matches[0]


def resolve_eligibility(service, item, *, perspective, at, held_scope, usable_stage):
    """Same perspective/cutoff/held scope as the main record read."""
    ref = item["ref"]
    try:
        read = service.read(ref["id"], snapshot_id=ref["version"], perspective=perspective,
                            at=at, held_scope=held_scope, usable_stage=usable_stage,
                            include_history=True)
        rows = [row.get("row") or {} for row in read.get("rows", [])]
        if not rows:
            reasons = {diag.get("reason") for diag in read.get("diagnostics", [])}
            if "time_interval_starts_after_cutoff" in reasons:
                return {"status": "not_yet", "rows": [], "reason": reasons}
            return {"status": "unknown", "rows": [], "reason": reasons or "no_eligible_rows"}
        return {"status": "eligible", "rows": rows, "read": read}
    except ValueError as exc:
        code = str(exc).split(":", 1)[0]
        if code in {"INSTANCE_HOLDING_NOT_YET_AVAILABLE"}:
            return {"status": "not_yet", "rows": [], "reason": code}
        return {"status": "unknown", "rows": [], "reason": code}


def eligible_leaf_items(service, item, *, perspective, at, held_scope, usable_stage):
    """Eligibility first, then per-logical-key revision leaves.

    A withdrawn/conflicting key is reported only for that key; other keys stay
    usable.  Matching callers must first match their required date/period and
    only then consume that record's decision.
    """
    ref = item["ref"]
    try:
        read = service.read(ref["id"], snapshot_id=ref["version"],
                            perspective=perspective, at=at,
                            held_scope=held_scope, usable_stage=usable_stage,
                            include_history=True)
    except ValueError as exc:
        code = str(exc).split(":", 1)[0]
        return {"status": "not_yet" if code == "INSTANCE_HOLDING_NOT_YET_AVAILABLE"
                else "unknown", "items": [], "keys": {}, "reason": code}
    if not read.get("rows"):
        reasons = {d.get("reason") for d in read.get("diagnostics", [])}
        status = "not_yet" if "time_interval_starts_after_cutoff" in reasons else "unknown"
        return {"status": status, "items": [], "keys": {},
                "reason": sorted(str(reason) for reason in reasons)}
    grouped = {}
    for row in read["rows"]:
        key = (row.get("record_ref") or {}).get("logical_key")
        grouped.setdefault(key, []).append(row)
    items, keys = [], {}
    for key, group in grouped.items():
        leaves = service._version_leaves(group)
        if len(leaves) != 1:
            keys[key] = {"status": "conflict", "items": copy.deepcopy(leaves)}
            for leaf in leaves:
                leaf = copy.deepcopy(leaf)
                leaf["calendar_record_status"] = "conflict"
                items.append(leaf)
            continue
        leaf = copy.deepcopy(leaves[0])
        if (leaf.get("revision") or {}).get("withdrawn"):
            leaf["calendar_record_status"] = "withdrawn"
            keys[key] = {"status": "withdrawn", "items": [leaf]}
        else:
            leaf["calendar_record_status"] = "eligible"
            keys[key] = {"status": "eligible", "items": [leaf]}
        items.append(leaf)
    statuses = {value["status"] for value in keys.values()}
    overall = ("eligible" if statuses == {"eligible"}
               else "unknown" if statuses == {"unknown"} or not statuses
               else "mixed")
    return {"status": overall, "items": items, "keys": keys, "reason": None}


def row_values(row_item):
    row = row_item.get("row") or {}
    return row.get("values") if isinstance(row.get("values"), dict) else {}


def cell_value(row_item, field_code):
    cell = row_values(row_item).get(field_code)
    return cell.get("value") if isinstance(cell, dict) else cell
