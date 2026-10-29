"""P5a precise physical bundles: real slice, strict PIT, cross-dataset, failures."""
from __future__ import annotations

import copy
import json
import shutil
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, canonical, load_protocol_validator, sha
from wfd_sdk.lineage import Lineage
from wfd_sdk.product_bundle import (
    BundledProductService, _json, export_financial_bundle, import_financial_bundle,
)
from wfd_sdk.product_query import ProductQuery
from wfd_sdk.product_service import SERVICE_VERSION, WFDProductService
from wfd_sdk.transfer import verify_package


HERE = Path(__file__).resolve().parents[1]
ROOT = HERE.parents[1]
P3A6_STORE = ROOT / "03_测试与验证记录/P3_通用入库与更新_2026-10-27/run_20261027_p3a6/store"
P3A6_SNAPSHOT = "s_75ba1080a80c944a7cb5e89e"
P3A6_PLAN = "p_c6e2ebaa67c41eb6aad986a9"
P3A6_SCHEDULE = "p_c29cff868e8ec4508de69ead"
ALL_ROLES = {"read", "read_evidence", "export", "submit", "register",
             "publish", "redistribute", "evidence_write"}


def _known_day(value: str):
    start = datetime.strptime(value, "%Y-%m-%d")
    end = start + timedelta(days=1)
    return {"status": "known", "precision": "day",
            "earliest_utc": start.strftime("%Y-%m-%dT00:00:00Z"),
            "latest_exclusive_utc": end.strftime("%Y-%m-%dT00:00:00Z"),
            "source_timezone": "UTC"}


def _known_year(year: int):
    return {"status": "known", "precision": "year",
            "earliest_utc": f"{year}-01-01T00:00:00Z",
            "latest_exclusive_utc": f"{year + 1}-01-01T00:00:00Z",
            "source_timezone": "UTC"}


def _policy(**overrides):
    value = {"may_submit": True, "may_publish_formal": True, "may_read": True,
             "may_read_evidence": True, "may_export": True, "may_export_evidence": True,
             "export_scope": "user_local_validation_only", "usage_scope": "local_use",
             "allowed_roles": ["definer", "deliverer"],
             "allowed_authorities": ["p1.test", "portoflosangeles.official"],
             "may_redistribute": False}
    value.update(overrides)
    return value


def _service(root: Path, *, dataset="ds_a", policy=None):
    engine = WFDDuckDBPrototype(root / "store", load_protocol_validator(HERE / "protocol"),
                                runtime_root=root / "runtime", sandbox=False, writer_host="test")
    return engine, WFDProductService(
        engine, allowed_sources={"fixture": policy or _policy()},
        caller_roles=ALL_ROLES, caller_id="test",
        unit_registry={"vehicle": {"dimension": "quantity"}},
        trusted_actor_namespaces={"wfd.test.curated"})


def _output(key, subject, fields, rows):
    return {
        "output_key": key, "logical_domain": "observations", "subject": subject,
        "definition_mode": "create", "definition_ref": None,
        "new_definition_declaration": {
            "semantic_code": "test." + key, "measurement_nature": "flow",
            "unit_code": "per_field", "definition_authority": "p1.test",
            "time_role": "observation", "field_definitions": fields,
        },
        "input_mode": "partial_observation",
        "coverage": {"scope": {"sample_only": True}, "basis": "observed_partial",
                     "completeness": "partial", "coverage_evidence": [],
                     "absence_means": "unknown"},
        "payload": {"kind": "tabular_rows", "rows": rows},
        "evidence_refs": [],
    }


def _row(key, subject, when, amount, label):
    return {"business_key": key, "subject": subject, "observation_time": when,
            "values": {"amount": {"data_type": "decimal", "value": amount,
                                  "value_state": "valid_value"},
                       "label": {"data_type": "text", "value": label,
                                 "value_state": "valid_value"}}}


