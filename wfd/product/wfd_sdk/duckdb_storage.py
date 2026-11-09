"""Official DuckDB-backed Parquet/ZSTD **candidate** for WFD.

This replaces the home-grown limited parquet_lite writer/reader. DuckDB must
actually be importable; no silent fallback is permitted. This is a small-batch
proof-of-concept that stages a temporary file, not the future bulk writer.

Every Parquet file carries typed columns for identity, time, scalar numbers,
per-field numerical values, relation edges or event coordinates. `row_json`
is retained for *lossless protocol round trip only*: it is redundant and
MUST be removed/replaced by a versioned schema mapping before bulk scale use.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import importlib
import json
from pathlib import Path
import re
import tempfile
from typing import Any


DUCKDB_STORAGE_FORMAT = 'parquet_duckdb_zstd_typed_columns_poc'


def require_duckdb():
    try:
        return importlib.import_module('duckdb')
    except ImportError as exc:
        raise RuntimeError('DUCKDB_RUNTIME_MISSING: install the official duckdb Python wheel; no experimental writer fallback') from exc


def _ident(col: str) -> str:
    return '"' + col.replace('"', '""') + '"'


def _pathstr(path: Path) -> str:
    return "'" + str(path).replace("'", "''") + "'"


def _instant(t: dict | None, boundary: str = 'earliest_utc') -> datetime | None:
    if not t or t.get('status') != 'known':
        return None
    raw = t.get(boundary)
    if not raw:
        return None
    if not raw.endswith('Z'):
        raise ValueError('NON_UTC_TIME_IN_WFD_CONTRACT')
    # BASE 1.0: seconds, no implicit truncation of sub-second values.
    if '.' in raw:
        raise ValueError('UNSUPPORTED_SUBSECOND_TIME')
    parsed = datetime.strptime(raw, '%Y-%m-%dT%H:%M:%SZ')
    return parsed  # Naive TIMESTAMP defined by column suffix as UTC.


def _decimal_precision_scale(vals: list[Any]) -> int:
    max_integer=1; scale=0
    for v in vals:
        if v is None:
            continue
        try:
            d=Decimal(str(v))
        except (InvalidOperation,ValueError) as exc:
            raise ValueError('INVALID_DECIMAL_FOR_NATIVE_COLUMN') from exc
        if not d.is_finite():
            raise ValueError('NON_FINITE_DECIMAL')
        tup=d.as_tuple(); digits=len(tup.digits); exp=tup.exponent
        scale=max(scale,max(-exp,0))
        max_integer=max(max_integer, max(digits+exp,0))
    if scale > 38 or scale+max_integer > 38:
        raise ValueError('DECIMAL_PRECISION_EXCEEDS_38: use a different declared numeric encoding')
    return scale


def _sqltype(dtype: str, cells: list[dict | None]) -> str:
    if dtype in ('decimal','integer'):
        values=[c.get('value') for c in cells if c and c.get('value') is not None]
        scale=_decimal_precision_scale(values)
        if dtype == 'integer' and scale > 0:
            raise ValueError('INTEGER_CELL_HAS_FRACTION')
        return f'DECIMAL(38,{scale})'
    if dtype in ('string','text','categorical'):
        return 'VARCHAR'
    if dtype in ('boolean','bool'):
        return 'BOOLEAN'
    # Strict: unknown type should not be guessed as a number.
    raise ValueError('UNSUPPORTED_NATIVE_FIELD_TYPE: '+dtype)


def _cell_value(c: dict | None, dtype: str):
    if c is None or c.get('value') is None:
        return None
    value=c['value']
    if dtype in ('decimal','integer'):
        return Decimal(str(value))
    if dtype in ('boolean','bool'):
        if value in (True, 'true','True','1'):return True
        if value in (False,'false','False','0'):return False
        raise ValueError('INVALID_BOOLEAN_CELL')
    return str(value)


def _native_schema(payload_kind: str, rows: list[dict]) -> list[tuple[str,str,Any]]:
    """Return (column, duckdb SQL type, extractor(row)->native value)."""
    columns=[
        ('_wfd_row_index','BIGINT',None),
        ('product_id','VARCHAR',None),
        ('output_key','VARCHAR',None),
        ('subject_id','VARCHAR',None),
        ('business_key','VARCHAR',None),
        ('payload_kind','VARCHAR',None),
        ('time_start_utc','TIMESTAMP',lambda r: _instant(r.get('observation_time') or r.get('public_time') or r.get('event_time') or r.get('effective_period'))),
        ('time_end_exclusive_utc','TIMESTAMP',lambda r: _instant(r.get('observation_time') or r.get('public_time') or r.get('event_time') or r.get('effective_period'), 'latest_exclusive_utc')),
        ('time_precision','VARCHAR',lambda r: (r.get('observation_time') or r.get('public_time') or r.get('event_time') or r.get('effective_period') or {}).get('precision')),
    ]
    if payload_kind == 'scalar_rows':
        vals=[r.get('value_decimal') for r in rows]
        scale=_decimal_precision_scale(vals)
        columns.extend([
            ('value_decimal', f'DECIMAL(38,{scale})',lambda r:Decimal(r['value_decimal']) if r.get('value_decimal') is not None else None),
            ('value_state','VARCHAR', lambda r:r.get('value_state')),
        ])
    elif payload_kind == 'tabular_rows':
        keys=sorted({k for row in rows for k in row.get('values',{})})
        used={col[0] for col in columns}
        for code in keys:
            cells=[row.get('values',{}).get(code) for row in rows]
            data_types={c['data_type'] for c in cells if c is not None}
            if len(data_types)!=1: raise ValueError('MIXED_FIELD_TYPES_IN_BATCH: '+code)
            data_type=next(iter(data_types))
            # prefix names to avoid collision with reserved keys.
            safe=''.join(x if (x.isalnum() and x.isascii()) or x == '_' else '_' for x in code)
            if not safe or not safe[0].isalpha():
                raise ValueError('UNSAFE_FIELD_CODE: '+code)
            if len(safe) > 60:
                # Legal logical field codes can exceed the physical-name budget.
                # Keep them verbatim in row_json and use a disjoint, bounded native name.
                if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.:-]{0,127}', code):
                    raise ValueError('UNSAFE_FIELD_CODE: '+code)
                cname='mhash_'+hashlib.sha256(code.encode('ascii')).hexdigest()[:48]
            else:
                cname='metric_'+safe
            if cname in used or cname+'_state' in used:raise ValueError('NORMALIZED_COLUMN_COLLISION: '+code)
            used.add(cname);used.add(cname+'_state')
            columns.append((cname,_sqltype(data_type,cells), lambda r,k=code,dt=data_type:_cell_value(r.get('values',{}).get(k),dt)))
            columns.append((cname+'_state','VARCHAR',lambda r,k=code:(r.get('values',{}).get(k) or {}).get('value_state')))
    elif payload_kind == 'relation_edges':
        columns.extend([
            ('edge_subject_id','VARCHAR',lambda r:(r.get('subject') or {}).get('id')),
            ('edge_object_id','VARCHAR',lambda r:(r.get('object') or {}).get('id')),
            ('edge_relation_type','VARCHAR',lambda r:r.get('relation_type')),
            ('effective_from_utc','TIMESTAMP',lambda r:_instant(r.get('effective_period'))),
            ('effective_to_exclusive_utc','TIMESTAMP',lambda r:_instant(r.get('effective_period'),'latest_exclusive_utc')),
            ('public_from_utc','TIMESTAMP',lambda r:_instant(r.get('public_time'))),
        ])
    elif payload_kind == 'event_records':
        columns.extend([
            ('event_id','VARCHAR',lambda r:r.get('event_id')),
            ('case_id','VARCHAR',lambda r:r.get('case_id')),
            ('event_type','VARCHAR',lambda r:r.get('event_type')),
            ('content_nature','VARCHAR',lambda r:r.get('content_nature')),
            ('event_status','VARCHAR',lambda r:r.get('status')),
            ('public_from_utc','TIMESTAMP',lambda r:_instant(r.get('public_time'))),
            ('event_from_utc','TIMESTAMP',lambda r:_instant(r.get('event_time'))),
            ('expected_from_utc','TIMESTAMP',lambda r:_instant(r.get('expected_time'))),
        ])
    else:
        raise ValueError('UNSUPPORTED_PAYLOAD_KIND: '+payload_kind)
    columns.append(('row_json','VARCHAR',lambda r:json.dumps(r,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)))
    return columns


def parquet_from_rows(product_id:str,output_key:str,subject:dict,payload_kind:str,rows:list[dict]) -> bytes:
    """Minimal in-memory-batch prototype. Production must stream to staging."""
    duckdb=require_duckdb()
    if not rows:
        raise ValueError('EMPTY_ROWS')
    cols=_native_schema(payload_kind,rows)
    with tempfile.TemporaryDirectory(prefix='wfd_duckdb_write_') as tmpdir:
        dest=Path(tmpdir)/'batch.parquet'
        conn=duckdb.connect(database=':memory:')
        try:
            conn.execute('CREATE TABLE wfd_candidate ('+', '.join(f'{_ident(k)} {dtype}' for k,dtype,_ in cols)+')')
            placeholders=','.join('?' for _ in cols)
            packed=[]
            for i,r in enumerate(rows):
                base={'_wfd_row_index':i,'product_id':product_id,'output_key':output_key,
                      'subject_id':subject['id'],'business_key':r.get('business_key',r.get('event_id','')),
                      'payload_kind':payload_kind}
                packed.append(tuple(base[k] if k in base else extractor(r) for k,_,extractor in cols))
            conn.executemany(f'INSERT INTO wfd_candidate VALUES ({placeholders})',packed)
            conn.execute(f'COPY (SELECT * FROM wfd_candidate ORDER BY _wfd_row_index) TO {_pathstr(dest)} (FORMAT PARQUET, COMPRESSION ZSTD)')
            # Read-back check using official DuckDB parser, not the old codec.
            count=conn.execute('SELECT COUNT(*) FROM read_parquet(?)',[str(dest)]).fetchone()[0]
            if count!=len(rows): raise ValueError('DUCKDB_ROW_COUNT_MISMATCH')
            return dest.read_bytes()
        finally:
            conn.close()


def _query_parquet(raw:bytes, *, rows:bool):
    duckdb=require_duckdb()
    if len(raw)<12 or raw[:4]!=b'PAR1' or raw[-4:]!=b'PAR1':
        raise ValueError('PARQUET_MAGIC_INVALID')
    with tempfile.TemporaryDirectory(prefix='wfd_duckdb_read_') as tmpdir:
        p=Path(tmpdir)/'batch.parquet';p.write_bytes(raw)
        conn=duckdb.connect(database=':memory:')
        try:
            if rows:
                data=conn.execute('SELECT row_json FROM read_parquet(?) ORDER BY _wfd_row_index',[str(p)]).fetchall()
                return [json.loads(z[0]) for z in data]
            info=conn.execute('DESCRIBE SELECT * FROM read_parquet(?)',[str(p)]).fetchall()
            count=conn.execute('SELECT COUNT(*) FROM read_parquet(?)',[str(p)]).fetchone()[0]
            codec=conn.execute('SELECT DISTINCT compression FROM parquet_metadata(?)',[str(p)]).fetchall()
            return {'num_rows':count,'columns':[(x[0],x[1]) for x in info],
                    'codecs':[x[0] for x in codec]}
        finally:
            conn.close()


def rows_from_parquet(raw:bytes)->list[dict]:
    return _query_parquet(raw,rows=True)


def matching_business_keys(paths, wanted):
    """Exact scalar/tabular JSON business-key collision check, no value hydration."""
    if not paths or not wanted:
        return set()
    duckdb = require_duckdb()
    with tempfile.TemporaryDirectory(prefix='wfd_key_check_') as tmp:
        conn = duckdb.connect(database=':memory:')
        try:
            conn.execute('SET threads=1')
            conn.execute("SET memory_limit='64MB'")
            conn.execute('SET temp_directory=' + _pathstr(Path(tmp)))
            conn.execute('CREATE TEMP TABLE wanted_keys (key VARCHAR)')
            conn.executemany('INSERT INTO wanted_keys VALUES (?)', [(key,) for key in wanted])
            values = conn.execute(
                "SELECT DISTINCT source.key FROM (SELECT CASE "
                "WHEN json_type(row_json, '$.business_key')='VARCHAR' "
                "THEN json_extract_string(row_json, '$.business_key') "
                "ELSE error('BUSINESS_KEY_INVALID') END AS key FROM read_parquet(?, union_by_name=true)) source "
                "JOIN wanted_keys wanted ON source.key=wanted.key", [[str(path) for path in paths]]).fetchall()
            return {row[0] for row in values}
        finally:
            conn.close()


def parse_footer(raw:bytes)->dict:
    return _query_parquet(raw,rows=False)


def selected_rows_page(parts, selections, *, after_position, row_limit, max_row_bytes,
                       identities_only=False):
    """Read only selected physical rows through SQL, not a whole-file JSON list.

    The caller has verified immutable files and selected unique current leaves.
    SQL also checks that every requested identity materializes exactly once.
    Identity/length metadata is <=5000 for public selected-ref pages and O(N)
    for the internally derived complete product view, not protocol data rows.
    Only a bounded keyset and byte-bounded row_json prefix is decoded in Python;
    this does not claim constant total RAM or bounded catalog/version metadata.
    """
    if not selections:
        return []
    paths = [str(parts[index]["path"]) for index in sorted({s["part_index"] for s in selections})]
    duckdb = require_duckdb()
    with tempfile.TemporaryDirectory(prefix="wfd_fixed_page_") as tmp:
        conn = duckdb.connect(database=":memory:")
        try:
            conn.execute("SET threads=1")
            conn.execute("SET memory_limit='64MB'")
            conn.execute("SET temp_directory=" + _pathstr(Path(tmp)))
            conn.execute("CREATE TEMP TABLE selected (position BIGINT, filename VARCHAR, "
                         "physical_key VARCHAR, product_id VARCHAR, output_key VARCHAR)")
            conn.executemany("INSERT INTO selected VALUES (?,?,?,?,?)", [
                (s["position"], str(parts[s["part_index"]]["path"]), s["physical_key"],
                 parts[s["part_index"]]["product_id"], parts[s["part_index"]]["output_key"])
                for s in selections
            ])
            join = (" FROM selected s LEFT JOIN read_parquet(?, filename=true, union_by_name=true) p"
                    " ON p.filename=s.filename AND p.business_key=s.physical_key"
                    " AND p.product_id=s.product_id AND p.output_key=s.output_key"
                    " AND p.payload_kind IN ('scalar_rows','tabular_rows') ")
            metadata = conn.execute(
                "SELECT s.position, count(p._wfd_row_index), "
                "min(octet_length(encode(p.row_json)))" + join +
                "GROUP BY s.position ORDER BY s.position", [paths]).fetchall()
            if len(metadata) != len(selections) or any(count != 1 or size is None
                                                       for _, count, size in metadata):
                raise ValueError("PAGE_RECORD_MATERIALIZATION_MISMATCH")
            if identities_only:
                # Internal formal publication only consumes record identities.
                # Verify those against the actual Parquet row JSON in SQL,
                # without decoding any accumulated business values in Python.
                identities = conn.execute(
                    "SELECT s.position, json_extract_string(p.row_json, '$.business_key')" +
                    join + "ORDER BY s.position", [paths]).fetchall()
                by_position = {item["position"]: item for item in selections}
                if (len(identities) != len(selections) or any(
                        key != by_position[position]["physical_key"]
                        for position, key in identities)):
                    raise ValueError("PAGE_RECORD_IDENTITY_MISMATCH")
                return [by_position[position] for position, _ in identities]
            chosen, size = [], 0
            for position, _, row_bytes in metadata:
                if position <= after_position:
                    continue
                if len(chosen) >= row_limit:
                    break
                if size + row_bytes > max_row_bytes:
                    if not chosen:
                        raise ValueError("PAGE_ITEM_TOO_LARGE")
                    break
                chosen.append(position)
                size += row_bytes
            if not chosen:
                return []
            # No OFFSET and no all-row JSON fetch: the selected fixed identity
            # relation and keyset/length bounds are applied by DuckDB itself.
            result = conn.execute(
                "SELECT s.position, p.row_json" + join +
                "WHERE s.position>? AND s.position<=? ORDER BY s.position LIMIT ?",
                [paths, after_position, chosen[-1], min(row_limit, len(chosen))]).fetchall()
            if [item[0] for item in result] != chosen:
                raise ValueError("PAGE_RECORD_MATERIALIZATION_MISMATCH")
            by_position = {item["position"]: item for item in selections}
            rows = []
            for position, raw in result:
                selection = by_position[position]
                row = json.loads(raw)
                if not isinstance(row, dict) or row.get("business_key") != selection["physical_key"]:
                    raise ValueError("PAGE_RECORD_IDENTITY_MISMATCH")
                rows.append({**selection, "row": row})
            return rows
        finally:
            conn.close()
