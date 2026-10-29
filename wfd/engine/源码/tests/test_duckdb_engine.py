"""Official DuckDB integration tests (SKIP, never PASS, if DuckDB is missing)."""
import copy,importlib.util,json
from decimal import Decimal
from pathlib import Path
import pytest
from wfd_sdk.duckdb_storage import (require_duckdb, parquet_from_rows,
    parse_footer, rows_from_parquet, DUCKDB_STORAGE_FORMAT)
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype,load_protocol_validator,verify_test_bundle

ROOT=Path(__file__).resolve().parents[1]
AVAILABLE=importlib.util.find_spec('duckdb') is not None
requires_engine=pytest.mark.skipif(not AVAILABLE,reason='OFFICIAL_DUCKDB_NOT_INSTALLED: engine test NOT_RUN')

def fixture(name):
    return json.loads((ROOT/'fixtures'/name).read_text(encoding='utf-8'))

def engine(tmp_path):
    return WFDDuckDBPrototype(tmp_path/'wfd_disk',load_protocol_validator(ROOT/'protocol'),runtime_root=tmp_path/'host_cache')


def test_engine_dependency_is_explicit():
    if AVAILABLE:
        assert require_duckdb().__version__
    else:
        with pytest.raises(RuntimeError, match='DUCKDB_RUNTIME_MISSING'):
            require_duckdb()


@pytest.mark.parametrize('source,expected_cols',[ 
    ('port_monthly_teu.json',['value_decimal','value_state','time_start_utc']),
    ('apple_v13_candidate.json',['metric_open','metric_high','metric_close','metric_volume']),
    ('port_release_event.json',['event_id','case_id','public_from_utc']),
    ('finred_v13_candidate.json',['edge_subject_id','edge_object_id','edge_relation_type']),
])
@requires_engine
def test_four_shapes_are_real_zstd_parquet(source,expected_cols):
    obj=fixture(source)['outputs'][0]
    binary=parquet_from_rows('p_test',obj['output_key'],obj['subject'],obj['payload']['kind'],obj['payload']['rows'])
    info=parse_footer(binary)
    assert info['num_rows']==len(obj['payload']['rows'])
    assert all(col in [c[0] for c in info['columns']] for col in expected_cols)
    assert 'ZSTD' in ' '.join(str(x).upper() for x in info['codecs'])
    assert rows_from_parquet(binary)==obj['payload']['rows']
    cols=dict(info['columns'])
    if source=='port_monthly_teu.json':
        assert cols['value_decimal'].startswith('DECIMAL')
    if source=='apple_v13_candidate.json':
        assert cols['metric_open'].startswith('DECIMAL')
        assert cols['metric_volume'].startswith('DECIMAL')


@requires_engine
def test_missing_decimal_retains_native_null_and_value_state():
    d=json.loads((ROOT/'protocol/examples/conformant/scalar_missing.json').read_text())
    out=d['outputs'][0]
    b=parquet_from_rows('p_null',out['output_key'],out['subject'],out['payload']['kind'],out['payload']['rows'])
    assert rows_from_parquet(b)==out['payload']['rows']
    with __import__('tempfile').TemporaryDirectory() as tmp:
        path=Path(tmp)/'n.parquet';path.write_bytes(b)
        conn=require_duckdb().connect(':memory:')
        got=conn.execute('SELECT value_decimal, value_state FROM read_parquet(?)',[str(path)]).fetchone()
        assert got==(None,'not_reported')
        conn.close()


@requires_engine
def test_engine_manifest_snapshot_sqlite_rebuild_export(tmp_path):
    w=engine(tmp_path)
    six=['port_monthly_teu.json','port_annual_autos.json','port_release_event.json',
         'seismic_quake_event.json','apple_v13_candidate.json','wdi_v13_candidate.json']
    receipts=[]
    for fn in six:
        doc=fixture(fn);doc['expected_parent_snapshot_id']=w.head()['snapshot_id'] if w.head() else None
        if 'candidate' in fn:
            doc['request_identity']['dataset_id']='integration_test';doc['request_identity']['request_id']='duckdb_'+fn
        r=w.submit(doc)
        assert r['status']=='published_sandbox',r
        assert r['storage_format']==DUCKDB_STORAGE_FORMAT
        assert r['duckdb_roundtrip_verified'] is True
        receipts.append(r)
    assert len({r['snapshot_id'] for r in receipts})==6
    snap=w.head();assert len(w.read_product())==6
    assert sum(len(e['rows']) for e in w.read_product())==32
    idx=Path(w.rebuild_sqlite_index());idx.unlink()
    assert len(w.read_product(snapshot_id=snap['snapshot_id']))==6
    port=next(e for e in snap['files'] if e['output_key']=='la_port_auto_handled_2023_2025')
    path=tmp_path/'independent_read';w.export_test_bundle(port['product_id'],path)
    assert len(verify_test_bundle(path)['rows'])==3
    old=w.submit(fixture(six[0]))
    assert old['idempotent_replay'] is True
    assert old['snapshot_id']==receipts[0]['snapshot_id']


@requires_engine
def test_commit_marker_required_and_orphans_not_visible(tmp_path):
    w=engine(tmp_path)
    d=fixture('port_annual_autos.json')
    outcome=w.submit(d,fail_before_commit=True)
    assert outcome['status']=='injected_failure_before_commit'
    assert w.head() is None
    assert len(list((w.root/'catalog/snapshots').glob('*.json')))==1
    assert len(w._valid_snapshots())==0


@requires_engine
def test_large_integer_decimal_does_not_float_round(tmp_path):
    d=fixture('port_annual_autos.json')
    o=d['outputs'][0]
    o['payload']['rows'][0]['value_decimal']='9007199254740993'
    b=parquet_from_rows('p_dec',o['output_key'],o['subject'],o['payload']['kind'],o['payload']['rows'])
    with __import__('tempfile').TemporaryDirectory() as tmp:
        p=Path(tmp)/'n.parquet';p.write_bytes(b)
        conn=require_duckdb().connect(':memory:')
        got=conn.execute('SELECT CAST(value_decimal AS VARCHAR) FROM read_parquet(?) ORDER BY _wfd_row_index',[str(p)]).fetchone()[0]
        assert Decimal(got)==Decimal('9007199254740993')
        conn.close()

@requires_engine
def test_old_experimental_parquet_is_or_is_not_duckdb_compatible():
    """Migration gate: FAIL means source candidates must be re-written, not relabeled.

    The older pure-Python writer's own parser is not an independent Parquet
    conformance proof. This negative-capable test is intentionally strict.
    """
    p=ROOT/'legacy_samples'/'old_codec_example.parquet'
    conn=require_duckdb().connect(':memory:')
    try:
        result=conn.execute('SELECT COUNT(*) FROM read_parquet(?)',[str(p)]).fetchone()[0]
        assert result>0
    finally:
        conn.close()
