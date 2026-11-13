"""Contract-driven partitions and compatibility on the shared bulk lifecycle."""
from copy import deepcopy

import pytest

from test_p4b_precise_hydration import _volume
from test_r1_data_only import request as ordinary_request, scalar_output
from test_source_minute_batch import FIELDS, request as legacy_request, row, stage
from wfd_sdk import indexed_bulk as bulk, tabular_batch as tabular
from wfd_sdk.product_batches import ProductBatchLedger
from wfd_sdk.product_volume_service import WFDVolumeService


def request(batch_id, rows, parent=None, *, minute=False, partition="类目/本期"):
    header = legacy_request(batch_id, [row("20260407")], parent)
    output = header["outputs"][0]
    definition = output["definition"]
    fields = FIELDS if minute else ["category", "code", "label"]
    contract = {"version": tabular.CONTRACT, "fields": fields, "key_fields": fields[1:3][::-1] if minute else ["code"],
                "partition_field": None if minute else "category",
                "time": ({"kind": "source_minute", "date_field": fields[0], "minute_field": fields[1],
                          "timezone": "Asia/Shanghai"} if minute else {"kind": "unknown"})}
    contract["digest"] = bulk.digest(contract)
    definition["semantic_code"] = "source.generic.minute" if minute else "source.generic.lookup"
    definition["semantic_context"]["identity"]["identity_resolution_rule"] = tabular.identity_rule(contract)
    if not minute:
        definition["semantic_context"]["time"] = {"roles": {"public_time": "unknown"}}
        definition.pop("field_semantic_context")
        definition["field_definitions"] = [{**definition["field_definitions"][1], "field_code": code}
                                            for code in fields]
    from hashlib import sha256
    from wfd_sdk.duckdb_sdk import canonical
    header.update(protocol_version=tabular.PROTOCOL, field_codes=fields, partition={"value": partition},
                  row_count=len(rows), table_contract=contract,
                  rows_digest="sha256:" + sha256(b"".join(canonical(cells) + b"\n" for cells in rows)).hexdigest())
    return rehash(header)


def rehash(header):
    header["request_identity"]["submission_digest"] = bulk.header_identity(header)
    return header


def test_mixed_parent_chain_keeps_fixed_products_and_route(tmp_path):
    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [["类目/本期", "A1", "原值"], ["类目/本期", "A2", None]]
    base = volume.submit(ordinary_request([scalar_output("old", "test.legacy", "10")], "ordinary"))
    assert base["state"] == "published_formal", base
    old_rows = [row("20260407")]
    old = ledger.finalize(stage(ledger, legacy_request("old-bulk", old_rows, base["snapshot_id"]), [old_rows]))
    assert old["state"] == "published_formal", old
    header = request("lookup", rows, old["snapshot_id"])
    first = ledger.finalize(stage(ledger, header, [[rows[0]], [rows[1]]]))
    assert first["state"] == "published_formal", first
    locator = bulk.locator(first)
    page = ledger.read_source_minute_page(**locator, page_size=1)  # machine's existing operation seam
    assert page["protocol_version"] == tabular.PROTOCOL
    assert first["table_contract_digest"] == page["table_contract_digest"] == header["table_contract"]["digest"]
    assert page["rows"][0]["cells"] == rows[0]
    assert page["rows"][0]["record_id"] == "tabular_" + bulk.digest(["类目/本期", ["A1"]])[7:]
    assert ledger.read_source_minute_page(**locator, cursor=page["next_cursor"])["rows"][0]["cells"] == rows[1]
    assert ledger.status("lookup")["state"] == "published_formal"
    assert volume.request_status(first["request_identity"])["state"] == "published_formal"
    assert bulk.semantic_row(header, rows[0])[1]["observation_time"] == {"status": "unknown"}
    with pytest.raises(ValueError, match="BULK_LOCATOR_MISMATCH"):
        ledger.read_source_minute_page(**{**locator, "result_root": old["result_root"]})
    with pytest.raises(ValueError, match="BULK_COMMIT_INVALID"):
        ledger.read_bulk_page(**locator, protocol_version=bulk.legacy.PROTOCOL)
    minute_rows = [row("20260408"), row("20260409")]
    minute_header = request("generic-minute", minute_rows, first["snapshot_id"], minute=True)
    minute = ledger.finalize(stage(ledger, minute_header, [minute_rows]))
    assert minute["state"] == "published_formal", minute
    minute_page = ledger.read_source_minute_page(**bulk.locator(minute))
    assert [row["cells"] for row in minute_page["rows"]] == minute_rows
    assert bulk.semantic_row(minute_header, minute_rows[0])[1]["observation_time"]["precision"] == "minute"
    with pytest.raises(ValueError, match="BULK_CURSOR_INVALID"):
        ledger.read_source_minute_page(**bulk.locator(minute), cursor=page["next_cursor"])

    # The new partition has the same definition, subject and business key
    # mapping. A valid time adapter cannot change under that product binding.
    drift = request("drift", minute_rows, minute["snapshot_id"], minute=True, partition="不同标签")
    table = drift["table_contract"]
    table["time"] = {"kind": "unknown"}
    table.pop("digest")
    table["digest"] = bulk.digest(table)
    drift["outputs"][0]["definition"]["semantic_context"]["time"] = {"roles": {"public_time": "unknown"}}
    result = ledger.finalize(stage(ledger, rehash(drift), [minute_rows]))
    assert result["errors"][0]["code"] == "BULK_TABLE_CONTRACT_MISMATCH", result

    later_old_rows = [row("20260408")]
    later_old = ledger.finalize(stage(ledger, legacy_request("later-old", later_old_rows, minute["snapshot_id"]), [later_old_rows]))
    assert later_old["state"] == "published_formal", later_old
    scalar = scalar_output("old", "test.legacy", "11")
    scalar["payload"]["rows"][0]["business_key"] = "row-old-next"
    later = volume.submit(ordinary_request([scalar], "later", parent=later_old["snapshot_id"]))
    assert later["state"] == "published_formal", later
    sid = later["snapshot_id"]
    expected = {base["output_results"][0]["product_id"], first["product_id"], minute["product_id"], old["product_id"]}
    assert {item["product_id"] for item in volume.discover_products(snapshot_id=sid)["products"]} == expected
    assert len(volume.read(base["output_results"][0]["product_id"], snapshot_id=sid)["rows"]) == 2
    assert ledger.read_source_minute_page(**bulk.locator(old))["rows"][0]["cells"] == old_rows[0]
    assert "protocol_version" not in ledger.read_source_minute_page(**bulk.locator(old))
    with pytest.raises(ValueError, match="BULK_PARTITION_LOCATOR_REQUIRED"):
        volume.read(first["product_id"], snapshot_id=sid)

    duplicate = ledger.finalize(stage(ledger, request("different-boundary", rows, sid), [rows]))
    assert duplicate["state"] == "unchanged" and bulk.locator(duplicate) == locator
    changed = [["类目/本期", "A1", "changed"], rows[1]]
    conflict = ledger.finalize(stage(ledger, request("changed", changed, sid), [changed]))
    assert conflict["state"] == "conflicts_pending", conflict
    assert volume.snapshot_status()["snapshot_id"] == sid


