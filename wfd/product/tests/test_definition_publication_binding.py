"""Synthetic exact-binding projection; no new historical eligibility or write route."""
import copy

from test_r1_data_only import make_data_service
from test_product_query import known_second


def evidence():
    ref = {"snapshot_id": "fixed-snapshot", "product_id": "fixed-product",
           "logical_key": "row", "revision_id": "version-1"}
    definition, contract = {"digest": "definition"}, {"digest": "contract"}
    revision = {"logical_key": "row", "revision_id": "version-1"}
    binding = {"product": {"product_id": "fixed-product", "definition_ref": definition,
                           "contract_ref": contract},
               "definition_public_time": known_second(2025, 1, 1)}
    item = {"record_ref": ref, "definition_ref": definition, "contract_ref": contract,
            "revision": revision}
    source = {"_wfd_data_only": True, "_wfd_product_bindings": {"output": binding},
              "_wfd_row_versions": {"output": {"physical": revision}}}
    return item, source


def test_exact_persisted_binding_and_unknown_fail_closed(tmp_path):
    service = make_data_service(tmp_path)
    item, source = evidence()
    project = lambda i, s: service._record_definition_publication(i, s, "output", "physical")
    valid = project(item, source)
    assert valid["status"] == "bound" and valid["qualification"] == "not_asserted"
    assert valid["record_ref"] == item["record_ref"]
    assert valid["public_time"] == source["_wfd_product_bindings"]["output"]["definition_public_time"]
    assert valid == project(copy.deepcopy(item), copy.deepcopy(source))
    for key in ("product_id", "logical_key", "revision_id", "snapshot_id"):
        changed = copy.deepcopy(item)
        changed["record_ref"].pop(key)
        assert project(changed, source) == {"status": "unknown", "qualification": "not_asserted"}
    for key in ("product_id", "logical_key", "revision_id"):
        changed = copy.deepcopy(item)
        changed["record_ref"][key] = "different"
        assert project(changed, source)["status"] == "unknown"
    for key in ("definition_ref", "contract_ref", "revision"):
        changed = copy.deepcopy(item)
        changed[key] = {"digest": "mismatch"}
        assert project(changed, source)["status"] == "unknown"
    for time in (None, {}, {"status": "unknown", "precision": "unknown",
                           "earliest_utc": None, "latest_exclusive_utc": None, "source_timezone": "UTC"},
                 {**known_second(2025, 1, 1), "earliest_utc": "2025-02-30T00:00:00Z"}):
        changed = copy.deepcopy(source)
        changed["_wfd_product_bindings"]["output"]["definition_public_time"] = time
        assert project(item, changed) == {"status": "unknown", "qualification": "not_asserted"}
    for key in ("_wfd_data_only", "_wfd_product_bindings", "_wfd_row_versions"):
        changed = copy.deepcopy(source)
        changed.pop(key)
        assert project(item, changed)["status"] == "unknown"
    other = copy.deepcopy(source)
    other["_wfd_product_bindings"]["unrelated-secret"] = {"secret": "do-not-return"}
    assert project(item, other) == valid
    assert "do-not-return" not in str(project(item, other))


def test_binding_validation_cache_is_request_local(tmp_path):
    service = make_data_service(tmp_path)
    item, source = evidence()
    original = service._time_errors
    calls = []
    def count(value):
        calls.append(value)
        return original(value)
    service._time_errors = count
    cache = {}
    first = service._record_definition_publication(item, source, 'output', 'physical', cache)
    assert first == service._record_definition_publication(item, source, 'output', 'physical', cache)
    assert len(calls) == 1
    assert first == service._record_definition_publication(item, source, 'output', 'physical', {})
    assert len(calls) == 2


def test_opt_in_preserves_default_rows_and_binds_cursors(tmp_path):
    import pytest
    from test_r1_data_only import request, scalar_output
    from test_product_query import request as query_request
    from wfd_sdk.product_query import ProductQuery, ProductQueryError
    from wfd_sdk.duckdb_sdk import canonical, sha
    service = make_data_service(tmp_path)
    output = scalar_output('first', 'test.definition.option', '10')
    output['definition_public_time'] = known_second(2024, 1, 1)
    other = copy.deepcopy(output['payload']['rows'][0])
    other['business_key'] = 'row-second'
    output['payload']['rows'].append(other)
    published = service.submit(request([output], 'definition-option'))
    assert published['state'] == 'published_formal'
    sid, pid = published['snapshot_id'], published['output_results'][0]['product_id']
    query = ProductQuery(service)
    base = query_request('wfd_r1_local', sid, pid, ['value_decimal'], page_size=1)
    original_projection = service._record_definition_publication
    def forbidden(*args, **kwargs):
        raise AssertionError("Default read must not compute opt-in evidence")
    service._record_definition_publication = forbidden
    plain = query.execute(base)
    service.read(pid, snapshot_id=sid)
    service.read_product_page(pid, snapshot_id=sid, page_size=1)
    service._record_definition_publication = original_projection
    explicit = query.execute({**base, 'include_definition_publication': True})
    stripped = copy.deepcopy(explicit['rows'])
    for row in stripped:
        assert row['source_binding'].pop('definition_publication')['status'] == 'bound'
    assert canonical(stripped) == canonical(plain['rows'])
    assert sha(canonical(stripped)) == sha(canonical(plain['rows']))
    assert query.execute(base) == plain
    assert query.execute({**base, 'include_definition_publication': False}) == plain
    for source, target in ((plain, True), (explicit, False)):
        cursor = source['page']['next_cursor']
        assert cursor
        with pytest.raises(ProductQueryError):
            query.execute({**base, 'cursor': cursor, 'include_definition_publication': target})
    for mode in ('market_known_at', 'system_held_at'):
        with pytest.raises(ProductQueryError, match='snapshot-only'):
            query.execute({**base, 'include_definition_publication': True, 'history_mode': mode})
    with pytest.raises(ProductQueryError):
        query.execute({**base, 'include_definition_publication': 'true'})
    # Existing direct fixed and machine-page reads remain opt-out too.
    assert all('definition_publication' not in row['source_binding']
               for row in service.read(pid, snapshot_id=sid)['rows'])
    page = service.read_product_page(pid, snapshot_id=sid, page_size=1)
    opted = service.read_product_page(pid, snapshot_id=sid, page_size=1, include_definition_publication=True)
    assert 'definition_publication' not in page['rows'][0]['source_binding']
    assert opted['rows'][0]['source_binding']['definition_publication']['status'] == 'bound'
    with pytest.raises(ValueError, match='PAGE_CURSOR_INVALID'):
        service.read_product_page(pid, snapshot_id=sid, page_size=1,
                                  cursor=opted['pagination']['next_cursor'])
