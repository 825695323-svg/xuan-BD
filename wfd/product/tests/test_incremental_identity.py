"""Bounded append identity checks retain publication and HEAD authority."""
from __future__ import annotations
import copy
import json
import subprocess
import sys
import pytest
from test_fixed_read_pages import make_data_service
from test_r1_data_only import request, scalar_output
from wfd_sdk.duckdb_sdk import canonical, sha
from wfd_sdk.product_service import WFDProductService
from wfd_sdk.state import StateError


def recovery_call(tmp_path, service, document):
    from test_store_opening import machine_config
    from test_product_service import HERE
    target=tmp_path/('write-machine-'+str(len(list(tmp_path.glob('write-machine-*')))))
    target.mkdir()
    config=machine_config(target,service.root,'data_only',('read','register','submit','publish'),caller_id='r1-test')
    request={'protocol_version':'wfd.product-machine/0.1','request_id':'explicit-original-recovery','operation':'recovery','arguments':{'document':document}}
    bootstrap='import sys;sys.path.insert(0,'+repr(str(HERE))+');from wfd_sdk.product_machine import main;raise SystemExit(main(["--config",sys.argv[1]]))'
    result=subprocess.run([sys.executable,'-I','-B','-X','pycache_prefix='+str(target/'cache'),'-c',bootstrap,str(config)],input=json.dumps(request),text=True,capture_output=True,timeout=30)
    assert result.returncode==0,result.stderr
    return json.loads(result.stdout)


def seeded(tmp_path):
    service=make_data_service(tmp_path)
    doc=request([scalar_output('metric','append.identity','1')],'append-first')
    first=service.submit(doc);assert first['state']=='published_formal',first
    sid,pid=first['snapshot_id'],first['output_results'][0]['product_id']
    snapshot=service.engine.read_snapshot(sid)
    entry=next(item for item in snapshot['files'] if item['product_id']==pid)
    product=entry['source_bundle']['_wfd_product_bindings']['metric']['product']
    addition=copy.deepcopy(doc['outputs'][0]);addition['payload']['rows'][0]['business_key']='new-key'
    return service,doc,first,product,addition


def test_append_metadata_matches_full_hydration_and_still_rejects_existing_keys(tmp_path,monkeypatch):
    service,doc,first,product,addition=seeded(tmp_path)
    out=service._internal_output(addition);extension={'_wfd_data_only':True,'read_dependencies':[],'revisions':{}}
    args=(out,product,extension,first['snapshot_id'],'f'*64,{'_wfd_data_only':True})
    expected=WFDProductService._prepare_versions(service,*args)
    assert service._prepare_versions(*args)==expected
    def forbidden(*args,**kwargs):raise AssertionError('append must not decode the whole product')
    monkeypatch.setattr(service,'_read',forbidden)
    assert service._prepare_versions(*args)==expected
    duplicate=copy.deepcopy(out);duplicate['payload']['rows'][0]['business_key']='row-metric'
    with pytest.raises(ValueError,match='DUPLICATE_LOGICAL_KEY_REQUIRES_REVISION'):
        service._prepare_versions(duplicate,*args[1:])


@pytest.mark.parametrize('mode',['complete_snapshot','source_correction','processing_repair','withdrawal'])
def test_non_append_modes_keep_original_value_reader(tmp_path,monkeypatch,mode):
    service,doc,first,product,addition=seeded(tmp_path)
    out=service._internal_output(addition);out['input_mode']=mode
    extension={'_wfd_data_only':True,'read_dependencies':[],'revisions':{}}
    if mode!='complete_snapshot':extension['revisions']={'new-key':{'previous':{},'reason':'explicit revision test'}}
    def full_reader(*args,**kwargs):raise RuntimeError('original value reader retained')
    monkeypatch.setattr(service,'_read',full_reader)
    with pytest.raises(RuntimeError,match='original value reader retained'):
        service._prepare_versions(out,product,extension,first['snapshot_id'],'f'*64)


