"""Structured-data-only delta: same selection, new day, old/new fixed reads."""
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, canonical, load_protocol_validator
from wfd_sdk.duckdb_storage import rows_from_parquet
from wfd_sdk.product_bundle import (
    apply_structured_delta_bundle, export_structured_bundle,
    export_structured_delta_bundle, import_structured_bundle,
)
from wfd_sdk.product_data_service import WFDDataOnlyService


HERE = Path(__file__).resolve().parents[1]
ROOT = HERE.parents[1]
DAILY60 = ROOT / "03_测试与验证记录/P3_通用入库与更新_2026-10-27/batches/run_20261026T200932Z/store"
DAILY60_SID = "s_9c6b1cf47d2f782194474fcf"
DAILY60_PID = "p_1d757ae27ee0b41b3ac63bcb"
SUBJECT = {"kind": "instrument", "namespace": "wfd.cn", "id": "instrument_000001_a"}
KEYS = ["daily_000001_20251226", "daily_000001_20251229",
        "daily_000001_20251230", "daily_000001_20251231"]


def _rows():
    snap = json.loads((DAILY60 / f"catalog/snapshots/{DAILY60_SID}.json").read_text())
    entry = next(e for e in snap["files"] if e["product_id"] == DAILY60_PID)
    rows = rows_from_parquet((DAILY60 / entry["file_relpath"]).read_bytes())
    return {row["business_key"]: row for row in rows if row["business_key"] in KEYS}


def _make_source(root: Path, row_keys, request_id):
    engine = WFDDuckDBPrototype(root / "store", load_protocol_validator(HERE / "protocol"),
                                runtime_root=root / "runtime", sandbox=False, writer_host="r2b")
    service = WFDDataOnlyService(
        engine, caller_roles={"read", "read_evidence", "submit", "register",
                              "publish", "export"}, caller_id="r2b",
        trusted_actor_namespaces={"wfd.local"},
        unit_registry={"cny_per_share": {"dimension": "money_per_share"}})
    definition = {
        "semantic_code": "r2b.delta.close", "measurement_nature": "stock",
        "unit_code": "per_field", "definition_authority": "wfd.local",
        "time_role": "observation",
        "semantic_context": {
            "version": "wfd.semantic-context/1.0", "content_nature": "observed_fact",
            "time": {"period_type": "natural", "frequency": "day", "interval": "closed"},
            "statistical": {"price_basis": "nominal", "period_aggregation": "period"}},
        "field_definitions": [
            {"field_code": "close_price", "data_type": "decimal",
             "unit_code": "cny_per_share", "measurement_nature": "stock",
             "time_role": "observation"},
            {"field_code": "price_adjustment", "data_type": "text",
             "unit_code": "not_applicable", "measurement_nature": "stock",
             "time_role": "observation"}],
    }
    cache = _rows()
    converted = [{
        "business_key": key, "subject": SUBJECT,
        "observation_time": cache[key]["observation_time"],
        "values": {"close_price": cache[key]["values"]["close_price"],
                   "price_adjustment": cache[key]["values"]["price_adjustment"]},
    } for key in row_keys]
    doc = {"protocol_version": "wfd.structured-ingest/1.0",
           "request_identity": {"dataset_id": "r2b_delta",
                                "trusted_actor_namespace": "wfd.local",
                                "request_id": request_id,
                                "submission_digest": "sha256:" + "2" * 64},
           "intent": "submit", "producer_namespace": "wfd.local",
           "expected_parent_snapshot_id": None,
           "outputs": [{"output_key": "daily_delta", "logical_domain": "observations",
                        "subject": SUBJECT, "definition_mode": "create",
                        "definition_ref": None, "definition": definition,
                        "input_mode": "partial_observation",
                        "coverage": {"scope": {"sample_only": True},
                                     "basis": "observed_partial",
                                     "completeness": "partial",
                                     "absence_means": "unknown"},
                        "payload": {"kind": "tabular_rows", "rows": converted}}]}
    result = service.submit(doc)
    assert result.get("state") == "published_formal", result
    return service, result["snapshot_id"], result["output_results"][0]["product_id"]


