"""Actual SQL batch boundary, not a memory/capacity benchmark."""
import copy
from test_r1_data_only import make_data_service, scalar_output, request as submit_request
from test_product_query import request
from wfd_sdk.product_query import ProductQuery
import wfd_sdk.product_data_service as data_module


def test_300_row_generic_query_uses_bounded_actual_sql_batches(tmp_path, monkeypatch):
    service = make_data_service(tmp_path)
    output = scalar_output('metric', 'f09.query-batch-volume', '1')
    template = output['payload']['rows'][0]
    output['payload']['rows'] = [{**copy.deepcopy(template), 'business_key': f'row-{i:04d}',
                                  'value_decimal': str(i)} for i in range(300)]
    receipt = service.submit(submit_request([output], 'query-batch-volume'))
    assert receipt['state'] == 'published_formal', receipt
    sid = receipt['snapshot_id']
    pid = receipt['output_results'][0]['product_id']
    req = request('wfd_r1_local', sid, pid, ['value_decimal'], page_size=7)
    query = ProductQuery(service)
    with monkeypatch.context() as context:
        context.setattr(service, '_query_batches_supported', lambda **kwargs: False)
        expected = query.execute(req)
        walk_req = {**req, 'page_size': 113}
        old_pages = []
        current = walk_req
        while True:
            page = query.execute(current)
            old_pages.append(page)
            cursor = page['page']['next_cursor']
            if not cursor:
                break
            current = {**walk_req, 'cursor': cursor}
        empty_req = {**req, 'subject': {'kind': 'physical_object',
                     'namespace': 'fixture', 'id': 'absent'}}
        old_empty = query.execute(empty_req)
    observations = []
    original = data_module.selected_rows_page
    def observed(*args, **kwargs):
        rows = original(*args, **kwargs)
        observations.append({'limit': kwargs['row_limit'], 'decoded': len(rows),
                             'after': kwargs['after_position']})
        return rows
    def forbidden(*args, **kwargs):
        raise AssertionError('Eligible 300-row query called full reader')
    monkeypatch.setattr(data_module, 'selected_rows_page', observed)
    monkeypatch.setattr(service, 'read', forbidden)
    monkeypatch.setattr(service, '_read', forbidden)
    verification_calls = []
    original_verify = service._page_verify_files
    def observed_verify(parts):
        result = original_verify(parts)
        verification_calls.append(sum(part['path'].stat().st_size for part in parts))
        return result
    monkeypatch.setattr(service, '_page_verify_files', observed_verify)
    def equal_business_result(actual, old):
        assert {k: v for k, v in actual.items() if k != 'budget'} == \
            {k: v for k, v in old.items() if k != 'budget'}
        assert actual['budget']['conservative'] is True
        assert actual['budget']['batch_count'] == 2
        assert actual['budget']['required_scan_bytes'] == 2 * old['budget']['required_scan_bytes']
    equal_business_result(query.execute(req), expected)
    assert len(verification_calls) == 2
    assert verification_calls[0] == verification_calls[1] > 0
    print({'first_query_full_part_hash_passes': len(verification_calls),
           'first_query_hash_bytes': sum(verification_calls),
           'legacy_budget_note_not_actual_batch_io_bound': True})
    # Fixed public pages fetch one lookahead row to establish has_more.
    # That probe is fetched again as the first row of the next page.
    assert [item['decoded'] for item in observations] == [257, 44]
    assert all(item['limit'] == 257 for item in observations)
    assert expected['page']['total_rows'] == 300 and len(expected['rows']) == 7
    current = walk_req
    collected = []
    for expected_page in old_pages:
        actual = query.execute(current)
        equal_business_result(actual, expected_page)
        collected.extend(actual['rows'])
        current = {**walk_req, 'cursor': actual['page']['next_cursor']}
    assert [len(page['rows']) for page in old_pages] == [113, 113, 74]
    assert len(collected) == 300
    assert len({row['record_ref']['logical_key'] for row in collected}) == 300
    equal_business_result(query.execute(empty_req), old_empty)
    import pytest
    from wfd_sdk.product_query import ProductQueryError
    before_budget_sql = len(observations)
    with pytest.raises(ProductQueryError) as budget_error:
        query.execute({**req, 'max_scan_bytes': expected['budget']['required_scan_bytes']})
    assert budget_error.value.code == 'SCAN_BUDGET_EXCEEDED'
    assert budget_error.value.details['completed_batches'] == 1
    assert len(observations) == before_budget_sql + 1
    assert old_empty['rows'] == [] and old_empty['page']['total_rows'] == 0
    exact_allowance = 2 * expected['budget']['required_scan_bytes']
    before_exact = len(observations)
    exact = query.execute({**req, 'max_scan_bytes': exact_allowance})
    assert exact['budget']['required_scan_bytes'] == exact_allowance
    assert exact['budget']['payload_bytes'] + exact['budget']['metadata_bytes'] == exact_allowance
    assert exact['rows'] == expected['rows']
    assert len(observations) == before_exact + 2
    before_short = len(observations)
    with pytest.raises(ProductQueryError) as short:
        query.execute({**req, 'max_scan_bytes': exact_allowance - 1})
    assert short.value.code == 'SCAN_BUDGET_EXCEEDED'
    assert short.value.details['required_scan_bytes'] == exact_allowance
    assert short.value.details['completed_batches'] == 1
    assert len(observations) == before_short + 1
    # Revoke only this synthetic service's in-memory role after one actual page.
    import pytest
    sql_before_revocation = len(observations)
    original_page = service.read_product_page
    page_calls = []
    def revoke_after_first(*args, **kwargs):
        result = original_page(*args, **kwargs)
        page_calls.append(len(result['rows']))
        if len(page_calls) == 1:
            service.caller_roles = frozenset()
        return result
    monkeypatch.setattr(service, 'read_product_page', revoke_after_first)
    with pytest.raises(PermissionError):
        query.execute(req)
    assert page_calls == [256]
    assert len(observations) == sql_before_revocation + 1
    print({'actual_sql_batches': observations, 'whole_result_equal': True,
           'total_rows': 300, 'returned_rows': 7, 'memory_benchmark': False})