def test_append_checks_all_declared_files_including_unrelated_products(tmp_path):
    service,doc,first,product,addition=seeded(tmp_path)
    other=service.submit(request([scalar_output('other','append.unrelated','7')],'append-other',parent=first['snapshot_id']))
    assert other['state']=='published_formal'
    snapshot=service.engine.read_snapshot(other['snapshot_id'])
    entry=next(item for item in snapshot['files'] if item['product_id']!=product['product_id'])
    path=service.root/entry['file_relpath'];path.write_bytes(path.read_bytes()+b'corrupt')
    with pytest.raises(ValueError,match='CHECKSUM_MISMATCH'):
        service._prepare_versions(service._internal_output(addition),product,{'_wfd_data_only':True},other['snapshot_id'],'f'*64)


def test_authoritative_head_is_checked_exactly_without_enumerating_older_commits(tmp_path,monkeypatch):
    service,doc,first,product,addition=seeded(tmp_path)
    def forbidden():raise AssertionError('normal HEAD must not enumerate all historical snapshots')
    monkeypatch.setattr(service.engine,'_valid_snapshots',forbidden)
    assert service.engine.head()['snapshot_id']==first['snapshot_id']


@pytest.mark.parametrize('damage',['missing_state','empty_head','bad_pointer_digest','missing_commit','corrupt_payload'])
def test_head_faults_do_not_fall_back_to_an_older_snapshot(tmp_path,damage):
    service,doc,first,product,addition=seeded(tmp_path)
    second=service.submit(request([addition],'append-second',parent=first['snapshot_id']));assert second['state']=='published_formal'
    state=service.root/'catalog/state.json';body=json.loads(state.read_bytes())
    if damage=='missing_state':state.unlink()
    elif damage=='empty_head':body['active_head']=None;state.write_bytes(canonical(body))
    elif damage=='bad_pointer_digest':body['head_snapshot_sha256']='sha256:'+'0'*64;state.write_bytes(canonical(body))
    elif damage=='missing_commit':(service.root/'catalog/commits'/f"{second['snapshot_id']}.json").unlink()
    else:
        entry=service.engine.read_snapshot(second['snapshot_id'])['files'][-1]
        path=service.root/entry['file_relpath'];path.write_bytes(path.read_bytes()+b'corrupt')
    with pytest.raises(StateError):service.engine.head()


@pytest.mark.parametrize('marker_mode',['current','tampered_lookup','tampered_lookup_digest','legacy','missing_marker'])
def test_lost_receipt_and_commit_lookup_never_hide_an_original_request(tmp_path,marker_mode):
    service,doc,first,product,addition=seeded(tmp_path)
    rid=service.engine._request_key(doc)
    (service.root/'catalog/governance/receipts'/f'{rid}.json').unlink()
    marker=service.root/'catalog/commits'/f"{first['snapshot_id']}.json";body=json.loads(marker.read_bytes())
    if marker_mode=='tampered_lookup':
        body['request_lookup']['request_key']='hidden-request'
        body['request_lookup_sha256']=sha(canonical(body['request_lookup']))
    elif marker_mode=='tampered_lookup_digest':body['request_lookup_sha256']='0'*64
    elif marker_mode=='legacy':body.pop('request_lookup');body.pop('request_lookup_sha256')
    if marker_mode=='missing_marker':marker.unlink()
    else:marker.write_bytes(canonical(body))
    result=service.engine._known_request(rid)
    if marker_mode=='missing_marker':assert result is None
    else:assert result['snapshot_id']==first['snapshot_id']


def test_precommit_snapshot_without_marker_is_not_a_committed_request(tmp_path,monkeypatch):
    service,doc,first,product,addition=seeded(tmp_path)
    original=service.engine.submit;seen=[]
    def before_commit(document,**kwargs):
        result=original(document,fail_before_commit=True,**kwargs);seen.append(result);return result
    monkeypatch.setattr(service.engine,'submit',before_commit)
    next_doc=request([addition],'append-precommit',parent=first['snapshot_id'])
    service.submit(next_doc)
    assert seen[0]['status']=='injected_failure_before_commit'
    assert (service.root/seen[0]['orphan_snapshot_file']).is_file()
    assert service.engine._known_request(service.engine._request_key(next_doc)) is None
    assert service.engine.head()['snapshot_id']==first['snapshot_id']


