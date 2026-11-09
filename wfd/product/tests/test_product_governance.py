"""P1 governance checks: contracts, permissions, request state and formal publish."""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from test_product_service import (
    ALL_ROLES, HERE, SOURCE_POLICY, UNIT_REGISTRY, extension, fixture_source_roles,
    known_time, make_service, next_doc,
)
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_bundle import export_financial_bundle
from wfd_sdk.product_governance import validate_definition, validate_payload
from wfd_sdk.product_service import WFDProductService, canonical, sha


def new_reader(engine_root: Path, tmp_path: Path) -> WFDProductService:
    engine = WFDDuckDBPrototype(
        engine_root, load_protocol_validator(HERE / "protocol"),
        runtime_root=tmp_path / "reader_runtime", sandbox=False, writer_host="reader",
    )
    return WFDProductService(
        engine, allowed_sources={"fixture": dict(SOURCE_POLICY)},
        caller_roles={"read", "read_evidence"}, caller_id="reader",
        trusted_actor_namespaces={"wfd.test.curated"},
    )


def test_new_definition_formal_publish_and_new_instance_read(tmp_path):
    service, doc = make_service(tmp_path)
    result = service.submit(doc)
    assert result["status"] == "published_formal"
    assert result["formal_publication_verified"] is True
    assert result["formal_publication_checks"] and all(result["formal_publication_checks"].values())
    assert result["production_publishable"] is False  # storage-level acceptance remains separate

    item = result["output_results"][0]
    pid, sid = item["product_id"], result["snapshot_id"]
    receipt_path = tmp_path / "store" / result["formal_publication_receipt"]
    assert receipt_path.is_file()
    formal = json.loads(receipt_path.read_text("utf-8"))
    assert formal["raw_engine_status"] == "published_sandbox"
    assert formal["snapshot_id"] == sid
    assert formal["commit_marker_sha256"]
    assert formal["formal_publication_state"] == "published_formal"

    product = service.discover_products(snapshot_id=sid)["products"][0]
    assert product["definition_sequence"] == 1
    assert set(product["contracts"]["part_digests"]) == {
        "semantic", "read", "compute_dependencies", "publication",
    }
    assert product["contracts"]["read"]["primary_key"] == "business_key"
    assert product["contracts"]["read"]["business_time_field"] == "observation_time"

    reader = new_reader(tmp_path / "store", tmp_path)
    rows = reader.read(pid, snapshot_id=sid)["rows"]
    assert len(rows) == 1
    assert reader.trace(pid, snapshot_id=sid)["evidence"][0]["verified"] is True
    assert reader.request_status(doc["request_identity"])["state"] == "published_formal"


def test_missing_unit_and_invalid_time_get_contract_errors(tmp_path):
    service, doc = make_service(tmp_path)

    missing_unit = copy.deepcopy(doc)
    missing_unit["request_identity"]["request_id"] = "missing-unit"
    missing_unit["outputs"][0]["new_definition_declaration"]["unit_code"] = "unknown"
    result = service.submit(missing_unit)
    assert result["status"] == "rejected"
    assert result["output_results"][0]["errors"][0]["code"] == "UNIT_MEANING_REQUIRED"

    bad_time = copy.deepcopy(doc)
    bad_time["request_identity"]["request_id"] = "bad-time"
    row = bad_time["outputs"][0]["payload"]["rows"][0]
    row["observation_time"]["latest_exclusive_utc"] = row["observation_time"]["earliest_utc"]
    result = service.submit(bad_time)
    assert result["status"] == "registered_not_published"
    assert result["output_results"][0]["errors"][0]["code"] == "TIME_INTERVAL_INVALID"


def test_no_implicit_source_or_caller_permissions(tmp_path):
    service, doc = make_service(tmp_path)
    no_submit = WFDProductService(
        service.engine, allowed_sources={"fixture": dict(SOURCE_POLICY)},
        caller_roles={"read"}, caller_id="submit-denied",
        unit_registry={"vehicle": {"dimension": "quantity"}},
        trusted_actor_namespaces={"wfd.test.curated"},
    )
    denied = no_submit.submit(doc)
    assert denied["status"] == "rejected"
    assert denied["errors"][0]["code"] == "CALLER_PERMISSION_DENIED"

    no_source = WFDProductService(
        service.engine, allowed_sources={"fixture": {"usage_scope": "test_only"}},
        caller_roles=ALL_ROLES, caller_id="source-denied",
        unit_registry={"vehicle": {"dimension": "quantity"}},
        trusted_actor_namespaces={"wfd.test.curated"},
    )
    denied = no_source.submit(doc)
    assert denied["status"] == "rejected"
    assert denied["errors"][0]["code"] == "SOURCE_NOT_ADMITTED"

    # A read-only caller can read but cannot expose evidence or export a bundle.
    result = service.submit(doc)
    sid = result["snapshot_id"]
    reader = new_reader(tmp_path / "store", tmp_path)
    read_only = WFDProductService(
        reader.engine, allowed_sources={"fixture": dict(SOURCE_POLICY)},
        caller_roles={"read"}, caller_id="read-only",
        trusted_actor_namespaces={"wfd.test.curated"},
    )
    assert reader.read(result["output_results"][0]["product_id"], snapshot_id=sid)["rows"]
    with pytest.raises(PermissionError, match="CALLER_PERMISSION_DENIED"):
        read_only.trace(result["output_results"][0]["product_id"], snapshot_id=sid)
    with pytest.raises(PermissionError, match="CALLER_PERMISSION_DENIED"):
        export_financial_bundle(reader, [result["output_results"][0]["product_id"]],
                                tmp_path / "forbidden-bundle", snapshot_id=sid)


