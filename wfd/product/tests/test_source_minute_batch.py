"""Whole-date source-reported minute batches on isolated WFD volumes."""
from __future__ import annotations

import hashlib

import pytest

from test_p4b_precise_hydration import _volume
from test_r1_data_only import context
from wfd_sdk import indexed_bulk as bulk
from wfd_sdk.duckdb_sdk import canonical
from wfd_sdk.product_batches import BatchIncomplete, ProductBatchLedger


FIELDS = ["src_date", "src_minute", "src_identity", *[f"src_value_{i}" for i in range(8)]]


def row(date, identity="000001", minute="09:30", first="0.0"):
    label = f"{date[:4]}-{date[4:6]}-{date[6:]} {minute}:00"
    return [date, label, identity, first, "0", "1.0", "2", "3.0", "4", "5.0", None]


def request(request_id, rows, parent=None):
    partition = {"date": rows[0][0], "date_field": FIELDS[0], "minute_field": FIELDS[1],
                 "identity_field": FIELDS[2], "timezone": "Asia/Shanghai", "key_algorithm": bulk.legacy.KEY_ALGORITHM}
    output = {"output_key": "source.minute.bulk.test", "logical_domain": "observations",
              "subject": {"kind": "entity", "namespace": "wfd.local", "id": "source_table.test"},
              "definition_mode": "create", "input_mode": "partial_observation",
              "coverage": {"scope": {"sample_only": True}, "basis": "observed_partial",
                           "completeness": "partial", "absence_means": "unknown"},
              "payload": {"kind": "tabular_rows"},
              "definition": {"semantic_code": "source.minute.bulk.test", "definition_authority": "wfd.local",
                "measurement_nature": "mixed_observation", "unit_code": "per_field", "time_role": "observation",
                "semantic_context": context("source_claim", time={"period_type": "natural", "frequency": "source_reported_minute",
                    "interval": "half_open", "timezone": "Asia/Shanghai",
                    "roles": {"business_interval": "minute_label_bucket_not_verified_bar_interval"}},
                    identity={"subject_kind": "entity", "identity_resolution_rule": bulk.legacy.identity_rule(partition),
                              "alias_scope": "isolated test"}, content={"assertion_status": "source_reported"}),
                "field_semantic_context": {key: {"content": {"assertion_status": label}}
                    for key, label in zip(FIELDS, ["source_reported_date_label", "source_reported_minute_label",
                        "source_reported_identity_label", *["source_reported_lexeme_unit_unknown"] * 7,
                        "source_reported_observation"], strict=True)},
                "field_definitions": [{"field_code": key, "data_type": "text",
                    "unit_code": "date" if key == FIELDS[0] else "not_applicable",
                    "measurement_nature": "mixed_observation", "time_role": "observation"} for key in FIELDS]}}
    header = {"protocol_version": bulk.legacy.PROTOCOL, "request_identity": {"dataset_id": "wfd_r1_local",
                "trusted_actor_namespace": "wfd.local", "request_id": request_id},
              "producer_namespace": "wfd.local", "expected_parent_snapshot_id": parent, "outputs": [output],
              "field_codes": FIELDS, "partition": partition, "row_count": len(rows),
              "rows_digest": "sha256:" + hashlib.sha256(b"".join(canonical(item) + b"\n" for item in rows)).hexdigest()}
    header["request_identity"]["submission_digest"] = bulk.header_identity(header)
    return header


def stage(ledger, header, matrices):
    batch_id = header["request_identity"]["request_id"]
    expected = [{"chunk_id": f"chunk-{i}", "ordinal": i, "row_count": len(rows), "digest": bulk.digest(rows)}
                for i, rows in enumerate(matrices)]
    ledger.begin(batch_id, header=header, expected_chunks=expected)
    for declaration, rows in reversed(list(zip(expected, matrices, strict=True))):
        ledger.put_chunk(batch_id, output_key=header["outputs"][0]["output_key"], chunk_id=declaration["chunk_id"],
                         rows=rows, digest=declaration["digest"])
    return batch_id


