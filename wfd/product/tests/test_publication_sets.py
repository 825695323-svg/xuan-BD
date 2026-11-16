"""Declared publication sets on the existing W06 volume publisher.

All values and volumes are synthetic. The detector models the volume identity;
these tests exercise real files, commits, fixed reads and recovery, not exFAT
hardware or power-loss durability.
"""
from __future__ import annotations

import json

import pytest

from test_p4b_precise_hydration import _volume
from test_r1_data_only import request, scalar_output


def outputs():
    return [scalar_output(key, "publication-set." + key, value)
            for key, value in (("left", "10"), ("right", "20"), ("independent", "30"))]


def grouped(request_id, *, parent=None):
    return request(outputs(), request_id, parent=parent,
                   consistency_groups={"declared-pair": ["left", "right"]})


def state(target):
    return json.loads((target / "catalog/state.json").read_text("utf-8"))


def commit_names(target):
    return sorted(path.name for path in (target / "catalog/commits").glob("*.json"))


def reopen(service, runtime_root=None):
    return type(service)(binding=service.binding, runtime_root=runtime_root or service.runtime_root,
        protocol_root=service.protocol_root, caller_roles=service.caller_roles,
        caller_id=service.caller_id, unit_registry=service.unit_registry,
        trusted_actor_namespaces=service.trusted_actor_namespaces, detector=service.detector)


def test_failed_declared_set_keeps_independent_output_and_visible_failure(tmp_path):
    service, target = _volume(tmp_path, "target")
    document = grouped("group-member-failed")
    document["outputs"][0]["payload"]["rows"][0]["value_decimal"] = "invalid-number"
    result = service.submit(document)
    assert result["state"] == "partially_published_formal", result
    outcomes = {item["output_key"]: item for item in result["output_results"]}
    assert set(outcomes) == {"left", "right", "independent"}
    assert outcomes["left"]["publication_state"] == "not_published"
    assert outcomes["right"]["publication_state"] == "not_published"
    assert outcomes["right"]["errors"][0]["code"] == "CONSISTENCY_GROUP_FAILED"
    assert outcomes["independent"]["publication_state"] == "published_formal"
    read = service.read(snapshot_id=result["snapshot_id"])
    assert {row["record_id"] for row in read["rows"]} == {"row-independent"}
    assert state(target)["active_head"] == result["snapshot_id"]
    before = commit_names(target)
    reopened = reopen(service, tmp_path / "reopened-runtime")
    status = reopened.request_status(document["request_identity"])
    assert status["state"] == "partially_published_formal", status
    assert status["output_results"] == result["output_results"]
    replay = reopened.submit(document)
    assert replay["idempotent_replay"] is True
    assert replay["snapshot_id"] == result["snapshot_id"]
    assert commit_names(target) == before


def test_failed_set_without_independent_output_never_creates_visible_snapshot(tmp_path):
    service, target = _volume(tmp_path, "target")
    document = grouped("all-blocked")
    document["outputs"].pop()
    document["outputs"][0]["payload"]["rows"][0]["value_decimal"] = "invalid-number"
    result = service.submit(document)
    assert result["state"] == "registered_not_published", result
    assert result["snapshot_id"] is None
    assert result["formal_publication_verified"] is False
    assert {item["output_key"] for item in result["output_results"] if item.get("errors")} == {"left", "right"}
    assert commit_names(target) == []
    assert not (target / "catalog/state.json").exists()
    assert not list((target / "catalog/product_service/products").glob("*/definition_*.json"))


def test_set_fixed_reads_keep_one_catalog_snapshot_after_head_advances(tmp_path):
    service, target = _volume(tmp_path, "target")
    document = grouped("pair-and-independent")
    first = service.submit(document)
    assert first["state"] == "published_formal", first
    sid = first["snapshot_id"]
    newer = scalar_output("independent-later", "publication-set.independent", "31")
    later = service.submit(request([newer], "later-independent", parent=sid))
    assert later["state"] == "published_formal", later
    assert state(target)["active_head"] == later["snapshot_id"] != sid
    fixed = [service.read(item["product_id"], snapshot_id=sid) for item in first["output_results"]]
    assert {item["snapshot_id"] for item in fixed} == {sid}
    assert {row["record_id"] for item in fixed for row in item["rows"]} == {
        "row-left", "row-right", "row-independent"}
    before = commit_names(target)
    replay = reopen(service).submit(document)
    assert replay["snapshot_id"] == sid
    assert replay["idempotent_replay"] is True
    assert commit_names(target) == before