@pytest.mark.parametrize('lookup_mode',['legacy','invalid_digest'])
def test_unrelated_legacy_commit_checks_metadata_without_decoding_payloads(tmp_path,monkeypatch,lookup_mode):
    service,doc,first,product,addition=seeded(tmp_path)
    marker=service.root/'catalog/commits'/f"{first['snapshot_id']}.json";body=json.loads(marker.read_bytes())
    if lookup_mode=='legacy':body.pop('request_lookup');body.pop('request_lookup_sha256')
    else:body['request_lookup_sha256']='0'*64
    marker.write_bytes(canonical(body))
    original=service.engine._valid_snapshot_exact;calls=[]
    def checked(sid,**kwargs):
        calls.append((sid,kwargs.get('verify_payloads',True)))
        return original(sid,**kwargs)
    monkeypatch.setattr(service.engine,'_valid_snapshot_exact',checked)
    assert service.engine._known_request('unrelated-request') is None
    assert calls==[(first['snapshot_id'],False)]
    # A matching request still checks its payload after the same metadata pass.
    rid=service.engine._request_key(doc)
    (service.root/'catalog/governance/receipts'/f'{rid}.json').unlink();calls.clear()
    assert service.engine._known_request(rid)['snapshot_id']==first['snapshot_id']
    assert calls==[(first['snapshot_id'],False),(first['snapshot_id'],True)]


@pytest.mark.parametrize('damage',['snapshot','manifest','payload'])
def test_matching_legacy_request_damage_is_not_recovered(tmp_path,damage):
    service,doc,first,product,addition=seeded(tmp_path)
    rid=service.engine._request_key(doc)
    (service.root/'catalog/governance/receipts'/f'{rid}.json').unlink()
    marker=service.root/'catalog/commits'/f"{first['snapshot_id']}.json";body=json.loads(marker.read_bytes())
    body.pop('request_lookup');body.pop('request_lookup_sha256');marker.write_bytes(canonical(body))
    snapshot=service.engine.read_snapshot(first['snapshot_id'])
    path=(service.root/f"catalog/snapshots/{first['snapshot_id']}.json" if damage=='snapshot' else
          service.root/snapshot['manifest_relpath'] if damage=='manifest' else
          service.root/snapshot['files'][0]['file_relpath'])
    path.write_bytes(path.read_bytes()+b'corrupt')
    assert service.engine._known_request(rid) is None
    with pytest.raises(StateError):service.engine.head()


def test_append_formal_receipt_is_identical_without_history_scan_or_full_value_read(tmp_path,monkeypatch):
    service,doc,first,product,addition=seeded(tmp_path)
    key=service.engine._request_key(doc)
    path=service.root/first['formal_publication_ref'];before=path.read_bytes();path.unlink()
    def forbidden(*args,**kwargs):raise AssertionError('append formalization cannot hydrate history')
    monkeypatch.setattr(service,'_read',forbidden)
    monkeypatch.setattr(service.engine,'_valid_snapshots',forbidden)
    result=service._formalize(key,doc['request_identity'],sha(canonical(doc)),first['output_results'],{'snapshot_id':first['snapshot_id']})
    assert result[2]=='published_formal',result
    assert path.read_bytes()==before


def test_append_formalization_rejects_an_unmaterialized_original_version(tmp_path):
    service,doc,first,product,addition=seeded(tmp_path)
    results=copy.deepcopy(first['output_results'])
    results[0]['records'][0]['record_version']='r_missing_original_version'
    path,checks,state=service._formalize('unmaterialized-original',doc['request_identity'],sha(canonical(doc)),results,{'snapshot_id':first['snapshot_id']})
    assert path is None and state=='published_sandbox'
    assert checks['fixed_readback_verified'] is False
    assert not (service.root/'catalog/product_service/data_only_formal_publications/unmaterialized-original.json').exists()