def _submit_fixture(root: Path):
    engine, service = _service(root)
    (root / "evidence.txt").write_text("synthetic bundle fixture")
    evidence = service.register_evidence(root / "evidence.txt")
    subject = {"kind": "entity", "namespace": "wfd.test", "id": "e1"}
    fields = [
        {"field_code": "amount", "data_type": "decimal", "unit_code": "vehicle",
         "measurement_nature": "flow", "time_role": "observation"},
        {"field_code": "label", "data_type": "text", "unit_code": "not_applicable",
         "measurement_nature": "flow", "time_role": "observation"},
    ]
    unit = _output("unit_product", subject, fields,
                   [_row("u1", subject, _known_day("2024-01-02"), "1", "u")])
    unit["evidence_refs"] = [evidence]
    first = {
        "protocol_version": "wfd.ingest/1.3-candidate",
        "request_identity": {"dataset_id": "ds_a",
                             "trusted_actor_namespace": "wfd.test.curated",
                             "request_id": "unit",
                             "submission_digest": "sha256:" + "a" * 64},
        "intent": "submit", "producer_namespace": "wfd.test.curated",
        "expected_parent_snapshot_id": None, "outputs": [unit],
        "source_bundle": {
            "source_id": "fixture", "license": "test_only",
            "source_roles": {"unit_product": [{"source_id": "fixture", "roles": ["definer"]}]},
            "product_service": {"version": SERVICE_VERSION,
                                "outputs": {"unit_product": {"read_dependencies": []}}},
            "public_time": _known_day("2024-01-02"),
            "raw_source_bytes_custodied": True,
        },
    }
    first_result = service.submit(first)
    assert first_result["status"] == "published_formal", first_result
    dep_pid = first_result["output_results"][0]["product_id"]
    dep_sid = first_result["snapshot_id"]
    main = _output("main", subject, fields, [
        _row("a", subject, _known_day("2025-01-03"), "1", "a"),
        _row("b", subject, _known_day("2025-06-03"), "2", "b"),
        _row("c", subject, _known_day("2025-12-03"), "3", "c"),
    ])
    main["evidence_refs"] = [evidence]
    extra = _output("extra", subject, fields,
                    [_row("e", subject, _known_day("2024-01-03"), "9", "e")])
    extra["evidence_refs"] = [evidence]
    dep = {"dataset_id": "ds_a", "snapshot_id": dep_sid,
           "product_id": dep_pid, "role": "unit", "required": True}
    second = {
        "protocol_version": "wfd.ingest/1.3-candidate",
        "request_identity": {"dataset_id": "ds_a",
                             "trusted_actor_namespace": "wfd.test.curated",
                             "request_id": "main",
                             "submission_digest": "sha256:" + "b" * 64},
        "intent": "submit", "producer_namespace": "wfd.test.curated",
        "expected_parent_snapshot_id": dep_sid, "outputs": [main, extra],
        "source_bundle": {
            "source_id": "fixture", "license": "test_only",
            "source_roles": {
                "main": [{"source_id": "fixture", "roles": ["definer"]}],
                "extra": [{"source_id": "fixture", "roles": ["definer"]}],
            },
            "product_service": {"version": SERVICE_VERSION, "outputs": {
                "main": {"read_dependencies": [dep]},
                "extra": {"read_dependencies": []}}},
            "public_time": _known_day("2024-01-02"),
            "row_public_times": {"main": {
                "a": _known_day("2025-01-03"),
                "b": _known_day("2025-06-03"),
                "c": _known_day("2025-12-03"),
            }},
            "raw_source_bytes_custodied": True,
        },
    }
    second_result = service.submit(second)
    assert second_result["status"] == "published_formal", second_result
    main_pid = second_result["output_results"][0]["product_id"]
    extra_pid = second_result["output_results"][1]["product_id"]
    return service, engine, subject, fields, dep_pid, dep_sid, main_pid, extra_pid, second_result["snapshot_id"]


def _target_snapshot(bundle: Path, descriptor):
    directory = bundle / descriptor["storage_packages"][0]["directory"]
    checked = verify_package(directory)
    assert checked["ok"]
    files = {}
    for obj in checked["inventory"]["objects"]:
        raw = (directory / "objects" / obj["sha256"]).read_bytes()
        for relative in obj["rel_paths"]:
            files[relative] = raw
    for meta in checked["inventory"]["metadata"]:
        files[meta["rel_path"]] = (directory / "objects" / meta["sha256"]).read_bytes()
    return json.loads(files[f"catalog/snapshots/{descriptor['target_snapshot_id']}.json"].decode()), files


