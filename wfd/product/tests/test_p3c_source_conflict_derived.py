"""P3c: original-publisher independence, source conflict and external derived results.

These are targeted acceptance fixtures.  They are not the P6 external BD
integration, and the moving-average producer is a temporary local script used
only to obtain a real externally computed result for admission verification.
"""
from __future__ import annotations

import copy
import json
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

import pytest

from test_product_service import ALL_ROLES, HERE, UNIT_REGISTRY, known_time
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, canonical, load_protocol_validator, sha
from wfd_sdk.product_governance import source_origin_key
from wfd_sdk.product_service import SERVICE_VERSION, WFDProductService

P3C_ROLES = set(ALL_ROLES) | {"compute"}
DATASET = "test_p3c"
UNITS = {**UNIT_REGISTRY, "cny_per_share": {"dimension": "money_per_share"},
         "share": {"dimension": "quantity"}}


def policy(roles, authorities=("p3c.test",)):
    return {
        "may_submit": True, "may_publish_formal": True,
        "may_read": True, "may_read_evidence": True,
        "may_export": True, "may_export_evidence": True,
        "export_scope": "p3c_test_only", "usage_scope": "p3c_test_only",
        "allowed_roles": list(roles), "allowed_authorities": list(authorities),
    }


def make_p3c_service(tmp_path, sources=None):
    engine = WFDDuckDBPrototype(
        tmp_path / "store", load_protocol_validator(HERE / "protocol"),
        runtime_root=tmp_path / "runtime", sandbox=False, writer_host="p3c-test")
    return WFDProductService(
        engine,
        allowed_sources=sources or {
            "alpha": policy(["first_publisher", "deliverer"]),
            "beta": policy(["first_publisher", "deliverer"]),
            "exchange": policy(["first_publisher", "deliverer"]),
            "wire_a": policy(["republisher", "deliverer"]),
            "wire_b": policy(["republisher", "deliverer"]),
        },
        caller_roles=P3C_ROLES, caller_id="p3c-test", unit_registry=UNITS,
        trusted_actor_namespaces={"wfd.test.curated"})


def evidence(service, tmp_path, name, text):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return service.register_evidence(path)


def scalar_output(key, semantic, value, *, state="valid_value", unit="vehicle",
                  authority="p3c.test", nature="stock", refs, subject_id="metric"):
    return {
        "output_key": key, "logical_domain": "observations",
        "subject": {"kind": "physical_object", "namespace": "p3c.test", "id": subject_id},
        "definition_mode": "create", "definition_ref": None,
        "new_definition_declaration": {
            "semantic_code": semantic, "measurement_nature": nature,
            "unit_code": unit, "definition_authority": authority,
            "time_role": "observation"},
        "input_mode": "partial_observation",
        "coverage": {"scope": {"sample_only": True}, "basis": "observed_partial",
                     "completeness": "partial", "coverage_evidence": [],
                     "absence_means": "unknown"},
        "payload": {"kind": "scalar_rows", "rows": [{
            "business_key": "row-" + key, "value_decimal": value,
            "value_state": state, "observation_time": known_time(2024)}]},
        "evidence_refs": list(refs),
    }


def tabular_output(key, semantic, rows, *, unit="cny_per_share",
                   authority="p3c.test", refs, subject_id="security_1"):
    return {
        "output_key": key, "logical_domain": "observations",
        "subject": {"kind": "instrument", "namespace": "p3c.test", "id": subject_id},
        "definition_mode": "create", "definition_ref": None,
        "new_definition_declaration": {
            "semantic_code": semantic, "measurement_nature": "mixed_observation",
            "unit_code": "per_field", "definition_authority": authority,
            "time_role": "observation",
            "field_definitions": [{
                "field_code": "close", "data_type": "decimal", "unit_code": unit,
                "measurement_nature": "stock", "time_role": "observation"}]},
        "input_mode": "partial_observation",
        "coverage": {"scope": {"sample_only": True}, "basis": "observed_partial",
                     "completeness": "partial", "coverage_evidence": [],
                     "absence_means": "unknown"},
        "payload": {"kind": "tabular_rows", "rows": [{
            "business_key": item["business_key"], "subject": {
                "kind": "instrument", "namespace": "p3c.test", "id": subject_id},
            "observation_time": known_time(2024),
            "values": {"close": {"data_type": "decimal", "value_state": "valid_value",
                                  "value": item["close"]}}} for item in rows]},
        "evidence_refs": list(refs),
    }


