"""R07/R08 foundations: real disposable stores, never a selected business store."""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from synthetic_daily import ACTOR, SUBJECT, _document, _output, known_day, source_policy
from test_product_service import make_service
from test_r1_data_only import UNITS, request, scalar_output
from test_market_current_only import bar_output
from wfd_sdk.product_data_service import WFDDataOnlyService
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_query import ProductQuery
from wfd_sdk.filter_objects import run as filter_candidate
from wfd_sdk.filter_plan import PROTOCOL

ROOT = Path(__file__).resolve().parents[1]


def make_data_service(tmp_path):
    engine = WFDDuckDBPrototype.initialize_new(
        tmp_path / 'store', load_protocol_validator(ROOT / 'protocol', 'wfd-data-only-write.schema.json'),
        runtime_root=tmp_path / 'runtime', sandbox=False, writer_host='r07-test')
    return WFDDataOnlyService(engine, caller_roles={'read', 'submit', 'register', 'publish'},
                              caller_id='r1-test', unit_registry=UNITS,
                              trusted_actor_namespaces={'wfd.local'})


def query_fixture(tmp_path, *, policy=False, dates=1):
    service = make_data_service(tmp_path)
    snapshot, products, subjects = None, [], []
    for index, value in enumerate(['10', '10', None, '0']):
        output = bar_output(policy=policy, subject='query_' + str(index))
        output['definition']['semantic_code'] = 'r07.synthetic_value'
        output['definition']['field_definitions'] = [f for f in output['definition']['field_definitions'] if f['field_code'] in {'close', 'high'}]
        row = output['payload']['rows'][0]
        row['values'] = {f: cell for f, cell in row['values'].items() if f in {'close', 'high'}}
        row['values']['close'].update(value=value, value_state='unknown' if value is None else 'reported_zero' if value == '0' else 'valid_value')
        row['business_key'] = 'query_' + str(index) + '_day0'
        row['observation_time'] = known_day('2026-01-05')
        for day in range(1, dates):
            following = copy.deepcopy(row)
            following['business_key'] = 'query_' + str(index) + '_day' + str(day)
            following['observation_time'] = known_day(f'2026-01-{5 + day:02}')
            output['payload']['rows'].append(following)
        result = service.submit(request([output], 'query-' + str(index), parent=snapshot))
        assert result['state'] == 'published_formal', json.dumps(result)
        snapshot = result['snapshot_id']
        products.append(result['output_results'][0]['product_id'])
        subjects.append(output['subject'])
    config = {'runtime': str(tmp_path / 'runtime'), 'store': str(service.root),
              'connection_id': 'isolated-query', 'caller': {'caller_id': 'r1-test'},
              'units': UNITS, 'sources': {}, 'protocol_root': str(ROOT / 'protocol')}
    args = {'protocol_version': PROTOCOL, 'operation': 'filter_objects', 'dataset_id': 'wfd_r1_local',
            'snapshot_id': snapshot, 'history_mode': 'snapshot_contents', 'knowledge_cutoff': None,
            'held_scope': None, 'usable_stage': None,
            'universe': {'kind': 'explicit_subjects', 'subjects': subjects},
            'metrics': [{'metric': field, 'field': field,
                         'bindings': [{'subject': subject, 'product_id': product} for subject, product in zip(subjects, products)]}
                        for field in ['close', 'high']],
            'predicate': {'compare': {'metric': 'close', 'op': '>=', 'value': constant('0')}},
            'business_time_range': {'role': 'observation', 'start': '2026-01-05', 'end': '2026-01-05', 'timezone': 'Asia/Shanghai'},
            'order_by': [{'kind': 'metric', 'metric': 'close', 'direction': 'desc', 'nulls': 'last'}],
            'page_size': 1, 'max_nodes': 200000, 'max_scan_bytes': 268435456}
    return service, config, args


def constant(value):
    return {'data_type': 'decimal', 'value': value, 'unit_code': 'count'}


def query(service, config, args):
    return filter_candidate(service, config, args, lambda: ProductQuery(service), {})


