"""Targeted P6 machine-boundary tests.

Protocol/configuration/serialization unit checks remain separate from the
actual adapter checks below, which explicitly generate a new daily store under
tmp_path.  No historical script, product ID or store is implicitly selected.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
import subprocess
from pathlib import Path, PureWindowsPath

import pytest

from wfd_sdk import product_machine as machine
from synthetic_daily import ACTOR, SOURCE_IDS, make_daily_store, source_policy


ROOT = Path(__file__).resolve().parents[1]


def _config(tmp_path, **overrides):
    # Empty default directories are only for config-shape unit checks, not opens.
    store = Path(overrides.get("store", tmp_path / "store"))
    store.mkdir(exist_ok=True)
    config = {
        "protocol_version": "wfd.product-machine-config/0.1",
        "connection_id": "wfd-test-connection",
        "store": str(store),
        "runtime": str(tmp_path / "runtime"),
        "project_root": str(ROOT),
        "protocol_root": str(ROOT / "protocol"),
        "caller": {
            "caller_id": "p6-test",
            "trusted_actor_namespace": "wfd.p6.test",
            "roles": ["read", "read_evidence", "evidence_write", "register", "submit", "publish"],
        },
        "sources": {
            "fixture": {
                "may_submit": True, "may_publish_formal": True,
                "may_read": True, "may_read_evidence": True,
                "usage_scope": "test", "license": "test_only",
                "allowed_roles": ["compiler", "deliverer"],
                "allowed_authorities": ["wfd.project.market_semantics"],
            }
        },
        "units": {"cny_per_share": {"dimension": "money_per_share", "currency": "CNY", "multiplier": "1"}},
        "limits": {},
    }
    config.update(overrides)
    path = tmp_path / "config.json"
    path.write_text(json.dumps(config), "utf-8")
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    return path


def test_bundle_host_drive_paths_and_portable_members_have_separate_rules():
    from wfd_sdk.product_bundle import _structured_safe_rel
    expected = PureWindowsPath(r"C:\WFD\packages")
    for spelling in (r"C:\WFD\packages", "C:/WFD/packages"):
        assert machine._parse_bundle_host_path(spelling, PureWindowsPath) == expected
    for spelling in ("relative", r"C:relative", r"\WFD\packages", r"\\server\share\dir",
                     "//server/share/dir", r"\\?\C:\dir", "C:/base/../elsewhere", "C:/tab\t", "C:/nul\0"):
        with pytest.raises(ValueError, match="BUNDLE_PATH_INVALID"):
            machine._parse_bundle_host_path(spelling, PureWindowsPath)
    assert _structured_safe_rel("objects/one") == "objects/one"
    for member in (r"objects\one", r"C:\one", "C:/one", "/one", "a/D:/two", "objects/../one", "one\0"):
        with pytest.raises(ValueError, match="STRUCTURED_PATH_INVALID"):
            _structured_safe_rel(member)


def _link_dir(alias: Path, target: Path) -> None:
    if os.name == "nt":
        subprocess.run(["cmd", "/c", "mklink", "/J", str(alias), str(target)], check=True, capture_output=True)
    else:
        alias.symlink_to(target, target_is_directory=True)


def test_machine_bundle_roots_reject_overlap_and_linked_ancestors(tmp_path):
    package = tmp_path / "packages"
    package.mkdir(mode=0o700)
    target = tmp_path / "detached"
    access = {"operations": ["bundle_import_full"], "source_ids": ["synthetic"], "dataset_id": "synthetic",
              "package_root": str(package), "target_store": str(target)}
    def load(**roots):
        return machine._load_config(_config(tmp_path, profile="data_only", sources={},
            caller={"caller_id": "test", "trusted_actor_namespace": "test", "roles": ["read"]},
            bundle_access={**access, **roots}))
    assert load()["bundle_access"]["target_store"] == str(target)
    with pytest.raises(ValueError, match="CONFIG_UNSAFE:overlapping"):
        load(target_store=str(package / "nested"))
    with pytest.raises(ValueError, match="BUNDLE_PATH_INVALID"):
        load(target_store=str(package / ".." / "detached"))
    alias = tmp_path / "alias"
    _link_dir(alias, tmp_path)
    with pytest.raises(ValueError, match="BUNDLE_PATH_INVALID"):
        load(target_store=str(alias / "detached"))
    assert not target.exists()


def _daily_config(tmp_path, *, roles=None):
    fixture = make_daily_store(tmp_path / "daily_fixture")
    policies = {source_id: {**source_policy(), "may_export": False,
                            "may_export_evidence": False, "may_redistribute": False}
                for source_id in SOURCE_IDS}
    caller = {"caller_id": "synthetic-daily", "trusted_actor_namespace": ACTOR,
              "roles": (list(roles) if roles is not None else
                        ["read", "read_evidence", "evidence_write", "register", "submit", "publish"])}
    config = machine._load_config(_config(
        tmp_path, store=str(fixture.store), caller=caller, sources=policies))
    return fixture, config


def _tree_snapshot(root):
    return {path.relative_to(root).as_posix():
            (path.stat().st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest())
            for path in sorted(root.rglob("*")) if path.is_file()}


def _machine_request(operation, arguments):
    return {"protocol_version": "wfd.product-machine/0.1", "request_id": "p6-synthetic-check",
            "operation": operation, "arguments": arguments}


def test_daily_machine_default_open_is_reader_even_with_write_roles(tmp_path):
    fixture, config = _daily_config(tmp_path)
    before = _tree_snapshot(fixture.store)
    # Deliberately omit operation: an initialized daily store must still open read-only.
    service = machine._build_service(config)
    assert service.engine.read_only is True
    response = machine._handle(service, config, _machine_request("fixed_read", {
        "product_id": fixture.product_id, "snapshot_id": fixture.snapshot_id}))
    assert response["ok"] is True
    assert response["result"]["row_count"] == 43
    assert response["result"]["snapshot_id"] == fixture.snapshot_id
    assert response["result"]["rows"][-1]["row"]["values"]["close_price"]["value"] == "100.42"
    with pytest.raises(machine._Unsupported):
        machine._handle(service, config, _machine_request("export", {}))
    assert _tree_snapshot(fixture.store) == before
    assert not Path(config["runtime"]).exists()


def test_daily_machine_missing_store_is_not_implicitly_initialized(tmp_path):
    config = machine._load_config(_config(tmp_path))
    store = Path(config["store"])
    assert list(store.iterdir()) == []
    with pytest.raises(FileNotFoundError, match="FORMAL_VOLUME_NOT_INITIALIZED"):
        machine._build_service(config)
    assert list(store.iterdir()) == []
    assert not Path(config["runtime"]).exists()


def test_daily_machine_read_roles_cannot_delegate_submit_or_evidence(tmp_path):
    fixture, config = _daily_config(tmp_path, roles=["read", "read_evidence"])
    before = _tree_snapshot(fixture.store)
    for operation, permission in [("submit", "submit"), ("evidence_ingest", "evidence_write")]:
        service = machine._build_service(config, operation=operation)
        assert service.engine.read_only is True
        with pytest.raises(PermissionError, match="CALLER_PERMISSION_DENIED:" + permission):
            machine._handle(service, config, _machine_request(operation, {}))
    assert _tree_snapshot(fixture.store) == before
    assert not Path(config["runtime"]).exists()


def test_daily_machine_source_permission_rejects_real_fixed_read(tmp_path):
    fixture, config = _daily_config(tmp_path)
    config["sources"][SOURCE_IDS[0]]["may_read"] = False
    before = _tree_snapshot(fixture.store)
    service = machine._build_service(config, operation="fixed_read")
    assert service.engine.read_only is True
    with pytest.raises(PermissionError, match="SOURCE_READ_PERMISSION_MISSING:" + SOURCE_IDS[0]):
        machine._handle(service, config, _machine_request("fixed_read", {
            "product_id": fixture.product_id, "snapshot_id": fixture.snapshot_id}))
    assert _tree_snapshot(fixture.store) == before
    assert not Path(config["runtime"]).exists()


def test_daily_machine_evidence_write_requires_explicit_operation(tmp_path):
    fixture, config = _daily_config(tmp_path)
    service = machine._build_service(config, operation="evidence_ingest")
    assert service.engine.read_only is False
    head = service.engine.head()["snapshot_id"]
    raw = b"Actual P6 machine evidence bytes, synthetic fixture only."
    response = machine._handle(service, config, _machine_request("evidence_ingest", {
        "content_base64": base64.b64encode(raw).decode("ascii"), "original_name": "p6-evidence.txt"}))
    assert response["ok"] is True
    result = response["result"]
    digest = hashlib.sha256(raw).hexdigest()
    assert result["content_sha256"] == "sha256:" + digest
    assert result["ref_kind"] == "content" and result["size"] == len(raw)
    assert (fixture.store / "evidence/sha256" / digest).read_bytes() == raw
    assert service.engine.head()["snapshot_id"] == head == fixture.snapshot_id


def test_public_operation_registry_covers_machine_boundary():
    required = {
        "capabilities", "service_capabilities", "schema", "contract_discovery",
        "fixed_read", "submit", "request_status", "recovery", "evidence_ingest",
        "trace", "query_capabilities", "read_product", "batch_begin",
        "batch_put_chunk", "batch_status", "batch_finalize",
    }
    assert required <= set(machine.SUPPORTED)
    for unsupported in ("packages", "export", "redistribute", "query_graph"):
        assert unsupported in machine.UNSUPPORTED


def test_request_cannot_supply_root_or_roles():
    base = {"protocol_version": "wfd.product-machine/0.1",
            "request_id": "p6m-test-1", "operation": "capabilities", "arguments": {}}
    with pytest.raises(ValueError, match="unexpected fields"):
        machine._request_object({**base, "store": "/tmp/attacker"})
    with pytest.raises(ValueError, match="unexpected fields"):
        machine._request_object({**base, "caller_roles": ["submit"]})


def test_config_requires_explicit_roles_and_authorities(tmp_path):
    loaded = machine._load_config(_config(tmp_path))
    assert loaded["caller"]["roles"] == ["read", "read_evidence", "evidence_write",
                                          "register", "submit", "publish"]
    assert loaded["sources"]["fixture"]["allowed_authorities"] == ["wfd.project.market_semantics"]
    assert loaded["batch_limits"]["max_chunks"] == 64


def test_config_rejects_export_grant(tmp_path):
    path = _config(tmp_path)
    data = json.loads(path.read_text())
    data["sources"]["fixture"]["may_export"] = True
    path.write_text(json.dumps(data), "utf-8")
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    with pytest.raises(ValueError, match="CONFIG_INVALID"):
        machine._load_config(path)


def test_config_rejects_unknown_machine_role(tmp_path):
    path = _config(tmp_path)
    data = json.loads(path.read_text())
    data["caller"]["roles"].append("redistribute")
    path.write_text(json.dumps(data), "utf-8")
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    with pytest.raises(ValueError, match="machine roles not supported"):
        machine._load_config(path)


def test_response_too_large_action_does_not_advise_removed_compact():
    action = machine._action_for("RESPONSE_TOO_LARGE")
    assert "compact" not in action
    assert "P4" in action


def test_compute_role_is_explicit_in_trusted_config_only(tmp_path):
    assert "compute" in machine.MACHINE_ROLES
    plain = machine._load_config(_config(tmp_path))
    assert "compute" not in plain["caller"]["roles"]

    path = _config(tmp_path)
    data = json.loads(path.read_text())
    data["caller"]["roles"].append("compute")
    path.write_text(json.dumps(data), "utf-8")
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    loaded = machine._load_config(path)
    assert "compute" in loaded["caller"]["roles"]


def test_request_cannot_self_authorize_compute_or_paths(tmp_path):
    base = {"protocol_version": "wfd.product-machine/0.1",
            "request_id": "p6m-test-roles", "operation": "capabilities", "arguments": {}}
    with pytest.raises(ValueError, match="unexpected fields"):
        machine._request_object({**base, "caller_roles": ["compute"]})
    with pytest.raises(ValueError, match="unexpected fields"):
        machine._request_object({**base, "sources": {"fixture": {}}})
    with pytest.raises(ValueError, match="unexpected arguments"):
        machine._exact({"path": "/tmp/attacker"}, set(), set())


def test_read_product_rejects_unexposed_inner_operation():
    with pytest.raises(machine._QueryOperationDenied) as caught:
        machine._validated_query_request({
            "request": {"operation": "read_relation_graph"}})
    assert caught.value.details["exposed_inner_operations"] == ["read_product"]
    accepted = {"operation": "read_product"}
    assert machine._validated_query_request({"request": accepted}) is accepted


def _fake_status(count=64):
    outputs = [{"output_key": f"out_{index:02d}",
                "product_id": f"p_{index:08d}",
                "snapshot_id": "s_test",
                "registration_state": "registered",
                "publication_state": "published_formal",
                "engine_publication_state": "published_verified",
                "contract_ref": {"id": "contract_test", "digest": "sha256:test"},
                "errors": []}
               for index in range(count)]
    return {
        "format_version": "wfd.product-request-state/0.3",
        "service_version": "wfd.product-service/0.3",
        "request_key": "request_key_test",
        "request_identity": {"dataset_id": "d", "trusted_actor_namespace": "n",
                             "request_id": "r", "submission_digest": "sha256:x"},
        "state": "published_formal", "service_status": "published_formal",
        "phases": {"publication": "published"}, "snapshot_id": "s_test",
        "errors": [], "output_results": outputs,
        "formal_publication": {"path": "catalog/product_service/formal_publications/k.json",
                               "record": {"checks": {"ok": True}, "outputs": outputs}},
    }


def test_status_view_is_bounded_and_pageable():
    view = machine._status_view(_fake_status(), _fake_status()["request_identity"],
                                offset=0, limit=5, detail="summary")
    assert view["state"] == "published_formal"
    assert view["outputs_total"] == 64
    assert view["outputs_included"] == 5
    assert view["outputs_complete"] is False
    assert view["has_more"] is True
    assert view["continuation"]["arguments"]["output_offset"] == 5
    assert view["formal_publication"]["record_included"] is False
    assert "record" not in view["formal_publication"]

    tail = machine._status_view(_fake_status(), _fake_status()["request_identity"],
                                offset=60, limit=20, detail="summary")
    assert tail["outputs_included"] == 4
    assert tail["has_more"] is False
    assert tail["outputs_remaining"] == 0


def test_fit_response_projects_large_status_without_claiming_complete():
    status = _fake_status()
    response = {"protocol_version": "wfd.product-machine/0.1", "request_id": "r",
                "operation": "request_status", "ok": True, "result": status,
                "error": None, "identity": {}, "service": {}, "elapsed_ms": 1}
    projected = machine._fit_response(response, 8192)
    assert projected["bounded_response"]["complete"] is False
    assert projected["result"]["outputs_total"] == 64
    assert projected["result"]["outputs_included"] < 64
    assert projected["result"]["request_identity"]["request_id"] == "r"
    assert machine._json_bytes(projected) <= 8192


def test_write_failure_never_claims_no_write():
    class FakeService:
        def request_status(self, identity):
            return {"state": "published_formal", "snapshot_id": "s_real",
                    "request_key": "k_real", "request_identity": identity,
                    "output_results": [{"output_key": "o1"}],
                    "formal_publication": {"path": "p", "record": {"checks": {}}}}

    config = {"max_response_bytes": 65536, "batch_limits": {}}
    request = {"request_id": "r", "operation": "submit",
               "arguments": {"document": {"request_identity": {
                   "dataset_id": "d", "trusted_actor_namespace": "n",
                   "request_id": "req-1", "submission_digest": "sha256:x"}}}}
    context = machine._write_context(FakeService(), config, request, None)
    assert context["known_state"] == "published_formal"
    assert context["snapshot_id"] == "s_real"
    assert context["status_query"]["operation"] == "request_status"
    assert "没有写入任何数据" not in machine._action_for("PROCESS_OUTPUT_FAILED")
    assert "同一" in machine._action_for("PROCESS_OUTPUT_FAILED")
    assert "没有写入任何数据" not in machine._action_for("SOMETHING_UNKNOWN")


def test_nt_reparse_point_distinguishes_surrogates_from_filter_tags(tmp_path, monkeypatch):
    import types
    from wfd_sdk.transfer import is_bundle_link, is_nt_link_stat
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x0400)
    symlink_tag = getattr(stat, "IO_REPARSE_TAG_SYMLINK", 0xA000000C)
    mount_tag = getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003)
    dedup_tag = 0x80000013
    wof_tag = 0x80000017
    appexeclink_tag = 0x8000001B
    af_unix_tag = 0x80000023
    for helper in (machine._is_nt_link_stat, is_nt_link_stat):
        assert helper(types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_file_attributes=0, st_reparse_tag=0)) is True
        assert helper(types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_file_attributes=0, st_reparse_tag=0)) is False
        assert helper(types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_file_attributes=reparse, st_reparse_tag=symlink_tag)) is True
        assert helper(types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_file_attributes=reparse, st_reparse_tag=mount_tag)) is True
        assert helper(types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_file_attributes=reparse, st_reparse_tag=0)) is True
        assert helper(types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_file_attributes=reparse, st_reparse_tag=appexeclink_tag)) is True
        assert helper(types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_file_attributes=reparse, st_reparse_tag=af_unix_tag)) is True
        assert helper(types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_file_attributes=reparse, st_reparse_tag=dedup_tag)) is False
        assert helper(types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_file_attributes=reparse, st_reparse_tag=wof_tag)) is False

    # On Windows, _is_nt_link_path / transfer.is_bundle_link must rely on raw FindFirstFileW reparse tags rather than lstat().
    sample = tmp_path / "entry"
    sample.mkdir()
    assert is_bundle_link is machine._is_nt_link_path
    with monkeypatch.context() as mp:
        mp.setattr(machine.os, "name", "nt")
        mp.setattr(Path, "lstat", lambda _self: types.SimpleNamespace(
            st_mode=stat.S_IFDIR | 0o755, st_file_attributes=reparse, st_reparse_tag=0))
        mp.setattr(machine, "_nt_raw_reparse_info", lambda _p: (reparse, wof_tag))
        assert is_bundle_link(sample) is False
        mp.setattr(Path, "lstat", lambda _self: types.SimpleNamespace(
            st_mode=stat.S_IFDIR | 0o755, st_file_attributes=0, st_reparse_tag=0))
        mp.setattr(machine, "_nt_raw_reparse_info", lambda _p: (reparse, appexeclink_tag))
        assert is_bundle_link(sample) is True
        mp.setattr(machine, "_nt_raw_reparse_info", lambda _p: (reparse, 0))
        assert is_bundle_link(sample) is True


def test_machine_correlates_config_not_found_and_marks_unwritten(tmp_path, monkeypatch, capsys):
    from io import BytesIO
    import types
    missing_store = tmp_path / "missing-store"
    cfg_path = _config(tmp_path, store=str(missing_store), profile="data_only",
                       sources={}, caller={"caller_id": "test", "trusted_actor_namespace": "test", "roles": ["read"]})
    missing_store.rmdir()
    digest = "sha256:" + hashlib.sha256(cfg_path.read_bytes()).hexdigest()
    envelope = {"protocol_version": machine.MACHINE_PROTOCOL, "request_id": "req-correlate-1",
                "operation": "bundle_capabilities", "arguments": {}}
    monkeypatch.setattr("sys.stdin", types.SimpleNamespace(buffer=BytesIO(json.dumps(envelope).encode("utf-8"))))
    code = machine.main(["--config", str(cfg_path), "--expected-config-sha256", digest])
    assert code == 2
    reply = json.loads(capsys.readouterr().out)
    assert reply["ok"] is False
    assert reply["request_id"] == "req-correlate-1"
    assert reply["operation"] == "bundle_capabilities"
    assert reply["error"]["code"] == "CONFIG_NOT_FOUND"

    package_dir = tmp_path / "pkg"
    package_dir.mkdir(mode=0o700)
    write_env = {"protocol_version": machine.MACHINE_PROTOCOL, "request_id": "req-correlate-2",
                 "operation": "bundle_import_full",
                 "arguments": {"package_path": str(package_dir / "pkg1"), "descriptor_sha256": "sha256:" + "0" * 64}}
    monkeypatch.setattr("sys.stdin", types.SimpleNamespace(buffer=BytesIO(json.dumps(write_env).encode("utf-8"))))
    code2 = machine.main(["--config", str(cfg_path), "--expected-config-sha256", digest])
    assert code2 == 2
    reply2 = json.loads(capsys.readouterr().out)
    assert reply2["ok"] is False
    assert reply2["request_id"] == "req-correlate-2"
    assert reply2["operation"] == "bundle_import_full"
    assert reply2["error"]["code"] == "CONFIG_NOT_FOUND"
    assert reply2["error"]["details"]["write_context"]["may_have_written"] is False


def test_machine_correlates_bundle_path_invalid_for_linked_store(tmp_path, monkeypatch, capsys):
    from io import BytesIO
    import types
    base = tmp_path.resolve()
    alias = base / "alias-store"
    _link_dir(alias, base)
    package_dir = base / "pkg"
    package_dir.mkdir(mode=0o700)
    real_store = base / "real-store"
    real_store.mkdir(mode=0o700)
    bundle_opts = dict(
        profile="data_only",
        sources={"s1": {"may_read": True, "usage_scope": "test"}},
        caller={"caller_id": "test", "trusted_actor_namespace": "test", "roles": ["read", "register", "publish"]},
        bundle_access={"operations": ["bundle_import_full"], "source_ids": ["s1"], "dataset_id": "d1",
                       "package_root": str(package_dir), "target_store": str(base / "target")},
    )
    valid_cfg = _config(base, store=str(real_store), **bundle_opts)
    assert machine._load_config(valid_cfg)["store"] == str(real_store)
    bad_bundle_cfg = _config(base, store=str(alias / "real-store"), **bundle_opts)
    bad_digest = "sha256:" + hashlib.sha256(bad_bundle_cfg.read_bytes()).hexdigest()
    envelope = {"protocol_version": machine.MACHINE_PROTOCOL, "request_id": "req-correlate-link",
                "operation": "bundle_capabilities", "arguments": {}}
    monkeypatch.setattr("sys.stdin", types.SimpleNamespace(buffer=BytesIO(json.dumps(envelope).encode("utf-8"))))
    code = machine.main(["--config", str(bad_bundle_cfg), "--expected-config-sha256", bad_digest])
    assert code == 2
    reply = json.loads(capsys.readouterr().out)
    assert reply["ok"] is False
    assert reply["request_id"] == "req-correlate-link"
    assert reply["operation"] == "bundle_capabilities"
    assert reply["error"]["code"] == "BUNDLE_PATH_INVALID"


def test_machine_correlates_config_io_error(tmp_path, monkeypatch, capsys):
    import errno
    from io import BytesIO
    import types
    base = tmp_path.resolve()
    store = base / "store"
    package_dir = base / "pkg"
    package_dir.mkdir(mode=0o700)
    cfg_path = _config(
        base, store=str(store), profile="data_only",
        sources={"s1": {"may_read": True, "may_export": True, "usage_scope": "test",
                        "export_scope": "selected_dataset"}},
        caller={"caller_id": "test", "trusted_actor_namespace": "test",
                "roles": ["read", "register", "publish", "export"]},
        limits={"max_request_bytes": machine.MAX_ALLOWED_INPUT_BYTES},
        bundle_access={"operations": ["bundle_import_full", "bundle_export_full"],
                       "source_ids": ["s1"], "dataset_id": "d1",
                       "package_root": str(package_dir), "target_store": str(base / "target")},
    )
    digest = "sha256:" + hashlib.sha256(cfg_path.read_bytes()).hexdigest()
    assert machine._load_config(cfg_path, digest)["max_request_bytes"] == machine.MAX_ALLOWED_INPUT_BYTES
    original_read_bytes = Path.read_bytes

    def fail_config_read(self):
        if self == cfg_path:
            raise PermissionError(errno.EACCES, "Permission denied", str(self))
        return original_read_bytes(self)

    def invoke(argv, req_id, op, args, *, pad=0):
        env = {"protocol_version": machine.MACHINE_PROTOCOL, "request_id": req_id,
               "operation": op, "arguments": args}
        raw = json.dumps(env).encode("utf-8")
        if pad:
            raw += b" " * (pad - len(raw))
        monkeypatch.setattr("sys.stdin", types.SimpleNamespace(buffer=BytesIO(raw)))
        code = machine.main(argv)
        return code, json.loads(capsys.readouterr().out), len(raw)

    base_argv = ["--config", str(cfg_path), "--expected-config-sha256", digest]
    large_args = {"package_path": str(package_dir / "pkg2"), "snapshot_id": "s_" + "1" * 24,
                  "products": [{"product_id": "p_" + "1" * 24}]}
    with monkeypatch.context() as mp:
        mp.setattr(Path, "read_bytes", fail_config_read)
        for req_id, op, args, expected_may in (
            ("req-cfg-io-ro", "bundle_capabilities", {}, None),
            ("req-cfg-io-rw", "bundle_import_full",
             {"package_path": str(package_dir / "pkg1"), "descriptor_sha256": "sha256:" + "0" * 64}, True),
        ):
            code, reply, _ = invoke(base_argv, req_id, op, args)
            assert code == 2 and reply["ok"] is False
            assert reply["request_id"] == req_id and reply["operation"] == op
            assert reply["error"]["code"] == "STORAGE_IO_ERROR"
            assert str(base) not in reply["error"]["message"]
            assert str(base) not in (reply["error"].get("cause") or "")
            if expected_may is not None:
                assert reply["error"]["details"]["write_context"]["may_have_written"] is expected_may

        # Exact 8 MiB boundary correlates request/write_context; 8 MiB + 1 byte stays unparsed.
        code, exact_reply, exact_len = invoke(
            base_argv, "req-cfg-io-8mib", "bundle_export_full", large_args,
            pad=machine.MAX_ALLOWED_INPUT_BYTES)
        assert exact_len == machine.MAX_ALLOWED_INPUT_BYTES
        assert code == 2 and exact_reply["ok"] is False
        assert exact_reply["request_id"] == "req-cfg-io-8mib" and exact_reply["operation"] == "bundle_export_full"
        assert exact_reply["error"]["code"] == "STORAGE_IO_ERROR"
        assert str(base) not in exact_reply["error"]["message"]
        assert str(base) not in (exact_reply["error"].get("cause") or "")
        assert exact_reply["error"]["details"]["write_context"]["may_have_written"] is True

        code, over_reply, over_len = invoke(
            base_argv, "req-cfg-io-over", "bundle_export_full", large_args,
            pad=machine.MAX_ALLOWED_INPUT_BYTES + 1)
        assert over_len == machine.MAX_ALLOWED_INPUT_BYTES + 1
        assert code == 2 and over_reply["ok"] is False
        assert over_reply["request_id"] == "unparsed" and over_reply["operation"] == "unparsed"
        assert over_reply["error"]["code"] == "STORAGE_IO_ERROR"

        # Without --expected-config-sha256, config EACCES still correlates read & write requests.
        no_digest_argv = ["--config", str(cfg_path)]
        code, ro_reply, _ = invoke(no_digest_argv, "req-no-digest-ro", "capabilities", {})
        assert code == 2 and ro_reply["ok"] is False
        assert ro_reply["request_id"] == "req-no-digest-ro" and ro_reply["operation"] == "capabilities"
        assert ro_reply["error"]["code"] == "STORAGE_IO_ERROR"
        assert str(base) not in ro_reply["error"]["message"]
        assert str(base) not in (ro_reply["error"].get("cause") or "")

        code, rw_reply, _ = invoke(no_digest_argv, "req-no-digest-rw", "submit", {})
        assert code == 2 and rw_reply["ok"] is False
        assert rw_reply["request_id"] == "req-no-digest-rw" and rw_reply["operation"] == "submit"
        assert rw_reply["error"]["code"] == "STORAGE_IO_ERROR"
        assert rw_reply["error"]["details"]["write_context"]["may_have_written"] is True

    # Unhashable non-string profile or explicit null storage_format returns correlated CONFIG_INVALID.
    for idx, overrides in enumerate(({"profile": ["data_only"], "sources": {}},
                                     {"profile": "data_only", "sources": {}, "storage_format": None})):
        bad_dir = base / f"bad-cfg-{idx}"
        bad_dir.mkdir(mode=0o700)
        bad_cfg = _config(bad_dir, store=str(store), **overrides)
        bad_digest = "sha256:" + hashlib.sha256(bad_cfg.read_bytes()).hexdigest()
        for argv in (["--config", str(bad_cfg)],
                     ["--config", str(bad_cfg), "--expected-config-sha256", bad_digest]):
            code, bad_reply, _ = invoke(
                argv, f"req-bad-cfg-{idx}", "bundle_import_full",
                {"package_path": str(package_dir / "pkg1"), "descriptor_sha256": "sha256:" + "0" * 64})
            assert code == 2 and bad_reply["ok"] is False
            assert bad_reply["request_id"] == f"req-bad-cfg-{idx}" and bad_reply["operation"] == "bundle_import_full"
            assert bad_reply["error"]["code"] == "CONFIG_INVALID"
            assert bad_reply["error"]["details"]["write_context"]["may_have_written"] is False

    store.rmdir()
    code, missing_reply, _ = invoke(["--config", str(cfg_path)], "req-no-digest-missing", "capabilities", {})
    assert code == 2 and missing_reply["ok"] is False
    assert missing_reply["request_id"] == "req-no-digest-missing" and missing_reply["operation"] == "capabilities"
    assert missing_reply["error"]["code"] == "CONFIG_NOT_FOUND"


def _submit_bundle_seed_row(store: Path, runtime: Path, *, request_id: str,
                            business_key: str, value: str, parent: str | None = None,
                            initialize: bool = True) -> tuple[str, str]:
    from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
    from wfd_sdk.product_data_service import WFDDataOnlyService
    validator = load_protocol_validator(ROOT / "protocol", "wfd-data-only-write.schema.json")
    engine = (WFDDuckDBPrototype.initialize_new(store, validator, runtime_root=runtime, sandbox=False,
                                                writer_host="p6-bundle-io")
              if initialize else
              WFDDuckDBPrototype.open_existing(store, validator, runtime_root=runtime, sandbox=False,
                                               read_only=False, writer_host="p6-bundle-io"))
    service = WFDDataOnlyService(
        engine,
        caller_roles={"read", "register", "submit", "publish", "export"},
        caller_id="p6-test",
        unit_registry={"count": {"dimension": "quantity"}},
        trusted_actor_namespaces={"wfd.p6.test"},
    )
    doc = {
        "protocol_version": "wfd.structured-ingest/1.0",
        "request_identity": {
            "dataset_id": "d1", "trusted_actor_namespace": "wfd.p6.test",
            "request_id": request_id, "submission_digest": "sha256:" + "1" * 64,
        },
        "intent": "submit",
        "producer_namespace": "wfd.p6.test",
        "expected_parent_snapshot_id": parent,
        "outputs": [{
            "output_key": "metric",
            "logical_domain": "observations",
            "subject": {"kind": "physical_object", "namespace": "wfd.p6.test", "id": "synthetic"},
            "definition_mode": "create",
            "definition_ref": None,
            "definition": {
                "semantic_code": "p6.bundle.count",
                "measurement_nature": "flow",
                "unit_code": "count",
                "definition_authority": "wfd.p6.test",
                "time_role": "observation",
                "semantic_context": {
                    "version": "wfd.semantic-context/1.0",
                    "content_nature": "observed_fact",
                    "time": {"period_type": "natural", "frequency": "year", "interval": "closed"},
                    "statistical": {"price_basis": "nominal", "period_aggregation": "period"},
                },
            },
            "input_mode": "partial_observation",
            "coverage": {"scope": {"sample_only": True}, "basis": "observed_partial",
                         "completeness": "partial", "absence_means": "unknown"},
            "payload": {"kind": "scalar_rows", "rows": [{
                "business_key": business_key,
                "value_decimal": value,
                "value_state": "valid_value",
                "observation_time": {
                    "status": "known", "precision": "year",
                    "earliest_utc": "2025-01-01T00:00:00Z",
                    "latest_exclusive_utc": "2026-01-01T00:00:00Z",
                    "source_timezone": "UTC",
                },
            }]},
        }],
    }
    res = service.submit(doc)
    assert res["state"] == "published_formal"
    return res["snapshot_id"], res["output_results"][0]["product_id"]


def test_bundle_write_tracking_compatibility_and_capabilities(tmp_path, monkeypatch, capsys):
    from io import BytesIO
    import types
    from wfd_sdk import product_machine_bundle
    from wfd_sdk.product_data_service import WFDDataOnlyService

    base = tmp_path.resolve()
    store = base / "store"
    runtime = base / "runtime"
    packages = base / "packages"
    target = base / "target"
    packages.mkdir(mode=0o700)
    snapshot_id, product_id = _submit_bundle_seed_row(
        store, runtime, request_id="p6-compat-seed", business_key="row-1", value="1")

    cfg = _config(
        base, store=str(store), profile="data_only",
        units={"count": {"dimension": "quantity"},
               "cny_per_share": {"dimension": "money_per_share", "currency": "CNY", "multiplier": "1"}},
        sources={"s1": {"may_read": True, "may_export": True, "usage_scope": "test",
                        "export_scope": "selected_dataset"}},
        caller={"caller_id": "p6-test", "trusted_actor_namespace": "wfd.p6.test",
                "roles": ["read", "register", "publish", "export"]},
        bundle_access={"operations": sorted(machine.BUNDLE_ROLES), "source_ids": ["s1"], "dataset_id": "d1",
                       "package_root": str(packages), "target_store": str(target)},
    )
    digest = "sha256:" + hashlib.sha256(cfg.read_bytes()).hexdigest()
    loaded = machine._load_config(cfg, digest)
    read_service = machine._build_service(loaded, operation="bundle_capabilities")

    # 1) Old entry (omits on_write_start) with HEAD SDK: capabilities reflect unsupported, side effects reject before read check.
    no_cb_caps = product_machine_bundle.capabilities(loaded)
    no_cb_dispatch_caps = product_machine_bundle.dispatch(read_service, loaded, "bundle_capabilities", {})
    for caps_view in (no_cb_caps, no_cb_dispatch_caps):
        assert caps_view["operations"] == {
            op: {"supported": False, "writes_target": op in machine.BUNDLE_WRITES, "reason": "OPERATION_UNSUPPORTED"}
            for op in machine.BUNDLE_ROLES
        }
    tracked_caps = product_machine_bundle.dispatch(
        read_service, loaded, "bundle_capabilities", {}, on_write_start=lambda: None)
    assert all(item["supported"] is True and item["reason"] is None for item in tracked_caps["operations"].values())

    no_read_service = WFDDataOnlyService(
        read_service.engine,
        caller_roles={"register", "publish"},
        caller_id="p6-no-read",
        unit_registry={"count": {"dimension": "quantity"}},
        trusted_actor_namespaces={"wfd.p6.test"},
    )
    for op in sorted(machine.BUNDLE_ROLES):
        op_args = ({"package_path": str(packages / "pkg1"), "descriptor_sha256": "sha256:" + "0" * 64}
                   if op in machine.BUNDLE_WRITES else
                   {"package_path": str(packages / f"no-cb-{op}"), "snapshot_id": snapshot_id,
                    "products": [{"product_id": product_id}],
                    **({"baseline_snapshot_id": snapshot_id} if op == "bundle_export_delta" else {})})
        for svc in (read_service, no_read_service):
            with pytest.raises(ValueError, match="OPERATION_UNSUPPORTED"):
                product_machine_bundle.dispatch(svc, loaded, op, op_args)
    with pytest.raises(ValueError, match="OPERATION_UNSUPPORTED"):
        product_machine_bundle._export(
            read_service, loaded["bundle_access"], "bundle_export_full",
            {"package_path": str(packages / "no-cb-export"), "snapshot_id": snapshot_id,
             "products": [{"product_id": product_id}]},
            packages / "no-cb-export",
        )
    assert list(packages.iterdir()) == []
    assert not target.exists()

    # 2) HEAD entry paired with a legacy 4-arg SDK module (no on_write_start param): capabilities stay readable & unsupported.
    legacy_dispatch_calls = 0

    def legacy_capabilities(config):
        return product_machine_bundle.capabilities(config, write_tracking=True)

    def legacy_dispatch(service, config, operation, args):
        nonlocal legacy_dispatch_calls
        legacy_dispatch_calls += 1
        assert operation == "bundle_capabilities"
        return legacy_capabilities(config)

    legacy_bundle = types.SimpleNamespace(
        load_access=product_machine_bundle.load_access,
        capabilities=legacy_capabilities,
        dispatch=legacy_dispatch,
    )

    def run_main(env):
        monkeypatch.setattr("sys.stdin", types.SimpleNamespace(buffer=BytesIO(json.dumps(env).encode("utf-8"))))
        code = machine.main(["--config", str(cfg), "--expected-config-sha256", digest])
        return code, json.loads(capsys.readouterr().out)

    with monkeypatch.context() as mp:
        mp.setattr(machine, "_optional_bundle_module", lambda: legacy_bundle)
        code, caps_reply = run_main({
            "protocol_version": machine.MACHINE_PROTOCOL,
            "request_id": "req-legacy-sdk-bcaps",
            "operation": "bundle_capabilities",
            "arguments": {},
        })
        assert code == 0 and caps_reply["ok"] is True
        assert legacy_dispatch_calls == 1
        assert all(item == {"supported": False, "writes_target": op in machine.BUNDLE_WRITES, "reason": "OPERATION_UNSUPPORTED"}
                   for op, item in caps_reply["result"]["operations"].items())

        code, gen_caps = run_main({
            "protocol_version": machine.MACHINE_PROTOCOL,
            "request_id": "req-legacy-sdk-caps",
            "operation": "capabilities",
            "arguments": {},
        })
        assert code == 0 and gen_caps["ok"] is True
        for op in machine.BUNDLE_ROLES:
            assert gen_caps["result"]["operations"][op]["supported"] is False
            assert gen_caps["result"]["operations"][op]["reason"] == "OPERATION_UNSUPPORTED"

        code, write_reply = run_main({
            "protocol_version": machine.MACHINE_PROTOCOL,
            "request_id": "req-legacy-sdk-write",
            "operation": "bundle_import_full",
            "arguments": {"package_path": str(packages / "pkg1"), "descriptor_sha256": "sha256:" + "0" * 64},
        })
        assert code == 0 and write_reply["ok"] is False
        assert write_reply["error"]["code"] == "OPERATION_UNSUPPORTED"
        assert write_reply["error"]["details"]["write_context"]["may_have_written"] is False
        assert legacy_dispatch_calls == 1

    # 3) HEAD entry with an SDK accepting on_write_start in dispatch and single-arg capabilities(config) without module flags.
    inter_dispatch_calls = 0

    def inter_dispatch(service, config, operation, args, *, on_write_start=None):
        nonlocal inter_dispatch_calls
        inter_dispatch_calls += 1
        if operation == "bundle_capabilities":
            return legacy_capabilities(config)
        assert callable(on_write_start)
        on_write_start()
        raise ValueError("REQUEST_INVALID:late_failure")

    inter_bundle = types.SimpleNamespace(
        load_access=product_machine_bundle.load_access,
        capabilities=legacy_capabilities,
        dispatch=inter_dispatch,
    )
    with monkeypatch.context() as mp:
        mp.setattr(machine, "_optional_bundle_module", lambda: inter_bundle)
        code, inter_bcaps = run_main({
            "protocol_version": machine.MACHINE_PROTOCOL,
            "request_id": "req-inter-sdk-bcaps",
            "operation": "bundle_capabilities",
            "arguments": {},
        })
        assert code == 0 and inter_bcaps["ok"] is True
        assert inter_bcaps["result"]["write_tracking"] is True
        assert all(item["supported"] is True and item["reason"] is None
                   for item in inter_bcaps["result"]["operations"].values())

        code, inter_gcaps = run_main({
            "protocol_version": machine.MACHINE_PROTOCOL,
            "request_id": "req-inter-sdk-caps",
            "operation": "capabilities",
            "arguments": {},
        })
        assert code == 0 and inter_gcaps["ok"] is True
        assert inter_gcaps["result"]["bundle_write_tracking"] is True
        for op in machine.BUNDLE_ROLES:
            assert inter_gcaps["result"]["operations"][op]["supported"] is True
            assert inter_gcaps["result"]["operations"][op]["reason"] is None

        monkeypatch.setattr("sys.stdin", types.SimpleNamespace(buffer=BytesIO(json.dumps({
            "protocol_version": machine.MACHINE_PROTOCOL,
            "request_id": "req-inter-sdk-write",
            "operation": "bundle_import_full",
            "arguments": {"package_path": str(packages / "pkg1"), "descriptor_sha256": "sha256:" + "0" * 64},
        }).encode("utf-8"))))
        code = machine.main(["--config", str(cfg), "--expected-config-sha256", digest,
                             "--require-bundle-write-tracking"])
        inter_write = json.loads(capsys.readouterr().out)
        assert code == 0 and inter_write["ok"] is False
        assert inter_write["error"]["code"] == "REQUEST_INVALID"
        assert inter_write["error"]["details"]["write_context"]["may_have_written"] is True
        assert inter_dispatch_calls == 2

    # 4) Positional-only (with or without **kwargs) and generic **kwargs wrappers must NOT claim write-tracking support.
    def posonly_capabilities(config, write_tracking=False, /):
        return product_machine_bundle.capabilities(config, write_tracking=write_tracking)

    def posonly_dispatch(service, config, operation, args, on_write_start=None, /):
        assert operation == "bundle_capabilities"
        return legacy_capabilities(config)

    def posonly_kwargs_dispatch(service, config, operation, args, on_write_start=None, /, **_extra):
        assert operation == "bundle_capabilities"
        return legacy_capabilities(config)

    def generic_kwargs_dispatch(service, config, operation, args, **_extra):
        assert operation == "bundle_capabilities"
        return legacy_capabilities(config)

    for variant, fn in (("posonly", posonly_dispatch),
                        ("posonly-kwargs", posonly_kwargs_dispatch),
                        ("generic-kwargs", generic_kwargs_dispatch)):
        bundle_stub = types.SimpleNamespace(
            load_access=product_machine_bundle.load_access,
            capabilities=posonly_capabilities,
            dispatch=fn,
        )
        with monkeypatch.context() as mp:
            mp.setattr(machine, "_optional_bundle_module", lambda _b=bundle_stub: _b)
            code, pos_bcaps = run_main({
                "protocol_version": machine.MACHINE_PROTOCOL,
                "request_id": f"req-{variant}-bcaps",
                "operation": "bundle_capabilities",
                "arguments": {},
            })
            assert code == 0 and pos_bcaps["ok"] is True
            assert pos_bcaps["result"]["write_tracking"] is False
            assert all(item["supported"] is False and item["reason"] == "OPERATION_UNSUPPORTED"
                       for item in pos_bcaps["result"]["operations"].values())

            code, pos_gcaps = run_main({
                "protocol_version": machine.MACHINE_PROTOCOL,
                "request_id": f"req-{variant}-gcaps",
                "operation": "capabilities",
                "arguments": {},
            })
            assert code == 0 and pos_gcaps["ok"] is True
            assert pos_gcaps["result"]["bundle_write_tracking"] is False
            for op in machine.BUNDLE_ROLES:
                assert pos_gcaps["result"]["operations"][op]["supported"] is False
                assert pos_gcaps["result"]["operations"][op]["reason"] == "OPERATION_UNSUPPORTED"

            code, pos_write = run_main({
                "protocol_version": machine.MACHINE_PROTOCOL,
                "request_id": f"req-{variant}-write",
                "operation": "bundle_import_full",
                "arguments": {"package_path": str(packages / "pkg1"), "descriptor_sha256": "sha256:" + "0" * 64},
            })
            assert code == 0 and pos_write["ok"] is False
            assert pos_write["error"]["code"] == "OPERATION_UNSUPPORTED"
            assert pos_write["error"]["details"]["write_context"]["may_have_written"] is False


def test_bundle_write_io_errors_preserve_may_have_written(tmp_path, monkeypatch, capsys):
    import errno
    from io import BytesIO
    import types
    from wfd_sdk import product_bundle as sdk_bundle
    from wfd_sdk import product_machine_bundle

    assert machine._service_error(OSError(errno.ENOSPC, "No space left on device"))[0] == "STORAGE_IO_ERROR"
    assert machine._service_error(PermissionError(errno.EACCES, "Permission denied"))[0] == "STORAGE_IO_ERROR"
    assert machine._service_error(PermissionError("CALLER_PERMISSION_DENIED:publish"))[0] == "CALLER_PERMISSION_DENIED"

    base = tmp_path.resolve()
    store = base / "store"
    runtime = base / "runtime"
    packages = base / "packages"
    target = base / "target"
    packages.mkdir(mode=0o700)
    snapshot_id, product_id = _submit_bundle_seed_row(
        store, runtime, request_id="p6-bundle-seed-1", business_key="row-1", value="1")

    cfg = _config(
        base, store=str(store), profile="data_only",
        units={"count": {"dimension": "quantity"},
               "cny_per_share": {"dimension": "money_per_share", "currency": "CNY", "multiplier": "1"}},
        sources={"s1": {"may_read": True, "may_export": True, "usage_scope": "test",
                        "export_scope": "selected_dataset"}},
        caller={"caller_id": "p6-test", "trusted_actor_namespace": "wfd.p6.test",
                "roles": ["read", "register", "publish", "export"]},
        bundle_access={"operations": sorted(machine.BUNDLE_ROLES), "source_ids": ["s1"], "dataset_id": "d1",
                       "package_root": str(packages), "target_store": str(target)},
    )
    digest = "sha256:" + hashlib.sha256(cfg.read_bytes()).hexdigest()

    def run_main(env):
        monkeypatch.setattr("sys.stdin", types.SimpleNamespace(buffer=BytesIO(json.dumps(env).encode("utf-8"))))
        code = machine.main(["--config", str(cfg), "--expected-config-sha256", digest])
        return code, json.loads(capsys.readouterr().out)

    def real_bundle(op, pkg_name, arguments):
        code, reply = run_main({
            "protocol_version": machine.MACHINE_PROTOCOL,
            "request_id": f"req-real-{op}-{pkg_name}",
            "operation": op,
            "arguments": {"package_path": str(packages / pkg_name), **arguments},
        })
        assert code == 0 and reply["ok"] is True, reply
        return reply["result"]

    real_pkg = packages / "real-pkg"
    full_res = real_bundle("bundle_export_full", "real-pkg",
                           {"snapshot_id": snapshot_id, "products": [{"product_id": product_id}]})
    full_digest = full_res["descriptor_sha256"]

    ref_pkg = packages / "ref-pkg"
    ref_res = real_bundle("bundle_export_reference", "ref-pkg",
                          {"snapshot_id": snapshot_id, "products": [{"product_id": product_id}]})
    ref_digest = ref_res["descriptor_sha256"]

    # Pre-write digest mismatches stay unwritten.
    for op, pkg in (("bundle_import_full", real_pkg), ("bundle_register_reference", ref_pkg)):
        code, reply = run_main({
            "protocol_version": machine.MACHINE_PROTOCOL,
            "request_id": f"req-mismatch-{op}",
            "operation": op,
            "arguments": {"package_path": str(pkg), "descriptor_sha256": "sha256:" + "0" * 64},
        })
        assert code == 0 and reply["ok"] is False
        assert reply["error"]["code"] == "BUNDLE_DESCRIPTOR_DIGEST_MISMATCH"
        assert reply["error"]["details"]["write_context"]["may_have_written"] is False

    # Seed real target baseline + second snapshot for delta export/apply coverage.
    baseline_snapshot_id = real_bundle(
        "bundle_import_full", "real-pkg", {"descriptor_sha256": full_digest})["target_snapshot_id"]
    snapshot_id_2, product_id_2 = _submit_bundle_seed_row(
        store, runtime, request_id="p6-bundle-seed-2", business_key="row-2", value="2",
        parent=snapshot_id, initialize=False)
    assert product_id_2 == product_id
    delta_pkg = packages / "delta-pkg"
    delta_digest = real_bundle("bundle_export_delta", "delta-pkg", {
        "snapshot_id": snapshot_id_2, "baseline_snapshot_id": baseline_snapshot_id,
        "products": [{"product_id": product_id}],
    })["descriptor_sha256"]

    code, mismatch_delta = run_main({
        "protocol_version": machine.MACHINE_PROTOCOL,
        "request_id": "req-mismatch-delta",
        "operation": "bundle_apply_delta",
        "arguments": {"package_path": str(delta_pkg), "descriptor_sha256": "sha256:" + "0" * 64},
    })
    assert code == 0 and mismatch_delta["ok"] is False
    assert mismatch_delta["error"]["code"] == "BUNDLE_DESCRIPTOR_DIGEST_MISMATCH"
    assert mismatch_delta["error"]["details"]["write_context"]["may_have_written"] is False

    faults = (
        ("STORAGE_IO_ERROR", OSError(errno.ENOSPC, "No space left on device")),
        ("STORAGE_IO_ERROR", PermissionError(errno.EACCES, "Permission denied")),
        ("REQUEST_INVALID", ValueError("REQUEST_INVALID:late_failure")),
    )
    # Failure at staging TemporaryDirectory creation must already observe on_write_start().
    export_ops = (
        ("bundle_export_full", {"snapshot_id": snapshot_id, "products": [{"product_id": product_id}]}, "export_structured_bundle"),
        ("bundle_export_delta", {"snapshot_id": snapshot_id_2, "baseline_snapshot_id": baseline_snapshot_id,
                                 "products": [{"product_id": product_id}]}, "export_structured_delta_bundle"),
        ("bundle_export_reference", {"snapshot_id": snapshot_id, "products": [{"product_id": product_id}]},
         "export_structured_reference_bundle"),
    )
    for op, base_args, sdk_attr in export_ops:
        for idx, (expected_code, exc) in enumerate((faults[0], faults[2])):
            tempdir_hits = 0

            def fail_tempdir(*_a, _exc=exc, **_kw):
                nonlocal tempdir_hits
                tempdir_hits += 1
                raise _exc

            with monkeypatch.context() as mp:
                mp.setattr(product_machine_bundle, "tempfile",
                           types.SimpleNamespace(TemporaryDirectory=fail_tempdir))
                code, reply = run_main({
                    "protocol_version": machine.MACHINE_PROTOCOL,
                    "request_id": f"req-tmpdir-{op}-{idx}",
                    "operation": op,
                    "arguments": {"package_path": str(packages / f"tmpdir-{op}-{idx}"), **base_args},
                })
            assert tempdir_hits == 1
            assert code == 0 and reply["ok"] is False
            assert reply["error"]["code"] == expected_code
            assert reply["error"]["details"]["write_context"]["may_have_written"] is True

        for idx, (expected_code, exc) in enumerate(faults):
            sdk_hits = 0

            def fail_sdk_export(*_a, _exc=exc, **_kw):
                nonlocal sdk_hits
                sdk_hits += 1
                raise _exc

            with monkeypatch.context() as mp:
                mp.setattr(sdk_bundle, sdk_attr, fail_sdk_export)
                code, reply = run_main({
                    "protocol_version": machine.MACHINE_PROTOCOL,
                    "request_id": f"req-sdk-{op}-{idx}",
                    "operation": op,
                    "arguments": {"package_path": str(packages / f"sdk-{op}-{idx}"), **base_args},
                })
            assert sdk_hits == 1
            assert code == 0 and reply["ok"] is False
            assert reply["error"]["code"] == expected_code
            assert reply["error"]["details"]["write_context"]["may_have_written"] is True

    write_ops = (
        ("bundle_import_full", real_pkg, full_digest, "import_structured_bundle"),
        ("bundle_apply_delta", delta_pkg, delta_digest, "apply_structured_delta_bundle"),
        ("bundle_register_reference", ref_pkg, ref_digest, "register_structured_reference_bundle"),
    )
    for op, pkg, pkg_digest, sdk_attr in write_ops:
        for idx, (expected_code, exc) in enumerate(faults):
            sdk_hits = 0

            def fail_sdk_write(*_a, _exc=exc, **_kw):
                nonlocal sdk_hits
                sdk_hits += 1
                raise _exc

            with monkeypatch.context() as mp:
                mp.setattr(sdk_bundle, sdk_attr, fail_sdk_write)
                code, reply = run_main({
                    "protocol_version": machine.MACHINE_PROTOCOL,
                    "request_id": f"req-sdk-{op}-{idx}",
                    "operation": op,
                    "arguments": {"package_path": str(pkg), "descriptor_sha256": pkg_digest},
                })
            assert sdk_hits == 1
            assert code == 0 and reply["ok"] is False
            assert reply["error"]["code"] == expected_code
            assert reply["error"]["details"]["write_context"]["may_have_written"] is True