def request(outputs, *, request_id, source_roles, extension_outputs,
            source_ids, parent=None):
    return {
        "protocol_version": "wfd.ingest/1.3-candidate",
        "request_identity": {"dataset_id": DATASET,
                             "trusted_actor_namespace": "wfd.test.curated",
                             "request_id": request_id,
                             "submission_digest": "sha256:" + "0" * 64},
        "intent": "submit", "producer_namespace": "wfd.test.curated",
        "expected_parent_snapshot_id": parent,
        "outputs": outputs,
        "source_bundle": {
            "source_ids": list(source_ids), "source_roles": source_roles,
            "product_service": {"version": SERVICE_VERSION,
                                "outputs": extension_outputs},
        },
    }


def errors(result):
    return [error["code"] for item in result.get("output_results", [])
            for error in item.get("errors", [])]


def test_reposts_of_one_original_count_as_one_independent_origin(tmp_path):
    service = make_p3c_service(tmp_path)
    ref = evidence(service, tmp_path, "exchange_bulletin.txt",
                   "Synthetic original bulletin for P3c repost independence.")
    digest = ref["content_sha256"]
    output = scalar_output("repost_value", "p3c.repost.value", "10.50", refs=[ref])
    lineage = []
    for sid in ("wire_a", "wire_b"):
        lineage.append({
            "source_id": sid, "first_publisher_id": "exchange",
            "first_publication_id": "bulletin-2024-01",
            "original_content_sha256": digest, "content_sha256": digest,
            "publication_chain": ["exchange", sid],
            "evidence_ref_ids": [ref["ref_id"]],
            "field_evidence": {"value_decimal": [ref["ref_id"]]},
            "values": [{"business_key": "row-repost_value", "field": "value_decimal",
                        "value_state": "valid_value", "value": "10.50"}],
        })
    doc = request(
        [output], request_id="p3c-reposts",
        source_roles={"repost_value": [
            {"source_id": "wire_a", "roles": ["republisher", "deliverer"]},
            {"source_id": "wire_b", "roles": ["republisher", "deliverer"]}]},
        extension_outputs={"repost_value": {
            "read_dependencies": [], "source_lineage": lineage}},
        source_ids=["exchange", "wire_a", "wire_b"])
    result = service.submit(doc)
    assert result["status"] == "published_formal", result
    read = service.read(result["output_results"][0]["product_id"],
                        snapshot_id=result["snapshot_id"])
    attribution = read["rows"][0]["source_binding"]["source_attribution"]
    assert len(attribution["origins"]) == 1
    assert attribution["fields"]["value_decimal"]["independent_origin_count"] == 1
    assert attribution["origins"][0]["source_ids"] == ["wire_a", "wire_b"]
    assert read["rows"][0]["row"]["value_decimal"] == "10.50"