def test_registration_success_publication_failure_is_queryable(tmp_path):
    service, doc = make_service(tmp_path)
    doc["expected_parent_snapshot_id"] = "s_does_not_exist"
    result = service.submit(doc)
    assert result["status"] == "registered_not_published"
    item = result["output_results"][0]
    assert item["registration_state"] == "registered"
    assert item["publication_state"] == "not_published"
    assert result["request_key"]

    status = service.request_status(doc["request_identity"])
    assert status["state"] == "registered_not_published"
    assert status["phases"]["registration"] == "registered"
    assert status["output_results"][0]["registration_state"] == "registered"


def test_breaking_definition_gets_new_family_version_and_old_read_survives(tmp_path):
    service, doc = make_service(tmp_path)
    first = service.submit(doc)
    assert first["status"] == "published_formal"
    first_pid, first_sid = first["output_results"][0]["product_id"], first["snapshot_id"]
    first_product = next(p for p in service.discover_products(snapshot_id=first_sid)["products"]
                         if p["product_id"] == first_pid)

    second_doc = copy.deepcopy(doc)
    second_doc["request_identity"]["request_id"] = "definition-v2"
    second_doc["expected_parent_snapshot_id"] = first_sid
    second_doc["outputs"][0]["new_definition_declaration"]["unit_code"] = "share"
    second = service.submit(second_doc)
    print("SECOND", second["status"], second["output_results"][0].get("errors"))
    assert second["status"] == "published_formal"
    second_pid = second["output_results"][0]["product_id"]
    assert second_pid != first_pid
    second_product = next(p for p in service.discover_products(snapshot_id=second["snapshot_id"])["products"]
                          if p["product_id"] == second_pid)
    assert second_product["product_family_id"] == first_product["product_family_id"]
    assert second_product["definition_sequence"] == 2
    assert second_product["definition_compatibility"] == "breaking"
    assert second_product["definition_parent_ref"] == first_product["definition_ref"]

    reader = new_reader(tmp_path / "store", tmp_path)
    rows = reader.read(first_pid, snapshot_id=first_sid)["rows"]
    assert len(rows) == 1
    assert rows[0]["definition_ref"] == first_product["definition_ref"]


def test_field_type_precision_and_null_contract_checks():
    declaration = {
        "semantic_code": "test.contract.values",
        "measurement_nature": "mixed_observation",
        "unit_code": "per_field",
        "definition_authority": "p1.test",
        "time_role": "observation",
        "field_definitions": [
            {"field_code": "amount", "data_type": "decimal", "unit_code": "cny",
             "measurement_nature": "stock", "time_role": "observation"},
            {"field_code": "count", "data_type": "integer", "unit_code": "share",
             "measurement_nature": "stock", "time_role": "observation"},
            {"field_code": "note", "data_type": "text", "unit_code": "text",
             "measurement_nature": "stock", "time_role": "observation"},
        ],
    }
    dimension = copy.deepcopy(declaration)
    dimension["field_definitions"][0]["unit_code"] = "text"
    issues = validate_definition(dimension, "tabular_rows")
    assert any(x["code"] == "UNIT_DIMENSION_MISMATCH" for x in issues)

    unknown = {"status": "unknown", "precision": "unknown", "earliest_utc": None,
               "latest_exclusive_utc": None, "source_timezone": "UTC"}
    output = {
        "payload": {"kind": "tabular_rows", "rows": [{
            "business_key": "row-1", "observation_time": unknown,
            "values": {
                "amount": {"data_type": "decimal", "value_state": "valid_value",
                           "value": "1.1234567890123456789"},
                "count": {"data_type": "text", "value_state": "valid_value", "value": "1"},
                "note": {"data_type": "text", "value_state": "valid_value", "value": None},
            },
        }]},
    }
    codes = {x["code"] for x in validate_payload(output, declaration)}
    assert "VALUE_SCALE_UNSUPPORTED" in codes
    assert "FIELD_TYPE_MISMATCH" in codes
    assert "VALUE_REQUIRED" in codes


def test_additive_field_definition_is_classified_compatible():
    base_field = {"field_code": "amount", "data_type": "decimal", "unit_code": "cny",
                  "measurement_nature": "stock", "time_role": "observation"}
    prior = {"declaration": {"semantic_code": "test.additive", "measurement_nature": "stock",
                             "unit_code": "per_field", "definition_authority": "p1.test",
                             "time_role": "observation", "field_definitions": [base_field]}}
    added = copy.deepcopy(prior)
    added["declaration"]["field_definitions"].append(
        {"field_code": "note", "data_type": "text", "unit_code": "text",
         "measurement_nature": "stock", "time_role": "observation"})
    assert WFDProductService._definition_relation(prior, added["declaration"]) == "compatible_additive"


