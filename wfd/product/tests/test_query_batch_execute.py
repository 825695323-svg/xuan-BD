"""Actual execute response parity and absence of full-reader fallback."""
import pytest
from test_fixed_read_pages import seed
from test_product_query import request
from wfd_sdk.product_query import ProductQuery


def test_execute_batch_matches_complete_response_and_cursor(tmp_path, monkeypatch):
    service, sid, pid, refs = seed(tmp_path)
    query = ProductQuery(service)
    req = request('wfd_r1_local', sid, pid, ['value_decimal'], page_size=2)
    with monkeypatch.context() as context:
        context.setattr(service, '_query_batches_supported', lambda **kwargs: False)
        old_first = query.execute(req)
        old_second = query.execute({**req, 'cursor': old_first['page']['next_cursor']})
    def forbidden(*args, **kwargs):
        raise AssertionError('Eligible execute used full reader')
    monkeypatch.setattr(service, 'read', forbidden)
    monkeypatch.setattr(service, '_read', forbidden)
    assert query.execute(req) == old_first
    assert query.execute({**req, 'cursor': old_first['page']['next_cursor']}) == old_second


def test_execute_batch_failure_does_not_retry_complete_reader(tmp_path, monkeypatch):
    service, sid, pid, refs = seed(tmp_path)
    query = ProductQuery(service)
    req = request('wfd_r1_local', sid, pid, ['value_decimal'], page_size=2)
    def broken(*args, **kwargs):
        raise ValueError('QUERY_BATCH_INJECTED_FAILURE')
    def forbidden(*args, **kwargs):
        raise AssertionError('Batch failure triggered full fallback')
    monkeypatch.setattr(service, '_iter_query_batches', broken)
    monkeypatch.setattr(service, 'read', forbidden)
    from wfd_sdk.product_query import ProductQueryError
    with pytest.raises(ProductQueryError, match='QUERY_BATCH_INJECTED_FAILURE') as error:
        query.execute(req)
    assert error.value.code == 'QUERY_BATCH_INJECTED_FAILURE'
    assert error.value.details == {'snapshot_id': sid, 'product_id': pid}


@pytest.mark.parametrize('role', ['observation', 'declared'])
def test_execute_time_range_full_response_matches_old_path(tmp_path, monkeypatch, role):
    service, sid, pid, refs = seed(tmp_path)
    query = ProductQuery(service)
    req = request('wfd_r1_local', sid, pid, ['value_decimal'], page_size=2,
                  business_time_range={'role': role, 'start': '2025-01-01',
                                       'end': '2025-12-31', 'timezone': 'UTC'})
    with monkeypatch.context() as context:
        context.setattr(service, '_query_batches_supported', lambda **kwargs: False)
        expected = query.execute(req)
    def forbidden(*args, **kwargs):
        raise AssertionError('Time-filtered batch query called full reader')
    monkeypatch.setattr(service, 'read', forbidden)
    assert query.execute(req) == expected


def test_execute_mixed_unknown_time_preserves_eligibility_diagnostics(tmp_path, monkeypatch):
    import copy
    from test_r1_data_only import make_data_service, scalar_output, request as submit_request
    from test_product_query import unknown_time
    service = make_data_service(tmp_path)
    output = scalar_output('metric', 'f09.mixed-time', '1')
    unknown = copy.deepcopy(output['payload']['rows'][0])
    unknown.update(business_key='unknown', observation_time=unknown_time())
    output['payload']['rows'].append(unknown)
    receipt = service.submit(submit_request([output], 'mixed-time'))
    assert receipt['state'] == 'published_formal', receipt
    req = request('wfd_r1_local', receipt['snapshot_id'],
                  receipt['output_results'][0]['product_id'], ['value_decimal'], page_size=2,
                  business_time_range={'role': 'observation', 'start': '2025-01-01',
                                       'end': '2025-12-31', 'timezone': 'UTC'})
    query = ProductQuery(service)
    with monkeypatch.context() as context:
        context.setattr(service, '_query_batches_supported', lambda **kwargs: False)
        expected = query.execute(req)
    monkeypatch.setattr(service, 'read', lambda *args, **kwargs: pytest.fail('Full reader called'))
    actual = query.execute(req)
    assert actual == expected
    assert len(actual['rows']) == 1
    assert actual['diagnostics'] and actual['complete'] is False


