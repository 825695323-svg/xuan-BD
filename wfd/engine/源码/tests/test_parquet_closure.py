"""Round 2 WFD v1.3 prototype exercises. ALL run in sandbox fixture directory.
Do not convert these tests into official 241 acceptance result statuses.
"""
import copy
import json
from pathlib import Path
from decimal import Decimal
from datetime import datetime, timezone
from shutil import copytree
import pytest

from wfd_sdk.parquet_sdk import WFDParquetPrototype,business_validate,eligibility_at,load_protocol_validator,verify_test_bundle

ROOT=Path(__file__).resolve().parents[1]
PROTO=ROOT/'protocol'
PREV=ROOT/'fixtures'

@pytest.fixture(scope='session')
def validator():return load_protocol_validator(PROTO)

def fx(filename):return json.loads((ROOT/'fixtures'/filename).read_text('utf-8'))
def prev(filename):return json.loads((PREV/filename).read_text('utf-8'))
def store(tmp_path,validator,**kwargs):return WFDParquetPrototype(tmp_path/'wfd_sandbox',validator,runtime_root=tmp_path/'local_cache',**kwargs)
def with_parent(doc, wfd, request_id=None):
    d=copy.deepcopy(doc)
    d['expected_parent_snapshot_id']=wfd.head()['snapshot_id'] if wfd.head() else None
    if request_id:d['request_identity']['request_id']=request_id
    return d

@pytest.mark.parametrize('name',[
 'port_monthly_teu.json','port_annual_autos.json','port_release_event.json','seismic_quake_event.json',
 'unknown_vehicle_negative.json'])
def test_new_alt_fixture_schema(validator,name):
    assert not list(validator.iter_errors(fx(name)))

@pytest.mark.parametrize('name',[
 'apple_v13_candidate.json','wdi_v13_candidate.json','tatqa_v13_candidate.json','finred_v13_candidate.json'])
def test_round1_fixture_schema_still_valid(validator,name):
    assert not list(validator.iter_errors(prev(name)))

@pytest.mark.parametrize('name',[
 'port_monthly_teu.json','port_annual_autos.json','port_release_event.json','seismic_quake_event.json'])
def test_official_web_excerpts_business_valid(name):
    assert business_validate(fx(name)['outputs'][0])==[]

@pytest.mark.parametrize('name,expected',[
 ('unknown_vehicle_negative.json','NEEDS_ENTITY_RESOLUTION'),
])
def test_ambiguous_alt_rejected_by_business_layer(name,expected):
    assert expected in {v['code'] for v in business_validate(fx(name)['outputs'][0])}

@pytest.mark.parametrize('name,expected',[
 ('tatqa_v13_candidate.json','NEEDS_ENTITY_RESOLUTION'),
 ('finred_v13_candidate.json','UNVERIFIED_RELATION')])
def test_training_annotations_not_formal_facts(name,expected):
    assert expected in {v['code'] for v in business_validate(prev(name)['outputs'][0])}

def test_port_annual_is_flow_not_onsite_inventory():
    a=fx('port_annual_autos.json')['outputs'][0]
    m=fx('port_monthly_teu.json')['outputs'][0]
    assert a['new_definition_declaration']['semantic_code']=='port.automobiles.handled'
    assert a['new_definition_declaration']['measurement_nature']=='flow'
    assert a['new_definition_declaration']['unit_code']=='vehicle'
    assert m['new_definition_declaration']['unit_code']=='teu'
    assert a['payload']['rows'][-1]['value_decimal']=='91862'
    assert a['payload']['rows'][-1]['observation_time']['precision']=='year'

def test_official_monthly_teus_add_to_2025_annual():
    rows=fx('port_monthly_teu.json')['outputs'][0]['payload']['rows']
    assert len(rows)==12
    assert sum((Decimal(r['value_decimal']) for r in rows),Decimal(0))==Decimal('10239318.40')
    assert rows[8]['value_decimal']=='883053.25'