def test_real_p3a6_precise_slice_is_physically_selected_and_reads_isolated(tmp_path):
    source = tmp_path / "source"
    shutil.copytree(P3A6_STORE, source)
    engine = WFDDuckDBPrototype(source, load_protocol_validator(HERE / "protocol"),
                                runtime_root=tmp_path / "runtime", sandbox=False, writer_host=None)
    policies = {}
    for source_id in ("cninfo_1222806519", "cninfo_1223765073",
                      "cninfo_1225022887", "market_20251231", "wfd_p2_local_evidence"):
        policies[source_id] = _policy(
            may_export=source_id in {"cninfo_1222806519", "cninfo_1223765073", "wfd_p2_local_evidence"},
            may_export_evidence=source_id in {"cninfo_1222806519", "cninfo_1223765073", "wfd_p2_local_evidence"})
    service = WFDProductService(engine, allowed_sources=policies, caller_roles=ALL_ROLES,
                                caller_id="real-reader", can_register=False)
    subject = {"kind": "entity", "namespace": "wfd.cn", "id": "entity_000001"}
    selection = {"products": [
        {"product_id": P3A6_PLAN, "fields": ["final_per_10", "fiscal_year", "stage"],
         "subject": subject,
         "business_time_range": {"role": "event", "start": "2025-01-01",
                                 "end": "2025-12-31", "timezone": "Asia/Shanghai"}},
        {"product_id": P3A6_SCHEDULE, "fields": ["record_date", "ex_date"],
         "subject": subject,
         "business_time_range": {"role": "event", "start": "2025-01-01",
                                 "end": "2025-12-31", "timezone": "Asia/Shanghai"}},
    ], "evidence": {"mode": "if_licensed"}}
    bundle = tmp_path / "bundle"
    descriptor = export_financial_bundle(
        service, [P3A6_PLAN, P3A6_SCHEDULE], bundle, snapshot_id=P3A6_SNAPSHOT,
        selection=selection)
    assert descriptor["target_snapshot_id"] != P3A6_SNAPSHOT
    assert descriptor["target_snapshot_id"].startswith("s_")
    assert descriptor["logical_state_digest"] == descriptor["logical_state_digest"]
    snapshot, _ = _target_snapshot(bundle, descriptor)
    assert snapshot["snapshot_id"] == descriptor["target_snapshot_id"]
    assert snapshot["parent_snapshot_id"] is None
    assert snapshot["receipt"]["formal_source_receipt"] is False
    assert {entry["product_id"] for entry in snapshot["files"]} == {
        item["target_product_id"] for item in descriptor["logical_state"]["products"]}
    assert len(snapshot["files"]) == 4
    for entry in snapshot["files"]:
        source_bundle = entry["source_bundle"]
        assert set(source_bundle["_wfd_product_bindings"]) == {entry["output_key"]}
        assert set(source_bundle["_wfd_row_versions"]) == {entry["output_key"]}
    for item in descriptor["logical_state"]["products"]:
        if item["role"] == "selected":
            assert item["fields"] in (["ex_date", "record_date"],
                                      ["final_per_10", "fiscal_year", "stage"])
            assert item["row_count"] == 1
    assert not any(item["source_product_id"] in {market, revenue} for item in
                   descriptor["logical_state"]["products"]
                   for market, revenue in [("p_41bd2793733d9dff596d0802",
                                            "p_02ec6055541fbe0a36213c05")])
    assert descriptor["sanitized_paths"]
    assert all("/Users/" not in json.dumps(descriptor) for _ in [0])

    source.rename(tmp_path / "source_unavailable")
    with pytest.raises(ValueError, match="BUNDLE_TRUSTED_POLICY_REQUIRED"):
        import_financial_bundle(bundle, tmp_path / "target0",
                                runtime_root=tmp_path / "runtime0")
    trusted = {source_id: {"may_read": True, "may_read_evidence": True,
                           "usage_scope": "local_use"} for source_id in policies}
    target, report = import_financial_bundle(
        bundle, tmp_path / "target", runtime_root=tmp_path / "runtime_target",
        allowed_sources=trusted)
    assert report["active_head"] is None
    assert report["write_authority_granted"] is False
    assert report["source_received_at_utc"]
    assert report["import_started_at_utc"] not in report["source_received_at_utc"]
    assert report["source_and_target_received_time_differ"] is True
    target_pids = {item["source_product_id"]: item["target_product_id"]
                   for item in descriptor["logical_state"]["products"]}
    plan_rows = target.read(target_pids[P3A6_PLAN],
                            snapshot_id=report["target_snapshot_id"])["rows"]
    schedule_rows = target.read(target_pids[P3A6_SCHEDULE],
                                snapshot_id=report["target_snapshot_id"])["rows"]
    assert len(plan_rows) == len(schedule_rows) == 1
    assert set(plan_rows[0]["row"]["values"]) == {"final_per_10", "fiscal_year", "stage"}
    assert set(schedule_rows[0]["row"]["values"]) == {"record_date", "ex_date"}
    # The target query boundary must also see the physically narrowed target.
    query = ProductQuery(target)
    result = query.execute({
        "protocol_version": "wfd.read/1.3-product1", "dataset_id": "p3a_real_2026_v2",
        "operation": "read_product", "snapshot_id": report["target_snapshot_id"],
        "history_mode": "snapshot_contents", "knowledge_cutoff": None,
        "held_scope": None, "usable_stage": None, "subject": subject,
        "max_nodes": 200000, "product_id": target_pids[P3A6_PLAN],
        "fields": ["final_per_10", "fiscal_year", "stage"],
        "business_time_range": {"role": "event", "start": "2025-01-01",
                                "end": "2025-12-31", "timezone": "Asia/Shanghai"},
        "page_size": 500, "max_scan_bytes": 268435456, "cursor": None,
    })
    assert len(result["rows"]) == 1
    assert result["rows"][0]["values"]["final_per_10"]["value"] == "3.62"
    assert target.trace(target_pids[P3A6_SCHEDULE],
                        snapshot_id=report["target_snapshot_id"])["evidence"]


