"""P3B data_only structured batches: native staging, exact finalize, bounded views.

Five isolated groups mirror the assigned acceptance scope.  All business data is
explicitly synthetic; no path under /Volumes/WFD or BD is read or written.
"""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from test_r1_data_only import (
    HERE, NAMESPACE, UNITS, make_data_service, scalar_output,
)
from test_r2a_volume_publication import FakeDetector, VOL_UUID
from wfd_sdk import product_machine
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_batches import (
    BatchChunkConflict, BatchConflict, BatchIncomplete, BatchLimit,
    BatchPermission, ProductBatchLedger,
)
from wfd_sdk.product_volume_service import WFDVolumeService
from wfd_sdk.volume_publication import VolumeBinding


DATASET = "wfd_r1_local"
BATCH_ROLES = {"read", "register", "submit", "publish"}


def header_for(batch_id, output_keys=("m1",)):
    outputs = []
    for key in output_keys:
        out = scalar_output(key, "p3b.synthetic." + key, "10")
        out["payload"] = {"kind": "scalar_rows"}
        outputs.append(out)
    return {
        "protocol_version": "wfd.structured-ingest/1.0",
        "request_identity": {"dataset_id": DATASET,
                             "trusted_actor_namespace": NAMESPACE,
                             "request_id": batch_id,
                             "submission_digest": "sha256:" + "0" * 64},
        "intent": "submit",
        "producer_namespace": NAMESPACE,
        "expected_parent_snapshot_id": None,
        "outputs": outputs,
    }


def chunk_row(key, value, output_key="m1"):
    return {"business_key": key, "value_decimal": value,
            "value_state": "valid_value",
            "observation_time": {"status": "known", "precision": "year",
                                 "earliest_utc": "2025-01-01T00:00:00Z",
                                 "latest_exclusive_utc": "2026-01-01T00:00:00Z",
                                 "source_timezone": "UTC"}}


def expected(*pairs):
    return [{"output_key": output_key, "chunk_id": chunk_id}
            for output_key, chunk_id in pairs]


def ledger_for(tmp_path, service, name="actor"):
    return ProductBatchLedger(
        service, ledger_root=tmp_path / "runtime" / "batches" / name,
        max_chunks=16, max_rows=20, max_bytes=200_000)


def machine_config(tmp_path, *, roles=tuple(sorted(BATCH_ROLES)), store=None,
                   runtime=None, volume=None, name="p3b-machine"):
    config = {
        "protocol_version": product_machine.MACHINE_CONFIG_PROTOCOL,
        "connection_id": name,
        "profile": "data_only",
        "store": str(store or (tmp_path / "store")),
        "runtime": str(runtime or (tmp_path / "runtime")),
        "project_root": str(HERE),
        "protocol_root": str(HERE / "protocol"),
        "caller": {"caller_id": name, "trusted_actor_namespace": NAMESPACE,
                   "roles": list(roles)},
        "units": UNITS,
    }
    if volume is not None:
        config["volume"] = volume
    path = tmp_path / (name + ".json")
    path.write_text(json.dumps(config), encoding="utf-8")
    os.chmod(path, os.stat(path).st_mode & ~0o022)
    return path


def machine_handle(config_path, operation, arguments):
    loaded = product_machine._load_config(str(config_path))
    service = product_machine._build_service(loaded, operation=operation)
    return product_machine._handle(service, loaded, {
        "protocol_version": product_machine.MACHINE_PROTOCOL,
        "request_id": "p3b-" + operation.replace("_", "-"),
        "operation": operation, "arguments": arguments})


