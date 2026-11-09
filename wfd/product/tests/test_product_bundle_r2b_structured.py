"""R2b structured-only package: generated daily slice, physical scan, isolated read.

Synthetic rows are published into actual disposable stores; no historical market
store, product identity or evidence directory is needed by these core checks.
"""
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, canonical, load_protocol_validator
from wfd_sdk.duckdb_storage import rows_from_parquet
from wfd_sdk.product_bundle import (
    _verify_structured_bundle, export_structured_bundle, import_structured_bundle,
)
from wfd_sdk.product_data_service import WFDDataOnlyService
from synthetic_daily import SUBJECT, daily_rows


HERE = Path(__file__).resolve().parents[1]


def _open(store: Path, runtime: Path):
    engine = WFDDuckDBPrototype(store, load_protocol_validator(HERE / "protocol"),
                                runtime_root=runtime, sandbox=False, writer_host="r2b-test")
    service = WFDDataOnlyService(
        engine, caller_roles={"read", "read_evidence", "submit", "register",
                              "publish", "export"},
        caller_id="r2b-test", trusted_actor_namespaces={"wfd.local"},
        unit_registry={"cny_per_share": {"dimension": "money_per_share"}})
    return engine, service


def _make_daily_slice(tmp_path):
    store = tmp_path / "daily_store"
    engine, service = _open(store, tmp_path / "daily_runtime")
    # Generated rows, then a real publication under tmp_path (not a copied store).
    picked = [row for row in daily_rows() if row["business_key"] in {
        "daily_000001_20251229", "daily_000001_20251230", "daily_000001_20251231"}]
    definition = {
        "semantic_code": "r2b.daily.close",
        "measurement_nature": "stock",
        "unit_code": "per_field",
        "definition_authority": "wfd.local",
        "time_role": "observation",
        "semantic_context": {
            "version": "wfd.semantic-context/1.0",
            "content_nature": "observed_fact",
            "time": {"period_type": "natural", "frequency": "day", "interval": "closed"},
            "statistical": {"price_basis": "nominal", "period_aggregation": "period"},
        },
        "field_definitions": [
            {"field_code": "close_price", "data_type": "decimal",
             "unit_code": "cny_per_share", "measurement_nature": "stock",
             "time_role": "observation"},
            {"field_code": "price_adjustment", "data_type": "text",
             "unit_code": "not_applicable", "measurement_nature": "stock",
             "time_role": "observation"},
        ],
    }
    converted = [{
        "business_key": row["business_key"], "subject": SUBJECT,
        "observation_time": row["observation_time"],
        "values": {
            "close_price": row["values"]["close_price"],
            "price_adjustment": row["values"]["price_adjustment"],
        },
    } for row in picked]
    doc = {
        "protocol_version": "wfd.structured-ingest/1.0",
        "request_identity": {
            "dataset_id": "r2b_daily", "trusted_actor_namespace": "wfd.local",
            "request_id": "r2b-daily-1", "submission_digest": "sha256:" + "1" * 64,
        },
        "intent": "submit", "producer_namespace": "wfd.local",
        "expected_parent_snapshot_id": None,
        "outputs": [{
            "output_key": "daily3", "logical_domain": "observations",
            "subject": SUBJECT, "definition_mode": "create", "definition_ref": None,
            "definition": definition, "input_mode": "partial_observation",
            "coverage": {"scope": {"sample_only": True}, "basis": "observed_partial",
                         "completeness": "partial", "absence_means": "unknown"},
            "payload": {"kind": "tabular_rows", "rows": converted},
        }],
    }
    result = service.submit(doc)
    assert result.get("state") == "published_formal", result
    return store, service, result["snapshot_id"], result["output_results"][0]["product_id"]