def test_whole_date_publication(tmp_path):
    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}

    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [row("20260407"), row("20260407", minute="09:31"), row("20260407", "000002")]
    first = stage(ledger, request("first", rows), [rows[:1], rows[1:]])
    assert not (target / "catalog/state.json").exists()
    result = ledger.finalize(first)
    assert result["state"] == "published_formal", result
    locator = bulk.locator(result)
    page = ledger.read_source_minute_page(**locator, page_size=2)
    rest = ledger.read_source_minute_page(**locator, page_size=1, cursor=page["next_cursor"])
    assert [item["cells"] for item in page["rows"] + rest["rows"]] == rows
    assert bulk.digest(page["definition"]) == page["definition_ref"]["digest"]
    for key in ("definition", "definition_ref", "contract_refs", "contract_bundle_ref", "rows_digest"):
        assert page[key] == result[key] == rest[key]
    with pytest.raises(ValueError, match="BULK_CURSOR_INVALID"):
        ledger.read_source_minute_page(**locator, cursor=page["next_cursor"][:-1] + "*")
    assert volume.snapshot_status()["snapshot_id"] == result["snapshot_id"]
    assert len(list((target / "catalog/commits").glob("*.json"))) == 1


def test_read_page_increased_row_limit_retains_byte_budget_and_cursor(tmp_path):
    volume, _ = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [row("20260407", identity=f"{index:06d}", first="甲" * 200)
            for index in range(1200)]
    result = ledger.finalize(stage(ledger, request("bounded-page", rows), [rows]))
    assert result["state"] == "published_formal", result
    locator = bulk.locator(result)

    with pytest.raises(ValueError, match="BULK_PAGE_SIZE_INVALID"):
        ledger.read_source_minute_page(**locator, page_size=5001)

    first = ledger.read_source_minute_page(**locator, page_size=2)
    large = ledger.read_source_minute_page(**locator, page_size=5000, cursor=first["next_cursor"])
    assert 2 < len(large["rows"]) < len(rows) - 2
    assert len(canonical(large["rows"])) <= 768 * 1024
    assert large["next_cursor"] is not None
    final = ledger.read_source_minute_page(**locator, page_size=1000, cursor=large["next_cursor"])
    read = first["rows"] + large["rows"] + final["rows"]
    assert [item["row_index"] for item in read] == list(range(len(rows)))
    assert [item["cells"] for item in read] == rows
    assert final["next_cursor"] is None


def test_identical_date_reuses_original_identity_and_conflicting_date_is_atomic(tmp_path):
    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [row("20260407")]
    first = ledger.finalize(stage(ledger, request("first", rows), [rows]))
    assert first.get("state") == "published_formal", first.get("errors")
    other_rows = [row("20260408")]
    other = ledger.finalize(stage(ledger, request("next", other_rows, first["snapshot_id"]), [other_rows]))
    assert other.get("state") == "published_formal", other.get("errors")
    duplicate = ledger.finalize(stage(ledger, request("same", rows, other["snapshot_id"]), [rows]))
    assert duplicate.get("state") == "unchanged", duplicate.get("errors")
    assert bulk.locator(duplicate) == bulk.locator(first)
    assert duplicate["partition_fingerprint"] == first["partition_fingerprint"]
    assert duplicate["row_summary"]["duplicate_skipped"] == 1
    changed = [row("20260407", first="0")]
    conflict = ledger.finalize(stage(ledger, request("changed", changed, other["snapshot_id"]), [changed]))
    assert conflict.get("state") == "conflicts_pending", conflict.get("errors")
    assert conflict["row_summary"]["conflict_pending"] == 1
    assert volume.snapshot_status()["snapshot_id"] == other["snapshot_id"]
    assert len(list((target / "catalog/commits").glob("*.json"))) == 2


