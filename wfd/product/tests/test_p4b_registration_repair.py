#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P4B registration/repair focused tests: data-only deps + reuse roots.

Only isolated tmp volumes.  No real WFD/BD write.  The old independent-audit
failure files under 03/.../独立审核 are left untouched.
"""
from __future__ import annotations

import copy
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from test_p4b_precise_hydration import (
    MARKET, OBJECT, _calendar_data, _calendar_ref, _product, _trading_calendar, _volume,
)
from test_r1_data_only import (
    HERE, NAMESPACE, UNITS, request, scalar_output,
)
from test_r2a_volume_publication import FakeDetector, VOL_UUID
from wfd_sdk import product_calendar
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, canonical, load_protocol_validator, sha
from wfd_sdk.product_data_service import WFDDataOnlyService
from wfd_sdk.product_volume_service import WFDVolumeService
from wfd_sdk.volume_publication import VolumeBinding

DATASET = "wfd_r1_local"
ROLES = {"read", "register", "submit", "publish"}


def _volume_for(target: Path, runtime: Path) -> WFDVolumeService:
    binding = VolumeBinding(mount_point=str(target), volume_uuid=VOL_UUID,
                            filesystem="exfat", writer_host="p4b-hydration",
                            writer_epoch=0)
    return WFDVolumeService(
        binding=binding, runtime_root=runtime, protocol_root=HERE / "protocol",
        caller_roles=ROLES, caller_id="p4b-repair", unit_registry=UNITS,
        trusted_actor_namespaces={NAMESPACE}, detector=FakeDetector())


def _local(target: Path, runtime: Path, *, readonly: bool = False):
    engine = WFDDuckDBPrototype(
        target, load_protocol_validator(HERE / "protocol", entry="wfd-data-only-write.schema.json"),
        runtime_root=runtime, sandbox=False, writer_host="p4b-hydration",
        read_only=readonly)
    return WFDDataOnlyService(
        engine, caller_roles=ROLES, caller_id="p4b-repair",
        unit_registry=UNITS, trusted_actor_namespaces={NAMESPACE})


def _head_bytes(target: Path, sid: str):
    return ((target / "catalog/state.json").read_bytes(),
            (target / f"catalog/snapshots/{sid}.json").read_bytes())


def _internal_output(key, semantic, value="10"):
    item = scalar_output(key, semantic, value)
    internal = copy.deepcopy(item)
    internal["new_definition_declaration"] = internal.pop("definition")
    return internal


def _process_rows(target, runtime, product_id, snapshot_id):
    code = r"""
import json, sys
from pathlib import Path
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_data_service import WFDDataOnlyService
target, protocol, runtime, pid, sid, units, ns = sys.argv[1:8]
engine = WFDDuckDBPrototype(Path(target), load_protocol_validator(Path(protocol), entry="wfd-data-only-write.schema.json"),
                            runtime_root=Path(runtime), sandbox=False, read_only=True)
service = WFDDataOnlyService(engine, caller_roles=("read",), caller_id="repair-read",
                             unit_registry=json.loads(units),
                             trusted_actor_namespaces={ns})
read = service.read(pid, snapshot_id=sid)
print(json.dumps([{"record_id": row["record_id"], "row": row["row"]}
                  for row in read["rows"]], ensure_ascii=False, sort_keys=True))
