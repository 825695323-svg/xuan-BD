"""Synthetic explicit SDK governance; not BD activation or human approval."""
import copy
import pytest
from test_joint_volume import open_service
from test_post_publication_correction import two_series_doc, revised_named_doc, previous_refs, gov
from wfd_sdk.duckdb_sdk import canonical, sha
from wfd_sdk.state import StateStore


def token(service):
    return service.engine.state.view()['commit_id']


def prepare_repair(tmp_path, *, original_group=True, member_count=2):
    service = open_service(tmp_path, new=True)
    initial = two_series_doc('joint-governance-original')
    if original_group:
        initial['consistency_groups'] = {'pair': ['series_a', 'series_b']}
    first = service.submit(initial, expected_commit_id=token(service))
    assert first['state'] == 'published_formal', first
    sid = first['snapshot_id']
    original = {o['output_key']: service.read(o['product_id'], snapshot_id=sid)['rows']
                for o in first['output_results']}
    scopes = [{'product_id': o['product_id'], 'snapshot_id': sid,
               'record_versions': [o['records'][0]['record_version']]} for o in first['output_results'][:member_count]]
    before = token(service)
    gov.suspend(service.root, {
        'issue_id': 'joint-pair', 'error_type': 'mapping_error',
        'reason': 'synthetic pair mapping correction', 'evidence_digest': 'sha256:' + 'a' * 64,
        'error_binding_digest': 'sha256:' + 'b' * 64, 'impact_digest': 'sha256:' + 'c' * 64,
        'declared_at_utc': '2026-11-07T00:00:00Z', 'scopes': scopes,
    }, expected_commit_id=before)
    assert token(service) != before
    assert service.snapshot_status()['snapshot_id'] == sid
    revisions = []
    for out in first['output_results'][:member_count]:
        with pytest.raises(ValueError, match='USAGE_SUSPENDED'):
            service.read(out['product_id'], snapshot_id=sid)
        key = out['output_key']
        revisions.append(revised_named_doc(first, key, 'correction.series.' + key[-1],
            out['product_id'], sid, out['records'][0]['record_version'],
            value='11' if key == 'series_a' else '21', request_id='joint-pair-repair'))
    doc = revisions[0]
    if member_count == 2:
        doc['outputs'].append(revisions[1]['outputs'][0])
    doc['consistency_groups'] = {'pair': [o['output_key'] for o in doc['outputs']]}
    digest = sha(canonical(doc))
    before = token(service)
    gov.authorize_repair(service.root, {
        'ticket_id': 'joint-pair-ticket', 'issue_id': 'joint-pair',
        'document_digest': digest, 'request_identity': doc['request_identity'],
        'revisions': previous_refs(doc), 'confirmation_digest': digest, 'repair_mode': 'processing_repair',
        'error_binding_digest': 'sha256:' + 'b' * 64, 'impact_digest': 'sha256:' + 'c' * 64,
        'budget': {'max_rows': 10, 'max_document_bytes': 786432, 'series_count': 2},
    }, expected_commit_id=before)
    assert token(service) != before
    assert service.snapshot_status()['snapshot_id'] == sid
    return service, first, doc, original


def assert_repaired(service, first, result, original):
    assert result['state'] == 'published_formal', result
    sid = result['snapshot_id']
    assert sid != first['snapshot_id']
    issue = next(i for i in gov.load(service.root)['issues'] if i['issue_id'] == 'joint-pair')
    assert issue['state'] == 'resolved'
    assert issue['resolution']['replacement_snapshot_id'] == sid
    assert set(issue['resolution']['replacement_record_versions']) == {
        r['record_version'] for o in result['output_results'] for r in o['records']}
    for out in result['output_results']:
        expected = '11' if out['output_key'] == 'series_a' else '21'
        assert service.read(out['product_id'], snapshot_id=sid)['rows'][0]['row']['value_decimal'] == expected
    for out in first['output_results']:
        with pytest.raises(ValueError, match='USAGE_KNOWN_ISSUE_LEGACY'):
            service.read(out['product_id'], snapshot_id=first['snapshot_id'])
        service._usage_audit_issue_id = 'joint-pair'
        try:
            audit = service.read(out['product_id'], snapshot_id=first['snapshot_id'])
            assert audit['rows'] == original[out['output_key']]
            assert audit['usage_governance']['publishable'] is False
        finally:
            service._usage_audit_issue_id = None
    assert not (service.root / 'catalog/state.json').exists()
    assert not (service.root / 'catalog/usage_suspensions.json').exists()


def test_joint_full_group_repair_resolves_at_same_flip_and_reopens(tmp_path):
    service, first, doc, original = prepare_repair(tmp_path)
    authorized = token(service)
    result = service.submit(doc, expected_commit_id=authorized)
    assert_repaired(service, first, result, original)
    reopened = open_service(tmp_path)
    assert_repaired(reopened, first, result, original)
    pointer = reopened.engine.state.path.read_bytes()
    replay = reopened.submit(doc, expected_commit_id=authorized)
    assert replay['snapshot_id'] == result['snapshot_id']
    assert reopened.engine.state.path.read_bytes() == pointer