def machine_process(config_path, operation, arguments, env=None):
    request = {"protocol_version": product_machine.MACHINE_PROTOCOL,
               "request_id": "p3b-" + operation.replace("_", "-"),
               "operation": operation, "arguments": arguments}
    run_env = dict(os.environ)
    run_env.update(env or {})
    # -I omits cwd from sys.path; explicitly select this source root and carry
    # the parent's fresh prefix so subprocesses cannot consume old co_filename pyc.
    cache_prefix = sys.pycache_prefix or tempfile.mkdtemp(
        prefix="p3b-machine-pycache-", dir=Path(config_path).parent)
    bootstrap = ("import runpy, sys; sys.path.insert(0, sys.argv.pop(1)); "
                 "runpy.run_module('wfd_sdk.product_machine', run_name='__main__')")
    completed = subprocess.run(
        [sys.executable, "-I", "-B", "-X", "pycache_prefix=" + str(cache_prefix),
         "-c", bootstrap, str(HERE), "--config", str(config_path)],
        input=json.dumps(request).encode("utf-8"), stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, cwd=HERE, env=run_env, timeout=120)
    assert completed.returncode == 0, (completed.stdout.decode("utf-8", "replace") +
                                       completed.stderr.decode("utf-8", "replace"))
    return json.loads(completed.stdout.decode("utf-8"))


def fresh_machine(tmp_path):
    store, runtime = tmp_path / "store", tmp_path / "runtime"
    writer = "p3b-machine"
    # Provision before connecting: batch_begin must not initialize a formal volume.
    WFDDuckDBPrototype.initialize_new(
        store, load_protocol_validator(HERE / "protocol", entry="wfd-data-only-write.schema.json"), runtime_root=runtime,
        sandbox=False, writer_host=writer)
    return machine_config(tmp_path, store=store, runtime=runtime, name=writer)


def test_native_only_staging_and_forbidden_metadata(tmp_path, monkeypatch):
    service = make_data_service(tmp_path)
    ledger = ledger_for(tmp_path, service)
    batch = "b-native"
    base_header = header_for(batch)
    with pytest.raises(ValueError, match="BATCH_LEDGER_ROOT_REQUIRED"):
        ProductBatchLedger(service)
    with pytest.raises(ValueError, match="BATCH_LEDGER_ROOT_INSIDE_STORE"):
        ProductBatchLedger(service, ledger_root=tmp_path / "store" / "nested")
    with pytest.raises(ValueError, match="BATCH_LEDGER_ROOT_INSIDE_STORE"):
        ProductBatchLedger(service, ledger_root=service.root / "catalog")

    with_source = copy.deepcopy(base_header)
    with_source["source_bundle"] = {}
    with pytest.raises(Exception) as source_error:
        ledger.begin(batch, header=with_source, expected_chunks=expected(("m1", "c1")))
    assert str(source_error.value).startswith("BATCH_EXTERNAL_METADATA_FORBIDDEN")

    with_path = copy.deepcopy(base_header)
    with_path["outputs"][0]["definition"]["original_path"] = "/tmp/BD/raw.pdf"
    with pytest.raises(Exception) as path_error:
        ledger.begin(batch, header=with_path, expected_chunks=expected(("m1", "c1")))
    assert str(path_error.value).startswith("BATCH_EXTERNAL_METADATA_FORBIDDEN")

    ledger.begin(batch, header=base_header, expected_chunks=expected(("m1", "c1")))
    with pytest.raises(Exception) as chunk_error:
        ledger.put_chunk(batch, output_key="m1", chunk_id="c1",
                         rows=[{"business_key": "x", "source_binding": {}}])
    assert str(chunk_error.value).startswith("BATCH_EXTERNAL_METADATA_FORBIDDEN")
    assert not (service.root / "catalog/product_service/batches").exists()
    assert list((tmp_path / "runtime" / "batches").rglob("records/*.json"))

    # A namespace outside the trusted service is rejected before any record write.
    changed_namespace = header_for("b-native-untrusted")
    changed_namespace["request_identity"]["trusted_actor_namespace"] = "wfd.untrusted"
    with pytest.raises(BatchPermission):
        ledger.begin("b-native-untrusted", header=changed_namespace,
                     expected_chunks=expected(("m1", "c1")))


