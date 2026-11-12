#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P4B focused acceptance: precise native prep hydration from a real volume.

Only isolated tmp targets are used.  No /Volumes/WFD or BD path is touched.
The calendar-ref positive path stops at the existing publication seam
(R4a _add_product_closure version/contracts/read-dependency check); hydration
itself is independently exercised and the seam is asserted explicitly.
"""
from __future__ import annotations

import copy
import datetime
import json
import subprocess
import sys
from pathlib import Path

import pytest

from test_r1_data_only import (
    HERE, NAMESPACE, UNITS, request, scalar_output,
)
from test_r2a_volume_publication import FakeDetector, VOL_UUID
from wfd_sdk.duckdb_sdk import product_content_digest
from wfd_sdk.product_holdings import HoldingLedger
from wfd_sdk.product_volume_service import WFDVolumeService
from wfd_sdk.volume_publication import VolumeBinding

MARKET = {"kind": "market", "namespace": "wfd.local", "id": "XSHG"}
OBJECT = {"kind": "physical_object", "namespace": "wfd.local", "id": "object_1"}
TRADING_FIELDS = [
    {"field_code": "session_date", "data_type": "text", "unit_code": "text",
     "measurement_nature": "event", "time_role": "session_date"},
    {"field_code": "is_open", "data_type": "boolean", "unit_code": "not_applicable",
     "measurement_nature": "event", "time_role": "session_date"},
    {"field_code": "market_code", "data_type": "text", "unit_code": "text",
     "measurement_nature": "event", "time_role": "session_date"},
    {"field_code": "day_type", "data_type": "text", "unit_code": "text",
     "measurement_nature": "event", "time_role": "session_date"},
]
ROLES = {"semantic", "read_layout", "algorithm_dependency", "update_release"}


def _volume(tmp_path, name):
    target = tmp_path / name
    target.mkdir()
    binding = VolumeBinding(mount_point=str(target), volume_uuid=VOL_UUID,
                            filesystem="exfat", writer_host="p4b-hydration",
                            writer_epoch=0)
    service = WFDVolumeService(
        binding=binding, runtime_root=tmp_path / (name + "_runtime"),
        protocol_root=HERE / "protocol",
        caller_roles={"read", "register", "submit", "publish"},
        caller_id="p4b-hydration", unit_registry=UNITS,
        trusted_actor_namespaces={NAMESPACE}, detector=FakeDetector())
    return service, target


def _product(target, snapshot_id, product_id):
    snapshot = json.loads(
        (target / f"catalog/snapshots/{snapshot_id}.json").read_text("utf-8"))
    entry = next(item for item in snapshot["files"]
                 if item["product_id"] == product_id)
    return entry["source_bundle"]["_wfd_product_bindings"][entry["output_key"]]["product"]


def _product_paths(product):
    pid = product["product_id"]
    paths = set()
    for role, ref in product["contract_refs"].items():
        paths.add(f"catalog/product_service/contracts/{role}/"
                  f"{ref['digest'].split(':')[-1]}.json")
    paths.add("catalog/product_service/contract_bundles/"
              f"{product['contract_bundle_ref']['digest'].split(':')[-1]}.json")
    paths.add("catalog/product_service/definitions/"
              f"{product['definition_ref']['digest'].split(':')[-1]}.json")
    paths.add(f"catalog/product_service/products/{pid}/"
              f"definition_{product['definition_sequence']}.json")
    paths.add("catalog/product_service/contracts/"
              f"{product['contract_ref']['digest'].split(':')[-1]}.json")
    return paths


def _head_bytes(target, snapshot_id):
    return ((target / "catalog/state.json").read_bytes(),
            (target / f"catalog/snapshots/{snapshot_id}.json").read_bytes())


def _new_process_read(target, runtime, product_id, snapshot_id):
    code = r"""
import json, sys
from pathlib import Path
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_data_service import WFDDataOnlyService
target, protocol, runtime, pid, sid, units, namespace = sys.argv[1:8]
engine = WFDDuckDBPrototype(Path(target), load_protocol_validator(Path(protocol), entry="wfd-data-only-write.schema.json"),
                            runtime_root=Path(runtime), sandbox=False, read_only=True)
