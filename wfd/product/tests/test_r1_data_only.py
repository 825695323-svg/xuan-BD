"""R1 data-only structured ingress: no source/evidence/lineage persistence."""
from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path

import pytest

from test_product_service import ALL_ROLES, HERE, UNIT_REGISTRY
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator, rows_from_parquet
from wfd_sdk.product_data_service import (
    DATA_ONLY_PROTOCOL, WFDDataOnlyService, FORBIDDEN_EXTERNAL_KEYS,
)

UNITS = {**UNIT_REGISTRY, "count": {"dimension": "quantity"},
         "text": {"dimension": "text"}, "identifier": {"dimension": "identifier"}}
NAMESPACE = "wfd.local"


def make_data_service(tmp_path, roles=ALL_ROLES):
    engine = WFDDuckDBPrototype(
        tmp_path / "store", load_protocol_validator(HERE / "protocol", entry="wfd-data-only-write.schema.json"),
        runtime_root=tmp_path / "runtime", sandbox=False, writer_host="r1-test")
    service = WFDDataOnlyService(
        engine, caller_roles=roles, caller_id="r1-test", unit_registry=UNITS,
        trusted_actor_namespaces={NAMESPACE})
    return service


def context(nature="observed_fact", measurement="flow", **extra):
    value = {
        "version": "wfd.semantic-context/1.0",
        "content_nature": nature,
        "time": {"period_type": "natural", "frequency": "year", "interval": "closed"},
        "statistical": {"price_basis": "nominal", "period_aggregation": "period"},
        "financial": {"consolidation_scope": "not_applicable",
                      "price_adjustment": {"direction": "raw"}},
    }
    value.update(extra)
    return value


def request(outputs, request_id, *, parent=None, consistency_groups=None):
    return {
        "protocol_version": DATA_ONLY_PROTOCOL,
        "request_identity": {"dataset_id": "wfd_r1_local", "trusted_actor_namespace": NAMESPACE,
                             "request_id": request_id,
                             "submission_digest": "sha256:" + "0" * 64},
        "intent": "submit", "producer_namespace": NAMESPACE,
        "expected_parent_snapshot_id": parent, "outputs": outputs,
        **({"consistency_groups": consistency_groups} if consistency_groups else {}),
    }


def scalar_output(key, semantic, value, *, nature="observed_fact", measurement="flow",
                  algorithm=None, business_publisher=None, definition=None):
    declaration = definition or {
        "semantic_code": semantic, "measurement_nature": measurement,
        "unit_code": "count", "definition_authority": "wfd.local",
        "time_role": "observation",
        "semantic_context": context(nature, measurement),
    }
    if nature in {"forecast", "source_claim"}:
        declaration["semantic_context"] = copy.deepcopy(declaration["semantic_context"])
        declaration["semantic_context"]["content"] = {
            "assertion_status": "published", "target_period": "2027E"}
    if business_publisher is not None:
        declaration["semantic_context"] = copy.deepcopy(declaration["semantic_context"])
        declaration["semantic_context"]["source"] = {
            "definition_authority": "wfd.local",
            "publisher_ref": {"kind": "organization", "namespace": "wfd.local",
                              "id": business_publisher},
        }
    if algorithm is not None:
        declaration["algorithm_definition"] = copy.deepcopy(algorithm)
    return {
        "output_key": key, "logical_domain": "observations",
        "subject": {"kind": "physical_object", "namespace": "wfd.local", "id": "object_1"},
        "definition_mode": "create", "definition_ref": None, "definition": declaration,
        "input_mode": "partial_observation",
        "coverage": {"scope": {"sample_only": True}, "basis": "observed_partial",
                     "completeness": "partial", "absence_means": "unknown"},
        "payload": {"kind": "scalar_rows", "rows": [{
            "business_key": "row-" + key, "value_decimal": value,
            "value_state": "valid_value",
            "observation_time": {"status": "known", "precision": "year",
                                 "earliest_utc": "2025-01-01T00:00:00Z",
                                 "latest_exclusive_utc": "2026-01-01T00:00:00Z",
                                 "source_timezone": "UTC"}}]},
    }


