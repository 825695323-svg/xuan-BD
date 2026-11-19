"""Explicit new-format synthetic WFD volumes; no migration or group repair."""
from pathlib import Path
import pytest
from test_post_publication_correction import make_service, gov
from test_r1_data_only import request, scalar_output, UNITS, NAMESPACE
from test_product_service import ALL_ROLES, HERE
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_data_service import WFDDataOnlyService
from wfd_sdk.state import StateError
from wfd_sdk.joint_state import FORMAT


def open_service(tmp_path, new=False, read_only=False):
    factory = WFDDuckDBPrototype.initialize_new if new else WFDDuckDBPrototype.open_existing
    options = {'storage_format': 'joint_experimental'} if new else {'read_only': read_only}
    engine = factory(tmp_path / 'store', load_protocol_validator(HERE / 'protocol', entry='wfd-data-only-write.schema.json'),
        runtime_root=tmp_path / 'runtime', sandbox=False, writer_host='joint-test', **options)
    return WFDDataOnlyService(engine, caller_roles=ALL_ROLES, caller_id='joint-test', unit_registry=UNITS,
        trusted_actor_namespaces={NAMESPACE})


def test_joint_volume_real_publish_reopen_and_original_receipt(tmp_path):
    service = open_service(tmp_path, new=True)
    initial = service.snapshot_status()
    assert initial['empty'] and initial['storage_format'] == FORMAT
    assert initial['authority'] == 'joint_commit'
    doc = request([scalar_output('first', 'joint.first', '10')], 'joint-first')
    with pytest.raises(ValueError, match='JOINT_PREDECESSOR_REQUIRED'):
        service.submit(doc)
    first = service.submit(doc, expected_commit_id=initial['joint_commit_id'])
    assert first['state'] == 'published_formal', first
    sid = first['snapshot_id']; member = first['output_results'][0]
    view = service.engine.state.view()
    assert view['record']['state']['active_head'] == sid
    assert view['record']['predecessor_commit'] == initial['joint_commit_id']
    assert gov.load(service.root) == view['usage']
    assert not (service.root / 'catalog/state.json').exists()
    assert not (service.root / 'catalog/usage_suspensions.json').exists()
    reopened = open_service(tmp_path)
    row = reopened.read(member['product_id'], snapshot_id=sid)['rows'][0]
    assert row['row']['value_decimal'] == '10'
    pointer = reopened.engine.state.path.read_bytes()
    replay = reopened.submit(doc, expected_commit_id=initial['joint_commit_id'])
    assert replay['snapshot_id'] == sid
    assert reopened.engine.state.path.read_bytes() == pointer
    second = request([scalar_output('second', 'joint.second', '20')], 'joint-second', parent=sid)
    with pytest.raises(ValueError, match='JOINT_CAS_CONFLICT'):
        reopened.submit(second, expected_commit_id=initial['joint_commit_id'])
    published = reopened.submit(second, expected_commit_id=view['commit_id'])
    assert published['state'] == 'published_formal', published
    assert reopened.read(member['product_id'], snapshot_id=sid)['rows'][0]['row']['value_decimal'] == '10'
    assert reopened.discover_products(snapshot_id=sid)['products']
    assert reopened.engine.state.view()['record']['usage_ref'] == view['record']['usage_ref']
    for action in (gov.suspend, gov.authorize_repair, gov.resolve):
        with pytest.raises(StateError, match='JOINT_OPERATION_UNSUPPORTED'):
            action(reopened.root, {})
    assert not (service.root / 'catalog/usage_suspensions.json').exists()

