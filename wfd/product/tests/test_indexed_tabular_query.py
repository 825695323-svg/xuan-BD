"""Fixed product queries through signed pages of real published Parquet."""
from copy import deepcopy
import errno
from io import BytesIO, TextIOWrapper
import json
from pathlib import Path

import pytest

from test_p4b_precise_hydration import _volume
from test_r1_data_only import request as ordinary_request, scalar_output
from test_source_minute_batch import FIELDS, request as legacy_request, row, stage
from test_tabular_batch import request, rehash
from wfd_sdk import indexed_bulk as bulk, joint_state, product_machine, tabular_batch, usage_suspension
from wfd_sdk.duckdb_sdk import canonical
from wfd_sdk.product_batches import ProductBatchLedger
from wfd_sdk.product_query import PROTOCOL_VERSION, ProductQuery, ProductQueryError
from wfd_sdk.product_volume_service import WFDVolumeService


def publish(ledger, header, rows):
    result = ledger.finalize(stage(ledger, header, [rows]))
    assert result["state"] == "published_formal", result
    return result


def restart(volume):
    return WFDVolumeService(binding=volume.binding, runtime_root=volume.runtime_root,
                            protocol_root=volume.protocol_root, caller_roles=volume.caller_roles,
                            caller_id=volume.caller_id, unit_registry=volume.unit_registry,
                            detector=volume.detector)


def minute_header(batch_id, rows, parent=None):
    header = request(batch_id, rows, parent, minute=True, partition=rows[0][0])
    contract = header["table_contract"]
    contract["partition_field"] = FIELDS[0]
    contract.pop("digest")
    contract["digest"] = bulk.digest(contract)
    header["outputs"][0]["definition"]["semantic_context"]["identity"]["identity_resolution_rule"] = tabular_batch.identity_rule(contract)
    return rehash(header)


def read_request(pid, sid, fields, indexed, **overrides):
    return {"protocol_version": PROTOCOL_VERSION, "operation": "read_product", "dataset_id": "wfd_r1_local",
            "snapshot_id": sid, "history_mode": "snapshot_contents", "knowledge_cutoff": None,
            "held_scope": None, "usable_stage": None, "subject": None, "product_id": pid,
            "fields": fields, "page_size": 1, "max_nodes": 4_000_000, "max_scan_bytes": 64 * 1024 * 1024,
            "indexed_tabular": indexed, **overrides}