@pytest.mark.parametrize("fault_stage", ["target_verified", "before_activate", "before_fixed_read"])
def test_publication_resumes_same_candidate_after_interruption(tmp_path, fault_stage):
    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [row("20260407")]
    request_id = stage(ledger, request("first", rows), [rows])

    def interrupt(stage, _details):
        if stage == fault_stage:
            raise RuntimeError("stop requested")

    volume.fault_injector = interrupt
    with pytest.raises(RuntimeError, match="stop requested"):
        ledger.finalize(request_id)
    commits = list((target / "catalog/commits").glob("*.json"))
    assert len(commits) == (0 if fault_stage == "target_verified" else 1)
    if fault_stage != "before_fixed_read":
        assert not (target / "catalog/state.json").exists()
    before_status = {path.relative_to(target): path.read_bytes() for path in target.rglob("*.json")}
    status = ledger.status(request_id)
    assert status["phase"] == "finalizing"
    assert status["activation_state"] == ("activated" if fault_stage == "before_fixed_read" else "not_activated")
    assert status["recovery_required"] is True
    assert {path.relative_to(target): path.read_bytes() for path in target.rglob("*.json")} == before_status
    if fault_stage == "before_fixed_read":
        with pytest.raises(ValueError, match="BULK_PUBLICATION_NOT_FORMAL"):
            ledger.read_source_minute_page(**bulk.locator(status))
    volume.fault_injector = None
    result = ledger.finalize(request_id)
    assert result["state"] == "published_formal", result.get("errors")
    assert len(list((target / "catalog/commits").glob("*.json"))) == 1
    assert volume.snapshot_status()["snapshot_id"] == result["snapshot_id"]
    assert len(list((target / "catalog/product_service/holdings/source_minute").glob("*.json"))) == 1


def test_missing_chunk_duplicate_key_and_changed_partition_do_not_publish(tmp_path):
    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [row("20260407"), row("20260407")]
    header = request("dup", rows)
    chunk = [rows[0]]
    expected = [{"chunk_id": str(i), "ordinal": i, "row_count": 1, "digest": bulk.digest(chunk)} for i in range(2)]
    ledger.begin("dup", header=header, expected_chunks=expected)
    args = {"output_key": header["outputs"][0]["output_key"], "rows": chunk, "digest": bulk.digest(chunk)}
    ledger.put_chunk("dup", chunk_id="0", **args)
    with pytest.raises(BatchIncomplete):
        ledger.finalize("dup")
    ledger.put_chunk("dup", chunk_id="1", **args)
    result = ledger.finalize("dup")
    assert result["state"] == "rejected" and result["errors"][0]["code"] == "BULK_ROW_ORDER_OR_DUPLICATE"
    rows = [row("20260407"), row("20260408")]
    result = ledger.finalize(stage(ledger, request("mixed", rows), [[rows[0]], [rows[1]]]))
    assert result["state"] == "rejected" and result["errors"][0]["code"] == "BULK_ROW_PARTITION_MISMATCH"
    assert not (target / "catalog/state.json").exists()


def test_new_head_keeps_fixed_legacy_read_and_directory(tmp_path):
    from test_r1_data_only import request as legacy_request, scalar_output

    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    legacy = volume.submit(legacy_request([scalar_output("old", "test.legacy", "10")], "legacy"))
    assert legacy["state"] == "published_formal", legacy
    pid = legacy["output_results"][0]["product_id"]
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [row("20260407")]
    result = ledger.finalize(stage(ledger, request("first", rows, legacy["snapshot_id"]), [rows]))
    assert result["state"] == "published_formal", result.get("errors")
    sid = result["snapshot_id"]
    bulk_read = volume.read(pid, snapshot_id=sid)
    old_read = volume.read(pid, snapshot_id=legacy["snapshot_id"])
    assert bulk_read["snapshot_id"] == sid
    assert [(item["row"], item["record_version"]) for item in bulk_read["rows"]] == [
        (item["row"], item["record_version"]) for item in old_read["rows"]]
    assert {item["product_id"] for item in volume.discover_products(snapshot_id=sid)["products"]} == {pid, result["product_id"]}
    with pytest.raises(ValueError, match="BULK_PARTITION_LOCATOR_REQUIRED"):
        volume.read(None, snapshot_id=sid)
    later_output = scalar_output("old", "test.legacy", "11")
    later_output["payload"]["rows"][0]["business_key"] = "row-old-next"
    later = volume.submit(legacy_request([later_output], "legacy-next", parent=sid))
    assert later["state"] == "published_formal", later
    assert len(volume.read(pid, snapshot_id=later["snapshot_id"])["rows"]) == 2
    assert {item["product_id"] for item in volume.discover_products(snapshot_id=later["snapshot_id"])["products"]} == {pid, result["product_id"]}
    extra = [row("20260408")]
    next_date = ledger.finalize(stage(ledger, request("next", extra, later["snapshot_id"]), [extra]))
    assert next_date["state"] == "published_formal", next_date
    assert len(volume.read(pid, snapshot_id=next_date["snapshot_id"])["rows"]) == 2
    assert ledger.read_source_minute_page(**bulk.locator(result))["rows"][0]["cells"] == rows[0]
    assert volume.request_status(legacy["request_identity"])["state"] == "published_formal"
    assert volume.request_status(later["request_identity"])["state"] == "published_formal"
    assert volume.request_status(result["request_identity"])["phase"] == "finalized"
    assert volume.capabilities()["operations"]["submit"]["supported"] is True
    assert volume.capabilities()["profile"] == "data_only"


