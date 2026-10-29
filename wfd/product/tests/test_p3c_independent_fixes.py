"""Focused re-audit cases for P3c independent review blockers.

Only four negative cases are exercised here; the legal external MA positive is
the existing `test_external_short_ma_result_is_formally_admitted_and_fixed_read_back`
in test_p3c_source_conflict_derived.py (run together for this round).
"""
from __future__ import annotations

import copy

from test_p3c_source_conflict_derived import (
    DATASET, _input_product, errors, evidence, make_p3c_service, request,
    scalar_output,
)

CODE = "def custom_result(values, window):\n    return values[-1] if values else None"


def _lineage(sid, publisher, digest, value, *, values=True, business_key="row-v"):
    entry = {
        "source_id": sid, "first_publisher_id": publisher,
        "first_publication_id": "bulletin-1",
        "original_content_sha256": digest, "content_sha256": digest,
        "publication_chain": [publisher, sid],
        "evidence_ref_ids": [digest],
        "field_evidence": {"value_decimal": [digest]},
    }
    # evidence_ref_ids are replaced by the caller with actual ref ids.
    return entry


def _derived_request(input_pid, input_sid, input_digest, *, method, processing_ref,
                     request_id, source_id="alpha"):
    output = scalar_output("derived_ma", "p3c.derived.ma", "999",
                           unit="cny_per_share", nature="derived",
                           refs=[processing_ref])
    return request(
        [output], request_id=request_id,
        source_roles={"derived_ma": [
            {"source_id": source_id, "roles": ["first_publisher", "deliverer"]}]},
        extension_outputs={"derived_ma": {
            "read_dependencies": [],
            "derived_lineage": {
                "method": method,
                "inputs": [{"dataset_id": DATASET, "product_id": input_pid,
                            "snapshot_id": input_sid, "content_digest": input_digest}],
                "processing_evidence": [processing_ref],
                "warmup": {"required_observations": 1, "available_observations": 8,
                           "status": "sufficient"},
                "validity": {"state": "valid"},
            }}},
        source_ids=[source_id], parent=input_sid)


def test_unregistered_claimed_first_publishers_are_not_independent_origins(tmp_path):
    service = make_p3c_service(tmp_path)
    ref = evidence(service, tmp_path, "original.txt",
                   "Synthetic original bulletin for P3c re-audit.")
    digest = ref["content_sha256"]
    output = scalar_output("v", "p3c.audit.fake_publishers", "10.50", refs=[ref])
    lineage = []
    for index, sid in enumerate(("wire_a", "wire_b")):
        entry = _lineage(sid, f"unregistered_{index}", digest, "10.50")
        entry["evidence_ref_ids"] = [ref["ref_id"]]
        entry["field_evidence"] = {"value_decimal": [ref["ref_id"]]}
        entry["values"] = [{"business_key": "row-v", "field": "value_decimal",
                            "value_state": "valid_value", "value": "10.50"}]
        lineage.append(entry)
    result = service.submit(request(
        [output], request_id="reaudit-fake-publishers",
        source_roles={"v": [
            {"source_id": "wire_a", "roles": ["republisher", "deliverer"]},
            {"source_id": "wire_b", "roles": ["republisher", "deliverer"]}]},
        extension_outputs={"v": {"read_dependencies": [], "source_lineage": lineage}},
        source_ids=["wire_a", "wire_b"]))
    assert result["status"] == "published_formal", result
    row = service.read(result["output_results"][0]["product_id"],
                       snapshot_id=result["snapshot_id"])["rows"][0]
    attribution = row["source_binding"]["source_attribution"]
    assert len(attribution["origins"]) == 1
    assert attribution["origins"][0]["verified"] is False
    assert attribution["fields"]["value_decimal"]["independent_origin_count"] == 0
    assert attribution["fields"]["value_decimal"]["unverified_origin_count"] == 1
    assert attribution["fields"]["value_decimal"]["independence_status"] == "unconfirmed"
    assert [item["code"] for item in attribution["diagnostics"]] == [
        "SOURCE_ORIGIN_UNVERIFIED", "SOURCE_ORIGIN_UNVERIFIED"]


def test_field_evidence_without_candidate_values_cannot_bypass_comparison(tmp_path):
    service = make_p3c_service(tmp_path)
    ref = evidence(service, tmp_path, "original.txt",
                   "Synthetic original bulletin for P3c re-audit.")
    digest = ref["content_sha256"]
    output = scalar_output("v", "p3c.audit.missing_values", "999", refs=[ref])
    lineage = []
    for sid in ("wire_a", "wire_b"):
        entry = _lineage(sid, "exchange", digest, None)
        entry["evidence_ref_ids"] = [ref["ref_id"]]
        entry["field_evidence"] = {"value_decimal": [ref["ref_id"]]}
        entry["values"] = []
        lineage.append(entry)
    result = service.submit(request(
        [output], request_id="reaudit-missing-values",
        source_roles={"v": [
            {"source_id": "wire_a", "roles": ["republisher", "deliverer"]},
            {"source_id": "wire_b", "roles": ["republisher", "deliverer"]}]},
        extension_outputs={"v": {"read_dependencies": [], "source_lineage": lineage}},
        source_ids=["exchange", "wire_a", "wire_b"]))
    assert result["status"] == "registered_not_published", result
    assert "SOURCE_VALUE_ATTRIBUTION_REQUIRED" in errors(result), result


