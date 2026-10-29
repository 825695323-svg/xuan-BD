"""P5b first batch: delta and reference manifests over the same 0.2 descriptor."""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, canonical, load_protocol_validator, sha
from wfd_sdk.duckdb_storage import parquet_from_rows, rows_from_parquet
from wfd_sdk.gc import GC
from wfd_sdk.lineage import Lineage, sha_file
from wfd_sdk.product_bundle import (
    BundledProductService, apply_delta_bundle, export_delta_bundle,
    export_financial_bundle, export_reference_bundle, import_financial_bundle,
    maintain_financial_bundle, register_reference_bundle,
)
from wfd_sdk.product_service import WFDProductService


HERE = Path(__file__).resolve().parents[1]
ROOT = HERE.parents[1]
DAILY60 = ROOT / "03_测试与验证记录/P3_通用入库与更新_2026-10-27/batches/run_20261026T200932Z/store"
DAILY60_SID = "s_9c6b1cf47d2f782194474fcf"
DAILY60_PID = "p_1d757ae27ee0b41b3ac63bcb"
SUBJECT = {"kind": "instrument", "namespace": "wfd.cn", "id": "instrument_000001_a"}


def _policy():
    return {"may_read": True, "may_read_evidence": True, "may_export": True,
            "may_export_evidence": True, "export_scope": "user_local_validation_only",
            "usage_scope": "local_use", "may_redistribute": False}


def _policies():
    return {"market_60": _policy(), "wfd_p2_local_evidence": _policy()}


def _open(store: Path, runtime: Path):
    engine = WFDDuckDBPrototype(store, load_protocol_validator(HERE / "protocol"),
                                runtime_root=runtime, sandbox=False, writer_host=None)
    return engine, WFDProductService(engine, allowed_sources=_policies(),
                                     caller_roles={"read", "read_evidence", "export"},
                                     caller_id="p5b-test", can_register=False)


def _selection():
    return {"products": [{
        "product_id": DAILY60_PID, "fields": ["close_price"], "subject": SUBJECT,
        "business_time_range": {"role": "observation", "start": "2025-11-01",
                                "end": "2025-12-31", "timezone": "Asia/Shanghai"}}],
        "evidence": {"mode": "if_licensed"}}


def _target_reader(store: Path, runtime: Path, sid: str):
    engine = WFDDuckDBPrototype(store, load_protocol_validator(HERE / "protocol"),
                                runtime_root=runtime, sandbox=False, writer_host=None)
    snapshot = engine.read_snapshot(sid)
    index, datasets = set(), set()
    for entry in snapshot["files"]:
        product = entry["source_bundle"]["_wfd_product_bindings"][entry["output_key"]]["product"]
        index.add((product["dataset_id"], sid, product["product_id"]))
        datasets.add(product["dataset_id"])
    return BundledProductService(engine, allowed_sources=_policies(),
                                 dependency_index=index, dependency_datasets=datasets,
                                 caller_roles={"read", "read_evidence"},
                                 caller_id="p5b-target", allow_local_multi_dataset=True)