def _selection(product_id):
    return {"products": [{"product_id": product_id, "fields": ["close_price"],
                          "subject": SUBJECT,
                          "business_time_range": {"role": "observation",
                                                  "start": "2025-12-26",
                                                  "end": "2025-12-31",
                                                  "timezone": "Asia/Shanghai"}}]}


@pytest.fixture
def delta_env(tmp_path):
    base_service, base_source, base_pid = _make_source(tmp_path / "base", KEYS[1:], "base")
    selection = _selection(base_pid)
    full = export_structured_bundle(base_service, [base_pid], tmp_path / "full",
                                    snapshot_id=base_source, selection=selection)
    target, report = import_structured_bundle(
        tmp_path / "full", tmp_path / "target", runtime_root=tmp_path / "target_rt",
        caller_roles={"read"})
    new_service, new_source, new_pid = _make_source(tmp_path / "new", KEYS, "new")
    assert new_pid == base_pid
    return {"tmp": tmp_path, "selection": selection, "full": full,
            "target": target, "baseline": report, "new_service": new_service,
            "new_source": new_source, "product_id": base_pid}


def _reader(store, runtime):
    engine = WFDDuckDBPrototype(store, load_protocol_validator(HERE / "protocol"),
                                runtime_root=runtime, sandbox=False, writer_host=None)
    return WFDDataOnlyService(engine, caller_roles={"read"}, caller_id="r2b-delta")


def test_structured_delta_new_day_keeps_old_and_new_fixed_reads(delta_env):
    env = delta_env
    descriptor = export_structured_delta_bundle(
        env["new_service"], [env["product_id"]], env["tmp"] / "delta",
        snapshot_id=env["new_source"],
        baseline_store=env["tmp"] / "target",
        baseline_snapshot_id=env["baseline"]["target_snapshot_id"],
        selection=env["selection"])
    assert descriptor["mode"] == "delta"
    assert descriptor["target_snapshot_id"] != env["baseline"]["target_snapshot_id"]
    assert descriptor["baseline"]["target_snapshot_id"] == env["baseline"]["target_snapshot_id"]
    assert len(descriptor["missing_objects"]) == 1
    report = apply_structured_delta_bundle(
        env["tmp"] / "delta", env["tmp"] / "target",
        runtime_root=env["tmp"] / "apply_rt", caller_roles={"read"})
    assert report["status"] == "applied"
    assert report["active_head"] is None
    assert report["write_authority_granted"] is False
    assert report["target_instance_held_time"].startswith("recorded")
    assert report["instance_id"].startswith("wfi_")
    old_pid = env["full"]["included_reads"][0]["target_product_id"]
    new_pid = descriptor["included_reads"][0]["target_product_id"]
    assert old_pid == new_pid
    reader = _reader(env["tmp"] / "target", env["tmp"] / "read_rt")
    old = reader.read(old_pid, snapshot_id=env["baseline"]["target_snapshot_id"])["rows"]
    new = reader.read(new_pid, snapshot_id=report["target_snapshot_id"])["rows"]
    assert len(old) == 3 and len(new) == 4
    assert [item["record_id"] for item in old] == KEYS[1:]
    assert [item["record_id"] for item in new] == KEYS
    source_versions = {item["record_id"]: item["record_version"]
                       for item in env["new_service"].read(
                           env["product_id"], snapshot_id=env["new_source"])["rows"]}
    target_versions = {item["record_id"]: item["record_version"] for item in new}
    for record in descriptor["record_map"]:
        assert record["source_record_version"] == source_versions[record["source_record_id"]]
        assert record["target_record_version"] == target_versions[record["target_record_id"]]
    assert [item["record_version"] for item in old] == [
        target_versions[item["record_id"]] for item in old]
    old_snap = json.loads((env["tmp"] / "target" / f"catalog/snapshots/{env['baseline']['target_snapshot_id']}.json").read_text())
    new_snap = json.loads((env["tmp"] / "target" / f"catalog/snapshots/{report['target_snapshot_id']}.json").read_text())
    old_product = old_snap["files"][0]["source_bundle"]["_wfd_product_bindings"][old_snap["files"][0]["output_key"]]["product"]
    new_product = new_snap["files"][0]["source_bundle"]["_wfd_product_bindings"][new_snap["files"][0]["output_key"]]["product"]
    assert old_product["definition_ref"] == new_product["definition_ref"]
    assert old_product["contract_bundle_ref"] == new_product["contract_bundle_ref"]
    assert old_product["contracts"] == new_product["contracts"]


