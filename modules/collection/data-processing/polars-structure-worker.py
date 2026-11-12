"""Strict declared schema conversion via the dedicated Polars cleaning/structuring engine.

Only frozen, explicitly declared scalar column types are supported. Values retain their
source lexemes and original evidence in TypeScript. No silent casts, rounding, row drops,
unrecognized null generation, external data reads, arbitrary code or algorithm execution.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import struct
import sys

os.environ["POLARS_MAX_THREADS"] = "2"
import polars as pl

VERSION = "bd.polars-structure/1"
POLARS_VERSION = "2.0.0"
MAX_ROWS = 2500
MAX_FIELDS = 256
TYPES = {"string", "safe_integer", "decimal_string", "boolean", "binary64_hex"}
NUMBER = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?\Z")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def decimal(value):
    if not isinstance(value, str) or len(value) > 1024 or not NUMBER.fullmatch(value):
        raise ValueError("STRUCTURE_NUMBER_INVALID")
    matched = re.fullmatch(r"(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?", value)
    exponent = int(matched.group(4) or 0)
    if abs(exponent) > 1024:
        raise ValueError("STRUCTURE_NUMBER_PRECISION")
    fraction = matched.group(3) or ""
    digits = (matched.group(2) + fraction).lstrip("0") or "0"
    scale = len(fraction) - exponent
    while scale > 0 and digits.endswith("0"):
        digits = digits[:-1] or "0"
        scale -= 1
    if digits == "0":
        return "0"
    if scale <= 0:
        digits += "0" * -scale
    elif scale >= len(digits):
        digits = "0." + "0" * (scale - len(digits)) + digits
    else:
        digits = digits[:-scale] + "." + digits[-scale:]
    return ("-" if matched.group(1) else "") + digits


def cast_value(item, typ):
    value, kind = item["value"], item["kind"]
    if value is None:
        return None
    if not isinstance(value, str) or kind not in ("string", "number", "boolean"):
        raise ValueError("STRUCTURE_SOURCE_INVALID")
    if typ == "string":
        return value
    if typ == "boolean":
        if kind == "boolean":
            if value not in ("true", "false"):
                raise ValueError("STRUCTURE_TYPE_INVALID")
        elif kind != "string" or value not in ("true", "false"):
            raise ValueError("STRUCTURE_TYPE_INVALID")
        return value == "true"
    if kind == "boolean":
        raise ValueError("STRUCTURE_TYPE_INVALID")
    if typ == "decimal_string":
        result = decimal(value)
        if len(result) > 128:
            raise ValueError("STRUCTURE_NUMBER_PRECISION")
        return result
    if typ == "safe_integer":
        result = decimal(value)
        if "." in result:
            raise ValueError("STRUCTURE_NUMBER_PRECISION")
        number = int(result)
        if abs(number) > 9007199254740991:
            raise ValueError("STRUCTURE_NUMBER_PRECISION")
        return number
    if typ == "binary64_hex":
        if re.fullmatch(r"[0-9a-f]{16}", value):
            number = struct.unpack(">d", bytes.fromhex(value))[0]
            if math.isfinite(number):
                return value
            raise ValueError("STRUCTURE_NUMBER_PRECISION")
        decimal(value)
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("STRUCTURE_NUMBER_PRECISION")
        return struct.pack(">d", number).hex()
    raise ValueError("STRUCTURE_TYPE_INVALID")


def execute(request):
    if pl.__version__ != POLARS_VERSION:
        raise ValueError("POLARS_VERSION_MISMATCH")
    if not isinstance(request, dict) or set(request) != {"version", "operation", "columns", "rows", "types"}:
        raise ValueError("STRUCTURE_REQUEST_INVALID")
    if request["version"] != VERSION or request["operation"] != "structure":
        raise ValueError("STRUCTURE_OPERATION_UNSUPPORTED")
    columns, rows, types = request["columns"], request["rows"], request["types"]
    if not isinstance(columns, list) or not 1 <= len(columns) <= MAX_FIELDS or (
        any(not isinstance(x, str) or not x or len(x) > 512 for x in columns) or len(set(columns)) != len(columns)
    ):
        raise ValueError("STRUCTURE_COLUMNS_INVALID")
    if not isinstance(types, dict) or any(column not in columns or typ not in TYPES
        for column, typ in types.items()):
        raise ValueError("STRUCTURE_TYPES_INVALID")
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_ROWS:
        raise ValueError("STRUCTURE_ROWS_INVALID")
    for row in rows:
        if not isinstance(row, list) or len(row) != len(columns):
            raise ValueError("STRUCTURE_ROWS_INVALID")
        for cell in row:
            if (not isinstance(cell, dict) or set(cell) != {"value", "kind"}
                or cell["kind"] not in ("string", "number", "boolean", "null")
                or (cell["value"] is not None and
                    (not isinstance(cell["value"], str) or len(cell["value"]) > 131072))):
                raise ValueError("STRUCTURE_SOURCE_INVALID")
    # Explicit String source schema. The per-column conversion UDF is evaluated by Polars
    # with fixed output dtype; no 'strict=False' fallback or null-on-invalid conversion.
    results = [[None for _ in columns] for _ in rows]
    for column_index, column in enumerate(columns):
        typ = types.get(column)
        if typ is None:
            # Unspecified columns are identity: they are not authorized type conversions.
            for row_index, row in enumerate(rows):
                results[row_index][column_index] = row[column_index]["value"]
            continue
        data = [row[column_index] for row in rows]
        frame = pl.DataFrame({
            "value": pl.Series("value", [v["value"] for v in data], dtype=pl.String, strict=True),
            "kind": pl.Series("kind", [v["kind"] for v in data], dtype=pl.String, strict=True),
        }).lazy()
        return_type = pl.Int64 if typ == "safe_integer" else pl.Boolean if typ == "boolean" else pl.String
        expression = pl.struct(["value", "kind"]).map_elements(
            lambda item, typ=typ: cast_value(item, typ), return_dtype=return_type
        ).alias("converted")
        output = frame.select(expression).collect(engine="streaming")["converted"].to_list()
        if len(output) != len(rows):
            raise ValueError("STRUCTURE_ROW_COUNT")
        for row_index, value in enumerate(output):
            # None can only come from a true original null. Failed casts never return None.
            if value is None and data[row_index]["value"] is not None:
                raise ValueError("STRUCTURE_SILENT_NULL")
            results[row_index][column_index] = value
    return results


def main():
    raw = sys.stdin.buffer.read(1_800_001)
    if len(raw) > 1_800_000:
        raise ValueError("STRUCTURE_INPUT_BUDGET")
    request = json.loads(raw)
    rows = execute(request)
    output = {
        "version": VERSION, "executor": "polars",
        "polars_version": pl.__version__, "operation": "structure",
        "input_sha256": hashlib.sha256(canonical(request)).hexdigest(), "rows": rows,
    }
    data = canonical(output)
    if len(data) > 2_000_000:
        raise ValueError("STRUCTURE_OUTPUT_BUDGET")
    sys.stdout.buffer.write(data + b"\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        value = str(error).split(":", 1)[0]
        print(json.dumps({"ok": False, "code": value if re.fullmatch(r"[A-Z][A-Z0-9_]{1,64}", value)
                          else "STRUCTURE_REJECTED", "message": str(error)[:400]}, ensure_ascii=False))
