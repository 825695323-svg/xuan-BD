"""Real service batches reduced in generic query order, not record order."""
from test_fixed_read_pages import seed
from test_product_query import request
from wfd_sdk.product_query import ProductQuery


def test_real_batch_reducer_matches_full_projection_and_cursor(tmp_path):
    service, sid, pid, refs = seed(tmp_path)
    query = ProductQuery(service)
    req = request('wfd_r1_local', sid, pid, ['value_decimal'], page_size=2)
    full = service.read(pid, snapshot_id=sid)
    rows, notes, products, units = query._project(
        req, full, {}, subject=None, fields=['value_decimal'], business_range=None)
    sources = sorted({source for row in rows
                      for source in (row.get('source_binding') or {}).get('source_ids', [])})
    for last in [None, query._sort_key(rows[1]), query._sort_key(rows[-1])]:
        expected = rows if last is None else [row for row in rows if query._sort_key(row) > last]
        actual = query._project_batch_window(
            req, service._iter_query_batches(pid, snapshot_id=sid, batch_size=2), {},
            subject=None, fields=['value_decimal'], business_range=None, last=last)
        assert actual['rows'] == expected[:2]
        assert actual['total_rows'] == len(rows)
        assert actual['remaining_rows'] == len(expected)
        assert actual['has_more'] == (len(expected) > 2)
        assert actual['units'] == units
        assert actual['diagnostics'] == notes
        assert actual['source_ids'] == sources
        assert query._product_envelope(pid, actual['products'], ['value_decimal']) == \
            query._product_envelope(pid, products, ['value_decimal'])
    # Reverse actual public batches/rows to oppose storage iteration order.
    batches = list(service._iter_query_batches(pid, snapshot_id=sid, batch_size=2))
    for batch in batches:
        batch['rows'].reverse()
    batches.reverse()
    reversed_result = query._project_batch_window(
        req, iter(batches), {}, subject=None, fields=['value_decimal'], business_range=None)
    assert reversed_result['rows'] == rows[:2]
    assert reversed_result['total_rows'] == 5
    # Raw product content_digest differs, but generic _product_envelope does
    # not expose it; the explicit comparison above checks the actual contract.
    absent = {'kind': 'physical_object', 'namespace': 'fixture', 'id': 'absent'}
    empty = query._project_batch_window(
        req, service._iter_query_batches(pid, snapshot_id=sid, batch_size=2), {},
        subject=absent, fields=['value_decimal'], business_range=None)
    expected_empty, expected_notes, _, expected_units = query._project(
        req, full, {}, subject=absent, fields=['value_decimal'], business_range=None)
    assert empty['rows'] == expected_empty == []
    assert empty['total_rows'] == empty['remaining_rows'] == 0
    assert not empty['has_more']
    assert empty['diagnostics'] == expected_notes
    assert empty['units'] == expected_units
    assert empty['source_ids'] == []


def test_real_batches_keep_filtered_total_and_outside_page_diagnostic(tmp_path):
    import copy
    service, sid, pid, refs = seed(tmp_path)
    query = ProductQuery(service)
    req = request('wfd_r1_local', sid, pid, ['value_decimal'], page_size=1)
    full = service.read(pid, snapshot_id=sid)
    # Controlled projection faults on actual public rows, not new published data.
    full = copy.deepcopy(full)
    full['rows'][0]['row'].pop('value_decimal')
    batches = [{**full, 'rows': full['rows'][index:index+1], 'diagnostics': []}
               for index in range(len(full['rows']))]
    expected_rows, expected_notes, _, expected_units = query._project(
        req, full, {}, subject=None, fields=['value_decimal'], business_range=None)
    actual = query._project_batch_window(
        req, iter(batches), {}, subject=None, fields=['value_decimal'], business_range=None)
    assert actual['rows'] == expected_rows[:1]
    assert actual['total_rows'] == len(expected_rows)
    assert actual['remaining_rows'] == len(expected_rows)
    assert actual['diagnostics'] == expected_notes and expected_notes
    assert actual['units'] == expected_units


def test_batches_reject_same_contract_changed_declaration(tmp_path):
    import copy
    import pytest
    from wfd_sdk.product_query import ProductQueryError
    service, sid, pid, refs = seed(tmp_path)
    query = ProductQuery(service)
    req = request('wfd_r1_local', sid, pid, ['value_decimal'], page_size=2)
    batches = list(service._iter_query_batches(pid, snapshot_id=sid, batch_size=2))
    batches = copy.deepcopy(batches)
    batches[1]['products'][0]['declaration']['time_role'] = 'event'
    with pytest.raises(ProductQueryError, match='declaration') as error:
        query._project_batch_window(
            req, iter(batches), {}, subject=None, fields=['value_decimal'], business_range=None)
    assert error.value.code == 'PRODUCT_METADATA_MISMATCH'