def test_independent_conflict_is_explicitly_preserved_or_selected(tmp_path):
    service = make_p3c_service(tmp_path)
    a_ref = evidence(service, tmp_path, "alpha.txt", "Synthetic alpha observation.")
    b_ref = evidence(service, tmp_path, "beta.txt", "Synthetic beta observation.")
    a_digest = a_ref["content_sha256"]
    b_digest = b_ref["content_sha256"]
    a_origin = source_origin_key("alpha", "alpha-pub-1", a_digest)
    b_origin = source_origin_key("beta", "beta-pub-1", b_digest)

    def lineage_for(sid, digest, value, business_key="row-select_value"):
        return {
            "source_id": sid, "first_publisher_id": sid,
            "first_publication_id": sid + "-pub-1",
            "original_content_sha256": digest, "content_sha256": digest,
            "publication_chain": [sid],
            "evidence_ref_ids": [(a_ref if sid == "alpha" else b_ref)["ref_id"]],
            "field_evidence": {"value_decimal": [
                (a_ref if sid == "alpha" else b_ref)["ref_id"]]},
            "values": [{"business_key": business_key, "field": "value_decimal",
                        "value_state": "valid_value", "value": value}],
        }

    select_output = scalar_output("select_value", "p3c.conflict.value", "10.00",
                                  refs=[a_ref, b_ref])
    comparability = {
        "format_version": "wfd.source-comparability/1.0",
        "semantic_code": "p3c.conflict.value", "unit_code": "vehicle",
        "mode": "select", "rule_version": "p3c.selection/1.0",
        "groups": [{"business_key": "row-select_value", "field": "value_decimal",
                    "origin_keys": sorted([a_origin, b_origin])}],
    }
    comp_digest = "sha256:" + sha(canonical(comparability))
    select_output["comparison_set"] = {
        "comparison_set_id": "cmp-select-1",
        "input_refs": [a_ref, b_ref],
        "comparability_contract_ref": {
            "kind": "contract", "dataset_id": DATASET,
            "namespace": "wfd.product", "id": "cmp_" + comp_digest[7:31],
            "version": "v_" + comp_digest[7:23], "digest": comp_digest,
            "resolution": "pinned", "required": True, "dependency_type": "read"},
        "decisions": [
            {"candidate_ref": "cand_alpha", "selection_status": "selected",
             "affected_scope": {"business_key": "row-select_value",
                                "field": "value_decimal"},
             "reason_code": "declared_first_publisher_priority"},
            {"candidate_ref": "cand_beta", "selection_status": "excluded",
             "affected_scope": {"business_key": "row-select_value",
                                "field": "value_decimal"},
             "reason_code": "independent_different_value"},
        ],
    }
    select_ext = {
        "read_dependencies": [],
        "source_lineage": [lineage_for("alpha", a_digest, "10.00"),
                           lineage_for("beta", b_digest, "10.50")],
        "conflict_resolution": {
            "comparison_set_id": "cmp-select-1", "mode": "select",
            "rule_version": "p3c.selection/1.0",
            "comparability": comparability,
            "candidates": [
                {"candidate_ref": "cand_alpha", "source_id": "alpha",
                 "business_key": "row-select_value", "field": "value_decimal",
                 "value_state": "valid_value", "value": "10.00",
                 "evidence_ref_ids": [a_ref["ref_id"]]},
                {"candidate_ref": "cand_beta", "source_id": "beta",
                 "business_key": "row-select_value", "field": "value_decimal",
                 "value_state": "valid_value", "value": "10.50",
                 "evidence_ref_ids": [b_ref["ref_id"]]},
            ],
            "selection": {"candidate_ref": "cand_alpha",
                          "reason_code": "declared_first_publisher_priority",
                          "reason": "Alpha is the declared first publisher for this publication."},
        },
    }
    doc = request(
        [select_output], request_id="p3c-conflict-select",
        source_roles={"select_value": [
            {"source_id": "alpha", "roles": ["first_publisher"]},
            {"source_id": "beta", "roles": ["first_publisher"]}]},
        extension_outputs={"select_value": select_ext},
        source_ids=["alpha", "beta"])
    result = service.submit(doc)
    assert result["status"] == "published_formal", result
    read = service.read(result["output_results"][0]["product_id"],
                        snapshot_id=result["snapshot_id"])
    row = read["rows"][0]
    assert row["row"]["value_decimal"] == "10.00"
    conflict = row["source_binding"]["source_conflicts"][0]
    assert conflict["resolution"] == "select"
    assert conflict["independent_origin_count"] == 2
    assert {candidate["value"] for candidate in conflict["candidates"]} == {"10.00", "10.50"}
    assert conflict["selected_candidate_ref"] == "cand_alpha"
    assert all(conflict["decisions"][i]["selection_status"] in {"selected", "excluded"}
               for i in range(2))
    assert conflict["all_original_values_retained"] is True

    # Preserve mode keeps both values and leaves the payload explicitly unknown.
    preserve_output = scalar_output("preserve_value", "p3c.conflict.preserve", None,
                                    state="source_conflict", refs=[a_ref, b_ref])
    preserve_comparability = {
        "format_version": "wfd.source-comparability/1.0",
        "semantic_code": "p3c.conflict.preserve", "unit_code": "vehicle",
        "mode": "preserve", "rule_version": "p3c.selection/1.0",
        "groups": [{"business_key": "row-preserve_value", "field": "value_decimal",
                    "origin_keys": sorted([a_origin, b_origin])}],
    }
    preserve_digest = "sha256:" + sha(canonical(preserve_comparability))
    preserve_output["comparison_set"] = {
        "comparison_set_id": "cmp-preserve-1",
        "input_refs": [a_ref, b_ref],
        "comparability_contract_ref": {
            "kind": "contract", "dataset_id": DATASET,
            "namespace": "wfd.product", "id": "cmp_" + preserve_digest[7:31],
            "version": "v_" + preserve_digest[7:23], "digest": preserve_digest,
            "resolution": "pinned", "required": True, "dependency_type": "read"},
        "decisions": [
            {"candidate_ref": "cand_alpha", "selection_status": "unresolved",
             "affected_scope": {"business_key": "row-preserve_value",
                                "field": "value_decimal"},
             "reason_code": "conflict_unresolved"},
            {"candidate_ref": "cand_beta", "selection_status": "unresolved",
             "affected_scope": {"business_key": "row-preserve_value",
                                "field": "value_decimal"},
             "reason_code": "conflict_unresolved"},
        ],
    }
    preserve_lineage = [lineage_for("alpha", a_digest, "10.00", "row-preserve_value"),
                        lineage_for("beta", b_digest, "10.50", "row-preserve_value")]
    preserve_doc = request(
        [preserve_output], request_id="p3c-conflict-preserve",
        source_roles={"preserve_value": [
            {"source_id": "alpha", "roles": ["first_publisher"]},
            {"source_id": "beta", "roles": ["first_publisher"]}]},
        extension_outputs={"preserve_value": {
            "read_dependencies": [], "source_lineage": preserve_lineage,
            "conflict_resolution": {
                "comparison_set_id": "cmp-preserve-1", "mode": "preserve",
                "rule_version": "p3c.selection/1.0",
                "comparability": preserve_comparability,
                "candidates": [
                    {"candidate_ref": "cand_alpha", "source_id": "alpha",
                     "business_key": "row-preserve_value", "field": "value_decimal",
                     "value_state": "valid_value", "value": "10.00",
                     "evidence_ref_ids": [a_ref["ref_id"]]},
                    {"candidate_ref": "cand_beta", "source_id": "beta",
                     "business_key": "row-preserve_value", "field": "value_decimal",
                     "value_state": "valid_value", "value": "10.50",
                     "evidence_ref_ids": [b_ref["ref_id"]]},
                ],
            }}},
        source_ids=["alpha", "beta"], parent=result["snapshot_id"])
    preserve = service.submit(preserve_doc)
    assert preserve["status"] == "published_formal", preserve
    preserve_read = service.read(preserve["output_results"][0]["product_id"],
                                 snapshot_id=preserve["snapshot_id"])
    preserve_row = preserve_read["rows"][0]
    assert preserve_row["row"]["value_state"] == "source_conflict"
    assert preserve_row["row"]["value_decimal"] is None
    preserve_conflict = preserve_row["source_binding"]["source_conflicts"][0]
    assert preserve_conflict["resolution"] == "preserve"
    assert preserve_conflict["selected_candidate_ref"] is None
    assert {candidate["value"] for candidate in preserve_conflict["candidates"]} == {"10.00", "10.50"}
    assert all(decision["selection_status"] == "unresolved"
               for decision in preserve_conflict["decisions"])

    # Compare mode retains both values and records that they differ, without
    # selecting either.  It is not a silent last-write-wins path.
    compare_output = scalar_output("compare_value", "p3c.conflict.compare", None,
                                   state="source_conflict", refs=[a_ref, b_ref])
    compare_comparability = {
        "format_version": "wfd.source-comparability/1.0",
        "semantic_code": "p3c.conflict.compare", "unit_code": "vehicle",
        "mode": "compare", "rule_version": "p3c.selection/1.0",
        "groups": [{"business_key": "row-compare_value", "field": "value_decimal",
                    "origin_keys": sorted([a_origin, b_origin])}],
    }
    compare_digest = "sha256:" + sha(canonical(compare_comparability))
    compare_output["comparison_set"] = {
        "comparison_set_id": "cmp-compare-1",
        "input_refs": [a_ref, b_ref],
        "comparability_contract_ref": {
            "kind": "contract", "dataset_id": DATASET,
            "namespace": "wfd.product", "id": "cmp_" + compare_digest[7:31],
            "version": "v_" + compare_digest[7:23], "digest": compare_digest,
            "resolution": "pinned", "required": True, "dependency_type": "read"},
        "decisions": [
            {"candidate_ref": "cand_alpha", "selection_status": "unresolved",
             "affected_scope": {"business_key": "row-compare_value",
                                "field": "value_decimal"},
             "reason_code": "comparison_result_differs"},
            {"candidate_ref": "cand_beta", "selection_status": "unresolved",
             "affected_scope": {"business_key": "row-compare_value",
                                "field": "value_decimal"},
             "reason_code": "comparison_result_differs"},
        ],
    }
    compare_lineage = [lineage_for("alpha", a_digest, "10.00", "row-compare_value"),
                       lineage_for("beta", b_digest, "10.50", "row-compare_value")]
    compare_doc = request(
        [compare_output], request_id="p3c-conflict-compare",
        source_roles={"compare_value": [
            {"source_id": "alpha", "roles": ["first_publisher"]},
            {"source_id": "beta", "roles": ["first_publisher"]}]},
        extension_outputs={"compare_value": {
            "read_dependencies": [], "source_lineage": compare_lineage,
            "conflict_resolution": {
                "comparison_set_id": "cmp-compare-1", "mode": "compare",
                "rule_version": "p3c.selection/1.0",
                "comparability": compare_comparability,
                "candidates": [
                    {"candidate_ref": "cand_alpha", "source_id": "alpha",
                     "business_key": "row-compare_value", "field": "value_decimal",
                     "value_state": "valid_value", "value": "10.00",
                     "evidence_ref_ids": [a_ref["ref_id"]]},
                    {"candidate_ref": "cand_beta", "source_id": "beta",
                     "business_key": "row-compare_value", "field": "value_decimal",
                     "value_state": "valid_value", "value": "10.50",
                     "evidence_ref_ids": [b_ref["ref_id"]]},
                ],
            }}},
        source_ids=["alpha", "beta"], parent=preserve["snapshot_id"])
    compare = service.submit(compare_doc)
    assert compare["status"] == "published_formal", compare
    compare_row = service.read(compare["output_results"][0]["product_id"],
                               snapshot_id=compare["snapshot_id"])["rows"][0]
    compare_conflict = compare_row["source_binding"]["source_conflicts"][0]
    assert compare_conflict["resolution"] == "compare"
    assert compare_conflict["outcome"] == "compared_different"
    assert compare_conflict["selected_candidate_ref"] is None
    assert compare_row["row"]["value_state"] == "source_conflict"

    # Same semantic_code with a different unit is a breaking definition, not
    # a merge with the selected conflict product.
    distinct_output = scalar_output("distinct_value", "p3c.conflict.value", "1",
                                    unit="share", refs=[a_ref])
    distinct_doc = request(
        [distinct_output], request_id="p3c-conflict-distinct",
        source_roles={"distinct_value": [
            {"source_id": "alpha", "roles": ["first_publisher"]}]},
        extension_outputs={"distinct_value": {"read_dependencies": []}},
        source_ids=["alpha"], parent=compare["snapshot_id"])
    distinct = service.submit(distinct_doc)
    assert distinct["status"] == "published_formal", distinct
    assert distinct["output_results"][0]["product_id"] != result["output_results"][0]["product_id"]


