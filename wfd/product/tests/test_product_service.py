"""Targeted checks of the new product layer, not a storage re-validation."""
import copy
import json
from pathlib import Path
import pytest

from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_service import SERVICE_VERSION, WFDProductService


HERE = Path(__file__).resolve().parents[1]
ALL_ROLES = {"evidence_write", "register", "submit", "publish", "read", "read_evidence", "export", "redistribute"}
SOURCE_POLICY = {
    "may_submit": True, "may_publish_formal": True,
    "may_read": True, "may_read_evidence": True,
    "allowed_roles": ["definer", "first_publisher", "republisher", "deliverer", "compiler", "acquirer"],
    "allowed_authorities": ["portoflosangeles.official", "p1.test", "p3.test", "audit", "p3.real"],
    "may_export": True, "may_export_evidence": True,
    "export_scope": "user_local_validation_only", "usage_scope": "test_only",
}
UNIT_REGISTRY = {"vehicle": {"dimension": "quantity"}, "share": {"dimension": "quantity"}}


def make_service(tmp_path):
    engine = WFDDuckDBPrototype(tmp_path / "store", load_protocol_validator(HERE / "protocol"),
                               runtime_root=tmp_path / "runtime", sandbox=False, writer_host="test")
    service = WFDProductService(engine, allowed_sources={"fixture": dict(SOURCE_POLICY)},
                                caller_roles=ALL_ROLES, caller_id="test-caller",
                                unit_registry=UNIT_REGISTRY,
                                trusted_actor_namespaces={"wfd.test.curated"})
    evidence_path = tmp_path / "source.txt"
    evidence_path.write_text("Synthetic product-layer fixture, not real financial data.")
    evidence = service.register_evidence(evidence_path)
    doc = json.loads((HERE / "fixtures/port_annual_autos.json").read_text())
    doc["source_bundle"] = {"source_id": "fixture", "license": "test_only"}
    doc["outputs"][0]["payload"]["rows"] = doc["outputs"][0]["payload"]["rows"][:1]
    doc["outputs"][0]["evidence_refs"] = [evidence]
    doc["source_bundle"]["product_service"] = {
        "version": SERVICE_VERSION,
        "outputs": {doc["outputs"][0]["output_key"]: {"read_dependencies": []}},
    }
    return service, doc


def test_registration_reuse_fixed_read_and_historical_scope(tmp_path):
    service, doc = make_service(tmp_path)
    first = service.submit(doc)
    published = first["output_results"][0]
    assert published["registration_state"] == "registered"
    assert published["publication_state"] == "published_formal"
    pid, s1 = published["product_id"], first["snapshot_id"]
    assert service.submit(doc)["engine_receipt"]["idempotent_replay"] is True

    # Recreate the service before reuse: this is a persisted registry lookup.
    service = WFDProductService(service.engine, allowed_sources={"fixture": dict(SOURCE_POLICY)},
                                caller_roles=ALL_ROLES, caller_id="test-caller",
                                unit_registry=UNIT_REGISTRY,
                                trusted_actor_namespaces={"wfd.test.curated"})
    second_doc = copy.deepcopy(doc)
    second_doc["request_identity"]["request_id"] = "second"
    second_doc["expected_parent_snapshot_id"] = s1
    output = second_doc["outputs"][0]
    output.update(definition_mode="reuse", definition_ref=published["definition_ref"], new_definition_declaration=None)
    output["payload"]["rows"][0]["business_key"] = "next_period"
    second = service.submit(second_doc)
    assert second["status"] == "published_formal"
    assert second["output_results"][0]["publication_state"] == "published_formal"
    assert second["output_results"][0]["product_id"] == pid
    assert second["output_results"][0]["registration_state"] == "reused"
    assert len(service.read(pid, snapshot_id=s1)["rows"]) == 1
    assert len(service.read(pid, snapshot_id=second["snapshot_id"])["rows"]) == 2
    history = service.read(pid, snapshot_id=s1, perspective="market_known_at", at="2024-01-01T00:00:00Z")
    assert history["rows"] == []
    assert history["diagnostics"][0]["decision"] == "indeterminate"
    old_held = service.read(pid, snapshot_id=s1, perspective="system_held_at", at="2024-01-01T00:00:00Z")
    assert old_held["rows"] == []
    assert old_held["held_scope"] == "received_structured"
    assert service.trace(pid, snapshot_id=s1)["evidence"][0]["verified"] is True
    assert first["production_publishable"] is False


def test_registration_is_not_publication(tmp_path):
    service, doc = make_service(tmp_path)
    # One business-contract failure: a vehicle count cannot be negative.
    doc["outputs"][0]["payload"]["rows"][0]["value_decimal"] = "-1"
    result = service.submit(doc)
    assert result["snapshot_id"] is None
    output = result["output_results"][0]
    assert output["registration_state"] == "registered"
    assert output["publication_state"] == "not_published"
    assert output["errors"][0]["code"] == "NEGATIVE_QUANTITY"