def test_readonly_reconcile_after_formal_holding_but_before_ledger(tmp_path, monkeypatch):
    from wfd_sdk.product_volume_service import WFDVolumeService

    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [row("20260407")]
    batch = stage(ledger, request("first", rows), [rows])
    atomic_json = ledger._atomic_json

    def lose_reply(path, record):
        if record["phase"] == "finalized":
            raise RuntimeError("ledger stopped")
        atomic_json(path, record)

    monkeypatch.setattr(ledger, "_atomic_json", lose_reply)
    with pytest.raises(RuntimeError, match="ledger stopped"):
        ledger.finalize(batch)
    state = (target / "catalog/state.json").read_bytes()
    reader = WFDVolumeService(binding=volume.binding, runtime_root=volume.runtime_root,
        protocol_root=volume.protocol_root, caller_roles=("read",), caller_id=volume.caller_id,
        unit_registry=volume.unit_registry, detector=volume.detector)
    restarted = ProductBatchLedger(reader, ledger_root=tmp_path / "batch")
    status = restarted.status(batch)
    assert status["phase"] == "finalized"
    assert status["activation_state"] == "activated" and status["recovery_required"] is False
    assert status["staging_cleanup_required"] is True
    assert restarted.read_source_minute_page(**bulk.locator(status))["rows"][0]["cells"] == rows[0]
    assert (target / "catalog/state.json").read_bytes() == state
    assert restarted._bulk_record(batch)["phase"] == "finalizing"
    monkeypatch.setattr(ledger, "_atomic_json", atomic_json)

    def must_not_publish(*args, **kwargs):
        pytest.fail("a formal candidate cannot publish again while clearing staging")

    monkeypatch.setattr(volume, "submit_bulk_batch", must_not_publish)
    repaired = ledger.finalize(batch)
    assert repaired["staging_cleanup_required"] is False
    assert restarted.status(batch)["staging_cleanup_required"] is False
    assert not ledger._bulk_chunk_path(batch, 0).exists()
    assert not (volume.prep_root / "source_minute" / volume._request_key(repaired["request_identity"])).exists()
    assert (target / "catalog/state.json").read_bytes() == state


def test_reconcile_partial_staging_release(tmp_path, monkeypatch):
    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [row("20260407"), row("20260407", minute="09:31")]
    batch = stage(ledger, request("first", rows), [[rows[0]], [rows[1]]])
    release = ledger._release_bulk_stage

    def stop_during_release(record):
        ledger._bulk_chunk_path(batch, 0).unlink()
        raise RuntimeError("release stopped")

    monkeypatch.setattr(ledger, "_release_bulk_stage", stop_during_release)
    with pytest.raises(RuntimeError, match="release stopped"):
        ledger.finalize(batch)
    state = (target / "catalog/state.json").read_bytes()
    assert ledger.status(batch)["phase"] == "finalized"
    assert ledger.status(batch)["staging_cleanup_required"] is True
    assert ledger._bulk_chunk_path(batch, 1).is_file()
    monkeypatch.setattr(ledger, "_release_bulk_stage", release)
    assert ledger.finalize(batch)["staging_cleanup_required"] is False
    assert ledger.status(batch)["staging_cleanup_required"] is False
    assert not ledger._bulk_chunk_path(batch, 1).exists()
    assert (target / "catalog/state.json").read_bytes() == state


