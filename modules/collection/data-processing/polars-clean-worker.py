"""Strict Polars column cleaning. No arbitrary code, filesystem, database or network access.

This is the cleaning engine, NOT the financial formula/indicator execution worker.
Only explicitly declared trim and empty-to-null operations are accepted.
Original cells/evidence stay with the existing TypeScript production plan.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys

os.environ["POLARS_MAX_THREADS"] = "2"
import polars as pl

VERSION = "bd.polars-clean/1"
POLARS_VERSION = "2.0.0"
MAX_ROWS = 2500
MAX_FIELDS = 256


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def reject(code):
    raise ValueError(code)


def execute(request):
    if pl.__version__ != POLARS_VERSION:
        reject("POLARS_VERSION_MISMATCH")
    if not isinstance(request, dict) or set(request) != {"version", "operation", "columns", "rows", "rules"}:
        reject("CLEAN_REQUEST_INVALID")
    if request["version"] != VERSION or request["operation"] != "clean":
        reject("CLEAN_OPERATION_UNSUPPORTED")
    columns, rows, rules = request["columns"], request["rows"], request["rules"]
    if not isinstance(columns, list) or not 1 <= len(columns) <= MAX_FIELDS or (
        any(not isinstance(c, str) or not c or len(c) > 512 for c in columns)
        or len(set(columns)) != len(columns)
    ):
        reject("CLEAN_COLUMNS_INVALID")
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_ROWS:
        reject("CLEAN_ROWS_INVALID")
    if not isinstance(rules, dict) or set(rules) != {"trim", "emptyToNull"}:
        reject("CLEAN_RULES_INVALID")
    trim, empty = rules["trim"], rules["emptyToNull"]
    if any(not isinstance(items, list) or len(set(map(str, items))) != len(items)
           or any(not isinstance(v, str) or v not in columns for v in items)
           for items in (trim, empty)):
        reject("CLEAN_RULES_INVALID")
    if any(not isinstance(row, list) or len(row) != len(columns)
           or any(value is not None and (not isinstance(value, str) or len(value) > 131072) for value in row)
           for row in rows):
        reject("CLEAN_CELL_INVALID")

    # Explicit String schema; strict=True refuses implicit type inference or coercion.
    names = [f"c{i}" for i in range(len(columns))]
    frame = pl.DataFrame([
        pl.Series(name, [row[i] for row in rows], dtype=pl.String, strict=True)
        for i, name in enumerate(names)
    ]).lazy()
    expressions = []
    for i, column in enumerate(columns):
        value = pl.col(names[i])
        if column in trim:
            value = value.str.strip_chars()
        if column in empty:
            value = pl.when(value == "").then(pl.lit(None, dtype=pl.String)).otherwise(value)
        expressions.append(value.alias(names[i]))
    result = frame.select(expressions).collect(engine="streaming")
    return [list(row) for row in result.iter_rows()]


def main():
    raw = sys.stdin.buffer.read(1_800_001)
    if len(raw) > 1_800_000:
        reject("CLEAN_INPUT_BUDGET")
    request = json.loads(raw)
    rows = execute(request)
    output = {
        "version": VERSION,
        "executor": "polars",
        "polars_version": pl.__version__,
        "operation": "clean",
        "input_sha256": hashlib.sha256(canonical(request)).hexdigest(),
        "rows": rows,
    }
    data = canonical(output)
    if len(data) > 2_000_000:
        reject("CLEAN_OUTPUT_BUDGET")
    sys.stdout.buffer.write(data + b"\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error).split(":", 1)[0]
        print(json.dumps({
            "ok": False,
            "code": code if re.fullmatch(r"[A-Z][A-Z0-9_]{1,64}", code) else "CLEAN_REJECTED",
            "message": str(error)[:400],
        }, ensure_ascii=False))