def known_time(year):
    return {"status": "known", "precision": "year", "earliest_utc": f"{year}-01-01T00:00:00Z",
            "latest_exclusive_utc": f"{year + 1}-01-01T00:00:00Z", "source_timezone": "UTC"}


def test_partial_admission_reports_partial_publication(tmp_path):
    service, doc = make_service(tmp_path)
    bad = copy.deepcopy(doc["outputs"][0])
    bad.update(output_key="missing_evidence", evidence_refs=[])
    doc["outputs"].append(bad)
    doc["source_bundle"]["product_service"]["outputs"][bad["output_key"]] = {"read_dependencies": []}
    result = service.submit(doc)
    assert result["status"] == "partially_published_formal"
    assert result["engine_receipt"]["status"] == "published_sandbox"
    assert [r["publication_state"] for r in result["output_results"]] == ["published_formal", "not_published"]


def test_pending_activation_remains_pending_on_replay(tmp_path, monkeypatch):
    service, doc = make_service(tmp_path)
    activate = service.engine.state.activate
    monkeypatch.setattr(service.engine.state, "activate", lambda *a, **k: {"ok": False, "detail": "targeted activation failure"})
    first = service.submit(doc)
    replay = service.submit(doc)
    assert first["status"] == replay["status"] == "published_commit_pending_head"
    assert replay["output_results"][0]["publication_state"] == "committed_pending_activation"
    assert service.engine.state.read()["active_head"] is None
    monkeypatch.setattr(service.engine.state, "activate", activate)
    sid = first["snapshot_id"]
    assert activate(sid, service.root / f"catalog/snapshots/{sid}.json", expected_prev=None, writer_host="test")["ok"]
    assert service.submit(doc)["output_results"][0]["publication_state"] == "published_formal"


def test_output_times_are_bound_to_their_own_files_and_batch_keys(tmp_path):
    service, doc = make_service(tmp_path)
    first = doc["outputs"][0]
    first["output_key"] = "late"
    key = first["payload"]["rows"][0]["business_key"]
    second = copy.deepcopy(first)
    second["output_key"] = "early"
    second["payload"]["rows"][0]["business_key"] = "second_key"
    duplicate = copy.deepcopy(second)
    duplicate["output_key"] = "duplicate"
    doc["outputs"] = [first, second, duplicate]
    doc["source_bundle"]["product_service"]["outputs"] = {
        out["output_key"]: {"read_dependencies": []} for out in doc["outputs"]}
    doc["source_bundle"]["row_public_times"] = {
        "late": {key: known_time(2026)},
        "early": {key: known_time(2020), "second_key": known_time(2020)}}
    result = service.submit(doc)
    assert result["output_results"][2]["errors"][0]["code"] == "DUPLICATE_BATCH_BUSINESS_KEY"
    historical = service.read(snapshot_id=result["snapshot_id"], perspective="market_known_at", at="2024-01-01T00:00:00Z")
    assert [r["row"]["business_key"] for r in historical["rows"]] == ["second_key"]
    assert historical["diagnostics"][0]["business_key"] == key


def test_company_view_scopes_metadata_and_excludes_invalid_relation(tmp_path):
    service, doc = make_service(tmp_path)
    company = {"kind": "entity", "namespace": "test", "id": "company_a"}
    other = {"kind": "entity", "namespace": "test", "id": "company_b"}
    security = {"kind": "instrument", "namespace": "test", "id": "security_a"}
    unknown = {"status": "unknown", "precision": "unknown", "earliest_utc": None,
               "latest_exclusive_utc": None, "source_timezone": "UTC"}
    template = doc["outputs"][0]
    outputs = []
    for name, subject in [("company", company), ("other", other), ("security", security)]:
        output = copy.deepcopy(template)
        output.update(output_key=name, subject=subject)
        output["payload"]["rows"][0]["business_key"] = name
        outputs.append(output)
    relation = copy.deepcopy(template)
    relation.update(output_key="relation", subject=company, logical_domain="foundation")
    relation["new_definition_declaration"].update(semantic_code="issuer_relationship", measurement_nature="relation", unit_code="not_applicable")
    relation["payload"] = {"kind": "relation_edges", "rows": [{"business_key": "relation", "subject": company,
        "object": security, "relation_type": "has_security", "effective_period": unknown, "public_time": known_time(2020)}]}
    outputs.append(relation)
    doc["outputs"] = outputs
    doc["source_bundle"]["product_service"]["outputs"] = {
        out["output_key"]: {"read_dependencies": []} for out in outputs}
    doc["source_bundle"].update(public_time=known_time(2020), row_public_times={"other": {"other": unknown}})
    result = service.submit(doc)
    view = service.company_view(company, snapshot_id=result["snapshot_id"], perspective="market_known_at", at="2024-01-01T00:00:00Z")
    assert [r["row"]["business_key"] for r in view["rows"]] == ["company"]
    assert [d["business_key"] for d in view["diagnostics"]] == ["relation"]
    assert {p["product_id"] for p in view["products"]} == {result["output_results"][i]["product_id"] for i in (0, 3)}


