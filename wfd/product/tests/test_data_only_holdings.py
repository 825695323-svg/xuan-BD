"""Ordinary local data_only publication records host-observed readability only."""
import copy
import json
from datetime import datetime, timedelta, timezone

import pytest

from test_r1_data_only import make_data_service, request, scalar_output
from wfd_sdk.product_holdings import HoldingLedger, HoldingError


def published(service, name="first", outputs=None, parent=None):
    doc = request(outputs or [scalar_output("metric", "holding.metric", "10")], name, parent=parent)
    result = service.submit(doc)
    assert result["state"] == "published_formal", result
    return doc, result


def proof_args(result, output=0):
    item = result["output_results"][output]
    return dict(snapshot_id=result["snapshot_id"], product_id=item["product_id"], records=item["records"],
                proof={"kind": "data_only_publish", "request_key": result["request_key"], "snapshot_id": result["snapshot_id"]})


def test_normal_readable_holding_and_readonly_discovery(tmp_path):
    service = make_data_service(tmp_path)
    assert service.snapshot_status()["holding_instance"] is None
    assert not (service.root / "catalog/product_service/target_instance_binding.json").exists()
    doc, result = published(service)
    binding = service.snapshot_status()["holding_instance"]
    assert set(binding) == {"instance_id", "source"}
    assert binding["source"] == "target_instance"
    assert result["holding_status"]["state"] == "recorded"
    ledger = HoldingLedger(service.root, binding["instance_id"])
    facts = ledger.facts()
    stamp = result["holding_status"]["published_readable_at"]
    assert facts[0]["records"][0]["stages"] == {"published_readable": stamp}
    assert facts[0]["proof"]["kind"] == "data_only_publish"
    pid = result["output_results"][0]["product_id"]
    read = service.read(pid, snapshot_id=result["snapshot_id"], perspective="system_held_at", at=stamp,
                        held_scope=binding["instance_id"], usable_stage="published_readable")
    assert len(read["rows"]) == 1
    assert read["rows"][0]["held_at"] == stamp
    before = (datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ") - timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with pytest.raises(ValueError, match="INSTANCE_HOLDING_NOT_YET_AVAILABLE"):
        service.read(pid, snapshot_id=result["snapshot_id"], perspective="system_held_at", at=before,
                     held_scope=binding["instance_id"], usable_stage="published_readable")
    assert service.submit(doc)["holding_status"] == result["holding_status"]
    assert ledger.facts() == facts
    reopened = make_data_service(tmp_path)
    assert reopened.snapshot_status()["holding_instance"] == binding
    assert reopened.request_status(doc["request_identity"])["holding_status"] == result["holding_status"]


def test_ledger_failure_preserves_publication_and_reuses_receipt_clock(tmp_path, monkeypatch):
    service = make_data_service(tmp_path)
    original = HoldingLedger._write
    def failed(*args, **kwargs):
        raise OSError("synthetic disk full after immutable formal receipt")
    monkeypatch.setattr(HoldingLedger, "_write", failed)
    doc, result = published(service)
    assert result["holding_status"]["state"] == "pending"
    receipt_path = service.root / result["formal_publication_ref"]
    original_receipt = receipt_path.read_bytes()
    stamp = json.loads(original_receipt)["holding"]["published_readable_at"]
    # Read-only status does not silently repair the missing ledger.
    assert service.request_status(doc["request_identity"])["holding_status"]["state"] == "pending"
    monkeypatch.setattr(HoldingLedger, "_write", original)
    recovered = service.submit(doc)
    assert recovered["state"] == "published_formal"
    assert recovered["holding_status"]["published_readable_at"] == stamp
    assert receipt_path.read_bytes() == original_receipt
    assert recovered["snapshot_id"] == result["snapshot_id"]


def test_old_receipt_without_proof_is_not_upgraded_on_retry(tmp_path):
    service = make_data_service(tmp_path)
    doc, result = published(service)
    receipt_path = service.root / result["formal_publication_ref"]
    legacy = json.loads(receipt_path.read_text()); legacy.pop("holding")
    # Explicit isolated old-format fixture, never a migration or production edit.
    receipt_path.write_text(json.dumps(legacy))
    facts = HoldingLedger(service.root, result["holding_status"]["instance_id"])
    for path in facts.dir.iterdir():
        path.unlink()
    before = receipt_path.read_bytes()
    retried = service.submit(doc)
    assert retried["state"] == "published_formal"
    assert retried["holding_status"]["state"] == "not_recorded"
    assert receipt_path.read_bytes() == before
    assert facts.facts() == []


def test_receipt_scopes_product_records_and_forbids_caller_times(tmp_path):
    service = make_data_service(tmp_path)
    a, b = scalar_output("a", "holding.a", "1"), scalar_output("b", "holding.b", "2")
    # Same logical key across independent products must never share a proof member.
    b["payload"]["rows"][0]["business_key"] = a["payload"]["rows"][0]["business_key"]
    _, result = published(service, outputs=[a, b])
    ledger = HoldingLedger(service.root, result["holding_status"]["instance_id"])
    args = proof_args(result)
    assert ledger.record_batch(**args)["product_id"] == args["product_id"]
    with pytest.raises(HoldingError, match="TIME_AUTHORITY"):
        ledger.record_batch(**args, readable_at=result["holding_status"]["published_readable_at"])
    with pytest.raises(HoldingError, match="TIME_AUTHORITY"):
        ledger.record_batch(**args, acquired_at=result["holding_status"]["published_readable_at"])
    bad = copy.deepcopy(args); bad["records"] = result["output_results"][1]["records"]
    with pytest.raises(HoldingError, match="RECORD_MISMATCH"):
        ledger.record_batch(**bad)
    bad = copy.deepcopy(args); bad["product_id"] = "missing_product"
    with pytest.raises(HoldingError, match="PRODUCT_MISMATCH"):
        ledger.record_batch(**bad)
    bad = copy.deepcopy(args); bad["proof"]["kind"] = "r2_publish"
    with pytest.raises(HoldingError):
        ledger.record_batch(**bad)


def test_crash_after_receipt_recovers_original_proof_without_new_time(tmp_path, monkeypatch):
    service = make_data_service(tmp_path)
    doc = request([scalar_output("metric", "holding.crash", "10")], "crash")
    original = service._record_formal_holdings
    def crash(record):
        raise SystemExit("synthetic crash after atomic receipt, before ledger/status")
    monkeypatch.setattr(service, "_record_formal_holdings", crash)
    with pytest.raises(SystemExit):
        service.submit(doc)
    receipts = list((service.root / "catalog/product_service/data_only_formal_publications").glob("*.json"))
    assert len(receipts) == 1
    raw = receipts[0].read_bytes()
    stamp = json.loads(raw)["holding"]["published_readable_at"]
    monkeypatch.setattr(service, "_record_formal_holdings", original)
    result = service.submit(doc)
    assert result["state"] == "published_formal"
    assert result["holding_status"]["published_readable_at"] == stamp
    assert receipts[0].read_bytes() == raw


def test_readonly_recovery_with_missing_status_does_not_repair_ledger(tmp_path, monkeypatch):
    service = make_data_service(tmp_path)
    original = HoldingLedger._write
    def failed(*args, **kwargs):
        raise OSError("synthetic ledger failure")
    monkeypatch.setattr(HoldingLedger, "_write", failed)
    doc, result = published(service)
    monkeypatch.setattr(HoldingLedger, "_write", original)
    (service.root / service._status_path(result["request_key"])).unlink()
    instance = service.snapshot_status()["holding_instance"]["instance_id"]
    ledger = HoldingLedger(service.root, instance)
    assert ledger.facts() == []
    recovered = service.request_status(doc["request_identity"])
    assert recovered["state"] == "published_formal"
    assert recovered["holding_status"]["state"] == "pending"
    assert ledger.facts() == []
    assert service.submit(doc)["holding_status"]["state"] == "recorded"


def test_p5_target_keeps_its_own_instance_and_import_stage_proof(tmp_path):
    from test_product_bundle_r2b_structured import _make_daily_slice
    from wfd_sdk.product_bundle import export_structured_bundle, import_structured_bundle
    source, service, snapshot, product = _make_daily_slice(tmp_path)
    source_instance = service.snapshot_status()["holding_instance"]["instance_id"]
    bundle = tmp_path / "bundle"
    descriptor = export_structured_bundle(service, [product], bundle, snapshot_id=snapshot,
        selection={"products": [{"product_id": product, "fields": ["close_price"]}]})
    target, report = import_structured_bundle(bundle, tmp_path / "target",
        runtime_root=tmp_path / "target-runtime", caller_roles={"read"})
    target_instance = report["instance_id"]
    assert target_instance != source_instance
    facts = HoldingLedger(target.root, target_instance).facts()
    assert facts and all(fact["proof"]["kind"] == "p5_import" for fact in facts)
    assert not (target.root / "catalog/product_service/data_only_formal_publications").exists()
    assert not (target.root / "catalog/product_service/holdings" / source_instance).exists()
    assert all(fact["instance_id"] == target_instance for fact in facts)
    assert all(fact["snapshot_id"] == report["target_snapshot_id"] for fact in facts)


def test_two_outputs_in_same_product_record_the_exact_union_once(tmp_path):
    service = make_data_service(tmp_path)
    _, initial = published(service, "seed", [scalar_output("seed", "holding.shared", "0")])
    a, b = scalar_output("a", "holding.shared", "1"), scalar_output("b", "holding.shared", "2")
    _, result = published(service, "two-members", outputs=[a, b], parent=initial["snapshot_id"])
    assert len({item["product_id"] for item in result["output_results"]}) == 1
    assert result["holding_status"]["state"] == "recorded"
    facts = HoldingLedger(service.root, result["holding_status"]["instance_id"]).facts()
    current = [fact for fact in facts if fact["snapshot_id"] == result["snapshot_id"]]
    assert len(current) == 1
    assert {r["record_id"] for r in current[0]["records"]} == {"row-a", "row-b"}
    with pytest.raises(HoldingError, match="RECORD_MISMATCH"):
        HoldingLedger(service.root, result["holding_status"]["instance_id"]).record_batch(**proof_args(result))


def test_r2_prep_is_not_target_proof_and_direct_bound_publish_uses_actual_instance(tmp_path):
    from test_p4b_precise_hydration import _volume
    from test_r1_data_only import UNITS, NAMESPACE, HERE
    from wfd_sdk.product_data_service import WFDDataOnlyService
    volume, target = _volume(tmp_path, "volume")
    first_doc = request([scalar_output("seed", "holding.volume", "1")], "volume-seed")
    first = volume.submit(first_doc)
    assert first["state"] == "published_formal", first
    facts = HoldingLedger(target, volume.binding.instance_id).facts()
    assert facts and all(fact["proof"]["kind"] == "r2_publish" for fact in facts)
    assert not list(volume.prep_root.rglob("target_instance_binding.json"))
    for path in volume.prep_root.rglob("data_only_formal_publications/*.json"):
        assert "holding" not in json.loads(path.read_text())
    # Ordinary service on an already-bound target must use that actual instance.
    from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
    writable = WFDDuckDBPrototype.open_existing(target, load_protocol_validator(HERE / "protocol", entry="wfd-data-only-write.schema.json"), runtime_root=volume.runtime_root,
        sandbox=False, read_only=False, writer_host=volume.binding.writer_host)
    direct = WFDDataOnlyService(writable, caller_roles={"read", "register", "submit", "publish"},
        caller_id="direct-bound-test", unit_registry=UNITS, trusted_actor_namespaces={NAMESPACE})
    _, second = published(direct, "direct-bound", [scalar_output("next", "holding.next", "2")], first["snapshot_id"])
    assert second["holding_status"]["instance_id"] == volume.binding.instance_id
    assert direct.snapshot_status()["holding_instance"] == {"instance_id": volume.binding.instance_id, "source": "volume_binding"}
    assert not (target / "catalog/product_service/target_instance_binding.json").exists()
    kinds = {fact["proof"]["kind"] for fact in HoldingLedger(target, volume.binding.instance_id).facts()}
    assert kinds == {"r2_publish", "data_only_publish"}
