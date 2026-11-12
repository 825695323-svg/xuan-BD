#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R2a focused acceptance: one normal R1 readback + three reviewer counterexamples.

Only the exact snapshot-bound definition version is in closure. Flat current
registrations and unrelated files in the product directory are excluded.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from test_r1_data_only import (
    HERE, NAMESPACE, UNITS, make_data_service, request, scalar_output,
)
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_data_service import WFDDataOnlyService
from wfd_sdk.volume_publication import (
    DetectedVolume, PreparationInstance, VolumeBinding, VolumeDetector,
    VolumePublisher,
)

VOL_UUID = "228F8340-D41F-35DF-B07D-2D723F736836"


class FakeDetector(VolumeDetector):
    def detect(self, mount_point):
        return DetectedVolume(
            mount_point=str(Path(mount_point).resolve()), volume_uuid=VOL_UUID,
            filesystem="exfat", device="fake", identity_source="test-fake", writable=True,
        )


def binding(root: Path) -> VolumeBinding:
    return VolumeBinding(mount_point=str(root), volume_uuid=VOL_UUID,
                         writer_host="volume-test", writer_epoch=0)


def build_a(tmp_path: Path):
    base = tmp_path / "prep"
    base.mkdir()
    service = make_data_service(base)
    doc = request([scalar_output("m1", "r1.metric", "10")], "r1-a")
    result = service.submit(doc)
    assert result["state"] == "published_formal", result
    return base / "store", doc, result


def instance(prep_root: Path, doc: dict, result: dict) -> PreparationInstance:
    return PreparationInstance(
        prep_root=prep_root, request_identity=doc["request_identity"],
        snapshot_id=result["snapshot_id"], protocol_root=HERE / "protocol",
        unit_registry=UNITS, trusted_actor_namespaces=(NAMESPACE,),
        request_document=doc,
    )


def publisher(tmp_path: Path, name: str):
    target = tmp_path / name
    target.mkdir()
    return VolumePublisher(binding=binding(target),
                           runtime_root=tmp_path / (name + "_runtime"),
                           detector=FakeDetector()), target


def target_service(target: Path, tmp_path: Path) -> WFDDataOnlyService:
    engine = WFDDuckDBPrototype(
        target, load_protocol_validator(HERE / "protocol", entry="wfd-data-only-write.schema.json"),
        runtime_root=tmp_path / "target_read_runtime", sandbox=False,
        writer_host="volume-test",
    )
    return WFDDataOnlyService(
        engine, caller_roles=("read",), caller_id="target-read",
        unit_registry=UNITS, trusted_actor_namespaces={NAMESPACE},
    )


def state_of(target: Path) -> dict:
    return json.loads((target / "catalog/state.json").read_text("utf-8"))


def snapshot_of(prep: Path, sid: str) -> dict:
    return json.loads((prep / f"catalog/snapshots/{sid}.json").read_text("utf-8"))


def test_normal_r1_slice_target_service_readback(tmp_path):
    prep, doc, result = build_a(tmp_path)
    pub, target = publisher(tmp_path, "target-normal")
    published = pub.publish(instance(prep, doc, result))
    assert published["status"] == "activated", published
    assert published["formal"] is True, published
    sid = result["snapshot_id"]
    assert state_of(target)["active_head"] == sid
    assert not (target / "_staging").exists()
    assert not (target / "catalog/activation_log.jsonl").exists()

    snap = snapshot_of(prep, sid)
    for entry in snap["files"]:
        assert (target / entry["file_relpath"]).read_bytes() == (
            prep / entry["file_relpath"]
        ).read_bytes()
    assert (target / f"catalog/commits/{sid}.json").read_bytes() == (
        prep / f"catalog/commits/{sid}.json"
    ).read_bytes()

    pid = result["output_results"][0]["product_id"]
    assert (target / f"catalog/product_service/products/{pid}/definition_1.json").is_file()
    assert not (target / f"catalog/product_service/products/{pid}.json").exists()
    service = target_service(target, tmp_path)
    read = service.read(pid, snapshot_id=sid)
    expected = result["output_results"][0]["records"][0]
    assert read["rows"][0]["record_id"] == expected["record_id"]
    assert read["rows"][0]["record_version"] == expected["record_version"]
    assert set(read["products"][0]["contract_refs"]) == {
        "semantic", "read_layout", "algorithm_dependency", "update_release"}


