"""Semantic adapter for the historical whole-date source-minute format."""
from datetime import datetime

from .duckdb_sdk import canonical, sha

STORAGE_NAMESPACE = "source_minute"
PROTOCOL = "wfd.source-minute-batch/1"
KEY_ALGORITHM = "wfd.source-minute-key/1"
SNAPSHOT_FORMAT = "wfd.source-minute-snapshot/1"


def validate_contract(header):
    from .indexed_bulk import _CODE, _DATE, _exact, _matches

    fields = header["field_codes"]
    if (not isinstance(fields, list) or len(fields) != 11
            or not all(_matches(_CODE, code) for code in fields) or len(set(fields)) != 11):
        raise ValueError("BULK_FIELDS_INVALID")
    partition = header["partition"]
    _exact(partition, "date date_field minute_field identity_field timezone key_algorithm", "BULK_PARTITION_INVALID")
    axes = [partition[key] for key in ("date_field", "minute_field", "identity_field")]
    if (not all(isinstance(axis, str) and axis in fields for axis in axes) or len(set(axes)) != 3
            or partition["timezone"] != "Asia/Shanghai" or partition["key_algorithm"] != KEY_ALGORITHM
            or not _matches(_DATE, partition["date"])):
        raise ValueError("BULK_PARTITION_INVALID")
    try:
        datetime.strptime(partition["date"], "%Y%m%d")
    except ValueError as exc:
        raise ValueError("BULK_PARTITION_INVALID") from exc


def identity_rule(partition):
    projection = {key: partition[key] for key in ("date_field", "minute_field", "identity_field")}
    return KEY_ALGORITHM + ":" + canonical({
        **projection, "order": ["identity UTF-8 bytes", "minute UTF-8 bytes"],
        "record_id": "source_minute_YYYYMMDD_ + SHA256(canonical([identity,minute]))",
    }).decode("utf-8")


def semantic_row(header, cells):
    from .indexed_bulk import _MINUTE, _matches, observation_bounds

    partition = header["partition"]
    values = dict(zip(header["field_codes"], cells, strict=True))
    date = values[partition["date_field"]]
    minute = values[partition["minute_field"]]
    identity = values[partition["identity_field"]]
    if date != partition["date"] or not _matches(_MINUTE, minute) or minute[:10].replace("-", "") != date:
        raise ValueError("BULK_ROW_PARTITION_MISMATCH")
    if not isinstance(identity, str) or not identity.strip():
        raise ValueError("BULK_ROW_IDENTITY_INVALID")
    earliest, latest = observation_bounds(minute, partition["timezone"])
    business_key = "source_minute_" + date + "_" + sha(canonical([identity, minute]))
    row = {"business_key": business_key, "subject": header["outputs"][0]["subject"],
           "observation_time": {"status": "known", "earliest_utc": earliest,
                                "latest_exclusive_utc": latest,
                                "precision": "minute", "source_timezone": partition["timezone"]},
           "values": {code: {"data_type": "text", "value_state": "unknown" if value is None else "valid_value",
                            "value": value} for code, value in values.items()}}
    return (identity.encode("utf-8"), minute.encode("utf-8")), row


def validate_definition(header, declaration):
    from . import product_calendar

    field_codes, partition = header["field_codes"], header["partition"]

    semantic = declaration.get("semantic_context") or {}
    axes = (semantic.get("identity") or {}).get("identity_resolution_rule", "")
    time = semantic.get("time") or {}
    fields = {field["field_code"]: field for field in declaration.get("field_definitions", [])}
    contexts = declaration.get("field_semantic_context") or {}
    assertions = {code: (context.get("content") or {}).get("assertion_status")
                  for code, context in contexts.items()}
    unknown_measurements = {code for code, assertion in assertions.items()
                            if assertion == "source_reported_lexeme_unit_unknown"}
    date_code, minute_code, identity_code = (partition[name] for name in ("date_field", "minute_field", "identity_field"))
    if (axes != identity_rule(partition) or semantic.get("content_nature") != "source_claim"
            or time.get("period_type") != "natural" or time.get("frequency") != "source_reported_minute"
            or time.get("timezone") != partition["timezone"] or time.get("interval") != "half_open"
            or (time.get("roles") or {}).get("business_interval") != "minute_label_bucket_not_verified_bar_interval"
            or declaration.get("unit_code") != "per_field" or set(fields) != set(field_codes)
            or assertions.get(date_code) != "source_reported_date_label"
            or assertions.get(minute_code) != "source_reported_minute_label"
            or assertions.get(identity_code) != "source_reported_identity_label"
            or len(unknown_measurements) != 7 or not unknown_measurements <= set(fields)
            or any(assertions.get(code) != "source_reported_observation"
                   for code in set(fields) - unknown_measurements - {date_code, minute_code, identity_code})
            or declaration.get("algorithm_definition") is not None
            or any(field["data_type"] != "text" or field.get("unit_code") != (
                "date" if code == partition["date_field"] else "not_applicable") for code, field in fields.items())
            or product_calendar.validate_declaration(declaration)):
        raise ValueError("BULK_DEFINITION_SCOPE_INVALID")
