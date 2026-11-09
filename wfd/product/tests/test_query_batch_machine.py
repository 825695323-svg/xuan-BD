"""Actual isolated Python machine protocol over the eligible batch query path."""
from test_fixed_read_pages import seed, machine_call, inventory
from test_product_query import request


def test_real_machine_generic_batch_cursor_across_processes(tmp_path):
    service, sid, pid, refs = seed(tmp_path)
    before = inventory(service.root)
    req = request('wfd_r1_local', sid, pid, ['value_decimal'], page_size=2)
    first = machine_call(tmp_path, service, 'read_product', {'request': req})
    assert first['ok'] is True, first
    result = first['result']
    assert result['snapshot_id'] == sid
    assert result['page']['returned_rows'] == 2
    assert result['page']['total_rows'] == 5
    cursor = result['page']['next_cursor']
    assert cursor
    second = machine_call(tmp_path, service, 'read_product', {'request': {**req, 'cursor': cursor}})
    assert second['ok'] is True, second
    assert second['result']['snapshot_id'] == sid
    assert second['result']['page']['remaining_rows'] == 3
    assert second['result']['page']['returned_rows'] == 2
    assert second['result']['query_hash'] == result['query_hash']
    keys = lambda value: {row['record_ref']['logical_key'] for row in value['rows']}
    assert keys(result).isdisjoint(keys(second['result']))
    replay = machine_call(tmp_path, service, 'read_product', {'request': {**req, 'cursor': cursor}})
    assert replay['ok'] is True and replay['result'] == second['result']
    assert inventory(service.root) == before