"""
    completed = subprocess.run(
        [sys.executable, "-c", code, str(target), str(HERE / "protocol"),
         str(runtime), product_id, snapshot_id, json.dumps(UNITS), NAMESPACE],
        cwd=str(HERE), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    assert completed.returncode == 0, completed.stderr.decode("utf-8", "replace")
    return json.loads(completed.stdout.decode("utf-8"))


def _registered_fixture(tmp_path, name):
    service, target = _volume(tmp_path, name)
    parent = service.submit(request([scalar_output("parent", "repair.parent", "1")],
                                    name + "-parent"))
    assert parent["state"] == "published_formal", parent
    direct = _local(target, tmp_path / (name + "-direct"))
    registered, state = direct._register(
        _internal_output("registered", "repair.registered.not.in.snapshot"),
        DATASET, {"_wfd_data_only": True})
    assert state == "registered", state
    # 注册但未发布的产品必须由受信操作者显式绑定写入目标；
    # 测试不通过请求内容或语义相似性自动采用目标。
    binding = service.register_write_target(
        DATASET, registered["product_id"], registered["definition_ref"],
        reason="explicit fixture for registered-only hydration")
    assert binding["state"] == "registered", binding
    reuse = scalar_output("reuse", "ignored.request.semantic", "7")
    reuse.update(definition_mode="reuse",
                 definition_ref=copy.deepcopy(registered["definition_ref"]),
                 definition=None)
    doc = request([reuse], name + "-reuse", parent=parent["snapshot_id"])
    return service, target, parent["snapshot_id"], registered, doc


def _calendar_fixture(tmp_path, name):
    service, target = _volume(tmp_path, name)
    calendar = service.submit(request(
        [_trading_calendar("cal", ["2025-02-03", "2025-02-04"])], name + "-cal"))
    assert calendar["state"] == "published_formal", calendar
    sid = calendar["snapshot_id"]
    pid = calendar["output_results"][0]["product_id"]
    ref = _calendar_ref(service, pid, sid)
    data = service.submit(request([_calendar_data(ref, observation_date="2025-02-03")], name + "-data", parent=sid))
    assert data["state"] == "published_formal", data
    return service, target, calendar, data, ref


# --------------------------------------------------------------------------- 1
def test_registered_only_reuse_hydrates_definition_and_registry(tmp_path):
    service, target, parent_sid, registered, doc = _registered_fixture(
        tmp_path, "registered")
    result = service.submit(doc)
    assert result["state"] == "published_formal", {"state": result["state"], "errors": result.get("errors"),
        "outputs": [{"key": item.get("output_key"), "errors": item.get("errors")}
                    for item in result.get("output_results", [])]}
    new_pid = result["output_results"][0]["product_id"]
    assert new_pid == registered["product_id"]
    collected = {item["relpath"] for item in service.last_hydration["collected_files"]}
    digest = registered["definition_ref"]["digest"].split(":")[-1]
    assert f"catalog/product_service/definitions/{digest}.json" in collected
    assert (f"catalog/product_service/products/{registered['product_id']}/"
            "definition_1.json") in collected
    rows = _process_rows(target, tmp_path / "registered-read", new_pid,
                         result["snapshot_id"])
    assert [row["record_id"] for row in rows] == ["row-reuse"]


# --------------------------------------------------------------------------- 2
def test_registered_only_reuse_wrong_ref_body_registry_rejected(tmp_path):
    # wrong ref
    service, target, parent_sid, registered, doc = _registered_fixture(
        tmp_path, "badref")
    sid = service._target_service().engine.read_snapshot(parent_sid)["snapshot_id"]
    before = _head_bytes(target, parent_sid)
    bad = copy.deepcopy(doc)
    bad["outputs"][0]["definition_ref"]["id"] = "def_" + "0" * 24
    rejected = service.submit(bad)
    assert rejected["state"] == "rejected", rejected
    assert rejected["errors"][0]["code"] in {
        "DEFINITION_REFERENCE_MISMATCH", "P4B_REUSE_DEFINITION_DIGEST_INVALID"}, rejected
    assert _head_bytes(target, parent_sid) == before

    # wrong definition body
    service, target, parent_sid, registered, doc = _registered_fixture(
        tmp_path, "badbody")
    digest = registered["definition_ref"]["digest"].split(":")[-1]
    definition_path = target / f"catalog/product_service/definitions/{digest}.json"
    body = json.loads(definition_path.read_text("utf-8"))
    body["declaration"]["semantic_code"] = "tampered.semantic"
    definition_path.write_text(json.dumps(body, ensure_ascii=False,
                                          sort_keys=True, separators=(",", ":")),
                               encoding="utf-8")
    before = _head_bytes(target, parent_sid)
    rejected = service.submit(doc)
    assert rejected["state"] == "rejected", rejected
    assert rejected["errors"][0]["code"] == "DEFINITION_DIGEST_MISMATCH", rejected
    assert _head_bytes(target, parent_sid) == before

    # registry version missing its real dependencies
    service, target, parent_sid, registered, doc = _registered_fixture(
        tmp_path, "badregistry")
    version_path = (target / "catalog/product_service/products"
                    / registered["product_id"] / "definition_1.json")
    record = json.loads(version_path.read_text("utf-8"))
    tampered_deps = [{
        "dataset_id": DATASET, "product_id": "p_" + "0" * 24,
        "snapshot_id": "s_" + "0" * 24, "role": "calendar_ref",
        "required": True}]
    record["contracts"]["read"]["dependencies"] = copy.deepcopy(tampered_deps)
    version_path.write_text(json.dumps(record, ensure_ascii=False,
                                       sort_keys=True, separators=(",", ":")),
                            encoding="utf-8")
    before = _head_bytes(target, parent_sid)
    rejected = service.submit(doc)
    assert rejected["state"] == "rejected", rejected
    assert rejected["errors"][0]["code"] in {
        "P4B_REUSE_REGISTRY_DEPENDENCY_MISMATCH",
        "DATA_ONLY_REGISTRATION_DEPENDENCY_MISMATCH"}, rejected
    assert _head_bytes(target, parent_sid) == before
    assert json.loads(version_path.read_text("utf-8"))[
        "contracts"]["read"]["dependencies"] == tampered_deps


# --------------------------------------------------------------------------- 3
def test_calendar_first_registration_and_reuse_sequence(tmp_path):
    service, target, calendar, data, ref = _calendar_fixture(tmp_path, "calendar-seq")
    data_pid = data["output_results"][0]["product_id"]
    version_path = (target / "catalog/product_service/products"
                    / data_pid / "definition_1.json")
    before = version_path.read_bytes()
    version = json.loads(before)
    fixed = _product(target, data["snapshot_id"], data_pid)
    compiled = product_calendar.dependencies(fixed["declaration"], DATASET)
    assert version["contracts"]["read"]["dependencies"] == compiled
    assert fixed["contracts"]["read"]["dependencies"] == compiled

    reuse = _calendar_data(ref, observation_date="2025-02-03")
    reuse.update(definition_mode="reuse",
                 definition_ref=data["output_results"][0]["definition_ref"],
                 definition=None)
    reuse["payload"]["rows"][0]["business_key"] = "data-row-reuse"
    doc = request([reuse], "calendar-reuse-same-sequence",
                  parent=data["snapshot_id"])
    again = service.submit(doc)
    assert again["state"] == "published_formal", again
    assert again["output_results"][0]["product_id"] == data_pid
    assert json.loads(version_path.read_text("utf-8"))[
        "definition_sequence"] == 1
    assert version_path.read_bytes() == before
    assert json.loads(version_path.read_text("utf-8"))[
        "contracts"]["read"]["dependencies"] == compiled


# --------------------------------------------------------------------------- 4
def test_old_candidate_registration_deps_missing_rejected_by_register(tmp_path):
    service, target, calendar, data, ref = _calendar_fixture(tmp_path, "old-candidate")
    data_pid = data["output_results"][0]["product_id"]
    version_path = (target / "catalog/product_service/products"
                    / data_pid / "definition_1.json")
    record = json.loads(version_path.read_text("utf-8"))
    record["contracts"]["read"]["dependencies"] = []
    version_path.write_text(json.dumps(record, ensure_ascii=False,
                                       sort_keys=True, separators=(",", ":")),
                            encoding="utf-8")
    before = _head_bytes(target, data["snapshot_id"])
    direct_target = tmp_path / "old-candidate-copy"
    shutil.copytree(target, direct_target)
    direct = _local(direct_target, tmp_path / "old-candidate-direct")
    declaration = record["declaration"]
    compiled = product_calendar.dependencies(declaration, DATASET)
    internal = copy.deepcopy(_calendar_data(ref, observation_date="2025-02-03"))
    internal["new_definition_declaration"] = internal.pop("definition")
    internal.update(definition_mode="reuse",
                    definition_ref=data["output_results"][0]["definition_ref"],
                    new_definition_declaration=None, definition=None)
    with pytest.raises(ValueError, match="DATA_ONLY_REGISTRATION_DEPENDENCY_MISMATCH"):
        direct._register(internal, DATASET, {
            "_wfd_data_only": True, "read_dependencies": compiled})
    assert json.loads(version_path.read_text("utf-8"))[
        "contracts"]["read"]["dependencies"] == []
    assert _head_bytes(target, data["snapshot_id"]) == before


# --------------------------------------------------------------------------- 5
def test_no_refs_control_registration_and_reuse(tmp_path):
    service, target = _volume(tmp_path, "control")
    parent = service.submit(request([scalar_output("m1", "repair.control", "1")],
                                    "control-parent"))
    assert parent["state"] == "published_formal", parent
    pid = parent["output_results"][0]["product_id"]
    version_path = target / f"catalog/product_service/products/{pid}/definition_1.json"
    before = version_path.read_bytes()
    version = json.loads(before)
    assert version["contracts"]["read"]["dependencies"] == []
    reuse = scalar_output("m1", "repair.control", "2")
    reuse.update(definition_mode="reuse",
                 definition_ref=parent["output_results"][0]["definition_ref"],
                 definition=None)
    reuse["payload"]["rows"][0]["business_key"] = "row-m1-2"
    again = service.submit(request([reuse], "control-reuse",
                                   parent=parent["snapshot_id"]))
    assert again["state"] == "published_formal", again
    assert again["output_results"][0]["product_id"] == pid
    assert version_path.read_bytes() == before


# --------------------------------------------------------------------------- 6
def test_public_calendar_a_then_compacted_b_then_first_old_a_ref(tmp_path):
    service, target = _volume(tmp_path, "public-chain")
    calendar = service.submit(request(
        [_trading_calendar("cal", ["2025-02-03", "2025-02-04"])],
        "public-chain-calendar"))
    assert calendar["state"] == "published_formal", calendar
    a_sid = calendar["snapshot_id"]
    a_pid = calendar["output_results"][0]["product_id"]
    ref = _calendar_ref(service, a_pid, a_sid)

    reader = _local(target, tmp_path / "public-chain-compaction")
    a_rows = reader.engine.read_product(a_pid, snapshot_id=a_sid)[0]["rows"]
    compaction = reader.engine.publish_compaction({a_pid: list(reversed(a_rows))})
    assert compaction["status"] == "published_compaction", compaction
    b_sid = compaction["snapshot_id"]
    snap_b = json.loads((target / f"catalog/snapshots/{b_sid}.json").read_text("utf-8"))
    a_rel = next(entry for entry in json.loads(
        (target / f"catalog/snapshots/{a_sid}.json").read_text("utf-8"))["files"]
        if entry["product_id"] == a_pid)["file_relpath"]
    assert a_rel not in {entry["file_relpath"] for entry in snap_b["files"]}

    # Unrelated objects must not enter the hydration inventory.
    orphan = {
        "catalog/product_service/data_only_status/" + "e" * 64 + ".json": b"{bad status",
        "catalog/snapshots/s_" + "f" * 24 + ".json": b"{bad snapshot",
        "catalog/product_service/products/p_" + "f" * 24 + ".json": b"{bad flat",
        "foundation/orphan_payload.bin": b"UNRELATED_PAYLOAD",
    }
    for rel, body in orphan.items():
        path = target / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)

    main_item = _calendar_data(ref, observation_date="2025-02-03")
    main_item["payload"]["rows"][0]["values"]["amount"]["value"] = "9"
    main_item["payload"]["rows"][0]["business_key"] = "main-row"
    doc = request([main_item], "public-chain-main", parent=b_sid)
    fresh = _volume_for(target, tmp_path / "public-chain-fresh-runtime")
    result = fresh.submit(doc)
    assert result["state"] == "published_formal", result
    main_sid = result["snapshot_id"]
    main_pid = result["output_results"][0]["product_id"]
    assert json.loads((target / "catalog/state.json").read_text("utf-8"))[
        "active_head"] == main_sid

    raw_main = fresh._target_service().engine.read_product(
        main_pid, snapshot_id=main_sid)[0]["rows"]
    assert raw_main[0]["values"]["amount"]["value"] == "9"
    main_rows = _process_rows(target, tmp_path / "public-chain-read-main",
                              main_pid, main_sid)
    assert [row["record_id"] for row in main_rows] == ["main-row"]
    assert main_rows[0]["row"]["subject"] == MARKET
    a_read = _process_rows(target, tmp_path / "public-chain-read-a", a_pid, a_sid)
    assert len(a_read) == 2
    dates = sorted(row["row"]["values"]["session_date"]["value"] for row in a_read)
    assert dates == ["2025-02-03", "2025-02-04"]
    assert {row["record_id"] for row in a_read} != {"main-row"}
    collected = {item["relpath"] for item in fresh.last_hydration["collected_files"]}
    assert not set(orphan) & collected
    assert not any("data_only_status" in p or "data_only_intents" in p
                   or "data_only_submission_plans" in p for p in collected)


# --------------------------------------------------------------------------- 7
def test_old_candidate_deps_empty_rejected_by_public_submit(tmp_path):
    service, target, calendar, data, ref = _calendar_fixture(
        tmp_path, "old-candidate-public")
    data_pid = data["output_results"][0]["product_id"]
    version_path = (target / "catalog/product_service/products"
                    / data_pid / "definition_1.json")
    record = json.loads(version_path.read_text("utf-8"))
    record["contracts"]["read"]["dependencies"] = []
    version_path.write_text(json.dumps(record, ensure_ascii=False,
                                       sort_keys=True, separators=(",", ":")),
                            encoding="utf-8")
    before = _head_bytes(target, data["snapshot_id"])
    reuse = _calendar_data(ref, observation_date="2025-02-03")
    reuse.update(definition_mode="reuse",
                 definition_ref=data["output_results"][0]["definition_ref"],
                 definition=None)
    reuse["payload"]["rows"][0]["business_key"] = "data-row-public-old"
    rejected = service.submit(request([reuse], "old-candidate-public",
                                      parent=data["snapshot_id"]))
    assert rejected["state"] == "rejected", rejected
    assert rejected["errors"][0]["code"] in {
        "R1_DEFINITION_VERSION_BINDING_MISMATCH",
        "P4B_REUSE_REGISTRY_DEPENDENCY_MISMATCH",
        "DATA_ONLY_REGISTRATION_DEPENDENCY_MISMATCH"}, rejected
    assert _head_bytes(target, data["snapshot_id"]) == before
    assert json.loads(version_path.read_text("utf-8"))[
        "contracts"]["read"]["dependencies"] == []