def test_mixed_volume_checks_legacy_payload_and_rejects_incomplete_whole_store_ops(tmp_path):
    from test_r1_data_only import request as legacy_request, scalar_output
    from wfd_sdk.gc import GC, ClosureError
    from wfd_sdk.transfer import export_package, check_fast_forward
    from wfd_sdk.row_version_objects import RowVersionObjectError

    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    old = volume.submit(legacy_request([scalar_output("old", "test.legacy", "10")], "legacy"))
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [row("20260407")]
    new = ledger.finalize(stage(ledger, request("first", rows, old["snapshot_id"]), [rows]))
    assert new["phase"] == "finalized", new
    old_product = old["output_results"][0]["product_id"]
    package = tmp_path / "package"
    package.mkdir()
    retained = package / "preserved.txt"
    retained.write_text("preserve existing package")
    with pytest.raises(RowVersionObjectError, match="SOURCE_MINUTE_SNAPSHOT_OPERATION_UNSUPPORTED"):
        export_package(target, new["snapshot_id"], package)
    assert retained.is_file()
    assert not check_fast_forward(target, old["snapshot_id"])["ok"]
    with pytest.raises(ClosureError, match="SOURCE_MINUTE_SNAPSHOT_OPERATION_UNSUPPORTED"):
        GC(target).plan()
    with pytest.raises(RuntimeError, match="SOURCE_MINUTE_SNAPSHOT_OPERATION_UNSUPPORTED"):
        volume.engine.rebuild_sqlite_index()
    with pytest.raises(ValueError, match="BULK_PARTITION_LOCATOR_REQUIRED"):
        volume.read(None, snapshot_id=new["snapshot_id"])
    with pytest.raises(ValueError, match="BULK_PARTITION_LOCATOR_REQUIRED"):
        volume.read_product_page(new["product_id"], snapshot_id=new["snapshot_id"])
    read = volume.read_product_page(old_product, snapshot_id=new["snapshot_id"])
    assert read["snapshot_id"] == new["snapshot_id"] and len(read["rows"]) == 1
    with pytest.raises(ValueError, match="BULK_LOCATOR_MISMATCH"):
        ledger.read_source_minute_page(**{**bulk.locator(new), "result_root": "sha256:" + "0" * 64})
    part = next((target / "observations/source_minute").glob("*.parquet"))
    part.write_bytes(part.read_bytes() + b"\n")
    with pytest.raises(ValueError, match="BULK_PART_DIGEST_MISMATCH"):
        ledger.read_source_minute_page(**bulk.locator(new))
    assert volume.read(old_product, snapshot_id=new["snapshot_id"])["rows"]


def test_first_ordinary_write_after_bulk_only_parent_and_historical_bulk_recovery(tmp_path):
    from test_r1_data_only import request as legacy_request, scalar_output
    import json

    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [row("20260407")]
    batch = stage(ledger, request("first", rows), [rows])

    def interrupt(stage_name, _details):
        if stage_name == "before_fixed_read":
            raise RuntimeError("head advanced without a formal receipt")

    volume.fault_injector = interrupt
    with pytest.raises(RuntimeError, match="head advanced"):
        ledger.finalize(batch)
    volume.fault_injector = None
    original = ledger.status(batch)
    assert original["activation_state"] == "activated"
    sid = original["snapshot_id"]
    ordinary = volume.submit(legacy_request([scalar_output("old", "test.legacy", "10")], "legacy", parent=sid))
    assert ordinary["state"] == "published_formal", ordinary
    state_path = target / "catalog/state.json"
    state = json.loads(state_path.read_bytes())
    assert state["update_seq"] == 2
    # Model the bounded activation history after this entry has rolled out.
    state["activation_history"] = state["activation_history"][1:]
    state_path.write_bytes(canonical(state))
    before = state_path.read_bytes()
    assert ledger.status(batch)["activation_state"] == "activated"
    repaired = ledger.finalize(batch)
    assert repaired["phase"] == "finalized" and repaired["snapshot_id"] == sid
    assert repaired["staging_cleanup_required"] is False
    assert state_path.read_bytes() == before
    assert ledger.read_source_minute_page(**bulk.locator(repaired))["rows"][0]["cells"] == rows[0]