def scan_persisted(store):
    """No external source/evidence/locator/processing content in persisted files."""
    problems = []
    for path in store.rglob("*"):
        if not path.is_file():
            continue
        raw = path.read_bytes()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = ""
        for token in ("original_path", "original_local_path", "/Users/",
                      "processing_record", "processing_evidence",
                      "derived_lineage", "source_roles", "source_ids",
                      "bd_locator", "bd_ref", "evidence/sha256"):
            if token in text:
                problems.append((str(path), token))
        for match in re.finditer(r'"evidence_refs"\s*:\s*\[', text):
            tail = text[match.end():match.end() + 3]
            if not tail.startswith("]"):
                problems.append((str(path), "nonempty evidence_refs"))
        if path.suffix == ".parquet":
            for row in rows_from_parquet(raw):
                for key in row:
                    if key in FORBIDDEN_EXTERNAL_KEYS:
                        problems.append((str(path), "row key " + key))
    return problems


def test_structured_record_formal_read_reopen_refs_and_no_external_metadata(tmp_path):
    service = make_data_service(tmp_path)
    doc = request([scalar_output("m1", "r1.metric", "10")], "r1-first")
    result = service.submit(doc)
    assert result["state"] == "published_formal", result
    pid = result["output_results"][0]["product_id"]
    sid = result["snapshot_id"]
    assert set(result["output_results"][0]["contract_refs"]) == {
        "semantic", "read_layout", "algorithm_dependency", "update_release"}
    records = result["output_results"][0]["records"]
    assert records[0]["record_id"] == "row-m1"
    assert records[0]["record_version"].startswith("r_")

    reopened = make_data_service(tmp_path)
    read = reopened.read(pid, snapshot_id=sid)
    assert read["rows"][0]["record_id"] == records[0]["record_id"]
    assert read["rows"][0]["record_version"] == records[0]["record_version"]
    assert read["products"][0]["contract_refs"] == result["output_results"][0]["contract_refs"]

    replay = reopened.submit(doc)
    assert replay["idempotent_replay"] is True
    assert replay["output_results"][0]["records"] == records
    assert scan_persisted(tmp_path / "store") == []


def test_external_source_evidence_paths_and_processing_are_rejected(tmp_path):
    service = make_data_service(tmp_path)
    base = request([scalar_output("m1", "r1.metric", "10")], "r1-clean")
    assert service.submit(base)["state"] == "published_formal"
    head = service.engine.head()["snapshot_id"]

    variants = []
    with_source = copy.deepcopy(base); with_source["request_identity"]["request_id"] = "bad-source"
    with_source["source_bundle"] = {"source_id": "synthetic"}; variants.append(with_source)
    with_evidence = copy.deepcopy(base); with_evidence["request_identity"]["request_id"] = "bad-evidence"
    with_evidence["outputs"][0]["evidence_refs"] = [{"ref_kind": "content"}]; variants.append(with_evidence)
    with_path = copy.deepcopy(base); with_path["request_identity"]["request_id"] = "bad-path"
    with_path["outputs"][0]["definition"]["original_path"] = "/tmp/original.pdf"; variants.append(with_path)
    with_processing = copy.deepcopy(base); with_processing["request_identity"]["request_id"] = "bad-processing"
    with_processing["outputs"][0]["definition"]["processing_record"] = {"code": "x"}; variants.append(with_processing)
    with_code = copy.deepcopy(base); with_code["request_identity"]["request_id"] = "bad-code"
    with_code["outputs"][0]["definition"]["algorithm_definition"] = {
        "mathematical_definition": "mean", "code": "print(1)"}; variants.append(with_code)

    for doc in variants:
        rejected = service.submit(doc)
        assert rejected["state"] == "rejected", rejected
        assert rejected["errors"][0]["code"] in {
            "EXTERNAL_METADATA_FORBIDDEN", "SCHEMA_INVALID"}, rejected
        assert service.engine.head()["snapshot_id"] == head
    assert scan_persisted(tmp_path / "store") == []


