"""Current R07 legacy/write gates, through real isolated machine processes.

The historical L03/L04/L05 script was not retained. These tests name their
actual assertions rather than assigning unknown historical inputs to labels.
Generated business values are protocol fixtures, not market/source evidence.
"""
from __future__ import annotations

import copy
import hashlib
import json
import subprocess
import sys

from test_filter_production import machine_call, machine_config
from test_product_context import _relation_output, p4b_request, span
from test_product_query import (
    HERE, SOURCE_POLICY, UNIT_REGISTRY, base_document, field, known_day,
    request as read_request, sync_source_roles,
)
from test_r1_data_only import make_data_service, request, scalar_output
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_query import ProductQuery
from wfd_sdk.product_service import WFDProductService


def proof(root, name, value):
    (root / (name + '.json')).write_text(
        json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def legacy_config(root, service):
    policy = {key: value for key, value in SOURCE_POLICY.items()
              if not key.startswith('may_export') and key not in {'may_redistribute', 'export_scope'}}
    return machine_config(
        root, service, profile='legacy', sources={'fixture': policy}, units=UNIT_REGISTRY,
        caller={'caller_id': 'p4a1-test', 'trusted_actor_namespace': 'wfd.test.curated',
                'roles': ['read', 'read_evidence', 'evidence_write', 'register', 'submit', 'publish']})


def published(path, doc):
    response = machine_call(path, 'submit', {'document': doc})
    assert response['ok'] is True, response
    assert response['result'].get('state', response['result'].get('status')) == 'published_formal', response
    assert response['business_outcome']['published_formal'] is True, response
    return response['result']


def rejected(path, doc, expected, *, state='rejected'):
    response = machine_call(path, 'submit', {'document': doc})
    assert response['ok'] is True, response
    assert response['business_outcome']['published_formal'] is False, response
    result = response['result']
    assert result.get('state', result.get('status')) == state, result
    issues = result.get('errors', []) + [issue for out in result.get('output_results', [])
                                       for issue in out.get('errors', [])]
    assert expected in {issue['code'] for issue in issues}, response
    status = machine_call(path, 'request_status', {'request_identity': doc['request_identity']})
    assert status['ok'] is True and status['result']['state'] == state, status
    replay = machine_call(path, 'recovery', {'document': doc})
    assert replay['ok'] is True, replay
    if state == 'rejected':
        assert replay['result'].get('idempotent_replay') is True, replay
    else:
        # Registered definitions are retained independently of publication.
        # This recoverable state may re-evaluate the original business gate.
        assert replay['result']['snapshot_id'] is None, replay
        repeated = [issue['code'] for out in replay['result']['output_results']
                    for issue in out.get('errors', [])]
        assert expected in repeated, replay
    assert replay['result'].get('state', replay['result'].get('status')) == state, replay
    return response


def test_legacy_six_read_operations_actual_rows_evidence_and_restart(tmp_path):
    service, doc = base_document(tmp_path)
    subject = {'kind': 'physical_object', 'namespace': 'r07.fixture', 'id': 'a'}
    other = dict(subject, id='b')
    template = doc['outputs'][0]
    edge = {'business_key': 'linked', 'subject': subject, 'object': other,
            'relation_type': 'linked_to', 'effective_period': span(2020, 2030),
            'public_time': known_day(2020, 1, 2)}
    relation = _relation_output(template, 'relation', 'r07.compat.relation', subject, [edge])
    rule_row = dict(edge, business_key='rule', relation_type='applies_to', values={
        'rule_code': {'data_type': 'text', 'value_state': 'valid_value', 'value': 'R07-1'},
        'rule_text': {'data_type': 'text', 'value_state': 'valid_value', 'value': 'generated bounded rule'}})
    rule = _relation_output(template, 'rule', 'r07.compat.rule', subject, [rule_row])
    rule['new_definition_declaration']['field_definitions'] = [
        field('rule_code', 'text', 'text'), field('rule_text', 'text', 'text')]
    event = copy.deepcopy(template)
    event.update(output_key='event', logical_domain='events', subject=subject,
                 new_definition_declaration={
                     'semantic_code': 'r07.compat.event', 'measurement_nature': 'event',
                     'unit_code': 'not_applicable', 'definition_authority': 'p4a1.test', 'time_role': 'event'},
                 payload={'kind': 'event_records', 'rows': [{
                     'event_id': 'event-1', 'subject': subject, 'event_type': 'dividend',
                     'content_nature': 'plan', 'event_time': known_day(2025, 1, 2),
                     'public_time': known_day(2025, 1, 2), 'expected_time': known_day(2025, 6, 1),
                     'status': 'planned'}]})
    value = copy.deepcopy(template)
    value.update(output_key='value', subject=subject)
    value['payload']['rows'] = value['payload']['rows'][:1]
    doc['outputs'] = [relation, rule, event, value]
    sync_source_roles(doc)
    path = legacy_config(tmp_path, service)
    submitted = published(path, doc)
    snapshot = submitted['snapshot_id']
    pid = submitted['output_results'][3]['product_id']
    dataset = doc['request_identity']['dataset_id']
    requests = {'read_product': read_request(dataset, snapshot, pid, ['value_decimal'], subject=subject)}
    for operation in ('read_company_context', 'read_relation_graph', 'read_applicable_rules',
                      'read_event_timeline', 'trace_evidence'):
        requests[operation] = p4b_request(dataset, snapshot, operation, subject)
    requests['trace_evidence']['product_id'] = pid
    requests['read_relation_graph']['max_depth'] = 1
    def sdk_read(inner):
        engine = WFDDuckDBPrototype.open_existing(
            service.root, load_protocol_validator(HERE / 'protocol'),
            runtime_root=tmp_path / 'sdk-read-runtime', read_only=True, sandbox=False)
        reader = WFDProductService(engine, allowed_sources={'fixture': SOURCE_POLICY},
                                  caller_roles={'read', 'read_evidence'}, caller_id='r07-sdk-read',
                                  unit_registry=UNIT_REGISTRY, can_register=False)
        return ProductQuery(reader).execute(inner)
    first = {}
    for operation, inner in requests.items():
        first[operation] = sdk_read(inner)
        assert first[operation]['operation'] == operation
    assert first['read_product']['rows'][0]['values']['value_decimal']['value'] == '157066'
    assert any(row['row_type'] == 'value' for row in first['read_company_context']['rows'])
    assert len(first['read_relation_graph']['edges']) == 1
    assert first['read_relation_graph']['edges'][0]['relation_type'] == 'linked_to'
    assert first['read_applicable_rules']['rules'][0]['rule']['rule_code'] == 'R07-1'
    assert first['read_event_timeline']['rows'][0]['event']['status'] == 'planned'
    assert first['trace_evidence']['evidence'][0]['verified'] is True
    status = machine_call(path, 'request_status', {'request_identity': doc['request_identity']})
    assert status['result']['state'] == 'published_formal', status
    recovered = machine_call(path, 'recovery', {'document': doc})
    assert recovered['result']['snapshot_id'] == snapshot, recovered
    assert recovered['result']['recovery']['prior_state'] == 'published_formal', recovered
    # The original SDK exposes six query operations. The bounded legacy
    # machine deliberately exposes only read_product, not the five contexts.
    machine_read = machine_call(path, 'read_product', {'request': requests['read_product']})
    assert machine_read['ok'] is True
    assert machine_read['result']['rows'] == first['read_product']['rows']
    unsupported = machine_call(path, 'read_company_context', {'request': requests['read_company_context']})
    assert unsupported['ok'] is False and unsupported['error']['code'] == 'OPERATION_UNSUPPORTED'
    for operation, inner in requests.items():
        again = sdk_read(inner)
        for field_name in ('rows', 'nodes', 'edges', 'rules', 'evidence'):
            if field_name in first[operation]:
                assert again[field_name] == first[operation][field_name]
    reused_doc = copy.deepcopy(doc)
    reused_doc['request_identity']['request_id'] = 'r07-legacy-pinned-reuse'
    reused_doc['expected_parent_snapshot_id'] = snapshot
    reused_doc['outputs'] = [copy.deepcopy(value)]
    reused_output = reused_doc['outputs'][0]
    reused_output.update(definition_mode='reuse', new_definition_declaration=None,
                         definition_ref=submitted['output_results'][3]['definition_ref'])
    reused_output['payload']['rows'][0]['business_key'] = 'legacy-next-period'
    sync_source_roles(reused_doc)
    reused = published(path, reused_doc)
    assert reused['output_results'][0]['product_id'] == pid
    assert reused['output_results'][0]['registration_state'] == 'reused'
    old_fixed = machine_call(path, 'fixed_read', {'snapshot_id': snapshot, 'product_id': pid})
    new_fixed = machine_call(path, 'fixed_read', {'snapshot_id': reused['snapshot_id'], 'product_id': pid})
    assert old_fixed['result']['row_count'] == 1 and new_fixed['result']['row_count'] == 2
    assert machine_call(path, 'recovery', {'document': reused_doc})['result']['snapshot_id'] == reused['snapshot_id']
    proof(tmp_path, 'six-read-restart', {'request_identity': doc['request_identity'],
          'snapshot_id': snapshot, 'outputs': submitted['output_results'], 'results': first,
          'legacy_pinned_reuse': reused, 'old_fixed': old_fixed, 'new_fixed': new_fixed,
          'reopened': True, 'historical_script_replayed': False,
          'sdk_operations': list(requests), 'legacy_machine_public_query_operations': ['read_product']})


def data_seed(root):
    service = make_data_service(root)
    path = machine_config(root, service)
    doc = request([scalar_output('a', 'r07.target.a', '10'),
                   scalar_output('b', 'r07.target.b', '90')], 'r07-write-seed')
    result = published(path, doc)
    return service, path, doc, result


def reuse(template, result, *, value='11', mode='source_correction'):
    output = copy.deepcopy(template)
    output.update(definition_mode='reuse', definition=None,
                  definition_ref=result['definition_ref'], input_mode=mode)
    output['payload']['rows'][0]['value_decimal'] = value
    return output


def previous(result, snapshot, key):
    return {'product_id': result['product_id'], 'snapshot_id': snapshot,
            'logical_key': key, 'revision_id': result['records'][0]['record_version']}


def test_write_cross_product_fixed_reference_and_allowed_value_revision(tmp_path):
    service, path, original, seed = data_seed(tmp_path)
    a, b = seed['output_results']
    snapshot = seed['snapshot_id']
    output = reuse(original['outputs'][0], b)
    output['revisions'] = {'row-a': {'previous': previous(a, snapshot, 'row-a'), 'reason': 'cross product test'}}
    cross = request([output], 'r07-cross-definition', parent=snapshot)
    assert not list(service._structured_validator.iter_errors(cross))
    rejected(path, cross, 'REVISION_TARGET_MISMATCH', state='registered_not_published')
    assert service.engine.head()['snapshot_id'] == snapshot
    output = reuse(original['outputs'][0], a, mode='partial_observation')
    duplicate = request([output], 'r07-no-revision', parent=snapshot)
    assert not list(service._structured_validator.iter_errors(duplicate))
    rejected(path, duplicate, 'DUPLICATE_LOGICAL_KEY_REQUIRES_REVISION', state='registered_not_published')
    output = reuse(original['outputs'][0], a)
    output['revisions'] = {'row-a': {'previous': previous(b, snapshot, 'row-a'), 'reason': 'foreign predecessor'}}
    foreign = request([output], 'r07-cross-predecessor', parent=snapshot)
    rejected(path, foreign, 'REVISION_TARGET_MISMATCH', state='registered_not_published')
    output['revisions']['row-a']['previous'] = previous(a, snapshot, 'row-a')
    forged_output = copy.deepcopy(output)
    forged_output['payload']['rows'][0]['record_version'] = 'r_client_forged'
    forged = request([forged_output], 'r07-forged-row-version', parent=snapshot)
    rejected(path, forged, 'SCHEMA_INVALID', state='registered_not_published')
    correction = request([output], 'r07-allowed-revision', parent=snapshot)
    corrected = published(path, correction)
    fresh = corrected['output_results'][0]['records'][0]
    assert fresh['record_id'] == a['records'][0]['record_id']
    assert fresh['record_version'] != a['records'][0]['record_version']
    old = machine_call(path, 'fixed_read', {'snapshot_id': snapshot, 'product_id': a['product_id']})['result']['rows'][0]
    current = machine_call(path, 'fixed_read', {'snapshot_id': corrected['snapshot_id'], 'product_id': a['product_id']})['result']['rows'][0]
    assert old['row']['value_decimal'] == '10' and current['row']['value_decimal'] == '11'
    assert old['record_version'] == a['records'][0]['record_version']
    assert current['record_version'] == fresh['record_version']
    unchanged = machine_call(path, 'fixed_read', {'snapshot_id': corrected['snapshot_id'], 'product_id': b['product_id']})['result']['rows'][0]
    assert unchanged['row']['value_decimal'] == '90'
    assert unchanged['record_version'] == b['records'][0]['record_version']
    tampered = copy.deepcopy(correction)
    tampered['outputs'][0]['payload']['rows'][0]['value_decimal'] = '999'
    conflict = machine_call(path, 'submit', {'document': tampered})
    assert conflict['result']['errors'][0]['code'] == 'REQUEST_ID_CONFLICT', conflict
    assert machine_call(path, 'request_status', {'request_identity': correction['request_identity']})['result']['snapshot_id'] == corrected['snapshot_id']
    assert machine_call(path, 'recovery', {'document': correction})['result']['snapshot_id'] == corrected['snapshot_id']
    proof(tmp_path, 'cross-product-revision', {'seed': seed, 'corrected': corrected,
          'old_fixed': old, 'new_fixed': current, 'other_product_fixed': unchanged})


def test_write_registration_permission_and_external_profile_are_host_bound(tmp_path):
    service, path, original, seed = data_seed(tmp_path)
    snapshot = seed['snapshot_id']
    candidate = reuse(original['outputs'][0], seed['output_results'][0],
                      value='30', mode='partial_observation')
    candidate['payload']['rows'][0]['business_key'] = 'permitted-next-a'
    document = request([candidate], 'r07-no-register', parent=snapshot)
    config = json.loads(path.read_text())
    config['caller']['roles'].remove('register')
    restricted = tmp_path / 'restricted.json'
    restricted.write_text(json.dumps(config))
    restricted.chmod(0o600)
    rejected(restricted, document, 'REGISTRATION_PERMISSION_DENIED')
    external = copy.deepcopy(document)
    external['request_identity']['request_id'] = 'r07-external-profile'
    external['profile'] = 'legacy'
    rejected(path, external, 'SCHEMA_INVALID')
    response = machine_call(path, 'submit', {'document': document, 'profile': 'legacy'})
    assert response['ok'] is False and response['error']['code'] == 'REQUEST_INVALID', response
    assert machine_call(path, 'capabilities', {})['result']['profile'] == 'data_only'
    assert service.engine.head()['snapshot_id'] == snapshot
    # The unrestricted host can publish the same permitted business fields;
    # permission is not supplied by an external payload field.
    allowed = copy.deepcopy(document)
    allowed['request_identity']['request_id'] = 'r07-register-allowed'
    actual = published(path, allowed)
    assert actual['output_results'][0]['product_id'] == seed['output_results'][0]['product_id']
    proof(tmp_path, 'host-write-permission', {'restricted_roles': config['caller']['roles'],
          'original_head': snapshot, 'allowed': actual, 'product_acl_model': 'caller-scoped; no per-product ACL'})


def test_valid_pinned_definition_incompatible_payload_rejects_semantically(tmp_path):
    service, path, original, seed = data_seed(tmp_path)
    output = reuse(original['outputs'][0], seed['output_results'][0], mode='partial_observation')
    output['payload'] = {'kind': 'tabular_rows', 'rows': [{
        'business_key': 'incompatible-row', 'observation_time': known_day(2025, 1, 2),
        'values': {'undeclared': {'data_type': 'decimal', 'value': '12', 'value_state': 'valid_value'}}}]}
    doc = request([output], 'r07-valid-ref-incompatible-payload', parent=seed['snapshot_id'])
    assert not list(service._structured_validator.iter_errors(doc))
    result = machine_call(path, 'submit', {'document': doc})
    issues = [issue for out in result['result']['output_results'] for issue in out.get('errors', [])]
    assert [issue['code'] for issue in issues] == ['FIELD_DEFINITIONS_REQUIRED'], result
    assert result['result']['state'] == 'rejected' and result['result']['snapshot_id'] is None, result
    rejected(path, doc, 'FIELD_DEFINITIONS_REQUIRED')
    assert service.engine.head()['snapshot_id'] == seed['snapshot_id']
    proof(tmp_path, 'valid-ref-incompatible', {'definition_ref': output['definition_ref'], 'result': result})


def test_multiple_dates_old_typed_read_candidate_and_new_filter_exact_points(tmp_path):
    service, doc = base_document(tmp_path)
    output = doc['outputs'][0]
    output['subject'] = {'kind': 'instrument', 'namespace': 'r07.fixture', 'id': 'multi-date'}
    output['new_definition_declaration'] = {
        'semantic_code': 'r07.synthetic.daily', 'measurement_nature': 'stock',
        'unit_code': 'per_field', 'definition_authority': 'p4a1.test', 'time_role': 'observation',
        'field_definitions': [field('close_price', 'decimal', 'share', 'stock')]}
    output['payload'] = {'kind': 'tabular_rows', 'rows': [{
        'business_key': 'day-' + str(index), 'subject': output['subject'],
        'observation_time': known_day(2025, 12, 29 + index),
        'values': {'close_price': {'data_type': 'decimal', 'value': value, 'value_state': state}}}
        for index, (value, state) in enumerate([
            ('11.56', 'valid_value'), ('0', 'reported_zero'), (None, 'unknown')])]}
    path = legacy_config(tmp_path, service)
    submitted = published(path, doc)
    snapshot = submitted['snapshot_id']
    product = submitted['output_results'][0]['product_id']
    subject = output['subject']
    dataset = doc['request_identity']['dataset_id']
    points = []
    for index, (value, state) in enumerate([('11.56', 'valid_value'), ('0', 'reported_zero'), (None, 'unknown')]):
        date = f'2025-12-{29 + index}'
        business_time = {'role': 'observation', 'start': date, 'end': date, 'timezone': 'Asia/Shanghai'}
        inner = read_request(dataset, snapshot, product, ['close_price'], subject=subject,
                             business_time_range=business_time)
        read = machine_call(path, 'read_product', {'request': inner})
        assert read['ok'] is True and len(read['result']['rows']) == 1, read
        cell = read['result']['rows'][0]['values']['close_price']
        assert (cell['value'], cell['value_state']) == (value, state)
        common = {key: inner[key] for key in ('dataset_id', 'snapshot_id', 'history_mode',
                  'knowledge_cutoff', 'held_scope', 'usable_stage', 'page_size', 'max_scan_bytes',
                  'max_nodes', 'business_time_range')}
        candidate = {**common, 'protocol_version': 'wfd.filter-objects/1.4-candidate',
                     'operation': 'filter_objects', 'product_id': product,
                     'universe': {'kind': 'explicit_subjects', 'subjects': [subject]},
                     'predicate': {'compare': {'field': 'close_price', 'op': '>=',
                         'value': {'data_type': 'decimal', 'value': '0', 'unit_code': 'share'}}}}
        old_filter = machine_call(path, 'filter_objects', candidate)
        current = {**common, 'protocol_version': 'wfd.filter-objects/1.4-product1',
                   'operation': 'filter_objects',
                   'universe': {'kind': 'explicit_subjects', 'subjects': [subject]},
                   'metrics': [{'metric': 'close', 'field': 'close_price',
                                'bindings': [{'subject': subject, 'product_id': product}]}],
                   'predicate': {'compare': {'metric': 'close', 'op': '>=',
                       'value': {'data_type': 'decimal', 'value': '0', 'unit_code': 'share'}}},
                   'order_by': [{'kind': 'subject', 'direction': 'asc'}]}
        new_filter = machine_call(path, 'filter_objects', current)
        for filtered, name in ((old_filter, 'close_price'), (new_filter, 'close')):
            assert filtered['ok'] is True, filtered
            result = filtered['result']
            if value is None:
                assert result['status'] == 'coverage_insufficient' and result['objects'] == [], result
                assert result['indeterminate'], result
            else:
                assert result['status'] == 'matched' and len(result['objects']) == 1, result
                actual = result['objects'][0]['values'][name]
                assert (actual['value'], actual['value_state']) == (value, state)
        reopened = machine_call(path, 'read_product', {'request': inner})
        assert reopened['result']['rows'] == read['result']['rows']
        points.append({'date': date, 'typed_read': read['result'],
                       'candidate_filter': old_filter['result'], 'current_filter': new_filter['result']})
    fixed = machine_call(path, 'fixed_read', {'snapshot_id': snapshot, 'product_id': product})
    assert len(fixed['result']['rows']) == 3
    proof(tmp_path, 'multi-date-three-paths', {'snapshot_id': snapshot, 'product_id': product,
          'points': points, 'fixed_read': fixed['result'], 'generated_fixture_not_market_evidence': True})


_OPEN_FAULT_MACHINE = r'''
import json, os, sys
from pathlib import Path
target = Path(sys.argv[2]).resolve()
parked = target.with_name(target.name + '.during-open')
tripped = []
def audit(event, args):
    if event == 'open' and not tripped and isinstance(args[0], (str, bytes, os.PathLike)):
        frame = sys._getframe(1)
        fixed_verification = False
        while frame is not None:
            fixed_verification |= frame.f_code.co_name == '_verify_fixed_definition_version'
            frame = frame.f_back
        if fixed_verification and Path(os.fsdecode(args[0])).resolve() == target:
            tripped.append(str(target))
            target.rename(parked)
sys.addaudithook(audit)
from wfd_sdk.product_machine import main
try:
    code = main(['--config', sys.argv[1]])
finally:
    if parked.exists():
        parked.rename(target)
print(json.dumps({'physical_open_fault': tripped, 'original_restored': target.is_file()}), file=sys.stderr)
raise SystemExit(code)
'''


def test_definition_reuse_missing_business_guard_and_unexpected_open_fault_recover(tmp_path):
    service, path, original, seed = data_seed(tmp_path)
    a = seed['output_results'][0]
    target = service.root / 'catalog/product_service/products' / a['product_id'] / 'definition_1.json'
    original_sha = hashlib.sha256(target.read_bytes()).hexdigest()
    candidate = reuse(original['outputs'][0], a, mode='partial_observation')
    candidate['payload']['rows'][0]['business_key'] = 'next-row'
    missing = request([candidate], 'r07-m02-missing', parent=seed['snapshot_id'])
    parked = target.with_name(target.name + '.missing')
    target.rename(parked)
    try:
        result = rejected(path, missing, 'DATA_ONLY_REGISTRATION_VERSION_MISSING')
        assert result['error'] is None
    finally:
        parked.rename(target)
    restored_missing = machine_call(path, 'recovery', {'document': missing})
    assert restored_missing['result']['state'] == 'rejected'
    assert restored_missing['result']['idempotent_replay'] is True
    # This original missing-file probe reaches a business guard, not the
    # unexpected FileNotFoundError mapper. Separately trip a real open after
    # the exists/is_file checks, without replacing any service/mapping method.
    unexpected = request([candidate], 'r07-m02-unexpected-open', parent=seed['snapshot_id'])
    packet = {'protocol_version': 'wfd.product-machine/0.1', 'request_id': 'r07-open-fault',
              'operation': 'submit', 'arguments': {'document': unexpected}}
    completed = subprocess.run([sys.executable, '-c', _OPEN_FAULT_MACHINE, str(path), str(target)],
                               cwd=HERE,
                               input=json.dumps(packet), capture_output=True, text=True, timeout=30)
    # Use the same import path as the ordinary executable machine entry.
    assert completed.stdout, completed.stderr
    response = json.loads(completed.stdout)
    diagnostic = json.loads(completed.stderr)
    assert diagnostic['physical_open_fault'] == [str(target)] and diagnostic['original_restored'] is True
    assert response['ok'] is False and response['error']['code'] == 'WFD_STORE_UNAVAILABLE', response
    assert hashlib.sha256(target.read_bytes()).hexdigest() == original_sha
    assert service.engine.head()['snapshot_id'] == seed['snapshot_id']
    status = machine_call(path, 'request_status', {'request_identity': unexpected['request_identity']})
    recovered = machine_call(path, 'recovery', {'document': unexpected})
    assert recovered['ok'] is True and recovered['result']['state'] == 'published_formal', recovered
    recovered_snapshot = recovered['result']['snapshot_id']
    read = machine_call(path, 'fixed_read', {'snapshot_id': recovered_snapshot, 'product_id': a['product_id']})
    assert {row['row']['business_key'] for row in read['result']['rows']} == {'row-a', 'next-row'}
    assert machine_call(path, 'recovery', {'document': unexpected})['result']['snapshot_id'] == recovered_snapshot
    proof(tmp_path, 'definition-open-fault', {'missing_guard': result, 'unexpected_open': response,
          'physical_fault': diagnostic, 'status_after_fault': status, 'recovered': recovered,
          'fixed': read, 'original_definition_sha256': original_sha, 'same_identity': True})