def test_chunk_order_idempotence_conflict_budget_and_missing(tmp_path):
    service = make_data_service(tmp_path)
    ledger = ProductBatchLedger(
        service, ledger_root=tmp_path / "runtime" / "batches" / "chunks",
        max_chunks=3, max_rows=10, max_bytes=20_000)
    batch = "b-chunks"
    pairs = [("m1", "c2"), ("m1", "c1"), ("m2", "c3")]
    status = ledger.begin(batch, header=header_for(batch, ("m1", "m2")),
                          expected_chunks=expected(*pairs))
    assert status["phase"] == "collecting" and len(status["missing"]) == 3

    ledger.put_chunk(batch, output_key="m1", chunk_id="c2", rows=[chunk_row("k2", "2")])
    ledger.put_chunk(batch, output_key="m1", chunk_id="c2", rows=[chunk_row("k2", "2")])
    assert ledger.status(batch)["received_chunks"] == 1
    with pytest.raises(BatchChunkConflict):
        ledger.put_chunk(batch, output_key="m1", chunk_id="c2",
                         rows=[chunk_row("k2", "999")])
    with pytest.raises(Exception):
        ledger.put_chunk(batch, output_key="m1", chunk_id="unexpected",
                         rows=[chunk_row("x", "1")])
    ledger.put_chunk(batch, output_key="m1", chunk_id="c1", rows=[chunk_row("k1", "1")])
    with pytest.raises(BatchIncomplete):
        ledger.finalize(batch)
    assert ledger.status(batch)["received_chunks"] == 2
    ledger.put_chunk(batch, output_key="m2", chunk_id="c3", rows=[chunk_row("k3", "3")])
    result = ledger.finalize(batch)
    assert result["state"] == "published_formal", result
    assert result["phase"] == "finalized"
    read = service.read(result["output_results"][0]["product_id"],
                        snapshot_id=result["snapshot_id"])
    assert [row["row"]["business_key"] for row in read["rows"]] == ["k2", "k1"]

    # Trusted byte/row budgets count header, manifest and chunks.
    budget_service = make_data_service(tmp_path / "budget")
    header = header_for("b-budget")
    header["outputs"][0]["coverage"]["scope"]["pad"] = "x" * 800
    header_bytes = len(json.dumps(header, ensure_ascii=False, sort_keys=True,
                                  separators=(",", ":")).encode())
    manifest = expected(("m1", "c1"))
    manifest_bytes = len(json.dumps(manifest, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode())
    tight = ProductBatchLedger(
        budget_service, ledger_root=tmp_path / "runtime" / "batches" / "budget",
        max_chunks=1, max_rows=10, max_bytes=header_bytes + manifest_bytes - 1)
    with pytest.raises(BatchLimit):
        tight.begin("b-budget", header=header, expected_chunks=manifest)


def test_isolated_volume_formal_readback_and_idempotent_finalize(tmp_path):
    target = tmp_path / "target"
    target.mkdir()
    runtime = tmp_path / "volume-runtime"
    binding = VolumeBinding(mount_point=str(target), volume_uuid=VOL_UUID,
                             filesystem="exfat", writer_host="p3b-volume",
                             writer_epoch=0)
    service = WFDVolumeService(
        binding=binding, runtime_root=runtime, protocol_root=HERE / "protocol",
        caller_roles=BATCH_ROLES, caller_id="p3b-volume",
        unit_registry=UNITS, trusted_actor_namespaces={NAMESPACE},
        detector=FakeDetector())
    ledger = ProductBatchLedger(
        service, ledger_root=runtime / "batches" / "instance",
        max_chunks=2, max_rows=10, max_bytes=100_000)
    batch = "b-volume"
    ledger.begin(batch, header=header_for(batch), expected_chunks=expected(("m1", "c1")))
    ledger.put_chunk(batch, output_key="m1", chunk_id="c1",
                     rows=[chunk_row("k1", "10")])
    first = ledger.finalize(batch)
    assert first["state"] == "published_formal", first
    assert first["formal_publication_verified"] is True
    assert first["formal_publication_ref"]
    sid = first["snapshot_id"]
    pid = first["output_results"][0]["product_id"]
    assert json.loads((target / "catalog/state.json").read_text("utf-8"))[
        "active_head"] == sid
    assert not (target / "catalog/product_service/batches").exists()
    assert list((runtime / "batches").rglob("records/*.json"))
    read = service.read(pid, snapshot_id=sid)
    assert read["rows"][0]["record_id"] == "k1"
    snapshots_before = len(list((target / "catalog/snapshots").glob("*.json")))
    holdings_before = len(list((target / "catalog/product_service/holdings").rglob("*.json")))
    second = ledger.finalize(batch)
    assert second["snapshot_id"] == sid
    assert len(list((target / "catalog/snapshots").glob("*.json"))) == snapshots_before
    assert len(list((target / "catalog/product_service/holdings").rglob("*.json"))) == \
        holdings_before


def test_new_process_continuation_and_failure_recovery(tmp_path):
    config = fresh_machine(tmp_path)
    batch = "b-process"
    begin = machine_process(config, "batch_begin", {
        "batch_id": batch, "header": header_for(batch, ("m1", "m2")),
        "expected_chunks": expected(("m1", "c1"), ("m2", "c2"))})
    assert begin["ok"] is True, begin
    put = machine_process(config, "batch_put_chunk", {
        "batch_id": batch, "output_key": "m1", "chunk_id": "c1",
        "rows": [chunk_row("k1", "10")]})
    assert put["ok"] is True, put
    status = machine_process(config, "batch_status", {
        "batch_id": batch, "chunk_limit": 1})
    assert status["ok"] is True and status["result"]["chunks_has_more"] is True
    second = machine_process(config, "batch_put_chunk", {
        "batch_id": batch, "output_key": "m2", "chunk_id": "c2",
        "rows": [chunk_row("k2", "11")]})
    assert second["ok"] is True, second
    final = machine_process(config, "batch_finalize", {"batch_id": batch})
    assert final["ok"] is True, final
    assert final["result"]["state"] == "published_formal"
    assert final["result"]["formal_publication_verified"] is True
    status_after = machine_process(config, "request_status", {
        "request_identity": header_for(batch)["request_identity"],
        "output_limit": 1})
    assert status_after["ok"] is True
    assert status_after["result"]["state"] == "published_formal"
    assert status_after["result"]["outputs_total"] == 2

    # Direct ledger failure/recovery: before-submit and after-commit return loss.
    service = make_data_service(tmp_path / "recovery")
    ledger = ProductBatchLedger(
        service, ledger_root=tmp_path / "recovery-runtime" / "batches" / "a")
    before_batch = "b-before"
    ledger.begin(before_batch, header=header_for(before_batch),
                 expected_chunks=expected(("m1", "c1")))
    ledger.put_chunk(before_batch, output_key="m1", chunk_id="c1",
                     rows=[chunk_row("k1", "10")])
    original = service.submit

    def fail_before(doc):
        raise RuntimeError("before submit")

    service.submit = fail_before
    failed = ledger.finalize(before_batch)
    assert failed["phase"] == "submit_unknown"
    assert ledger.status(before_batch)["received_chunks"] == 1
    service.submit = original
    recovered = ProductBatchLedger(
        service, ledger_root=tmp_path / "recovery-runtime" / "batches" / "a").finalize(
        before_batch)
    assert recovered["state"] == "published_formal"

    lossy_batch = "b-lossy"
    lossy_header = header_for(lossy_batch)
    lossy_header["expected_parent_snapshot_id"] = service.engine.head()["snapshot_id"]
    ledger.begin(lossy_batch, header=lossy_header,
                 expected_chunks=expected(("m1", "c1")))
    ledger.put_chunk(lossy_batch, output_key="m1", chunk_id="c1",
                     rows=[chunk_row("k2", "10")])

    def fail_after(doc):
        original(doc)
        raise RuntimeError("return loss after commit")

    service.submit = fail_after
    lost = ledger.finalize(lossy_batch)
    assert lost["phase"] == "submit_unknown"
    service.submit = original
    reopened = ProductBatchLedger(
        service, ledger_root=tmp_path / "recovery-runtime" / "batches" / "a")
    recovered_again = reopened.finalize(lossy_batch)
    assert recovered_again["state"] == "published_formal"
    assert recovered_again["snapshot_id"] == service.request_status(
        header_for(lossy_batch)["request_identity"])["snapshot_id"]
    final_again = reopened.finalize(lossy_batch)
    assert final_again["snapshot_id"] == recovered_again["snapshot_id"]


def test_permissions_pure_volume_and_bounded_machine_views(tmp_path):
    target = tmp_path / "target-perm"
    target.mkdir()
    binding = VolumeBinding(mount_point=str(target), volume_uuid=VOL_UUID,
                             filesystem="exfat", writer_host="p3b-perm",
                             writer_epoch=0)
    service = WFDVolumeService(
        binding=binding, runtime_root=tmp_path / "perm-runtime",
        protocol_root=HERE / "protocol", caller_roles={"read", "register",
                                                       "publish"},
        caller_id="p3b-perm", unit_registry=UNITS,
        trusted_actor_namespaces={NAMESPACE}, detector=FakeDetector())
    assert service.has_permission("read") is True
    assert service.has_permission("submit") is False
    assert service.actor_namespace_allowed(NAMESPACE) is True
    assert service._read_service is None
    with pytest.raises(PermissionError):
        service.require_permission("submit")
    assert service._read_service is None

    config = fresh_machine(tmp_path / "machine")
    begin = machine_handle(config, "batch_begin", {
        "batch_id": "b-perm", "header": header_for("b-perm", ("m1", "m2")),
        "expected_chunks": expected(("m1", "c1"), ("m2", "c2"))})
    assert begin["ok"] is True
    for output_key, chunk_id in (("m1", "c1"), ("m2", "c2")):
        put = machine_handle(config, "batch_put_chunk", {
            "batch_id": "b-perm", "output_key": output_key, "chunk_id": chunk_id,
            "rows": [chunk_row(chunk_id, "10")]})
        assert put["ok"] is True, put
    chunk_page = machine_handle(config, "batch_status", {
        "batch_id": "b-perm", "chunk_limit": 1})
    assert chunk_page["ok"] is True
    assert chunk_page["result"]["chunks_has_more"] is True
    assert chunk_page["result"]["next_chunk_offset"] == 1

    no_submit = machine_config(tmp_path / "machine", roles=("read", "register", "publish"),
                               store=tmp_path / "machine" / "store",
                               runtime=tmp_path / "machine" / "runtime",
                               name="no-submit")
    denied = machine_process(no_submit, "batch_begin", {
        "batch_id": "b-no-submit", "header": {"bad": "header"},
        "expected_chunks": []})
    assert denied["ok"] is False
    assert denied["error"]["code"] == "CALLER_PERMISSION_DENIED"

    no_read = machine_config(tmp_path / "machine", roles=("register", "submit", "publish"),
                             store=tmp_path / "machine" / "store",
                             runtime=tmp_path / "machine" / "runtime",
                             name="no-read")
    denied_status = machine_process(no_read, "batch_status", {"batch_id": "b-perm"})
    assert denied_status["ok"] is False
    assert denied_status["error"]["code"] == "CALLER_PERMISSION_DENIED"

    final = machine_handle(config, "batch_finalize", {
        "batch_id": "b-perm", "output_limit": 1, "output_detail": "summary"})
    assert final["ok"] is True, final
    body = final["result"]
    assert body["state"] == "published_formal"
    assert body["formal_publication_verified"] is True
    assert body["formal_publication_ref"]
    assert body["outputs_total"] == 2
    assert "output_results" not in (body.get("status_detail", {}).get("submit") or {})
    assert body["has_more"] is True
    assert body["continuation"]["operation"] == "request_status"
    status_view = machine_handle(config, "request_status", {
        "request_identity": header_for("b-perm")["request_identity"],
        "output_limit": 1})
    assert status_view["ok"] is True, status_view
    assert status_view["result"]["formal_publication_verified"] is True
    assert status_view["result"]["formal_publication"]["path"] == \
        body["formal_publication_ref"]