def test_batch_version_owner_and_staged_bytes_are_checked(tmp_path):
    from wfd_sdk.product_batches import BatchConflict, BatchError
    from wfd_sdk.product_volume_service import WFDVolumeService

    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [row("20260407")]
    header = request("changed", rows)
    expected = [{"chunk_id": "chunk-0", "ordinal": 0, "row_count": 1, "digest": bulk.digest(rows)}]
    with pytest.raises(BatchError, match="BATCH_HEADER_INVALID:protocol_version"):
        ledger.begin("changed", header={**header, "protocol_version": "wfd.source-minute-batch/2"},
                     expected_chunks=expected)
    batch = stage(ledger, header, [rows])
    altered = request(batch, [row("20260407", first="0")])
    with pytest.raises(BatchConflict, match="BATCH_ID_CONFLICT"):
        ledger.begin(batch, header=altered, expected_chunks=expected)
    other = WFDVolumeService(binding=volume.binding, runtime_root=volume.runtime_root,
        protocol_root=volume.protocol_root, caller_roles=("read", "submit", "publish"),
        caller_id="other-owner", unit_registry=volume.unit_registry, detector=volume.detector)
    assert ProductBatchLedger(other, ledger_root=tmp_path / "batch").status(batch)["phase"] == "not_found"
    ledger._bulk_chunk_path(batch, 0).write_bytes(canonical([row("20260407", first="0")]))
    rejected = ledger.finalize(batch)
    assert rejected["phase"] == "rejected" and rejected["errors"][0]["code"] == "BULK_CHUNK_DIGEST_MISMATCH"
    assert not (target / "catalog/state.json").exists()


def test_batch_rejects_changed_definition_projection_and_stale_parent(tmp_path):
    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [row("20260407")]
    first = ledger.finalize(stage(ledger, request("first", rows), [rows]))
    assert first["phase"] == "finalized", first
    next_rows = [row("20260408")]
    stale = ledger.finalize(stage(ledger, request("stale", next_rows), [next_rows]))
    assert stale["errors"][0]["code"] == "PARENT_CHANGED"
    changed = request("changed", next_rows, first["snapshot_id"])
    changed["partition"]["identity_field"] = FIELDS[-1]
    changed["request_identity"]["submission_digest"] = bulk.header_identity(changed)
    next_rows[0][-1] = "replacement identity"
    changed["rows_digest"] = "sha256:" + hashlib.sha256(canonical(next_rows[0]) + bytes([10])).hexdigest()
    changed["request_identity"]["submission_digest"] = bulk.header_identity(changed)
    rejected = ledger.finalize(stage(ledger, changed, [next_rows]))
    assert rejected["phase"] == "rejected" and rejected["errors"][0]["code"] == "BULK_DEFINITION_SCOPE_INVALID"
    assert len(list((target / "catalog/commits").glob("*.json"))) == 1