def test_additive_field_context_preserves_existing_fields_and_global_scope():
    old = {"semantic_code": "test.source-qualifications", "measurement_nature": "mixed_observation",
           "unit_code": "per_field", "definition_authority": "p1.test", "time_role": "observation",
           "field_definitions": [{"field_code": "reading", "data_type": "decimal", "unit_code": "cny",
                                  "measurement_nature": "mixed_observation", "time_role": "observation"}],
           "semantic_context": {"content_nature": "source_claim"},
           "field_semantic_context": {"reading": {"content": {"assertion_status": "source_reported_price_label"}}}}
    added = copy.deepcopy(old)
    added["field_definitions"].append({"field_code": "note", "data_type": "text", "unit_code": "text",
                                        "measurement_nature": "mixed_observation", "time_role": "observation"})
    added["field_semantic_context"]["note"] = {"content": {"assertion_status": "source_reported_interpretation"}}
    assert WFDProductService._definition_relation({"declaration": old}, added) == "compatible_additive"
    for change in ("delete_context", "replace_context", "override_time", "change_global", "change_unit", "remove_field"):
        candidate = copy.deepcopy(added)
        if change == "delete_context":
            del candidate["field_semantic_context"]["reading"]
        elif change == "replace_context":
            candidate["field_semantic_context"]["reading"]["content"]["assertion_status"] = "confirmed_market_fact"
        elif change == "override_time":
            candidate["field_semantic_context"]["reading"]["time"] = {"period_type": "instant"}
        elif change == "change_global":
            candidate["semantic_context"]["content_nature"] = "observed_fact"
        elif change == "change_unit":
            candidate["field_definitions"][0]["unit_code"] = "usd"
        else:
            candidate["field_definitions"] = candidate["field_definitions"][1:]
            del candidate["field_semantic_context"]["reading"]
        assert WFDProductService._definition_relation({"declaration": old}, candidate) == "breaking", change
    unqualified = copy.deepcopy(old)
    del unqualified["field_semantic_context"]
    assert WFDProductService._definition_relation({"declaration": unqualified}, added) == "breaking"


def test_idempotent_replay_preserves_original_grade(tmp_path):
    service, doc = make_service(tmp_path)
    first = service.submit(doc)
    assert first["status"] == "published_formal"
    replay = WFDProductService(
        service.engine,
        allowed_sources={"fixture": {"may_submit": True, "usage_scope": "test_only"}},
        caller_roles={"submit", "read"}, caller_id="replay",
        unit_registry=UNIT_REGISTRY, trusted_actor_namespaces={"wfd.test.curated"},
    )
    again = replay.submit(doc)
    assert again["status"] == "published_formal"
    assert again["idempotent_replay"] is True
    assert again["formal_publication_verified"] is True
    assert again["engine_receipt"]["idempotent_replay"] is True

    sandbox_service, sandbox_doc = make_service(tmp_path / "sandbox")
    sandbox = WFDProductService(
        sandbox_service.engine,
        allowed_sources={"fixture": {"may_submit": True, "usage_scope": "test_only",
                                      "allowed_roles": ["definer", "first_publisher", "deliverer"],
                                      "allowed_authorities": ["portoflosangeles.official"]}},
        caller_roles=ALL_ROLES, caller_id="sandbox",
        unit_registry=UNIT_REGISTRY, trusted_actor_namespaces={"wfd.test.curated"},
    )
    original = sandbox.submit(sandbox_doc)
    assert original["status"] == "published_sandbox"
    formal_again = WFDProductService(
        sandbox_service.engine, allowed_sources={"fixture": dict(SOURCE_POLICY)},
        caller_roles=ALL_ROLES, caller_id="formal-after",
        unit_registry=UNIT_REGISTRY, trusted_actor_namespaces={"wfd.test.curated"},
    )
    replay_sandbox = formal_again.submit(sandbox_doc)
    assert replay_sandbox["status"] == "published_sandbox"
    assert replay_sandbox["formal_publication_verified"] is False


def test_cached_prep_rechecks_current_source_scope(tmp_path):
    service, doc = make_service(tmp_path)
    doc["expected_parent_snapshot_id"] = "s_does_not_exist"
    first = service.submit(doc)
    assert first["status"] == "registered_not_published"
    service.allowed_sources["fixture"]["allowed_domains"] = ["events"]
    retry = service.submit(doc)
    assert retry["status"] == "rejected"
    assert retry["errors"][0]["code"] == "SOURCE_SCOPE_DENIED"
    preserved = service.request_status(doc["request_identity"])
    assert preserved["state"] == "registered_not_published"
    assert preserved["last_attempt"]["code"] == "SOURCE_SCOPE_DENIED"


def test_unknown_unit_registers_but_cannot_formally_publish(tmp_path):
    service, doc = make_service(tmp_path)
    doc["outputs"][0]["new_definition_declaration"]["unit_code"] = "mystery_unit"
    result = service.submit(doc)
    assert result["status"] == "registered_not_published"
    assert result["output_results"][0]["registration_state"] == "registered"
    assert any(x["code"] == "UNIT_DEFINITION_REQUIRED" for x in result["output_results"][0]["errors"])
    assert service.request_status(doc["request_identity"])["state"] == "registered_not_published"


def test_actor_binding_and_schema_rejection_have_persistent_status(tmp_path):
    service, doc = make_service(tmp_path)
    spoofed = copy.deepcopy(doc)
    spoofed["request_identity"]["request_id"] = "actor-spoof"
    spoofed["request_identity"]["trusted_actor_namespace"] = "actor.bob"
    result = service.submit(spoofed)
    assert result["status"] == "rejected"
    assert result["errors"][0]["code"] == "ACTOR_NAMESPACE_UNTRUSTED"
    status = service.request_status(spoofed["request_identity"])
    assert status["state"] == "unknown"  # untrusted actor must not write a request fact

    malformed = copy.deepcopy(doc)
    malformed["request_identity"]["request_id"] = "schema-bad"
    malformed["outputs"][0].pop("coverage")
    result = service.submit(malformed)
    assert result["status"] == "rejected"
    assert result["errors"][0]["code"] == "SCHEMA_INVALID"
    status = service.request_status(malformed["request_identity"])
    assert status["state"] == "rejected"
    assert status["service_status"] == "rejected"