@pytest.mark.parametrize('stage', ['before', 'after'])
def test_original_request_recovers_pointer_failure_without_new_identity(tmp_path, monkeypatch, stage):
    from wfd_sdk.state import StateStore
    service = open_service(tmp_path, new=True)
    token = service.snapshot_status()['joint_commit_id']
    doc = request([scalar_output('row', 'joint.recover', '12')], 'recover')
    original = StateStore._write_atomic
    triggered = []
    def broken(store, data):
        if store.path.name == 'joint-current.json' and not triggered:
            triggered.append(True)
            if stage == 'after': original(store, data)
            raise OSError('synthetic pointer I/O/response interruption')
        return original(store, data)
    with monkeypatch.context() as patch:
        patch.setattr(StateStore, '_write_atomic', broken)
        interrupted = service.submit(doc, expected_commit_id=token)
        assert interrupted['state'] != 'published_formal', interrupted
    assert triggered
    after_fault = service.engine.state.view()
    assert (after_fault['commit_id'] == token) == (stage == 'before')
    reopened = open_service(tmp_path)
    # A complete candidate file is not public until the authoritative flip.
    candidates = list((service.root / 'catalog/snapshots').glob('*.json'))
    assert len(candidates) == 1
    candidate_sid = candidates[0].stem
    candidate = service.engine.read_snapshot(candidate_sid)
    pid = candidate['files'][0]['product_id']
    reads = [lambda: reopened.read(pid, snapshot_id=candidate_sid),
             lambda: reopened.read_page(pid, snapshot_id=candidate_sid, record_refs=[]),
             lambda: reopened.read_product_page(pid, snapshot_id=candidate_sid),
             lambda: reopened.discover_products(snapshot_id=candidate_sid)]
    if stage == 'before':
        for read in reads:
            with pytest.raises(StateError, match='JOINT_SNAPSHOT_NOT_ACTIVATED'):
                read()
    else:
        assert reopened.read(pid, snapshot_id=candidate_sid)['rows']
    result = reopened.submit(doc, expected_commit_id=token)
    assert result['state'] == 'published_formal', result
    pointer = reopened.engine.state.path.read_bytes()
    again = reopened.submit(doc, expected_commit_id=token)
    assert again['snapshot_id'] == result['snapshot_id']
    assert reopened.engine.state.path.read_bytes() == pointer
    member = result['output_results'][0]
    assert reopened.read(member['product_id'], snapshot_id=result['snapshot_id'])['rows'][0]['row']['value_decimal'] == '12'


def test_joint_corruption_mixed_format_and_read_generation_refuse(tmp_path, monkeypatch):
    service = open_service(tmp_path, new=True)
    token = service.snapshot_status()['joint_commit_id']
    first = service.submit(request([scalar_output('a','joint.a','1')], 'first'), expected_commit_id=token)
    view = service.engine.state.view(); member = first['output_results'][0]
    original_public = service._public_read_result
    def changed(*args, **kwargs):
        result = original_public(*args, **kwargs)
        other = open_service(tmp_path)
        other.submit(request([scalar_output('b','joint.b','2')], 'interleave', parent=first['snapshot_id']),
                     expected_commit_id=view['commit_id'])
        return result
    with monkeypatch.context() as patch:
        patch.setattr(service, '_public_read_result', changed)
        with pytest.raises(StateError, match='JOINT_READ_CHANGED'):
            service.read(member['product_id'], snapshot_id=first['snapshot_id'])
    for filename in ['state.json','usage_suspensions.json']:
        path = service.root / 'catalog' / filename; path.write_text('synthetic marker')
        with pytest.raises(StateError, match='JOINT_LEGACY_MIXED'):
            open_service(tmp_path, read_only=True)
        assert path.read_text() == 'synthetic marker'; path.unlink()
    usage = service.root / f"catalog/joint_objects/usage-{view['record']['usage_ref']}.json"
    usage.write_text('{}')
    with pytest.raises(StateError, match='JOINT_OBJECT_DIGEST'):
        open_service(tmp_path, read_only=True)


def test_legacy_volume_keeps_old_authority_and_rejects_joint_token(tmp_path):
    service = make_service(tmp_path)
    first = service.submit(request([scalar_output('a','legacy.a','1')], 'legacy'))
    assert first['state'] == 'published_formal'
    assert (service.root/'catalog/state.json').exists()
    assert not (service.root/'catalog/volume-format.json').exists()
    with pytest.raises(ValueError, match='JOINT_TOKEN_ON_LEGACY_VOLUME'):
        service.submit(request([scalar_output('b','legacy.b','2')], 'bad'), expected_commit_id='x')


