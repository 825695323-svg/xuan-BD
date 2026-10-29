"""P3 batch ledger checks: no second submit kernel, one ordinary final request."""
import copy
import json
from pathlib import Path

import pytest

from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_service import SERVICE_VERSION, WFDProductService
from wfd_sdk.product_batches import (
    BatchChunkConflict, BatchConflict, BatchIncomplete, BatchLimit, BatchPermission,
    ProductBatchLedger,
)


HERE = Path(__file__).resolve().parents[1]
ROLES = {"evidence_write", "register", "submit", "publish", "read", "read_evidence"}
POLICY = {
    "may_submit": True, "may_publish_formal": True, "may_read": True,
    "may_read_evidence": True, "export_scope": "test_only", "usage_scope": "test_only",
    "allowed_roles": ["compiler", "deliverer", "first_publisher"],
    "allowed_authorities": ["test.project"],
}
UNIT_REGISTRY = {"count": {"dimension": "quantity"}}
TIME = {"status": "known", "precision": "year", "earliest_utc": "2024-01-01T00:00:00Z",
        "latest_exclusive_utc": "2025-01-01T00:00:00Z", "source_timezone": "UTC"}


def service(tmp_path, caller="batch-a", namespace="wfd.test.batch"):
    engine = WFDDuckDBPrototype(tmp_path / "store", load_protocol_validator(HERE / "protocol"),
                                runtime_root=tmp_path / ("runtime_" + caller), sandbox=False,
                                writer_host=caller)
    return WFDProductService(engine, allowed_sources={"fixture": copy.deepcopy(POLICY)},
                             caller_roles=ROLES, caller_id=caller,
                             unit_registry=UNIT_REGISTRY,
                             trusted_actor_namespaces={namespace})


def header_for(svc, batch_id, scope="first", rows_in_header=False):
    ev = svc.register_evidence(HERE / "tests/expect.json") if not hasattr(svc, "_batch_ev") else svc._batch_ev
    svc._batch_ev = ev
    header = {
        "protocol_version": "wfd.ingest/1.3-candidate",
        "request_identity": {"dataset_id": "batch_test", "trusted_actor_namespace": "wfd.test.batch",
                             "request_id": batch_id, "submission_digest": "sha256:" + "0" * 64},
        "intent": "submit", "producer_namespace": "wfd.test.batch",
        "expected_parent_snapshot_id": None,
        "outputs": [{
            "output_key": "batch_metric", "logical_domain": "observations",
            "subject": {"kind": "entity", "namespace": "wfd.test.batch", "id": "company_a"},
            "definition_mode": "create", "definition_ref": None,
            "new_definition_declaration": {
                "semantic_code": "test.batch.metric", "measurement_nature": "flow",
                "unit_code": "count", "definition_authority": "test.project.batch",
                "time_role": "observation"},
            "input_mode": "partial_observation",
            "coverage": {"scope": {"set": scope}, "basis": "observed_partial",
                         "completeness": "partial", "coverage_evidence": [ev],
                         "absence_means": "unknown"},
            "payload": {"kind": "scalar_rows", "rows": [{"x": "not-allowed"}] if rows_in_header else []},
            "evidence_refs": [ev],
        }],
        "source_bundle": {
            "source_id": "fixture", "source_ids": ["fixture"],
            "source_roles": {"batch_metric": [{"source_id": "fixture",
                                               "roles": ["compiler", "deliverer"]}]},
            "license": "test_only", "usage_scope": "test_only",
            "raw_source_bytes_custodied": True,
            "product_service": {"version": SERVICE_VERSION,
                                "outputs": {"batch_metric": {"read_dependencies": []}}},
        },
    }
    return header


def chunk_row(key, value):
    return {"business_key": key, "value_decimal": value, "value_state": "valid_value",
            "observation_time": TIME}


def expected():
    return [{"output_key": "batch_metric", "chunk_id": "c2"},
            {"output_key": "batch_metric", "chunk_id": "c1"},
            {"output_key": "batch_metric", "chunk_id": "c3"}]


