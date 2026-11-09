"""F03: real engine/process checks, with all mutable data under tmp_path."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from test_product_service import HERE, SOURCE_POLICY, make_service
from test_r1_data_only import NAMESPACE, UNITS, make_data_service, request, scalar_output
from test_r2a_volume_publication import FakeDetector, VOL_UUID
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_volume_service import WFDVolumeService
from wfd_sdk.volume_publication import VolumeBinding


READ_ROLES = ("read",)
WRITE_ROLES = ("read", "register", "submit", "publish")


def inventory(root):
    """Record directories as well as every file's exact content digest."""
    return {
        item.relative_to(root).as_posix(): (
            "directory" if item.is_dir() else hashlib.sha256(item.read_bytes()).hexdigest())
        for item in sorted(root.rglob("*"))
    }


def seed_store(tmp_path, profile):
    if profile == "data_only":
        service = make_data_service(tmp_path)
        document = request([scalar_output("m1", "f03.synthetic", "10")], "f03-seed")
    else:
        service, document = make_service(tmp_path)
        document["source_bundle"]["source_roles"] = {
            output["output_key"]: [{"source_id": "fixture", "roles": ["definer"]}]
            for output in document["outputs"]
        }
    result = service.submit(document)
    assert result.get("state", result.get("status")) == "published_formal", result
    return service.root, result["snapshot_id"], result["output_results"][0]["product_id"]


def machine_config(tmp_path, store, profile, roles, *, caller_id="test"):
    namespace = NAMESPACE if profile == "data_only" else "wfd.test.curated"
    sources = {} if profile == "data_only" else {
        "fixture": {key: value for key, value in SOURCE_POLICY.items()
                    if key not in {"may_export", "may_export_evidence", "may_redistribute"}}}
    value = {
        "protocol_version": "wfd.product-machine-config/0.1",
        "connection_id": "f03-isolated", "profile": profile,
        "project_root": str(HERE), "protocol_root": str(HERE / "protocol"),
        "store": str(store), "runtime": str(tmp_path / "machine-runtime"),
        "caller": {"caller_id": caller_id, "trusted_actor_namespace": namespace,
                   "roles": list(roles)},
        "sources": sources, "units": UNITS,
    }
    path = tmp_path / "machine-config.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    path.chmod(0o600)
    return path


# This is a real machine process, not a patched submit.  The audit hook also
# catches attempted store writes whose final bytes would happen to be unchanged.
_AUDITED_MACHINE = r'''
import json, os, sys
from pathlib import Path
store = Path(sys.argv[1]).resolve()
def within(value):
    if not isinstance(value, (str, bytes, os.PathLike)):
        return False
    try:
        Path(os.fsdecode(value)).resolve().relative_to(store)
        return True
    except ValueError:
        return False
writes = []
def audit(event, args):
    paths = ()
    if event == "open":
        flags = args[2] or 0
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
            paths = args[:1]
    elif event in {"os.mkdir", "os.remove", "os.rmdir", "os.chmod", "os.utime"}:
        paths = args[:1]
    elif event in {"os.rename", "os.link", "os.symlink"}:
        paths = args[:2]
    if any(within(path) for path in paths):
        writes.append(event)
        raise PermissionError("TEST_STORE_WRITE_ATTEMPT:" + event)
sys.addaudithook(audit)
from wfd_sdk.product_machine import main
code = main(["--config", sys.argv[2]])
print(json.dumps({"store_write_attempts": writes}), file=sys.stderr)
raise SystemExit(code)
'''


def machine_process(config, store, operation, arguments=None, *, extra=None):
    document = {"protocol_version": "wfd.product-machine/0.1",
                "request_id": "f03-" + operation, "operation": operation,
                "arguments": arguments or {}, **(extra or {})}
    result = subprocess.run(
        [sys.executable, "-c", _AUDITED_MACHINE, str(store), str(config)],
        input=json.dumps(document), text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, cwd=HERE,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, timeout=60)
    assert result.returncode in {0, 2}, result.stderr
    assert json.loads(result.stderr)["store_write_attempts"] == [], result.stderr
    return result.returncode, json.loads(result.stdout)


@pytest.mark.parametrize("read_only", [True, False])
@pytest.mark.parametrize("missing", [True, False])
def test_open_existing_never_creates_missing_or_empty_store(tmp_path, read_only, missing):
    store = tmp_path / "store"
    if not missing:
        store.mkdir()
    with pytest.raises(FileNotFoundError, match="FORMAL_VOLUME_NOT_INITIALIZED"):
        WFDDuckDBPrototype.open_existing(
            store, load_protocol_validator(HERE / "protocol"),
            runtime_root=tmp_path / "runtime", read_only=read_only)
    assert store.exists() is (not missing)
    assert inventory(store) == {}
    assert not (tmp_path / "runtime").exists()