def test_strict_pit_fixture_physically_excludes_future_rows_and_originals(tmp_path):
    service, engine, subject, fields, dep_pid, dep_sid, main_pid, extra_pid, sid = _submit_fixture(tmp_path)
    cutoff = {"status": "known", "precision": "second",
              "earliest_utc": "2025-07-01T00:00:00Z",
              "latest_exclusive_utc": "2025-07-01T00:00:01Z",
              "source_timezone": "UTC"}
    selection = {"at": cutoff, "products": [{
        "product_id": main_pid, "fields": ["amount"], "subject": subject,
        "business_time_range": {"role": "observation", "start": "2025-01-01",
                                "end": "2025-12-31", "timezone": "UTC"}}],
        "evidence": {"mode": "if_licensed"}}
    bundle = tmp_path / "bundle"
    descriptor = export_financial_bundle(
        service, [main_pid], bundle, snapshot_id=sid,
        perspective="market_known_at", selection=selection)
    target_item = next(item for item in descriptor["logical_state"]["products"]
                       if item["source_product_id"] == main_pid)
    assert target_item["row_count"] == 2
    assert target_item["fields"] == ["amount"]
    assert not any(item["source_product_id"] == extra_pid
                   for item in descriptor["logical_state"]["products"])
    assert descriptor["evidence"][0]["carried"] is False
    assert descriptor["evidence"][0]["status"] == "referenced_only"
    snapshot, _ = _target_snapshot(bundle, descriptor)
    assert len(snapshot["files"]) == 2  # main + unit dependency
    main_entry = next(entry for entry in snapshot["files"]
                      if entry["product_id"] == target_item["target_product_id"])
    assert set(main_entry["source_bundle"]["row_public_times"]) == {main_entry["output_key"]}
    assert set(main_entry["source_bundle"]["row_public_times"][main_entry["output_key"]]) == {"a", "b"}
    assert not any((bundle / "objects" / item["digest"]).exists()
                   for item in descriptor["evidence"])

    with pytest.raises(ValueError, match="BUNDLE_PIT_ORIGINAL_REQUIRED"):
        bad = copy.deepcopy(selection)
        bad["evidence"] = {"mode": "required", "require_original": True}
        export_financial_bundle(service, [main_pid], tmp_path / "bad",
                                snapshot_id=sid, perspective="market_known_at",
                                selection=bad)
    target, report = import_financial_bundle(
        bundle, tmp_path / "target", runtime_root=tmp_path / "runtime_target",
        allowed_sources={"fixture": {"may_read": True, "may_read_evidence": True,
                                     "usage_scope": "test"}})
    rows = target.read(target_item["target_product_id"],
                       snapshot_id=report["target_snapshot_id"])["rows"]
    assert [item["row"]["business_key"] for item in rows] == ["a", "b"]
    assert all(set(item["row"]["values"]) == {"amount"} for item in rows)
    assert target.read(target_item["target_product_id"],
                       snapshot_id=report["target_snapshot_id"],
                       perspective="market_known_at",
                       at="2025-01-15T00:00:00Z")["rows"]
    assert len(target.read(target_item["target_product_id"],
                           snapshot_id=report["target_snapshot_id"],
                           perspective="market_known_at",
                           at="2025-01-15T00:00:00Z")["rows"]) == 1