def _patch_update(store: Path, source_sid: str):
    """Clearly marked update fixture: append one daily row, rewrite one file/manifest."""
    engine, service = _open(store, store.parent / "patch_runtime")
    snapshot = engine.read_snapshot(source_sid)
    files = copy.deepcopy(snapshot["files"])
    for entry in files:
        if entry["product_id"] != DAILY60_PID:
            continue
        rows = rows_from_parquet((store / entry["file_relpath"]).read_bytes())
        rows.append({
            "business_key": "daily_000001_20251101", "subject": SUBJECT,
            "observation_time": {"status": "known", "precision": "day",
                                 "earliest_utc": "2025-10-31T16:00:00Z",
                                 "latest_exclusive_utc": "2025-11-01T16:00:00Z",
                                 "source_timezone": "Asia/Shanghai"},
            "values": {
                "close_price": {"data_type": "decimal", "value": "9.99",
                                "value_state": "valid_value"},
                "price_adjustment": {"data_type": "text", "value": "unknown",
                                     "value_state": "valid_value"},
                "source_basis": {"data_type": "text", "value": "local_compiled_daily",
                                 "value_state": "valid_value"},
            },
        })
        raw = parquet_from_rows(DAILY60_PID, entry["output_key"], SUBJECT,
                                "tabular_rows", rows)
        digest = sha(raw)
        rel = f"observations/product={DAILY60_PID}/part-{digest[:24]}.parquet"
        (store / rel).parent.mkdir(parents=True, exist_ok=True)
        (store / rel).write_bytes(raw)
        entry.update({"file_relpath": rel, "file_sha256": digest, "row_count": len(rows)})
        bundle = entry["source_bundle"]
        output_key = entry["output_key"]
        bundle.setdefault("_wfd_row_versions", {}).setdefault(output_key, {})[
            "daily_000001_20251101"] = {
                "logical_key": "daily_000001_20251101", "revision_id": "r_p5b_fixture_update",
                "supersedes": None, "input_mode": "partial_observation",
                "withdrawn": False, "reason": None}
        bundle.setdefault("row_public_times", {}).setdefault(output_key, {})[
            "daily_000001_20251101"] = {
                "status": "known", "precision": "day",
                "earliest_utc": "2025-10-31T16:00:00Z",
                "latest_exclusive_utc": "2025-11-01T16:00:00Z",
                "source_timezone": "Asia/Shanghai"}
    manifest = {"parent_snapshot_id": source_sid, "files": files}
    mraw = canonical(manifest)
    mhash = sha(mraw)
    mrel = f"catalog/manifests/manifest_{mhash[:24]}.json"
    (store / mrel).write_bytes(mraw)
    new_sid = "s_" + sha(canonical(["p5b-update-fixture", source_sid, mhash]))[:24]
    snap = {"snapshot_id": new_sid, "parent_snapshot_id": source_sid,
            "manifest_relpath": mrel, "manifest_sha256": mhash, "files": files,
            "metadata_versions": [], "request_key": "p5b-update-fixture",
            "request_fingerprint": "p5b-update-fixture",
            "receipt": {"status": "p5b_update_fixture", "snapshot_id": new_sid,
                        "parent_snapshot_id": source_sid,
                        "outputs_success": [DAILY60_PID]}}
    sraw = canonical(snap)
    srel = f"catalog/snapshots/{new_sid}.json"
    (store / srel).write_bytes(sraw)
    (store / f"catalog/commits/{new_sid}.json").write_bytes(canonical(
        {"snapshot_id": new_sid, "snapshot_file": srel, "snapshot_sha256": sha(sraw)}))
    Lineage(store).ensure(new_sid)
    return new_sid


@pytest.fixture
def delta_env(tmp_path):
    source = tmp_path / "source"
    import shutil
    shutil.copytree(DAILY60, source)
    engine, service = _open(source, tmp_path / "source_runtime")
    selection = _selection()
    full = export_financial_bundle(service, [DAILY60_PID], tmp_path / "full",
                                   snapshot_id=DAILY60_SID, selection=selection)
    trusted = {sid: {"may_read": True, "may_read_evidence": True,
                     "usage_scope": "local_use"} for sid in _policies()}
    target_service, report = import_financial_bundle(
        tmp_path / "full", tmp_path / "target",
        runtime_root=tmp_path / "target_runtime", allowed_sources=trusted)
    baseline_sid = report["target_snapshot_id"]
    new_source_sid = _patch_update(source, DAILY60_SID)
    return {
        "tmp": tmp_path, "source": source, "service": service,
        "selection": selection, "full": full, "trusted": trusted,
        "target_service": target_service, "baseline_sid": baseline_sid,
        "new_source_sid": new_source_sid,
    }


def _make_delta(env, destination):
    return export_delta_bundle(
        env["service"], [DAILY60_PID], destination,
        snapshot_id=env["new_source_sid"], baseline_store=env["tmp"] / "target",
        baseline_snapshot_id=env["baseline_sid"], selection=env["selection"])