def test_fake_method_and_unrelated_processing_evidence_are_rejected(tmp_path):
    service = make_p3c_service(tmp_path)
    input_pid, input_sid, input_digest, _, _, _ = _input_product(service, tmp_path)
    unrelated = evidence(service, tmp_path, "unrelated.txt",
                         "This text is not an external processing record.")
    fake_method = {
        "method_id": "anything", "version": "1",
        "declaration": {"arbitrary": "not a formula, code, or method"},
        "parameter_version": "1", "parameters": {},
    }
    result = service.submit(_derived_request(
        input_pid, input_sid, input_digest, method=fake_method,
        processing_ref=unrelated, request_id="reaudit-fake-method"))
    assert result["status"] == "registered_not_published", result
    assert "DERIVED_METHOD_CODE_REQUIRED" in errors(result), result

    coded_method = {
        "method_id": "custom", "version": "1",
        "declaration": {"formula": "last value"},
        "code": CODE, "code_format": "python",
        "parameter_version": "1", "parameters": {"window": 3},
    }
    result = service.submit(_derived_request(
        input_pid, input_sid, input_digest, method=coded_method,
        processing_ref=unrelated, request_id="reaudit-unrelated-processing"))
    assert result["status"] == "registered_not_published", result
    assert "DERIVED_PROCESSING_RECORD_REQUIRED" in errors(result), result


def test_input_read_permission_is_required_and_not_washed_by_output_source(tmp_path):
    service = make_p3c_service(tmp_path)
    input_pid, input_sid, input_digest, _, _, _ = _input_product(service, tmp_path)
    unrelated = evidence(service, tmp_path, "processing.txt",
                         "This text is not an external processing record.")
    service.allowed_sources["alpha"]["may_read"] = False
    method = {
        "method_id": "custom", "version": "1",
        "declaration": {"formula": "last value"},
        "code": CODE, "code_format": "python",
        "parameter_version": "1", "parameters": {"window": 3},
    }
    result = service.submit(_derived_request(
        input_pid, input_sid, input_digest, method=method,
        processing_ref=unrelated, request_id="reaudit-denied-input",
        source_id="beta"))
    assert result["status"] == "registered_not_published", result
    assert "SOURCE_READ_PERMISSION_MISSING" in errors(result), result


def test_each_claiming_source_must_supply_its_own_cell_candidate(tmp_path):
    service = make_p3c_service(tmp_path)
    a_ref = evidence(service, tmp_path, "alpha.txt", "Synthetic alpha observation.")
    b_ref = evidence(service, tmp_path, "beta.txt", "Synthetic beta observation.")

    def lineage(sid, ref, value, values):
        return {
            "source_id": sid, "first_publisher_id": sid,
            "first_publication_id": sid + "-bulletin",
            "original_content_sha256": ref["content_sha256"],
            "content_sha256": ref["content_sha256"],
            "publication_chain": [sid],
            "evidence_ref_ids": [ref["ref_id"]],
            "field_evidence": {"value_decimal": [ref["ref_id"]]},
            "values": ([{"business_key": "row-v", "field": "value_decimal",
                         "value_state": "valid_value", "value": value}]
                       if values else []),
        }

    missing_output = scalar_output("v", "p3c.audit.partial_missing",
                                   "10.50", refs=[a_ref, b_ref])
    missing = service.submit(request(
        [missing_output], request_id="reaudit-one-source-missing",
        source_roles={"v": [
            {"source_id": "alpha", "roles": ["first_publisher", "deliverer"]},
            {"source_id": "beta", "roles": ["first_publisher", "deliverer"]}]},
        extension_outputs={"v": {
            "read_dependencies": [],
            "source_lineage": [lineage("alpha", a_ref, "10.50", True),
                               lineage("beta", b_ref, "10.50", False)]}},
        source_ids=["alpha", "beta"]))
    assert missing["status"] == "registered_not_published", missing
    error = missing["output_results"][0]["errors"][0]
    assert error["code"] == "SOURCE_VALUE_ATTRIBUTION_REQUIRED", missing
    assert "beta:row-v:value_decimal" in error["message"], missing

    legal_output = scalar_output("v", "p3c.audit.partial_legal",
                                 "10.50", refs=[a_ref, b_ref])
    legal = service.submit(request(
        [legal_output], request_id="reaudit-both-sources-present",
        source_roles={"v": [
            {"source_id": "alpha", "roles": ["first_publisher", "deliverer"]},
            {"source_id": "beta", "roles": ["first_publisher", "deliverer"]}]},
        extension_outputs={"v": {
            "read_dependencies": [],
            "source_lineage": [lineage("alpha", a_ref, "10.50", True),
                               lineage("beta", b_ref, "10.50", True)]}},
        source_ids=["alpha", "beta"]))
    assert legal["status"] == "published_formal", legal
    read = service.read(legal["output_results"][0]["product_id"],
                        snapshot_id=legal["snapshot_id"])
    attribution = read["rows"][0]["source_binding"]["source_attribution"]
    assert attribution["fields"]["value_decimal"]["independent_origin_count"] == 2
    assert attribution["fields"]["value_decimal"]["independence_status"] == "confirmed"
    assert read["rows"][0]["source_binding"].get("source_conflicts") is None