def test_multidate_query_pins_membership_and_authenticates_cursor(tmp_path):
    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "ledger")
    first_rows = [row("20260407", minute="09:30", first="1.0000"), row("20260407", minute="09:31"), row("20260407", "000002")]
    second_rows = [row("20260409", minute="09:30", first="2.0000"), row("20260409", minute="09:31"), row("20260409", "000002")]
    first = publish(ledger, minute_header("day-a", first_rows), first_rows)
    second = publish(ledger, minute_header("day-b", second_rows, first["snapshot_id"]), second_rows)
    assert first["product_id"] == second["product_id"]
    ordinary = volume.submit(ordinary_request([scalar_output("separate", "other.scalar", "10")], "ordinary", parent=second["snapshot_id"]))
    assert ordinary["state"] == "published_formal", ordinary
    indexed = {"context_digest": bulk.digest(["classification", "fixed-membership"]),
               "match": {FIELDS[2]: ["000001"]}, "date_range": {"field": FIELDS[0], "format": "YYYYMMDD",
                                                            "start": "2026-04-07", "end": "2026-04-09"}}
    selected = read_request(first["product_id"], ordinary["snapshot_id"], [FIELDS[3], FIELDS[-1]], indexed)
    reader = ProductQuery(volume, protocol_root=volume.protocol_root)
    response = reader.execute(selected)
    assert all(response[key] is None for key in ("knowledge_cutoff", "held_scope", "usable_stage"))
    assert response["budget"]["verified_parts"] == 2
    assert response["page"]["total_rows"] == 4
    assert response["indexed_tabular"]["missing_partitions"] == ["20260408"]
    assert response["indexed_tabular"]["selection"] == {**indexed, "partitions": ["20260407", "20260408", "20260409"]}
    assert response["indexed_tabular"]["table_contract_digest"] == first["table_contract_digest"]
    assert [item["result_root"] for item in response["indexed_tabular"]["partitions"]] == [first["result_root"], second["result_root"]]
    assert [item["publication_snapshot_id"] for item in response["indexed_tabular"]["partitions"]] == [first["snapshot_id"], second["snapshot_id"]]
    item = response["rows"][0]
    assert item["values"][FIELDS[3]]["value"] == "1.0000"
    assert item["values"][FIELDS[-1]]["value_state"] == "unknown"
    authoritative = ledger.read_bulk_page(**bulk.locator(first))["rows"][0]
    assert item["record_id"] == authoritative["record_id"]
    assert item["record_version"] == authoritative["record_version"]
    cursor = response["page"]["next_cursor"]
    fresh = ProductQuery(restart(volume), protocol_root=volume.protocol_root)
    rest = fresh.execute({**selected, "cursor": cursor, "page_size": 1})
    assert rest["budget"]["verified_parts"] == 1
    assert [item["row_index"] for item in rest["rows"]] == [1]
    assert rest["page"]["total_rows"] == 4
    tail = fresh.execute({**selected, "cursor": rest["page"]["next_cursor"], "page_size": 2})
    assert tail["page"]["has_more"] is False
    assert [(item["partition"], item["row_index"]) for item in tail["rows"]] == [("20260409", 0), ("20260409", 1)]
    for modified in ({**selected, "snapshot_id": first["snapshot_id"]},
                     {**selected, "fields": [FIELDS[2]]},
                     {**selected, "indexed_tabular": {**indexed, "context_digest": bulk.digest("different evidence")}},
                     {**selected, "indexed_tabular": {**indexed, "match": {FIELDS[2]: ["000002"]}}}):
        with pytest.raises(ProductQueryError, match="CURSOR_QUERY_MISMATCH"):
            fresh.execute({**modified, "cursor": cursor})
    with pytest.raises(ProductQueryError, match="CURSOR_INVALID"):
        fresh.execute({**selected, "cursor": cursor[:-1] + "!"})

    catalog = target / bulk.node_relative(second["result_root"], protocol=tabular_batch.PROTOCOL)
    leaf = json.loads(catalog.read_bytes())
    part = target / bulk.part_relative(leaf["parts"][0]["sha256"], protocol=tabular_batch.PROTOCOL)
    raw = part.read_bytes()
    part.write_bytes(raw[:-1] + bytes([raw[-1] ^ 1]))
    with pytest.raises(ProductQueryError, match="BULK_PART_DIGEST_MISMATCH"):
        fresh.execute({**selected, "cursor": rest["page"]["next_cursor"]})
    with pytest.raises(ProductQueryError, match="BULK_PART_DIGEST_MISMATCH"):
        fresh.execute(selected)
    isolated = fresh.execute({**selected, "indexed_tabular": {**indexed, "partitions": ["20260407"]}})
    assert isolated["page"]["total_rows"] == 2 and isolated["budget"]["verified_parts"] == 1


def test_legacy_minute_interval_boundaries_and_governance(tmp_path):
    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "ledger")
    rows = [row("20260407", minute=minute) for minute in ("09:30", "09:31", "09:32")]
    formal = publish(ledger, legacy_request("minute-legacy", rows), rows)
    request = read_request(formal["product_id"], formal["snapshot_id"], [FIELDS[1]], {},
                           business_time_range={"role": "observation", "timezone": "Asia/Shanghai",
                                                "start": "2026-04-07T09:30:01", "end": "2026-04-07T09:31:59"})
    reader = ProductQuery(volume, protocol_root=volume.protocol_root)
    result = reader.execute(request)
    assert result["page"]["total_rows"] == 1
    assert result["rows"][0]["row_index"] == 1
    assert result["rows"][0]["values"][FIELDS[1]]["value"] == "2026-04-07 09:31:00"
    assert result["rows"][0]["business_time"]["earliest_utc"] == "2026-04-07T01:31:00Z"
    explicit = deepcopy(request)
    explicit["indexed_tabular"]["partitions"] = ["20260407"]
    explicit["business_time_range"].update(timezone="UTC", start="2026-04-07T01:30:01", end="2026-04-07T01:31:59")
    assert reader.execute(explicit)["rows"] == result["rows"]
    broad = {**request, "indexed_tabular": {"partitions": ["20260407"]}, "business_time_range": None}
    old_cursor = reader.execute(broad)["page"]["next_cursor"]
    # Governance applies to the exact returned original revision under new queries.
    blocked = {"format_version": usage_suspension.FORMAT, "tickets": [], "issues": [
        {"issue_id": "minute-issue", "error_type": "test", "reason": "test scope", "state": "active",
         "scopes": [{"product_id": formal["product_id"], "record_versions": [result["rows"][0]["record_version"]]}]}]}
    (target / usage_suspension.FILENAME).write_bytes(canonical(blocked))
    with pytest.raises(ProductQueryError, match="USAGE_SUSPENDED"):
        reader.execute(request)
    with pytest.raises(ProductQueryError, match="USAGE_SUSPENDED"):
        reader.execute(broad)
    with pytest.raises(ProductQueryError, match="CURSOR_QUERY_MISMATCH"):
        reader.execute({**broad, "cursor": old_cursor})
    volume.caller_roles.remove("read")
    with pytest.raises(PermissionError, match="CALLER_PERMISSION_DENIED"):
        reader.execute(request)


