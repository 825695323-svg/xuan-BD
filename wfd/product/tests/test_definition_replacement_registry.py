"""Real isolated local store and machine approval; no user data or forged bindings."""
import copy
import json
import subprocess
import sys
from datetime import datetime, timedelta

import pytest
from test_r1_data_only import make_data_service, request, scalar_output
from test_product_query import known_second
from wfd_sdk.definition_replacement_registry import digest, ACTIONS, FILE, SCOPE
from wfd_sdk.product_holdings import resolve_target_instance
from test_store_opening import machine_config
from test_product_service import HERE


def seed(tmp_path):
    service = make_data_service(tmp_path)
    old = scalar_output('old', 'test.replacement.approval', '1')
    old['definition_public_time'] = known_second(2024, 1, 1)
    old['definition']['unit_code'] = 'per_field'
    field = dict(field_code='a', data_type='decimal', unit_code='count', measurement_nature='flow', time_role='observation')
    old['definition']['field_definitions'] = [field]
    old['payload'] = {'kind': 'tabular_rows', 'rows': [{'business_key': 'old', 'subject': old['subject'],
        'observation_time': known_second(2024, 1, 1), 'values': {'a': {'data_type': 'decimal', 'value_state': 'valid_value', 'value': '1'}}}]}
    first = service.submit(request([old], 'approval-old'))
    assert first['state'] == 'published_formal', first
    new = copy.deepcopy(old); new['output_key'] = 'new'
    new['definition']['field_definitions'].append({**field, 'field_code': 'b'})
    new['payload']['rows'][0]['business_key'] = 'new'
    new['payload']['rows'][0]['values']['b'] = {'data_type': 'decimal', 'value_state': 'valid_value', 'value': '2'}
    new['definition_public_time'] = known_second(2024, 2, 1)
    second = service.submit(request([new], 'approval-new', parent=first['snapshot_id']))
    assert second['state'] == 'published_formal', second
    sid, pid = second['snapshot_id'], second['output_results'][0]['product_id']
    assert pid == first['output_results'][0]['product_id']
    rows = service.read_product_page(pid, snapshot_id=sid, include_definition_publication=True)['rows']
    bindings = {r['record_ref']['logical_key']: r['source_binding']['definition_publication'] for r in rows}
    scope = dict(instance_id=resolve_target_instance(service.root)['instance_id'], product_id=pid, business_scope='test.explicit-local-operator')
    edge = {**scope, 'snapshot_id': sid, 'public_time': known_second(2024, 3, 1),
        'valid_from': '2024-04-01T00:00:00Z', 'valid_until': '2030-01-01T00:00:00Z',
        **{k: {f: bindings[k][f] for f in ('record_ref', 'definition_ref', 'binding_digest')} for k in ('old', 'new')}}
    grants = [{'operation': action, **scope} for action in ACTIONS]
    return service, edge, scope, grants


def call(tmp_path, service, action, payload, grants=(), roles=('read', 'register', 'publish')):
    folder = tmp_path / ('machine-' + str(len(list(tmp_path.glob('machine-*')))))
    folder.mkdir()
    path = machine_config(folder, service.root, 'data_only', roles, caller_id='r1-test')
    config = json.loads(path.read_text()); config['definition_replacement_access'] = list(grants)
    path.write_text(json.dumps(config))
    doc = {'protocol_version': 'wfd.product-machine/0.1', 'request_id': 'replacement', 'operation': action,
           'arguments': {'request' if action == 'resolve_definition_replacement' else 'command': payload}}
    # Match BD's actual absolute-script entry, not only package-import startup.
    done = subprocess.run([sys.executable, '-I', '-B', str(HERE / 'wfd_sdk/product_machine.py'), '--config', str(path)],
                          input=json.dumps(doc), text=True, capture_output=True, timeout=60)
    assert done.stdout, done.stderr
    return json.loads(done.stdout)


def command(scope, edge, catalog, action='approve_definition_replacement'):
    body = {'scope': scope, 'approver': 'r1-test', 'expected_catalog_digest': catalog,
            'statement' if action == 'approve_definition_replacement' else 'approval_digest': edge}
    return {**body, 'confirmation_digest': digest({'operation': action, **body})}