def test_structured_full_synthetic_daily_field_subset_and_physical_scan(tmp_path):
    source, service, snapshot_id, product_id = _make_daily_slice(tmp_path)
    selection = {"products": [{
        "product_id": product_id, "fields": ["close_price"], "subject": SUBJECT,
        "business_time_range": {"role": "observation", "start": "2025-12-29",
                                "end": "2025-12-31", "timezone": "Asia/Shanghai"},
    }]}
    descriptor = export_structured_bundle(
        service, [product_id], tmp_path / "bundle", snapshot_id=snapshot_id,
        selection=selection)
    assert descriptor["profile"] == "wfd.data-only/1.0"
    assert descriptor["source_permission_required"] is False
    assert descriptor["bd_required"] is False
    assert len(descriptor["included_reads"]) == 1
    read = descriptor["included_reads"][0]
    assert read["fields"] == ["close_price"]
    assert read["row_count"] == 3
    assert read["target_product_id"] != product_id
    assert descriptor["record_map"][0]["source_record_id"] == "daily_000001_20251229"
    assert descriptor["record_map"][0]["target_record_id"] == "daily_000001_20251229"
    assert descriptor["record_map"][0]["source_record_version"] == \
        descriptor["record_map"][0]["target_record_version"]
    # Every target parquet row is physically complete but contains only the
    # selected value field; excluded source/evidence metadata is absent.
    package = tmp_path / "bundle" / descriptor["storage_packages"][0]["directory"]
    inventory = json.loads((package / "inventory.json").read_text())
    parquet_objects = [obj for obj in inventory["objects"]
                       if any(rel.endswith(".parquet") for rel in obj["rel_paths"])]
    assert parquet_objects
    for obj in parquet_objects:
        for row in rows_from_parquet(
                (package / "objects" / obj["sha256"]).read_bytes()):
            assert set(row.get("values") or {}) == {"close_price"}
            assert "source_bundle" not in row and "evidence_refs" not in row
    assert not any(rel.startswith("evidence/") or "/evidence/" in rel
                   for obj in inventory["objects"] for rel in obj["rel_paths"])
    source.rename(tmp_path / "source_gone")
    target, report = import_structured_bundle(
        tmp_path / "bundle", tmp_path / "target",
        runtime_root=tmp_path / "target_runtime", caller_roles={"read"})
    assert report["status"] == "imported_structured_readable"
    assert report["active_head"] is None
    assert report["write_authority_granted"] is False
    assert report["source_permission_required"] is False
    assert report["bd_required"] is False
    result = target.read(read["target_product_id"],
                         snapshot_id=report["target_snapshot_id"])
    assert len(result["rows"]) == 3
    assert all(set(item["row"]["values"]) == {"close_price"}
               for item in result["rows"])
    assert [item["record_id"] for item in result["rows"]] == [
        "daily_000001_20251229", "daily_000001_20251230", "daily_000001_20251231"]
    assert all(item["record_version"] for item in result["rows"])


def test_structured_import_requires_wfd_read_role(tmp_path):
    source, service, snapshot_id, product_id = _make_daily_slice(tmp_path)
    export_structured_bundle(
        service, [product_id], tmp_path / "bundle", snapshot_id=snapshot_id,
        selection={"products": [{"product_id": product_id, "fields": ["close_price"]}]})
    with pytest.raises(PermissionError, match="WFD_READ_PERMISSION_REQUIRED"):
        import_structured_bundle(tmp_path / "bundle", tmp_path / "target",
                                 runtime_root=tmp_path / "rt", caller_roles=set())


def test_structured_verifier_rejects_external_metadata(tmp_path):
    source, service, snapshot_id, product_id = _make_daily_slice(tmp_path)
    descriptor = export_structured_bundle(
        service, [product_id], tmp_path / "bundle", snapshot_id=snapshot_id,
        selection={"products": [{"product_id": product_id, "fields": ["close_price"]}]})
    bundle = tmp_path / "tampered"
    shutil.copytree(tmp_path / "bundle", bundle)
    path = bundle / "financial_bundle.json"
    value = json.loads(path.read_text())
    value["source_id"] = "bd-forbidden-source"
    path.write_bytes(canonical(value))
    inventory = []
    for item in sorted(bundle.rglob("*")):
        if item.is_file() and item.name != "CHECKSUMS.json":
            inventory.append({"path": item.relative_to(bundle).as_posix(),
                              "sha256": hashlib.sha256(item.read_bytes()).hexdigest(),
                              "size": item.stat().st_size})
    (bundle / "CHECKSUMS.json").write_bytes(canonical(inventory))
    with pytest.raises(ValueError, match="BUNDLE_EXTERNAL_METADATA_FORBIDDEN"):
        _verify_structured_bundle(bundle)


def _resign(bundle: Path):
    inventory = []
    for item in sorted(bundle.rglob("*")):
        if item.is_file() and item.name != "CHECKSUMS.json":
            inventory.append({"path": item.relative_to(bundle).as_posix(),
                              "sha256": hashlib.sha256(item.read_bytes()).hexdigest(),
                              "size": item.stat().st_size})
    (bundle / "CHECKSUMS.json").write_bytes(canonical(inventory))