def test_joint_incomplete_group_cannot_consume_complete_authorization(tmp_path):
    service, first, doc, _original = prepare_repair(tmp_path)
    pointer = service.engine.state.path.read_bytes()
    usage = copy.deepcopy(gov.load(service.root))
    incomplete = copy.deepcopy(doc)
    incomplete['outputs'].pop()
    incomplete['consistency_groups'] = {'pair': ['series_a']}
    with pytest.raises(ValueError):
        service.submit(incomplete, expected_commit_id=token(service))
    assert service.engine.state.path.read_bytes() == pointer
    assert gov.load(service.root) == usage
    assert service.snapshot_status()['snapshot_id'] == first['snapshot_id']


@pytest.mark.parametrize('stage', ['before', 'after'])
def test_joint_group_repair_failure_replays_without_split_state(tmp_path, monkeypatch, stage):
    service, first, doc, original = prepare_repair(tmp_path)
    authorized = token(service)
    write = StateStore._write_atomic
    triggered = []
    def broken(store, data):
        if store.path.name == 'joint-current.json' and not triggered:
            triggered.append(True)
            if stage == 'after':
                write(store, data)
            raise OSError('synthetic governance pointer interruption')
        return write(store, data)
    with monkeypatch.context() as patch:
        patch.setattr(StateStore, '_write_atomic', broken)
        interrupted = service.submit(doc, expected_commit_id=authorized)
        assert interrupted['state'] != 'published_formal', interrupted
    assert triggered
    view = service.engine.state.view()
    issue = next(i for i in view['usage']['issues'] if i['issue_id'] == 'joint-pair')
    assert (view['commit_id'] == authorized) == (stage == 'before')
    assert (view['record']['state']['active_head'] == first['snapshot_id']) == (stage == 'before')
    assert (issue['state'] == 'resolved') == (stage == 'after')
    reopened = open_service(tmp_path)
    result = reopened.submit(doc, expected_commit_id=authorized)
    assert_repaired(reopened, first, result, original)
    pointer = reopened.engine.state.path.read_bytes()
    again = reopened.submit(doc, expected_commit_id=authorized)
    assert again['snapshot_id'] == result['snapshot_id']
    assert reopened.engine.state.path.read_bytes() == pointer


def extra_issue(first, identity):
    out = first['output_results'][0]
    return {'issue_id': identity, 'error_type': 'mapping_error',
            'reason': 'synthetic additional governance observation',
            'evidence_digest': 'sha256:' + 'd' * 64,
            'error_binding_digest': 'sha256:' + 'e' * 64,
            'impact_digest': 'sha256:' + 'f' * 64,
            'declared_at_utc': '2026-11-07T00:00:00Z',
            'scopes': [{'product_id': out['product_id'], 'snapshot_id': first['snapshot_id'],
                        'record_versions': [out['records'][0]['record_version']]}]}


def test_changed_governance_commit_rejects_old_authorized_submit(tmp_path):
    service, first, doc, _ = prepare_repair(tmp_path)
    authorized = token(service)
    gov.suspend(service.root, extra_issue(first, 'later-issue'), expected_commit_id=authorized)
    pointer = service.engine.state.path.read_bytes()
    usage = gov.load(service.root)
    with pytest.raises(ValueError, match='JOINT_CAS_CONFLICT'):
        service.submit(doc, expected_commit_id=authorized)
    assert service.engine.state.path.read_bytes() == pointer
    assert gov.load(service.root) == usage
    assert service.snapshot_status()['snapshot_id'] == first['snapshot_id']


def test_group_repair_without_publish_permission_cannot_flip(tmp_path):
    service, first, doc, _ = prepare_repair(tmp_path)
    service.caller_roles = service.caller_roles - {'publish'}
    pointer = service.engine.state.path.read_bytes()
    usage = gov.load(service.root)
    result = service.submit(doc, expected_commit_id=token(service))
    assert result['state'] != 'published_formal', result
    assert service.engine.state.path.read_bytes() == pointer
    assert gov.load(service.root) == usage
    assert service.snapshot_status()['snapshot_id'] == first['snapshot_id']


def test_last_member_actual_fixed_read_failure_keeps_old_joint_state(tmp_path, monkeypatch):
    service, first, doc, _ = prepare_repair(tmp_path)
    last_pid = first['output_results'][-1]['product_id']
    pointer = service.engine.state.path.read_bytes()
    usage = gov.load(service.root)
    verify = service._verify_candidate_fixed_outputs
    failures = []
    def unavailable(snapshot, sid, results):
        entry = next(e for e in snapshot['files'] if e['product_id'] == last_pid)
        path = service.root / entry['file_relpath']
        raw = path.read_bytes()
        path.unlink()
        failures.append(sid)
        try:
            return verify(snapshot, sid, results)
        finally:
            path.write_bytes(raw)
    with monkeypatch.context() as patch:
        patch.setattr(service, '_verify_candidate_fixed_outputs', unavailable)
        result = service.submit(doc, expected_commit_id=token(service))
        assert result['state'] != 'published_formal', result
    assert failures
    assert service.engine.state.path.read_bytes() == pointer
    assert gov.load(service.root) == usage
    assert service.snapshot_status()['snapshot_id'] == first['snapshot_id']