def machine_config(tmp_path, service, **overrides):
    config = {'protocol_version': 'wfd.product-machine-config/0.1', 'profile': 'data_only',
              'connection_id': 'isolated-r07-process', 'store': str(service.root),
              'runtime': str(tmp_path / 'runtime'), 'project_root': str(ROOT), 'protocol_root': str(ROOT / 'protocol'),
              'caller': {'caller_id': 'r1-test', 'trusted_actor_namespace': 'wfd.local',
                         'roles': ['read', 'submit', 'register', 'publish']}, 'units': UNITS, 'sources': {}, 'limits': {}}
    config.update(overrides)
    path = tmp_path / 'machine.json'
    path.write_text(json.dumps(config))
    path.chmod(0o600)
    return path


def machine_call(config, operation, args):
    packet = {'protocol_version': 'wfd.product-machine/0.1', 'request_id': 'r07-process-' + operation,
              'operation': operation, 'arguments': args}
    process = subprocess.run([sys.executable, '-m', 'wfd_sdk.product_machine', '--config', str(config)],
                             cwd=ROOT, input=json.dumps(packet), capture_output=True, text=True, timeout=30)
    result = json.loads(process.stdout)
    with (config.parent / 'machine-transcript.jsonl').open('a') as stream:
        stream.write(json.dumps({'request': packet, 'response': result, 'exit': process.returncode}, ensure_ascii=False) + '\n')
    return result


def test_l01_legacy_content_axis_reproduction_and_valid_expression(tmp_path):
    service, doc = make_service(tmp_path)
    declaration = doc['outputs'][0]['new_definition_declaration']
    declaration['semantic_context'] = {
        'version': 'wfd.semantic-context/1.0', 'content_nature': 'observed_fact',
        'content': {'content_nature': 'observed_fact'},
    }
    refused = service.submit(doc)
    assert refused['status'] == 'rejected', refused
    assert any(e['code'] == 'SEMANTIC_CONTEXT_FIELD_UNSUPPORTED'
               for out in refused['output_results'] for e in out.get('errors', []))
    assert service.engine.head() is None
    # Correct the legacy expression, not the admission whitelist. A rejected
    # request remains immutable: a corrected document has a distinct identity.
    corrected = copy.deepcopy(doc)
    corrected['request_identity']['request_id'] = 'l01-corrected-expression'
    corrected['outputs'][0]['new_definition_declaration']['semantic_context'].pop('content')
    published = service.submit(corrected)
    assert published['status'] == 'published_formal', published
    assert service.engine.head()['snapshot_id'] == published['snapshot_id']
    out = published['output_results'][0]
    read = service.read(out['product_id'], snapshot_id=published['snapshot_id'])
    assert len(read['rows']) == 1
    assert read['rows'][0]['row']['value_decimal'] == corrected['outputs'][0]['payload']['rows'][0]['value_decimal']


def test_data_only_schema_rejection_survives_service_restart(tmp_path):
    service = make_data_service(tmp_path)
    doc = request([scalar_output('value', 'r07.rejection', '1')], 'schema-reject')
    doc['unexpected'] = True
    result = service.submit(doc)
    assert result['state'] == 'rejected'
    restored = WFDDataOnlyService(service.engine, caller_roles={'read', 'submit'},
                                 caller_id='r1-test', unit_registry=service.unit_registry,
                                 trusted_actor_namespaces={'wfd.local'})
    status = restored.request_status(doc['request_identity'])
    assert status['state'] == 'rejected', status
    assert status['errors'][0]['code'] == 'SCHEMA_INVALID'
    assert service.engine.head() is None
    assert restored.submit(doc)['idempotent_replay'] is True
    changed = copy.deepcopy(doc)
    changed.pop('unexpected')
    conflict = restored.submit(changed)
    assert conflict['errors'][0]['code'] == 'REQUEST_ID_CONFLICT'


def test_data_only_rejection_cannot_overwrite_published_identity(tmp_path):
    service = make_data_service(tmp_path)
    doc = request([bar_output(policy=False)], 'published')
    result = service.submit(doc)
    assert result['state'] == 'published_formal', result
    changed = copy.deepcopy(doc)
    changed['unexpected'] = True
    conflict = service.submit(changed)
    assert conflict['errors'][0]['code'] == 'REQUEST_ID_CONFLICT'
    status = service.request_status(doc['request_identity'])
    assert status['state'] == 'published_formal'
    assert status['snapshot_id'] == result['snapshot_id']


