"""Additional experimental Parquet file/snapshot invariants; not independent DuckDB validation."""
import json,copy,struct,pytest
from pathlib import Path
from wfd_sdk.parquet_lite import (encode_parquet, decode_parquet,rows_from_parquet,parse_footer,
                                   parquet_from_rows,COLS)
from wfd_sdk.parquet_sdk import WFDParquetPrototype,load_protocol_validator
ROOT=Path(__file__).resolve().parents[1]

def test_parquet_file_header_footer_and_schema():
    rows=[{k:'value_'+k for k in COLS}]
    rows[0]['row_json']='{"business_key":"value_business_key","n":123}'
    b=encode_parquet(rows)
    assert b[:4]==b[-4:]==b'PAR1'
    n=struct.unpack('<I',b[-8:-4])[0]
    assert 0<n<len(b)-12
    f=parse_footer(b)
    assert f[3]==1 and f[4][0][3]==1
    assert len(f[2])==len(COLS)+1
    assert decode_parquet(b)==rows

def test_parquet_many_rows_unicode_decimal_null_preserved():
    orig=[{'business_key':f'键{i}','value_decimal':None if i%2 else '883053.250',
           'value_state':'not_reported' if i%2 else 'valid_value',
           'observation_time':{'status':'known','precision':'month','earliest_utc':'2025-09-01T00:00:00Z',
            'latest_exclusive_utc':'2025-10-01T00:00:00Z','source_timezone':'UTC'}} for i in range(211)]
    b=parquet_from_rows('p_test','port',{'id':'港口01'},'scalar_rows',orig)
    assert rows_from_parquet(b)==orig
    assert parse_footer(b)[3]==211

def test_parquet_bad_footer_rejected():
    data=encode_parquet([{k:'x' for k in COLS}])
    with pytest.raises(ValueError,match='MAGIC_INVALID'):
        parse_footer(data[:-4]+b'NOPE')
    with pytest.raises(ValueError,match='FOOTER_INVALID'):
        parse_footer(data[:-8]+(900_000).to_bytes(4,'little')+b'PAR1')

def test_parquet_wrong_columns_rejected():
    with pytest.raises(ValueError,match='COLUMN_MISMATCH'):
        encode_parquet([{'foo':'a'}])

def test_parquet_empty_batch_rejected():
    with pytest.raises(ValueError,match='EMPTY_PARQUET_ROWS'):
        encode_parquet([])

def test_store_writes_true_magic_and_manifests_point_to_parquet(tmp_path):
    w=WFDParquetPrototype(tmp_path/'drive',load_protocol_validator(ROOT/'protocol'),runtime_root=tmp_path/'host',sandbox=True)
    d=json.loads((ROOT/'fixtures/port_annual_autos.json').read_text())
    r=w.submit(d);assert r['status']=='published_sandbox'
    for file in w.head()['files']:
        p=w.root/file['file_relpath']
        assert p.suffix=='.parquet'
        assert p.read_bytes().startswith(b'PAR1') and p.read_bytes().endswith(b'PAR1')
        assert parse_footer(p.read_bytes())[3]==file['row_count']
    assert w.read_product()[0]['rows']==d['outputs'][0]['payload']['rows']

def test_local_index_is_not_on_external_volume(tmp_path):
    with pytest.raises(ValueError,match='LOCAL_INDEX_MUST_BE_OUTSIDE_DATA_VOLUME'):
        WFDParquetPrototype(tmp_path/'drive',load_protocol_validator(ROOT/'protocol'),runtime_root=tmp_path/'drive'/'runtime',sandbox=True)

def test_payload_corruption_detected_no_promoting(tmp_path):
    w=WFDParquetPrototype(tmp_path/'drive',load_protocol_validator(ROOT/'protocol'),runtime_root=tmp_path/'host',sandbox=True)
    d=json.loads((ROOT/'fixtures/port_annual_autos.json').read_text())
    r=w.submit(d); assert r['status']=='published_sandbox'
    f=w.root/w.head()['files'][0]['file_relpath']
    b=bytearray(f.read_bytes());b[13]^=0x55;f.write_bytes(b)
    assert w.head() is None
    with pytest.raises(ValueError,match='SNAPSHOT_UNAVAILABLE'):
        w.read_product(snapshot_id=r['snapshot_id'])

def test_same_request_id_idempotent(tmp_path):
    w=WFDParquetPrototype(tmp_path/'drive',load_protocol_validator(ROOT/'protocol'),runtime_root=tmp_path/'host',sandbox=True)
    d=json.loads((ROOT/'fixtures/port_monthly_teu.json').read_text())
    a=w.submit(d);b=w.submit(copy.deepcopy(d))
    assert a['snapshot_id']==b['snapshot_id'] and b['idempotent_replay']
    assert len(list((w.root/'catalog/commits').glob('*.json')))==1

def test_original_time_precision_preserved_in_row(tmp_path):
    w=WFDParquetPrototype(tmp_path/'drive',load_protocol_validator(ROOT/'protocol'),runtime_root=tmp_path/'host',sandbox=True)
    d=json.loads((ROOT/'fixtures/port_annual_autos.json').read_text())
    w.submit(d)
    record=w.read_product()[0]['rows'][0]
    assert record['observation_time']['precision']=='year'
    assert record['observation_time']['source_timezone']=='America/Los_Angeles'
