"""P3a update semantics and consistency-group checks."""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from test_product_service import ALL_ROLES, SOURCE_POLICY, UNIT_REGISTRY, extension, known_time, make_service
from wfd_sdk.product_service import WFDProductService


def _tabular_doc(tmp_path):
    service, doc = make_service(tmp_path)
    output = doc["outputs"][0]
    output["output_key"] = "p3_tabular"
    output["new_definition_declaration"] = {
        "semantic_code": "p3.update.tabular", "measurement_nature": "mixed_observation",
        "unit_code": "per_field", "definition_authority": "p3.test", "time_role": "observation",
        "field_definitions": [{"field_code": "amount", "data_type": "decimal", "unit_code": "vehicle",
                               "measurement_nature": "stock", "time_role": "observation"}],
    }
    output["payload"] = {"kind": "tabular_rows", "rows": [
        {"business_key": "row-1", "subject": output["subject"], "observation_time": known_time(2023),
         "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "1"}}},
        {"business_key": "row-2", "subject": output["subject"], "observation_time": known_time(2023),
         "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "2"}}},
    ]}
    output["coverage"] = {"scope": {"product": "p3.update.tabular"}, "basis": "declared_full",
                          "completeness": "complete", "coverage_evidence": [],
                          "absence_means": "explicitly_absent"}
    doc["source_bundle"]["source_roles"] = {"p3_tabular": [
        {"source_id": "fixture", "roles": ["definer", "first_publisher", "deliverer"]}]}
    extension(doc, read_dependencies=[])
    first = service.submit(doc)
    assert first["status"] == "published_formal", first
    return service, doc, first["snapshot_id"], first["output_results"][0]["product_id"]


def _next(doc, sid, request_id):
    result = copy.deepcopy(doc)
    result["request_identity"]["request_id"] = request_id
    result["expected_parent_snapshot_id"] = sid
    extension(result, read_dependencies=[])
    return result


def test_complete_partial_incremental_and_coverage_revision(tmp_path):
    service, doc, s1, pid = _tabular_doc(tmp_path)
    old_rows = service.read(pid, snapshot_id=s1)["rows"]
    assert len(old_rows) == 2

    complete = _next(doc, s1, "complete-replace")
    complete["outputs"][0]["input_mode"] = "complete_snapshot"
    complete["outputs"][0]["payload"]["rows"] = [{
        "business_key": "row-1", "subject": doc["outputs"][0]["subject"],
        "observation_time": known_time(2023),
        "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "9"}},
    }]
    complete["outputs"][0]["coverage"]["completeness"] = "complete"
    complete["outputs"][0]["coverage"]["absence_means"] = "explicitly_absent"
    cresult = service.submit(complete)
    assert cresult["status"] == "published_formal", cresult
    s2 = cresult["snapshot_id"]
    new_rows = service.read(pid, snapshot_id=s2)["rows"]
    assert len(new_rows) == 1 and new_rows[0]["row"]["values"]["amount"]["value"] == "9"
    assert len(service.read(pid, snapshot_id=s1)["rows"]) == 2

    partial = _next(doc, s2, "partial-add")
    partial["outputs"][0]["input_mode"] = "partial_observation"
    partial["outputs"][0]["coverage"]["basis"] = "observed_partial"
    partial["outputs"][0]["coverage"]["completeness"] = "partial"
    partial["outputs"][0]["coverage"]["absence_means"] = "unknown"
    partial["outputs"][0]["payload"]["rows"] = [{
        "business_key": "row-3", "subject": doc["outputs"][0]["subject"],
        "observation_time": known_time(2023),
        "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "3"}},
    }]
    presult = service.submit(partial)
    assert presult["status"] == "published_formal", presult
    s3 = presult["snapshot_id"]
    assert {r["record_ref"]["logical_key"] for r in service.read(pid, snapshot_id=s3)["rows"]} == {"row-1", "row-3"}

    incremental = _next(doc, s3, "incremental-add")
    incremental["outputs"][0]["input_mode"] = "explicit_increment"
    incremental["outputs"][0]["coverage"]["basis"] = "explicit_incremental"
    incremental["outputs"][0]["coverage"]["completeness"] = "partial"
    incremental["outputs"][0]["payload"]["rows"] = [{
        "business_key": "row-4", "subject": doc["outputs"][0]["subject"],
        "observation_time": known_time(2023),
        "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "4"}},
    }]
    iresult = service.submit(incremental)
    assert iresult["status"] == "published_formal", iresult
    s4 = iresult["snapshot_id"]
    assert len(service.read(pid, snapshot_id=s4)["rows"]) == 3

def test_consistency_group_failure_does_not_publish_members(tmp_path):
    service, doc, s1, pid = _tabular_doc(tmp_path)
    second = _next(doc, s1, "group-two")
    second["outputs"][0]["payload"]["rows"] = [{
        "business_key": "row-group", "subject": doc["outputs"][0]["subject"],
        "observation_time": known_time(2023),
        "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "8"}},
    }]
    second["outputs"].append(copy.deepcopy(second["outputs"][0]))
    second["outputs"][1]["output_key"] = "p3_bad"
    second["outputs"][1]["new_definition_declaration"]["unit_code"] = "unknown_unit"
    second["outputs"][1]["payload"]["rows"][0]["business_key"] = "bad-row"
    second["source_bundle"]["source_roles"]["p3_bad"] = [
        {"source_id": "fixture", "roles": ["definer"]}]
    second["source_bundle"]["product_service"]["outputs"]["p3_bad"] = {"read_dependencies": []}
    second["source_bundle"]["product_service"]["consistency_groups"] = {"g1": ["p3_tabular", "p3_bad"]}
    result = service.submit(second)
    assert result["status"] != "published_formal"
    assert service.engine.head()["snapshot_id"] == s1
    assert all(item.get("publication_state") == "not_published" for item in result["output_results"])
    assert any(item.get("errors", [{}])[0].get("code") == "CONSISTENCY_GROUP_FAILED"
               for item in result["output_results"])

    independent = _next(doc, s1, "independent-after-group")
    independent["outputs"][0]["output_key"] = "p3_independent"
    independent["outputs"][0]["new_definition_declaration"]["semantic_code"] = "p3.update.independent"
    independent["outputs"][0]["payload"]["rows"] = [{
        "business_key": "row-independent", "subject": doc["outputs"][0]["subject"],
        "observation_time": known_time(2023),
        "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "7"}},
    }]
    independent["source_bundle"]["source_roles"] = {"p3_independent": [
        {"source_id": "fixture", "roles": ["definer"]}]}
    extension(independent, read_dependencies=[])
    ok = service.submit(independent)
    assert ok["status"] == "published_formal", ok
    assert service.engine.head()["snapshot_id"] != s1


def test_source_roles_are_selected_per_output(tmp_path):
    service, _ = make_service(tmp_path)
    policies = [("a", {"usage_scope": "local_use", "allowed_roles": ["definer", "first_publisher", "deliverer"]}),
                ("b", {"usage_scope": "local_use", "allowed_roles": ["definer", "first_publisher", "deliverer"]})]
    source = {"source_ids": ["a", "b"], "source_roles": {
        "out_a": [{"source_id": "a", "roles": ["definer", "first_publisher"]}],
        "out_b": [{"source_id": "b", "roles": ["deliverer"]}],
    }}
    a, mode_a = service._output_policies(source, "out_a", policies)
    b, mode_b = service._output_policies(source, "out_b", policies)
    assert [sid for sid, _ in a] == ["a"] and mode_a == "explicit"
    assert [sid for sid, _ in b] == ["b"] and mode_b == "explicit"
    with pytest.raises(ValueError):
        service._output_policies(source, "out_missing", policies)


def test_engine_business_failure_propagates_to_whole_group(tmp_path):
    service, doc, s1, _ = _tabular_doc(tmp_path)
    request = _next(doc, s1, "engine-group-failure")
    request["outputs"][0]["payload"]["rows"] = [{
        "business_key": "row-a", "subject": doc["outputs"][0]["subject"],
        "observation_time": known_time(2023),
        "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "1"}},
    }]
    bad = copy.deepcopy(request["outputs"][0])
    bad["output_key"] = "p3_negative"
    bad["new_definition_declaration"] = {
        "semantic_code": "p3.update.negative", "measurement_nature": "stock",
        "unit_code": "per_field", "definition_authority": "p3.test", "time_role": "observation",
        "field_definitions": [{"field_code": "vehicle_count", "data_type": "decimal",
                               "unit_code": "vehicle", "measurement_nature": "stock",
                               "time_role": "observation"}],
    }
    bad["payload"] = {"kind": "tabular_rows", "rows": [{
        "business_key": "bad", "subject": doc["outputs"][0]["subject"],
        "observation_time": known_time(2023),
        "values": {"vehicle_count": {"data_type": "decimal", "value_state": "valid_value", "value": "-1"}},
    }]}
    request["outputs"].append(bad)
    request["source_bundle"]["source_roles"]["p3_negative"] = [
        {"source_id": "fixture", "roles": ["definer"]}]
    request["source_bundle"]["product_service"]["outputs"]["p3_negative"] = {"read_dependencies": []}
    request["source_bundle"]["product_service"]["consistency_groups"] = {
        "g": ["p3_tabular", "p3_negative"]}
    result = service.submit(request)
    assert result["status"] != "published_formal"
    assert service.engine.head()["snapshot_id"] == s1
    assert all(item["publication_state"] == "not_published" for item in result["output_results"])
    assert any(item.get("errors", [{}])[0].get("code") == "CONSISTENCY_GROUP_FAILED"
               for item in result["output_results"])


def test_complete_snapshot_honors_declared_business_key_scope(tmp_path):
    service, doc, s1, pid = _tabular_doc(tmp_path)
    scoped = _next(doc, s1, "scoped-complete")
    scoped["outputs"][0]["input_mode"] = "complete_snapshot"
    scoped["outputs"][0]["coverage"]["scope"]["business_keys"] = ["row-1"]
    scoped["outputs"][0]["payload"]["rows"] = [{
        "business_key": "row-1", "subject": doc["outputs"][0]["subject"],
        "observation_time": known_time(2023),
        "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "9"}},
    }]
    result = service.submit(scoped)
    assert result["status"] == "published_formal", result
    rows = {r["record_ref"]["logical_key"]: r["row"]["values"]["amount"]["value"]
            for r in service.read(pid, snapshot_id=result["snapshot_id"])["rows"]}
    assert rows == {"row-1": "9", "row-2": "2"}


def test_trusted_source_policy_can_restrict_roles(tmp_path):
    service, _ = make_service(tmp_path)
    policies = [("a", {"usage_scope": "local_use", "allowed_roles": ["deliverer"]})]
    source = {"source_ids": ["a"], "source_roles": {
        "out": [{"source_id": "a", "roles": ["definer"]}]}}
    with pytest.raises(ValueError, match="SOURCE_ROLE_DENIED:a"):
        service._output_policies(source, "out", policies)


def test_formal_eligibility_is_per_output_not_global(tmp_path):
    service, doc, s1, pid = _tabular_doc(tmp_path)
    b_policy = dict(SOURCE_POLICY)
    b_policy.update(may_publish_formal=False, usage_scope="local_use_b")
    service.allowed_sources["b"] = b_policy
    request = _next(doc, s1, "mixed-formal")
    request["source_bundle"]["source_ids"] = ["fixture", "b"]
    request["source_bundle"]["source_roles"]["p3_tabular"] = [
        {"source_id": "fixture", "roles": ["definer", "deliverer"]}]
    request["outputs"][0]["payload"]["rows"] = [{
        "business_key": "row-mixed-a", "subject": doc["outputs"][0]["subject"],
        "observation_time": known_time(2023),
        "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "5"}},
    }]
    b = copy.deepcopy(request["outputs"][0])
    b["output_key"] = "p3_b"
    b["subject"] = {"id": "port_b", "kind": "physical_object", "namespace": "us.port.official"}
    b["new_definition_declaration"]["semantic_code"] = "p3.update.b"
    b["payload"]["rows"][0]["business_key"] = "row-mixed-b"
    b["payload"]["rows"][0]["subject"] = b["subject"]
    request["outputs"].append(b)
    request["source_bundle"]["source_roles"]["p3_b"] = [
        {"source_id": "b", "roles": ["definer", "deliverer"]}]
    request["source_bundle"]["product_service"]["outputs"]["p3_b"] = {"read_dependencies": []}
    result = service.submit(request)
    assert result["status"] == "partially_published_formal", result
    states = {item["output_key"]: item["publication_state"] for item in result["output_results"]}
    assert states["p3_tabular"] == "published_formal"
    assert states["p3_b"] == "published_sandbox"


def test_resume_uses_fixed_per_output_admission(tmp_path, monkeypatch):
    service, doc, s1, _ = _tabular_doc(tmp_path)
    service.allowed_sources["unused"] = {"may_submit": True, "may_read": True,
                                         "usage_scope": "unused", "allowed_domains": ["relations"]}
    doc = _next(doc, s1, "resume-per-output")
    doc["outputs"][0]["payload"]["rows"] = [{
        "business_key": "row-resume", "subject": doc["outputs"][0]["subject"],
        "observation_time": known_time(2023),
        "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "6"}},
    }]
    doc["source_bundle"]["source_ids"] = ["fixture", "unused"]
    # source_roles remains only the actual fixture output role.
    original = service.engine.state.activate
    monkeypatch.setattr(service.engine.state, "activate",
                        lambda *a, **k: {"ok": False, "detail": "targeted activation failure"})
    first = service.submit(doc)
    assert first["status"] == "published_commit_pending_head"
    monkeypatch.setattr(service.engine.state, "activate", original)
    sid = first["snapshot_id"]
    assert original(sid, service.root / f"catalog/snapshots/{sid}.json",
                    expected_prev=s1, writer_host="test")["ok"]
    retry = service.submit(doc)
    assert retry["status"] == "published_formal", retry


def test_missing_allowed_roles_does_not_grant_new_roles(tmp_path):
    service, doc = make_service(tmp_path)
    service.allowed_sources["fixture"]["allowed_roles"] = []
    result = service.submit(doc)
    assert result["status"] == "rejected"
    assert result["output_results"][0]["errors"][0]["code"] == "SOURCE_ROLE_DENIED"
    assert result.get("snapshot_id") is None


def test_arbitrary_definition_authority_is_denied(tmp_path):
    service, doc = make_service(tmp_path)
    service.allowed_sources["fixture"]["allowed_authorities"] = ["portoflosangeles.official"]
    doc["outputs"][0]["new_definition_declaration"]["definition_authority"] = "unrelated.authority.no.trusted.binding"
    result = service.submit(doc)
    assert result["status"] == "rejected"
    assert result["output_results"][0]["errors"][0]["code"] == "SOURCE_AUTHORITY_DENIED"
    assert result.get("snapshot_id") is None


def test_pending_role_revocation_preserves_original_facts(tmp_path, monkeypatch):
    service, doc, s1, _ = _tabular_doc(tmp_path)
    request = _next(doc, s1, "pending-role-revocation")
    request["outputs"][0]["payload"]["rows"] = [{
        "business_key": "row-role-resume", "subject": doc["outputs"][0]["subject"],
        "observation_time": known_time(2023),
        "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "8"}},
    }]
    original = service.engine.state.activate
    monkeypatch.setattr(service.engine.state, "activate",
                        lambda *a, **k: {"ok": False, "detail": "targeted activation failure"})
    first = service.submit(request)
    assert first["status"] == "published_commit_pending_head"
    original_status = service.request_status(request["request_identity"])
    assert original_status["state"] == "publication_pending_activation"
    assert original_status["snapshot_id"] == first["snapshot_id"]
    assert original_status["publication_intent"] == "formal"

    service.allowed_sources["fixture"]["allowed_roles"] = ["deliverer"]
    retry = service.submit(request)
    assert retry["status"] == "rejected"
    assert retry["errors"][0]["code"] == "SOURCE_ROLE_DENIED"
    preserved = service.request_status(request["request_identity"])
    assert preserved["state"] == "publication_pending_activation"
    assert preserved["snapshot_id"] == original_status["snapshot_id"]
    assert preserved["publication_intent"] == "formal"
    assert preserved["last_attempt"]["code"] == "SOURCE_ROLE_DENIED"


def test_reuse_authority_is_checked_against_resolved_product(tmp_path):
    service, doc = make_service(tmp_path)
    first = service.submit(doc)
    assert first["status"] == "published_formal"
    sid = first["snapshot_id"]
    published = first["output_results"][0]
    reuse = _next(doc, sid, "reuse-authority-revoked")
    reuse["outputs"][0]["definition_mode"] = "reuse"
    reuse["outputs"][0]["definition_ref"] = published["definition_ref"]
    reuse["outputs"][0]["new_definition_declaration"] = None
    reuse["outputs"][0]["payload"]["rows"][0]["business_key"] = "reuse-new-key"
    service.allowed_sources["fixture"]["allowed_authorities"] = ["unrelated.other_namespace"]
    result = service.submit(reuse)
    assert result["status"] in {"rejected", "registered_not_published"}
    assert result["output_results"][0]["errors"][0]["code"] == "SOURCE_AUTHORITY_DENIED"
    assert result.get("snapshot_id") is None


def test_coverage_metadata_only_snapshot_keeps_business_rows(tmp_path):
    service, doc, s1, pid = _tabular_doc(tmp_path)
    old = service.read(pid, snapshot_id=s1)
    old_refs = {r["record_ref"]["revision_id"] for r in old["rows"]}
    old_product = service.discover_products(snapshot_id=s1)["products"][0]
    old_coverage = old_product["coverage"]
    snapshot_before = service.engine.read_snapshot(s1)
    files_before = sorted((f["file_relpath"], f["file_sha256"]) for f in snapshot_before["files"])

    update = _next(doc, s1, "coverage-metadata-only")
    update["outputs"][0]["output_key"] = "coverage_update"
    update["source_bundle"]["source_roles"]["coverage_update"] = [
        {"source_id": "fixture", "roles": ["definer", "first_publisher", "deliverer"]}]
    update["source_bundle"]["product_service"]["outputs"] = {"coverage_update": {"read_dependencies": []}}
    update["outputs"][0]["input_mode"] = "coverage_revision"
    update["outputs"][0]["definition_mode"] = "reuse"
    update["outputs"][0]["definition_ref"] = old_product["definition_ref"]
    update["outputs"][0]["new_definition_declaration"] = None
    update["outputs"][0]["payload"] = {"kind": "metadata_revision"}
    update["outputs"][0]["coverage"] = {
        "scope": {"product": "p3.update.tabular", "note": "metadata-only update"},
        "basis": "declared_full", "completeness": "complete",
        "coverage_evidence": [], "absence_means": "explicitly_absent",
        "predecessor_ref": old_product["coverage_ref"],
    }
    result = service.submit(update)
    assert result["status"] == "published_formal", result
    s2 = result["snapshot_id"]
    assert s2 != s1
    snapshot_after = service.engine.read_snapshot(s2)
    files_after = sorted((f["file_relpath"], f["file_sha256"]) for f in snapshot_after["files"])
    assert files_before == files_after
    metadata_entry = snapshot_after["metadata_versions"][0]
    assert metadata_entry["coverage_ref"] != old_product["coverage_ref"]
    assert metadata_entry["definition_ref"] == old_product["definition_ref"]
    assert metadata_entry["source_admission"]["source_ids"] == ["fixture"]
    new = service.read(pid, snapshot_id=s2)
    assert {r["record_ref"]["revision_id"] for r in new["rows"]} == old_refs
    assert service.discover_products(snapshot_id=s1)["products"][0]["coverage"] == old_coverage
    new_product = service.discover_products(snapshot_id=s2)["products"][0]
    assert new_product["coverage"]["scope"]["note"] == "metadata-only update"
    assert new_product["coverage_ref"] != old_product["coverage_ref"]
    assert service.submit(update)["snapshot_id"] == s2

    head = service.engine.head()["snapshot_id"]
    bad = copy.deepcopy(update)
    bad["request_identity"]["request_id"] = "bad-coverage-predecessor"
    bad["outputs"][0]["coverage"]["predecessor_ref"] = "sha256:" + "0" * 64
    bad["outputs"][0]["coverage"]["scope"]["note"] = "bad predecessor"
    bad_result = service.submit(bad)
    assert bad_result["status"] != "published_formal"
    assert service.engine.head()["snapshot_id"] == head


def test_coverage_metadata_lost_return_recovers_same_snapshot(tmp_path, monkeypatch):
    service, doc, s1, pid = _tabular_doc(tmp_path)
    product = service.discover_products(snapshot_id=s1)["products"][0]
    update = _next(doc, s1, "coverage-lost-return")
    update["outputs"][0]["input_mode"] = "coverage_revision"
    update["outputs"][0]["definition_mode"] = "reuse"
    update["outputs"][0]["definition_ref"] = product["definition_ref"]
    update["outputs"][0]["new_definition_declaration"] = None
    update["outputs"][0]["payload"] = {"kind": "metadata_revision"}
    update["outputs"][0]["coverage"] = {
        "scope": {"product": "p3.update.tabular", "note": "lost-return metadata"},
        "basis": "declared_full", "completeness": "complete",
        "coverage_evidence": [], "absence_means": "explicitly_absent",
        "predecessor_ref": product["coverage_ref"],
    }
    original_submit = service.engine.submit
    def commit_then_lose(doc_arg):
        original_submit(doc_arg)
        raise RuntimeError("lost coverage metadata return")
    monkeypatch.setattr(service.engine, "submit", commit_then_lose)
    first = service.submit(update)
    assert first["status"] == "publication_unknown"
    recovered_sid = service.request_status(update["request_identity"])["snapshot_id"]
    assert recovered_sid
    monkeypatch.setattr(service.engine, "submit", original_submit)
    retry = service.submit(update)
    assert retry["status"] == "published_formal"
    assert retry["snapshot_id"] == recovered_sid
    assert service.engine.read_snapshot(recovered_sid)["files"] == service.engine.read_snapshot(s1)["files"]


def test_metadata_survives_later_unrelated_product_snapshot(tmp_path):
    service, doc, s1, pid = _tabular_doc(tmp_path)
    old_product = service.discover_products(snapshot_id=s1)["products"][0]
    update = _next(doc, s1, "metadata-before-unrelated")
    update["outputs"][0]["input_mode"] = "coverage_revision"
    update["outputs"][0]["definition_mode"] = "reuse"
    update["outputs"][0]["definition_ref"] = old_product["definition_ref"]
    update["outputs"][0]["new_definition_declaration"] = None
    update["outputs"][0]["payload"] = {"kind": "metadata_revision"}
    update["outputs"][0]["coverage"] = {
        "scope": {"product": "p3.update.tabular", "note": "survives-later"},
        "basis": "declared_full", "completeness": "complete",
        "coverage_evidence": [], "absence_means": "explicitly_absent",
        "predecessor_ref": old_product["coverage_ref"],
    }
    first = service.submit(update)
    assert first["status"] == "published_formal"
    s2 = first["snapshot_id"]

    unrelated = _next(doc, s2, "unrelated-after-metadata")
    unrelated["outputs"][0]["output_key"] = "p3_unrelated"
    unrelated["outputs"][0]["new_definition_declaration"]["semantic_code"] = "p3.update.unrelated"
    unrelated["outputs"][0]["subject"] = {"id": "unrelated_subject", "kind": "physical_object",
                                          "namespace": "test"}
    unrelated["outputs"][0]["payload"]["rows"] = [{
        "business_key": "unrelated-row", "subject": unrelated["outputs"][0]["subject"],
        "observation_time": known_time(2023),
        "values": {"amount": {"data_type": "decimal", "value_state": "valid_value", "value": "1"}},
    }]
    unrelated["source_bundle"]["source_roles"] = {"p3_unrelated": [
        {"source_id": "fixture", "roles": ["definer", "deliverer"]}]}
    unrelated["source_bundle"]["product_service"]["outputs"] = {"p3_unrelated": {"read_dependencies": []}}
    other = service.submit(unrelated)
    assert other["status"] == "published_formal", other
    s3 = other["snapshot_id"]
    assert len(service.engine.read_snapshot(s3)["metadata_versions"]) == 1
    product = service.discover_products(snapshot_id=s3)["products"][0]
    assert product["coverage"]["scope"]["note"] == "survives-later"
    assert service.read(pid, snapshot_id=s3)["snapshot_id"] == s3


def test_metadata_source_permission_governs_public_read(tmp_path):
    service, doc, s1, pid = _tabular_doc(tmp_path)
    service.allowed_sources["meta"] = {
        "may_submit": True, "may_publish_formal": True, "may_read": False,
        "may_read_evidence": False, "usage_scope": "restricted_meta",
        "allowed_roles": ["definer", "deliverer"],
        "allowed_authorities": ["p3.test"],
    }
    product = service.discover_products(snapshot_id=s1)["products"][0]
    update = _next(doc, s1, "metadata-restricted-source")
    update["source_bundle"]["source_ids"] = ["meta"]
    update["source_bundle"]["source_roles"] = {"p3_tabular": [
        {"source_id": "meta", "roles": ["definer", "deliverer"]}]}
    update["outputs"][0]["input_mode"] = "coverage_revision"
    update["outputs"][0]["definition_mode"] = "reuse"
    update["outputs"][0]["definition_ref"] = product["definition_ref"]
    update["outputs"][0]["new_definition_declaration"] = None
    update["outputs"][0]["payload"] = {"kind": "metadata_revision"}
    update["outputs"][0]["coverage"] = {
        "scope": {"product": "p3.update.tabular", "note": "restricted-metadata"},
        "basis": "declared_full", "completeness": "complete",
        "coverage_evidence": [], "absence_means": "explicitly_absent",
        "predecessor_ref": product["coverage_ref"],
    }
    result = service.submit(update)
    assert result["status"] == "published_formal", result
    sid = result["snapshot_id"]
    reader = WFDProductService(
        service.engine, allowed_sources={"fixture": dict(SOURCE_POLICY)},
        caller_roles={"read", "read_evidence"}, caller_id="fixture-only",
        unit_registry=UNIT_REGISTRY, trusted_actor_namespaces={"wfd.test.curated"},
    )
    with pytest.raises(PermissionError, match="SOURCE_READ_PERMISSION_MISSING:meta"):
        reader.read(pid, snapshot_id=sid)

    service.allowed_sources["meta"]["may_read"] = True
    service.allowed_sources["meta"]["may_read_evidence"] = True
    service.allowed_sources["fixture"]["may_read"] = False
    mixed = WFDProductService(
        service.engine, allowed_sources={"fixture": dict(service.allowed_sources["fixture"]),
                                          "meta": dict(service.allowed_sources["meta"])},
        caller_roles={"read", "read_evidence"}, caller_id="mixed-reader",
        unit_registry=UNIT_REGISTRY, trusted_actor_namespaces={"wfd.test.curated"},
    )
    with pytest.raises(PermissionError, match="SOURCE_READ_PERMISSION_MISSING:fixture"):
        mixed.read(pid, snapshot_id=sid)
    service.allowed_sources["fixture"]["may_read"] = True
    mixed.allowed_sources["fixture"]["may_read"] = True
    result_read = mixed.read(pid, snapshot_id=sid)
    assert result_read["source_ids"] == ["fixture", "meta"]
    assert len(result_read["rows"]) == 2


def test_future_metadata_is_not_selected_for_earlier_perspective(tmp_path):
    service, doc, s1, pid = _tabular_doc(tmp_path)
    product = service.discover_products(snapshot_id=s1)["products"][0]
    update = _next(doc, s1, "future-metadata")
    update["source_bundle"]["public_time"] = {
        "status": "known", "precision": "year", "earliest_utc": "2030-01-01T00:00:00Z",
        "latest_exclusive_utc": "2031-01-01T00:00:00Z", "source_timezone": "UTC"}
    update["outputs"][0]["input_mode"] = "coverage_revision"
    update["outputs"][0]["definition_mode"] = "reuse"
    update["outputs"][0]["definition_ref"] = product["definition_ref"]
    update["outputs"][0]["new_definition_declaration"] = None
    update["outputs"][0]["payload"] = {"kind": "metadata_revision"}
    update["outputs"][0]["coverage"] = {
        "scope": {"product": "p3.update.tabular", "note": "future-2030"},
        "basis": "declared_full", "completeness": "complete",
        "coverage_evidence": [], "absence_means": "explicitly_absent",
        "predecessor_ref": product["coverage_ref"],
    }
    result = service.submit(update)
    assert result["status"] == "published_formal", result
    snapshot = service.engine.read_snapshot(result["snapshot_id"])
    assert service._select_metadata(snapshot, pid, "market_known_at", "2025-06-01T00:00:00Z") is None
    selected = service._select_metadata(snapshot, pid, "market_known_at", "2031-06-01T00:00:00Z")
    assert selected["coverage"]["scope"]["note"] == "future-2030"