def test_structured_delta_wrong_baseline_or_selection_does_not_touch_old(delta_env):
    env = delta_env
    with pytest.raises(ValueError, match="STRUCTURED_BASELINE_SELECTION_MISMATCH"):
        export_structured_delta_bundle(
            env["new_service"], [env["product_id"]], env["tmp"] / "bad_selection",
            snapshot_id=env["new_source"], baseline_store=env["tmp"] / "target",
            baseline_snapshot_id=env["baseline"]["target_snapshot_id"],
            selection={"products": [{"product_id": env["product_id"],
                                     "fields": ["price_adjustment"]}]})
    descriptor = export_structured_delta_bundle(
        env["new_service"], [env["product_id"]], env["tmp"] / "delta",
        snapshot_id=env["new_source"], baseline_store=env["tmp"] / "target",
        baseline_snapshot_id=env["baseline"]["target_snapshot_id"],
        selection=env["selection"])
    bad_target = env["tmp"] / "bad_target"
    shutil.copytree(env["tmp"] / "target", bad_target)
    snap_path = bad_target / f"catalog/snapshots/{env['baseline']['target_snapshot_id']}.json"
    snap = json.loads(snap_path.read_text())
    snap["receipt"]["normalized_selection_digest"] = "sha256:" + "0" * 64
    snap_path.write_bytes(canonical(snap))
    with pytest.raises(ValueError, match="STRUCTURED_BASELINE_SELECTION_MISMATCH"):
        apply_structured_delta_bundle(env["tmp"] / "delta", bad_target,
                                      runtime_root=env["tmp"] / "bad_rt",
                                      caller_roles={"read"})
    reader = _reader(env["tmp"] / "target", env["tmp"] / "read_rt")
    old_pid = env["full"]["included_reads"][0]["target_product_id"]
    assert len(reader.read(old_pid, snapshot_id=env["baseline"]["target_snapshot_id"])["rows"]) == 3


def test_structured_delta_interruption_and_repeat(delta_env):
    env = delta_env
    descriptor = export_structured_delta_bundle(
        env["new_service"], [env["product_id"]], env["tmp"] / "delta",
        snapshot_id=env["new_source"], baseline_store=env["tmp"] / "target",
        baseline_snapshot_id=env["baseline"]["target_snapshot_id"],
        selection=env["selection"])
    first = apply_structured_delta_bundle(
        env["tmp"] / "delta", env["tmp"] / "target",
        runtime_root=env["tmp"] / "apply_rt", caller_roles={"read"},
        interrupt_after=1)
    assert first["status"] == "interrupted"
    record = json.loads((env["tmp"] / "target" / f"catalog/bundles/{descriptor['bundle_id']}.json").read_text())
    assert record["state"] == "staging"
    assert record["verified_objects"]
    reader = _reader(env["tmp"] / "target", env["tmp"] / "read_rt")
    old_pid = env["full"]["included_reads"][0]["target_product_id"]
    assert len(reader.read(old_pid, snapshot_id=env["baseline"]["target_snapshot_id"])["rows"]) == 3
    commits = len(list((env["tmp"] / "target/catalog/commits").glob("*.json")))
    second = apply_structured_delta_bundle(
        env["tmp"] / "delta", env["tmp"] / "target",
        runtime_root=env["tmp"] / "apply_rt", caller_roles={"read"})
    assert second["status"] == "applied"
    assert len(list((env["tmp"] / "target/catalog/commits").glob("*.json"))) == commits + 1
    third = apply_structured_delta_bundle(
        env["tmp"] / "delta", env["tmp"] / "target",
        runtime_root=env["tmp"] / "apply_rt", caller_roles={"read"})
    assert third["status"] == "already_applied"
    assert len(list((env["tmp"] / "target/catalog/commits").glob("*.json"))) == commits + 1


