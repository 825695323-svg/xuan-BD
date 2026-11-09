"""Structured WFD-internal reference: reachable fixed read, gaps, pinned snapshot."""
from __future__ import annotations

import copy
import hashlib
import json
import shutil
from pathlib import Path

import pytest

from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, canonical, load_protocol_validator
from wfd_sdk.product_bundle import (
    export_structured_reference_bundle, register_structured_reference_bundle,
)
from wfd_sdk.product_data_service import WFDDataOnlyService
from synthetic_daily import SUBJECT, daily_rows


HERE = Path(__file__).resolve().parents[1]
KEYS = ["daily_000001_20251226", "daily_000001_20251229",
        "daily_000001_20251230", "daily_000001_20251231"]


def _cache():
    # Actual snapshots/versions are produced by _submit, not read from old assets.
    return {row["business_key"]: row for row in daily_rows() if row["business_key"] in KEYS}


def _definition():
    return {
        "semantic_code": "r2b.reference.close", "measurement_nature": "stock",
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


def _submit(service, dataset, request_id, row_keys):
    cache = _cache()
    converted = [{
        "business_key": key, "subject": SUBJECT,
        "observation_time": cache[key]["observation_time"],
        "values": {"close_price": cache[key]["values"]["close_price"],
                   "price_adjustment": cache[key]["values"]["price_adjustment"]},
    } for key in row_keys]
    doc = {"protocol_version": "wfd.structured-ingest/1.0",
           "request_identity": {"dataset_id": dataset,
                                "trusted_actor_namespace": "wfd.local",
                                "request_id": request_id,
                                "submission_digest": "sha256:" + "3" * 64},
           "intent": "submit", "producer_namespace": "wfd.local",
           "expected_parent_snapshot_id": None,
           "outputs": [{"output_key": "daily_ref", "logical_domain": "observations",
                        "subject": SUBJECT, "definition_mode": "create",
                        "definition_ref": None, "definition": _definition(),
                        "input_mode": "partial_observation",
                        "coverage": {"scope": {"sample_only": True},
                                     "basis": "observed_partial",
                                     "completeness": "partial",
                                     "absence_means": "unknown"},
                        "payload": {"kind": "tabular_rows", "rows": converted}}]}
    result = service.submit(doc)
    assert result.get("state") == "published_formal", result
    return result["snapshot_id"], result["output_results"][0]["product_id"]


def _make_source(store, dataset, request_id, row_keys, caller_roles=None):
    engine = WFDDuckDBPrototype(store, load_protocol_validator(HERE / "protocol"),
                                runtime_root=store.parent / (store.name + "_rt"),
                                sandbox=False, writer_host="r2b-ref")
    service = WFDDataOnlyService(
        engine, caller_roles=caller_roles or {"read", "read_evidence", "submit",
                                               "register", "publish", "export"},
        caller_id="r2b-ref", trusted_actor_namespaces={"wfd.local"},
        unit_registry={"cny_per_share": {"dimension": "money_per_share"}})
    sid, pid = _submit(service, dataset, request_id, row_keys)
    return service, sid, pid


def _selection(pid):
    return {"products": [{"product_id": pid, "fields": ["close_price"],
                          "subject": SUBJECT,
                          "business_time_range": {"role": "observation",
                                                  "start": "2025-12-26",
                                                  "end": "2025-12-31",
                                                  "timezone": "Asia/Shanghai"}}]}


def _resign(bundle):
    inventory = []
    for item in sorted(bundle.rglob("*")):
        if item.is_file() and item.name != "CHECKSUMS.json":
            inventory.append({"path": item.relative_to(bundle).as_posix(),
                              "sha256": hashlib.sha256(item.read_bytes()).hexdigest(),
                              "size": item.stat().st_size})
    (bundle / "CHECKSUMS.json").write_bytes(canonical(inventory))


def test_structured_reference_reachable_fixed_read_no_bd(tmp_path):
    service, sid, pid = _make_source(tmp_path / "source", "r2b_ref", "base", KEYS[1:])
    descriptor = export_structured_reference_bundle(
        service, [pid], tmp_path / "ref", snapshot_id=sid, selection=_selection(pid))
    assert descriptor["mode"] == "reference"
    assert descriptor["read_self_contained"] is False
    assert descriptor["source_permission_required"] is True
    assert descriptor["storage_packages"] == []
    handle, report = register_structured_reference_bundle(
        tmp_path / "ref", tmp_path / "target",
        resolvers={"r2b_ref": service}, runtime_root=tmp_path / "rt",
        caller_roles={"read"})
    assert report["status"] == "registered_reference_readable"
    assert report["readable"] is True
    assert report["read_self_contained"] is False
    assert report["bd_required"] is False
    result = handle.read()
    assert result["read_self_contained"] is False
    assert [row["record_id"] for row in result["rows"]] == KEYS[1:]
    assert [row["row"]["values"]["close_price"]["value"] for row in result["rows"]] == [
        "100.40", "100.41", "100.42"]  # generated values, not historical prices
    assert not list((tmp_path / "target/catalog/commits").glob("*.json"))
    assert not list((tmp_path / "target/catalog/snapshots").glob("*.json"))
    assert (tmp_path / "target/catalog/state.json").is_file()
    assert report["target_instance_held_time"].startswith("unknown")


def test_structured_reference_source_unavailable_keeps_registration(tmp_path):
    service, sid, pid = _make_source(tmp_path / "source", "r2b_ref", "base", KEYS[1:])
    export_structured_reference_bundle(
        service, [pid], tmp_path / "ref", snapshot_id=sid, selection=_selection(pid))
    handle, report = register_structured_reference_bundle(
        tmp_path / "ref", tmp_path / "target",
        resolvers={"r2b_ref": service}, runtime_root=tmp_path / "rt",
        caller_roles={"read"})
    assert report["readable"] is True
    record_path = tmp_path / "target" / f"catalog/bundles/{report['reference_id']}.json"
    before = record_path.read_bytes()
    (tmp_path / "source").rename(tmp_path / "source_gone")
    with pytest.raises(ValueError, match="STRUCTURED_REFERENCE_UNREADABLE"):
        handle.read()
    assert record_path.read_bytes() == before
    missing, missing_report = register_structured_reference_bundle(
        tmp_path / "ref", tmp_path / "target_missing",
        resolvers={}, runtime_root=tmp_path / "mrt", caller_roles={"read"})
    assert missing_report["status"] == "registered_reference_unavailable"
    assert missing_report["readable"] is False
    assert missing_report["dependency_gaps"][0]["gap"] == "missing_resolver"
    with pytest.raises(ValueError, match="STRUCTURED_REFERENCE_UNREADABLE"):
        missing.read()


def test_structured_reference_wrong_dataset_snapshot_digest_permission(tmp_path):
    service, sid, pid = _make_source(tmp_path / "source", "r2b_ref", "base", KEYS[1:])
    export_structured_reference_bundle(
        service, [pid], tmp_path / "ref", snapshot_id=sid, selection=_selection(pid))
    # Wrong dataset resolver: same store copy with a conflicting dataset marker.
    other_root = tmp_path / "other"
    shutil.copytree(tmp_path / "source", other_root)
    (other_root / "catalog/product_service/dataset.json").write_bytes(
        canonical({"dataset_id": "other_dataset"}))
    other_engine = WFDDuckDBPrototype(
        other_root, load_protocol_validator(HERE / "protocol"),
        runtime_root=tmp_path / "other_rt", sandbox=False, writer_host=None)
    other = WFDDataOnlyService(other_engine, caller_roles={"read"},
                               caller_id="other")
    handle, report = register_structured_reference_bundle(
        tmp_path / "ref", tmp_path / "t1", resolvers={"r2b_ref": other},
        runtime_root=tmp_path / "r1", caller_roles={"read"})
    assert report["readable"] is False
    assert report["dependency_gaps"][0]["gap"] == "wrong_dataset"
    # Missing WFD source read permission.
    denied = WFDDataOnlyService(
        service.engine, caller_roles={"read_evidence"}, caller_id="denied",
        trusted_actor_namespaces={"wfd.local"})
    _, denied_report = register_structured_reference_bundle(
        tmp_path / "ref", tmp_path / "t2", resolvers={"r2b_ref": denied},
        runtime_root=tmp_path / "r2", caller_roles={"read"})
    assert denied_report["readable"] is False
    assert denied_report["dependency_gaps"][0]["gap"] == "source_permission_denied"
    # Wrong pinned snapshot in descriptor.
    for name, mutate in [
        ("snapshot", lambda value: value["external_objects"][0].update(
            {"snapshot_id": "s_" + "0" * 24})),
        ("digest", lambda value: value["external_objects"][0].update(
            {"definition_digest": "sha256:" + "0" * 64})),
    ]:
        bundle = tmp_path / f"bad_{name}"
        shutil.copytree(tmp_path / "ref", bundle)
        value = json.loads((bundle / "financial_bundle.json").read_text())
        mutate(value)
        # Keep the descriptor internally consistent; the fixed source is still wrong.
        bindings = [{"dataset_id": obj["dataset_id"], "snapshot_id": obj["snapshot_id"],
                     "product_id": obj["product_id"], **binding}
                    for obj in value["external_objects"]
                    for binding in obj["record_bindings"]]
        value["record_bindings_digest"] = "sha256:" + hashlib.sha256(
            canonical(bindings)).hexdigest()
        _recompute_reference_id(value)
        (bundle / "financial_bundle.json").write_bytes(canonical(value))
        _resign(bundle)
        if name in ("snapshot", "digest"):
            expected = ("STRUCTURED_REFERENCE_SNAPSHOT_MISMATCH" if name == "snapshot"
                        else "STRUCTURED_REFERENCE_REF_DIGEST_MISMATCH")
            with pytest.raises(ValueError, match=expected):
                register_structured_reference_bundle(
                    bundle, tmp_path / f"target_{name}", resolvers={"r2b_ref": service},
                    runtime_root=tmp_path / f"rt_{name}", caller_roles={"read"})
            continue
        handle, bad_report = register_structured_reference_bundle(
            bundle, tmp_path / f"target_{name}", resolvers={"r2b_ref": service},
            runtime_root=tmp_path / f"rt_{name}", caller_roles={"read"})
        assert bad_report["readable"] is False
        assert bad_report["dependency_gaps"][0]["gap"] in {
            "unreachable", "identity_or_digest_mismatch"}
        with pytest.raises(ValueError, match="STRUCTURED_REFERENCE_UNREADABLE"):
            handle.read()


def test_structured_reference_pinned_snapshot_survives_source_update(tmp_path):
    service, sid, pid = _make_source(tmp_path / "source", "r2b_ref", "base", KEYS[1:])
    export_structured_reference_bundle(
        service, [pid], tmp_path / "ref", snapshot_id=sid, selection=_selection(pid))
    handle, report = register_structured_reference_bundle(
        tmp_path / "ref", tmp_path / "target",
        resolvers={"r2b_ref": service}, runtime_root=tmp_path / "rt",
        caller_roles={"read"})
    assert [row["record_id"] for row in handle.read()["rows"]] == KEYS[1:]
    # Add a real new snapshot on the same source store using the same definition.
    old_product = service.discover_products(snapshot_id=sid)["products"][0]
    cache = _cache()
    converted = [{
        "business_key": KEYS[0], "subject": SUBJECT,
        "observation_time": cache[KEYS[0]]["observation_time"],
        "values": {"close_price": cache[KEYS[0]]["values"]["close_price"],
                   "price_adjustment": cache[KEYS[0]]["values"]["price_adjustment"]},
    }]
    updated = service.submit({
        "protocol_version": "wfd.structured-ingest/1.0",
        "request_identity": {"dataset_id": "r2b_ref",
                             "trusted_actor_namespace": "wfd.local",
                             "request_id": "updated",
                             "submission_digest": "sha256:" + "5" * 64},
        "intent": "submit", "producer_namespace": "wfd.local",
        "expected_parent_snapshot_id": sid,
        "outputs": [{"output_key": "daily_ref_new", "logical_domain": "observations",
                     "subject": SUBJECT, "definition_mode": "reuse",
                     "definition_ref": old_product["definition_ref"],
                     "definition": None, "input_mode": "partial_observation",
                     "coverage": {"scope": {"sample_only": True},
                                  "basis": "observed_partial",
                                  "completeness": "partial",
                                  "absence_means": "unknown"},
                     "payload": {"kind": "tabular_rows", "rows": converted}}]})
    assert updated.get("state") == "published_formal", updated
    result = handle.read()
    assert [row["record_id"] for row in result["rows"]] == KEYS[1:]
    assert [row["record_version"] for row in result["rows"]] == [
        binding["record_version"]
        for binding in json.loads((tmp_path / "ref/financial_bundle.json").read_text())[
            "external_objects"][0]["record_bindings"]]


def test_structured_reference_bad_descriptor_rejected_before_write(tmp_path):
    service, sid, pid = _make_source(tmp_path / "source", "r2b_ref", "base", KEYS[1:])
    export_structured_reference_bundle(
        service, [pid], tmp_path / "ref", snapshot_id=sid, selection=_selection(pid))
    bundle = tmp_path / "bad_ref"
    shutil.copytree(tmp_path / "ref", bundle)
    value = json.loads((bundle / "financial_bundle.json").read_text())
    value["source_id"] = "BD_EXCLUDED_SOURCE"
    value["processing_record"] = {"run_log": "BD_EXCLUDED_EXECUTION"}
    (bundle / "financial_bundle.json").write_bytes(canonical(value))
    _resign(bundle)
    with pytest.raises(ValueError, match="BUNDLE_EXTERNAL_METADATA_FORBIDDEN|STRUCTURED_METADATA_FIELD_UNKNOWN"):
        register_structured_reference_bundle(
            bundle, tmp_path / "bad_target", resolvers={"r2b_ref": service},
            runtime_root=tmp_path / "bad_rt", caller_roles={"read"})
    assert not list((tmp_path / "bad_target/catalog/bundles").glob("*.json"))


def _recompute_reference_id(value):
    body = {"selection": value["selection"],
            "source_dataset_id": value["source_dataset_id"],
            "source_snapshot_id": value["source_snapshot_id"],
            "external_objects": value["external_objects"]}
    value["reference_id"] = "sr_" + hashlib.sha256(canonical(body)).hexdigest()[:24]


def test_structured_reference_bad_id_path_rejected_without_write(tmp_path):
    service, sid, pid = _make_source(tmp_path / "source", "r2b_ref", "base", KEYS[1:])
    export_structured_reference_bundle(
        service, [pid], tmp_path / "ref", snapshot_id=sid, selection=_selection(pid))
    _, report = register_structured_reference_bundle(
        tmp_path / "ref", tmp_path / "target", resolvers={"r2b_ref": service},
        runtime_root=tmp_path / "rt", caller_roles={"read"})
    record = tmp_path / "target" / f"catalog/bundles/{report['reference_id']}.json"
    before = record.read_bytes()
    bundle = tmp_path / "bad_id"
    shutil.copytree(tmp_path / "ref", bundle)
    value = json.loads((bundle / "financial_bundle.json").read_text())
    value["reference_id"] = "../../../outside_reference_probe"
    (bundle / "financial_bundle.json").write_bytes(canonical(value))
    _resign(bundle)
    with pytest.raises(ValueError, match="STRUCTURED_REFERENCE_ID_FORMAT_INVALID|STRUCTURED_REFERENCE_ID_MISMATCH"):
        register_structured_reference_bundle(
            bundle, tmp_path / "target", resolvers={"r2b_ref": service},
            runtime_root=tmp_path / "bad_id_rt", caller_roles={"read"})
    assert record.read_bytes() == before
    assert not (tmp_path.parent / "outside_reference_probe").exists()


def test_structured_reference_nested_execution_rejected_without_write(tmp_path):
    service, sid, pid = _make_source(tmp_path / "source", "r2b_ref", "base", KEYS[1:])
    export_structured_reference_bundle(
        service, [pid], tmp_path / "ref", snapshot_id=sid, selection=_selection(pid))
    _, report = register_structured_reference_bundle(
        tmp_path / "ref", tmp_path / "target", resolvers={"r2b_ref": service},
        runtime_root=tmp_path / "rt", caller_roles={"read"})
    record = tmp_path / "target" / f"catalog/bundles/{report['reference_id']}.json"
    before = record.read_bytes()
    bundle = tmp_path / "bad_nested"
    shutil.copytree(tmp_path / "ref", bundle)
    value = json.loads((bundle / "financial_bundle.json").read_text())
    value["external_objects"][0]["contract_refs"]["semantic"]["execution"] = {
        "command": "BD_PROCESS_COMMAND_EXCLUDED",
        "input_ref": "bd:original:EXCLUDED",
        "notes": "Original stored at /tmp/BD_EXCLUDED_ORIGINAL.pdf",
    }
    _recompute_reference_id(value)
    (bundle / "financial_bundle.json").write_bytes(canonical(value))
    _resign(bundle)
    with pytest.raises(ValueError, match="STRUCTURED_METADATA_FIELD_UNKNOWN:reference_ref|STRUCTURED_REFERENCE_ID_MISMATCH"):
        register_structured_reference_bundle(
            bundle, tmp_path / "target", resolvers={"r2b_ref": service},
            runtime_root=tmp_path / "bad_nested_rt", caller_roles={"read"})
    assert record.read_bytes() == before


def test_structured_reference_subject_id_nested_rejected_before_write(tmp_path):
    service, sid, pid = _make_source(tmp_path / "source", "r2b_ref", "base", KEYS[1:])
    export_structured_reference_bundle(
        service, [pid], tmp_path / "ref", snapshot_id=sid, selection=_selection(pid))
    _, report = register_structured_reference_bundle(
        tmp_path / "ref", tmp_path / "target", resolvers={"r2b_ref": service},
        runtime_root=tmp_path / "rt", caller_roles={"read"})
    record = tmp_path / "target" / f"catalog/bundles/{report['reference_id']}.json"
    before = record.read_bytes()
    bundle = tmp_path / "bad_subject"
    shutil.copytree(tmp_path / "ref", bundle)
    value = json.loads((bundle / "financial_bundle.json").read_text())
    value["external_objects"][0]["subject"]["id"] = {
        "processing_command": "BD_PROCESS_COMMAND_EXCLUDED",
        "original_input_ref": "bd:original:EXCLUDED",
    }
    _recompute_reference_id(value)
    (bundle / "financial_bundle.json").write_bytes(canonical(value))
    _resign(bundle)
    with pytest.raises(ValueError, match="STRUCTURED_REFERENCE_SCALAR_INVALID:reference_subject.id"):
        register_structured_reference_bundle(
            bundle, tmp_path / "target", resolvers={"r2b_ref": service},
            runtime_root=tmp_path / "bad_subject_rt", caller_roles={"read"})
    assert record.read_bytes() == before