def test_delta_same_selection_updates_new_and_keeps_old_readable(delta_env):
    env = delta_env
    descriptor = _make_delta(env, env["tmp"] / "delta")
    assert descriptor["mode"] == "delta"
    assert descriptor["target_snapshot_id"] != env["baseline_sid"]
    assert descriptor["baseline"]["target_snapshot_id"] == env["baseline_sid"]
    assert len(descriptor["baseline_reused_files"]) == 1
    new_main = next(item for item in descriptor["included_reads"]
                    if item["row_count"] == 44)
    old_main = next(item for item in env["full"]["included_reads"]
                    if item["row_count"] == 43)
    report = apply_delta_bundle(
        env["tmp"] / "delta", env["tmp"] / "target",
        runtime_root=env["tmp"] / "apply_runtime", allowed_sources=env["trusted"])
    assert report["status"] == "applied"
    assert report["active_head"] is None
    assert report["write_authority_granted"] is False
    reader = _target_reader(env["tmp"] / "target", env["tmp"] / "read_runtime",
                            report["target_snapshot_id"])
    baseline_reader = _target_reader(env["tmp"] / "target", env["tmp"] / "read_runtime2",
                                     env["baseline_sid"])
    assert len(baseline_reader.read(old_main["product_id"],
                                    snapshot_id=env["baseline_sid"])["rows"]) == 43
    new_rows = reader.read(new_main["product_id"],
                           snapshot_id=report["target_snapshot_id"])["rows"]
    assert len(new_rows) == 44
    assert new_rows[0]["row"]["business_key"] == "daily_000001_20251101"
    # Re-applying the same package is the same result, not a second snapshot.
    commits = len(list((env["tmp"] / "target/catalog/commits").glob("*.json")))
    again = apply_delta_bundle(
        env["tmp"] / "delta", env["tmp"] / "target",
        runtime_root=env["tmp"] / "apply_runtime", allowed_sources=env["trusted"])
    assert again["status"] == "already_applied"
    assert len(list((env["tmp"] / "target/catalog/commits").glob("*.json"))) == commits


def test_delta_wrong_baseline_and_object_conflict_do_not_change_old(delta_env):
    env = delta_env
    _make_delta(env, env["tmp"] / "delta")
    # Wrong baseline state.
    bad_target = env["tmp"] / "bad_target"
    import shutil
    shutil.copytree(env["tmp"] / "target", bad_target)
    snap_path = bad_target / f"catalog/snapshots/{env['baseline_sid']}.json"
    snap = json.loads(snap_path.read_text())
    snap["receipt"]["target_receipt"]["selection_digest"] = "sha256:" + "0" * 64
    snap["receipt"]["target_receipt"]["normalized_selection_digest"] = "sha256:" + "0" * 64
    snap_path.write_bytes(canonical(snap))
    with pytest.raises(ValueError, match="BUNDLE_BASELINE_SELECTION_MISMATCH"):
        apply_delta_bundle(env["tmp"] / "delta", bad_target,
                           runtime_root=env["tmp"] / "bad_runtime",
                           allowed_sources=env["trusted"])
    # Same new object path with different content.
    conflict_target = env["tmp"] / "conflict_target"
    shutil.copytree(env["tmp"] / "target", conflict_target)
    delta = json.loads((env["tmp"] / "delta/financial_bundle.json").read_text())
    package = env["tmp"] / "delta" / delta["storage_packages"][0]["directory"]
    inventory = json.loads((package / "inventory.json").read_text())
    victim = next(obj for obj in inventory["objects"]
                  if any(rel.startswith("observations/") for rel in obj["rel_paths"]))
    target_path = conflict_target / victim["rel_paths"][0]
    target_path.parent.mkdir(parents=True, exist_ok=True)
    target_path.write_bytes(b"different content")
    with pytest.raises(ValueError, match="BUNDLE_PATH_HASH_CONFLICT"):
        apply_delta_bundle(env["tmp"] / "delta", conflict_target,
                           runtime_root=env["tmp"] / "conflict_runtime",
                           allowed_sources=env["trusted"])
    # The original baseline remains readable in both cases.
    old_main = next(item for item in env["full"]["included_reads"] if item["row_count"] == 43)
    reader = _target_reader(env["tmp"] / "target", env["tmp"] / "read_runtime3",
                            env["baseline_sid"])
    assert len(reader.read(old_main["product_id"], snapshot_id=env["baseline_sid"])["rows"]) == 43


def test_delta_interruption_and_repeat_apply(delta_env):
    env = delta_env
    descriptor = _make_delta(env, env["tmp"] / "delta")
    first = apply_delta_bundle(
        env["tmp"] / "delta", env["tmp"] / "target",
        runtime_root=env["tmp"] / "apply_runtime", allowed_sources=env["trusted"],
        interrupt_after=1)
    assert first["status"] == "interrupted"
    bundle_id = descriptor["bundle_id"]
    record = json.loads((env["tmp"] / "target" / f"catalog/bundles/{bundle_id}.json").read_text())
    assert record["state"] == "staging"
    assert record["verified_objects"]
    assert record["target_snapshot_id"] == descriptor["target_snapshot_id"]
    old_main = next(item for item in env["full"]["included_reads"] if item["row_count"] == 43)
    reader = _target_reader(env["tmp"] / "target", env["tmp"] / "read_runtime4",
                            env["baseline_sid"])
    assert len(reader.read(old_main["product_id"], snapshot_id=env["baseline_sid"])["rows"]) == 43
    commits = len(list((env["tmp"] / "target/catalog/commits").glob("*.json")))
    second = apply_delta_bundle(
        env["tmp"] / "delta", env["tmp"] / "target",
        runtime_root=env["tmp"] / "apply_runtime", allowed_sources=env["trusted"])
    assert second["status"] == "applied"
    assert second["target_snapshot_id"] == descriptor["target_snapshot_id"]
    assert len(list((env["tmp"] / "target/catalog/commits").glob("*.json"))) == commits + 1
    third = apply_delta_bundle(
        env["tmp"] / "delta", env["tmp"] / "target",
        runtime_root=env["tmp"] / "apply_runtime", allowed_sources=env["trusted"])
    assert third["status"] == "already_applied"
    assert len(list((env["tmp"] / "target/catalog/commits").glob("*.json"))) == commits + 1