def test_structured_delta_logical_identity_stable_across_paths(delta_env):
    env = delta_env
    first = export_structured_delta_bundle(
        env["new_service"], [env["product_id"]], env["tmp"] / "delta_a",
        snapshot_id=env["new_source"], baseline_store=env["tmp"] / "target",
        baseline_snapshot_id=env["baseline"]["target_snapshot_id"],
        selection=env["selection"])
    second = export_structured_delta_bundle(
        env["new_service"], [env["product_id"]], env["tmp"] / "delta_b",
        snapshot_id=env["new_source"], baseline_store=env["tmp"] / "target",
        baseline_snapshot_id=env["baseline"]["target_snapshot_id"],
        selection=env["selection"])
    assert first["selection_digest"] == second["selection_digest"]
    assert first["logical_state_digest"] == second["logical_state_digest"]
    assert first["target_snapshot_id"] == second["target_snapshot_id"]
    assert first["missing_objects"] == second["missing_objects"]


def test_structured_delta_object_hash_tamper_rejected(delta_env):
    env = delta_env
    descriptor = export_structured_delta_bundle(
        env["new_service"], [env["product_id"]], env["tmp"] / "delta",
        snapshot_id=env["new_source"], baseline_store=env["tmp"] / "target",
        baseline_snapshot_id=env["baseline"]["target_snapshot_id"],
        selection=env["selection"])
    package = env["tmp"] / "delta" / descriptor["storage_packages"][0]["directory"]
    inventory = json.loads((package / "inventory.json").read_text())
    victim = inventory["objects"][0]["sha256"]
    (package / "objects" / victim).write_bytes(b"tampered")
    with pytest.raises(ValueError, match="BUNDLE_STORAGE_INTEGRITY_FAILED|STRUCTURED_OBJECT_HASH_MISMATCH|BUNDLE_INTEGRITY_FAILED"):
        apply_structured_delta_bundle(env["tmp"] / "delta", env["tmp"] / "target",
                                      runtime_root=env["tmp"] / "apply_rt",
                                      caller_roles={"read"})
    reader = _reader(env["tmp"] / "target", env["tmp"] / "read_rt")
    old_pid = env["full"]["included_reads"][0]["target_product_id"]
    assert len(reader.read(old_pid, snapshot_id=env["baseline"]["target_snapshot_id"])["rows"]) == 3