def test_interrupted_set_copy_keeps_all_old_members_visible(tmp_path):
    service, target = _volume(tmp_path, "target")
    first = service.submit(grouped("seed"))
    sid = first["snapshot_id"]
    old_state = (target / "catalog/state.json").read_bytes()
    document = grouped("append-pair", parent=sid)
    document["outputs"].pop()
    for item in document["outputs"]:
        item["payload"]["rows"][0]["business_key"] += "-new"
    def interrupt(stage, details):
        if stage == "after_copy":
            raise OSError("synthetic copy interruption")
    service.fault_injector = interrupt
    with pytest.raises(OSError, match="synthetic copy interruption"):
        service.submit(document)
    assert (target / "catalog/state.json").read_bytes() == old_state
    assert len(commit_names(target)) == 1
    fixed = reopen(service).read(snapshot_id=sid)
    assert {row["record_id"] for row in fixed["rows"]} == {
        "row-left", "row-right", "row-independent"}


def test_partial_set_lost_receipt_recovers_failures_without_new_commit(tmp_path):
    service, target = _volume(tmp_path, "target")
    document = grouped("partial-lost-return")
    document["outputs"][0]["payload"]["rows"][0]["value_decimal"] = "invalid-number"
    def interrupt(stage, details):
        if stage == "after_activate":
            raise OSError("synthetic lost receipt")
    service.fault_injector = interrupt
    with pytest.raises(OSError, match="synthetic lost receipt"):
        service.submit(document)
    before = commit_names(target)
    assert len(before) == 1
    reopened = reopen(service, tmp_path / "recovery-runtime")
    recovered = reopened.submit(document)
    assert recovered["state"] == "partially_published_formal", recovered
    outcomes = {item["output_key"]: item for item in recovered["output_results"]}
    assert set(outcomes) == {"left", "right", "independent"}
    assert outcomes["right"]["errors"] == [{"code": "CONSISTENCY_GROUP_FAILED"}]
    assert outcomes["independent"]["publication_state"] == "published_formal"
    assert recovered["snapshot_id"] == state(target)["active_head"]
    assert reopened.request_status(document["request_identity"])["output_results"] == recovered["output_results"]
    assert reopened.submit(document)["snapshot_id"] == recovered["snapshot_id"]
    assert commit_names(target) == before


def test_prepared_set_rejects_changed_target_head_without_mixed_members(tmp_path, monkeypatch):
    from wfd_sdk.volume_publication import VolumePublisher
    service, target = _volume(tmp_path, "target")
    seed = service.submit(grouped("seed"))
    document = grouped("stale-pair", parent=seed["snapshot_id"])
    document["outputs"].pop()
    for item in document["outputs"]:
        item["payload"]["rows"][0]["business_key"] += "-stale"
    original = VolumePublisher.publish
    concurrent = {}
    def advance(publisher, instance):
        monkeypatch.setattr(VolumePublisher, "publish", original)
        other = reopen(service, tmp_path / "concurrent-runtime")
        value = scalar_output("concurrent", "publication-set.concurrent", "40")
        concurrent.update(other.submit(request([value], "concurrent", parent=seed["snapshot_id"])))
        assert concurrent["state"] == "published_formal", concurrent
        return original(publisher, instance)
    monkeypatch.setattr(VolumePublisher, "publish", advance)
    result = service.submit(document)
    assert result["status"] == "rejected_publication", result
    assert result["errors"][0]["code"] == "PARENT_CHANGED"
    assert state(target)["active_head"] == concurrent["snapshot_id"]
    current = reopen(service).read(snapshot_id=concurrent["snapshot_id"])
    assert {row["record_id"] for row in current["rows"]} == {
        "row-left", "row-right", "row-independent", "row-concurrent"}
    assert len(commit_names(target)) == 2