service = WFDDataOnlyService(engine, caller_roles=("read",),
                             caller_id="p4b-new-process",
                             unit_registry=json.loads(units),
                             trusted_actor_namespaces={namespace})
read = service.read(pid, snapshot_id=sid)
print(json.dumps([{"record_id": row["record_id"],
                   "record_version": row["record_version"]} for row in read["rows"]],
                 ensure_ascii=False, sort_keys=True))
"""
    completed = subprocess.run(
        [sys.executable, "-c", code, str(target), str(HERE / "protocol"),
         str(runtime), product_id, snapshot_id,
         json.dumps(UNITS, ensure_ascii=False), NAMESPACE],
        cwd=str(HERE), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=120)
    assert completed.returncode == 0, completed.stderr.decode("utf-8", "replace")
    return json.loads(completed.stdout.decode("utf-8"))


# --------------------------------------------------------------------------- calendar helpers
def _day(value):
    parsed = datetime.date.fromisoformat(value)
    nxt = (parsed + datetime.timedelta(days=1)).isoformat()
    return {"status": "known", "precision": "day",
            "earliest_utc": value + "T00:00:00Z",
            "latest_exclusive_utc": nxt + "T00:00:00Z",
            "source_timezone": "Asia/Shanghai"}


def _tabular(key, semantic, subject, fields, rows, time=None,
             logical_domain="foundation"):
    item = scalar_output(key, semantic, "1")
    item["subject"] = subject
    item["logical_domain"] = logical_domain
    item["definition"]["unit_code"] = "per_field"
    item["definition"]["field_definitions"] = fields
    item["definition"]["time_role"] = "observation"
    if time:
        item["definition"]["semantic_context"]["time"] = time
    item["payload"] = {"kind": "tabular_rows", "rows": rows}
    return item


def _trading_calendar(key, dates):
    rows = [{
        "business_key": key + "-" + value, "subject": MARKET,
        "observation_time": _day(value),
        "values": {
            "session_date": {"data_type": "text", "value_state": "valid_value",
                             "value": value},
            "is_open": {"data_type": "boolean", "value_state": "valid_value",
                        "value": True},
            "market_code": {"data_type": "text", "value_state": "valid_value",
                            "value": MARKET["id"]},
            "day_type": {"data_type": "text", "value_state": "valid_value",
                         "value": "trading"},
        }} for value in dates]
    return _tabular(key, "wfd.foundation.calendar.trading_days", MARKET,
                    TRADING_FIELDS, rows,
                    {"period_type": "natural", "timezone": "Asia/Shanghai"})


def _calendar_digest(service, product_id, snapshot_id):
    snapshot = service.engine.read_snapshot(snapshot_id)
    entries = [entry for entry in snapshot["files"]
               if entry["product_id"] == product_id]
    blocks = service.engine.read_product(product_id, snapshot_id=snapshot_id)
    parts = [{"output_key": entry["output_key"],
              "payload_kind": entry.get("payload_kind"),
              "rows": block["rows"], "source": block["source"]}
             for entry, block in zip(entries, blocks)]
    return product_content_digest(product_id, parts)


def _calendar_ref(service, product_id, snapshot_id):
    return {"kind": "product_snapshot", "namespace": "wfd.product",
            "id": product_id, "version": snapshot_id,
            "digest": _calendar_digest(service, product_id, snapshot_id),
            "dataset_id": "wfd_r1_local", "resolution": "pinned",
            "required": True, "dependency_type": "read"}


def _calendar_data(ref, *, subject=None, observation_date="2025-01-02"):
    field = {"field_code": "amount", "data_type": "decimal", "unit_code": "count",
             "measurement_nature": "flow", "time_role": "observation"}
    subject = copy.deepcopy(subject or MARKET)
    row = {"business_key": "data-row", "subject": subject,
           "observation_time": _day(observation_date),
           "values": {"amount": {"data_type": "decimal",
                                 "value_state": "valid_value", "value": "7"}}}
    item = _tabular("data", "p4b.calendar.data", subject, [field], [row],
                    {"period_type": "natural", "timezone": "Asia/Shanghai"},
                    logical_domain="observations")
    item["definition"]["field_semantic_context"] = {
        "amount": {"time": {"period_type": "trading", "calendar_ref": ref}}}
    return item


# --------------------------------------------------------------------------- 1
def test_cold_hot_inventory_simple_positive_and_new_process_read(tmp_path):
    service, target = _volume(tmp_path, "target-simple")
    doc_a = request([scalar_output("ma", "p4b.simple", "10")], "p4b-simple-a")
    result_a = service.submit(doc_a)
    assert result_a["state"] == "published_formal", result_a
    sid_a = result_a["snapshot_id"]
    pid_a = result_a["output_results"][0]["product_id"]
    doc_b = request([scalar_output("mb", "p4b.simple.b", "20")],
                    "p4b-simple-b", parent=sid_a)
    prep = service.prep_root / "workspace"

    cold = service._seed_prep_from_target(prep, sid_a, document=doc_b)
    product_a = _product(target, sid_a, pid_a)
    expected = _product_paths(product_a) | {
        f"catalog/snapshots/{sid_a}.json",
        f"catalog/commits/{sid_a}.json",
        "catalog/state.json", "catalog/retention.json",
        "catalog/product_service/volume_binding.json",
    }
    # data, manifest, formal receipt and holding/proof are also exact closure
    assert expected <= {item["relpath"] for item in cold["collected_files"]}
    assert cold["mode"] == "cold"
    assert not any("data_only_status" in item["relpath"]
                   or "data_only_intents" in item["relpath"]
                   or "data_only_submission_plans" in item["relpath"]
                   or "governance/receipts" in item["relpath"]
                   for item in cold["collected_files"])
    assert f"catalog/product_service/products/{pid_a}.json" not in {
        item["relpath"] for item in cold["collected_files"]}

    state_before = (prep / "catalog/state.json").read_bytes()
    retention_before = (prep / "catalog/retention.json").read_bytes()
    hot = service._seed_prep_from_target(prep, sid_a, document=doc_b)
    assert hot["mode"] == "hot"
    assert hot["state_and_retention_skipped"] is True
    assert (prep / "catalog/state.json").read_bytes() == state_before
    assert (prep / "catalog/retention.json").read_bytes() == retention_before

    # Hot backfill: a missing exact dependency file is restored on the next
    # hydrate without copying any unrelated historical object.
    role_rel = next(item["relpath"] for item in cold["collected_files"]
                    if "/contracts/semantic/" in item["relpath"])
    (prep / role_rel).unlink()
    backfilled = service._seed_prep_from_target(prep, sid_a, document=doc_b)
    assert backfilled["mode"] == "hot"
    assert (prep / role_rel).is_file()

    result_b = service.submit(doc_b)
    assert result_b["state"] == "published_formal", result_b
    assert result_b["snapshot_id"] != sid_a
    assert json.loads((target / "catalog/state.json").read_text("utf-8"))[
        "active_head"] == result_b["snapshot_id"]

    # Fixed read of A in a genuinely new process after B replaced HEAD.
    read_a = _new_process_read(target, tmp_path / "new-process-runtime",
                               pid_a, sid_a)
    assert read_a == [{"record_id": "row-ma",
                       "record_version": result_a["output_results"][0]["records"][0]["record_version"]}]
    assert service.last_hydration["mode"] == "hot"
    assert service.last_hydration["collected_files"]
    assert not (prep / "catalog/product_service/data_only_status").exists()


# --------------------------------------------------------------------------- 2
def test_reuse_real_definition_hydrates_exact_digest_body(tmp_path):
    service, target = _volume(tmp_path, "target-reuse")
    doc_a = request([scalar_output("ma", "p4b.reuse", "10")], "p4b-reuse-a")
    result_a = service.submit(doc_a)
    assert result_a["state"] == "published_formal", result_a
    sid_a = result_a["snapshot_id"]
    pid_a = result_a["output_results"][0]["product_id"]
    ref = result_a["output_results"][0]["definition_ref"]
    reuse = scalar_output("mb", "p4b.reuse", "20")
    reuse.update(definition_mode="reuse", definition_ref=copy.deepcopy(ref),
                 definition=None)
    doc_b = request([reuse], "p4b-reuse-b", parent=sid_a)
    result_b = service.submit(doc_b)
    assert result_b["state"] == "published_formal", result_b
    digest = ref["digest"].split(":")[-1]
    collected = {item["relpath"] for item in service.last_hydration["collected_files"]}
    assert f"catalog/product_service/definitions/{digest}.json" in collected
    assert f"catalog/product_service/products/{pid_a}/definition_1.json" in collected
    definition = json.loads(
        (target / f"catalog/product_service/definitions/{digest}.json").read_text("utf-8"))
    assert definition["definition_ref"] == ref
    assert "sha256:" + __import__("hashlib").sha256(
        json.dumps(definition["declaration"], ensure_ascii=False, sort_keys=True,
                   separators=(",", ":")).encode("utf-8")).hexdigest() == ref["digest"]
    read = service.read(result_b["output_results"][0]["product_id"],
                        snapshot_id=result_b["snapshot_id"])
    assert {row["record_id"] for row in read["rows"]} >= {"row-ma", "row-mb"}


# --------------------------------------------------------------------------- 3
def test_explicit_previous_is_hydrated_and_stale_still_rejected(tmp_path):
    service, target = _volume(tmp_path, "target-previous")
    doc_a1 = request([scalar_output("m1", "p4b.stale", "10")], "p4b-stale-1")
    a1 = service.submit(doc_a1)
    assert a1["state"] == "published_formal", a1
    pid = a1["output_results"][0]["product_id"]
    record1 = a1["output_results"][0]["records"][0]
    correction = scalar_output("m1", "p4b.stale", "11")
    correction.update(definition_mode="reuse",
                      definition_ref=a1["output_results"][0]["definition_ref"],
                      definition=None, input_mode="source_correction")
    correction["revisions"] = {"row-m1": {
        "previous": {"product_id": pid, "snapshot_id": a1["snapshot_id"],
                     "logical_key": "row-m1",
                     "revision_id": record1["record_version"]},
        "reason": "accepted correction"}}
    a2 = service.submit(request([correction], "p4b-stale-2",
                                parent=a1["snapshot_id"]))
    assert a2["state"] == "published_formal", a2

    stale = scalar_output("m1", "p4b.stale", "12")
    stale.update(definition_mode="reuse",
                 definition_ref=a1["output_results"][0]["definition_ref"],
                 definition=None, input_mode="source_correction")
    stale["revisions"] = {"row-m1": {
        "previous": {"product_id": pid, "snapshot_id": a1["snapshot_id"],
                     "logical_key": "row-m1",
                     "revision_id": record1["record_version"]},
        "reason": "stale predecessor"}}
    result = service.submit(request([stale], "p4b-stale-3",
                                    parent=a2["snapshot_id"]))
    assert result.get("state") != "published_formal", result
    codes = {item.get("code") for item in result.get("errors", [])}
    for output in result.get("output_results", []):
        codes.update(item.get("code") for item in output.get("errors", []))
    assert "REVISION_STALE_PREDECESSOR" in codes, result
    assert json.loads((target / "catalog/state.json").read_text("utf-8"))[
        "active_head"] == a2["snapshot_id"]
    assert not (target / f"catalog/commits/{result.get('snapshot_id')}.json").exists()
    collected = {item["relpath"] for item in service.last_hydration["collected_files"]}
    assert f"catalog/snapshots/{a1['snapshot_id']}.json" in collected
    assert f"catalog/snapshots/{a2['snapshot_id']}.json" in collected
    # A1 was first added as ancestor metadata, then upgraded to a full
    # payload/product closure because it is the explicit revision predecessor.
    snapshot_a1 = json.loads(
        (target / f"catalog/snapshots/{a1['snapshot_id']}.json").read_text("utf-8"))
    assert snapshot_a1["files"][0]["file_relpath"] in collected
    assert _product_paths(_product(target, a1["snapshot_id"], pid)) <= collected


# --------------------------------------------------------------------------- 4
def _fresh_a(tmp_path, name):
    service, target = _volume(tmp_path, name)
    result = service.submit(request([scalar_output("ma", "p4b.missing", "10")],
                                    name + "-a"))
    assert result["state"] == "published_formal", result
    return service, target, result


def test_missing_wrong_source_and_dest_conflict_leave_target_untouched(tmp_path):
    # missing old role in target
    service, target, a = _fresh_a(tmp_path, "missing")
    sid, pid = a["snapshot_id"], a["output_results"][0]["product_id"]
    product = _product(target, sid, pid)
    role_rel = ("catalog/product_service/contracts/semantic/"
                f"{product['contract_refs']['semantic']['digest'].split(':')[-1]}.json")
    state_bytes, head_bytes = _head_bytes(target, sid)
    (target / role_rel).unlink()
    doc_b = request([scalar_output("mb", "p4b.missing.b", "20")],
                    "missing-b", parent=sid)
    rejected = service.submit(doc_b)
    assert rejected["state"] == "rejected", rejected
    assert rejected["errors"][0]["code"] == "PREP_SOURCE_MISSING", rejected
    assert _head_bytes(target, sid) == (state_bytes, head_bytes)

    # wrong old role in target
    service, target, a = _fresh_a(tmp_path, "wrong")
    sid, pid = a["snapshot_id"], a["output_results"][0]["product_id"]
    product = _product(target, sid, pid)
    role_rel = ("catalog/product_service/contracts/semantic/"
                f"{product['contract_refs']['semantic']['digest'].split(':')[-1]}.json")
    state_bytes, head_bytes = _head_bytes(target, sid)
    path = target / role_rel
    path.write_bytes(path.read_bytes() + b"\n")
    doc_b = request([scalar_output("mb", "p4b.wrong.b", "20")],
                    "wrong-b", parent=sid)
    rejected = service.submit(doc_b)
    assert rejected["state"] == "rejected", rejected
    assert rejected["errors"][0]["code"] == "PREP_SOURCE_DIGEST_MISMATCH", rejected
    assert _head_bytes(target, sid) == (state_bytes, head_bytes)

    # different bytes at the same prep destination
    service, target, a = _fresh_a(tmp_path, "dest")
    sid, pid = a["snapshot_id"], a["output_results"][0]["product_id"]
    product = _product(target, sid, pid)
    role_rel = ("catalog/product_service/contracts/semantic/"
                f"{product['contract_refs']['semantic']['digest'].split(':')[-1]}.json")
    doc_b = request([scalar_output("mb", "p4b.dest.b", "20")],
                    "dest-b", parent=sid)
    prep = service.prep_root / "workspace"
    service._seed_prep_from_target(prep, sid, document=doc_b)
    state_bytes, head_bytes = _head_bytes(target, sid)
    path = prep / role_rel
    path.write_bytes(path.read_bytes() + b"\n")
    rejected = service.submit(doc_b)
    assert rejected["state"] == "rejected", rejected
    assert rejected["errors"][0]["code"] == "PREP_DEST_CONFLICT", rejected
    assert _head_bytes(target, sid) == (state_bytes, head_bytes)


# --------------------------------------------------------------------------- 5
def test_holding_known_time_preserved_unknown_not_invented(tmp_path):
    service, target = _volume(tmp_path, "target-holding")
    a = service.submit(request([scalar_output("ma", "p4b.holding", "10")],
                               "p4b-holding-a"))
    assert a["state"] == "published_formal", a
    sid, pid = a["snapshot_id"], a["output_results"][0]["product_id"]
    doc_b = request([scalar_output("mb", "p4b.holding.b", "20")],
                    "p4b-holding-b", parent=sid)
    prep = service.prep_root / "workspace"
    hydration = service._seed_prep_from_target(prep, sid, document=doc_b)
    facts = [item for item in hydration["collected_files"]
             if "/holdings/" in item["relpath"]]
    proofs = [item for item in hydration["collected_files"]
              if "data_only_stage_proofs" in item["relpath"]]
    assert facts and proofs
    for item in facts:
        assert (prep / item["relpath"]).read_bytes() == (target / item["relpath"]).read_bytes()
    target_ledger = HoldingLedger(target, service.binding.instance_id)
    prep_ledger = HoldingLedger(prep, service.binding.instance_id)
    known_target = target_ledger.stage_times(
        snapshot_id=sid, product_id=pid, stage="published_readable")
    known_prep = prep_ledger.stage_times(
        snapshot_id=sid, product_id=pid, stage="published_readable")
    assert known_prep == known_target
    before = len(list(prep_ledger.dir.glob("*.json")))
    assert prep_ledger.stage_times(snapshot_id=sid, product_id="p_unknown",
                                   stage="published_readable") == {}
    assert len(list(prep_ledger.dir.glob("*.json"))) == before
    held = service._open_prep(prep).read(
        pid, snapshot_id=sid, perspective="system_held_at",
        at="2099-01-01T00:00:00Z", held_scope=service.binding.instance_id,
        usable_stage="published_readable", include_history=True)
    assert held["rows"]
    assert all(row.get("held_at") == list(known_target.values())[0]
               for row in held["rows"])


# --------------------------------------------------------------------------- 6
def test_calendar_ref_hydration_and_public_publication(tmp_path):
    service, target = _volume(tmp_path, "target-calendar")
    calendar = service.submit(request(
        [_trading_calendar("cal", ["2025-01-02", "2025-01-03"])],
        "p4b-calendar-a"))
    assert calendar["state"] == "published_formal", calendar
    sid = calendar["snapshot_id"]
    pid = calendar["output_results"][0]["product_id"]
    ref = _calendar_ref(service, pid, sid)
    doc_b = request([_calendar_data(ref)], "p4b-calendar-b", parent=sid)
    result = service.submit(doc_b)
    assert result.get("state") == "published_formal", result
    assert json.loads((target / "catalog/state.json").read_text("utf-8"))[
        "active_head"] == result["snapshot_id"]
    assert (target / f"catalog/commits/{result['snapshot_id']}.json").is_file()

    hydration = service.last_hydration
    assert hydration and hydration["mode"] == "cold"
    collected = {item["relpath"] for item in hydration["collected_files"]}
    product = _product(target, sid, pid)
    assert _product_paths(product) <= collected
    assert f"catalog/snapshots/{sid}.json" in collected

    new_pid = result["output_results"][0]["product_id"]
    new_sid = result["snapshot_id"]
    read = service.read(new_pid, snapshot_id=new_sid)
    assert [row["record_id"] for row in read["rows"]] == ["data-row"]
    fixed = _product(target, new_sid, new_pid)
    version = json.loads(
        (target / f"catalog/product_service/products/{new_pid}/definition_1.json"
         ).read_text("utf-8"))
    assert (version["contracts"]["read"]["dependencies"]
            == fixed["contracts"]["read"]["dependencies"])
    assert version["contracts"]["read"]["dependencies"], "calendar dependency must be persisted"


# --------------------------------------------------------------------------- 7
def test_ancestor_binding_three_snapshot_same_product(tmp_path):
    """_head_product_binding walks ancestor metadata while A2 binds prior A1."""
    service, target = _volume(tmp_path, "target-ancestor")
    a0 = service.submit(request([scalar_output("m1", "p4b.ancestor", "0")],
                                "p4b-ancestor-0"))
    assert a0["state"] == "published_formal", a0
    ref = a0["output_results"][0]["definition_ref"]

    def next_row(value, key, request_id, parent):
        output = scalar_output("m1", "p4b.ancestor", value)
        output.update(definition_mode="reuse", definition_ref=copy.deepcopy(ref),
                      definition=None)
        output["payload"]["rows"][0]["business_key"] = key
        return request([output], request_id, parent=parent)

    a1 = service.submit(next_row("1", "row-m1-1", "p4b-ancestor-1",
                                 a0["snapshot_id"]))
    assert a1["state"] == "published_formal", a1
    a2 = service.submit(next_row("2", "row-m1-2", "p4b-ancestor-2",
                                 a1["snapshot_id"]))
    assert a2["state"] == "published_formal", a2
    collected = {item["relpath"] for item in service.last_hydration["collected_files"]}
    for sid in (a0["snapshot_id"], a1["snapshot_id"]):
        assert f"catalog/snapshots/{sid}.json" in collected
        assert f"catalog/commits/{sid}.json" in collected
    assert (target / f"catalog/snapshots/{a2['snapshot_id']}.json").is_file()
    read = service.read(a2["output_results"][0]["product_id"],
                        snapshot_id=a2["snapshot_id"])
    assert {row["record_id"] for row in read["rows"]} == {
        "row-m1", "row-m1-1", "row-m1-2"}