def test_data_only_rejection_untrusted_identity_is_not_persisted(tmp_path):
    service = make_data_service(tmp_path)
    doc = request([scalar_output('value', 'r07.untrusted', '1')], 'untrusted')
    doc['request_identity']['trusted_actor_namespace'] = 'untrusted'
    doc['unexpected'] = True
    service.submit(doc)
    assert not list((service.root / 'catalog/product_service/data_only_status').glob('*.json'))


def test_multi_object_stable_signed_pagination(tmp_path):
    service, config, args = query_fixture(tmp_path)
    first = query(service, config, args)
    assert first['status'] == 'matched', first
    assert first['scan_receipt']['matched_objects'] == 3
    assert first['scan_receipt']['scanned_rows'] == 4
    assert first['page']['has_more'] is True
    pages, cursor = [first], first['page']['next_cursor']
    while cursor:
        page = query(service, config, dict(args, cursor=cursor))
        pages.append(page)
        cursor = page['page']['next_cursor']
    ids = [obj['subject']['id'] for page in pages for obj in page['objects']]
    assert ids == ['query_0', 'query_1', 'query_3']
    assert pages[-1]['objects'][0]['values']['close']['value_state'] == 'reported_zero'
    assert pages[-1]['page']['result_exhausted'] is True
    assert pages[0]['coverage']['data_complete'] is False
    assert len(pages[0]['indeterminate']) == 1


@pytest.mark.parametrize('predicate, expected', [
    ({'not': {'compare': {'metric': 'close', 'op': '>', 'value': constant('5')}}}, ['query_3']),
    ({'between': {'metric': 'close', 'low': constant('0'), 'high': constant('10'), 'include_low': False, 'include_high': True}}, ['query_0', 'query_1']),
    ({'in': {'metric': 'close', 'values': [constant('0')]}}, ['query_3']),
    ({'and': [{'compare': {'metric': 'close', 'op': '>', 'value': constant('5')}}, {'compare_metrics': {'left': 'high', 'op': '>', 'right': 'close'}}]}, ['query_0', 'query_1']),
    ({'or': [{'compare': {'metric': 'close', 'op': '>', 'value': constant('5')}}, {'compare': {'metric': 'high', 'op': '>', 'value': constant('11')}}]}, ['query_0', 'query_1', 'query_3', 'query_2']),
])
def test_compound_exact_decimal_three_valued_predicates(tmp_path, predicate, expected):
    service, config, args = query_fixture(tmp_path)
    args.update(predicate=predicate, page_size=500)
    result = query(service, config, args)
    assert [obj['subject']['id'] for obj in result['objects']] == expected


def test_empty_unknown_ambiguity_and_budget_are_separate(tmp_path):
    service, config, args = query_fixture(tmp_path, dates=2)
    args.update(page_size=500, predicate={'compare': {'metric': 'close', 'op': '>', 'value': constant('100')}})
    insufficient = query(service, config, args)
    assert insufficient['status'] == 'coverage_insufficient', insufficient
    assert insufficient['objects'] == []
    limited = query(service, config, dict(args, max_nodes=1))
    assert limited['status'] == 'budget_exceeded'
    assert limited['objects'] == []
    assert limited['scan_receipt']['scan_complete'] is False
    assert limited['page']['result_exhausted'] is False
    broad = copy.deepcopy(args)
    broad['business_time_range']['end'] = '2026-01-06'
    assert query(service, config, broad)['status'] == 'ambiguous'
    complete = copy.deepcopy(args)
    complete['universe']['subjects'].pop(2)
    for metric in complete['metrics']:
        metric['bindings'].pop(2)
    assert query(service, config, complete)['status'] == 'empty'