def test_record_identity_stable_across_unrelated_snapshot_and_revision(tmp_path):
    service = make_data_service(tmp_path)
    first = service.submit(request([scalar_output("m1", "r1.identity", "10")], "r1-identity-1"))
    assert first["state"] == "published_formal"
    pid, s1 = first["output_results"][0]["product_id"], first["snapshot_id"]
    old_record = first["output_results"][0]["records"][0]
    old_row = service.read(pid, snapshot_id=s1)["rows"][0]
    assert old_row["record_id"] == old_record["record_id"]
    assert old_row["record_version"] == old_record["record_version"]

    unrelated = service.submit(request([scalar_output("m2", "r1.unrelated", "5")],
                                       "r1-unrelated", parent=s1))
    assert unrelated["state"] == "published_formal"
    s2 = unrelated["snapshot_id"]
    same = service.read(pid, snapshot_id=s2)["rows"][0]
    assert same["record_id"] == old_record["record_id"]
    assert same["record_version"] == old_record["record_version"]

    correction_output = scalar_output("m1", "r1.identity", "11")
    correction_output.update(definition_mode="reuse",
                             definition_ref=first["output_results"][0]["definition_ref"],
                             definition=None, input_mode="source_correction")
    correction_output["revisions"] = {"row-m1": {
        "previous": {"product_id": pid, "snapshot_id": s1,
                     "logical_key": "row-m1", "revision_id": old_record["record_version"]},
        "reason": "corrected value"}}
    corrected = service.submit(request([correction_output], "r1-identity-2", parent=s2))
    assert corrected["state"] == "published_formal", corrected
    s3 = corrected["snapshot_id"]
    new_record = corrected["output_results"][0]["records"][0]
    assert new_record["record_id"] == old_record["record_id"]
    assert new_record["record_version"] != old_record["record_version"]
    old_fixed = service.read(pid, snapshot_id=s1)["rows"][0]
    assert old_fixed["record_version"] == old_record["record_version"]
    current = service.read(pid, snapshot_id=s3)["rows"][0]
    assert current["record_version"] == new_record["record_version"]
    history = service.read(pid, snapshot_id=s3, include_history=True)["rows"]
    assert {row["record_version"] for row in history} == {
        old_record["record_version"], new_record["record_version"]}


def test_forecast_rating_actual_computed_business_definition_and_templates(tmp_path):
    service = make_data_service(tmp_path)
    parent = None
    ids = {}
    variants = {
        "rating": ("source_claim", "stock", "broker_a"),
        "forecast": ("forecast", "flow", "broker_a"),
        "actual": ("actual_outcome", "flow", None),
    }
    for label, (nature, measurement, publisher) in variants.items():
        # 不同事实性质、计量类型属于不同产品定义，不复用一个写入目标。
        doc = request([scalar_output("m-" + label, "r1.claim." + label, "12",
                                     nature=nature, measurement=measurement,
                                     business_publisher=publisher)], "r1-nature-" + label,
                      parent=parent)
        result = service.submit(doc)
        assert result["state"] == "published_formal", (label, {"state": result["state"],
            "errors": result.get("errors"), "outputs": [{"key": item.get("output_key"),
            "errors": item.get("errors")} for item in result.get("output_results", [])]})
        ids[label] = result["output_results"][0]["product_id"]
        parent = result["snapshot_id"]
    assert len(set(ids.values())) == 3
    for label, pid in ids.items():
        product = service.read(pid, snapshot_id=parent)["products"][0]
        assert product["semantic_context"]["content_nature"] == variants[label][0]
        assert product["declaration"]["measurement_nature"] == variants[label][1]
        if label in {"rating", "forecast"}:
            assert product["semantic_context"]["content"]["target_period"] == "2027E"
            assert product["semantic_context"]["source"]["publisher_ref"]["id"] == "broker_a"

    algorithm = {
        "mathematical_definition": "simple moving average of the last 20 trading-day closes",
        "window": {"type": "trading_days", "count": 20, "interval": "closed"},
        "constants": {"minimum_periods": 20},
        "definition_version": "1.0",
    }
    computed = service.submit(request(
        [scalar_output("m-computed", "r1.computed", "13", nature="forecast",
                       measurement="flow", algorithm=algorithm)],
        "r1-computed", parent=parent))
    assert computed["state"] == "published_formal", computed
    product = service.read(computed["output_results"][0]["product_id"],
                           snapshot_id=computed["snapshot_id"])["products"][0]
    assert product["declaration"]["measurement_nature"] == "flow"
    assert product["semantic_context"]["content_nature"] == "forecast"
    algorithm_contract = product["contracts"]["compute_dependencies"]
    assert algorithm_contract["result_definition"]["window"]["count"] == 20
    assert "code" not in algorithm_contract["result_definition"]
    assert "parameters" not in algorithm_contract["result_definition"]

    templates = service.discover_semantic_templates()
    names = [item["subdomain_id"] for item in templates["finance_subdomains"]]
    assert names == ["raw_disclosure", "standardized_history", "operations",
                     "model_derived", "management_plan", "research_reports",
                     "consensus_forecast", "forecast_scenario"]
    assert "segments" not in names and "calendar_mapping" not in names
    assert templates.get("finance_leaf_count") == 56
    assert sum(item["leaf_count"] for item in templates["finance_subdomains"]) == 56


