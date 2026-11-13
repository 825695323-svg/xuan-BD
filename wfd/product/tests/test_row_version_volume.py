"""The normal volume service keeps shared row metadata closed and explicitly adopted."""
from __future__ import annotations

import json

import pytest

from test_duplicate_append import opted, output
from test_p4b_precise_hydration import _volume
from test_r2a_volume_publication import snapshot_of, state_of
from wfd_sdk import row_version_objects as versions
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_holdings import HoldingLedger


def _adopt(service, target, parent):
    engine = WFDDuckDBPrototype.open_existing(
        target, service.engine.validator, runtime_root=service.runtime_root,
        sandbox=False, read_only=False, writer_host=service.binding.writer_host,
    )
    return versions.adopt_writing(
        engine, identity="isolated-volume-test", expected_snapshot_id=parent,
        adopted_at_utc="2026-01-01T00:00:00Z",
    )["marker"]


def _page(service, request_id, rows, parent=None):
    result = service.submit(opted([output(rows)], request_id, parent))
    assert result["state"] == "published_formal", result
    return result


def _object_paths(snapshot):
    return {versions.object_relative(digest)
            for digest, _size in versions.reference_inventory(snapshot)["unique"]}


def test_volume_adoption_keeps_old_snapshots_and_fixed_record_identities(tmp_path):
    service, target = _volume(tmp_path, "volume")
    first = _page(service, "one", [("a", "10"), ("b", "20")])
    first_sid = first["snapshot_id"]
    second = _page(service, "two", [("c", "30")], first_sid)
    second_sid = second["snapshot_id"]
    before = {}
    for sid in (first_sid, second_sid):
        snapshot = snapshot_of(target, sid)
        assert all(isinstance(entry["source_bundle"][versions.KEY], dict)
                   for entry in snapshot["files"])
        for rel in (f"catalog/snapshots/{sid}.json", snapshot["manifest_relpath"],
                    f"catalog/commits/{sid}.json"):
            before[rel] = (target / rel).read_bytes()
    assert not (target / versions.ADOPTION_REL).exists()
    target_adoption = _adopt(service, target, second_sid)
    marker_bytes = (target / versions.ADOPTION_REL).read_bytes()
    prep_markers = []

    def observe(stage, details):
        if stage == "target_verified":
            engine = service._open_prep(service.prep_root / "workspace").engine
            marker = versions.adoption_record(engine.root, engine.runtime_root)
            assert marker["identity"] == target_adoption["identity"]
            assert marker["store_filesystem_identity"] != target_adoption["store_filesystem_identity"]
            assert marker["runtime_filesystem_identity"] != target_adoption["runtime_filesystem_identity"]
            prep_markers.append(marker)

    service.fault_injector = observe
    third = _page(service, "three", [("d", "40")], second_sid)
    fourth = _page(service, "four", [("e", "50")], third["snapshot_id"])
    assert len(prep_markers) == 2
    assert (target / versions.ADOPTION_REL).read_bytes() == marker_bytes
    assert {rel: (target / rel).read_bytes() for rel in before} == before

    third_paths = _object_paths(snapshot_of(target, third["snapshot_id"]))
    fourth_paths = _object_paths(snapshot_of(target, fourth["snapshot_id"]))
    assert len(third_paths) == 3 and len(fourth_paths) == 4
    assert third_paths < fourth_paths
    assert third_paths <= {item["relpath"] for item in service.last_hydration["files"]}
    for rel in fourth_paths:
        assert (target / rel).is_file()

    pid = first["output_results"][0]["product_id"]
    rows = service.read(pid, snapshot_id=fourth["snapshot_id"])["rows"]
    assert {row["row"]["business_key"]: row["row"]["value_decimal"] for row in rows} == {
        "a": "10", "b": "20", "c": "30", "d": "40", "e": "50",
    }
    fixed_versions = {(row["record_id"], row["record_version"]) for row in rows}
    original_versions = {(row["record_id"], row["record_version"])
                         for result in (first, second, third, fourth)
                         for row in result["output_results"][0]["records"]}
    assert fixed_versions == original_versions
    old_rows = service.read(pid, snapshot_id=first_sid)["rows"]
    assert {(row["record_id"], row["record_version"]) for row in old_rows} == {
        (row["record_id"], row["record_version"]) for row in first["output_results"][0]["records"]
    }


