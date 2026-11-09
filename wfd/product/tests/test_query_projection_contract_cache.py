"""Per-projection contract reuse, using the existing actual-storage fixture."""
import wfd_sdk.product_query as module
from test_product_query import test_cursor_pagination_is_stable_across_instances_and_head_change as run_existing


def test_projection_reuses_fixed_contract_mapping(tmp_path, monkeypatch):
    original = module.ProductQuery._project
    declaration_fields = module._declaration_fields
    counts = []

    def project(self, *args, **kwargs):
        calls = []
        def counted(product):
            calls.append(id(product))
            return declaration_fields(product)
        with monkeypatch.context() as context:
            context.setattr(module, '_declaration_fields', counted)
            result = original(self, *args, **kwargs)
        if len(result[0]) == 5:
            counts.append(len(calls))
            assert len(calls) == 1, 'Fixed single-product field mapping rebuilt per row'
        return result

    monkeypatch.setattr(module.ProductQuery, '_project', project)
    run_existing(tmp_path, monkeypatch)
    assert counts == [1, 1, 1]


def test_projection_contract_versions_and_calls_are_isolated(monkeypatch):
    query = object.__new__(module.ProductQuery)
    products = [dict(product_id='same-product', dataset_id='fixture',
                     contract_ref={'digest': digest},
                     declaration={'field_definitions': [{'field_code': field}]})
                for digest, field in [('version-a', 'a'), ('version-b', 'b')]]
    rows = [dict(product_id='same-product', contract_ref={'digest': digest},
                 subject=None, row={}, record_ref={'logical_key': str(index)})
            for index, digest in enumerate(['version-a', 'version-b'] * 2)]
    result = {'products': products, 'rows': rows}
    calls = []
    original = module._declaration_fields
    def counted(product):
        calls.append(product['contract_ref']['digest'])
        return original(product)
    monkeypatch.setattr(module, '_declaration_fields', counted)
    monkeypatch.setattr(query, '_row_business_time', lambda *args: (None, None, None))
    projected, diagnostics, _, _ = query._project(
        {}, result, {}, subject=None, fields=['a', 'b'], business_range=None)
    assert projected == []
    assert [item['missing_fields'] for item in diagnostics] == [['b'], ['a'], ['b'], ['a']]
    assert calls == ['version-a', 'version-b']
    # A subsequent call sees changed declarations, not the previous call cache.
    products[0]['declaration']['field_definitions'] = [{'field_code': 'changed'}]
    _, diagnostics, _, _ = query._project(
        {}, result, {}, subject=None, fields=['a', 'b'], business_range=None)
    assert diagnostics[0]['missing_fields'] == ['a', 'b']
    assert calls == ['version-a', 'version-b'] * 2
