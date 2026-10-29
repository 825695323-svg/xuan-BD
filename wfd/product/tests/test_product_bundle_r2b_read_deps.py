"""Structured profile must reject all read dependencies before any target write."""
from __future__ import annotations

import hashlib
import json
import shutil

import pytest

from test_product_bundle_r2b_structured import _resign, _valid_bundle
from wfd_sdk.duckdb_sdk import canonical
from wfd_sdk.product_bundle import import_structured_bundle


def _tamper_inner_dependency(bundle):
    descriptor = json.loads((bundle / "financial_bundle.json").read_text())
    sid = descriptor["target_snapshot_id"]
    package = bundle / descriptor["storage_packages"][0]["directory"]
    inventory = json.loads((package / "inventory.json").read_text())
    meta = next(item for item in inventory["metadata"]
                if item["rel_path"] == f"catalog/snapshots/{sid}.json")
    snap = json.loads((package / "objects" / meta["sha256"]).read_text())
    entry = snap["files"][0]
    product = entry["source_bundle"]["_wfd_product_bindings"][entry["output_key"]]["product"]
    product["contracts"]["read"]["dependencies"] = [{
        "dataset_id": "missing_dataset", "product_id": "p_missing",
        "snapshot_id": "s_missing", "role": "reference", "required": True,
    }]
    raw = canonical(snap)
    digest = hashlib.sha256(raw).hexdigest()
    (package / "objects" / digest).write_bytes(raw)
    meta["sha256"] = digest
    (package / "inventory.json").write_bytes(canonical(inventory))
    _resign(bundle)


def test_structured_no_read_dependency_package_imports(tmp_path):
    descriptor, _, _ = _valid_bundle(tmp_path)
    target, report = import_structured_bundle(
        tmp_path / "bundle", tmp_path / "target",
        runtime_root=tmp_path / "target_rt", caller_roles={"read"})
    assert report["status"] == "imported_structured_readable"
    assert report["read_self_contained"] is True
    assert descriptor["read_dependencies"] == []


def test_structured_descriptor_required_dependency_rejected(tmp_path):
    descriptor, _, _ = _valid_bundle(tmp_path)
    bundle = tmp_path / "outer"
    shutil.copytree(tmp_path / "bundle", bundle)
    value = json.loads((bundle / "financial_bundle.json").read_text())
    value["read_dependencies"] = [{
        "dataset_id": "missing_dataset", "product_id": "p_missing",
        "snapshot_id": "s_missing", "role": "reference", "required": True,
    }]
    (bundle / "financial_bundle.json").write_bytes(canonical(value))
    _resign(bundle)
    with pytest.raises(ValueError, match="STRUCTURED_READ_DEPENDENCY_NOT_IMPLEMENTED"):
        import_structured_bundle(bundle, tmp_path / "outer_target",
                                 runtime_root=tmp_path / "outer_rt",
                                 caller_roles={"read"})
    assert not (tmp_path / "outer_target").exists()


def test_structured_inner_required_dependency_rejected_even_if_outer_empty(tmp_path):
    descriptor, _, _ = _valid_bundle(tmp_path)
    bundle = tmp_path / "inner"
    shutil.copytree(tmp_path / "bundle", bundle)
    value = json.loads((bundle / "financial_bundle.json").read_text())
    assert value["read_dependencies"] == []
    (bundle / "financial_bundle.json").write_bytes(canonical(value))
    _resign(bundle)
    _tamper_inner_dependency(bundle)
    with pytest.raises(ValueError, match="STRUCTURED_READ_DEPENDENCY_NOT_IMPLEMENTED:inner"):
        import_structured_bundle(bundle, tmp_path / "inner_target",
                                 runtime_root=tmp_path / "inner_rt",
                                 caller_roles={"read"})
    assert not (tmp_path / "inner_target").exists()