def next_doc(doc, request, parent, key):
    result = copy.deepcopy(doc)
    result["request_identity"]["request_id"] = request
    result["expected_parent_snapshot_id"] = parent
    result["outputs"][0]["payload"]["rows"][0]["business_key"] = key
    return result


def extension(doc, **value):
    doc["source_bundle"]["product_service"] = {"version": "wfd.product-service/0.2",
        "outputs": {doc["outputs"][0]["output_key"]: value}}


def test_fixed_read_dependencies_are_publication_bindings(tmp_path):
    service, doc = make_service(tmp_path)
    first = service.submit(doc)
    dep_pid, s1 = first["output_results"][0]["product_id"], first["snapshot_id"]
    business = next_doc(doc, "business", s1, "business_first")
    business["outputs"][0]["new_definition_declaration"]["semantic_code"] = "dependent.business"
    dep = {"dataset_id": doc["request_identity"]["dataset_id"], "product_id": dep_pid,
           "snapshot_id": s1, "role": "identity", "required": True}
    extension(business, read_dependencies=[dep])
    second = service.submit(business)
    pid, s2 = second["output_results"][0]["product_id"], second["snapshot_id"]
    template = (service.root / f"catalog/product_service/products/{pid}.json").read_bytes()
    later = next_doc(business, "business_later", s2, "business_second")
    extension(later, read_dependencies=[{**dep, "snapshot_id": s2}])
    third = service.submit(later)
    assert third["output_results"][0]["product_id"] == pid
    assert (service.root / f"catalog/product_service/products/{pid}.json").read_bytes() == template
    assert service.read(pid, snapshot_id=s2)["products"][0]["contracts"]["read"]["dependencies"] == [dep]
    assert len([p for p in service.discover_products(snapshot_id=third["snapshot_id"])["products"] if p["product_id"] == pid]) == 2
    # Reusing the product must not silently erase the pinned dependency
    # requirements that are carried by the fixed parent contract.
    omitted = copy.deepcopy(business)
    omitted["request_identity"]["request_id"] = "business_omitted_dependency"
    omitted["expected_parent_snapshot_id"] = s2
    del omitted["source_bundle"]["product_service"]["outputs"][business["outputs"][0]["output_key"]]["read_dependencies"]
    omitted_result = service.submit(omitted)
    assert omitted_result["status"] == "registered_not_published"
    assert any(item.get("errors", [{}])[0].get("code") == "READ_DEPENDENCY_DECLARATION_REQUIRED"
               for item in omitted_result["output_results"])

    # The current files remain readable to the storage engine; the product
    # reader must still reject a missing pinned dependency snapshot.
    (service.root / f"catalog/snapshots/{s1}.json").unlink()
    with pytest.raises(ValueError, match="DEPENDENCY_SNAPSHOT_UNAVAILABLE"):
        service.read(pid, snapshot_id=third["snapshot_id"])


