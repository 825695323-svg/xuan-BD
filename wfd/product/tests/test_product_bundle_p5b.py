"""P5b delta/reference manifests over actually published synthetic daily data.

The baseline, Friday backfill and revisions are created under tmp_path through
real submit calls; no historical store or handwritten snapshot is restored.
"""
from __future__ import annotations

import copy
import json
from datetime import date
from pathlib import Path

import pytest

from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, canonical, load_protocol_validator, sha
from wfd_sdk.gc import GC
from wfd_sdk.product_bundle import (
    BundledProductService, apply_delta_bundle, export_delta_bundle,
    export_financial_bundle, export_reference_bundle, import_financial_bundle,
    maintain_financial_bundle, register_reference_bundle,
)
from wfd_sdk.product_service import SERVICE_VERSION, WFDProductService
from synthetic_daily import (
    ACTOR, DATASET, SOURCE_IDS, SUBJECT, known_day, make_daily_store,
)


HERE = Path(__file__).resolve().parents[1]
UPDATE_DAY = "2025-10-31"  # Friday; not the former 11/01 Saturday pseudo-session.
UPDATE_KEY = "daily_000001_20251031"


def _policy():
    return {"may_read": True, "may_read_evidence": True, "may_export": True,
            "may_export_evidence": True, "export_scope": "user_local_validation_only",
            "usage_scope": "local_use", "may_redistribute": False}


def _policies():
    return {source_id: _policy() for source_id in SOURCE_IDS}


def _open(store: Path, runtime: Path):
    engine = WFDDuckDBPrototype(store, load_protocol_validator(HERE / "protocol"),
                                runtime_root=runtime, sandbox=False, writer_host=None)
    return engine, WFDProductService(engine, allowed_sources=_policies(),
                                     caller_roles={"read", "read_evidence", "export"},
                                     caller_id="p5b-test", can_register=False)