def _patch_cross_dataset(source_store: Path, source_sid: str, product_id: str,
                         dependency: dict):
    engine = WFDDuckDBPrototype(source_store, load_protocol_validator(HERE / "protocol"),
                                runtime_root=source_store.parent / "patch_runtime",
                                sandbox=False, writer_host=None)
    snapshot = engine.read_snapshot(source_sid)
    files = copy.deepcopy(snapshot["files"])
    for entry in files:
        if entry["product_id"] != product_id:
            continue
        bound = entry["source_bundle"]["_wfd_product_bindings"][entry["output_key"]]
        product = bound["product"]
        product["contracts"]["read"]["dependencies"] = [copy.deepcopy(dependency)]
        product["contracts"]["part_digests"]["read"] = "sha256:" + sha(
            canonical(product["contracts"]["read"]))
        digest = sha(canonical(product["contracts"]))
        product["contract_ref"] = {
            "kind": "contract", "dataset_id": product["dataset_id"],
            "namespace": "wfd.product", "id": "contract_" + digest[:24],
            "version": "v_" + digest[:16], "digest": "sha256:" + digest,
            "resolution": "pinned", "required": True, "dependency_type": "read",
        }
        entry["source_bundle"]["product_service"]["outputs"][entry["output_key"]][
            "read_dependencies"] = [copy.deepcopy(dependency)]
        product.pop("contract_refs", None)
        product.pop("contract_bundle_ref", None)
    manifest = {"parent_snapshot_id": None, "files": files}
    mraw = canonical(manifest)
    mhash = sha(mraw)
    mrel = f"catalog/manifests/manifest_{mhash[:24]}.json"
    (source_store / mrel).write_bytes(mraw)
    new_sid = "s_" + sha(canonical(["cross-dataset-fixture", source_sid, mhash]))[:24]
    receipt = {"status": "fixture_cross_dataset", "snapshot_id": new_sid,
               "parent_snapshot_id": None, "outputs_success": [product_id]}
    snap = {"snapshot_id": new_sid, "parent_snapshot_id": None,
            "manifest_relpath": mrel, "manifest_sha256": mhash, "files": files,
            "metadata_versions": [], "request_key": "cross-fixture",
            "request_fingerprint": "cross-fixture", "receipt": receipt}
    sraw = canonical(snap)
    srel = f"catalog/snapshots/{new_sid}.json"
    (source_store / srel).write_bytes(sraw)
    (source_store / f"catalog/commits/{new_sid}.json").write_bytes(canonical(
        {"snapshot_id": new_sid, "snapshot_file": srel,
         "snapshot_sha256": sha(sraw)}))
    Lineage(source_store).ensure(new_sid)
    return new_sid