def _valid_bundle(tmp_path):
    source, service, snapshot_id, product_id = _make_daily_slice(tmp_path)
    descriptor = export_structured_bundle(
        service, [product_id], tmp_path / "bundle", snapshot_id=snapshot_id,
        selection={"products": [{"product_id": product_id, "fields": ["close_price"],
                                 "subject": SUBJECT}]})
    return descriptor, product_id, snapshot_id


def test_structured_subject_selection_cannot_return_another_subject(tmp_path):
    source, service, snapshot_id, product_id = _make_daily_slice(tmp_path)
    with pytest.raises(ValueError, match="STRUCTURED_SUBJECT_NOT_IN_PRODUCT_SCOPE"):
        export_structured_bundle(
            service, [product_id], tmp_path / "wrong_subject",
            snapshot_id=snapshot_id,
            selection={"products": [{
                "product_id": product_id, "fields": ["close_price"],
                "subject": {"kind": "instrument", "namespace": "wfd.cn",
                            "id": "instrument_not_selected"}}]})
    assert not (tmp_path / "wrong_subject").exists()


def test_structured_traversal_record_rejected_before_target_write(tmp_path):
    descriptor, _, _ = _valid_bundle(tmp_path)
    bundle = tmp_path / "traversal"
    shutil.copytree(tmp_path / "bundle", bundle)
    value = json.loads((bundle / "financial_bundle.json").read_text())
    value["records"][0]["relative_path"] = "../outside_target_probe.json"
    (bundle / "financial_bundle.json").write_bytes(canonical(value))
    _resign(bundle)
    with pytest.raises(ValueError, match="STRUCTURED_PATH_INVALID|STRUCTURED_RECORD_PATH_NOT_ALLOWED"):
        import_structured_bundle(bundle, tmp_path / "traversal_target",
                                 runtime_root=tmp_path / "traversal_rt",
                                 caller_roles={"read"})
    assert not (tmp_path / "outside_target_probe.json").exists()
    assert not (tmp_path / "traversal_target").exists()


def test_structured_invented_record_map_rejected(tmp_path):
    descriptor, _, _ = _valid_bundle(tmp_path)
    bundle = tmp_path / "mapping"
    shutil.copytree(tmp_path / "bundle", bundle)
    value = json.loads((bundle / "financial_bundle.json").read_text())
    value["record_map"][0]["source_product_id"] = "unrelated_product"
    value["record_map"][0]["source_record_version"] = "invented_version"
    (bundle / "financial_bundle.json").write_bytes(canonical(value))
    _resign(bundle)
    with pytest.raises(ValueError, match="STRUCTURED_RECORD_MAP_MISMATCH"):
        import_structured_bundle(bundle, tmp_path / "mapping_target",
                                 runtime_root=tmp_path / "mapping_rt",
                                 caller_roles={"read"})
    assert not (tmp_path / "mapping_target").exists()


def test_structured_hidden_lineage_external_metadata_rejected(tmp_path):
    descriptor, _, _ = _valid_bundle(tmp_path)
    bundle = tmp_path / "lineage"
    shutil.copytree(tmp_path / "bundle", bundle)
    value = json.loads((bundle / "financial_bundle.json").read_text())
    probe = canonical({"source_id": "BD_EXCLUDED_SOURCE",
                       "original_path": "/tmp/BD_EXCLUDED_ORIGINAL.pdf",
                       "processing_record": {"run_log": "BD_EXCLUDED_PROCESS"}})
    probe_digest = hashlib.sha256(probe).hexdigest()
    (bundle / "objects" / probe_digest).write_bytes(probe)
    value["records"].append({
        "relative_path": "catalog/lineage/bd_processing_probe.json",
        "sha256": probe_digest, "size": len(probe), "kind": "probe"})
    (bundle / "financial_bundle.json").write_bytes(canonical(value))
    _resign(bundle)
    with pytest.raises(ValueError, match="STRUCTURED_RECORD_PATH_NOT_ALLOWED|BUNDLE_EXTERNAL_METADATA_FORBIDDEN"):
        import_structured_bundle(bundle, tmp_path / "lineage_target",
                                 runtime_root=tmp_path / "lineage_rt",
                                 caller_roles={"read"})
    assert not (tmp_path / "lineage_target").exists()