def test_logical_revision_withdrawal_and_historical_selection(tmp_path):
    service, doc = make_service(tmp_path)
    doc["source_bundle"]["public_time"] = known_time(2020)
    first = service.submit(doc)
    pid, s1 = first["output_results"][0]["product_id"], first["snapshot_id"]
    original = service.read(pid, snapshot_id=s1)["rows"][0]
    key = original["record_ref"]["logical_key"]
    correction = next_doc(doc, "correction", s1, key)
    correction["outputs"][0]["input_mode"] = "source_correction"
    correction["outputs"][0]["payload"]["rows"][0]["value_decimal"] = "157067"
    correction["source_bundle"]["public_time"] = known_time(2022)
    extension(correction, revisions={key: {"previous": original["record_ref"], "reason": "Synthetic source correction fixture"}})
    second = service.submit(correction)
    assert second["status"] == "published_formal"
    s2 = second["snapshot_id"]
    assert service.read(pid, snapshot_id=s1)["rows"][0]["row"]["value_decimal"] == "157066"
    assert service.read(pid, snapshot_id=s2, perspective="market_known_at", at="2021-06-01T00:00:00Z")["rows"][0]["row"]["value_decimal"] == "157066"
    corrected = service.read(pid, snapshot_id=s2)["rows"][0]
    assert corrected["row"]["value_decimal"] == "157067"
    repair = next_doc(correction, "repair", s2, key)
    repair["outputs"][0]["input_mode"] = "processing_repair"
    extension(repair, revisions={key: {"previous": corrected["record_ref"], "reason": "Same-value evidence processing repair"}})
    third = service.submit(repair)
    assert third["status"] == "published_formal"
    current = service.read(pid, snapshot_id=third["snapshot_id"])["rows"][0]
    withdrawal = next_doc(repair, "withdrawal", third["snapshot_id"], key)
    withdrawal["outputs"][0]["input_mode"] = "withdrawal"
    withdrawal["source_bundle"]["public_time"] = known_time(2024)
    extension(withdrawal, revisions={key: {"previous": current["record_ref"], "reason": "Synthetic withdrawal fixture"}})
    fourth = service.submit(withdrawal)
    assert fourth["status"] == "published_formal"
    assert service.read(pid, snapshot_id=fourth["snapshot_id"])["rows"] == []
    assert service.read(pid, snapshot_id=fourth["snapshot_id"], perspective="market_known_at", at="2023-06-01T00:00:00Z")["rows"][0]["row"]["value_decimal"] == "157067"
    history = service.read(pid, snapshot_id=fourth["snapshot_id"], include_history=True)["rows"]
    assert [r["revision_state"] for r in history] == ["superseded", "superseded", "superseded", "withdrawn"]
    assert service.read(pid, snapshot_id=fourth["snapshot_id"], perspective="system_held_at", at="2025-01-01T00:00:00Z")["rows"] == []
    wrong = next_doc(repair, "wrong_target", fourth["snapshot_id"], key)
    extension(wrong, revisions={key: {"previous": {**current["record_ref"], "product_id": "different_product"}, "reason": "Invalid cross-product fixture"}})
    assert service.submit(wrong)["output_results"][0]["errors"][0]["code"] == "REVISION_TARGET_MISMATCH"


def test_company_listing_calendar_queries_apply_historical_eligibility(tmp_path):
    service, doc = make_service(tmp_path)
    company = {"kind": "entity", "namespace": "test", "id": "company"}
    security = {"kind": "instrument", "namespace": "test", "id": "security"}
    listing = {"kind": "listing", "namespace": "test", "id": "listing"}
    market = {"kind": "market", "namespace": "test", "id": "market"}
    template = doc["outputs"][0]
    outputs = []
    period = {**known_time(2000), "latest_exclusive_utc": "2030-01-01T00:00:00Z", "precision": "interval"}
    for name, left, right in [("has_security", company, security), ("has_listing", security, listing), ("listed_on", listing, market)]:
        out = copy.deepcopy(template)
        out.update(output_key=name, logical_domain="foundation", subject=left)
        out["new_definition_declaration"].update(semantic_code=name, measurement_nature="relation", unit_code="not_applicable")
        out["payload"] = {"kind": "relation_edges", "rows": [{"business_key": name, "subject": left, "object": right,
            "relation_type": name, "effective_period": period, "public_time": known_time(2022 if name == "has_listing" else 2020)}]}
        outputs.append(out)
    calendar = copy.deepcopy(template)
    calendar.update(output_key="calendar", logical_domain="foundation", subject=market)
    calendar["new_definition_declaration"].update(semantic_code="market.calendar", unit_code="not_applicable", measurement_nature="mixed_observation",
        field_definitions=[{"field_code": code, "data_type": dtype, "unit_code": "not_applicable", "measurement_nature": "mixed_observation", "time_role": "session_date"}
                           for code, dtype in [("session_date", "text"), ("is_open", "boolean")]])
    calendar["payload"] = {"kind": "tabular_rows", "rows": [{"business_key": "2023-01-03", "subject": market,
        "observation_time": known_time(2023), "values": {"session_date": {"data_type": "text", "value_state": "valid_value", "value": "2023-01-03"},
        "is_open": {"data_type": "boolean", "value_state": "valid_value", "value": True}}}]}
    outputs.append(calendar)
    doc["outputs"] = outputs
    doc["source_bundle"]["product_service"]["outputs"] = {
        out["output_key"]: {"read_dependencies": []} for out in outputs}
    doc["source_bundle"]["public_time"] = known_time(2020)
    result = service.submit(doc)
    sid = result["snapshot_id"]
    before = service.company_view(company, snapshot_id=sid, perspective="market_known_at", at="2021-06-01T00:00:00Z")
    after = service.company_view(company, snapshot_id=sid, perspective="market_known_at", at="2023-06-01T00:00:00Z")
    assert before["identities"] == [company, security]
    assert after["identities"] == [company, security, listing, market]
    calendar_pid = result["output_results"][-1]["product_id"]
    assert len(service.read_calendar(calendar_pid, snapshot_id=sid, start_date="2023-01-01", end_date="2023-01-05")["rows"]) == 1