@pytest.mark.parametrize("remove", [True, False])
@pytest.mark.parametrize("corruption_stage", ["after_copy", "target_verified"])
def test_new_row_object_corruption_cannot_commit_or_activate(tmp_path, remove, corruption_stage):
    service, target = _volume(tmp_path, "volume")
    first = _page(service, "one", [("a", "10")])
    sid = first["snapshot_id"]
    _adopt(service, target, sid)
    previous_commits = sorted((target / "catalog/commits").iterdir())

    def corrupt(stage, details):
        if stage != corruption_stage:
            return
        if stage == "after_copy":
            paths = [target / details["relpath"]] if details["relpath"].startswith(
                "catalog/product_service/row_versions/") else []
        else:
            paths = (target / "catalog/product_service/row_versions").glob("*.json")
        for path in paths:
            if remove:
                path.unlink()
            else:
                path.write_bytes(b"!" + path.read_bytes()[1:])

    service.fault_injector = corrupt
    result = service.submit(opted([output([("b", "20")])], "two", sid))
    assert result["status"] == "rejected_publication", result
    assert result["errors"][0]["code"] == "ROW_VERSION_OBJECT_INVALID", result
    assert state_of(target)["active_head"] == sid
    assert sorted((target / "catalog/commits").iterdir()) == previous_commits


def test_target_marker_copy_cannot_authorize_prep_inode(tmp_path):
    service, target = _volume(tmp_path, "volume")
    first = _page(service, "one", [("a", "10")])
    sid = first["snapshot_id"]
    _adopt(service, target, sid)
    prep_marker = service.prep_root / "workspace" / versions.ADOPTION_REL
    prep_marker.parent.mkdir(parents=True)
    prep_marker.write_bytes((target / versions.ADOPTION_REL).read_bytes())
    result = service.submit(opted([output([("b", "20")])], "two", sid))
    assert result["state"] == "rejected", result
    assert result["errors"][0]["code"] == "ADOPTION_BINDING_INVALID", result
    assert state_of(target)["active_head"] == sid


@pytest.mark.parametrize("drift_stage", ["target_verified", "before_activate"])
def test_target_adoption_drift_blocks_activation_and_same_request_can_retry(tmp_path, drift_stage):
    service, target = _volume(tmp_path, "volume")
    first = _page(service, "one", [("a", "10")])
    sid = first["snapshot_id"]
    _adopt(service, target, sid)
    marker = target / versions.ADOPTION_REL
    original = marker.read_bytes()

    def remove_marker(stage, details):
        if stage == drift_stage:
            marker.unlink()

    service.fault_injector = remove_marker
    doc = opted([output([("b", "20")])], "two", sid)
    result = service.submit(doc)
    assert result["status"] == "rejected_publication", result
    assert result["errors"][0]["code"] == "ROW_VERSION_ADOPTION_CHANGED", result
    assert state_of(target)["active_head"] == sid
    commit_path = target / f"catalog/commits/{result['snapshot_id']}.json"
    assert commit_path.exists() is (drift_stage == "before_activate")

    marker.write_bytes(original)
    if drift_stage == "before_activate":
        object_path = target / next(iter(_object_paths(snapshot_of(target, result["snapshot_id"]))))
        object_bytes = object_path.read_bytes()

        def corrupt_on_resume(stage, details):
            if stage == "before_activate" and details.get("resume"):
                object_path.unlink()

        service.fault_injector = corrupt_on_resume
        rejected = service.submit(doc)
        assert rejected["status"] == "rejected_publication", rejected
        assert rejected["errors"][0]["code"] == "ROW_VERSION_OBJECT_INVALID", rejected
        assert state_of(target)["active_head"] == sid
        assert commit_path.is_file()
        object_path.write_bytes(object_bytes)

        commit_bytes = commit_path.read_bytes()

        def change_commit_on_resume(stage, details):
            if stage == "before_activate" and details.get("resume"):
                commit_path.write_bytes(commit_bytes + b"\n")

        service.fault_injector = change_commit_on_resume
        rejected = service.submit(doc)
        assert rejected["status"] == "rejected_publication", rejected
        assert rejected["errors"][0]["code"] == "TARGET_COMMIT_DIGEST_MISMATCH", rejected
        assert state_of(target)["active_head"] == sid
        commit_path.write_bytes(commit_bytes)

    service.fault_injector = None
    retried = service.submit(doc)
    assert retried["state"] == "published_formal", retried
    assert retried["snapshot_id"] == result["snapshot_id"]
    assert state_of(target)["active_head"] == result["snapshot_id"]
    assert retried["formal_publication_verified"] is True
    assert service.request_status(doc["request_identity"])["state"] == "published_formal"
    result_output = retried["output_results"][0]
    ledger = HoldingLedger(target, service.binding.instance_id)
    held = {(row["record_id"], row["record_version"])
            for fact in ledger.facts()
            if fact["snapshot_id"] == retried["snapshot_id"] and fact["product_id"] == result_output["product_id"]
            for row in fact["records"] if row["stages"].get("published_readable")}
    assert held == {(row["record_id"], row["record_version"]) for row in result_output["records"]}