def test_cursor_tampering_drift_and_permission_recheck(tmp_path):
    service, config, args = query_fixture(tmp_path)
    first = query(service, config, args)
    token = first['page']['next_cursor']
    assert token
    with pytest.raises(Exception, match='CURSOR_INVALID'):
        query(service, config, dict(args, cursor=token[:-2] + 'aa'))
    with pytest.raises(Exception, match='CURSOR_QUERY_MISMATCH'):
        query(service, config, dict(args, cursor=token, page_size=2))
    with pytest.raises(Exception, match='CURSOR_QUERY_MISMATCH'):
        query(service, dict(config, connection_id='another-connection'), dict(args, cursor=token))
    service.caller_roles = service.caller_roles - {'read'}
    with pytest.raises(PermissionError, match='CALLER_PERMISSION_DENIED'):
        query(service, config, dict(args, cursor=token))


def test_current_only_policy_is_enforced_through_filter(tmp_path):
    service, config, args = query_fixture(tmp_path, policy=True)
    # Final snapshot is current, all products may be read there.
    assert query(service, config, args)['status'] == 'matched'
    from test_product_query import known_second
    for mode in ['market_known_at', 'system_held_at']:
        historical = dict(args, history_mode=mode, knowledge_cutoff=known_second(2026, 1, 10),
                          held_scope='this-instance' if mode == 'system_held_at' else None,
                          usable_stage='published_readable' if mode == 'system_held_at' else None)
        with pytest.raises(Exception, match='CURRENT_ONLY_BUSINESS_HISTORY_UNSUPPORTED'):
            query(service, config, historical)


def test_machine_process_filter_legacy_reads_recovery_and_storage_fault(tmp_path):
    service, config, args = query_fixture(tmp_path)
    path = machine_config(tmp_path, service)
    caps = machine_call(path, 'capabilities', {})
    assert caps['ok'] is True, caps
    assert caps['result']['operations']['filter_objects']['protocol_version'] == PROTOCOL
    first = machine_call(path, 'filter_objects', args)
    assert first['ok'] is True, first
    assert first['result']['page']['has_more'] is True
    next_page = machine_call(path, 'filter_objects', dict(args, cursor=first['result']['page']['next_cursor']))
    assert next_page['result']['objects'][0]['subject']['id'] == 'query_1'
    # Existing fixed and typed reads retain their old wire contracts.
    product = args['metrics'][0]['bindings'][0]['product_id']
    fixed = machine_call(path, 'fixed_read', {'snapshot_id': args['snapshot_id'], 'product_id': product})
    assert fixed['ok'] is True and fixed['result']['row_count'] == 1, fixed
    legacy_read = {k: args[k] for k in ['dataset_id', 'snapshot_id', 'history_mode', 'knowledge_cutoff', 'held_scope', 'usable_stage', 'business_time_range', 'max_nodes', 'max_scan_bytes', 'page_size']}
    legacy_read.update(protocol_version='wfd.read/1.3-product1', operation='read_product', product_id=product,
                       subject=args['universe']['subjects'][0], fields=['close'])
    read = machine_call(path, 'read_product', {'request': legacy_read})
    assert read['ok'] is True and read['result']['rows'][0]['values']['close']['value'] == '10'
    old = copy.deepcopy(args)
    old['protocol_version'] = 'wfd.filter-objects/1.3'
    assert machine_call(path, 'filter_objects', old)['ok'] is False
    # Prevalidation business refusal is durable and explicitly differs from ok.
    malformed = request([bar_output(policy=False)], 'machine-schema-reject', parent=args['snapshot_id'])
    malformed['unexpected'] = True
    refused = machine_call(path, 'submit', {'document': malformed})
    assert refused['ok'] is True
    assert refused['business_outcome']['state'] == 'rejected'
    assert refused['business_outcome']['published_formal'] is False
    assert machine_call(path, 'request_status', {'request_identity': malformed['request_identity']})['result']['state'] == 'rejected'
    recovered = machine_call(path, 'recovery', {'document': malformed})
    assert recovered['result']['state'] == 'rejected'
    assert recovered['result']['idempotent_replay'] is True
    # Real physical filesystem error, not a patched error mapper. The original
    # product bytes are restored and the same fixed read succeeds afterwards.
    snapshot = service.engine.read_snapshot(args['snapshot_id'])
    selected = next(entry for entry in snapshot['files'] if entry['product_id'] == product)
    payload = service.root / selected['file_relpath']
    parked = payload.with_name(payload.name + '.fault-original')
    payload.rename(parked)
    try:
        broken = machine_call(path, 'filter_objects', args)
        assert broken['ok'] is False, broken
        assert broken['error']['code'] == 'MANIFEST_FILE_UNAVAILABLE', broken
    finally:
        parked.rename(payload)
    assert machine_call(path, 'filter_objects', args)['result']['objects'] == first['result']['objects']