def test_press_rounding_not_same_as_current_table_and_public_day():
    rel=fx('port_release_event.json')['outputs'][0]['payload']['rows'][0]
    sep=fx('port_monthly_teu.json')['outputs'][0]['payload']['rows'][8]
    assert rel['values']['rounded_monthly_teu']['value']=='883053'
    assert sep['value_decimal']=='883053.25'
    assert rel['public_time']['precision']=='day'
    assert sep['observation_time']['precision']=='month'

def test_precise_seismic_event_time_does_not_equal_public_time():
    quake=fx('seismic_quake_event.json')['outputs'][0]['payload']['rows'][0]
    assert quake['event_time']['earliest_utc']=='2025-09-02T10:53:10Z'
    assert quake['event_time']['precision']=='second'
    assert quake['public_time']['status']=='unknown'
    assert quake['values']['local_magnitude']['value']=='0.9'

def test_eligibility_before_on_and_after_public_day():
    t=fx('port_release_event.json')['outputs'][0]['payload']['rows'][0]['public_time']
    assert eligibility_at(t,'2025-10-15T06:00:00Z')['decision']=='ineligible'
    x=eligibility_at(t,'2025-10-15T18:00:00Z')
    assert x['decision']=='indeterminate' and x['reason']=='TIME_PRECISION_INSUFFICIENT'
    assert eligibility_at(t,'2025-10-16T08:00:00Z')['decision']=='eligible'

def test_unknown_public_time_is_indeterminate():
    row=fx('seismic_quake_event.json')['outputs'][0]['payload']['rows'][0]
    assert eligibility_at(row['public_time'],'2025-10-01T00:00:00Z')['decision']=='indeterminate'
    assert eligibility_at(row['public_time'],'2025-10-01T00:00:00Z',mode='snapshot_contents')['decision']=='eligible'

def test_ohlc_invalid_but_schema_valid(validator):
    doc=prev('apple_v13_candidate.json')
    doc['outputs'][0]['payload']['rows'][0]['values']['high']['value']='100'
    assert not list(validator.iter_errors(doc))
    assert 'OHLC_BOUNDS' in {v['code'] for v in business_validate(doc['outputs'][0])}

def test_duplicate_key_rejected(validator):
    d=prev('apple_v13_candidate.json')
    d['outputs'][0]['payload']['rows'].append(copy.deepcopy(d['outputs'][0]['payload']['rows'][0]))
    assert not list(validator.iter_errors(d))
    assert 'DUPLICATE_BUSINESS_KEY' in {e['code'] for e in business_validate(d['outputs'][0])}

def test_event_plan_cannot_claim_realized():
    d=copy.deepcopy(json.loads((PROTO/'examples/conformant/event_plan.json').read_text()))
    r=d['outputs'][0]['payload']['rows'][0]
    r['status']='realized';r['event_time']=copy.deepcopy(r['public_time'])
    assert 'CLAIM_OUTCOME_CONFLATED' in {x['code'] for x in business_validate(d['outputs'][0])}

def test_invalid_reverse_time_interval_rejected_business():
    d=fx('port_monthly_teu.json')
    r=d['outputs'][0]['payload']['rows'][0]
    r['observation_time']['latest_exclusive_utc']=r['observation_time']['earliest_utc']
    assert 'TIME_INTERVAL_INVALID' in {x['code'] for x in business_validate(d['outputs'][0])}

def test_quantity_negative_rejected():
    d=fx('port_annual_autos.json');d['outputs'][0]['payload']['rows'][0]['value_decimal']='-1'
    assert 'NEGATIVE_QUANTITY' in {e['code'] for e in business_validate(d['outputs'][0])}

def test_missing_value_unknown_not_turned_into_zero(validator):
    d=json.loads((PROTO/'examples/conformant/scalar_missing.json').read_text())
    assert not list(validator.iter_errors(d))
    assert d['outputs'][0]['payload']['rows'][0]['value_decimal'] is None
    assert d['outputs'][0]['payload']['rows'][0]['value_state']=='not_reported'

def test_formal_release_requires_custodied_source(tmp_path,validator):
    w=store(tmp_path,validator,sandbox=False)
    r=w.submit(fx('port_monthly_teu.json'))
    assert r['status']=='rejected'
    assert r['errors'][0]['code']=='EVIDENCE_CUSTODY_UNVERIFIED'
    assert w.head() is None