def test_experimental_machine_selection_and_live_marker_rejection(tmp_path):
    from wfd_sdk import product_machine
    service = open_service(tmp_path, new=True)
    before = service.engine.state.path.read_bytes()
    config = {'project_root': str(HERE), 'store': str(service.root)}
    with pytest.raises(StateError, match='experimental_machine_connection'):
        product_machine._build_service(config, operation='capabilities')
    assert service.engine.state.path.read_bytes() == before
    from wfd_sdk.product_query import ProductQuery
    with pytest.raises(StateError, match="experimental_product_query"):
        ProductQuery(service).execute({})
    with pytest.raises(StateError, match="resolve_write_target"):
        service.resolve_write_target("synthetic")
    caps = service.capabilities()
    assert caps['joint_storage']['machine_connection_supported'] is False
    assert caps['usage_governance']['operations'] == ['usage_status', 'usage_audit_read']
    assert not caps['operations']['register_write_target']['supported']
    assert not caps['operations']['resolve_write_target']['supported']
    marker = service.root/'catalog/volume-format.json'; original = marker.read_bytes()
    for content in [None, b'{}']:
        if content is None: marker.unlink()
        else: marker.write_bytes(content)
        with pytest.raises(StateError, match='JOINT_FORMAT'):
            service.snapshot_status()
        with pytest.raises(StateError, match='JOINT_FORMAT'):
            service.submit(request([scalar_output('x','joint.x','1')], 'bad'), expected_commit_id='x')
        assert service.engine.state.path.read_bytes() == before
        marker.write_bytes(original)


def test_two_real_processes_compete_for_same_joint_predecessor(tmp_path):
    import json
    import subprocess
    import sys
    import time
    service = open_service(tmp_path, new=True)
    token = service.snapshot_status()['joint_commit_id']
    worker = '''import json,sys,time
from pathlib import Path
sys.path[:0]=[sys.argv[1],sys.argv[2]]
from test_joint_volume import open_service
from test_r1_data_only import request,scalar_output
from wfd_sdk.writerlock import WriterBusy
root,token,identity,gate,ready,result=sys.argv[3:]
service=open_service(Path(root))
Path(ready).write_text('ready')
for _ in range(1000):
 if Path(gate).exists():break
 time.sleep(.01)
else:raise RuntimeError('barrier timeout')
try:
 doc=request([scalar_output('a','race.a','1'),scalar_output('b','race.b','2')],identity,consistency_groups={'pair':['a','b']})
 published=service.submit(doc,expected_commit_id=token)
 out={'state':published['state'],'snapshot_id':published.get('snapshot_id'),'count':len(published.get('output_results',[]))}
except (ValueError,WriterBusy) as error:out={'state':'rejected','code':str(error)}
Path(result).write_text(json.dumps(out))
'''
    processes = []
    for index in range(2):
        processes.append(subprocess.Popen([sys.executable, '-I', '-c', worker,
            str(Path(__file__).parent), str(HERE), str(tmp_path), token, 'race-' + str(index),
            str(tmp_path/'go'), str(tmp_path/f'ready{index}'), str(tmp_path/f'result{index}')]))
    try:
        until = time.monotonic()+15
        while not all((tmp_path/f'ready{i}').exists() for i in range(2)):
            assert time.monotonic()<until
            time.sleep(.01)
        (tmp_path/'go').write_text('go')
        for process in processes: assert process.wait(timeout=20) == 0
    finally:
        for process in processes:
            if process.poll() is None: process.kill(); process.wait()
    results=[json.loads((tmp_path/f'result{i}').read_text()) for i in range(2)]
    assert sorted(r['state'] for r in results) == ['published_formal', 'rejected'], results
    winner=next(r for r in results if r['state']=='published_formal')
    assert winner['count']==2
    reopened=open_service(tmp_path)
    assert reopened.snapshot_status()['snapshot_id']==winner['snapshot_id']
    assert reopened.engine.state.view()['record']['predecessor_commit']==token
