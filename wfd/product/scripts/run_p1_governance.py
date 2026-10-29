#!/usr/bin/env python3
"""Small P1 evidence run: new definition, formal publication, new-instance readback."""
from __future__ import annotations

import copy
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
PROJECT = ENGINE.parents[1]
sys.path.insert(0, str(ENGINE))

from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator  # noqa: E402
from wfd_sdk.product_service import WFDProductService, SERVICE_VERSION  # noqa: E402


ROLES = {"evidence_write", "register", "submit", "publish", "read", "read_evidence", "export", "redistribute"}
SOURCE = {
    "may_submit": True,
    "may_publish_formal": True,
    "may_read": True,
    "may_read_evidence": True,
    "may_export": True,
    "may_export_evidence": True,
    "export_scope": "user_local_validation_only",
    "usage_scope": "p1_contract_validation",
    "license": "test_only",
    "may_redistribute": False,
}
EVIDENCE = PROJECT / "03_测试与验证记录" / "P1_正式契约与治理_2026-10-27"
RUN = EVIDENCE / ("run_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")


def service(root, runtime, roles, caller):
    engine = WFDDuckDBPrototype(
        root, load_protocol_validator(ENGINE / "protocol"),
        runtime_root=runtime, sandbox=False, writer_host=caller,
    )
    return WFDProductService(
        engine, allowed_sources={"p1_fixture": copy.deepcopy(SOURCE)},
        caller_roles=roles, caller_id=caller,
        unit_registry={"vehicle": {"dimension": "quantity"}},
        trusted_actor_namespaces={"wfd.p1.validation"},
    )


def main():
    RUN.mkdir(parents=True, exist_ok=False)
    store = RUN / "store"
    source_path = RUN / "source.txt"
    source_path.write_text("P1 contract governance fixture; not a financial fact.\n", "utf-8")
    writer = service(store, RUN / "runtime_writer", ROLES, "p1-writer")
    evidence = writer.register_evidence(source_path)
    doc = json.loads((ENGINE / "fixtures/port_annual_autos.json").read_text("utf-8"))
    doc["request_identity"] = {
        "dataset_id": "p1_contract_validation",
        "trusted_actor_namespace": "wfd.p1.validation",
        "request_id": "p1-new-definition-" + RUN.name,
        "submission_digest": "sha256:" + "0" * 64,
    }
    doc["source_bundle"] = {"source_id": "p1_fixture", "source_ids": ["p1_fixture"],
                            "license": "test_only", "usage_scope": "p1_contract_validation"}
    doc["outputs"][0]["new_definition_declaration"] = {
        "semantic_code": "p1.port.automobiles.handled",
        "measurement_nature": "flow",
        "unit_code": "vehicle",
        "definition_authority": "p1.validation",
        "time_role": "statistical_period",
    }
    doc["outputs"][0]["evidence_refs"] = [evidence]
    doc["source_bundle"]["product_service"] = {
        "version": SERVICE_VERSION,
        "outputs": {doc["outputs"][0]["output_key"]: {"read_dependencies": []}},
    }
    result = writer.submit(doc)
    if result.get("status") != "published_formal":
        save(RUN / "summary.json", {"result": result, "failure": "formal publication not reached"})
        raise SystemExit("P1_EVIDENCE_FAILED: " + result.get("status", "unknown"))
    item = result["output_results"][0]
    pid, sid = item["product_id"], result["snapshot_id"]
    receipt_path = store / result["formal_publication_receipt"] if result.get("formal_publication_receipt") else None
    formal = json.loads(receipt_path.read_text("utf-8")) if receipt_path and receipt_path.is_file() else None

    reader = service(store, RUN / "runtime_reader", {"read", "read_evidence"}, "p1-reader")
    rows = reader.read(pid, snapshot_id=sid)["rows"]
    trace = reader.trace(pid, snapshot_id=sid)
    request_state = reader.request_status(doc["request_identity"])
    product = next(p for p in reader.discover_products(snapshot_id=sid)["products"] if p["product_id"] == pid)
    summary = {
        "status": "complete",
        "service_version": SERVICE_VERSION,
        "run_dir": str(RUN.relative_to(PROJECT)),
        "store": str(store.relative_to(PROJECT)),
        "request_identity": doc["request_identity"],
        "product_id": pid,
        "snapshot_id": sid,
        "definition_sequence": product.get("definition_sequence"),
        "definition_compatibility": product.get("definition_compatibility"),
        "contract_part_digests": product["contracts"].get("part_digests"),
        "formal_publication_receipt": str(receipt_path.relative_to(PROJECT)) if receipt_path else None,
        "formal_publication_verified": bool(formal),
        "formal_checks": formal.get("checks") if formal else None,
        "raw_engine_status": formal.get("raw_engine_status") if formal else None,
        "read_rows": len(rows),
        "trace_evidence_verified": all(x["verified"] for x in trace["evidence"]),
        "request_state": request_state.get("state"),
        "request_phases": request_state.get("phases"),
        "production_publishable": result.get("production_publishable"),
        "source_permissions": SOURCE,
    }
    if summary["formal_publication_verified"] is not True:
        raise SystemExit("P1_EVIDENCE_FAILED: formal receipt missing")
    if summary["read_rows"] != 3 or summary["trace_evidence_verified"] is not True:
        raise SystemExit("P1_EVIDENCE_FAILED: independent readback/evidence mismatch")
    if summary["request_state"] != "published_formal":
        raise SystemExit("P1_EVIDENCE_FAILED: request state not formal")
    save(RUN / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