def test_structured_delta_distinct_content_gets_distinct_target_identity(delta_env):
    env = delta_env
    selection = env["selection"]
    a = export_structured_delta_bundle(
        env["new_service"], [env["product_id"]], env["tmp"] / "delta_a",
        snapshot_id=env["new_source"], baseline_store=env["tmp"] / "target",
        baseline_snapshot_id=env["baseline"]["target_snapshot_id"],
        selection=selection)
    a_report = apply_structured_delta_bundle(
        env["tmp"] / "delta_a", env["tmp"] / "target",
        runtime_root=env["tmp"] / "apply_rt", caller_roles={"read"})
    # Same baseline/selection, different synthetic source content 999.00.
    changed_service, changed_source, changed_pid = _make_source(
        env["tmp"] / "changed", KEYS, "changed")
    changed_rows = changed_service.read(changed_pid, snapshot_id=changed_source)["rows"]
    for item in changed_rows:
        if item["record_id"] == "daily_000001_20251226":
            item["row"]["values"]["close_price"]["value"] = "999.00"
    # Rewrite the changed data-only source file with the corrected row.
    engine = changed_service.engine
    snapshot = engine.read_snapshot(changed_source)
    entry = next(e for e in snapshot["files"] if e["product_id"] == changed_pid)
    rows = rows_from_parquet((changed_service.root / entry["file_relpath"]).read_bytes())
    for row in rows:
        if row["business_key"] == "daily_000001_20251226":
            row["values"]["close_price"]["value"] = "999.00"
    raw = __import__("wfd_sdk.duckdb_storage", fromlist=["parquet_from_rows"]).parquet_from_rows(
        changed_pid, entry["output_key"], entry["subject"], "tabular_rows", rows)
    digest = hashlib.sha256(raw).hexdigest()
    rel = f"observations/product={changed_pid}/part-{digest[:24]}.parquet"
    (changed_service.root / rel).parent.mkdir(parents=True, exist_ok=True)
    (changed_service.root / rel).write_bytes(raw)
    from wfd_sdk.duckdb_sdk import canonical as _canonical
    files = [dict(e) for e in snapshot["files"]]
    for e in files:
        if e["product_id"] == changed_pid:
            e["file_relpath"] = rel
            e["file_sha256"] = digest
    manifest = {"parent_snapshot_id": None, "files": files}
    mraw = _canonical(manifest)
    mhash = hashlib.sha256(mraw).hexdigest()
    mrel = f"catalog/manifests/manifest_{mhash[:24]}.json"
    (changed_service.root / mrel).write_bytes(mraw)
    new_sid = "s_" + hashlib.sha256(_canonical(["delta-b", changed_source, mhash])).hexdigest()[:24]
    snap = {"snapshot_id": new_sid, "parent_snapshot_id": None,
            "manifest_relpath": mrel, "manifest_sha256": mhash, "files": files,
            "metadata_versions": [], "request_key": "delta-b",
            "request_fingerprint": "delta-b",
            "receipt": {"status": "synthetic_changed_fixture", "snapshot_id": new_sid}}
    sraw = _canonical(snap)
    srel = f"catalog/snapshots/{new_sid}.json"
    (changed_service.root / srel).write_bytes(sraw)
    (changed_service.root / f"catalog/commits/{new_sid}.json").write_bytes(_canonical(
        {"snapshot_id": new_sid, "snapshot_file": srel,
         "snapshot_sha256": hashlib.sha256(sraw).hexdigest()}))
    from wfd_sdk.lineage import Lineage
    Lineage(changed_service.root).ensure(new_sid)
    b = export_structured_delta_bundle(
        changed_service, [changed_pid], env["tmp"] / "delta_b",
        snapshot_id=new_sid, baseline_store=env["tmp"] / "target",
        baseline_snapshot_id=env["baseline"]["target_snapshot_id"],
        selection=selection)
    assert b["target_snapshot_id"] != a["target_snapshot_id"]
    assert b["target_state_digest"] != a["target_state_digest"]
    b_report = apply_structured_delta_bundle(
        env["tmp"] / "delta_b", env["tmp"] / "target",
        runtime_root=env["tmp"] / "apply_rt", caller_roles={"read"})
    assert b_report["status"] == "applied"
    reader = _reader(env["tmp"] / "target", env["tmp"] / "read_rt2")
    b_rows = reader.read(b["included_reads"][0]["target_product_id"],
                         snapshot_id=b_report["target_snapshot_id"])["rows"]
    changed = next(row for row in b_rows if row["record_id"] == "daily_000001_20251226")
    assert changed["row"]["values"]["close_price"]["value"] == "999.00"
    a_rows = reader.read(a["included_reads"][0]["target_product_id"],
                         snapshot_id=a_report["target_snapshot_id"])["rows"]
    assert next(row for row in a_rows if row["record_id"] == "daily_000001_20251226")[
        "row"]["values"]["close_price"]["value"] == "11.54"
    again = apply_structured_delta_bundle(
        env["tmp"] / "delta_b", env["tmp"] / "target",
        runtime_root=env["tmp"] / "apply_rt", caller_roles={"read"})
    assert again["status"] == "already_applied"


def _resign(bundle):
    inventory = []
    for item in sorted(bundle.rglob("*")):
        if item.is_file() and item.name != "CHECKSUMS.json":
            inventory.append({"path": item.relative_to(bundle).as_posix(),
                              "sha256": hashlib.sha256(item.read_bytes()).hexdigest(),
                              "size": item.stat().st_size})
    (bundle / "CHECKSUMS.json").write_bytes(canonical(inventory))


def _tamper_metadata_role(bundle, role, mutate):
    descriptor = json.loads((bundle / "financial_bundle.json").read_text())
    package = bundle / descriptor["storage_packages"][0]["directory"]
    inventory = json.loads((package / "inventory.json").read_text())
    if role == "manifest":
        match = lambda rel: rel.startswith("catalog/manifests/")
    elif role == "commit":
        match = lambda rel: rel.startswith("catalog/commits/")
    else:
        raise AssertionError(role)
    meta = next(item for item in inventory["metadata"] if match(item["rel_path"]))
    value = json.loads((package / "objects" / meta["sha256"]).read_text())
    mutate(value)
    raw = canonical(value)
    digest = hashlib.sha256(raw).hexdigest()
    (package / "objects" / digest).write_bytes(raw)
    meta["sha256"] = digest
    (package / "inventory.json").write_bytes(canonical(inventory))
    _resign(bundle)


