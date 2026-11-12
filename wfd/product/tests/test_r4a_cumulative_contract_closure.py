#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R4a focused acceptance: cumulative snapshot contract closure in prepare.

The three requested isolated groups are exercised here:

1. two products in two batches; the second snapshot retains A while adding B,
   and prepare's plan contains every fixed A and B contract/definition object;
   a plan-only isolated read-only target then reads both products;
2. one pid with two legal internal fixed contract bundles; both four-role sets
   are kept, independent of entry order;
3. a missing/wrong old role, bundle or definition file rejects preparation and
   leaves the target's old head unchanged.

Plus one normal single-product publisher control.  The synthetic second bundle
is an internal software fixture only; it is not a new financial-data entry and
is never registered or activated.  No real WFD/BD volume is touched.
"""
from __future__ import annotations

import copy
import hashlib
import json
import shutil
from pathlib import Path

import pytest

from test_r1_data_only import (
    HERE, NAMESPACE, UNITS, make_data_service, request, scalar_output,
)
from test_r2a_volume_publication import (
    instance, publisher, snapshot_of, state_of,
)
from wfd_sdk.duckdb_sdk import (
    WFDDuckDBPrototype, canonical, load_protocol_validator,
)
from wfd_sdk.duckdb_storage import parquet_from_rows, rows_from_parquet
from wfd_sdk.product_data_service import WFDDataOnlyService
from wfd_sdk.state import StateStore
from wfd_sdk.volume_publication import (
    PreparationError, _add_product_closure, _snapshot_fixed_products,
)

ROLE_BODY = {
    "semantic": "semantic",
    "read_layout": "read",
    "algorithm_dependency": "compute_dependencies",
    "update_release": "publication",
}


def _digest(value: str) -> str:
    return value.split(":")[-1]


def _entry_product(entry: dict) -> dict:
    return entry["source_bundle"]["_wfd_product_bindings"][entry["output_key"]]["product"]


def _expected_product_paths(product: dict) -> set[str]:
    pid = product["product_id"]
    paths = {
        f"catalog/product_service/contracts/{role}/{_digest(ref['digest'])}.json"
        for role, ref in product["contract_refs"].items()
    }
    paths.add(
        "catalog/product_service/contract_bundles/"
        f"{_digest(product['contract_bundle_ref']['digest'])}.json"
    )
    paths.add(
        f"catalog/product_service/definitions/"
        f"{_digest(product['definition_ref']['digest'])}.json"
    )
    paths.add(
        f"catalog/product_service/products/{pid}/"
        f"definition_{product['definition_sequence']}.json"
    )
    paths.add(
        f"catalog/product_service/contracts/"
        f"{_digest(product['contract_ref']['digest'])}.json"
    )
    parent = product.get("definition_parent_ref") or {}
    if parent.get("digest"):
        paths.add(
            f"catalog/product_service/definitions/{_digest(parent['digest'])}.json"
        )
    return paths


def _build_two_batches(tmp_path: Path):
    base = tmp_path / "prep-two-batches"
    base.mkdir()
    service = make_data_service(base)
    doc_a = request([scalar_output("ma", "r4a.a", "10")], "r4a-a")
    result_a = service.submit(doc_a)
    assert result_a["state"] == "published_formal", result_a
    doc_b = request(
        [scalar_output("mb", "r4a.b", "20")], "r4a-b",
        parent=result_a["snapshot_id"])
    result_b = service.submit(doc_b)
    assert result_b["state"] == "published_formal", result_b
    return base / "store", doc_a, result_a, doc_b, result_b


def _plan_target(summary, prep: Path, target: Path) -> None:
    """Materialize only prepare-plan files into an isolated fresh target."""
    target.mkdir()
    for item in summary.files:
        destination = target / item.relpath
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((prep / item.relpath).read_bytes())


def _read_only_service(target: Path, tmp_path: Path) -> WFDDataOnlyService:
    StateStore(target).ensure_initialized()
    engine = WFDDuckDBPrototype(
        target, load_protocol_validator(HERE / "protocol", entry="wfd-data-only-write.schema.json"),
        runtime_root=tmp_path / "plan-read-runtime", sandbox=False,
        writer_host=None, read_only=True,
    )
    return WFDDataOnlyService(
        engine, caller_roles=("read",), caller_id="r4a-plan-read",
        unit_registry=UNITS, trusted_actor_namespaces={NAMESPACE},
    )


# --------------------------------------------------------------------------- 1
def test_two_batch_closure_has_all_fixed_a_and_b_and_plan_only_read(tmp_path):
    prep, doc_a, result_a, doc_b, result_b = _build_two_batches(tmp_path)
    sid = result_b["snapshot_id"]
    snapshot = snapshot_of(prep, sid)
    assert {entry["output_key"] for entry in snapshot["files"]} == {"ma", "mb"}

    pub, _unused = publisher(tmp_path, "unused-target")
    summary = pub.prepare(instance(prep, doc_b, result_b))
    planned = set(summary.file_map())
    assert [item["output_key"] for item in summary.output_results] == ["mb"]
    fixed = _snapshot_fixed_products(snapshot)
    assert {product["product_id"] for product in fixed} == {
        result_a["output_results"][0]["product_id"],
        result_b["output_results"][0]["product_id"],
    }
    for entry in snapshot["files"]:
        product = _entry_product(entry)
        assert _expected_product_paths(product) <= planned, product["product_id"]
        assert (f"catalog/product_service/products/{product['product_id']}.json"
                not in planned)

    # The plan-only target contains no unplanned catalog object and reads both
    # fixed products with all four roles.  This is a prepare closure check, not
    # a claim that the full volume publisher formally activated this snapshot.
    plan_target = tmp_path / "plan-only-target"
    _plan_target(summary, prep, plan_target)
    copied_product_files = {
        path.relative_to(plan_target).as_posix()
        for path in (plan_target / "catalog/product_service").rglob("*")
        if path.is_file()
    }
    planned_product_files = {
        rel for rel in planned if rel.startswith("catalog/product_service/")
    }
    assert copied_product_files == planned_product_files
    service = _read_only_service(plan_target, tmp_path)
    for label, result in (("A", result_a), ("B", result_b)):
        item = result["output_results"][0]
        read = service.read(item["product_id"], snapshot_id=sid, include_history=True)
        assert {(row["record_id"], row["record_version"]) for row in read["rows"]} == {
            (record["record_id"], record["record_version"]) for record in item["records"]
        }, label
        assert set(read["products"][0]["contract_refs"]) == set(ROLE_BODY), label

    # Full publisher activation is only claimed with the real predecessor:
    # A is activated first, then B is published on top of that target.
    pub2, target2 = publisher(tmp_path, "target-two-batches")
    first = pub2.publish(instance(prep, doc_a, result_a))
    assert first["status"] == "activated" and first["formal"] is True, first
    second = pub2.publish(instance(prep, doc_b, result_b))
    assert second["status"] == "activated" and second["formal"] is True, second
    assert state_of(target2)["active_head"] == sid


# --------------------------------------------------------------------------- 2
def _two_bundle_fixture(tmp_path: Path):
    base = tmp_path / "prep-two-bundles"
    base.mkdir()
    service = make_data_service(base)
    doc = request(
        [scalar_output("ma", "r4a.two-bundles", "10")], "r4a-two-bundles")
    result = service.submit(doc)
    assert result["state"] == "published_formal", result
    store, sid = base / "store", result["snapshot_id"]
    snapshot = snapshot_of(store, sid)
    entry1 = snapshot["files"][0]
    output_key = entry1["output_key"]
    pid = entry1["product_id"]
    product1 = copy.deepcopy(_entry_product(entry1))

    # A legal internal second fixed contract bundle for the same pid.  The
    # existing binding helper builds and writes the real role/bundle/legacy
    # files and digests; the explicit marker makes clear this is not a new
    # external financial data entry.
    product2 = copy.deepcopy(product1)
    product2["contracts"]["semantic"]["r4a_fixture_note"] = (
        "internal synthetic second contract bundle; not a new financial data entry")
    product2 = service._bind_contract(
        product2, {"_wfd_data_only": True}, prior_product=product1)
    assert (product2["contract_bundle_ref"]["digest"]
            != product1["contract_bundle_ref"]["digest"])
    product2["definition_sequence"] = 2

    version_record = copy.deepcopy(json.loads(
        (store / f"catalog/product_service/products/{pid}/definition_1.json"
         ).read_text("utf-8")))
    version_record["definition_sequence"] = 2
    version_record["contracts"] = copy.deepcopy(product2["contracts"])
    service.engine._write_immutable(
        f"catalog/product_service/products/{pid}/definition_2.json",
        canonical(version_record))

    original_rows = rows_from_parquet(
        (store / entry1["file_relpath"]).read_bytes())
    rows = copy.deepcopy(original_rows)
    second_row = copy.deepcopy(rows[0])
    second_row["business_key"] = "row-ma-2"
    rows.append(second_row)
    raw = parquet_from_rows(pid, output_key, product2["subject"],
                            product2["payload_kind"], rows)
    digest = hashlib.sha256(raw).hexdigest()
    rel = f"observations/product={pid}/part-{digest[:24]}.parquet"
    service.engine._write_immutable(rel, raw)

    carrier = copy.deepcopy(entry1["source_bundle"])
    carrier["_wfd_product_bindings"] = {output_key: {
        "product": copy.deepcopy(product2), "source_role_mode": "data_only",
        "source_admission": {}}}
    carrier["_wfd_resolved_product_ids"] = {output_key: pid}
    versions = {}
    for row in rows:
        key = row["business_key"]
        versions[key] = {
            "logical_key": key,
            "revision_id": "r_" + hashlib.sha256(
                canonical([pid, output_key, key, "r4a-fixture"])).hexdigest()[:32],
            "supersedes": None, "input_mode": "partial_observation",
            "withdrawn": False, "reason": None,
        }
    carrier["_wfd_row_versions"] = {output_key: versions}
    entry2 = {
        "product_id": pid, "output_key": output_key, "file_relpath": rel,
        "file_sha256": digest, "row_count": len(rows),
        "definition": copy.deepcopy(product2["declaration"]),
        "subject": copy.deepcopy(product2["subject"]),
        "source_bundle": carrier, "evidence_refs": [],
        "input_mode": "partial_observation", "payload_kind": product2["payload_kind"],
    }
    files = [copy.deepcopy(entry1), entry2]
    manifest = {"parent_snapshot_id": sid, "files": files}
    manifest_raw = canonical(manifest)
    manifest_sha = hashlib.sha256(manifest_raw).hexdigest()
    manifest_rel = f"catalog/manifests/manifest_{manifest_sha[:24]}.json"
    service.engine._write_immutable(manifest_rel, manifest_raw)
    key, fingerprint = snapshot["request_key"], snapshot["request_fingerprint"]
    new_sid = "s_" + hashlib.sha256(canonical(
        [sid, key, fingerprint, manifest_sha])).hexdigest()[:24]
    receipt = copy.deepcopy(snapshot.get("receipt") or {})
    receipt.update({"snapshot_id": new_sid, "parent_snapshot_id": sid})
    synthetic = {
        "snapshot_id": new_sid, "parent_snapshot_id": sid,
        "manifest_relpath": manifest_rel, "manifest_sha256": manifest_sha,
        "files": files,
        "metadata_versions": copy.deepcopy(snapshot.get("metadata_versions") or []),
        "request_key": key, "request_fingerprint": fingerprint, "receipt": receipt,
    }
    snapshot_raw = canonical(synthetic)
    snapshot_rel = f"catalog/snapshots/{new_sid}.json"
    service.engine._write_immutable(snapshot_rel, snapshot_raw)
    commit = {"snapshot_id": new_sid, "snapshot_file": snapshot_rel,
              "snapshot_sha256": hashlib.sha256(snapshot_raw).hexdigest()}
    service.engine._write_immutable(f"catalog/commits/{new_sid}.json", canonical(commit))
    return {
        "store": store, "service": service, "snapshot": synthetic,
        "product1": product1, "product2": product2, "result": result,
        "snapshot_rel": snapshot_rel, "manifest_rel": manifest_rel,
        "commit_rel": f"catalog/commits/{new_sid}.json",
    }


def test_same_pid_two_fixed_bundles_both_kept(tmp_path):
    env = _two_bundle_fixture(tmp_path)
    store, snapshot = env["store"], env["snapshot"]
    fixed = _snapshot_fixed_products(snapshot)
    assert len(fixed) == 2
    assert {product["contract_bundle_ref"]["digest"] for product in fixed} == {
        env["product1"]["contract_bundle_ref"]["digest"],
        env["product2"]["contract_bundle_ref"]["digest"],
    }
    reversed_snapshot = {**snapshot, "files": list(reversed(snapshot["files"]))}
    assert canonical(_snapshot_fixed_products(reversed_snapshot)) == canonical(fixed)
    for product in (env["product1"], env["product2"]):
        assert env["service"]._verify_contract_refs(product, verify_files=True) is True

    closure: dict[str, str] = {}

    def add(rel: str, kind: str, expected_sha: str | None = None) -> None:
        path = store / rel
        assert path.is_file(), rel
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if expected_sha is not None:
            assert digest == expected_sha, rel
        closure[rel] = digest

    for product in fixed:
        _add_product_closure(add, product, store)
    for product in (env["product1"], env["product2"]):
        assert _expected_product_paths(product) <= set(closure)
        for role, ref in product["contract_refs"].items():
            rel = (f"catalog/product_service/contracts/{role}/"
                   f"{_digest(ref['digest'])}.json")
            body = json.loads((store / rel).read_text("utf-8"))
            assert canonical(body) == canonical(product["contracts"][ROLE_BODY[role]])

    # Real outer digest/file chain for the synthetic fixture.
    snapshot_raw = (store / env["snapshot_rel"]).read_bytes()
    manifest_raw = (store / env["manifest_rel"]).read_bytes()
    commit = json.loads((store / env["commit_rel"]).read_text("utf-8"))
    assert commit["snapshot_sha256"] == hashlib.sha256(snapshot_raw).hexdigest()
    assert snapshot["manifest_sha256"] == hashlib.sha256(manifest_raw).hexdigest()
    assert json.loads(manifest_raw)["files"] == snapshot["files"]
    assert json.loads(snapshot_raw)["snapshot_id"] == snapshot["snapshot_id"]

    # The fixture is not a new data entry: request status, state head and
    # formal outputs still point at the original single-product submission.
    status = json.loads((
        store / "catalog/product_service/data_only_status"
        / f"{snapshot['request_key']}.json").read_text("utf-8"))
    assert status["snapshot_id"] == snapshot["parent_snapshot_id"]
    assert len(status["output_results"]) == 1
    assert state_of(store)["active_head"] == snapshot["parent_snapshot_id"]


# --------------------------------------------------------------------------- 3
def _tamper_cases(store: Path, entry: dict) -> dict[str, callable]:
    product = _entry_product(entry)
    role_rel = (
        "catalog/product_service/contracts/semantic/"
        f"{_digest(product['contract_refs']['semantic']['digest'])}.json")
    bundle_rel = (
        "catalog/product_service/contract_bundles/"
        f"{_digest(product['contract_bundle_ref']['digest'])}.json")
    definition_rel = (
        "catalog/product_service/definitions/"
        f"{_digest(product['definition_ref']['digest'])}.json")

    def append(rel: str):
        path = store / rel
        path.write_bytes(path.read_bytes() + b"\n")

    def remove(rel: str):
        (store / rel).unlink()

    return {
        "missing_old_role": lambda: remove(role_rel),
        "wrong_old_role": lambda: append(role_rel),
        "missing_old_bundle": lambda: remove(bundle_rel),
        "wrong_old_bundle": lambda: append(bundle_rel),
        "missing_old_definition": lambda: remove(definition_rel),
    }


def test_missing_or_wrong_old_closure_rejects_and_preserves_target(tmp_path):
    prep, doc_a, result_a, doc_b, result_b = _build_two_batches(tmp_path)
    sid_a, sid_b = result_a["snapshot_id"], result_b["snapshot_id"]
    snapshot_b = snapshot_of(prep, sid_b)
    entry_a = next(entry for entry in snapshot_b["files"]
                   if entry["product_id"] == result_a["output_results"][0]["product_id"])
    entry_b = next(entry for entry in snapshot_b["files"]
                   if entry["product_id"] == result_b["output_results"][0]["product_id"])
    product_b = _entry_product(entry_b)
    assert _expected_product_paths(product_b) <= {
        path.relative_to(prep).as_posix() for path in prep.rglob("*") if path.is_file()
    }

    pub, target = publisher(tmp_path, "target-reject")
    first = pub.publish(instance(prep, doc_a, result_a))
    assert first["status"] == "activated", first
    assert first["formal"] is True, first
    head_before = state_of(target)["active_head"]
    seq_before = state_of(target)["update_seq"]
    assert head_before == sid_a

    for label, tamper in _tamper_cases(prep, entry_a).items():
        bad_prep = tmp_path / f"bad-{label}"
        shutil.copytree(prep, bad_prep)
        tamper_for_copy = _tamper_cases(bad_prep, entry_a)[label]
        tamper_for_copy()
        rejected = pub.publish(instance(bad_prep, doc_b, result_b))
        assert rejected["status"] == "rejected_preparation", (label, rejected)
        assert rejected["errors"][0]["code"] in {
            "PREP_FILE_MISSING", "PREP_DIGEST_MISMATCH", "JSON_UNREADABLE",
        }, (label, rejected["errors"])
        assert state_of(target)["active_head"] == sid_a, label
        assert state_of(target)["update_seq"] == seq_before, label
        assert not (target / f"catalog/commits/{sid_b}.json").exists(), label


# --------------------------------------------------------------------------- control
def test_normal_single_product_publisher_control(tmp_path):
    base = tmp_path / "prep-control"
    base.mkdir()
    service = make_data_service(base)
    doc = request([scalar_output("ma", "r4a.control", "10")], "r4a-control")
    result = service.submit(doc)
    assert result["state"] == "published_formal", result
    prep = base / "store"
    product = _entry_product(snapshot_of(prep, result["snapshot_id"])["files"][0])
    pub, target = publisher(tmp_path, "target-control")
    summary = pub.prepare(instance(prep, doc, result))
    assert _expected_product_paths(product) <= set(summary.file_map())
    published = pub.publish(instance(prep, doc, result))
    assert published["status"] == "activated", published
    assert published["formal"] is True, published
    assert state_of(target)["active_head"] == result["snapshot_id"]