@pytest.mark.parametrize("failure_window", ["before_formal_receipt", "status_missing"])
def test_native_recovery_retains_unpublished_members(tmp_path, monkeypatch, failure_window):
    from test_r1_data_only import make_data_service
    service = make_data_service(tmp_path)
    document = grouped("native-recovery")
    document["outputs"][0]["payload"]["rows"][0]["value_decimal"] = "invalid-number"
    if failure_window == "before_formal_receipt":
        def lose_return(*args, **kwargs):
            raise OSError("synthetic lost result before formal receipt")
        monkeypatch.setattr(service, "_formalize", lose_return)
        with pytest.raises(OSError, match="synthetic lost result"):
            service.submit(document)
    else:
        original = service.submit(document)
        assert original["state"] == "partially_published_formal", original
        (service.root / service._status_path(original["request_key"])).unlink()
    before = commit_names(service.root)
    recovered = make_data_service(tmp_path).request_status(document["request_identity"])
    assert recovered["state"] == "partially_published_formal", recovered
    outcomes = {item["output_key"]: item for item in recovered["output_results"]}
    assert set(outcomes) == {"left", "right", "independent"}
    assert outcomes["left"]["publication_state"] == outcomes["right"]["publication_state"] == "not_published"
    assert outcomes["independent"]["publication_state"] == "published_formal"
    assert make_data_service(tmp_path).submit(document)["snapshot_id"] == recovered["snapshot_id"]
    assert commit_names(service.root) == before


def test_publication_failure_receipt_keeps_codes_without_private_error_text(tmp_path, monkeypatch):
    import wfd_sdk.product_data_service as data_service
    service, target = _volume(tmp_path, "target")
    original = data_service.validate_payload
    marker = "synthetic-private-original-9371"
    def invalid_left(output, declaration):
        if output["output_key"] == "left":
            return [{"code": "SYNTHETIC_PAYLOAD_REJECTED",
                     "message": "/private/" + marker + ".csv contains value 997123"}]
        return original(output, declaration)
    monkeypatch.setattr(data_service, "validate_payload", invalid_left)
    result = service.submit(grouped("private-error-text"))
    assert result["state"] == "partially_published_formal", result
    outcomes = {item["output_key"]: item for item in result["output_results"]}
    assert outcomes["left"]["errors"] == [{"code": "SYNTHETIC_PAYLOAD_REJECTED"}]
    for path in target.rglob("*"):
        if path.is_file():
            assert marker.encode() not in path.read_bytes(), path


def test_native_recovery_rejects_formal_receipt_that_lost_failed_members(tmp_path):
    from test_r1_data_only import make_data_service
    service = make_data_service(tmp_path)
    document = grouped("native-receipt-conflict")
    document["outputs"][0]["payload"]["rows"][0]["value_decimal"] = "invalid-number"
    original = service.submit(document)
    formal_path = service.root / original["formal_publication_ref"]
    formal = json.loads(formal_path.read_text("utf-8"))
    formal.pop("unpublished_outputs")
    formal_path.write_text(json.dumps(formal), encoding="utf-8")
    (service.root / service._status_path(original["request_key"])).unlink()
    before = commit_names(service.root)
    recovered = make_data_service(tmp_path).request_status(document["request_identity"])
    assert recovered["state"] == "recovery_conflict", recovered
    assert recovered["formal_publication_verified"] is False
    assert recovered["errors"][0]["code"] == "FORMAL_RECEIPT_OUTPUT_CONFLICT"
    assert commit_names(service.root) == before


def test_data_service_failed_set_never_exposes_prepared_record_identities(tmp_path):
    from test_r1_data_only import make_data_service
    service = make_data_service(tmp_path)
    members = outputs()[:2]
    members[0]["definition"]["unit_code"] = "synthetic_unregistered_unit"
    document = request(members, "failed-direct-service-set",
                       consistency_groups={"pair": ["left", "right"]})
    result = service.submit(document)
    assert result["state"] == "registered_not_published", result
    assert result["snapshot_id"] is None
    outcomes = {item["output_key"]: item for item in result["output_results"]}
    assert outcomes["left"]["errors"][0]["code"] == "UNIT_DEFINITION_REQUIRED"
    assert outcomes["right"]["errors"][0]["code"] == "CONSISTENCY_GROUP_FAILED"
    assert all(not item.get("records") for item in outcomes.values())
    reopened = make_data_service(tmp_path)
    # BD treats this explicit rejection as a lookup, never a second submission.
    restored = reopened.request_status(document["request_identity"])
    assert restored["state"] == "registered_not_published"
    assert restored["snapshot_id"] is None
    assert restored["output_results"] == result["output_results"]