def query(edge):
    return {**{k: edge[k] for k in (*SCOPE, 'snapshot_id')}, 'old_definition_ref': edge['old']['definition_ref'],
            'business_at': '2025-01-01T00:00:00Z', 'public_cutoff': '2099-01-01T00:00:00Z'}


def test_explicit_machine_approval_read_reopen_and_disable(tmp_path):
    service, edge, scope, grants = seed(tmp_path)
    before = service.read_product_page(edge['product_id'], snapshot_id=edge['snapshot_id'])
    cmd = command(scope, edge, digest([]))
    # All generic roles are insufficient; authority cannot be granted by payload.
    denied = call(tmp_path, service, 'approve_definition_replacement', cmd)
    assert not denied['ok'] and 'ACTION_DENIED' in str(denied)
    assert not (service.root / FILE).exists()
    bad = {**cmd, 'confirmation_digest': 'wrong'}
    assert not call(tmp_path, service, 'approve_definition_replacement', bad, grants)['ok']
    approved = call(tmp_path, service, 'approve_definition_replacement', cmd, grants)
    assert approved['ok'], approved
    result = approved['result']
    assert result['approver'] == 'r1-test'
    same_second = call(tmp_path, service, 'resolve_definition_replacement', {**query(edge), 'public_cutoff': result['approved_at']}, grants)
    assert same_second['result']['status'] == 'unknown'
    next_second = (datetime.strptime(result['approved_at'], '%Y-%m-%dT%H:%M:%SZ') + timedelta(seconds=1)).strftime('%Y-%m-%dT%H:%M:%SZ')
    assert call(tmp_path, service, 'resolve_definition_replacement', {**query(edge), 'public_cutoff': next_second}, grants)['result']['status'] == 'selected'
    selected = call(tmp_path, service, 'resolve_definition_replacement', query(edge), grants)
    assert selected["ok"], json.dumps(selected)
    assert selected['result']['status'] == 'selected'
    assert selected['result']['candidate'] == edge['new']
    historical = call(tmp_path, service, 'resolve_definition_replacement', {**query(edge), 'public_cutoff': '2025-01-01T00:00:00Z'}, grants)
    assert historical['result']['status'] == 'unknown' and 'candidate' not in historical['result']
    assert not call(tmp_path, service, 'approve_definition_replacement', cmd, grants)['ok']  # stale CAS
    again = command(scope, edge, result['catalog_digest'])
    assert not call(tmp_path, service, 'approve_definition_replacement', again, grants)['ok']
    reversed_edge = {**edge, 'old': edge['new'], 'new': edge['old']}
    conflict = call(tmp_path, service, 'approve_definition_replacement', command(scope, reversed_edge, result['catalog_digest']), grants)
    assert not conflict['ok'] and 'COMPOUND_OR_DISABLED_CONFLICT' in str(conflict)
    active_bytes = (service.root / FILE).read_bytes()
    disable = command(scope, result['approval_digest'], result['catalog_digest'], 'disable_definition_replacement')
    stopped = call(tmp_path, service, 'disable_definition_replacement', disable, grants)
    assert stopped['ok'], stopped
    assert call(tmp_path, service, 'resolve_definition_replacement', query(edge), grants)['result']['reason'] == 'APPROVAL_DISABLED'
    assert not call(tmp_path, service, 'approve_definition_replacement', command(scope, edge, stopped['result']['catalog_digest']), grants)['ok']
    disabled_bytes = (service.root / FILE).read_bytes()
    (service.root / FILE).write_bytes(active_bytes)
    assert not call(tmp_path, service, 'resolve_definition_replacement', query(edge), grants)['ok']
    (service.root / FILE).write_bytes(disabled_bytes)
    assert make_data_service(tmp_path).read_product_page(edge['product_id'], snapshot_id=edge['snapshot_id']) == before


