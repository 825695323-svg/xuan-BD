"""Adapter semantics independent of the optional DuckDB binary.
These tests do NOT count as engine-write/read tests.
"""
import copy, json
from decimal import Decimal
from pathlib import Path
import pytest
from wfd_sdk.duckdb_storage import _native_schema,_cell_value,_sqltype,_instant,_pathstr,_ident

ROOT=Path(__file__).resolve().parents[1]
def out(name):
    return json.loads((ROOT/'fixtures'/name).read_text())['outputs'][0]

@pytest.mark.parametrize('name,column',[('port_monthly_teu.json','value_decimal'),('apple_v13_candidate.json','metric_open'),('port_release_event.json','event_id'),('finred_v13_candidate.json','edge_relation_type')])
def test_all_payloads_get_native_columns(name,column):
    data=out(name)
    cols=_native_schema(data['payload']['kind'],data['payload']['rows'])
    assert column in [x[0] for x in cols]
    assert 'row_json' in [x[0] for x in cols]


def test_decimal_scale_inferred_without_float():
    data=out('port_monthly_teu.json')
    cols=dict((x[0],x[1]) for x in _native_schema(data['payload']['kind'],data['payload']['rows']))
    assert cols['value_decimal']=='DECIMAL(38,2)'


def test_business_day_preserved_as_interval():
    data=out('port_release_event.json')
    row=data['payload']['rows'][0]
    assert row['public_time']['precision']=='day'
    a=_instant(row['public_time']);b=_instant(row['public_time'],'latest_exclusive_utc')
    assert (b-a).total_seconds()==24*3600


def test_null_remains_null():
    assert _cell_value({'value':None},'decimal') is None
    assert _cell_value(None,'integer') is None


def test_large_int_preserved_as_decimal():
    assert _cell_value({'value':'9007199254740993'},'integer')==Decimal('9007199254740993')
    assert _sqltype('integer',[{'value':'9007199254740993'}])=='DECIMAL(38,0)'


def test_disallow_subsecond_in_base():
    with pytest.raises(ValueError,match='UNSUPPORTED_SUBSECOND_TIME'):
        _instant({'status':'known','earliest_utc':'2025-01-01T00:00:00.001Z'})


def test_oversize_decimal_is_explicitly_rejected():
    with pytest.raises(ValueError,match='DECIMAL_PRECISION_EXCEEDS_38'):
        _sqltype('decimal',[{'value':'1'+'0'*38}])


def test_prevent_native_name_collision():
    sample=out('apple_v13_candidate.json')
    rows=copy.deepcopy(sample['payload']['rows'])
    rows[0]['values']['open_state']={'data_type':'decimal','value':'1','value_state':'valid_value'}
    with pytest.raises(ValueError,match='NORMALIZED_COLUMN_COLLISION'):
        _native_schema('tabular_rows',rows)


def test_long_logical_code_keeps_original_value_and_bounded_native_names():
    codes = ['src_' + 'x' * 75 + suffix for suffix in ['A', 'B']]
    row = {'values': {code: {'data_type': 'text', 'value': code, 'value_state': 'valid_value'} for code in codes}}
    metrics = [(name, read) for name, _, read in _native_schema('tabular_rows', [row]) if name.startswith('mhash_')]
    assert len({name for name, _ in metrics}) == 4
    assert all(len(name) <= 60 for name, _ in metrics)
    assert sorted(read(row) for name, read in metrics if not name.endswith('_state')) == codes
    for invalid in ['x' * 129, 'a' * 65 + '"']:
        with pytest.raises(ValueError, match='UNSAFE_FIELD_CODE'):
            _native_schema('tabular_rows', [{'values': {invalid: row['values'][codes[0]]}}])


def test_paths_are_sql_quoted():
    assert _pathstr(Path("/tmp/foo's.parquet")) == "'/tmp/foo''s.parquet'"
    assert _ident('x"y')=='"x""y"'