def test_one_batch_two_valid_outputs_one_snapshot(tmp_path,validator):
    d=fx('port_monthly_teu.json')
    second=copy.deepcopy(d['outputs'][0]); second['output_key']='loaded_imports_september_2025'
    second['new_definition_declaration']['semantic_code']='port.container.loaded_imports'
    second['payload']['rows']=[{'business_key':'loaded_imports_sep_2025','value_decimal':'460043.75','value_state':'valid_value','observation_time':
       copy.deepcopy(d['outputs'][0]['payload']['rows'][8]['observation_time'])}]
    d['outputs'].append(second)
    w=store(tmp_path,validator)
    r=w.submit(d)
    assert r['status']=='published_sandbox'
    assert len(r['outputs_success'])==2
    assert len(list((w.root/'catalog/commits').glob('*.json')))==1
    assert len(w.read_product())==2
    assert sum(len(e['rows']) for e in w.read_product())==13
    assert w.head()['snapshot_id']==r['snapshot_id']

def test_snapshot_immutable_and_incremental_independent_products(tmp_path,validator):
    w=store(tmp_path,validator)
    a=w.submit(fx('port_monthly_teu.json')); assert a['status']=='published_sandbox'
    b=w.submit(with_parent(fx('port_annual_autos.json'),w)); assert b['status']=='published_sandbox'
    assert a['snapshot_id']!=b['snapshot_id']
    assert len(w.read_product(snapshot_id=a['snapshot_id']))==1
    assert len(w.read_product(snapshot_id=b['snapshot_id']))==2
    assert w.read_product(snapshot_id=a['snapshot_id'])[0]['rows'][8]['value_decimal']=='883053.25'
    assert len(list((w.root/'catalog/commits').glob('*.json')))==2

def test_idempotent_replay_does_not_make_second_snapshot(tmp_path,validator):
    w=store(tmp_path,validator)
    d=fx('port_monthly_teu.json');a=w.submit(d);b=w.submit(copy.deepcopy(d))
    assert b['idempotent_replay'] is True
    assert a['snapshot_id']==b['snapshot_id']
    assert len(list((w.root/'catalog/commits').glob('*.json')))==1

def test_request_id_same_different_contents_is_conflict(tmp_path,validator):
    w=store(tmp_path,validator)
    d=fx('port_monthly_teu.json');w.submit(d)
    d['outputs'][0]['payload']['rows'][0]['value_decimal']='100000'
    r=w.submit(d)
    assert r['status']=='rejected'
    assert r['errors'][0]['code']=='REQUEST_ID_CONFLICT'

def test_stale_parent_rejected_without_overwrite(tmp_path,validator):
    w=store(tmp_path,validator)
    a=w.submit(fx('port_monthly_teu.json'))
    r=w.submit(fx('port_annual_autos.json'))
    assert r['errors'][0]['code']=='PARENT_CHANGED'
    assert w.head()['snapshot_id']==a['snapshot_id']

def test_partial_success_status_and_rejections(tmp_path,validator):
    w=store(tmp_path,validator)
    d=fx('port_monthly_teu.json')
    d['outputs'].append(fx('unknown_vehicle_negative.json')['outputs'][0])
    r=w.submit(d)
    assert r['status']=='partially_published_sandbox'
    assert r['outputs_success']==['la_port_teus_monthly_2025']
    assert r['outputs_rejected'][0]['errors'][0]['code']=='NEEDS_ENTITY_RESOLUTION'
    assert len(w.read_product())==1

def test_crash_before_commit_does_not_publish(tmp_path,validator):
    w=store(tmp_path,validator)
    d=fx('port_monthly_teu.json')
    r=w.submit(d,fail_before_commit=True)
    assert r['status']=='injected_failure_before_commit'
    assert w.head() is None
    r2=w.submit(d)
    assert r2['status']=='published_sandbox'
    assert w.head()['snapshot_id']==r2['snapshot_id']