def test_bulk_terminal_duplicate_and_ordinary_duplicate_share_request_identity(tmp_path, monkeypatch):
    from test_duplicate_append import opted, output
    from test_r1_data_only import request as legacy_request, scalar_output

    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [row("20260407")]
    original = ledger.finalize(stage(ledger, request("original", rows), [rows]))
    atomic = ledger._atomic_json

    def lose_terminal_write(path, record):
        if record["phase"] == "finalized":
            raise RuntimeError("lost local duplicate result")
        atomic(path, record)

    duplicate_id = stage(ledger, request("same-key", rows, original["snapshot_id"]), [rows])
    monkeypatch.setattr(ledger, "_atomic_json", lose_terminal_write)
    with pytest.raises(RuntimeError, match="lost local duplicate result"):
        ledger.finalize(duplicate_id)
    status = ledger.status(duplicate_id)
    assert status["state"] == "unchanged" and status["staging_cleanup_required"] is True
    changed_ordinary = volume.submit(legacy_request([scalar_output("old", "test.legacy", "10")],
                                                    "same-key", parent=original["snapshot_id"]))
    assert changed_ordinary["errors"][0]["code"] == "REQUEST_ID_CONFLICT"
    monkeypatch.setattr(ledger, "_atomic_json", atomic)
    settled = ledger.finalize(duplicate_id)
    assert settled["state"] == "unchanged" and settled["staging_cleanup_required"] is False
    assert bulk.locator(settled) == bulk.locator(original)

    ordinary = volume.submit(opted([output([("a", "10")])], "ordinary", original["snapshot_id"]))
    assert ordinary["state"] == "published_formal", ordinary
    noop = volume.submit(opted([output([("a", "10")])], "ordinary-dup", ordinary["snapshot_id"]))
    assert noop["state"] == "unchanged", noop
    blocked = ledger.finalize(stage(ledger, request("ordinary-dup", rows, ordinary["snapshot_id"]), [rows]))
    assert blocked["errors"][0]["code"] == "REQUEST_ID_CONFLICT"
    assert len(list((target / "catalog/commits").glob("*.json"))) == 2


def test_bulk_request_status_rejects_cross_linked_formal_locator(tmp_path):
    import json

    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [row("20260407")]
    first = ledger.finalize(stage(ledger, request("first", rows), [rows]))
    rows = [row("20260408")]
    other = ledger.finalize(stage(ledger, request("other", rows, first["snapshot_id"]), [rows]))
    assert other["phase"] == "finalized", other
    path = target / first["formal_publication_ref"]
    altered = json.loads(path.read_bytes())
    altered.update(bulk.locator(other))
    path.write_bytes(canonical(altered))
    status = volume.request_status(first["request_identity"])
    assert status["request_identity"] == first["request_identity"]
    assert status["errors"][0]["code"] == "BULK_FORMAL_RECEIPT_MISMATCH"
    assert status["formal_publication_verified"] is False


def test_catalog_1200_dates_read_write_work_is_bounded(tmp_path, monkeypatch):
    from datetime import date, timedelta
    from time import perf_counter

    reads = 0
    read_node = bulk.read_node

    def observe_read(*args, **kwargs):
        nonlocal reads
        reads += 1
        return read_node(*args, **kwargs)

    monkeypatch.setattr(bulk, "read_node", observe_read)
    started = perf_counter()
    root = None
    writes = 0
    bytes_written = 0
    max_node = 0
    first_product = {"product_id": "p_" + "b" * 24}

    def write(rel, raw):
        nonlocal writes, bytes_written, max_node
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        writes += 1
        bytes_written += len(raw)
        max_node = max(max_node, len(raw))

    for index in range(1200):
        partition = (date(2020, 1, 1) + timedelta(days=index)).strftime("%Y%m%d")
        before = writes
        prior_reads = reads
        branches = bulk.partition_path(tmp_path, root, first_product["product_id"], partition)
        leaf = bulk.write_node({"kind": "date", "test_date": partition}, write)
        root = bulk.put_partition(write, branches, first_product, partition, leaf)
        assert writes - before == 4
        assert reads - prior_reads <= 3
    print({"dates": 1200, "node_reads": reads, "node_writes": writes, "max_node_bytes": max_node,
           "node_bytes_written": bytes_written, "elapsed_seconds": perf_counter() - started})
    assert writes == 4800 and max_node < 40_000 and bytes_written < 21 * 1024 * 1024
    for partition in ("20200101", "20211231", "20230101"):
        _, _, dates = bulk.partition_path(tmp_path, root, first_product["product_id"], partition)
        assert bulk.read_node(tmp_path, dates[partition], "date")["test_date"] == partition