def test_bd_unavailable_read_and_machine_data_only_profile(tmp_path):
    # Provision this new fixture explicitly; machine requests only open existing stores.
    validator = load_protocol_validator(HERE / "protocol", entry="wfd-data-only-write.schema.json")
    engine = WFDDuckDBPrototype.initialize_new(
        tmp_path / "store", validator, runtime_root=tmp_path / "runtime",
        sandbox=False, writer_host="r1-test")
    service = WFDDataOnlyService(
        engine, caller_roles={"read", "register", "submit", "publish"}, caller_id="r1-test",
        unit_registry=UNITS, trusted_actor_namespaces={NAMESPACE})
    result = service.submit(request([scalar_output("m1", "r1.bd", "10")], "r1-bd"))
    assert result["state"] == "published_formal"
    pid, sid = result["output_results"][0]["product_id"], result["snapshot_id"]
    read_engine = WFDDuckDBPrototype.open_existing(
        tmp_path / "store", validator, runtime_root=tmp_path / "runtime",
        read_only=True, sandbox=False, writer_host="r1-test")
    read_only = WFDDataOnlyService(
        read_engine, caller_roles={"read"}, caller_id="r1-test", unit_registry=UNITS,
        trusted_actor_namespaces={NAMESPACE})
    assert read_only.read(pid, snapshot_id=sid)["rows"][0]["record_id"] == "row-m1"

    # P6 data_only profile: same service, no evidence/trace operations.
    from wfd_sdk import product_machine
    config_path = tmp_path / "machine_config.json"
    config = {
        "protocol_version": product_machine.MACHINE_CONFIG_PROTOCOL,
        "connection_id": "r1-machine", "profile": "data_only",
        "store": str(tmp_path / "store"), "runtime": str(tmp_path / "runtime"),
        "project_root": str(HERE), "protocol_root": str(HERE / "protocol"),
        "caller": {"caller_id": "r1-test", "trusted_actor_namespace": NAMESPACE,
                   "roles": ["read", "register", "submit", "publish"]},
        "units": UNITS,
    }
    config_path.write_text(json.dumps(config), encoding="utf-8")
    loaded = product_machine._load_config(str(config_path))
    machine_service = product_machine._build_service(loaded, operation="capabilities")
    assert machine_service.engine.read_only is True
    caps = product_machine._handle(machine_service, loaded, {
        "protocol_version": product_machine.MACHINE_PROTOCOL,
        "request_id": "caps", "operation": "capabilities", "arguments": {}})
    assert caps["ok"] is True
    assert "evidence_ingest" not in caps["result"]["operations"]
    with pytest.raises(ValueError, match="EXTERNAL_METADATA_OPERATION_UNSUPPORTED"):
        product_machine._handle(machine_service, loaded, {
            "protocol_version": product_machine.MACHINE_PROTOCOL,
            "request_id": "bad", "operation": "evidence_ingest",
            "arguments": {"content_base64": "eA=="}})
    schema_service = product_machine._build_service(loaded, operation="schema")
    schema = product_machine._handle(schema_service, loaded, {
        "protocol_version": product_machine.MACHINE_PROTOCOL,
        "request_id": "schema", "operation": "schema", "arguments": {}})
    assert schema["result"]["protocol_version"] == DATA_ONLY_PROTOCOL

    head = machine_service.engine.head()["snapshot_id"]
    machine_doc = request([scalar_output("m2", "r1.machine", "20")],
                          "r1-machine-submit", parent=head)
    submit_service = product_machine._build_service(loaded, operation="submit")
    assert submit_service.engine.read_only is False
    assert submit_service.engine.writer_host == service.engine.writer_host == "r1-test"
    submitted = product_machine._handle(submit_service, loaded, {
        "protocol_version": product_machine.MACHINE_PROTOCOL,
        "request_id": "submit", "operation": "submit",
        "arguments": {"document": machine_doc}})
    assert submitted["ok"] is True
    assert submitted["result"]["state"] == "published_formal", submitted
    machine_pid = submitted["result"]["output_results"][0]["product_id"]
    machine_sid = submitted["result"]["snapshot_id"]
    fixed_service = product_machine._build_service(loaded, operation="fixed_read")
    assert fixed_service.engine.read_only is True
    fixed = product_machine._handle(fixed_service, loaded, {
        "protocol_version": product_machine.MACHINE_PROTOCOL,
        "request_id": "fixed", "operation": "fixed_read",
        "arguments": {"snapshot_id": machine_sid, "product_id": machine_pid}})
    assert fixed["ok"] is True
    assert fixed["result"]["rows"][0]["record_id"] == "row-m2"
    assert fixed["result"]["rows"][0]["record_version"].startswith("r_")
    replay_service = product_machine._build_service(loaded, operation="submit")
    replay = product_machine._handle(replay_service, loaded, {
        "protocol_version": product_machine.MACHINE_PROTOCOL,
        "request_id": "replay", "operation": "submit",
        "arguments": {"document": machine_doc}})
    assert replay["result"]["idempotent_replay"] is True
    assert replay["result"]["output_results"][0]["records"][0]["record_version"] == \
        submitted["result"]["output_results"][0]["records"][0]["record_version"]
    assert scan_persisted(tmp_path / "store") == []


