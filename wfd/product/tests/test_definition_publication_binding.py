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