def test_unreferenced_definition_file_not_published(tmp_path):
    prep, doc, result = build_a(tmp_path)
    sid = result["snapshot_id"]
    pid = result["output_results"][0]["product_id"]
    sentinel = prep / f"catalog/product_service/products/{pid}/definition_999.json"
    sentinel.write_text(json.dumps({
        "product_id": pid, "definition_sequence": 999,
        "original_path": "/Users/BD/original.pdf",
        "processing_record": {"code": "should-not-publish"},
    }), encoding="utf-8")

    pub, target = publisher(tmp_path, "target-unreferenced")
    published = pub.publish(instance(prep, doc, result))
    assert published["status"] == "activated", published
    assert published["formal"] is True, published
    assert not (target / f"catalog/product_service/products/{pid}/definition_999.json").exists()
    for path in target.rglob("*"):
        if path.is_file():
            raw = path.read_bytes()
            assert b"original_path" not in raw, path
            assert b"processing_record" not in raw, path
            assert b"should-not-publish" not in raw, path
    # The exact snapshot-bound definition is still present.
    assert (target / f"catalog/product_service/products/{pid}/definition_1.json").is_file()
    # Target does not need the legacy flat current registration.
    assert not (target / f"catalog/product_service/products/{pid}.json").exists()
    assert state_of(target)["active_head"] == sid


def test_necessary_definition_conflict_rejects_and_preserves_head(tmp_path):
    prep, doc, result = build_a(tmp_path)
    pub, target = publisher(tmp_path, "target-conflict")
    first = pub.publish(instance(prep, doc, result))
    assert first["status"] == "activated", first
    sid = result["snapshot_id"]
    pid = result["output_results"][0]["product_id"]
    seq = snapshot_of(prep, sid)["files"][0]["source_bundle"][
        "_wfd_product_bindings"][result["output_results"][0]["output_key"]]["product"][
        "definition_sequence"]
    definition = target / f"catalog/product_service/products/{pid}/definition_{seq}.json"
    definition.write_bytes(definition.read_bytes() + b"\n")

    seq_before = state_of(target)["update_seq"]
    rejected = pub.publish(instance(prep, doc, result))
    assert rejected["status"] == "rejected_publication", rejected
    assert rejected["errors"][0]["code"] == "TARGET_CLOSURE_DIGEST_MISMATCH", rejected
    assert state_of(target)["active_head"] == sid
    assert state_of(target)["update_seq"] == seq_before
    assert len(list((target / "catalog/commits").glob("s_*.json"))) == 1


def test_target_fixed_read_failure_does_not_publish_formal_receipt(tmp_path):
    prep, doc, result = build_a(tmp_path)
    pub, target = publisher(tmp_path, "target-fixed-fail")
    original = pub._target_fixed_read

    def fail_read(summary):
        return {"ok": False, "error": {"code": "FORCED_TARGET_READ_FAILURE"},
                "snapshot_id": summary.snapshot_id}

    pub._target_fixed_read = fail_read
    failed = pub.publish(instance(prep, doc, result))
    assert failed["status"] == "activated_readback_failed", failed
    assert failed["formal"] is False
    assert failed["states"]["activated"] is True
    assert failed["states"]["receipt"] is False
    sid = result["snapshot_id"]
    assert state_of(target)["active_head"] == sid
    assert not (target / "catalog/product_service/data_only_formal_publications").exists()
    seq = state_of(target)["update_seq"]

    pub._target_fixed_read = original
    recovered = pub.publish(instance(prep, doc, result))
    assert recovered["status"] == "activated", recovered
    assert recovered["formal"] is True, recovered
    assert recovered["head_unchanged"] is True
    assert state_of(target)["update_seq"] == seq
    assert (target / recovered["formal_receipt"]["relpath"]).is_file()

