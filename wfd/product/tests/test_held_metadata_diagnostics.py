"""Synthetic legal additive publications must not leak unheld contract diagnostics.

Stage times below are observed by ordinary publication, never injected into the
ledger. This tests diagnostic minimization, not temporal metadata projection.
"""
import copy
import json
import time
from datetime import datetime, timedelta, timezone

import pytest

from test_r1_data_only import make_data_service, request as ingest_request, scalar_output, UNITS
from test_product_query import request as query_request
from test_p4a1_data_only_public_read import _machine_config, machine_call
from wfd_sdk.product_query import ProductQuery, ProductQueryError


@pytest.fixture(params=["not_yet_held", "unknown"])
def additive_held_store(tmp_path, request):
    service = make_data_service(tmp_path)
    output = scalar_output("metric", "synthetic.held.diagnostic", "1")
    output["definition"]["unit_code"] = "per_field"
    output["definition"]["field_definitions"] = [{
        "field_code": "amount", "data_type": "decimal", "unit_code": "count",
        "measurement_nature": "flow", "time_role": "observation"}]
    observation = output["payload"]["rows"][0]["observation_time"]
    output["payload"] = {"kind": "tabular_rows", "rows": [{
        "business_key": "old-row", "subject": output["subject"],
        "observation_time": observation,
        "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "1"}}}]}
    first = service.submit(ingest_request([output], "held-diagnostic-first"))
    assert first["state"] == "published_formal", first
    stamp = first["holding_status"]["published_readable_at"]
    # Wait for the actual host clock to advance past its second-precision stage
    # evidence. Do not fabricate a stage, overwrite a receipt or patch _now().
    deadline = time.monotonic() + 5
    while datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") <= stamp:
        assert time.monotonic() < deadline, "host clock did not advance"
        time.sleep(0.02)
    added = copy.deepcopy(output)
    added["definition"]["field_definitions"].append({
        "field_code": "synthetic_later_field", "data_type": "text", "unit_code": "text",
        "measurement_nature": "flow", "time_role": "event"})
    added["payload"]["rows"][0]["business_key"] = "later-row"
    added["payload"]["rows"][0]["values"]["synthetic_later_field"] = {
        "data_type": "text", "value_state": "valid_value", "value": "later"}
    # Explicit host-only disabled mode models a publication with no local proof.
    service._local_holdings = request.param != "unknown"
    second = service.submit(ingest_request([added], "held-diagnostic-second", parent=first["snapshot_id"]))
    assert second["state"] == "published_formal", second
    if request.param == "not_yet_held":
        assert second["holding_status"]["published_readable_at"] > stamp
    pid = first["output_results"][0]["product_id"]
    assert pid == second["output_results"][0]["product_id"]
    assert first["output_results"][0]["definition_ref"] != second["output_results"][0]["definition_ref"]
    scope = first["holding_status"]["instance_id"]
    held = service.read(pid, snapshot_id=second["snapshot_id"], perspective="system_held_at",
                        at=stamp, held_scope=scope, usable_stage="published_readable")
    assert [row["record_id"] for row in held["rows"]] == ["old-row"]
    assert len(held["products"]) == 1
    old_contract = held["products"][0]["contract_ref"]
    assert held["products"][0]["declaration"]["field_definitions"] == output["definition"]["field_definitions"]
    all_products = service.discover_products(snapshot_id=second["snapshot_id"])["products"]
    later = next(product for product in all_products
                 if product["product_id"] == pid and product["contract_ref"] != old_contract)
    assert later["contract_ref"]["digest"] not in json.dumps(held)
    assert held["diagnostics"][0]["holding_state"] == request.param
    assert held["diagnostics"][0]["record_id"] == "later-row"
    end = (datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ") + timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    query = query_request("wfd_r1_local", second["snapshot_id"], pid, ["amount"],
        history_mode="system_held_at", held_scope=scope, usable_stage="published_readable",
        knowledge_cutoff={"status": "known", "precision": "second", "earliest_utc": stamp,
                          "latest_exclusive_utc": end, "source_timezone": "UTC"},
        business_time_range={"role": "event", "start": "2025-01-01", "end": "2025-12-31", "timezone": "UTC"})
    return service, query, later["contract_ref"]


def assert_minimal_error(error, later_contract):
    assert error["code"] == "BUSINESS_TIME_ROLE_MISMATCH"
    assert error["details"]["requested_role"] == "event"
    assert "contracts" not in error["details"]
    assert "available_roles" not in error["details"]
    encoded = json.dumps(error)
    assert later_contract["digest"] not in encoded
    assert later_contract["id"] not in encoded
    assert "synthetic_later_field" not in encoded


def test_held_role_diagnostic_is_minimal_but_snapshot_remains_descriptive(additive_held_store):
    service, request_doc, later_contract = additive_held_store
    query = ProductQuery(service)
    with pytest.raises(ProductQueryError) as caught:
        query.execute(request_doc)
    assert_minimal_error(caught.value.as_dict(), later_contract)
    snapshot_request = dict(request_doc, history_mode="snapshot_contents", knowledge_cutoff=None,
                            held_scope=None, usable_stage=None)
    with pytest.raises(ProductQueryError) as snapshot:
        query.execute(snapshot_request)
    assert snapshot.value.code == "BUSINESS_TIME_ROLE_MISMATCH"
    assert snapshot.value.details["available_roles"] == ["observation"]
    assert any(item["contract_ref"] == later_contract and "event" in item["declared_roles"]
               for item in snapshot.value.details["contracts"])


def test_machine_held_role_error_does_not_reintroduce_unheld_contract(tmp_path, additive_held_store):
    service, request_doc, later_contract = additive_held_store
    config = _machine_config(tmp_path, service)
    document = json.loads(config.read_text())
    document["units"] = UNITS
    config.write_text(json.dumps(document))
    reply = machine_call(config, "read_product", {"request": request_doc})
    assert reply["ok"] is False
    assert_minimal_error(reply["error"], later_contract)
    selected = machine_call(config, "read_product", {"request": dict(request_doc, business_time_range=None)})
    assert selected["ok"] is True, selected
    assert later_contract["digest"] not in json.dumps(selected)
    assert selected["result"]["rows"][0]["record_ref"]["logical_key"] == "old-row"