def test_strict_metadata_boundaries_and_business_code(tmp_path):
    service = make_data_service(tmp_path)
    clean = service.submit(request([scalar_output("m", "r1.boundary.clean", "10")], "boundary-clean"))
    head = service.engine.head()["snapshot_id"]
    cases = []
    ext = scalar_output("m", "r1.boundary.ext", "10")
    ext["definition"]["semantic_context"]["source"] = {
        "definition_authority": "wfd.local",
        "license_ref": {"id": "BD_ONLY_LICENSE_MARKER"},
        "notes": "Original at /tmp/BD_ONLY_ORIGINAL.pdf",
    }
    cases.append((request([ext], "boundary-external"), "BD_ONLY_LICENSE_MARKER"))
    trace = scalar_output("m", "r1.boundary.trace", "10", nature="forecast",
                          algorithm={"mathematical_definition": "mean",
                                     "window": {"type": "trading_days", "count": 20},
                                     "constants": {"input_refs": [{"id": "BD_ONLY_INPUT_MARKER"}],
                                                   "run_log": "EXPERIMENT_TRACE_MARKER"}})
    cases.append((request([trace], "boundary-trace"), "BD_ONLY_INPUT_MARKER"))
    for doc, marker in cases:
        rejected = service.submit(doc)
        assert rejected["state"] == "rejected", rejected
        assert service.engine.head()["snapshot_id"] == head
        assert marker not in json.dumps(rejected)
    assert scan_persisted(tmp_path / "store") == []

    # A security code is a declared business field, not executable code.
    business = scalar_output("security", "r1.boundary.security", "1")
    business["subject"] = {"kind": "instrument", "namespace": "wfd.local",
                           "id": "security_000001"}
    business["definition"]["unit_code"] = "per_field"
    business["definition"]["field_definitions"] = [{
        "field_code": "code", "data_type": "text", "unit_code": "text",
        "measurement_nature": "stock", "time_role": "observation"}]
    business["payload"] = {"kind": "tabular_rows", "rows": [{
        "business_key": "security_000001", "subject": business["subject"],
        "observation_time": copy.deepcopy(
            scalar_output("x", "x", "1")["payload"]["rows"][0]["observation_time"]),
        "values": {"code": {"data_type": "text", "value_state": "valid_value",
                             "value": "000001"}}}]}
    accepted = service.submit(request([business], "boundary-business-code", parent=head))
    assert accepted["state"] == "published_formal", accepted
    assert scan_persisted(tmp_path / "store") == []