def test_three_batch_scan_allowance_is_reserved_before_third_sql(tmp_path, monkeypatch):
    import pytest
    from wfd_sdk.product_query import ProductQueryError
    service = make_data_service(tmp_path)
    output = scalar_output('metric', 'f09.three-batch-budget', '1')
    template = output['payload']['rows'][0]
    output['payload']['rows'] = [
        {**copy.deepcopy(template), 'business_key': f'row-{i:04d}', 'value_decimal': str(i)}
        for i in range(513)]
    receipt = service.submit(submit_request([output], 'query-three-batches'))
    assert receipt['state'] == 'published_formal', receipt
    req = request('wfd_r1_local', receipt['snapshot_id'],
                  receipt['output_results'][0]['product_id'], ['value_decimal'], page_size=7)
    query = ProductQuery(service)
    with monkeypatch.context() as context:
        context.setattr(service, '_query_batches_supported', lambda **kwargs: False)
        old = query.execute(req)
    base = old['budget']['required_scan_bytes']
    calls = []
    original = data_module.selected_rows_page
    def observed(*args, **kwargs):
        result = original(*args, **kwargs)
        calls.append(len(result))
        return result
    monkeypatch.setattr(data_module, 'selected_rows_page', observed)
    monkeypatch.setattr(service, 'read', lambda *args, **kwargs: pytest.fail('Full reader called'))
    with pytest.raises(ProductQueryError) as short:
        query.execute({**req, 'max_scan_bytes': 3 * base - 1})
    assert short.value.details['completed_batches'] == 2
    assert short.value.details['required_scan_bytes'] == 3 * base
    assert calls == [257, 257]
    calls.clear()
    actual = query.execute({**req, 'max_scan_bytes': 3 * base})
    assert calls == [257, 257, 1]
    assert actual['rows'] == old['rows'] and actual['page'] == old['page']
    assert actual['budget']['batch_count'] == 3
    assert actual['budget']['required_scan_bytes'] == 3 * base
    assert actual['budget']['payload_bytes'] + actual['budget']['metadata_bytes'] == 3 * base