@pytest.mark.parametrize("missing_after_lookup, expected_code", [
    (False, "BULK_OBJECT_MISSING"), (True, "INDEXED_QUERY_READ_FAILED"),
])
def test_missing_parquet_error_does_not_expose_storage_path(tmp_path, monkeypatch, missing_after_lookup, expected_code):
    volume, target = _volume(tmp_path, "target")
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "ledger")
    rows = [["本期", "001", "source"]]
    formal = publish(ledger, request("missing-parquet", rows, partition="本期"), rows)
    catalog = target / bulk.node_relative(formal["result_root"], protocol=tabular_batch.PROTOCOL)
    leaf = json.loads(catalog.read_bytes())
    part_relative = bulk.part_relative(leaf["parts"][0]["sha256"], protocol=tabular_batch.PROTOCOL)
    part = target / part_relative
    reader = ProductQuery(volume, protocol_root=volume.protocol_root)
    selected = read_request(formal["product_id"], formal["snapshot_id"], ["label"], {"partitions": ["本期"]})
    assert reader.execute(selected)["page"]["total_rows"] == 1

    if missing_after_lookup:
        checked_path = bulk.checked_path

        def remove_before_open(root, relative):
            path = checked_path(root, relative)
            if relative == part_relative:
                path.unlink()
            return path

        monkeypatch.setattr(bulk, "checked_path", remove_before_open)
    else:
        part.unlink()

    with pytest.raises(ProductQueryError) as rejected:
        reader.execute(selected)
    assert rejected.value.code == expected_code
    error = json.dumps(rejected.value.as_dict())
    for fragment in (str(target), part_relative, part.name, ".parquet", "[Errno", "No such file"):
        assert fragment not in error
    assert rejected.value.details == {}


@pytest.mark.parametrize("marker_method", ["read_text", "exists"])
def test_volume_marker_read_error_is_redacted_in_indexed_query(tmp_path, monkeypatch, capsys, marker_method):
    volume, target = _volume(tmp_path, "target")
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "ledger")
    rows = [["本期", "001", "source"]]
    formal = publish(ledger, request("unreadable-marker", rows, partition="本期"), rows)
    reader = ProductQuery(volume, protocol_root=volume.protocol_root)
    selected = read_request(formal["product_id"], formal["snapshot_id"], ["label"], {"partitions": ["本期"]})
    marker = (target / joint_state.MARKER).resolve()
    marker.write_bytes(canonical({"format": joint_state.FORMAT}))
    access_marker = getattr(Path, marker_method)

    def fail_marker_access(path, *args, **kwargs):
        if path == marker:
            raise OSError(errno.EIO, "private marker I/O diagnostic", str(path))
        return access_marker(path, *args, **kwargs)

    monkeypatch.setattr(Path, marker_method, fail_marker_access)
    with pytest.raises(ProductQueryError) as rejected:
        reader.execute(selected)
    assert rejected.value.as_dict() == {
        "code": "INDEXED_QUERY_READ_FAILED", "message": "Indexed tabular read failed", "details": {},
    }
    assert rejected.value.__context__ is None

    config = tmp_path / "machine.json"
    config.write_bytes(canonical({
        "protocol_version": product_machine.MACHINE_CONFIG_PROTOCOL,
        "connection_id": "indexed-marker", "profile": "data_only",
        "store": str(target), "runtime": str(volume.runtime_root),
        "project_root": str(volume.protocol_root.parent), "protocol_root": str(volume.protocol_root),
        "caller": {"caller_id": volume.caller_id, "trusted_actor_namespace": "wfd.local", "roles": ["read"]},
        "volume": volume.binding.to_dict(),
    }))
    envelope = {"protocol_version": product_machine.MACHINE_PROTOCOL, "request_id": "indexed-marker",
                "operation": "read_product", "arguments": {"request": selected}}
    monkeypatch.setattr("sys.stdin", TextIOWrapper(BytesIO(canonical(envelope)), encoding="utf-8"))
    assert product_machine.main(["--config", str(config)]) == 2
    output = capsys.readouterr().out
    result = json.loads(output)
    assert result["request_id"] == envelope["request_id"]
    assert result["ok"] is False
    assert result["error"]["code"] == rejected.value.code
    assert result["error"]["message"] == str(rejected.value)
    assert result["error"]["details"] == {}
    assert result["error"]["cause"] == f"ProductQueryError: {rejected.value}"
    for fragment in (str(marker), joint_state.MARKER, "[Errno", "private marker I/O diagnostic"):
        assert fragment not in output


