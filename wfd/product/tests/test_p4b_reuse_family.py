#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P4B repair2: reuse a fixed definition for a new subject/family.

No calendar refs are used, so the current core calendar admission branch is
not involved.  Only isolated tmp volumes; no real WFD/BD write.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from test_p4b_precise_hydration import _volume
from test_r1_data_only import request, scalar_output

SUBJECT_A = {"kind": "physical_object", "namespace": "wfd.local", "id": "object_a"}
SUBJECT_B = {"kind": "physical_object", "namespace": "wfd.local", "id": "object_b"}


def _output(key, semantic, subject, value="10"):
    item = scalar_output(key, semantic, value)
    item["subject"] = copy.deepcopy(subject)
    item["payload"]["rows"][0]["business_key"] = key + "-row"
    return item


def _two_family_published(tmp_path, name):
    service, target = _volume(tmp_path, name)
    a_output = _output("a", "p7b.daily_close", SUBJECT_A, "10")
    a = service.submit(request([a_output], name + "-a"))
    assert a["state"] == "published_formal", a
    a_pid = a["output_results"][0]["product_id"]
    a_sid = a["snapshot_id"]
    a_version = (target / "catalog/product_service/products"
                 / a_pid / "definition_1.json").read_bytes()
    a_snapshot = (target / f"catalog/snapshots/{a_sid}.json").read_bytes()
    a_record = a["output_results"][0]["records"][0]

    b_output = _output("b", "ignored.request.semantic", SUBJECT_B, "20")
    b_output.update(definition_mode="reuse",
                    definition_ref=copy.deepcopy(a["output_results"][0]["definition_ref"]),
                    definition=None)
    b = service.submit(request([b_output], name + "-b", parent=a_sid))
    assert b["state"] == "published_formal", b
    b_pid = b["output_results"][0]["product_id"]
    b_sid = b["snapshot_id"]
    b_version_path = (target / "catalog/product_service/products"
                      / b_pid / "definition_1.json")
    return {
        "service": service, "target": target, "a": a, "b": b,
        "a_pid": a_pid, "a_sid": a_sid, "a_version": a_version,
        "a_snapshot": a_snapshot, "a_record": a_record,
        "b_pid": b_pid, "b_sid": b_sid, "b_version_path": b_version_path,
    }


def test_new_subject_reuses_generic_definition_and_appends(tmp_path):
    env = _two_family_published(tmp_path, "new-family")
    service, target = env["service"], env["target"]
    a_pid, b_pid = env["a_pid"], env["b_pid"]

    # New subject/family: same fixed definition, different product identity.
    assert a_pid != b_pid
    b_version = json.loads(env["b_version_path"].read_text("utf-8"))
    a_version = json.loads(
        (target / "catalog/product_service/products" / a_pid
         / "definition_1.json").read_text("utf-8"))
    assert b_version["definition_sequence"] == 1
    assert b_version["definition_ref"] == a_version["definition_ref"]
    assert b_version["product_family_id"] != a_version["product_family_id"]
    assert b_version["contracts"]["read"]["dependencies"] == []
    assert service.last_hydration["mode"] == "cold"
    collected = {item["relpath"] for item in service.last_hydration["collected_files"]}
    digest = b_version["definition_ref"]["digest"].split(":")[-1]
    assert f"catalog/product_service/definitions/{digest}.json" in collected

    # A's old record/version and registry bytes are untouched.
    assert (target / "catalog/product_service/products" / a_pid
            / "definition_1.json").read_bytes() == env["a_version"]
    assert (target / f"catalog/snapshots/{env['a_sid']}.json").read_bytes() == env["a_snapshot"]
    a_read = service.read(a_pid, snapshot_id=env["a_sid"])
    assert [(row["record_id"], row["record_version"]) for row in a_read["rows"]] == [
        (env["a_record"]["record_id"], env["a_record"]["record_version"])]

    # Same family/declaration append: pid/sequence and version bytes stay fixed.
    b_version_before = env["b_version_path"].read_bytes()
    c_output = _output("c", "ignored.request.semantic", SUBJECT_B, "30")
    c_output.update(definition_mode="reuse",
                    definition_ref=copy.deepcopy(env["b"]["output_results"][0]["definition_ref"]),
                    definition=None)
    c = service.submit(request([c_output], "new-family-c",
                               parent=env["b_sid"]))
    assert c["state"] == "published_formal", c
    assert c["output_results"][0]["product_id"] == b_pid
    assert env["b_version_path"].read_bytes() == b_version_before
    assert json.loads(env["b_version_path"].read_text("utf-8"))[
        "definition_sequence"] == 1
    current = service.read(b_pid, snapshot_id=c["snapshot_id"])
    assert {row["record_id"] for row in current["rows"]} == {"b-row", "c-row"}


def test_existing_family_corrupt_registry_scope_or_body_rejected(tmp_path):
    for mode, expected in (
            ("scope", {"P4B_REUSE_REGISTRY_SCOPE_MISMATCH"}),
            ("body", {"P4B_REUSE_REGISTRY_DECLARATION_MISMATCH",
                      "R1_DEFINITION_VERSION_BINDING_MISMATCH"})):
        env = _two_family_published(tmp_path, "corrupt-" + mode)
        service, target = env["service"], env["target"]
        path = env["b_version_path"]
        record = json.loads(path.read_text("utf-8"))
        if mode == "scope":
            record["product_family_id"] = "pf_" + "0" * 24
        else:
            record["declaration"]["semantic_code"] = "tampered.semantic"
        path.write_text(json.dumps(record, ensure_ascii=False,
                                   sort_keys=True, separators=(",", ":")),
                        encoding="utf-8")
        tampered = path.read_bytes()
        state_before = (target / "catalog/state.json").read_bytes()
        head_before = (target / f"catalog/snapshots/{env['b_sid']}.json").read_bytes()

        c_output = _output("c", "ignored.request.semantic", SUBJECT_B, "30")
        c_output.update(definition_mode="reuse",
                        definition_ref=copy.deepcopy(
                            env["b"]["output_results"][0]["definition_ref"]),
                        definition=None)
        rejected = service.submit(request([c_output], "corrupt-" + mode + "-c",
                                          parent=env["b_sid"]))
        assert rejected["state"] == "rejected", (mode, rejected)
        assert rejected["errors"][0]["code"] in expected, (mode, rejected)
        assert path.read_bytes() == tampered
        assert (target / "catalog/state.json").read_bytes() == state_before
        assert (target / f"catalog/snapshots/{env['b_sid']}.json").read_bytes() == head_before
        assert not (target / f"catalog/commits/{rejected.get('snapshot_id')}.json").exists()
