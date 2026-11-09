"""Current snapshot discovery is read-only and never guesses a missing head."""
import json

from test_store_opening import inventory, machine_config, machine_process
from test_product_service import HERE
from test_r1_data_only import NAMESPACE, UNITS, request, scalar_output
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_data_service import WFDDataOnlyService


def seed_store(tmp_path):
    engine = WFDDuckDBPrototype.initialize_new(
        tmp_path / "store", load_protocol_validator(
            HERE / "protocol", entry="wfd-data-only-write.schema.json"),
        runtime_root=tmp_path / "runtime", sandbox=False, writer_host="snapshot-test")
    service = WFDDataOnlyService(
        engine, caller_roles=("read", "register", "submit", "publish"),
        caller_id="snapshot-test", unit_registry=UNITS,
        trusted_actor_namespaces={NAMESPACE})
    result = service.submit(request([scalar_output("m1", "snapshot.test", "10")], "snapshot-test"))
    assert result["state"] == "published_formal", result
    return service.root, result["snapshot_id"]


def test_snapshot_status_reads_verified_active_head_without_writes(tmp_path):
    store, sid = seed_store(tmp_path / "seed")
    config = machine_config(tmp_path, store, "data_only", ("read",))
    before = inventory(store)
    code, response = machine_process(config, store, "snapshot_status")
    assert code == 0 and response["ok"] is True, response
    status = response["result"]
    assert status["snapshot_id"] == sid
    assert status["empty"] is False
    assert status["authority"] == "active_head"
    assert status["caller_roles"] == ["read"]
    assert status["unit_definitions"]
    assert inventory(store) == before


def test_snapshot_status_confirms_initialized_empty_store_only(tmp_path):
    store = tmp_path / "store"
    WFDDuckDBPrototype.initialize_new(
        store, load_protocol_validator(HERE / "protocol"),
        runtime_root=tmp_path / "initial-runtime", sandbox=False)
    config = machine_config(tmp_path, store, "data_only", ("read",))
    before = inventory(store)
    code, response = machine_process(config, store, "snapshot_status")
    assert code == 0 and response["ok"] is True, response
    assert response["result"]["snapshot_id"] is None
    assert response["result"]["empty"] is True
    assert inventory(store) == before
    (store / "catalog/commits/broken.json").write_text("broken", encoding="utf-8")
    code, response = machine_process(config, store, "snapshot_status")
    assert response["ok"] is False, response
    assert response["error"]["code"] == "EMPTY_STORE_UNVERIFIED"


def test_snapshot_status_rejects_permissions_arguments_and_damaged_head(tmp_path):
    store, _ = seed_store(tmp_path / "seed")
    config = machine_config(tmp_path, store, "data_only", ("submit",))
    code, response = machine_process(config, store, "snapshot_status", {"store": "/other"})
    assert response["ok"] is False and response["error"]["code"] == "CALLER_PERMISSION_DENIED", response
    value = json.loads(config.read_text("utf-8"))
    value["caller"]["roles"] = ["read"]
    config.write_text(json.dumps(value), encoding="utf-8")
    code, response = machine_process(config, store, "snapshot_status", {"snapshot_id": "latest"})
    assert response["ok"] is False and response["error"]["code"] == "REQUEST_INVALID", response
    state_path = store / "catalog/state.json"
    state = json.loads(state_path.read_text("utf-8"))
    state["active_head"] = None
    state_path.write_text(json.dumps(state), encoding="utf-8")
    before = inventory(store)
    code, response = machine_process(config, store, "snapshot_status")
    assert response["ok"] is False, response
    assert response["error"]["code"] == "HEAD_INVALID_MISSING"
    assert inventory(store) == before


def test_definition_enquiry_returns_missing_family_without_publishing(tmp_path):
    store, sid = seed_store(tmp_path / "seed")
    config = machine_config(tmp_path, store, "data_only", ("read",))
    intent = {"snapshot_id": sid, "dataset_id": "wfd_r1_local", "semantic_code": "new.sensor.reading",
              "subject": {"kind": "entity", "namespace": NAMESPACE, "id": "example"}, "field_codes": ["reading"]}
    before = inventory(store)
    _, response = machine_process(config, store, "review_definition", intent)
    assert response["ok"] is True, response
    result = response["result"]
    assert (result["protocol"], result["disposition"], result["code"]) == (
        "wfd.definition-review/1", "return_to_bd", "FAMILY_DEFINITION_REQUIRED")
    assert result["missing_fields"] == ["reading"] and result["product_ids"] == []
    assert result["snapshot_id"] == sid
    _, stale = machine_process(config, store, "review_definition", {**intent, "snapshot_id": None})
    assert stale["ok"] is False and stale["error"]["code"] == "PARENT_CHANGED", stale
    _, extra = machine_process(config, store, "review_definition", {**intent, "store": "/unknown"})
    assert extra["ok"] is False and extra["error"]["code"] == "REQUEST_INVALID", extra
    assert before == inventory(store)