@pytest.mark.parametrize('damage',['none','marker','snapshot','manifest','missing_manifest','matching_payload'])
def test_negative_decode_cache_rechecks_original_bytes_and_matching_requests(tmp_path,monkeypatch,damage):
    service,doc,first,product,addition=seeded(tmp_path)
    rid=service.engine._request_key(doc)
    (service.root/'catalog/governance/receipts'/f'{rid}.json').unlink()
    marker=service.root/'catalog/commits'/f"{first['snapshot_id']}.json";body=json.loads(marker.read_bytes())
    body.pop('request_lookup');body.pop('request_lookup_sha256');marker.write_bytes(canonical(body))
    snapshot=service.engine.read_snapshot(first['snapshot_id'])
    assert service.engine._known_request('unrelated-request') is None
    paths={'marker':marker,'snapshot':service.root/f"catalog/snapshots/{first['snapshot_id']}.json",
           'manifest':service.root/snapshot['manifest_relpath'],'missing_manifest':service.root/snapshot['manifest_relpath'],
           'matching_payload':service.root/snapshot['files'][0]['file_relpath']}
    if damage!='none':
        path=paths[damage]
        if damage=='missing_manifest':path.unlink()
        else:path.write_bytes(path.read_bytes()+b'corrupt')
    if damage=='none':
        original=json.loads
        def forbidden(raw,*args,**kwargs):raise AssertionError('Unchanged negative cache decoded JSON again')
        with monkeypatch.context() as context:
            context.setattr(json,'loads',forbidden)
            assert service.engine._known_request('another-unrelated-request') is None
        assert service.engine._known_request(rid)['snapshot_id']==first['snapshot_id']
    else:
        # A prior negative result cannot conceal a subsequently damaged match.
        assert service.engine._known_request(rid) is None
        with pytest.raises(StateError):service.engine.head()


def test_accepted_original_intent_is_readonly_and_machine_recovery_is_idempotent(tmp_path):
    from test_fixed_read_pages import machine_call
    service,doc,first,product,addition=seeded(tmp_path)
    original=request([addition],'accepted-original',parent=first['snapshot_id'])
    key=service.engine._request_key(original)
    service._save_intent(key,original['request_identity'],sha(canonical(original)))
    status=service.request_status(original['request_identity'])
    assert status['state']=='accepted_not_published'
    assert status['input_fingerprint']==sha(canonical(original))
    assert service.engine.head()['snapshot_id']==first['snapshot_id']
    response=recovery_call(tmp_path,service,original)
    assert response['ok'] is True,response
    assert response['result']['state']=='published_formal',response
    sid=response['result']['snapshot_id'];markers=sorted((service.root/'catalog/commits').glob('*.json'))
    repeated=recovery_call(tmp_path,service,original)
    assert repeated['result']['snapshot_id']==sid
    assert sorted((service.root/'catalog/commits').glob('*.json'))==markers
    unknown=request([addition],'truly-unknown',parent=sid)
    result=recovery_call(tmp_path,service,unknown)
    assert result['ok'] is False and result['error']['code']=='RECOVERY_NOT_FOUND'
    assert sorted((service.root/'catalog/commits').glob('*.json'))==markers


@pytest.mark.parametrize('damage',['identity','fingerprint'])
def test_mismatched_intent_cannot_resume_or_publish(tmp_path,damage):
    from test_fixed_read_pages import machine_call
    service,doc,first,product,addition=seeded(tmp_path)
    original=request([addition],'conflicted-original',parent=first['snapshot_id'])
    key=service.engine._request_key(original)
    intent=service._save_intent(key,original['request_identity'],sha(canonical(original)))
    if damage=='identity':intent['request_identity']['request_id']='another-request'
    else:intent['input_fingerprint']='f'*64
    (service.root/service._intent_path(key)).write_bytes(canonical(intent))
    result=recovery_call(tmp_path,service,original)
    assert result['result']['state']=='rejected',result
    assert result['result']['errors'][0]['code']=='REQUEST_ID_CONFLICT'
    assert service.engine.head()['snapshot_id']==first['snapshot_id']