def _derived_doc(input_pid, input_sid, input_digest, *, processing_ref, request_id,
                 inputs=None, method=None):
    output = scalar_output("derived_ma", "p3c.derived.ma", "101.0000",
                           unit="cny_per_share", nature="derived",
                           refs=[processing_ref])
    method = method or {
        "method_id": "sma", "version": "1.0",
        "declaration": {"name": "simple_moving_average", "window": 3,
                        "rounding": "0.0001 half up"},
        "code": "def sma(values, window):\n    return [sum(values[i-window+1:i+1]) / window for i in range(len(values))]",
        "code_format": "python",
        "parameter_version": "1.0", "parameters": {"window": 3, "field": "close"},
    }
    return request(
        [output], request_id=request_id,
        source_roles={"derived_ma": [
            {"source_id": "alpha", "roles": ["first_publisher"]}]},
        extension_outputs={"derived_ma": {
            "read_dependencies": [],
            "derived_lineage": {
                "method": method,
                "inputs": inputs if inputs is not None else [{
                    "dataset_id": DATASET, "product_id": input_pid,
                    "snapshot_id": input_sid, "content_digest": input_digest}],
                "processing_evidence": [processing_ref],
                "warmup": {"required_observations": 1, "available_observations": 8,
                           "status": "sufficient"},
                "validity": {"state": "valid"},
            }}},
        source_ids=["alpha"])


