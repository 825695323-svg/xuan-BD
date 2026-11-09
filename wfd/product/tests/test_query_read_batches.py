"""Internal batching reuses fixed public pages, never the complete reader."""
import pytest
from test_fixed_read_pages import seed, inventory


def test_query_batches_are_lazy_bounded_and_public(tmp_path, monkeypatch):
    service, sid, pid, refs = seed(tmp_path)
    expected = {row['record_id']: row for row in service.read(pid, snapshot_id=sid)['rows']}
    before = inventory(service.root)
    calls = []
    original = service.read_product_page
    def page(*args, **kwargs):
        calls.append(kwargs.get('cursor'))
        return original(*args, **kwargs)
    monkeypatch.setattr(service, 'read_product_page', page)
    def forbidden(*args, **kwargs):
        raise AssertionError('Internal batch reader used a full reader')
    monkeypatch.setattr(service, 'read', forbidden)
    monkeypatch.setattr(service, '_read', forbidden)
    iterator = service._iter_query_batches(pid, snapshot_id=sid, batch_size=2)
    assert calls == []
    first = next(iterator)
    assert len(calls) == 1 and len(first['rows']) == 2
    batches = [first, *iterator]
    assert [len(batch['rows']) for batch in batches] == [2, 2, 1]
    assert len(calls) == 3
    rows = [row for batch in batches for row in batch['rows']]
    assert {row['record_id']: row for row in rows} == expected
    assert inventory(service.root) == before


def test_query_batches_fail_on_manifest_change(tmp_path, monkeypatch):
    service, sid, pid, refs = seed(tmp_path)
    original = service.read_product_page
    calls = []
    def page(*args, **kwargs):
        result = original(*args, **kwargs)
        calls.append(1)
        if len(calls) == 2:
            result['integrity']['manifest_digest'] = 'sha256:' + '0' * 64
        return result
    monkeypatch.setattr(service, 'read_product_page', page)
    iterator = service._iter_query_batches(pid, snapshot_id=sid, batch_size=2)
    next(iterator)
    with pytest.raises(ValueError, match='QUERY_BATCH_BINDING_CHANGED'):
        next(iterator)


def test_query_batch_applicability_is_narrow_and_metadata_only(tmp_path, monkeypatch):
    import copy
    service, sid, pid, refs = seed(tmp_path)
    snapshot = service.engine._valid_snapshot_exact(sid, verify_payloads=False)
    entries = [entry for entry in snapshot['files'] if entry['product_id'] == pid]
    products = {(str(index),): entry['source_bundle']['_wfd_product_bindings'][entry['output_key']]['product']
                for index, entry in enumerate(entries)}
    def forbidden(*args, **kwargs):
        raise AssertionError('Applicability must not read payloads')
    monkeypatch.setattr(service, 'read', forbidden)
    monkeypatch.setattr(service, 'read_product_page', forbidden)
    def supported(perspective='snapshot_contents', chosen=entries, fixed=products):
        return service._query_batches_supported(perspective=perspective, entries=chosen, products=fixed)
    assert supported()
    assert not supported('system_held_at')
    assert not supported('public_at')
    assert not supported(chosen=[])
    changed = copy.deepcopy(entries)
    changed[0]['source_bundle']['_wfd_data_only'] = False
    assert not supported(chosen=changed)
    changed_products = copy.deepcopy(products)
    first = next(iter(changed_products.values()))
    first.setdefault('contracts', {}).setdefault('read', {})['dependencies'] = [{'role': 'other'}]
    assert not supported(fixed=changed_products)
    changed_products = copy.deepcopy(products)
    next(iter(changed_products.values()))['declaration'].setdefault('semantic_context', {})['time'] = {'period_type': 'trading'}
    assert not supported(fixed=changed_products)