def test_legacy_machine_submit_evidence_schema_and_reopen(tmp_path):
    from test_product_service import SOURCE_POLICY, UNIT_REGISTRY
    service, doc = make_service(tmp_path)
    policy = {key: value for key, value in SOURCE_POLICY.items() if not key.startswith('may_export') and key not in {'may_redistribute', 'export_scope'}}
    path = machine_config(tmp_path, service, profile='legacy',
                          caller={'caller_id': 'test', 'trusted_actor_namespace': 'wfd.test.curated',
                                  'roles': ['read', 'read_evidence', 'evidence_write', 'register', 'submit', 'publish']},
                          sources={'fixture': policy}, units=UNIT_REGISTRY)
    published = machine_call(path, 'submit', {'document': doc})
    assert published['ok'] is True and published['result']['status'] == 'published_formal', published
    assert published['business_outcome']['published_formal'] is True
    assert machine_call(path, 'recovery', {'document': doc})['result']['snapshot_id'] == published['result']['snapshot_id']
    no_evidence = copy.deepcopy(doc)
    no_evidence['request_identity']['request_id'] = 'legacy-no-evidence'
    no_evidence['expected_parent_snapshot_id'] = published['result']['snapshot_id']
    no_evidence['outputs'][0]['evidence_refs'] = []
    refused = machine_call(path, 'submit', {'document': no_evidence})
    assert refused['result']['status'] == 'rejected'
    assert refused['result']['output_results'][0]['errors'][0]['code'] == 'EVIDENCE_REQUIRED'
    forbidden = copy.deepcopy(doc)
    forbidden['request_identity']['request_id'] = 'legacy-schema-reject'
    forbidden['unexpected'] = True
    result = machine_call(path, 'submit', {'document': forbidden})
    assert result['result']['status'] == 'rejected'
    assert machine_call(path, 'request_status', {'request_identity': forbidden['request_identity']})['result']['state'] == 'rejected'
    assert machine_call(path, 'capabilities', {})['result']['profile'] == 'legacy'


def test_historical_qualification_missing_is_specific(tmp_path):
    from test_product_query import known_second
    service, config, args = query_fixture(tmp_path)
    requested = dict(args, history_mode='market_known_at', knowledge_cutoff=known_second(2026, 1, 10))
    historical = query(service, config, requested)
    assert historical['objects'] == [] and historical['status'] == 'coverage_insufficient', historical
    assert any(gap['qualification_diagnostics'] for item in historical['indeterminate'] for gap in item['gaps'] if 'qualification_diagnostics' in gap)
    requested.update(history_mode='system_held_at', held_scope='missing-instance', usable_stage='published_readable')
    with pytest.raises(Exception, match='INSTANCE_HOLDING_UNKNOWN'):
        query(service, config, requested)


def test_schema_type_unit_binding_and_expression_budget_reject_before_execution(tmp_path):
    service, config, args = query_fixture(tmp_path)
    cases = []
    changed = copy.deepcopy(args)
    changed['predicate']['compare']['value']['unit_code'] = 'other-unit'
    cases.append((changed, 'UNIT_INCOMPATIBLE'))
    changed = copy.deepcopy(args)
    changed['metrics'][0]['bindings'][0]['record_version'] = 'forged'
    cases.append((changed, 'FILTER_SCHEMA_INVALID'))
    changed = copy.deepcopy(args)
    changed['metrics'][0]['bindings'][0]['subject']['namespace'] = 'another.namespace'
    cases.append((changed, 'PRODUCT_NOT_IN_SNAPSHOT'))
    changed = copy.deepcopy(args)
    changed['predicate']['compare']['value']['value'] = 'NaN'
    cases.append((changed, 'FILTER_SCHEMA_INVALID'))
    changed = copy.deepcopy(args)
    for _ in range(9):
        changed['predicate'] = {'not': changed['predicate']}
    cases.append((changed, 'PREDICATE_BUDGET_EXCEEDED'))
    changed = copy.deepcopy(args)
    changed['predicate'] = {'and': [copy.deepcopy(args['predicate']) for _ in range(65)]}
    cases.append((changed, 'PREDICATE_BUDGET_EXCEEDED'))
    for changed, code in cases:
        with pytest.raises(Exception, match=code):
            query(service, config, changed)