def _input_product(service, tmp_path):
    ref = evidence(service, tmp_path, "input_series.txt",
                   "Synthetic close series for P3c derived-input admission.")
    rows = [{"business_key": f"d{i}", "close": f"{99 + i}.00"} for i in range(1, 9)]
    output = tabular_output("close_series", "p3c.input.close", rows, refs=[ref])
    doc = request(
        [output], request_id="p3c-input-product",
        source_roles={"close_series": [
            {"source_id": "alpha", "roles": ["first_publisher", "deliverer"]}]},
        extension_outputs={"close_series": {"read_dependencies": []}},
        source_ids=["alpha"])
    result = service.submit(doc)
    assert result["status"] == "published_formal", result
    pid, sid = result["output_results"][0]["product_id"], result["snapshot_id"]
    read = service.read(pid, snapshot_id=sid)
    return pid, sid, read["products"][0]["content_digest"], doc, output, rows


def test_missing_or_wrong_input_and_unverifiable_method_are_rejected(tmp_path):
    service = make_p3c_service(tmp_path)
    input_pid, input_sid, input_digest, _, _, _ = _input_product(service, tmp_path)
    proc = evidence(service, tmp_path, "processing.log",
                    "Synthetic external processing evidence for P3c.")

    valid = _derived_doc(input_pid, input_sid, input_digest, processing_ref=proc,
                         request_id="p3c-derived-valid-shape")
    # The variants share a structurally valid shape; each is rejected for the
    # specific missing, wrong or unverifiable fact.
    cases = []
    no_input = copy.deepcopy(valid)
    no_input["request_identity"]["request_id"] = "p3c-derived-no-input"
    no_input["source_bundle"]["product_service"]["outputs"]["derived_ma"]["derived_lineage"]["inputs"] = []
    cases.append((no_input, "DERIVED_INPUT_REQUIRED"))

    wrong_digest = copy.deepcopy(valid)
    wrong_digest["request_identity"]["request_id"] = "p3c-derived-wrong-digest"
    wrong_digest["source_bundle"]["product_service"]["outputs"]["derived_ma"]["derived_lineage"]["inputs"][0]["content_digest"] = "sha256:" + "0" * 64
    cases.append((wrong_digest, "DERIVED_INPUT_DIGEST_MISMATCH"))

    no_method = copy.deepcopy(valid)
    no_method["request_identity"]["request_id"] = "p3c-derived-no-method"
    no_method["source_bundle"]["product_service"]["outputs"]["derived_ma"]["derived_lineage"]["method"] = {
        "method_id": "sma", "version": "1.0", "parameter_version": "1.0",
        "parameters": {"window": 3}}
    cases.append((no_method, "DERIVED_METHOD_NOT_VERIFIABLE"))

    foreign = copy.deepcopy(valid)
    foreign["request_identity"]["request_id"] = "p3c-derived-foreign-dataset"
    foreign["source_bundle"]["product_service"]["outputs"]["derived_ma"]["derived_lineage"]["inputs"][0] = {
        "dataset_id": "other_dataset", "product_id": input_pid,
        "snapshot_id": "s_not_in_this_store", "content_digest": input_digest}
    cases.append((foreign, "DERIVED_INPUT_DATASET_UNSUPPORTED"))

    for doc, expected in cases:
        result = service.submit(doc)
        assert result["status"] == "registered_not_published", result
        assert expected in errors(result), (expected, result)

    # Compute permission is explicit; a submitter without it cannot admit a
    # derived result.
    no_compute = WFDProductService(
        service.engine,
        allowed_sources={"alpha": policy(["first_publisher", "deliverer"])},
        caller_roles={"submit", "register", "publish", "read", "read_evidence"},
        caller_id="no-compute", unit_registry=UNITS,
        trusted_actor_namespaces={"wfd.test.curated"})
    result = no_compute.submit(copy.deepcopy(valid))
    assert result["status"] == "registered_not_published", result
    assert "CALLER_PERMISSION_DENIED" in errors(result), result