def test_permissions_fixed_evidence_and_scope_fail_closed(tmp_path):
    service, edge, scope, grants = seed(tmp_path)
    cmd = command(scope, edge, digest([]))
    for roles in (('read',), ('register', 'publish'), ('read', 'register'), ('read', 'publish')):
        denied = call(tmp_path, service, 'approve_definition_replacement', cmd, grants, roles)
        assert not denied['ok'], denied
        assert not (service.root / FILE).exists()
    for field in ('instance_id', 'product_id', 'business_scope'):
        wrong_scope = {**scope, field: 'wrong'}
        assert not call(tmp_path, service, 'approve_definition_replacement', command(wrong_scope, edge, digest([])), grants)['ok']
    for field in ('binding_digest', 'definition_ref', 'record_ref'):
        wrong = copy.deepcopy(edge)
        wrong['new'][field] = 'sha256:wrong' if field == 'binding_digest' else {'digest': 'wrong'}
        assert not call(tmp_path, service, 'approve_definition_replacement', command(scope, wrong, digest([])), grants)['ok']
    for change in ({'valid_until': edge['valid_from']}, {'public_time': {'status': 'unknown'}}):
        assert not call(tmp_path, service, 'approve_definition_replacement', command(scope, {**edge, **change}, digest([])), grants)['ok']
    wrong_actor = {**cmd, 'approver': 'other'}
    wrong_actor['confirmation_digest'] = digest({'operation': 'approve_definition_replacement', **{k: v for k,v in wrong_actor.items() if k != 'confirmation_digest'}})
    assert not call(tmp_path, service, 'approve_definition_replacement', wrong_actor, grants)['ok']
    assert not (service.root / FILE).exists()


def test_catalog_loss_corruption_and_wrong_instance_refuse(tmp_path):
    service, edge, scope, grants = seed(tmp_path)
    approved = call(tmp_path, service, 'approve_definition_replacement', command(scope, edge, digest([])), grants)
    assert approved['ok'], approved
    path = service.root / FILE
    raw = path.read_bytes()
    doc = json.loads(raw); doc['events'][0]['statement']['new']['binding_digest'] = 'sha256:tampered'
    path.write_text(json.dumps(doc))
    assert not call(tmp_path, service, 'resolve_definition_replacement', query(edge), grants)['ok']
    path.write_bytes(raw)
    assert call(tmp_path, service, 'resolve_definition_replacement', query(edge), grants)['result']['status'] == 'selected'
    path.unlink()  # Isolated fault injection only; marker prevents silent empty reset.
    failed = call(tmp_path, service, 'resolve_definition_replacement', query(edge), grants)
    assert not failed['ok'] and 'CATALOG_MISSING' in str(failed)
    assert not call(tmp_path, service, 'approve_definition_replacement', command(scope, edge, digest([])), grants)['ok']
    path.write_bytes(raw)
    other, _, _, _ = seed(tmp_path / 'other')
    denied = call(tmp_path, other, 'resolve_definition_replacement', query(edge), grants)
    assert not denied['ok'] and 'INSTANCE_MISMATCH' in str(denied)


def test_volume_on_disk_cannot_omit_volume_config_to_gain_approval(tmp_path):
    service, edge, scope, grants = seed(tmp_path)
    # Isolated volume-binding fault fixture, not a real user's volume.
    path = service.root / 'catalog/product_service/volume_binding.json'
    path.write_text(json.dumps({'instance_id': scope['instance_id']}))
    for operation, payload in [('approve_definition_replacement', command(scope, edge, digest([]))),
                               ('resolve_definition_replacement', query(edge))]:
        denied = call(tmp_path, service, operation, payload, grants)
        assert not denied['ok'] and 'LOCAL_ONLY' in str(denied), denied
    assert not (service.root / FILE).exists()


def test_absolute_script_default_capabilities_preserves_response_identity(tmp_path):
    from test_fixed_read_pages import inventory
    service, _, _, _ = seed(tmp_path)
    before = inventory(service.root)
    path = machine_config(tmp_path, service.root, 'data_only', ['read'], caller_id='r1-test')
    doc = {'protocol_version': 'wfd.product-machine/0.1', 'request_id': 'script-capabilities',
           'operation': 'capabilities', 'arguments': {}}
    completed = subprocess.run([sys.executable, '-I', '-B', str(HERE / 'wfd_sdk/product_machine.py'),
                                '--config', str(path)], input=json.dumps(doc), text=True,
                               capture_output=True, timeout=60)
    response = json.loads(completed.stdout)
    assert response['ok'], response
    assert response['request_id'] == 'script-capabilities'
    assert response['operation'] == 'capabilities'
    assert response['protocol_version'] == doc['protocol_version']
    assert inventory(service.root) == before