def test_two_real_processes_cannot_overwrite_same_governance_predecessor(tmp_path):
    import json
    import subprocess
    import sys
    import time
    from pathlib import Path
    from test_product_service import HERE
    service, first, _doc, _ = prepare_repair(tmp_path)
    before = token(service)
    declarations = [extra_issue(first, 'parallel-' + str(i)) for i in range(2)]
    worker = """import json,sys,time
from pathlib import Path
sys.path[:0]=[sys.argv[1],sys.argv[2]]
from test_joint_volume import open_service
from wfd_sdk import usage_suspension as gov
from wfd_sdk.writerlock import WriterBusy
from wfd_sdk.state import StateError
root,token,source,ready,gate,result=sys.argv[3:]
service=open_service(Path(root))
declaration=json.loads(Path(source).read_text())
Path(ready).write_text('ready')
for _ in range(1500):
 if Path(gate).exists():break
 time.sleep(.01)
else:raise RuntimeError('barrier timeout')
try:
 out=gov.suspend(service.root,declaration,expected_commit_id=token)
 out={'ok':True,'issue_id':out['issue_id']}
except (ValueError,WriterBusy,StateError) as e:out={'ok':False,'error':str(e)}
Path(result).write_text(json.dumps(out))
"""
    processes = []
    for i, declaration in enumerate(declarations):
        source = tmp_path / f'declaration{i}.json'
        source.write_text(json.dumps(declaration))
        processes.append(subprocess.Popen([sys.executable, '-I', '-c', worker,
            str(Path(__file__).parent), str(HERE), str(tmp_path), before, str(source),
            str(tmp_path / f'gov-ready{i}'), str(tmp_path / 'gov-go'), str(tmp_path / f'gov-result{i}')]))
    try:
        until = time.monotonic() + 20
        while not all((tmp_path / f'gov-ready{i}').exists() for i in range(2)):
            assert time.monotonic() < until
            time.sleep(.01)
        (tmp_path / 'gov-go').write_text('go')
        for process in processes:
            assert process.wait(timeout=20) == 0
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait()
    results = [json.loads((tmp_path / f'gov-result{i}').read_text()) for i in range(2)]
    assert sorted(r['ok'] for r in results) == [False, True], results
    winner = next(r['issue_id'] for r in results if r['ok'])
    reopened = open_service(tmp_path)
    view = reopened.engine.state.view()
    assert view['record']['predecessor_commit'] == before
    assert view['record']['state']['active_head'] == first['snapshot_id']
    assert {i['issue_id'] for i in view['usage']['issues']} == {'joint-pair', winner}


@pytest.mark.parametrize('original_group,member_count', [(False, 2), (True, 1)])
def test_legitimate_scoped_ticket_cannot_invent_or_shrink_original_group(tmp_path, original_group, member_count):
    service, first, doc, _ = prepare_repair(tmp_path, original_group=original_group, member_count=member_count)
    pointer = service.engine.state.path.read_bytes()
    usage = gov.load(service.root)
    result = service.submit(doc, expected_commit_id=token(service))
    assert result['state'] != 'published_formal', result
    assert service.engine.state.path.read_bytes() == pointer
    assert gov.load(service.root) == usage
    assert service.snapshot_status()['snapshot_id'] == first['snapshot_id']


def test_missing_original_formal_receipt_blocks_repair_then_same_identity_recovers(tmp_path):
    service, first, doc, original = prepare_repair(tmp_path)
    authorized = token(service)
    original_snapshot = service.engine.read_snapshot(first['snapshot_id'])
    path = service.root / 'catalog/product_service/data_only_formal_publications' / (original_snapshot['request_key'] + '.json')
    raw = path.read_bytes()
    pointer = service.engine.state.path.read_bytes()
    usage = copy.deepcopy(gov.load(service.root))
    path.unlink()
    try:
        blocked = service.submit(doc, expected_commit_id=authorized)
        assert blocked['state'] != 'published_formal', blocked
        assert service.engine.state.path.read_bytes() == pointer
        assert gov.load(service.root) == usage
        assert service.snapshot_status()['snapshot_id'] == first['snapshot_id']
    finally:
        path.write_bytes(raw)
    assert path.read_bytes() == raw
    reopened = open_service(tmp_path)
    recovered = reopened.submit(doc, expected_commit_id=authorized)
    assert_repaired(reopened, first, recovered, original)
    repaired_pointer = reopened.engine.state.path.read_bytes()
    replay = reopened.submit(doc, expected_commit_id=authorized)
    assert replay['request_key'] == recovered['request_key']
    assert replay['snapshot_id'] == recovered['snapshot_id']
    assert reopened.engine.state.path.read_bytes() == repaired_pointer