MA_SCRIPT = r'''
import hashlib
import json
import sys
from decimal import Decimal, ROUND_HALF_UP

SMA_CODE = "def sma(values, window):\n    return [sum(values[i-window+1:i+1]) / window for i in range(len(values))]"

def canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False,
                      sort_keys=True, separators=(",", ":")).encode("utf-8")

def digest(value):
    return "sha256:" + hashlib.sha256(canonical(value)).hexdigest()

spec = json.load(open(sys.argv[1], encoding="utf-8"))
window = int(spec["window"])
rows = spec["rows"]
closes = [Decimal(row["close"]) for row in rows]
out = []
for index, row in enumerate(rows):
    if index + 1 < window:
        state, value = "insufficient_warmup", None
    else:
        average = sum(closes[index - window + 1:index + 1]) / Decimal(window)
        state, value = "valid_value", format(average.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP), "f")
    out.append({"business_key": row["business_key"], "value_decimal": value,
                "value_state": state, "observation_time": row["observation_time"]})
method = {"method_id": "sma", "version": "1.0",
          "declaration": {"name": "simple_moving_average",
                          "window": window, "rounding": "0.0001 half up"},
          "code": SMA_CODE, "code_format": "python",
          "parameter_version": "1.0",
          "parameters": {"window": window, "field": "close"}}
method_digest = digest({"method_id": method["method_id"], "version": method["version"],
                        "declaration": method["declaration"]})
code_digest = digest({"code_format": method["code_format"], "code": SMA_CODE})
parameter_digest = digest({"method_id": method["method_id"], "version": method["version"],
                           "parameter_version": method["parameter_version"],
                           "parameters": method["parameters"]})
output_digest = digest({"output_key": spec["output_key"],
                        "logical_domain": spec["logical_domain"],
                        "subject": spec["subject"],
                        "payload_kind": "scalar_rows", "rows": out})
record = {"format_version": "wfd.external-processing/1.0",
          "output_key": spec["output_key"],
          "input_digests": sorted(spec["input_digests"]),
          "method_digest": method_digest,
          "method_code_digest": code_digest,
          "parameter_digest": parameter_digest,
          "output_digest": output_digest}
method.update(digest=method_digest, code_digest=code_digest,
              parameter_digest=parameter_digest)
json.dump({"rows": out,
           "warmup": {"required_observations": window,
                      "available_observations": len(rows), "status": "partial"},
           "validity": {"state": "partial"},
           "method": method,
           "processing_record": record},
          open(sys.argv[2], "w", encoding="utf-8"))
'''


