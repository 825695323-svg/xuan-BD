"""Contract adapter for text/null tabular batches. Storage and lifecycle are shared."""
from __future__ import annotations

import re
from unicodedata import category
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

STORAGE_NAMESPACE = "tabular"
PROTOCOL = "wfd.tabular-batch/1"
CONTRACT = "wfd.tabular-contract/1"
MAX_FIELDS = 64
KEY_ALGORITHM = "wfd.tabular-key/1"
SNAPSHOT_FORMAT = "wfd.tabular-snapshot/1"
# ECMAScript whitespace plus the additional whitespace accepted by the bulk
# compiler. Explicitly match FEFF as ECMAScript does, unlike Python strip().
_BLANK = re.compile(r"[\s\ufeff]*\Z")


def valid_partition(value):
    return (isinstance(value, str) and 0 < len(value.encode("utf-8")) <= 512
            and not any(category(ch) == "Cc" for ch in value))


def validate_contract(header):
    from .indexed_bulk import _CODE, _exact, _matches, digest

    contract = header["table_contract"]
    _exact(contract, "version fields key_fields partition_field time digest", "BULK_TABLE_CONTRACT_INVALID")
    fields, keys, partition_field, time = (contract[key] for key in ("fields", "key_fields", "partition_field", "time"))
    if (contract["version"] != CONTRACT
            or not isinstance(fields, list) or not 1 <= len(fields) <= MAX_FIELDS
            or not all(_matches(_CODE, field) for field in fields) or len(set(fields)) != len(fields)
            or fields != header["field_codes"]
            or not isinstance(keys, list) or not keys or not all(isinstance(key, str) and key in fields for key in keys)
            or len(set(keys)) != len(keys) or partition_field is not None and partition_field not in fields
            or contract["digest"] != digest({k: v for k, v in contract.items() if k != "digest"})):
        raise ValueError("BULK_TABLE_CONTRACT_INVALID")
    partition = header["partition"]
    _exact(partition, "value", "BULK_PARTITION_INVALID")
    if not valid_partition(partition["value"]):
        raise ValueError("BULK_PARTITION_INVALID")
    if isinstance(time, dict) and time.get("kind") == "unknown":
        _exact(time, "kind", "BULK_TABLE_TIME_INVALID")
        return
    _exact(time, "kind date_field minute_field timezone", "BULK_TABLE_TIME_INVALID")
    if (time["kind"] != "source_minute" or time["date_field"] not in fields or time["minute_field"] not in fields
            or time["date_field"] == time["minute_field"] or not isinstance(time["timezone"], str)
            or not 1 <= len(time["timezone"]) <= 128):
        raise ValueError("BULK_TABLE_TIME_INVALID")
    try:
        ZoneInfo(time["timezone"])
    except (ZoneInfoNotFoundError, ValueError, UnicodeError) as exc:
        raise ValueError("BULK_TABLE_TIME_INVALID") from exc


def identity_rule(contract):
    from .duckdb_sdk import canonical

    return KEY_ALGORITHM + ":" + canonical({key: contract[key] for key in ("key_fields", "partition_field")}).decode("utf-8")


def semantic_row(header, cells):
    from .indexed_bulk import _MINUTE, _matches, observation_bounds
    from .duckdb_sdk import canonical, sha

    contract = header["table_contract"]
    partition = header["partition"]["value"]
    values = dict(zip(header["field_codes"], cells, strict=True))
    field = contract["partition_field"]
    if field is not None and values[field] != partition:
        raise ValueError("BULK_ROW_PARTITION_MISMATCH")
    keys = [values[key] for key in contract["key_fields"]]
    if any(not isinstance(key, str) or _BLANK.fullmatch(key) for key in keys):
        raise ValueError("BULK_ROW_IDENTITY_INVALID")
    time = contract["time"]
    observation = {"status": "unknown"}
    if time["kind"] == "source_minute":
        date, minute = values[time["date_field"]], values[time["minute_field"]]
        if not _matches(_MINUTE, minute) or minute[:10].replace("-", "") != date:
            raise ValueError("BULK_ROW_TIME_INVALID")
        earliest, latest = observation_bounds(minute, time["timezone"])
        observation = {"status": "known", "earliest_utc": earliest, "latest_exclusive_utc": latest,
                       "precision": "minute", "source_timezone": time["timezone"]}
    key = "tabular_" + sha(canonical([partition, keys]))
    return tuple(key.encode("utf-8") for key in keys), {
        "business_key": key, "subject": header["outputs"][0]["subject"], "observation_time": observation,
        "values": {code: {"data_type": "text", "value_state": "unknown" if value is None else "valid_value",
                         "value": value} for code, value in values.items()},
    }


def validate_definition(header, declaration):
    from . import product_calendar

    contract = header["table_contract"]
    semantic = declaration.get("semantic_context") or {}
    axes = (semantic.get("identity") or {}).get("identity_resolution_rule")
    time = semantic.get("time") or {}
    fields = declaration.get("field_definitions", [])
    if (axes != identity_rule(contract) or semantic.get("content_nature") != "source_claim"
            or [field["field_code"] for field in fields] != contract["fields"]
            or any(field["data_type"] != "text" for field in fields)
            or declaration.get("algorithm_definition") is not None
            or product_calendar.validate_declaration(declaration)):
        raise ValueError("BULK_DEFINITION_SCOPE_INVALID")
    mapping = contract["time"]
    if mapping["kind"] == "source_minute":
        contexts = declaration.get("field_semantic_context") or {}
        def assertion(code):
            return ((contexts.get(code) or {}).get("content") or {}).get("assertion_status")
        if (time.get("period_type") != "natural" or time.get("frequency") != "source_reported_minute"
                or time.get("timezone") != mapping["timezone"] or time.get("interval") != "half_open"
                or (time.get("roles") or {}).get("business_interval") != "minute_label_bucket_not_verified_bar_interval"
                or assertion(mapping["date_field"]) != "source_reported_date_label"
                or assertion(mapping["minute_field"]) != "source_reported_minute_label"):
            raise ValueError("BULK_DEFINITION_SCOPE_INVALID")
    elif time not in ({}, {"roles": {}}, {"roles": {"public_time": "unknown"}}):
        raise ValueError("BULK_DEFINITION_SCOPE_INVALID")
