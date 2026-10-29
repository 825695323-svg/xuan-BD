"""Targeted P6 machine-boundary tests.

These tests cover the adapter's own trust boundary and operation registry; the
real multi-process submit/read/batch evidence lives in
``03_测试与验证记录/P6_公开机器入口扩展_2026-10-27/run_p6m1.py``.
"""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from wfd_sdk import product_machine as machine


ROOT = Path(__file__).resolve().parents[1]


def _config(tmp_path, **overrides):
    store = tmp_path / "store"
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