def test_out_of_order_duplicate_conflict_and_finalize(tmp_path):
    svc = service(tmp_path)
    ledger = ProductBatchLedger(svc, max_chunks=3, max_rows=10, max_bytes=100000)
    h = header_for(svc, "b-out-of-order")
    status = ledger.begin("b-out-of-order", header=h, expected_chunks=expected())
    assert status["phase"] == "collecting" and len(status["missing"]) == 3
    ledger.put_chunk("b-out-of-order", output_key="batch_metric", chunk_id="c2",
                     rows=[chunk_row("k2", "2")])
    status = ledger.status("b-out-of-order")
    assert status["received_chunks"] == 1 and status["per_output"]["batch_metric"]["received_rows"] == 1
    # Same chunk/content is idempotent.
    ledger.put_chunk("b-out-of-order", output_key="batch_metric", chunk_id="c2",
                     rows=[chunk_row("k2", "2")])
    assert ledger.status("b-out-of-order")["received_chunks"] == 1
    # Same chunk/different content is rejected and the original digest is kept.
    with pytest.raises(BatchChunkConflict):
        ledger.put_chunk("b-out-of-order", output_key="batch_metric", chunk_id="c2",
                         rows=[chunk_row("k2", "9")])
    assert ledger.status("b-out-of-order")["received"][0]["digest"] == \
        next(item["digest"] for item in ledger.status("b-out-of-order")["received"])
    ledger.put_chunk("b-out-of-order", output_key="batch_metric", chunk_id="c1",
                     rows=[chunk_row("k1", "1")])
    with pytest.raises(BatchIncomplete):
        ledger.finalize("b-out-of-order")
    assert svc.request_status(h["request_identity"])["state"] == "unknown"
    ledger.put_chunk("b-out-of-order", output_key="batch_metric", chunk_id="c3",
                     rows=[chunk_row("k3", "3")])
    result = ledger.finalize("b-out-of-order")
    assert result["status"] == "published_formal"
    assert result["snapshot_id"]
    assert [row["row"]["business_key"] for row in svc.read(
        result["output_results"][0]["product_id"], snapshot_id=result["snapshot_id"])["rows"]] == \
        ["k2", "k1", "k3"]
    # Finalize retry returns the same actual snapshot, not a new submit.
    again = ledger.finalize("b-out-of-order")
    assert again["snapshot_id"] == result["snapshot_id"]


def test_new_instance_reads_status_and_recovers(tmp_path):
    svc = service(tmp_path, caller="batch-a")
    ledger = ProductBatchLedger(svc)
    h = header_for(svc, "b-recover")
    ledger.begin("b-recover", header=h, expected_chunks=expected())
    ledger.put_chunk("b-recover", output_key="batch_metric", chunk_id="c1",
                     rows=[chunk_row("k1", "1")])
    # New service instance, same caller/namespace: status survives; missing chunk blocks.
    svc2 = service(tmp_path, caller="batch-a")
    ledger2 = ProductBatchLedger(svc2)
    status = ledger2.status("b-recover")
    assert status["phase"] == "collecting" and status["received_chunks"] == 1
    with pytest.raises(BatchIncomplete):
        ledger2.finalize("b-recover")
    assert svc2.request_status(h["request_identity"])["state"] == "unknown"
    ledger2.put_chunk("b-recover", output_key="batch_metric", chunk_id="c2",
                      rows=[chunk_row("k2", "2")])
    ledger2.put_chunk("b-recover", output_key="batch_metric", chunk_id="c3",
                      rows=[chunk_row("k3", "3")])
    result = ledger2.finalize("b-recover")
    assert result["status"] == "published_formal"


def test_return_loss_recovery_uses_request_status_without_resubmit(tmp_path, monkeypatch):
    svc = service(tmp_path)
    ledger = ProductBatchLedger(svc)
    h = header_for(svc, "b-loss")
    ledger.begin("b-loss", header=h, expected_chunks=expected())
    for chunk_id, key, value in [("c1", "k1", "1"), ("c2", "k2", "2"), ("c3", "k3", "3")]:
        ledger.put_chunk("b-loss", output_key="batch_metric", chunk_id=chunk_id,
                         rows=[chunk_row(key, value)])
    original = svc.submit
    calls = {"n": 0}
    def lossy(doc):
        calls["n"] += 1
        original(doc)
        raise RuntimeError("simulated return loss after commit")
    monkeypatch.setattr(svc, "submit", lossy)
    first = ledger.finalize("b-loss")
    assert first["phase"] == "submit_unknown"
    assert calls["n"] == 1
    monkeypatch.setattr(svc, "submit", original)
    second = ledger.finalize("b-loss")
    assert second["status"] == "published_formal"
    assert second["recovered_from_request_status"] is True
    assert calls["n"] == 1
    assert second["snapshot_id"] == svc.request_status(h["request_identity"])["snapshot_id"]