def test_event_values_and_scalar_unit_use_contract_semantics():
    scalar = {
        "semantic_code": "test.scalar.textunit", "measurement_nature": "stock",
        "unit_code": "text", "definition_authority": "p1.test", "time_role": "observation",
    }
    assert any(x["code"] == "UNIT_DIMENSION_MISMATCH" for x in validate_definition(scalar, "scalar_rows"))

    declaration = {
        "semantic_code": "test.event.values", "measurement_nature": "event",
        "unit_code": "not_applicable", "definition_authority": "p1.test", "time_role": "event_time",
        "field_definitions": [{"field_code": "amount", "data_type": "decimal", "unit_code": "cny",
                               "measurement_nature": "event", "time_role": "event_time"}],
    }
    unknown = {"status": "unknown", "precision": "unknown", "earliest_utc": None,
               "latest_exclusive_utc": None, "source_timezone": "UTC"}
    output = {"payload": {"kind": "event_records", "rows": [{
        "event_id": "evt-1", "subject": {"kind": "entity", "namespace": "test", "id": "x"},
        "event_type": "test", "content_nature": "source_claim", "event_time": unknown,
        "public_time": unknown, "status": "observed",
        "values": {"amount": {"data_type": "text", "value_state": "valid_value", "value": "1"}},
    }]}}
    codes = {x["code"] for x in validate_payload(output, declaration)}
    assert "FIELD_TYPE_MISMATCH" in codes


def test_engine_interruption_persists_publication_unknown(tmp_path, monkeypatch):
    service, doc = make_service(tmp_path)
    def interrupted(_doc):
        raise RuntimeError("simulated interruption after prep")
    monkeypatch.setattr(service.engine, "submit", interrupted)
    result = service.submit(doc)
    assert result["status"] == "publication_unknown"
    status = service.request_status(doc["request_identity"])
    assert status["state"] == "publication_unknown"
    assert status["phases"]["publication"] == "not_published"
    assert any(x["code"] == "PUBLICATION_UNKNOWN" for x in result["errors"])


def test_new_declaration_requires_explicit_dependency_binding(tmp_path):
    service, doc = make_service(tmp_path)
    del doc["source_bundle"]["product_service"]
    result = service.submit(doc)
    assert result["status"] == "registered_not_published"
    assert any(item.get("errors", [{}])[0].get("code") == "READ_DEPENDENCY_DECLARATION_REQUIRED"
               for item in result["output_results"])
    assert service.request_status(doc["request_identity"])["state"] == "registered_not_published"


def test_unauthorized_actor_does_not_overwrite_existing_formal_fact(tmp_path):
    service, doc = make_service(tmp_path)
    first = service.submit(doc)
    assert first["status"] == "published_formal"
    before = service.request_status(doc["request_identity"])
    assert before["state"] == "published_formal"
    hostile = WFDProductService(
        service.engine, allowed_sources={"fixture": dict(SOURCE_POLICY)},
        caller_roles={"read"}, caller_id="actor.alice",
        unit_registry=UNIT_REGISTRY, trusted_actor_namespaces={"other.namespace"},
    )
    denied = hostile.submit(doc)
    assert denied["status"] == "rejected"
    assert denied["errors"][0]["code"] == "CALLER_PERMISSION_DENIED"
    after = service.request_status(doc["request_identity"])
    assert after["state"] == "published_formal"
    assert after["snapshot_id"] == before["snapshot_id"]


def test_commit_then_throw_recovers_formal_intent(tmp_path, monkeypatch):
    service, doc = make_service(tmp_path)
    original_submit = service.engine.submit
    def commit_then_lose(_doc):
        original_submit(_doc)
        raise RuntimeError("simulated lost response after commit")
    monkeypatch.setattr(service.engine, "submit", commit_then_lose)
    first = service.submit(doc)
    assert first["status"] == "publication_unknown"
    assert service.request_status(doc["request_identity"])["state"] == "publication_unknown"
    monkeypatch.setattr(service.engine, "submit", original_submit)
    recovered = service.submit(doc)
    assert recovered["status"] == "published_formal"
    assert recovered["idempotent_replay"] is True
    assert service.request_status(doc["request_identity"])["state"] == "published_formal"


def test_latest_parent_contract_drives_dependency_evolution(tmp_path):
    service, doc = make_service(tmp_path)
    foundation = service.submit(doc)
    dep_pid, s1 = foundation["output_results"][0]["product_id"], foundation["snapshot_id"]
    business = next_doc(doc, "initial_empty", s1, "business_row")
    business["outputs"][0]["new_definition_declaration"]["semantic_code"] = "audit.changed.dependencies"
    extension(business, read_dependencies=[])
    first = service.submit(business)
    pid, s2 = first["output_results"][0]["product_id"], first["snapshot_id"]
    previous = service.read(pid, snapshot_id=s2)["rows"][0]
    dependency = {"dataset_id": doc["request_identity"]["dataset_id"], "product_id": dep_pid,
                  "snapshot_id": s1, "role": "identity", "required": True}
    added = next_doc(business, "added_required", s2, "business_row")
    added["outputs"][0]["input_mode"] = "processing_repair"
    extension(added, read_dependencies=[dependency],
              revisions={"business_row": {"previous": previous["record_ref"], "reason": "Synthetic dependency addition"}})
    second = service.submit(added)
    assert second["status"] == "published_formal"
    previous = service.read(pid, snapshot_id=second["snapshot_id"])["rows"][0]
    head = service.engine.head()
    reversed_head = copy.deepcopy(head)
    reversed_head["files"] = list(reversed(reversed_head["files"]))
    selected = service._head_product_binding(pid, reversed_head)
    assert selected["contracts"]["read"]["dependencies"] == [dependency]
    # A receipt clock rollback must not change the chosen publication batch.
    for entry in reversed_head["files"]:
        if entry.get("product_id") != pid:
            continue
        binding = entry["source_bundle"]["_wfd_product_bindings"][entry["output_key"]]["product"]
        has_dependency = bool(binding["contracts"]["read"]["dependencies"])
        entry["source_bundle"]["_wfd_received_time"] = {
            "status": "known", "precision": "second",
            "earliest_utc": "2026-10-27T01:00:01Z" if has_dependency else "2026-10-27T01:00:02Z",
            "latest_exclusive_utc": "2026-10-27T01:00:02Z" if has_dependency else "2026-10-27T01:00:03Z",
            "source_timezone": "UTC",
        }
    selected = service._head_product_binding(pid, reversed_head)
    assert selected["contracts"]["read"]["dependencies"] == [dependency]
    dropped = next_doc(added, "dropped_latest", second["snapshot_id"], "business_row")
    extension(dropped, revisions={"business_row": {"previous": previous["record_ref"], "reason": "Synthetic omitted dependency"}})
    third = service.submit(dropped)
    assert third["status"] == "registered_not_published"
    assert any(item.get("errors", [{}])[0].get("code") == "READ_DEPENDENCY_DECLARATION_REQUIRED"
               for item in third["output_results"])


