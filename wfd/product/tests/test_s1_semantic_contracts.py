"""S1: versioned semantic context and four independent fixed contracts.

Fixtures only; not real financial data and not complete P1-P7 acceptance.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from test_product_service import ALL_ROLES, HERE, SOURCE_POLICY, UNIT_REGISTRY, known_time, make_service
from wfd_sdk.duckdb_sdk import canonical, derived_output_digest, sha
from wfd_sdk.product_query import ProductQuery
from wfd_sdk.product_service import WFDProductService

DATASET = "test_wfd_v13_round2"


def context(**overrides):
    value = {
        "version": "wfd.semantic-context/1.0",
        "content_nature": "observed_fact",
        "time": {"period_type": "natural", "frequency": "year", "interval": "closed"},
        "statistical": {
            "price_basis": "nominal", "period_aggregation": "period",
            "seasonal_adjustment": {"status": "not_adjusted"},
            "sample_scope_ref": {"id": "sample_scope_all", "digest": "sha256:" + "1" * 64},
        },
        "financial": {
            "consolidation_scope": "not_applicable",
            "price_adjustment": {"direction": "raw"},
        },
    }
    value.update(overrides)
    return value


def sync_roles(doc):
    doc["source_bundle"]["source_roles"] = {
        out["output_key"]: [{"source_id": "fixture",
                             "roles": ["definer", "first_publisher", "deliverer"]}]
        for out in doc["outputs"]}


def semantic_tabular_doc(tmp_path):
    service, doc = make_service(tmp_path)
    out = doc["outputs"][0]
    out["new_definition_declaration"] = {
        "semantic_code": "s1.semantic.tabular",
        "measurement_nature": "mixed_observation",
        "unit_code": "per_field",
        "definition_authority": "p1.test",
        "time_role": "observation",
        "field_definitions": [{
            "field_code": "amount", "data_type": "decimal", "unit_code": "vehicle",
            "measurement_nature": "stock", "time_role": "observation"}],
        "semantic_context": context(
            time={"period_type": "accounting", "frequency": "half_year",
                  "interval": "closed",
                  "accounting_calendar_ref": {"id": "fiscal_cal", "digest": "sha256:" + "2" * 64}},
            statistical={"price_basis": "nominal", "period_aggregation": "ytd",
                          "seasonal_adjustment": {"status": "not_adjusted"},
                          "sample_scope_ref": {"id": "scope", "digest": "sha256:" + "3" * 64}},
            financial={"accounting_standard_ref": {"id": "cas", "digest": "sha256:" + "4" * 64},
                       "consolidation_scope": "consolidated",
                       "mapping_comparability_ref": {"id": "mapping", "digest": "sha256:" + "5" * 64},
                       "price_adjustment": {"direction": "raw"}},
        ),
        "field_semantic_context": {
            "amount": {"statistical": {"period_aggregation": "ytd"},
                       "financial": {"consolidation_scope": "consolidated"}},
        },
    }
    out["payload"] = {"kind": "tabular_rows", "rows": [{
        "business_key": "row-1", "subject": out["subject"],
        "observation_time": known_time(2025),
        "values": {"amount": {"data_type": "decimal", "value_state": "valid_value",
                               "value": "100"}}}]}
    out["coverage"] = {"scope": {"sample_only": True}, "basis": "observed_partial",
                       "completeness": "partial", "coverage_evidence": [],
                       "absence_means": "unknown"}
    doc["request_identity"]["request_id"] = "s1-semantic-1"
    doc["source_bundle"]["product_service"]["outputs"] = {
        out["output_key"]: {"read_dependencies": []}}
    sync_roles(doc)
    return service, doc


def test_new_semantic_declaration_publishes_four_refs_and_fixed_readback(tmp_path):
    service, doc = semantic_tabular_doc(tmp_path)
    result = service.submit(doc)
    assert result["status"] == "published_formal", result
    pid, sid = result["output_results"][0]["product_id"], result["snapshot_id"]
    read = service.read(pid, snapshot_id=sid)
    product = read["products"][0]
    assert product["semantic_context"]["version"] == "wfd.semantic-context/1.0"
    assert product["semantic_context"]["content_nature"] == "observed_fact"
    assert product["semantic_context"]["statistical"]["period_aggregation"] == "ytd"
    assert product["semantic_context"]["financial"]["consolidation_scope"] == "consolidated"
    assert product["field_semantic_context"]["amount"]["financial"]["consolidation_scope"] == "consolidated"
    assert set(product["contract_refs"]) == {
        "semantic", "read_layout", "algorithm_dependency", "update_release"}
    assert product["contract_bundle_ref"]["digest"].startswith("sha256:")
    receipt = json.loads((tmp_path / "store" / result["formal_publication_receipt"]).read_text("utf-8"))
    assert set(receipt["outputs"][0]["contract_refs"]) == set(product["contract_refs"])
    # New service instance reads the same fixed binding; no latest lookup.
    reader = WFDProductService(
        service.engine, allowed_sources={"fixture": copy.deepcopy(SOURCE_POLICY)},
        caller_roles={"read", "read_evidence"}, caller_id="s1-reader",
        unit_registry=UNIT_REGISTRY, trusted_actor_namespaces={"wfd.test.curated"})
    again = reader.read(pid, snapshot_id=sid)
    assert again["products"][0]["contract_refs"] == product["contract_refs"]
    assert again["products"][0]["semantic_context"] == product["semantic_context"]

    # Query exposes only the new semantic/contract projection; its time and
    # budget logic is otherwise unchanged.
    query_result = ProductQuery(service).execute({
        "protocol_version": "wfd.read/1.3-product1", "dataset_id": DATASET,
        "operation": "read_product", "snapshot_id": sid,
        "history_mode": "snapshot_contents", "knowledge_cutoff": None,
        "held_scope": None, "usable_stage": None, "subject": None,
        "max_nodes": 1000, "product_id": pid, "fields": ["amount"],
        "page_size": 100, "max_scan_bytes": 50_000_000, "cursor": None,
        "business_time_range": None,
    })
    assert query_result["product"]["contract_role_refs"] == product["contract_refs"]
    assert query_result["product"]["contract_bundle_ref"] == product["contract_bundle_ref"]
    assert query_result["product"]["semantic_context"] == product["semantic_context"]


def _scalar_doc(base, *, request_id, parent, semantic, value, context_value,
                measurement_nature="flow"):
    doc = copy.deepcopy(base)
    out = doc["outputs"][0]
    out["output_key"] = "metric"
    out["new_definition_declaration"] = {
        "semantic_code": semantic, "measurement_nature": measurement_nature,
        "unit_code": "vehicle", "definition_authority": "p1.test",
        "time_role": "observation", "semantic_context": context_value,
    }
    out["payload"] = {"kind": "scalar_rows", "rows": [{
        "business_key": "row-" + request_id, "value_decimal": value,
        "value_state": "valid_value", "observation_time": known_time(2025)}]}
    out["coverage"] = {"scope": {"sample_only": True}, "basis": "observed_partial",
                       "completeness": "partial", "coverage_evidence": [],
                       "absence_means": "unknown"}
    doc["request_identity"]["request_id"] = request_id
    doc["expected_parent_snapshot_id"] = parent
    doc["source_bundle"]["product_service"]["outputs"] = {
        "metric": {"read_dependencies": []}}
    sync_roles(doc)
    return doc


def test_same_name_unit_different_context_is_not_one_comparable_definition(tmp_path):
    service, base = make_service(tmp_path)
    base["outputs"][0]["new_definition_declaration"]["definition_authority"] = "p1.test"
    variants = [
        ("adjusted", context(statistical={
            "price_basis": "nominal", "period_aggregation": "period",
            "seasonal_adjustment": {"status": "adjusted",
                                    "method_ref": {"id": "census_x13", "digest": "sha256:" + "a" * 64}}})),
        ("not_adjusted", context(statistical={
            "price_basis": "nominal", "period_aggregation": "period",
            "seasonal_adjustment": {"status": "not_adjusted"}})),
        ("consolidated", context(financial={
            "consolidation_scope": "consolidated",
            "price_adjustment": {"direction": "raw"}})),
        ("parent", context(financial={
            "consolidation_scope": "parent",
            "price_adjustment": {"direction": "raw"}})),
        ("forecast", context(content_nature="forecast", content={
            "assertion_status": "published", "target_period": "2027"})),
        ("actual", context(content_nature="actual_outcome")),
    ]
    products, parent = [], None
    for label, ctx in variants:
        doc = _scalar_doc(base, request_id="s1-same-" + label, parent=parent,
                          semantic="s1.same.identity", value="10", context_value=ctx)
        result = service.submit(doc)
        assert result["status"] == "published_formal", (label, result)
        products.append(result["output_results"][0]["product_id"])
        parent = result["snapshot_id"]
    assert len(set(products)) == len(variants)
    for pid in products:
        product = service.read(pid, snapshot_id=parent)["products"][0]
        assert product["semantic_context"]["content_nature"] in {
            "observed_fact", "forecast", "actual_outcome"}

    unknown_context = {"version": "wfd.semantic-context/1.0",
                       "content_nature": "observed_fact"}
    unknown_doc = _scalar_doc(base, request_id="s1-unknown-axes", parent=parent,
                              semantic="s1.unknown.context", value="10",
                              context_value=unknown_context)
    unknown = service.submit(unknown_doc)
    assert unknown["status"] == "published_formal", unknown
    unknown_product = service.read(unknown["output_results"][0]["product_id"],
                                   snapshot_id=unknown["snapshot_id"])["products"][0]
    applicability = unknown_product["semantic_context"]["applicability"]
    assert {"time", "statistical", "financial", "version"} <= set(applicability["unknown_axes"])
    assert "time_comparison_limited" in applicability["limits"]
    assert "statistical_comparison_limited" in applicability["limits"]


def test_read_contract_change_keeps_the_other_three_versions_fixed(tmp_path):
    service, base = make_service(tmp_path)
    base["outputs"][0]["new_definition_declaration"]["definition_authority"] = "p1.test"
    first_doc = _scalar_doc(base, request_id="s1-read-old", parent=None,
                            semantic="s1.read.contract", value="10",
                            context_value=context())
    first = service.submit(first_doc)
    assert first["status"] == "published_formal", first
    first_pid, first_sid = first["output_results"][0]["product_id"], first["snapshot_id"]
    first_product = service.read(first_pid, snapshot_id=first_sid)["products"][0]
    refs_before = copy.deepcopy(first_product["contract_refs"])

    second_doc = copy.deepcopy(first_doc)
    second_doc["request_identity"]["request_id"] = "s1-read-new"
    second_doc["expected_parent_snapshot_id"] = first_sid
    second_doc["outputs"][0]["definition_mode"] = "reuse"
    second_doc["outputs"][0]["definition_ref"] = first["output_results"][0]["definition_ref"]
    second_doc["outputs"][0]["new_definition_declaration"] = None
    second_doc["outputs"][0]["payload"]["rows"][0]["business_key"] = "row-second"
    second_doc["source_bundle"]["product_service"]["outputs"] = {"metric": {
        "read_dependencies": [{
            "dataset_id": DATASET, "product_id": first_pid,
            "snapshot_id": first_sid, "role": "input", "required": True}],
    }}
    sync_roles(second_doc)
    second = service.submit(second_doc)
    assert second["status"] == "published_formal", second
    second_sid = second["snapshot_id"]
    second_products = service.read(first_pid, snapshot_id=second_sid)["products"]
    second_product = next(product for product in second_products
                          if product["contract_ref"] != first_product["contract_ref"])
    refs_after = second_product["contract_refs"]
    assert refs_before["semantic"] == refs_after["semantic"]
    assert refs_before["algorithm_dependency"] == refs_after["algorithm_dependency"]
    assert refs_before["update_release"] == refs_after["update_release"]
    assert refs_before["read_layout"] != refs_after["read_layout"]
    assert first_product["contract_bundle_ref"] != second_product["contract_bundle_ref"]
    old_read = service.read(first_pid, snapshot_id=first_sid)["products"][0]
    assert old_read["contract_refs"] == refs_before


def test_tampered_contract_part_is_rejected_on_fixed_read(tmp_path):
    service, base = make_service(tmp_path)
    base["outputs"][0]["new_definition_declaration"]["definition_authority"] = "p1.test"
    doc = _scalar_doc(base, request_id="s1-tamper", parent=None,
                      semantic="s1.tamper.contract", value="10",
                      context_value=context())
    result = service.submit(doc)
    assert result["status"] == "published_formal", result
    pid, sid = result["output_results"][0]["product_id"], result["snapshot_id"]
    digest = service.read(pid, snapshot_id=sid)["products"][0]["contract_refs"]["semantic"]["digest"]
    path = tmp_path / "store" / "catalog/product_service/contracts/semantic" / (
        digest.removeprefix("sha256:") + ".json")
    assert path.is_file()
    path.write_bytes(path.read_bytes() + b" ")
    with pytest.raises(ValueError, match="CONTRACT_FILE_DIGEST_MISMATCH:semantic"):
        service.read(pid, snapshot_id=sid)


def test_rating_forecast_actual_and_computed_forecast_keep_their_nature(tmp_path):
    service, base = make_service(tmp_path)
    base["outputs"][0]["new_definition_declaration"]["definition_authority"] = "p1.test"
    parent = None
    ids = {}
    variants = {
        "rating": context(content_nature="source_claim", measurement_nature="stock",
                          content={"assertion_status": "published", "target_period": "12m",
                                   "publisher_ref": {"id": "broker_a", "digest": "sha256:" + "b" * 64}}),
        "forecast": context(content_nature="forecast", measurement_nature="flow",
                            content={"target_period": "2027E",
                                     "publisher_ref": {"id": "broker_a", "digest": "sha256:" + "b" * 64}}),
        "actual": context(content_nature="actual_outcome", measurement_nature="flow"),
    }
    for label, ctx in variants.items():
        doc = _scalar_doc(base, request_id="s1-nature-" + label, parent=parent,
                          semantic="s1.claim.nature", value="12",
                          measurement_nature=ctx["measurement_nature"],
                          context_value=ctx)
        result = service.submit(doc)
        assert result["status"] == "published_formal", (label, result)
        ids[label] = result["output_results"][0]["product_id"]
        parent = result["snapshot_id"]
    assert len(set(ids.values())) == 3
    for label, pid in ids.items():
        product = service.read(pid, snapshot_id=parent)["products"][0]
        assert product["semantic_context"]["content_nature"] == variants[label]["content_nature"]
        assert product["declaration"]["measurement_nature"] == variants[label]["measurement_nature"]

    # Input product for the computed forecast.
    input_doc = _scalar_doc(base, request_id="s1-computed-input", parent=parent,
                            semantic="s1.computed.input", value="10",
                            context_value=context())
    input_result = service.submit(input_doc)
    assert input_result["status"] == "published_formal", input_result
    input_pid = input_result["output_results"][0]["product_id"]
    input_sid = input_result["snapshot_id"]
    input_digest = service.read(input_pid, snapshot_id=input_sid)["products"][0]["content_digest"]

    service.caller_roles = frozenset(set(service.caller_roles) | {"compute"})
    computed_context = context(
        content_nature="forecast", measurement_nature="flow",
        content={"target_period": "2027E"},
        derivation={"required": True})
    doc = _scalar_doc(base, request_id="s1-computed-forecast", parent=input_sid,
                      semantic="s1.computed.forecast", value="11",
                      measurement_nature="flow", context_value=computed_context)
    out = doc["outputs"][0]
    code = "def forecast(value, offset):\n    return value + offset"
    method = {
        "method_id": "forecast_offset", "version": "1",
        "declaration": {"formula": "value + offset"},
        "code": code, "code_format": "python",
        "parameter_version": "1", "parameters": {"offset": 1},
    }
    method_digest = "sha256:" + sha(canonical({
        "method_id": method["method_id"], "version": method["version"],
        "declaration": method["declaration"]}))
    code_digest = "sha256:" + sha(canonical({"code_format": "python", "code": code}))
    parameter_digest = "sha256:" + sha(canonical({
        "method_id": method["method_id"], "version": method["version"],
        "parameter_version": method["parameter_version"],
        "parameters": method["parameters"]}))
    output_digest = derived_output_digest(out)
    record = {
        "format_version": "wfd.external-processing/1.0",
        "output_key": "metric",
        "input_digests": [input_digest],
        "method_digest": method_digest,
        "method_code_digest": code_digest,
        "parameter_digest": parameter_digest,
        "output_digest": output_digest,
    }
    record_path = tmp_path / "computed_forecast_record.json"
    record_path.write_text(json.dumps(record), encoding="utf-8")
    record_ref = service.register_evidence(record_path)
    out["evidence_refs"] = [record_ref]
    doc["source_bundle"]["product_service"]["outputs"] = {"metric": {
        "read_dependencies": [],
        "derived_lineage": {
            "method": method,
            "inputs": [{"dataset_id": DATASET, "product_id": input_pid,
                        "snapshot_id": input_sid, "content_digest": input_digest}],
            "processing_evidence": [record_ref],
            "warmup": {"required_observations": 1, "available_observations": 8,
                       "status": "sufficient"},
            "validity": {"state": "valid"},
        },
    }}
    sync_roles(doc)
    computed = service.submit(doc)
    assert computed["status"] == "published_formal", computed
    c_pid, c_sid = computed["output_results"][0]["product_id"], computed["snapshot_id"]
    product = next(product for product in service.read(c_pid, snapshot_id=c_sid)["products"]
                   if product["product_id"] == c_pid)
    assert product["declaration"]["measurement_nature"] == "flow"
    assert product["semantic_context"]["content_nature"] == "forecast"
    assert product["semantic_context"]["derivation"]["required"] is True
    assert product["derived_lineage"]["computation"] == "external"
    assert product["contract_refs"]["algorithm_dependency"]["digest"].startswith("sha256:")


def test_template_discovery_does_not_register_products_or_block_custom(tmp_path):
    service, doc = semantic_tabular_doc(tmp_path)
    assert service.engine.head() is None
    templates = service.discover_semantic_templates()
    assert templates["status"] == "templates_only_not_products"
    assert len(templates["business_groups"]) == 7
    assert len(templates["finance_subdomains"]) == 8
    assert templates["template_ref"]["digest"].startswith("sha256:")
    assert service.capabilities()["semantic_templates"]["business_group_count"] == 7
    assert service.engine.head() is None
    result = service.submit(doc)
    assert result["status"] == "published_formal", result
    assert service.engine.head() is not None