def _selection(product_id):
    return {"products": [{
        "product_id": product_id, "fields": ["close_price"], "subject": SUBJECT,
        "business_time_range": {"role": "observation", "start": UPDATE_DAY,
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


def _publish_update(fixture):
    """Really publish one artificial Friday backfill, reusing the pinned definition."""
    assert date.fromisoformat(UPDATE_DAY).weekday() == 4
    service = fixture.service
    product = next(item for item in service.discover_products(
        snapshot_id=fixture.snapshot_id)["products"] if item["product_id"] == fixture.product_id)
    evidence_path = fixture.store.parent / "synthetic-backfill.txt"
    evidence_path.write_text("Synthetic Friday backfill for delta tests; not market evidence.\n", "utf-8")
    evidence = service.register_evidence(evidence_path)
    output = {
        "output_key": "daily_prices", "logical_domain": "observations", "subject": SUBJECT,
        "definition_mode": "reuse", "definition_ref": copy.deepcopy(product["definition_ref"]),
        "new_definition_declaration": None, "input_mode": "partial_observation",
        "coverage": copy.deepcopy(product["coverage"]), "evidence_refs": [evidence],
        "payload": {"kind": "tabular_rows", "rows": [{
            "business_key": UPDATE_KEY, "subject": SUBJECT, "observation_time": known_day(UPDATE_DAY),
            "values": {
                "close_price": {"data_type": "decimal", "value": "99.99", "value_state": "valid_value"},
                "price_adjustment": {"data_type": "text", "value": "unknown", "value_state": "valid_value"},
                "source_basis": {"data_type": "text", "value": "synthetic_fixture_not_market_data", "value_state": "valid_value"},
            }}]},
    }
    dependency = {"dataset_id": DATASET, "snapshot_id": fixture.unit_snapshot_id,
                  "product_id": fixture.unit_product_id, "role": "unit", "required": True}
    doc = {
        "protocol_version": "wfd.ingest/1.3-candidate",
        "request_identity": {"dataset_id": DATASET, "trusted_actor_namespace": ACTOR,
                             "request_id": "p5b-synthetic-friday-backfill"},
        "intent": "submit", "producer_namespace": ACTOR,
        "expected_parent_snapshot_id": fixture.snapshot_id, "outputs": [output],
        "source_bundle": {
            "source_id": SOURCE_IDS[0], "source_ids": [SOURCE_IDS[0]],
            "license": "synthetic_test_only", "usage_scope": "test_only",
            "raw_source_bytes_custodied": True, "public_time": known_day(UPDATE_DAY),
            "source_roles": {"daily_prices": [{"source_id": SOURCE_IDS[0],
                                                 "roles": ["definer", "compiler", "deliverer"]}]},
            "product_service": {"version": SERVICE_VERSION,
                                "outputs": {"daily_prices": {"read_dependencies": [dependency]}}},
        },
    }
    doc["request_identity"]["submission_digest"] = "sha256:" + sha(canonical(doc))
    result = service.submit(doc)
    assert result["status"] == "published_formal", result
    assert result["output_results"][0]["product_id"] == fixture.product_id
    assert fixture.engine.read_snapshot(result["snapshot_id"])["parent_snapshot_id"] == fixture.snapshot_id
    return result["snapshot_id"]


def _revision_ids(rows):
    return {item["row"]["business_key"]: item["record_ref"]["revision_id"] for item in rows}


@pytest.fixture
def delta_env(tmp_path):
    fixture = make_daily_store(tmp_path / "source")
    source = fixture.store
    engine, service = _open(source, tmp_path / "source_runtime")
    product_id = fixture.product_id
    selection = _selection(product_id)
    full = export_financial_bundle(service, [product_id], tmp_path / "full",
                                   snapshot_id=fixture.snapshot_id, selection=selection)
    trusted = {sid: {"may_read": True, "may_read_evidence": True,
                     "usage_scope": "local_use"} for sid in _policies()}
    target_service, report = import_financial_bundle(
        tmp_path / "full", tmp_path / "target",
        runtime_root=tmp_path / "target_runtime", allowed_sources=trusted)
    baseline_sid = report["target_snapshot_id"]
    new_source_sid = _publish_update(fixture)
    old_source_rows = service.read(product_id, snapshot_id=fixture.snapshot_id)["rows"]
    new_source_rows = service.read(product_id, snapshot_id=new_source_sid)["rows"]
    assert len(old_source_rows) == 43 and len(new_source_rows) == 44
    old_revisions, new_revisions = _revision_ids(old_source_rows), _revision_ids(new_source_rows)
    assert all(new_revisions[key] == revision for key, revision in old_revisions.items())
    assert UPDATE_KEY not in old_revisions
    assert new_revisions[UPDATE_KEY].startswith("r_")
    assert new_revisions[UPDATE_KEY] not in set(old_revisions.values())
    return {
        "tmp": tmp_path, "source": source, "service": service, "product_id": product_id,
        "selection": selection, "full": full, "trusted": trusted,
        "target_service": target_service, "baseline_sid": baseline_sid,
        "new_source_sid": new_source_sid,
        "old_revisions": old_revisions, "new_revisions": new_revisions,
    }


def _make_delta(env, destination):
    return export_delta_bundle(
        env["service"], [env["product_id"]], destination,
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
    old_rows = baseline_reader.read(old_main["product_id"],
                                     snapshot_id=env["baseline_sid"])["rows"]
    assert len(old_rows) == 43
    new_rows = reader.read(new_main["product_id"],
                           snapshot_id=report["target_snapshot_id"])["rows"]
    assert len(new_rows) == 44
    assert new_rows[0]["row"]["business_key"] == UPDATE_KEY
    assert new_rows[0]["row"]["values"]["close_price"]["value"] == "99.99"
    assert _revision_ids(old_rows) == env["old_revisions"]
    assert _revision_ids(new_rows) == env["new_revisions"]
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
        env["service"], [env["product_id"]], env["tmp"] / "full2",
        snapshot_id=env["new_source_sid"], selection=env["selection"],
        read_limits={"page_size": 1, "max_pages": 400})
    third = export_financial_bundle(
        env["service"], [env["product_id"]], env["tmp"] / "full3",
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
    import shutil
    fixture = make_daily_store(tmp_path / "source")
    source = fixture.store
    engine, service = _open(source, tmp_path / "source_runtime")
    reference = export_reference_bundle(
        service, [fixture.product_id], tmp_path / "ref",
        snapshot_id=fixture.snapshot_id, selection=_selection(fixture.product_id))
    assert reference["mode"] == "reference"
    assert reference["read_self_contained"] is False
    assert reference["storage_packages"] == []
    reachable = register_reference_bundle(
        tmp_path / "ref", tmp_path / "reachable_target",
        resolvers={DATASET: service}, runtime_root=tmp_path / "rr")
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
        resolvers={DATASET: wrong_service}, runtime_root=tmp_path / "wr")
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