def test_custom_unit_dimension_is_enforced(tmp_path):
    service, doc = make_service(tmp_path)
    custom = WFDProductService(
        service.engine, allowed_sources={"fixture": dict(SOURCE_POLICY)},
        caller_roles=ALL_ROLES, caller_id="custom-unit",
        trusted_actor_namespaces={"wfd.test.curated"},
        unit_registry={"custom_label": {"dimension": "text"}},
    )
    doc["outputs"][0]["new_definition_declaration"]["unit_code"] = "custom_label"
    result = custom.submit(doc)
    assert result["status"] == "registered_not_published"
    assert any(item.get("errors", [{}])[0].get("code") == "UNIT_DIMENSION_MISMATCH"
               for item in result["output_results"])


def test_relation_semantics_change_is_breaking():
    base = {
        "semantic_code": "audit.relation", "measurement_nature": "relation",
        "unit_code": "not_applicable", "definition_authority": "p1.test", "time_role": "observation",
        "relation_semantics": {"directed": True, "relation_type": "issued_by"},
    }
    changed = copy.deepcopy(base)
    changed["relation_semantics"] = {"directed": False, "relation_type": "belongs_to"}
    prior = {"declaration": base}
    assert WFDProductService._definition_relation(prior, changed) == "breaking"


def test_column_precision_is_rejected_before_storage():
    declaration = {
        "semantic_code": "test.column.precision", "measurement_nature": "stock",
        "unit_code": "per_field", "definition_authority": "p1.test", "time_role": "observation",
        "field_definitions": [{"field_code": "amount", "data_type": "decimal", "unit_code": "cny",
                               "measurement_nature": "stock", "time_role": "observation"}],
    }
    unknown = {"status": "unknown", "precision": "unknown", "earliest_utc": None,
               "latest_exclusive_utc": None, "source_timezone": "UTC"}
    rows = [
        {"business_key": "integer", "observation_time": unknown,
         "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "9" * 38}}},
        {"business_key": "fraction", "observation_time": unknown,
         "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "0.1"}}},
    ]
    issues = validate_payload({"payload": {"kind": "tabular_rows", "rows": rows}}, declaration)
    assert any(x["code"] == "COLUMN_PRECISION_UNSUPPORTED" for x in issues)


def test_recovery_intent_survives_permission_denial(tmp_path, monkeypatch):
    service, doc = make_service(tmp_path)
    original_submit = service.engine.submit
    def commit_then_lose(_doc):
        original_submit(_doc)
        raise RuntimeError("simulated lost return after commit")
    monkeypatch.setattr(service.engine, "submit", commit_then_lose)
    first = service.submit(doc)
    assert first["status"] == "publication_unknown"
    unknown = service.request_status(doc["request_identity"])
    assert unknown["state"] == "publication_unknown"
    assert unknown["publication_intent"] == "formal"
    assert unknown["snapshot_id"]
    monkeypatch.setattr(service.engine, "submit", original_submit)

    service.allowed_sources["fixture"]["may_submit"] = False
    denied = service.submit(doc)
    assert denied["status"] == "rejected"
    assert denied["errors"][0]["code"] == "SOURCE_NOT_ADMITTED"
    preserved = service.request_status(doc["request_identity"])
    assert preserved["state"] == "publication_unknown"
    assert preserved["publication_intent"] == "formal"
    assert preserved["snapshot_id"] == unknown["snapshot_id"]

    service.allowed_sources["fixture"]["may_submit"] = True
    recovered = service.submit(doc)
    assert recovered["status"] == "published_formal"
    assert recovered["idempotent_replay"] is True
    assert recovered["snapshot_id"] == unknown["snapshot_id"]
    assert service.request_status(doc["request_identity"])["state"] == "published_formal"


def test_compatible_field_addition_reuses_product_id_and_persists_units(tmp_path):
    service, doc = make_service(tmp_path)
    output = doc["outputs"][0]
    output["output_key"] = "stable_tabular"
    doc["source_bundle"]["source_roles"] = fixture_source_roles(doc["outputs"])
    output["new_definition_declaration"] = {
        "semantic_code": "p1.stable.tabular", "measurement_nature": "mixed_observation",
        "unit_code": "per_field", "definition_authority": "p1.test", "time_role": "observation",
        "field_definitions": [{"field_code": "amount", "data_type": "decimal", "unit_code": "vehicle",
                               "measurement_nature": "stock", "time_role": "observation"}],
    }
    output["payload"] = {"kind": "tabular_rows", "rows": [{
        "business_key": "row-1", "subject": output["subject"],
        "observation_time": known_time(2023),
        "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "1"}},
    }]}
    doc["source_bundle"]["product_service"] = {
        "version": "wfd.product-service/0.3",
        "outputs": {"stable_tabular": {"read_dependencies": []}},
    }
    first = service.submit(doc)
    assert first["status"] == "published_formal"
    first_pid, first_sid = first["output_results"][0]["product_id"], first["snapshot_id"]
    first_product = next(p for p in service.discover_products(snapshot_id=first_sid)["products"]
                         if p["product_id"] == first_pid)
    assert first_product["contracts"]["semantic"]["unit_definitions"]["vehicle"]["definition"]["dimension"] == "quantity"

    second_doc = copy.deepcopy(doc)
    second_doc["request_identity"]["request_id"] = "compatible-field-add"
    second_doc["expected_parent_snapshot_id"] = first_sid
    second_doc["outputs"][0]["new_definition_declaration"]["field_definitions"].append(
        {"field_code": "note", "data_type": "text", "unit_code": "not_applicable",
         "measurement_nature": "stock", "time_role": "observation"})
    second_doc["outputs"][0]["payload"]["rows"][0]["business_key"] = "row-2"
    second_doc["outputs"][0]["payload"]["rows"][0]["values"]["note"] = {
        "data_type": "text", "value_state": "valid_value", "value": "ok"}
    second = service.submit(second_doc)
    assert second["status"] == "published_formal"
    second_pid, second_sid = second["output_results"][0]["product_id"], second["snapshot_id"]
    assert second_pid == first_pid
    assert second["output_results"][0]["definition_ref"] != first["output_results"][0]["definition_ref"]
    old_rows = service.read(first_pid, snapshot_id=first_sid)["rows"]
    assert len(old_rows) == 1 and "note" not in old_rows[0]["row"]["values"]
    new_rows = service.read(second_pid, snapshot_id=second_sid)["rows"]
    new_row = next(item for item in new_rows if item["record_ref"]["logical_key"] == "row-2")
    old_row = next(item for item in new_rows if item["record_ref"]["logical_key"] == "row-1")
    assert new_row["row"]["values"]["note"]["value"] == "ok"
    assert "note" not in old_row["row"]["values"]

    # A fresh reader with no unit_registry still gets the fixed unit semantics
    # from the persisted semantic contract.
    reader = new_reader(tmp_path / "store", tmp_path / "reader2")
    fetched = next(p for p in reader.discover_products(snapshot_id=second_sid)["products"]
                   if p["product_id"] == second_pid)
    assert fetched["contracts"]["semantic"]["unit_definitions"]["vehicle"]["digest"].startswith("sha256:")


def test_source_read_and_evidence_permissions_are_enforced(tmp_path):
    service, doc = make_service(tmp_path)
    result = service.submit(doc)
    sid = result["snapshot_id"]
    pid = result["output_results"][0]["product_id"]
    reader = WFDProductService(
        service.engine,
        allowed_sources={"fixture": {"usage_scope": "test_only"}},
        caller_roles={"read", "read_evidence"}, caller_id="restricted-reader",
        unit_registry=UNIT_REGISTRY, trusted_actor_namespaces={"wfd.test.curated"},
    )
    with pytest.raises(PermissionError, match="SOURCE_READ_PERMISSION_MISSING:fixture"):
        reader.discover_products(snapshot_id=sid)
    with pytest.raises(PermissionError, match="SOURCE_READ_PERMISSION_MISSING:fixture"):
        reader.read(pid, snapshot_id=sid)
    with pytest.raises(PermissionError, match="SOURCE_READ_PERMISSION_MISSING:fixture"):
        reader.trace(pid, snapshot_id=sid)
    with pytest.raises(PermissionError, match="SOURCE_READ_PERMISSION_MISSING:fixture"):
        reader.company_view(doc["outputs"][0]["subject"], snapshot_id=sid)


def test_capabilities_match_actual_submit_validation(tmp_path):
    service, doc = make_service(tmp_path)
    caps = service.capabilities()
    assert caps["format_version"] == "wfd.product-capabilities/0.2"
    assert caps["ingest_protocol"] == "wfd.ingest/1.3-candidate"
    assert caps["structural_validation"]["enforced"] is True
    assert caps["structural_validation"]["schema"]["root_sha256"]
    assert caps["structural_validation"]["schema"]["references"]
    assert caps["structural_validation"]["schema"]["closure_sha256"]
    assert "source_bundle" in caps["operations"]["submit"]["required_fields"]
    assert any("read_dependencies" in item for item in
               caps["operations"]["submit"]["required_source_extensions"])
    assert "publication_pending_activation" in caps["operations"]["submit"]["request_states"]
    assert "partially_committed_pending_head" in caps["operations"]["submit"]["status_states"]
    assert "publication_unknown" in caps["operations"]["submit"]["recovery_actions"]
    broken = copy.deepcopy(doc)
    broken["request_identity"]["request_id"] = "capability-schema-check"
    broken.pop("source_bundle")
    result = service.submit(broken)
    assert result["status"] == "rejected"
    assert result["errors"][0]["code"] == "SCHEMA_INVALID"


def test_unpublished_draft_does_not_poison_published_identity(tmp_path):
    service, doc = make_service(tmp_path)
    foundation = service.submit(doc)
    dep_pid, s1 = foundation["output_results"][0]["product_id"], foundation["snapshot_id"]
    dependency = {"dataset_id": doc["request_identity"]["dataset_id"], "product_id": dep_pid,
                  "snapshot_id": s1, "role": "identity", "required": True}
    base = copy.deepcopy(doc)
    base["request_identity"]["request_id"] = "identity-v1"
    base["expected_parent_snapshot_id"] = s1
    output = base["outputs"][0]
    output["output_key"] = "identity_evolution"
    base["source_bundle"]["source_roles"] = fixture_source_roles(base["outputs"])
    output["new_definition_declaration"] = {
        "semantic_code": "p1.identity.evolution", "measurement_nature": "mixed_observation",
        "unit_code": "per_field", "definition_authority": "p1.test", "time_role": "observation",
        "field_definitions": [{"field_code": "amount", "data_type": "decimal", "unit_code": "vehicle",
                               "measurement_nature": "stock", "time_role": "observation"}],
    }
    output["payload"] = {"kind": "tabular_rows", "rows": [{
        "business_key": "row-1", "subject": output["subject"], "observation_time": known_time(2023),
        "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "1"}},
    }]}
    extension(base, read_dependencies=[dependency])
    v1 = service.submit(base)
    assert v1["status"] == "published_formal"
    v1_pid, v1_sid = v1["output_results"][0]["product_id"], v1["snapshot_id"]
    v1_product = next(p for p in service.discover_products(snapshot_id=v1_sid)["products"]
                      if p["product_id"] == v1_pid)

    draft = copy.deepcopy(base)
    draft["request_identity"]["request_id"] = "unpublished-draft"
    draft["expected_parent_snapshot_id"] = "s_missing_parent"
    draft["outputs"][0]["new_definition_declaration"]["field_definitions"].append(
        {"field_code": "draft_only", "data_type": "text", "unit_code": "not_applicable",
         "measurement_nature": "stock", "time_role": "observation"})
    draft["outputs"][0]["payload"]["rows"][0]["business_key"] = "row-draft"
    draft["outputs"][0]["payload"]["rows"][0]["values"]["draft_only"] = {
        "data_type": "text", "value_state": "valid_value", "value": "draft"}
    draft_result = service.submit(draft)
    assert draft_result["status"] == "registered_not_published"
    assert service.engine.head()["snapshot_id"] == v1_sid

    candidate = copy.deepcopy(base)
    candidate["request_identity"]["request_id"] = "compatible-after-draft-empty"
    candidate["expected_parent_snapshot_id"] = v1_sid
    candidate["outputs"][0]["new_definition_declaration"]["field_definitions"].append(
        {"field_code": "published_note", "data_type": "text", "unit_code": "not_applicable",
         "measurement_nature": "stock", "time_role": "observation"})
    candidate["outputs"][0]["payload"]["rows"][0]["business_key"] = "row-2"
    candidate["outputs"][0]["payload"]["rows"][0]["values"]["published_note"] = {
        "data_type": "text", "value_state": "valid_value", "value": "published"}
    extension(candidate, read_dependencies=[])
    omitted = service.submit(candidate)
    assert omitted["status"] == "registered_not_published"
    assert any(item.get("errors", [{}])[0].get("code") == "READ_DEPENDENCY_ROLE_MISSING"
               for item in omitted["output_results"])

    candidate2 = copy.deepcopy(candidate)
    candidate2["request_identity"]["request_id"] = "compatible-after-draft-with-dep"
    extension(candidate2, read_dependencies=[dependency])
    published = service.submit(candidate2)
    assert published["status"] == "published_formal"
    published_pid, published_sid = published["output_results"][0]["product_id"], published["snapshot_id"]
    assert published_pid == v1_pid
    new_product = next(p for p in service.discover_products(snapshot_id=published_sid)["products"]
                       if p["product_id"] == published_pid and p.get("definition_sequence", 1) > 1)
    assert new_product["definition_parent_ref"] == v1_product["definition_ref"]


def test_changed_unit_semantics_requires_new_definition_or_rejects(tmp_path):
    service, doc = make_service(tmp_path)
    doc["outputs"][0]["new_definition_declaration"]["unit_code"] = "cny"
    cny = {"cny": {"dimension": "money", "currency": "CNY", "multiplier": "10000",
                   "base_unit": "CNY", "version": "1", "authority": "p1.test"}}
    first_service = WFDProductService(
        service.engine, allowed_sources={"fixture": dict(SOURCE_POLICY)},
        caller_roles=ALL_ROLES, caller_id="unit-v1", unit_registry=cny,
        trusted_actor_namespaces={"wfd.test.curated"},
    )
    first = first_service.submit(doc)
    assert first["status"] == "published_formal"
    sid = first["snapshot_id"]
    old_units = next(p for p in first_service.discover_products(snapshot_id=sid)["products"]
                     if p["product_id"] == first["output_results"][0]["product_id"])["contracts"]["semantic"]["unit_definitions"]
    assert old_units["cny"]["definition"]["currency"] == "CNY"

    usd = {"cny": {"dimension": "money", "currency": "USD", "multiplier": "1",
                   "base_unit": "USD", "version": "2", "authority": "p1.test"}}
    second_doc = copy.deepcopy(doc)
    second_doc["request_identity"]["request_id"] = "unit-change"
    second_doc["expected_parent_snapshot_id"] = sid
    second_service = WFDProductService(
        service.engine, allowed_sources={"fixture": dict(SOURCE_POLICY)},
        caller_roles=ALL_ROLES, caller_id="unit-v2", unit_registry=usd,
        trusted_actor_namespaces={"wfd.test.curated"},
    )
    second = second_service.submit(second_doc)
    assert second["status"] == "rejected"
    assert second["output_results"][0]["errors"][0]["code"] == "UNIT_SEMANTIC_CONFLICT"
    # The published fixed binding still explains the old unit.
    fixed = next(p for p in second_service.discover_products(snapshot_id=sid)["products"]
                 if p["product_id"] == first["output_results"][0]["product_id"])
    assert fixed["contracts"]["semantic"]["unit_definitions"]["cny"]["definition"]["currency"] == "CNY"


def test_public_reads_hide_source_paths_and_raw_originals(tmp_path):
    service, doc = make_service(tmp_path)
    unit_registry = {"vehicle": {"dimension": "quantity", "source_path": "/secret/unit",
                                 "raw_original_text": "RAW UNIT"}}
    writer = WFDProductService(
        service.engine, allowed_sources={"fixture": dict(SOURCE_POLICY)},
        caller_roles=ALL_ROLES, caller_id="writer", unit_registry=unit_registry,
        trusted_actor_namespaces={"wfd.test.curated"},
    )
    doc["source_bundle"]["original_path"] = "/secret/source.parquet"
    doc["source_bundle"]["raw_original_text"] = "RAW SECRET"
    doc["outputs"][0]["evidence_refs"][0]["locator_generation"] = "/secret/locator.parquet"
    first = writer.submit(doc)
    assert first["status"] == "published_formal"
    sid, pid = first["snapshot_id"], first["output_results"][0]["product_id"]
    reader = WFDProductService(
        service.engine,
        allowed_sources={"fixture": {"may_read": True, "may_read_evidence": False,
                                     "usage_scope": "local_use"}},
        caller_roles={"read", "read_evidence"}, caller_id="data-only",
        unit_registry=unit_registry, trusted_actor_namespaces={"wfd.test.curated"},
    )
    outputs = [reader.read(pid, snapshot_id=sid),
               reader.discover_products(snapshot_id=sid),
               reader.company_view(doc["outputs"][0]["subject"], snapshot_id=sid)]
    text = repr(outputs)
    assert "/secret/source.parquet" not in text
    assert "RAW SECRET" not in text
    assert "/secret/unit" not in text
    assert "RAW UNIT" not in text
    assert "/secret/locator.parquet" not in text
    for output in outputs:
        projection = output["public_projection"]
        assert projection["source_paths"] == "omitted"
        assert projection["raw_original_text"] == "omitted"
        assert projection["contract_bodies"] == "partial"
        assert projection["complete_contract_bodies"] is False
        for product in output["products"]:
            entry = next(item for item in projection["contract_projections"]
                         if item["product_id"] == product["product_id"])
            assert entry["original_contract_ref"] == product["contract_ref"]
            assert entry["projection_digest"] == "sha256:" + sha(canonical(product))
            assert entry["complete_contract_body"] is False
    with pytest.raises(PermissionError, match="SOURCE_READ_PERMISSION_MISSING:fixture"):
        reader.trace(pid, snapshot_id=sid)


def test_unrelated_source_scope_does_not_block_authorized_product(tmp_path):
    service, doc = make_service(tmp_path)
    first = service.submit(doc)
    assert first["status"] == "published_formal"
    sid_a, pid_a = first["snapshot_id"], first["output_results"][0]["product_id"]
    other_policy = dict(SOURCE_POLICY)
    other_policy["usage_scope"] = "other_local_use"
    writer = WFDProductService(
        service.engine, allowed_sources={"fixture": dict(SOURCE_POLICY), "other": other_policy},
        caller_roles=ALL_ROLES, caller_id="writer", unit_registry=UNIT_REGISTRY,
        trusted_actor_namespaces={"wfd.test.curated"},
    )
    second = copy.deepcopy(doc)
    second["request_identity"]["request_id"] = "other-product"
    second["expected_parent_snapshot_id"] = sid_a
    second["source_bundle"]["source_id"] = "other"
    second["source_bundle"]["source_ids"] = ["other"]
    second["source_bundle"]["usage_scope"] = "other_local_use"
    second["outputs"][0]["output_key"] = "other_output"
    second["source_bundle"]["source_roles"] = fixture_source_roles(second["outputs"], "other")
    second["outputs"][0]["subject"] = {"id": "port_of_long_beach", "kind": "physical_object",
                                      "namespace": "us.port.official"}
    second["outputs"][0]["new_definition_declaration"]["semantic_code"] = "audit.other.product"
    second["outputs"][0]["payload"]["rows"][0]["business_key"] = "other_row"
    extension(second, read_dependencies=[])
    other = writer.submit(second)
    assert other["status"] == "published_formal"
    head = other["snapshot_id"]

    reader = WFDProductService(
        service.engine, allowed_sources={"fixture": dict(SOURCE_POLICY)},
        caller_roles={"read", "read_evidence"}, caller_id="fixture-only",
        unit_registry=UNIT_REGISTRY, trusted_actor_namespaces={"wfd.test.curated"},
    )
    assert reader.read(pid_a, snapshot_id=head)["source_ids"] == ["fixture"]
    filtered = reader.discover_products(snapshot_id=head, subject=doc["outputs"][0]["subject"])
    assert [p["product_id"] for p in filtered["products"]] == [pid_a]
    assert filtered["source_ids"] == ["fixture"]
    company = reader.company_view(doc["outputs"][0]["subject"], snapshot_id=head)
    assert company["source_ids"] == ["fixture"]
    assert "source_ids_by_product" not in company
    assert "source_ids_by_product" not in reader.read(pid_a, snapshot_id=head)
    assert "source_ids_by_product" not in filtered
    assert "other" not in repr(company)