def test_generic_dates_and_exact_matches_do_not_coerce_null_or_invent_time(tmp_path):
    volume, _ = _volume(tmp_path, "target")
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "ledger")
    rows = [["本期", "001", "20260407"], ["本期", "002", "20260431"], ["本期", "003", None],
            ["本期", "004", "20260501"], ["本期", "005", "2026-04-08"]]
    formal = publish(ledger, request("table", rows, partition="本期"), rows)
    reader = ProductQuery(volume, protocol_root=volume.protocol_root)
    indexed = {"partitions": ["本期"], "match": {"code": ["001", "002", "003", "005"]},
               "date_range": {"field": "label", "format": "YYYYMMDD", "start": "2026-04-01", "end": "2026-05-01"}}
    selected = read_request(formal["product_id"], formal["snapshot_id"], ["label", "code"], indexed)
    result = reader.execute(selected)
    assert result["rows"][0]["values"]["code"]["value"] == "001"
    assert result["rows"][0]["business_time"] == {"status": "unknown"}
    assert result["page"]["total_rows"] == 1
    assert reader.execute({**selected, "indexed_tabular": {**indexed, "match": {"code": []}}})["rows"] == []
    assert reader.execute({**selected, "indexed_tabular": {**indexed, "match": {"code": ["1"]}}})["rows"] == []
    with pytest.raises(ProductQueryError, match="FIELD_NOT_DEFINED"):
        reader.execute({**selected, "indexed_tabular": {**indexed, "match": {"unknown": ["001"]}}})
    with pytest.raises(ProductQueryError, match="SCAN_BUDGET_EXCEEDED"):
        reader.execute({**selected, "max_scan_bytes": 1})
    with pytest.raises(ProductQueryError, match="BULK_PARTITION_LOCATOR_REQUIRED"):
        reader.execute({**selected, "indexed_tabular": {"date_range": indexed["date_range"]}})


def test_row_group_pushdown_keeps_matching_read_within_candidate_budget(tmp_path):
    volume, _ = _volume(tmp_path, "target")
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "ledger")
    rows = [["本期", f"{index:05d}", "source"] for index in range(5000)]
    formal = publish(ledger, request("clustered-table", rows, partition="本期"), rows)
    reader = ProductQuery(volume, protocol_root=volume.protocol_root)
    selected = read_request(formal["product_id"], formal["snapshot_id"], ["label"],
                            {"partitions": ["本期"], "match": {"code": ["04999"]}}, max_nodes=1000)
    result = reader.execute(selected)
    assert result["page"]["total_rows"] == 1
    assert result["rows"][0]["row_index"] == 4999
    assert result["budget"]["pruned_row_groups"] == 1
    assert result["budget"]["candidate_rows"] == 904
    with pytest.raises(ProductQueryError, match="SCAN_NODE_BUDGET_EXCEEDED"):
        reader.execute({**selected, "indexed_tabular": {"partitions": ["本期"]}})