def test_shared_format_limit_does_not_fall_back_to_embedded_metadata(tmp_path, monkeypatch):
    service, target = _volume(tmp_path, "volume")
    first = _page(service, "one", [("a", "10")])
    sid = first["snapshot_id"]
    _adopt(service, target, sid)
    monkeypatch.setattr(versions, "MAX_REFERENCES", 1)
    doc = opted([output([("b", "20")])], "two", sid)
    result = service.submit(doc)
    assert "REFERENCE_COUNT_LIMIT" in str(result), result
    assert result["state"] != "published_formal", result
    assert state_of(target)["active_head"] == sid
    assert len(list((target / "catalog/commits").glob("*.json"))) == 1


def test_empty_adopted_target_requires_empty_head_digest(tmp_path):
    service, target = _volume(tmp_path, "volume")
    WFDDuckDBPrototype(
        target, load_protocol_validator(service.protocol_root), runtime_root=service.runtime_root,
        sandbox=False, writer_host=service.binding.writer_host,
    )
    _adopt(service, target, None)
    state_path = target / "catalog/state.json"
    valid_state = state_path.read_bytes()
    state = state_of(target)
    state["head_snapshot_sha256"] = "sha256:None"
    state_path.write_text(json.dumps(state), encoding="utf-8")
    result = service.submit(opted([output([("a", "10")])], "one"))
    assert result["state"] == "rejected", result
    assert result["errors"][0]["code"] == "TARGET_HEAD_DIGEST_MISMATCH", result
    assert not list((target / "catalog/commits").glob("*.json"))

    state_path.write_bytes(valid_state)
    first = _page(service, "one", [("a", "10")])
    assert len(_object_paths(snapshot_of(target, first["snapshot_id"]))) == 1


def test_new_row_objects_cannot_write_through_prep_directory_link(tmp_path):
    service, target = _volume(tmp_path, "volume")
    first = _page(service, "one", [("a", "10")])
    sid = first["snapshot_id"]
    _adopt(service, target, sid)
    outside = tmp_path / "outside-prep"
    outside.mkdir()
    object_dir = service.prep_root / "workspace/catalog/product_service/row_versions"
    object_dir.parent.mkdir(parents=True)
    object_dir.symlink_to(outside, target_is_directory=True)
    result = service.submit(opted([output([("b", "20")])], "two", sid))
    assert "OBJECT_SYMLINK" in str(result), result
    assert result["state"] != "published_formal", result
    assert not list(outside.iterdir())
    assert state_of(target)["active_head"] == sid


def test_target_adoption_during_legacy_publication_blocks_commit(tmp_path):
    service, target = _volume(tmp_path, "volume")
    first = _page(service, "one", [("a", "10")])
    sid = first["snapshot_id"]
    marker_file = target / versions.ADOPTION_REL
    _adopt(service, target, sid)
    marker_bytes = marker_file.read_bytes()
    marker_file.unlink()

    def add_marker(stage, details):
        if stage == "target_verified":
            marker_file.write_bytes(marker_bytes)

    service.fault_injector = add_marker
    result = service.submit(opted([output([("b", "20")])], "two", sid))
    assert result["status"] == "rejected_publication", result
    assert result["errors"][0]["code"] == "ROW_VERSION_ADOPTION_CHANGED", result
    assert not (target / f"catalog/commits/{result['snapshot_id']}.json").exists()
    assert state_of(target)["active_head"] == sid