def test_manifest_corrupt_makes_latest_unreadable(tmp_path,validator):
    w=store(tmp_path,validator)
    first=w.submit(fx('port_monthly_teu.json'))
    second=w.submit(with_parent(fx('port_annual_autos.json'),w))
    manifest= w.root/w.head()['manifest_relpath']
    manifest.write_bytes(b'corrupted')
    assert w.head()['snapshot_id']==first['snapshot_id']
    with pytest.raises(ValueError,match='SNAPSHOT_UNAVAILABLE'):
        w.read_snapshot(second['snapshot_id'])

def test_corrupt_data_file_does_not_pass_snapshot_validation(tmp_path,validator):
    w=store(tmp_path,validator);d=w.submit(fx('port_monthly_teu.json'))
    file_path=w.root/w.head()['files'][0]['file_relpath']
    file_path.write_bytes(b'NOT_PARQUET_AND_CORRUPTED')
    assert w.head() is None
    with pytest.raises(ValueError,match='SNAPSHOT_UNAVAILABLE'):
        w.read_product(snapshot_id=d['snapshot_id'])

def test_index_rebuild_is_disposable(tmp_path,validator):
    w=store(tmp_path,validator);w.submit(fx('port_monthly_teu.json'))
    r1=w.read_product()
    index=w.rebuild_sqlite_index()
    Path(index).unlink()
    r2=w.read_product()
    w.rebuild_sqlite_index()
    assert r1==r2

def test_independent_bundle_survives_copy_and_no_local_sqlite(tmp_path,validator):
    w=store(tmp_path,validator)
    w.submit(fx('port_annual_autos.json'));pid=w.head()['files'][0]['product_id']
    bundle_path=tmp_path/'machine_a'/'bundle'
    b=w.export_test_bundle(pid,bundle_path)
    copytree(bundle_path,tmp_path/'machine_b'/'extracted')
    r=verify_test_bundle(tmp_path/'machine_b'/'extracted')
    assert r['verified'] and len(r['rows'])==3
    assert r['rows'][-1]['value_decimal']=='91862'
    assert not r['audit_self_contained']
    assert not b['formal_wfd_bundle']

def test_bundle_rejects_tampered_file(tmp_path,validator):
    w=store(tmp_path,validator);w.submit(fx('port_monthly_teu.json'))
    d=tmp_path/'bundle';b=w.export_test_bundle(w.head()['files'][0]['product_id'],d)
    f=d/b['files'][0]['rel_path'];f.write_bytes(f.read_bytes()+b'X')
    with pytest.raises(ValueError,match='CHECKSUM_MISMATCH'):verify_test_bundle(d)

def test_products_keep_distinct_authority_even_same_display_name(tmp_path,validator):
    w=store(tmp_path,validator)
    a=fx('port_monthly_teu.json')
    b=copy.deepcopy(a)
    b['request_identity']['request_id']='different_authority'
    b['outputs'][0]['new_definition_declaration']['definition_authority']='other_authority'
    b['outputs'][0]['payload']['rows'][0]['business_key']='other_1'
    b['outputs'][0]['payload']['rows']=b['outputs'][0]['payload']['rows'][:1]
    w.submit(a)
    w.submit(with_parent(b,w))
    assert len({f['product_id'] for f in w.head()['files']})==2

def test_duplicate_across_submissions_without_revision_is_rejected(tmp_path,validator):
    w=store(tmp_path,validator)
    w.submit(fx('port_monthly_teu.json'))
    d=with_parent(fx('port_monthly_teu.json'),w,'different_request_same_business_keys')
    r=w.submit(d)
    assert r['status']=='rejected'
    assert r['errors'][0]['code']=='DUPLICATE_EXISTING_BUSINESS_KEY'

def test_derived_inputs_without_fixed_lineage_rejected_by_poc():
    d=fx('port_monthly_teu.json')
    d['outputs'][0]['new_definition_declaration']['measurement_nature']='derived'
    assert 'DERIVED_LINEAGE_NOT_IMPLEMENTED' in {e['code'] for e in business_validate(d['outputs'][0])}

def test_existing_v13_25_second_timestamps_not_truncated():
    d=fx('seismic_quake_event.json');r=d['outputs'][0]['payload']['rows'][0]
    assert r['event_time']['precision']=='second'
    assert r['event_time']['latest_exclusive_utc']=='2025-09-02T10:53:11Z'