def test_query_deterministic_and_recovery_boundaries(tmp_path):
    from test_product_query import request as query_request
    from wfd_sdk.product_query import ProductQuery

    service = make_data_service(tmp_path)
    first = service.submit(request([scalar_output("m", "r1.boundary.q", "10")],
                                   "boundary-query"))
    pid, sid = first["output_results"][0]["product_id"], first["snapshot_id"]
    query = ProductQuery(service).execute(query_request(
        "wfd_r1_local", sid, pid, ["value_decimal"]))
    assert query["result_status"] == "rows"
    assert query["rows"][0]["record_ref"]["logical_key"] == "row-m"

    algorithm = {"mathematical_definition": "20-day arithmetic mean",
                 "window": {"type": "trading_days", "count": 20},
                 "constants": {"minimum_periods": 20}, "definition_version": "1.0"}
    parent = sid
    for suffix, derivation in (("false", None), ("true", {"required": True})):
        out = scalar_output("m", "r1.boundary.det." + suffix, "10",
                            nature="deterministic_derived", measurement="flow",
                            algorithm=algorithm)
        if derivation is not None:
            out["definition"]["semantic_context"]["derivation"] = derivation
        result = service.submit(request([out], "boundary-det-" + suffix, parent=parent))
        assert result["state"] == "published_formal", (suffix, result)
        parent = result["snapshot_id"]
        product = service.read(result["output_results"][0]["product_id"],
                               snapshot_id=parent)["products"][0]
        assert product["semantic_context"]["content_nature"] == "deterministic_derived"
        assert product["declaration"]["measurement_nature"] == "flow"
        assert "derivation" not in product["semantic_context"]
        assert product["declaration"]["algorithm_definition"]["window"]["count"] == 20
        assert "derived_lineage" not in product

    # Lost final status: engine commit + intent must allow status/replay recovery.
    lost_tmp = tmp_path / "lost"
    lost = make_data_service(lost_tmp)
    doc = request([scalar_output("m", "r1.boundary.lost", "10")], "boundary-lost")
    saved = lost._save_status
    def fail_final(record):
        if record.get("state") == "published_formal":
            raise OSError("AUDIT_STATUS_WRITE_INTERRUPTED_AFTER_COMMIT")
        return saved(record)
    lost._save_status = fail_final
    with pytest.raises(OSError):
        lost.submit(doc)
    reopened = make_data_service(lost_tmp)
    status = reopened.request_status(doc["request_identity"])
    assert status["state"] == "published_formal"
    replay = reopened.submit(doc)
    assert replay["state"] == "published_formal" and replay["idempotent_replay"] is True
    assert replay["output_results"][0]["records"][0]["record_id"] == "row-m"

    # Activation failure must not claim formal; same identity recovers after activation.
    act_tmp = tmp_path / "activation"
    activation = make_data_service(act_tmp)
    doc = request([scalar_output("m", "r1.boundary.activation", "10")],
                  "boundary-activation")
    original_activate = activation.engine.state.activate
    activation.engine.state.activate = lambda *a, **k: {
        "ok": False, "code": "HEAD_WRITE_FAILED", "detail": "simulated"}
    pending = activation.submit(doc)
    assert pending["state"] == "published_commit_pending_head"
    assert pending["formal_publication_verified"] is False
    assert activation.engine.state.read().get("active_head") is None
    activation.engine.state.activate = original_activate
    sid = pending["snapshot_id"]
    assert original_activate(sid, activation.root / f"catalog/snapshots/{sid}.json",
                             expected_prev=None, writer_host="r1-test")["ok"]
    recovered = activation.submit(doc)
    assert recovered["state"] == "published_formal"
    assert recovered["formal_publication_verified"] is True
    assert recovered["idempotent_replay"] is True


def test_derived_measurement_uses_the_bound_data_only_protocol(tmp_path):
    from wfd_sdk.duckdb_sdk import business_validate
    engine = WFDDuckDBPrototype(tmp_path / "store", load_protocol_validator(
        HERE / "protocol", entry="wfd-data-only-write.schema.json"),
        runtime_root=tmp_path / "runtime", sandbox=False, writer_host="derived-observation-test")
    service = WFDDataOnlyService(engine, caller_roles=ALL_ROLES, caller_id="r1-test",
                                 unit_registry=UNITS, trusted_actor_namespaces={NAMESPACE})
    algorithm = {"mathematical_definition": "arithmetic mean of three selected observations",
                 "window": {"type": "observation_rows", "count": 3}, "definition_version": "1.0.0"}
    out = scalar_output("m", "derived.mean.test", "12.25", nature="deterministic_derived",
                        measurement="derived", algorithm=algorithm)
    internal = service._internal_output(out)
    assert "DERIVED_LINEAGE_REQUIRED" in {issue["code"] for issue in business_validate(internal)}
    incomplete = copy.deepcopy(internal)
    del incomplete["new_definition_declaration"]["algorithm_definition"]
    assert "DERIVED_LINEAGE_REQUIRED" in {issue["code"] for issue in business_validate(incomplete, data_only_write=True)}
    result = service.submit(request([out], "derived-with-business-definition"))
    assert result["state"] == "published_formal", result
    product = service.read(result["output_results"][0]["product_id"], snapshot_id=result["snapshot_id"])["products"][0]
    assert product["declaration"]["algorithm_definition"] == algorithm
    assert "derived_lineage" not in product
