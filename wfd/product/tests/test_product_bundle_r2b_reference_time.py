"""Reference time-selection consistency: normalized range must match exactly."""
from __future__ import annotations

import json
import shutil

import pytest

from wfd_sdk.duckdb_sdk import canonical
from wfd_sdk.product_bundle import (
    _structured_normalized_digest, export_structured_reference_bundle,
    register_structured_reference_bundle,
)
from test_product_bundle_r2b_reference import (
    KEYS, _make_source, _recompute_reference_id, _resign, _selection,
)


def _prepare(tmp_path):
    service, sid, pid = _make_source(tmp_path / "source", "r2b_ref", "base", KEYS[1:])
    export_structured_reference_bundle(
        service, [pid], tmp_path / "ref", snapshot_id=sid, selection=_selection(pid))
    return service, sid, pid


def _mutate(bundle, mutate):
    value = json.loads((bundle / "financial_bundle.json").read_text())
    mutate(value)
    _recompute_reference_id(value)
    (bundle / "financial_bundle.json").write_bytes(canonical(value))
    _resign(bundle)
    return value


def test_reference_normal_same_range_reads_three_rows(tmp_path):
    service, _, _ = _prepare(tmp_path)
    handle, report = register_structured_reference_bundle(
        tmp_path / "ref", tmp_path / "target",
        resolvers={"r2b_ref": service}, runtime_root=tmp_path / "rt",
        caller_roles={"read"})
    assert report["readable"] is True
    result = handle.read()
    assert [row["row"]["values"]["close_price"]["value"] for row in result["rows"]] == [
        "11.56", "11.48", "11.41"]
    assert not list((tmp_path / "target/catalog/commits").glob("*.json"))
    assert not list((tmp_path / "target/catalog/snapshots").glob("*.json"))


def test_reference_selection_range_mismatch_rejected_before_write(tmp_path):
    service, _, _ = _prepare(tmp_path)
    bad = tmp_path / "bad_selection"
    shutil.copytree(tmp_path / "ref", bad)
    _mutate(bad, lambda value: value["selection"]["products"][0].update({
        "business_time_range": {"role": "observation", "start": "2026-01-01",
                                "end": "2026-01-31", "timezone": "Asia/Shanghai"}}))
    value = json.loads((bad / "financial_bundle.json").read_text())
    value["selection_digest"] = _structured_normalized_digest(value["selection"])
    value["normalized_selection_digest"] = value["selection_digest"]
    _recompute_reference_id(value)
    (bad / "financial_bundle.json").write_bytes(canonical(value))
    _resign(bad)
    target = tmp_path / "target_bad"
    with pytest.raises(ValueError, match="STRUCTURED_REFERENCE_TIME_RANGE_MISMATCH"):
        register_structured_reference_bundle(
            bad, target, resolvers={"r2b_ref": service},
            runtime_root=tmp_path / "bad_rt", caller_roles={"read"})
    assert not list((target / "catalog/bundles").glob("*.json"))


def test_reference_external_timezone_boundary_mismatch_rejected(tmp_path):
    service, _, _ = _prepare(tmp_path)
    bad = tmp_path / "bad_timezone"
    shutil.copytree(tmp_path / "ref", bad)
    _mutate(bad, lambda value: value["external_objects"][0][
        "business_time_range"].update({"timezone": "UTC"}))
    target = tmp_path / "target_bad_tz"
    with pytest.raises(ValueError, match="STRUCTURED_REFERENCE_TIME_RANGE_MISMATCH"):
        register_structured_reference_bundle(
            bad, target, resolvers={"r2b_ref": service},
            runtime_root=tmp_path / "bad_tz_rt", caller_roles={"read"})
    assert not list((target / "catalog/bundles").glob("*.json"))