def test_budget_is_checked_before_any_payload_discovery(tmp_path):
    service, config, args = query_fixture(tmp_path)
    snapshot = service.engine.read_snapshot(args['snapshot_id'])
    payload = service.root / snapshot['files'][0]['file_relpath']
    parked = payload.with_name(payload.name + '.budget-original')
    payload.rename(parked)
    try:
        exhausted = query(service, config, dict(args, max_scan_bytes=1))
        assert exhausted['status'] == 'budget_exceeded'
        assert exhausted['gaps'][0]['code'] == 'SCAN_BUDGET_EXCEEDED'
        assert exhausted['scan_receipt']['scanned_rows'] == 0
    finally:
        parked.rename(payload)


def test_legacy_source_permission_precedes_field_disclosure(tmp_path):
    from synthetic_daily import make_daily_store, SOURCE_IDS
    fixture = make_daily_store(tmp_path / 'legacy-seed')
    args = {'protocol_version': PROTOCOL, 'operation': 'filter_objects', 'dataset_id': 'synthetic_daily',
            'snapshot_id': fixture.snapshot_id, 'history_mode': 'snapshot_contents',
            'knowledge_cutoff': None, 'held_scope': None, 'usable_stage': None,
            'universe': {'kind': 'explicit_subjects', 'subjects': [SUBJECT]},
            'metrics': [{'metric': 'close', 'field': 'secret_field_not_registered', 'bindings': [{'subject': SUBJECT, 'product_id': fixture.product_id}]}],
            'predicate': {'compare': {'metric': 'close', 'op': '>', 'value': {'data_type': 'decimal', 'value': '1', 'unit_code': 'cny_per_share'}}},
            'business_time_range': None, 'order_by': [{'kind': 'subject', 'direction': 'asc'}],
            'page_size': 10, 'max_scan_bytes': 268435456, 'max_nodes': 200000}
    fixture.service.allowed_sources[SOURCE_IDS[0]]['may_read'] = False
    with pytest.raises(PermissionError, match='SOURCE_READ_PERMISSION_MISSING'):
        query(fixture.service, {'store': str(fixture.store), 'runtime': str(tmp_path / 'runtime')}, args)


def test_candidate_wire_stays_compatible_and_unknown_is_not_empty(tmp_path):
    service, config, args = query_fixture(tmp_path)
    def candidate(index):
        return {key: args[key] for key in ('dataset_id', 'snapshot_id', 'history_mode', 'knowledge_cutoff',
                                           'held_scope', 'usable_stage', 'business_time_range', 'page_size', 'max_scan_bytes', 'max_nodes')} | {
            'protocol_version': 'wfd.filter-objects/1.4-candidate', 'operation': 'filter_objects',
            'universe': {'kind': 'explicit_subjects', 'subjects': [args['universe']['subjects'][index]]},
            'product_id': args['metrics'][0]['bindings'][index]['product_id'],
            'predicate': {'compare': {'field': 'close', 'op': '>=', 'value': constant('0')}}}
    first = query(service, config, candidate(0))
    assert first['format_version'] == 'wfd.filter-objects-result/0.1'
    assert first['status'] == 'matched'
    assert first['objects'][0]['values']['close']['value'] == '10'
    missing = query(service, config, candidate(2))
    assert missing['status'] == 'coverage_insufficient'
    assert missing['objects'] == [] and len(missing['indeterminate']) == 1
    zero = query(service, config, candidate(3))
    assert zero['status'] == 'matched'
    assert zero['objects'][0]['values']['close']['value_state'] == 'reported_zero'