def test_permissions_identity_and_batch_id_conflicts(tmp_path):
    svc = service(tmp_path, caller="batch-a")
    ledger = ProductBatchLedger(svc)
    h = header_for(svc, "b-perm")
    ledger.begin("b-perm", header=h, expected_chunks=expected())
    ledger.put_chunk("b-perm", output_key="batch_metric", chunk_id="c1",
                     rows=[chunk_row("k1", "1")])
    # Another caller cannot read or write the same batch id.
    other = service(tmp_path, caller="batch-b")
    other_ledger = ProductBatchLedger(other)
    assert other_ledger.status("b-perm")["status"] == "not_found"
    with pytest.raises(Exception):
        other_ledger.put_chunk("b-perm", output_key="batch_metric", chunk_id="c2",
                               rows=[chunk_row("k2", "2")])
    assert ledger.status("b-perm")["received_chunks"] == 1
    # Same batch id with a different fixed header/manifest is rejected.
    changed = header_for(svc, "b-perm", scope="different")
    with pytest.raises(BatchConflict):
        ProductBatchLedger(svc).begin("b-perm", header=changed, expected_chunks=expected())
    assert ledger.status("b-perm")["received_chunks"] == 1
    # A header carrying rows is not a structured batch header.
    with pytest.raises(Exception):
        ProductBatchLedger(svc).begin("b-header-rows",
                                      header=header_for(svc, "b-header-rows", rows_in_header=True),
                                      expected_chunks=expected())


def test_budget_limits_are_trusted(tmp_path):
    svc = service(tmp_path)
    ledger = ProductBatchLedger(svc, max_chunks=2, max_rows=2, max_bytes=5000)
    h = header_for(svc, "b-budget")
    with pytest.raises(BatchLimit):
        ledger.begin("b-budget", header=h, expected_chunks=expected())
    ledger2 = ProductBatchLedger(svc, max_chunks=3, max_rows=1, max_bytes=5000)
    ledger2.begin("b-budget2", header=header_for(svc, "b-budget2"), expected_chunks=expected())
    ledger2.put_chunk("b-budget2", output_key="batch_metric", chunk_id="c1",
                      rows=[chunk_row("k1", "1")])
    with pytest.raises(BatchLimit):
        ledger2.put_chunk("b-budget2", output_key="batch_metric", chunk_id="c2",
                          rows=[chunk_row("k2", "2")])


def test_identity_recovery_is_fingerprint_bound(tmp_path):
    svc = service(tmp_path, caller="batch-a")
    h = header_for(svc, "same-core-id")
    original_doc = copy.deepcopy(h)
    original_doc["outputs"][0]["payload"]["rows"] = [chunk_row("original", "1")]
    prior = svc.submit(original_doc)
    assert prior["status"] == "published_formal"
    other = service(tmp_path, caller="batch-b")
    other_ledger = ProductBatchLedger(other)
    changed = header_for(other, "same-core-id", scope="different_batch_contents")
    other_ledger.begin("same-core-id", header=changed,
                       expected_chunks=[{"output_key": "batch_metric", "chunk_id": "c1"}])
    other_ledger.put_chunk("same-core-id", output_key="batch_metric", chunk_id="c1",
                           rows=[chunk_row("different", "999")])
    with pytest.raises(BatchConflict):
        other_ledger.finalize("same-core-id")
    # The original formal product is untouched and the other owner is not finalized.
    assert other_ledger.status("same-core-id")["phase"] == "ready"
    read = svc.read(prior["output_results"][0]["product_id"], snapshot_id=prior["snapshot_id"])
    assert read["rows"][0]["row"]["business_key"] == "original"