@pytest.fixture(scope="module")
def derived_case(tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("p3c_derived")
    service = make_p3c_service(tmp_path)
    input_pid, input_sid, input_digest, input_doc, input_output, rows = _input_product(
        service, tmp_path)
    input_read = service.read(input_pid, snapshot_id=input_sid)
    subject = {"kind": "physical_object", "namespace": "p3c.test", "id": "metric"}

    script_path = tmp_path / "external_sma.py"
    script_path.write_text(MA_SCRIPT, encoding="utf-8")
    input_json = tmp_path / "ma_input.json"
    output_json = tmp_path / "ma_output.json"
    input_json.write_text(json.dumps({
        "window": 3,
        "input_digests": [input_digest],
        "output_key": "derived_ma3",
        "logical_domain": "observations",
        "subject": subject,
        "rows": [{"business_key": item["record_ref"]["logical_key"],
                  "close": item["row"]["values"]["close"]["value"],
                  "observation_time": item["row"]["observation_time"]}
                 for item in input_read["rows"]]}), encoding="utf-8")
    subprocess.run([sys.executable, str(script_path), str(input_json), str(output_json)],
                   check=True, cwd=tmp_path)
    computed = json.loads(output_json.read_text("utf-8"))
    script_ref = service.register_evidence(script_path)
    output_ref = service.register_evidence(output_json)
    input_ref = input_output["evidence_refs"][0]

    derived_output = scalar_output("derived_ma3", "p3c.derived.ma3", None,
                                   unit="cny_per_share", nature="derived",
                                   refs=[script_ref, output_ref, input_ref])
    derived_output["payload"] = {"kind": "scalar_rows", "rows": [
        {"business_key": item["business_key"],
         "value_decimal": item["value_decimal"],
         "value_state": item["value_state"],
         "observation_time": item["observation_time"]}
        for item in computed["rows"]]}
    derived_output["coverage"] = {"scope": {"sample_only": True},
                                  "basis": "observed_partial", "completeness": "partial",
                                  "coverage_evidence": [], "absence_means": "unknown"}
    derived_doc = request(
        [derived_output], request_id="p3c-derived-external-ma",
        source_roles={"derived_ma3": [
            {"source_id": "beta", "roles": ["first_publisher", "deliverer"]}]},
        extension_outputs={"derived_ma3": {
            "read_dependencies": [],
            "derived_lineage": {
                "method": computed["method"],
                "inputs": [{"dataset_id": DATASET, "product_id": input_pid,
                            "snapshot_id": input_sid, "content_digest": input_digest}],
                "processing_evidence": [script_ref, output_ref],
                "warmup": computed["warmup"],
                "validity": computed["validity"],
            }}},
        source_ids=["beta"], parent=input_sid)
    submitted = service.submit(derived_doc)
    assert submitted["status"] == "published_formal", submitted
    return {"service": service, "tmp_path": tmp_path, "submitted": submitted,
            "derived_doc": derived_doc, "computed": computed,
            "input_pid": input_pid, "input_sid": input_sid,
            "input_digest": input_digest, "input_doc": input_doc,
            "input_output": input_output, "rows": rows}


def test_external_short_ma_result_is_formally_admitted_and_fixed_read_back(derived_case):
    service = derived_case["service"]
    submitted = derived_case["submitted"]
    computed = derived_case["computed"]
    pid, sid = submitted["output_results"][0]["product_id"], submitted["snapshot_id"]
    read = service.read(pid, snapshot_id=sid)
    assert len(read["rows"]) == 8
    by_key = {item["record_ref"]["logical_key"]: item for item in read["rows"]}
    assert by_key["d1"]["row"]["value_state"] == "insufficient_warmup"
    assert by_key["d2"]["row"]["value_state"] == "insufficient_warmup"
    assert by_key["d1"]["row"]["value_decimal"] is None
    assert by_key["d2"]["row"]["value_decimal"] is None
    for item in computed["rows"]:
        if item["value_state"] == "valid_value":
            assert by_key[item["business_key"]]["row"]["value_decimal"] == item["value_decimal"]
            assert by_key[item["business_key"]]["row"]["value_decimal"] != "0"
    product = read["products"][0]
    lineage = product["derived_lineage"]
    assert lineage["computation"] == "external"
    assert lineage["inputs"][0]["snapshot_id"] == derived_case["input_sid"]
    assert lineage["inputs"][0]["content_digest"] == derived_case["input_digest"]
    assert lineage["inputs"][0]["source_ids"] == ["alpha"]
    assert lineage["input_source_ids"] == ["alpha"]
    assert lineage["method"]["method_id"] == "sma"
    assert lineage["method"]["code_digest"].startswith("sha256:")
    assert lineage["processing_record"]["content_sha256"].startswith("sha256:")
    assert product["contracts"]["compute_dependencies"]["execution"] == "external"
    assert product["contracts"]["compute_dependencies"]["lineage_ref"]["digest"] == lineage["lineage_digest"]
    assert product["derived_stale_basis"]["basis_state"] == "current"
    assert by_key["d1"]["source_binding"]["derived_lineage_digest"] == lineage["lineage_digest"]

    # The output source is beta, but the pinned input source alpha remains a
    # read obligation.  A beta-only reader cannot wash it away.
    reader = WFDProductService(
        service.engine,
        allowed_sources={"alpha": policy(["first_publisher", "deliverer"]),
                         "beta": policy(["first_publisher", "deliverer"])},
        caller_roles={"read", "read_evidence"}, caller_id="beta-only-reader",
        unit_registry=UNITS, trusted_actor_namespaces={"wfd.test.curated"})
    reader.allowed_sources["alpha"]["may_read"] = False
    with pytest.raises(PermissionError, match="SOURCE_READ_PERMISSION_MISSING:alpha"):
        reader.read(pid, snapshot_id=sid)


def test_input_correction_leaves_the_old_derived_result_fixed(derived_case):
    service = derived_case["service"]
    submitted = derived_case["submitted"]
    derived_pid, derived_sid = submitted["output_results"][0]["product_id"], submitted["snapshot_id"]
    before = service.read(derived_pid, snapshot_id=derived_sid)
    before_values = {item["record_ref"]["logical_key"]: item["row"]["value_decimal"]
                     for item in before["rows"]}
    before_lineage = before["products"][0]["derived_lineage"]
    before_input_digest = derived_case["input_digest"]

    input_read = service.read(derived_case["input_pid"], snapshot_id=derived_case["input_sid"],
                              include_history=True)
    previous = next(item for item in input_read["rows"]
                    if item["record_ref"]["logical_key"] == "d5")
    correction_output = copy.deepcopy(derived_case["input_output"])
    correction_output["input_mode"] = "source_correction"
    correction_output["definition_mode"] = "reuse"
    # The input product's definition_ref is read from the fixed product record.
    input_product = input_read["products"][0]
    correction_output["definition_ref"] = input_product["definition_ref"]
    correction_output["new_definition_declaration"] = None
    correction_output["payload"] = {"kind": "tabular_rows", "rows": [{
        "business_key": "d5", "subject": correction_output["subject"],
        "observation_time": known_time(2024),
        "values": {"close": {"data_type": "decimal", "value_state": "valid_value",
                              "value": "114.00"}}}]}
    correction = request(
        [correction_output], request_id="p3c-input-correction",
        source_roles={"close_series": [
            {"source_id": "alpha", "roles": ["first_publisher", "deliverer"]}]},
        extension_outputs={"close_series": {
            "read_dependencies": [],
            "revisions": {"d5": {
                "previous": {"product_id": derived_case["input_pid"],
                              "snapshot_id": derived_case["input_sid"],
                              "logical_key": "d5",
                              "revision_id": previous["record_ref"]["revision_id"]},
                "reason": "Corrected close for P3c input revision"}}}},
        source_ids=["alpha"], parent=derived_sid)
    corrected = service.submit(correction)
    assert corrected["status"] == "published_formal", corrected
    corrected_sid = corrected["snapshot_id"]

    old_again = service.read(derived_pid, snapshot_id=derived_sid)
    old_values = {item["record_ref"]["logical_key"]: item["row"]["value_decimal"]
                  for item in old_again["rows"]}
    assert old_values == before_values
    assert old_again["products"][0]["derived_lineage"] == before_lineage
    assert old_again["products"][0]["derived_stale_basis"]["basis_state"] == "current"

    current = service.read(derived_pid, snapshot_id=corrected_sid)
    current_values = {item["record_ref"]["logical_key"]: item["row"]["value_decimal"]
                      for item in current["rows"]}
    assert current_values == before_values
    current_product = current["products"][0]
    assert current_product["derived_lineage"]["inputs"][0]["content_digest"] == before_input_digest
    assert current_product["derived_lineage"]["inputs"][0]["snapshot_id"] == derived_case["input_sid"]
    assert current_product["derived_stale_basis"]["basis_state"] == "input_changed"
    assert current_product["derived_stale_basis"]["inputs"][0]["changed_since_pin"] is True
    assert current_product["derived_stale_basis"]["decision_owner"] == "P4"

    input_now = service.read(derived_case["input_pid"], snapshot_id=corrected_sid)
    corrected_row = next(item for item in input_now["rows"]
                         if item["record_ref"]["logical_key"] == "d5")
    assert corrected_row["row"]["values"]["close"]["value"] == "114.00"