def test_cross_dataset_requires_operator_mapping_and_exact_target_identity(tmp_path):
    # Dataset A and an independent read-only service for dataset B.
    engine_a, service_a = _service(tmp_path / "a")
    (tmp_path / "a/ev.txt").write_text("a")
    ev_a = service_a.register_evidence(tmp_path / "a/ev.txt")
    doc_a = _json(HERE / "fixtures/port_annual_autos.json")
    doc_a["source_bundle"] = {"source_id": "fixture", "license": "test_only",
        "source_roles": {doc_a["outputs"][0]["output_key"]: [
            {"source_id": "fixture", "roles": ["definer"]}]},
        "product_service": {"version": SERVICE_VERSION, "outputs": {
            doc_a["outputs"][0]["output_key"]: {"read_dependencies": []}}}}
    doc_a["request_identity"]["dataset_id"] = "ds_a"
    doc_a["outputs"][0]["evidence_refs"] = [ev_a]
    result_a = service_a.submit(doc_a)
    assert result_a["status"] == "published_formal", result_a
    a_pid, a_sid = result_a["output_results"][0]["product_id"], result_a["snapshot_id"]

    engine_b, service_b = _service(tmp_path / "b", dataset="ds_b")
    (tmp_path / "b/ev.txt").write_text("b")
    ev_b = service_b.register_evidence(tmp_path / "b/ev.txt")
    doc_b = copy.deepcopy(doc_a)
    doc_b["request_identity"]["dataset_id"] = "ds_b"
    doc_b["request_identity"]["request_id"] = "b"
    doc_b["outputs"][0]["evidence_refs"] = [ev_b]
    result_b = service_b.submit(doc_b)
    assert result_b["status"] == "published_formal", result_b
    b_pid, b_sid = result_b["output_results"][0]["product_id"], result_b["snapshot_id"]

    dep = {"dataset_id": "ds_b", "product_id": b_pid,
           "snapshot_id": b_sid, "role": "reference", "required": True}
    patched_sid = _patch_cross_dataset(tmp_path / "a/store", a_sid, a_pid, dep)
    index = {(("ds_a", patched_sid, a_pid)), ("ds_b", b_sid, b_pid)}
    source = BundledProductService(
        engine_a, allowed_sources={"fixture": _policy()},
        dependency_index=index, dependency_datasets={"ds_a", "ds_b"},
        caller_roles=ALL_ROLES, caller_id="cross-reader",
        dataset_services={"ds_b": service_b})
    assert source.read(a_pid, snapshot_id=patched_sid)["rows"]

    with pytest.raises(ValueError, match="BUNDLE_DATASET_SERVICE_MISSING:ds_b"):
        export_financial_bundle(source, [a_pid], tmp_path / "missing",
                                snapshot_id=patched_sid)
    with pytest.raises(ValueError, match="BUNDLE_DATASET_SERVICE_FALLBACK_FORBIDDEN:ds_b"):
        export_financial_bundle(source, [a_pid], tmp_path / "fallback",
                                snapshot_id=patched_sid,
                                dataset_services={"ds_b": source})
    descriptor = export_financial_bundle(
        source, [a_pid], tmp_path / "cross", snapshot_id=patched_sid,
        dataset_services={"ds_b": service_b})
    assert {item["source_dataset_id"] for item in descriptor["logical_state"]["products"]} == {
        "ds_a", "ds_b"}
    (tmp_path / "a/store").rename(tmp_path / "a/store_gone")
    target, report = import_financial_bundle(
        tmp_path / "cross", tmp_path / "target",
        runtime_root=tmp_path / "runtime_target",
        allowed_sources={"fixture": {"may_read": True, "may_read_evidence": True,
                                     "usage_scope": "test"}})
    target_a = next(item["target_product_id"] for item in descriptor["logical_state"]["products"]
                    if item["source_dataset_id"] == "ds_a")
    target_b = next(item["target_product_id"] for item in descriptor["logical_state"]["products"]
                    if item["source_dataset_id"] == "ds_b")
    assert target.read(target_a, snapshot_id=report["target_snapshot_id"])["rows"]
    assert target.read(target_b, snapshot_id=report["target_snapshot_id"])["rows"]


def test_missing_dependency_and_untrusted_import_are_accurate(tmp_path):
    service, engine, subject, fields, dep_pid, dep_sid, main_pid, extra_pid, sid = _submit_fixture(tmp_path)
    # A required dependency whose snapshot is no longer available must fail with
    # the exact identity, not silently fall back to a local product.
    (service.root / f"catalog/snapshots/{dep_sid}.json").unlink()
    with pytest.raises(ValueError, match="BUNDLE_SOURCE_SNAPSHOT_UNAVAILABLE:" + dep_sid):
        export_financial_bundle(service, [main_pid], tmp_path / "missing_dep",
                                snapshot_id=sid)