def test_engine_checks_actual_parquet_keys_and_retains_original_head_deep_content(tmp_path,monkeypatch):
    import wfd_sdk.duckdb_sdk as engine_module
    from wfd_sdk.duckdb_storage import rows_from_parquet
    service,doc,first,product,addition=seeded(tmp_path)
    original_submit=service.engine.submit;original_keys=engine_module.matching_business_keys;captured=[];calls=[]
    def keys(paths,wanted):
        full={row['business_key'] for path in paths for row in rows_from_parquet(path.read_bytes())}
        actual=original_keys(paths,wanted);assert actual==full & wanted
        calls.append(actual);return actual
    monkeypatch.setattr(engine_module,'matching_business_keys',keys)
    def submit_checked(document,**kwargs):
        captured.append(copy.deepcopy(document))
        old_head=service.engine.head();old_digest=sha(canonical(old_head));head=service.engine.head
        with monkeypatch.context() as context:
            context.setattr(service.engine,'head',lambda:old_head)
            result=original_submit(document,**kwargs)
        assert sha(canonical(old_head))==old_digest,'shallow manifest assembly mutated an old nested binding'
        return result
    monkeypatch.setattr(service.engine,'submit',submit_checked)
    second=service.submit(request([addition],'actual-key-append',parent=first['snapshot_id']))
    assert second['state']=='published_formal',second
    assert calls==[set()]
    duplicate=copy.deepcopy(captured[-1]);duplicate['request_identity']['request_id']='engine-actual-physical-duplicate'
    duplicate['expected_parent_snapshot_id']=second['snapshot_id']
    result=original_submit(duplicate)
    assert result['status']=='rejected'
    assert any(item.get('code')=='DUPLICATE_EXISTING_BUSINESS_KEY' for item in result['errors'])
    assert calls[-1]=={'new-key'}
    assert service.engine.head()['snapshot_id']==second['snapshot_id']


@pytest.mark.parametrize('original_mode',['complete_snapshot','source_correction','processing_repair','withdrawal'])
def test_engine_non_append_version_modes_do_not_use_new_key_projection(tmp_path,monkeypatch,original_mode):
    import wfd_sdk.duckdb_sdk as engine_module
    service,doc,first,product,addition=seeded(tmp_path)
    original=service.engine.submit;captured=[]
    def capture(document,**kwargs):captured.append(copy.deepcopy(document));return original(document,**kwargs)
    monkeypatch.setattr(service.engine,'submit',capture)
    second=service.submit(request([addition],'capture-append',parent=first['snapshot_id']))
    assert second['state']=='published_formal'
    candidate=copy.deepcopy(captured[-1]);candidate['request_identity']['request_id']='engine-original-'+original_mode
    candidate['expected_parent_snapshot_id']=second['snapshot_id']
    for versions in candidate['wfd_publish_context']['_wfd_row_versions'].values():
        for version in versions.values():version['input_mode']=original_mode
    monkeypatch.setattr(engine_module,'matching_business_keys',lambda *args,**kwargs:pytest.fail('non-append mode bypassed old actual value reader'))
    result=original(candidate)
    assert result['status']=='rejected'
    assert any(item.get('code')=='DUPLICATE_EXISTING_BUSINESS_KEY' for item in result['errors'])


def test_accepted_original_parent_change_refuses_real_machine_recovery_without_new_commit(tmp_path):
    service,doc,first,product,addition=seeded(tmp_path)
    original=request([addition],'accepted-before-parent-change',parent=first['snapshot_id'])
    key=service.engine._request_key(original)
    service._save_intent(key,original['request_identity'],sha(canonical(original)))
    moved=service.submit(request([scalar_output('other','accepted.parent.moved','7')],'move-parent',parent=first['snapshot_id']))
    assert moved['state']=='published_formal'
    markers=sorted((service.root/'catalog/commits').glob('*.json'))
    response=recovery_call(tmp_path,service,original)
    assert response['result']['state']=='rejected',response
    assert response['result']['errors'][0]['code']=='PARENT_CHANGED'
    assert service.engine.head()['snapshot_id']==moved['snapshot_id']
    assert sorted((service.root/'catalog/commits').glob('*.json'))==markers