@pytest.mark.parametrize("extra", [
    {"source_id": "BD_EXCLUDED_SOURCE", "original_path": "/tmp/BD_EXCLUDED_ORIGINAL.pdf",
     "processing_record": {"run_log": "BD_EXCLUDED_EXECUTION"}},
])
def test_structured_delta_manifest_unknown_external_metadata_rejected(delta_env, extra):
    env = delta_env
    descriptor = export_structured_delta_bundle(
        env["new_service"], [env["product_id"]], env["tmp"] / "delta",
        snapshot_id=env["new_source"], baseline_store=env["tmp"] / "target",
        baseline_snapshot_id=env["baseline"]["target_snapshot_id"],
        selection=env["selection"])
    _tamper_metadata_role(env["tmp"] / "delta", "manifest", lambda value: value.update(extra))
    bad_target = env["tmp"] / "bad_manifest_target"
    shutil.copytree(env["tmp"] / "target", bad_target)
    commits = len(list((bad_target / "catalog/commits").glob("*.json")))
    with pytest.raises(ValueError, match="STRUCTURED_METADATA_FIELD_UNKNOWN:manifest"):
        apply_structured_delta_bundle(env["tmp"] / "delta", bad_target,
                                      runtime_root=env["tmp"] / "bad_manifest_rt",
                                      caller_roles={"read"})
    assert len(list((bad_target / "catalog/commits").glob("*.json"))) == commits
    reader = _reader(bad_target, env["tmp"] / "bad_manifest_read")
    old_pid = env["full"]["included_reads"][0]["target_product_id"]
    assert len(reader.read(old_pid, snapshot_id=env["baseline"]["target_snapshot_id"])["rows"]) == 3


def test_structured_delta_commit_unknown_metadata_rejected(delta_env):
    env = delta_env
    export_structured_delta_bundle(
        env["new_service"], [env["product_id"]], env["tmp"] / "delta",
        snapshot_id=env["new_source"], baseline_store=env["tmp"] / "target",
        baseline_snapshot_id=env["baseline"]["target_snapshot_id"],
        selection=env["selection"])
    _tamper_metadata_role(env["tmp"] / "delta", "commit",
                          lambda value: value.update({"source_id": "BD_EXCLUDED_SOURCE"}))
    bad_target = env["tmp"] / "bad_commit_target"
    shutil.copytree(env["tmp"] / "target", bad_target)
    commits = len(list((bad_target / "catalog/commits").glob("*.json")))
    with pytest.raises(ValueError, match="STRUCTURED_METADATA_FIELD_UNKNOWN:commit"):
        apply_structured_delta_bundle(env["tmp"] / "delta", bad_target,
                                      runtime_root=env["tmp"] / "bad_commit_rt",
                                      caller_roles={"read"})
    assert len(list((bad_target / "catalog/commits").glob("*.json"))) == commits


def test_structured_delta_manifest_nested_unknown_metadata_rejected(delta_env):
    env = delta_env
    export_structured_delta_bundle(
        env["new_service"], [env["product_id"]], env["tmp"] / "delta",
        snapshot_id=env["new_source"], baseline_store=env["tmp"] / "target",
        baseline_snapshot_id=env["baseline"]["target_snapshot_id"],
        selection=env["selection"])

    def mutate(value):
        value["files"][0]["run_log"] = {"run": "BD_EXCLUDED_EXECUTION"}

    _tamper_metadata_role(env["tmp"] / "delta", "manifest", mutate)
    bad_target = env["tmp"] / "bad_nested_target"
    shutil.copytree(env["tmp"] / "target", bad_target)
    commits = len(list((bad_target / "catalog/commits").glob("*.json")))
    with pytest.raises(ValueError, match="STRUCTURED_METADATA_FIELD_UNKNOWN:entry"):
        apply_structured_delta_bundle(env["tmp"] / "delta", bad_target,
                                      runtime_root=env["tmp"] / "bad_nested_rt",
                                      caller_roles={"read"})
    assert len(list((bad_target / "catalog/commits").glob("*.json"))) == commits