def test_tabular_restart_and_competing_parent(tmp_path):
    volume, target = _volume(tmp_path, "target")
    root = tmp_path / "ledger"
    ledger = ProductBatchLedger(volume, ledger_root=root)
    rows = [["类目/本期", "A1", "原值"]]
    batch_id = stage(ledger, request("interrupt", rows), [rows])

    def interrupt(stage, _):
        if stage == "before_fixed_read":
            raise RuntimeError("interrupted")

    volume.fault_injector = interrupt
    with pytest.raises(RuntimeError, match="interrupted"):
        ledger.finalize(batch_id)
    state_path = target / "catalog/state.json"
    state = state_path.read_bytes()
    restarted = WFDVolumeService(binding=volume.binding, runtime_root=volume.runtime_root,
        protocol_root=volume.protocol_root, caller_roles=volume.caller_roles, caller_id=volume.caller_id,
        unit_registry=volume.unit_registry, detector=volume.detector)
    ledger = ProductBatchLedger(restarted, ledger_root=root)
    status = ledger.status(batch_id)
    assert status["activation_state"] == "activated" and status["recovery_required"]
    assert state_path.read_bytes() == state
    result = ledger.finalize(batch_id)
    assert result["state"] == "published_formal" and not result["staging_cleanup_required"]
    assert state_path.read_bytes() == state
    competitor = request("other", rows)
    stale = ledger.finalize(stage(ledger, competitor, [rows]))
    assert stale["errors"][0]["code"] == "PARENT_CHANGED"
    assert state_path.read_bytes() == state


@pytest.mark.parametrize("fault,code", [
    ("wrong-order", "BULK_ROW_ORDER_OR_DUPLICATE"), ("wrong-partition", "BULK_ROW_PARTITION_MISMATCH"),
    ("wrong-fields", "BULK_DEFINITION_SCOPE_INVALID"), ("wrong-identity", "BULK_DEFINITION_SCOPE_INVALID"),
    ("blank-key", "BULK_ROW_IDENTITY_INVALID"), ("wrong-time", "BULK_ROW_TIME_INVALID"),
])
def test_tabular_rejects_unbound_rows_and_definition(tmp_path, fault, code):
    volume, target = _volume(tmp_path, "target")
    volume.unit_registry["date"] = {"dimension": "date"}
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [["类目/本期", "A1", "first"], ["类目/本期", "A2", "second"]]
    if fault == "wrong-order":
        rows[1][1] = "A1"
    if fault == "wrong-partition":
        rows[1][0] = "other"
    if fault == "blank-key":
        rows[1][1] = "\ufeff\u0085"
    if fault == "wrong-time":
        rows = [row("20260407")]
        rows[0][1] = "2026-04-08 09:30:00"
    header = request("rejected", rows, minute=fault == "wrong-time")
    definition = header["outputs"][0]["definition"]
    if fault == "wrong-fields":
        definition["field_definitions"].reverse()
    if fault == "wrong-identity":
        definition["semantic_context"]["identity"]["identity_resolution_rule"] = "other"
    result = ledger.finalize(stage(ledger, rehash(header), [rows]))
    assert result["state"] == "rejected" and result["errors"][0]["code"] == code, result
    assert not (target / "catalog/state.json").exists()


def test_contract_digest_and_rule_are_checked_at_begin(tmp_path):
    volume, _ = _volume(tmp_path, "target")
    ledger = ProductBatchLedger(volume, ledger_root=tmp_path / "batch")
    rows = [["类目/本期", "A1", "first"]]
    header = request("contract", rows)
    tampered = deepcopy(header)
    tampered["table_contract"]["key_fields"] = ["label"]
    with pytest.raises(ValueError, match="BULK_TABLE_CONTRACT_INVALID"):
        stage(ledger, rehash(tampered), [rows])
    header["table_contract"]["time"] = {"kind": "expression"}
    header["table_contract"].pop("digest")
    header["table_contract"]["digest"] = bulk.digest(header["table_contract"])
    with pytest.raises(ValueError, match="BULK_TABLE_TIME_INVALID"):
        stage(ledger, rehash(header), [rows])