def test_initialize_new_is_explicit_and_existing_open_does_not_repair(tmp_path):
    store = tmp_path / "store"
    engine = WFDDuckDBPrototype.initialize_new(
        store, load_protocol_validator(HERE / "protocol"),
        runtime_root=tmp_path / "runtime", sandbox=False, writer_host="test")
    assert engine.read_only is False
    assert (store / "catalog/state.json").is_file()
    with pytest.raises(ValueError, match="STORE_INITIALIZATION_REQUIRES_EMPTY_DIRECTORY"):
        WFDDuckDBPrototype.initialize_new(
            store, engine.validator, runtime_root=tmp_path / "other-runtime")
    # A missing retention file must not be silently repaired by an existing open.
    (store / "catalog/retention.json").unlink()
    before = inventory(store)
    for read_only in (True, False):
        opened = WFDDuckDBPrototype.open_existing(
            store, engine.validator, runtime_root=tmp_path / "opened-runtime",
            read_only=read_only)
        assert opened.read_only is read_only
        assert inventory(store) == before


@pytest.mark.parametrize("profile", ["legacy", "data_only"])
@pytest.mark.parametrize("roles", [READ_ROLES, WRITE_ROLES], ids=["read-role", "write-roles"])
def test_nonvolume_machine_read_operations_have_zero_store_writes(tmp_path, profile, roles):
    store, sid, pid = seed_store(tmp_path / "seed", profile)
    config = machine_config(tmp_path, store, profile, roles)
    before = inventory(store)
    for operation, arguments in (
        ("capabilities", {}), ("schema", {}),
        ("fixed_read", {"snapshot_id": sid, "product_id": pid}),
        ("contract_discovery", {"snapshot_id": sid}),
        ("query_capabilities", {}),
    ):
        code, response = machine_process(config, store, operation, arguments)
        assert code == 0 and response["ok"] is True, response
        if operation == "capabilities":
            assert response["result"]["process"]["read_only"] is True
            assert response["result"]["process"]["store_open"] == "open_existing_read_only"
        if operation == "fixed_read":
            assert len(response["result"]["rows"]) == 1
        assert inventory(store) == before
        assert not (tmp_path / "machine-runtime").exists()


@pytest.mark.parametrize("profile", ["legacy", "data_only"])
@pytest.mark.parametrize("roles", [READ_ROLES, WRITE_ROLES], ids=["read-role", "write-roles"])
def test_empty_store_machine_reads_and_writes_do_not_initialize(tmp_path, profile, roles):
    store = tmp_path / "empty"
    store.mkdir()
    config = machine_config(tmp_path, store, profile, roles)
    for operation, arguments in (
        ("capabilities", {}), ("schema", {}),
        ("fixed_read", {"snapshot_id": "s_" + "0" * 24}),
        ("submit", {"document": {}}),
    ):
        code, response = machine_process(config, store, operation, arguments)
        assert code == 2 and response["ok"] is False, response
        assert response["error"]["code"] == "WFD_STORE_UNAVAILABLE"
        assert inventory(store) == {}
        assert not (tmp_path / "machine-runtime").exists()


@pytest.mark.parametrize("profile", ["legacy", "data_only"])
def test_denied_submit_precedes_any_store_lock(tmp_path, profile):
    store, _, _ = seed_store(tmp_path / "seed", profile)
    config = machine_config(tmp_path, store, profile, READ_ROLES)
    before = inventory(store)
    code, response = machine_process(config, store, "submit", {"document": {}})
    assert code == 0 and response["ok"] is False, response
    assert response["error"]["code"] == "CALLER_PERMISSION_DENIED"
    assert inventory(store) == before


def test_malformed_request_does_not_open_or_initialize_store(tmp_path):
    store = tmp_path / "empty"
    store.mkdir()
    config = machine_config(tmp_path, store, "data_only", WRITE_ROLES)
    code, response = machine_process(
        config, store, "capabilities", extra={"caller_roles": ["publish"]})
    assert code == 2 and response["error"]["code"] == "REQUEST_INVALID"
    assert inventory(store) == {}
    assert not (tmp_path / "machine-runtime").exists()


def test_volume_reader_keeps_existing_protection_on_empty_target(tmp_path):
    store = tmp_path / "volume"
    store.mkdir()
    service = WFDVolumeService(
        binding=VolumeBinding(mount_point=str(store), volume_uuid=VOL_UUID,
                              filesystem="exfat", writer_host="test", writer_epoch=0),
        runtime_root=tmp_path / "runtime", protocol_root=HERE / "protocol",
        caller_roles=WRITE_ROLES, detector=FakeDetector())
    assert service.capabilities()["volume"]["target_read_only"] is True
    assert service._read_service is None
    with pytest.raises(FileNotFoundError, match="FORMAL_VOLUME_NOT_INITIALIZED"):
        service.read(snapshot_id="s_" + "0" * 24)
    assert inventory(store) == {}
    assert service._read_service is None
    assert not (tmp_path / "runtime").exists()