def _tamper_lineage(bundle: Path, extra: dict):
    descriptor = json.loads((bundle / "financial_bundle.json").read_text())
    sid = descriptor["target_snapshot_id"]
    package = bundle / descriptor["storage_packages"][0]["directory"]
    inventory = json.loads((package / "inventory.json").read_text())
    meta = next(item for item in inventory["metadata"]
                if item["rel_path"] == f"catalog/lineage/{sid}.json")
    body = json.loads((package / "objects" / meta["sha256"]).read_text())
    body.update(extra)
    raw = canonical(body)
    digest = hashlib.sha256(raw).hexdigest()
    (package / "objects" / digest).write_bytes(raw)
    meta["sha256"] = digest
    (package / "inventory.json").write_bytes(canonical(inventory))
    _resign(bundle)


def _lineage_body(bundle: Path):
    descriptor = json.loads((bundle / "financial_bundle.json").read_text())
    sid = descriptor["target_snapshot_id"]
    package = bundle / descriptor["storage_packages"][0]["directory"]
    inventory = json.loads((package / "inventory.json").read_text())
    meta = next(item for item in inventory["metadata"]
                if item["rel_path"] == f"catalog/lineage/{sid}.json")
    return json.loads((package / "objects" / meta["sha256"]).read_text())


def test_structured_internal_lineage_exact_fields_and_actual_digests(tmp_path):
    descriptor, _, _ = _valid_bundle(tmp_path)
    body = _lineage_body(tmp_path / "bundle")
    assert set(body) == {
        "format_version", "profile", "snapshot_id", "parent_snapshot_id",
        "snapshot_sha256", "manifest_sha256", "files_root",
        "source_dataset_id", "source_snapshot_id", "selection_digest",
        "logical_state_digest", "record_set_digest", "status", "wfd_internal"}
    assert body["format_version"] == "wfd.structured-lineage/1.0"
    assert body["profile"] == "wfd.data-only/1.0"
    assert body["snapshot_id"] == descriptor["target_snapshot_id"]
    assert body["parent_snapshot_id"] is None
    assert body["source_dataset_id"] == descriptor["source_dataset_id"]
    assert body["source_snapshot_id"] == descriptor["source_snapshot_id"]
    assert body["selection_digest"] == descriptor["selection_digest"]
    assert body["logical_state_digest"] == descriptor["logical_state_digest"]
    assert body["wfd_internal"] is True
    for key in ("snapshot_sha256", "manifest_sha256", "files_root",
                "selection_digest", "logical_state_digest", "record_set_digest"):
        assert body[key].startswith("sha256:")
        assert len(body[key]) == 71


@pytest.mark.parametrize("extra", [
    {"license_ref": "bd:license:EXCLUDED"},
    {"input_refs": ["bd:original:EXCLUDED"]},
    {"run_log": "BD_EXCLUDED_EXECUTION"},
])
def test_structured_internal_lineage_unknown_external_fields_rejected(tmp_path, extra):
    descriptor, _, _ = _valid_bundle(tmp_path)
    bundle = tmp_path / "lineage_tamper"
    shutil.copytree(tmp_path / "bundle", bundle)
    _tamper_lineage(bundle, extra)
    with pytest.raises(ValueError, match="STRUCTURED_LINEAGE_FIELD_UNKNOWN"):
        import_structured_bundle(bundle, tmp_path / "lineage_target",
                                 runtime_root=tmp_path / "lineage_rt",
                                 caller_roles={"read"})
    assert not (tmp_path / "lineage_target").exists()


def test_structured_internal_lineage_nested_object_rejected(tmp_path):
    descriptor, _, _ = _valid_bundle(tmp_path)
    bundle = tmp_path / "lineage_nested"
    shutil.copytree(tmp_path / "bundle", bundle)
    _tamper_lineage(bundle, {"record_set_digest": {"bd": "EXCLUDED"}})
    with pytest.raises(ValueError, match="STRUCTURED_LINEAGE_TYPE_INVALID"):
        import_structured_bundle(bundle, tmp_path / "lineage_nested_target",
                                 runtime_root=tmp_path / "lineage_nested_rt",
                                 caller_roles={"read"})
    assert not (tmp_path / "lineage_nested_target").exists()