def test_execute_rejects_artifact_change_after_actual_sql_read(tmp_path, monkeypatch):
    from pathlib import Path
    import wfd_sdk.product_data_service as data_module
    from wfd_sdk.product_query import ProductQueryError
    service, sid, pid, refs = seed(tmp_path)
    req = request('wfd_r1_local', sid, pid, ['value_decimal'], page_size=2)
    query = ProductQuery(service)
    original_sql = data_module.selected_rows_page
    changed = []
    def change_after_sql(parts, *args, **kwargs):
        result = original_sql(parts, *args, **kwargs)
        path = Path(parts[0]['path'])
        original = path.read_bytes()
        changed.append((path, original))
        path.write_bytes(original + b'fixture-artifact-drift')
        return result
    monkeypatch.setattr(data_module, 'selected_rows_page', change_after_sql)
    monkeypatch.setattr(service, 'read', lambda *args, **kwargs: pytest.fail('Full fallback called'))
    try:
        with pytest.raises(ProductQueryError) as error:
            query.execute(req)
        assert error.value.code == 'PAGE_ARTIFACT_CHANGED'
        assert len(changed) == 1
    finally:
        for path, original in changed:
            path.write_bytes(original)
    monkeypatch.setattr(data_module, 'selected_rows_page', original_sql)
    assert len(query.execute(req)['rows']) == 2


@pytest.mark.parametrize('overrides,code', [
    ({'max_scan_bytes': 1}, 'SCAN_BUDGET_EXCEEDED'),
    ({'max_nodes': 1}, 'ROW_BUDGET_EXCEEDED'),
])
def test_batch_budget_failure_precedes_iterator_and_payload(tmp_path, monkeypatch, overrides, code):
    from wfd_sdk.product_query import ProductQueryError
    service, sid, pid, refs = seed(tmp_path)
    req = request('wfd_r1_local', sid, pid, ['value_decimal'], page_size=2, **overrides)
    def forbidden(*args, **kwargs):
        pytest.fail('Budget failure reached iterator or payload reader')
    monkeypatch.setattr(service, '_iter_query_batches', forbidden)
    monkeypatch.setattr(service, 'read_product_page', forbidden)
    monkeypatch.setattr(service, 'read', forbidden)
    with pytest.raises(ProductQueryError) as error:
        ProductQuery(service).execute(req)
    assert error.value.code == code


def test_execute_revision_and_fully_withdrawn_fixed_snapshots(tmp_path, monkeypatch):
    from test_full_product_pages import revise
    service, sid, pid, refs = seed(tmp_path)
    corrected = revise(service, sid, pid, ['a'], 'source_correction', 'query-correct')
    corrected_sid = corrected['snapshot_id']
    partial = revise(service, corrected_sid, pid, ['a'], 'withdrawal', 'query-withdraw-one')
    partial_sid = partial['snapshot_id']
    withdrawn = revise(service, partial_sid, pid,
                       [ref['record_id'] for ref in refs if ref['record_id'] != 'a'],
                       'withdrawal', 'query-withdraw-all')
    empty_sid = withdrawn['snapshot_id']
    query = ProductQuery(service)
    requests = [request('wfd_r1_local', snapshot, pid, ['value_decimal'], page_size=10)
                for snapshot in [sid, corrected_sid, partial_sid, empty_sid]]
    with monkeypatch.context() as context:
        context.setattr(service, '_query_batches_supported', lambda **kwargs: False)
        expected = [query.execute(req) for req in requests]
    monkeypatch.setattr(service, 'read', lambda *args, **kwargs: pytest.fail('Full reader called'))
    actual = [query.execute(req) for req in requests[:2]]
    # Withdrawals require the original diagnostic-capable reader at admission.
    monkeypatch.undo()
    monkeypatch.setattr(service, '_iter_query_batches',
                        lambda *args, **kwargs: pytest.fail('Withdrawals entered batch path'))
    actual.extend(query.execute(req) for req in requests[2:])
    for got, prior in zip(actual, expected):
        assert got == prior, {key: (got.get(key), prior.get(key))
                              for key in got if got.get(key) != prior.get(key)}
    assert [len(result['rows']) for result in actual] == [5, 5, 4, 0]
    assert actual[2]['diagnostics_total'] == 1
    assert actual[3]['diagnostics_total'] == 5
    assert actual[-1]['product'] == expected[-1]['product']
    assert actual[-1]['product']['contract_versions']
    old = next(row for row in actual[0]['rows'] if row['record_ref']['logical_key'] == 'a')
    new = next(row for row in actual[1]['rows'] if row['record_ref']['logical_key'] == 'a')
    assert old['record_ref']['revision_id'] != new['record_ref']['revision_id']