def test_source_role_revocation_is_preflight_then_resumable(tmp_path):
    svc = service(tmp_path, caller="batch-a")
    ledger = ProductBatchLedger(svc)
    h = header_for(svc, "role-preflight")
    ledger.begin("role-preflight", header=h,
                 expected_chunks=[{"output_key": "batch_metric", "chunk_id": "c1"}])
    ledger.put_chunk("role-preflight", output_key="batch_metric", chunk_id="c1",
                     rows=[chunk_row("k1", "1")])
    svc.allowed_sources["fixture"]["allowed_roles"] = ["acquirer"]
    first = ledger.finalize("role-preflight")
    assert first["status"] == "preflight_rejected"
    assert first["preflight_rejected"] is True
    assert svc.request_status(h["request_identity"])["state"] == "unknown"
    assert ledger.status("role-preflight")["received_chunks"] == 1
    assert ledger.status("role-preflight")["last_attempt"]["errors"][0]["code"] == "SOURCE_ROLE_DENIED"
    svc.allowed_sources["fixture"]["allowed_roles"] = list(POLICY["allowed_roles"])
    second = ledger.finalize("role-preflight")
    assert second["status"] == "published_formal"


def test_namespace_revocation_blocks_put_and_finalize_then_resumes(tmp_path):
    svc = service(tmp_path, caller="batch-a")
    ledger = ProductBatchLedger(svc)
    h = header_for(svc, "namespace-revoke")
    ledger.begin("namespace-revoke", header=h,
                 expected_chunks=[{"output_key": "batch_metric", "chunk_id": "c1"}])
    svc.trusted_actor_namespaces = frozenset()
    with pytest.raises(BatchPermission):
        ledger.put_chunk("namespace-revoke", output_key="batch_metric", chunk_id="c1",
                         rows=[chunk_row("k1", "1")])
    assert ledger.status("namespace-revoke")["received_chunks"] == 0
    first = ledger.finalize("namespace-revoke")
    assert first["status"] == "preflight_rejected"
    assert first["errors"][0]["code"] == "BATCH_NAMESPACE_UNTRUSTED"
    svc.trusted_actor_namespaces = frozenset({"wfd.test.batch"})
    ledger.put_chunk("namespace-revoke", output_key="batch_metric", chunk_id="c1",
                     rows=[chunk_row("k1", "1")])
    second = ledger.finalize("namespace-revoke")
    assert second["status"] == "published_formal"


def test_aggregate_payload_budget_counts_header_manifest_and_chunks(tmp_path):
    svc = service(tmp_path)
    h = header_for(svc, "aggregate-byte")
    h["source_bundle"]["audit_padding"] = "x" * 500
    manifest = [{"output_key": "batch_metric", "chunk_id": "c1"}]
    header_bytes = len(json.dumps(h, ensure_ascii=False, sort_keys=True,
                                  separators=(",", ":")).encode())
    manifest_bytes = len(json.dumps(manifest, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode())
    rows = [chunk_row("k1", "1")]
    row_bytes = len(json.dumps(rows, ensure_ascii=False, sort_keys=True,
                               separators=(",", ":")).encode())
    # Header + manifest alone must be counted: this cannot even begin.
    with pytest.raises(BatchLimit):
        ProductBatchLedger(svc, max_chunks=1, max_rows=10,
                           max_bytes=header_bytes + manifest_bytes - 1).begin(
            "aggregate-byte", header=h, expected_chunks=manifest)
    # Header + manifest fit; the chunk pushes the cumulative payload over.
    ledger = ProductBatchLedger(svc, max_chunks=1, max_rows=10,
                                max_bytes=header_bytes + manifest_bytes + row_bytes - 1)
    ledger.begin("aggregate-byte", header=h, expected_chunks=manifest)
    before = ledger.status("aggregate-byte")["accounting"]
    with pytest.raises(BatchLimit):
        ledger.put_chunk("aggregate-byte", output_key="batch_metric", chunk_id="c1", rows=rows)
    after = ledger.status("aggregate-byte")["accounting"]
    assert before["header_bytes"] + before["manifest_bytes"] == before["used_bytes"]
    assert after == before
    assert ledger.status("aggregate-byte")["received_chunks"] == 0