def test_delta_digest_is_stable_across_page_size_and_generation(delta_env):
    env = delta_env
    second = export_financial_bundle(
        env["service"], [DAILY60_PID], env["tmp"] / "full2",
        snapshot_id=env["new_source_sid"], selection=env["selection"],
        read_limits={"page_size": 1, "max_pages": 400})
    third = export_financial_bundle(
        env["service"], [DAILY60_PID], env["tmp"] / "full3",
        snapshot_id=env["new_source_sid"], selection=env["selection"],
        read_limits={"page_size": 500, "max_pages": 400})
    assert second["selection_digest"] == third["selection_digest"]
    assert second["normalized_selection_digest"] == third["normalized_selection_digest"]
    assert second["logical_state_digest"] == third["logical_state_digest"]
    assert second["target_snapshot_id"] == third["target_snapshot_id"]
    delta = _make_delta(env, env["tmp"] / "delta")
    assert delta["normalized_selection_digest"] == second["normalized_selection_digest"]
    assert delta["baseline_reused_files"]


def test_reference_reachable_missing_wrong_dataset_and_protection(tmp_path):
    source = tmp_path / "source"
    import shutil
    shutil.copytree(DAILY60, source)
    engine, service = _open(source, tmp_path / "source_runtime")
    reference = export_reference_bundle(
        service, [DAILY60_PID], tmp_path / "ref",
        snapshot_id=DAILY60_SID, selection=_selection())
    assert reference["mode"] == "reference"
    assert reference["read_self_contained"] is False
    assert reference["storage_packages"] == []
    reachable = register_reference_bundle(
        tmp_path / "ref", tmp_path / "reachable_target",
        resolvers={"p3a_batch_real_2026": service}, runtime_root=tmp_path / "rr")
    assert reachable["status"] == "registered_reference"
    assert reachable["read_self_contained"] is True
    assert all(item["resolution"] == "reachable" for item in reachable["external_objects"])
    assert all(item["actual_rows"] > 0 for item in reachable["external_objects"])
    missing = register_reference_bundle(
        tmp_path / "ref", tmp_path / "missing_target",
        resolvers={}, runtime_root=tmp_path / "mr")
    assert missing["status"] == "registered_reference_incomplete"
    assert missing["read_self_contained"] is False
    assert all(item["resolution"] == "missing_resolver" for item in missing["external_objects"])
    wrong = tmp_path / "wrong"
    shutil.copytree(source, wrong)
    (wrong / "catalog/product_service/dataset.json").write_bytes(
        canonical({"dataset_id": "wrong_dataset"}))
    wrong_engine, wrong_service = _open(wrong, tmp_path / "wrong_runtime")
    wrong_result = register_reference_bundle(
        tmp_path / "ref", tmp_path / "wrong_target",
        resolvers={"p3a_batch_real_2026": wrong_service}, runtime_root=tmp_path / "wr")
    assert all(item["resolution"] == "wrong_dataset"
               for item in wrong_result["external_objects"])
    roots = GC(source).build_roots()
    bundled = {rel: reason for rel, reason in roots["protected_files"].items()
               if reason.startswith("BUNDLE_")}
    assert any(rel.startswith("catalog/product_service/definitions/") for rel in bundled)
    assert any(rel.startswith("catalog/product_service/contracts/") for rel in bundled)
    assert any(rel.startswith("evidence/sha256/") for rel in bundled)
    assert any(rel.startswith("observations/") for rel in roots["protected_files"])
    with pytest.raises(ValueError, match="BUNDLE_MAINTENANCE_NOT_IMPLEMENTED"):
        maintain_financial_bundle(source)
