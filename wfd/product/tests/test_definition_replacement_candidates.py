"""Isolated synthetic contracts; never claims persisted replacement authority."""
import copy

from wfd_sdk.duckdb_sdk import canonical, sha
from wfd_sdk.definition_replacement_candidates import evaluate_replacement_candidates
from test_product_query import known_second


def fixture():
    req = dict(instance_id='isolated-instance', snapshot_id='fixed', product_id='product',
               business_scope='explicit-synthetic-scope', business_at='2025-02-01T00:00:00Z',
               public_cutoff='2025-01-02T00:00:00Z', old_definition_ref={'digest': 'old'})
    def endpoint(label):
        return dict(record_ref=dict(snapshot_id='fixed', product_id='product', logical_key=label,
                                    revision_id='version-' + label), definition_ref={'digest': label},
                    binding_digest='sha256:' + label)
    old, new = endpoint('old'), endpoint('new')
    statement = {k: req[k] for k in ('instance_id', 'snapshot_id', 'product_id', 'business_scope')}
    statement.update(old=old, new=new, valid_from='2025-02-01T00:00:00Z',
                     valid_until='2025-03-01T00:00:00Z', public_time=known_second(2025, 1, 1))
    bindings = [{**copy.deepcopy(e), 'status': 'bound', 'public_time': known_second(2024, 1, 1)} for e in (old, new)]
    return req, statement, bindings


def evaluate(req, statements, bindings):
    return evaluate_replacement_candidates(req, [{'statement': s, 'digest': 'sha256:' + sha(canonical(s))} for s in statements], bindings)


def test_synthetic_contract_roundtrip_and_half_open_interval():
    import json
    req, edge, bindings = json.loads(json.dumps(fixture()))
    before = copy.deepcopy((req, edge, bindings))
    result = evaluate(req, [edge], bindings)
    assert result['status'] == 'unique_candidate'
    assert result['qualification'] == 'not_asserted'
    assert result['candidate'] == edge['new']
    result['candidate']['definition_ref']['digest'] = 'mutated'
    assert (req, edge, bindings) == before
    for at in ('2025-01-31T23:59:59Z', '2025-03-01T00:00:00Z'):
        assert evaluate({**req, 'business_at': at}, [edge], bindings)['reason'] == 'NO_ELIGIBLE_CANDIDATE'


def test_conflicts_missing_evidence_and_binding_tamper_never_select():
    req, edge, bindings = fixture()
    conflict = copy.deepcopy(edge)
    conflict['valid_until'] = '2025-04-01T00:00:00Z'
    assert evaluate(req, [edge, conflict], bindings)['reason'] == 'AMBIGUOUS_CANDIDATES'
    assert evaluate(req, [edge, edge], bindings)['reason'] == 'EDGE_DIGEST_OR_DUPLICATE'
    for field in ('instance_id', 'snapshot_id', 'product_id', 'business_scope'):
        changed = {**edge, field: 'wrong'}
        assert evaluate(req, [changed], bindings)['reason'] == 'SCOPE_MISMATCH'
    for field in ('record_ref', 'definition_ref', 'binding_digest'):
        changed = copy.deepcopy(bindings)
        changed[1][field] = {'digest': 'wrong'} if field != 'binding_digest' else 'sha256:wrong'
        assert evaluate(req, [edge], changed)['status'] == 'unknown'
    for subset in ([], bindings[:1], bindings + [bindings[0]]):
        assert evaluate(req, [edge], subset)['status'] == 'unknown'
    assert evaluate_replacement_candidates(req, [{'statement': edge, 'digest': 'wrong'}], bindings)['reason'] == 'EDGE_DIGEST_OR_DUPLICATE'


def test_future_unknown_coarse_and_invalid_times_are_not_returned():
    req, edge, bindings = fixture()
    for time in (None, {'status': 'unknown'}, known_second(2026, 1, 1),
                 {**known_second(2025, 1, 1), 'precision': 'unknown'},
                 {**known_second(2025, 1, 1), 'latest_exclusive_utc': '2025-01-03T00:00:00Z'},
                 {**known_second(2025, 1, 1), 'earliest_utc': '2025-02-30T00:00:00Z'}):
        for target in ('edge', 'binding'):
            e, b = copy.deepcopy(edge), copy.deepcopy(bindings)
            if target == 'edge': e['public_time'] = time
            else: b[1]['public_time'] = time
            result = evaluate(req, [e], b)
            assert result['status'] == 'unknown'
            assert 'candidate' not in result and 'edge_digest' not in result
    assert evaluate({**req, 'public_cutoff': '2025-02-30T00:00:00Z'}, [edge], bindings)['status'] == 'unknown'


def test_actual_fixed_binding_does_not_invent_a_replacement(tmp_path):
    from test_r1_data_only import make_data_service, request, scalar_output
    from test_product_query import request as query_request
    from wfd_sdk.product_query import ProductQuery
    service = make_data_service(tmp_path)
    output = scalar_output('one', 'test.replacement.boundary', '10')
    output['definition_public_time'] = known_second(2024, 1, 1)
    published = service.submit(request([output], 'replacement-boundary'))
    assert published['state'] == 'published_formal'
    sid, pid = published['snapshot_id'], published['output_results'][0]['product_id']
    query = ProductQuery(service)
    base = query_request('wfd_r1_local', sid, pid, ['value_decimal'])
    before = query.execute(base)
    evidence = query.execute({**base, 'include_definition_publication': True})['rows'][0]['source_binding']['definition_publication']
    req, edge, _ = fixture()
    req.update(snapshot_id=sid, product_id=pid, old_definition_ref=evidence['definition_ref'])
    edge.update(snapshot_id=sid, product_id=pid)
    edge['old'] = {k: evidence[k] for k in ('record_ref', 'definition_ref', 'binding_digest')}
    # A real old binding plus an invented new endpoint is insufficient.
    edge['new']['record_ref'].update(snapshot_id=sid, product_id=pid)
    assert evaluate(req, [edge], [evidence])['reason'] == 'BINDING_MISSING_OR_AMBIGUOUS'
    assert evaluate(req, [], [evidence])['status'] == 'unknown'
    assert query.execute(base) == before
    assert ProductQuery(make_data_service(tmp_path)).execute(base) == before
