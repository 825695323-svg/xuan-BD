"""F06: strict legacy roles and independent data_only, without submit patches."""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys

import pytest

from test_product_service import HERE, make_service
from test_r1_data_only import make_data_service, request, scalar_output
from test_store_opening import WRITE_ROLES, machine_config


def issue_codes(result):
    return {issue["code"] for issue in result.get("errors", [])} | {
        issue["code"] for output in result.get("output_results", [])
        for issue in output.get("errors", [])}


def run_machine(config, document):
    """A fresh interpreter does not import pytest/conftest or any test helper."""
    payload = {"protocol_version": "wfd.product-machine/0.1",
               "request_id": "f06-submit", "operation": "submit",
               "arguments": {"document": document}}
    completed = subprocess.run(
        [sys.executable, "-m", "wfd_sdk.product_machine", "--config", str(config)],
        input=json.dumps(payload), text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, cwd=HERE,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, timeout=60)
    assert completed.returncode == 0, completed.stderr or completed.stdout
    response = json.loads(completed.stdout)
    assert response["ok"] is True, response
    return response["result"]


@pytest.mark.parametrize("roles", ["absent", None, {}, False])
def test_legacy_submit_missing_roles_is_not_filled_by_pytest(tmp_path, roles):
    service, document = make_service(tmp_path)
    if roles == "absent":
        del document["source_bundle"]["source_roles"]
    else:
        document["source_bundle"]["source_roles"] = roles
    result = service.submit(document)
    assert "SOURCE_ROLE_ASSIGNMENT_REQUIRED" in issue_codes(result), result
    assert result.get("snapshot_id") is None
    assert not list((service.root / "catalog/commits").glob("*.json"))
    # Admission never mutates the caller's request into a supposedly valid one.
    assert document["source_bundle"].get("source_roles") == (None if roles == "absent" else roles)


@pytest.mark.parametrize("roles", ["absent", {}])
def test_real_legacy_machine_rejects_missing_roles_then_accepts_explicit(tmp_path, roles):
    service, document = make_service(tmp_path / "seed")
    config = machine_config(tmp_path, service.root, "legacy", WRITE_ROLES)
    missing = copy.deepcopy(document)
    if roles == "absent":
        del missing["source_bundle"]["source_roles"]
    else:
        missing["source_bundle"]["source_roles"] = roles
    rejected = run_machine(config, missing)
    assert "SOURCE_ROLE_ASSIGNMENT_REQUIRED" in issue_codes(rejected), rejected
    assert rejected.get("snapshot_id") is None
    assert not list((service.root / "catalog/commits").glob("*.json"))

    # The positive control changes only request identity and the explicitly
    # supplied roles; neither configuration nor production admission is relaxed.
    explicit = copy.deepcopy(document)
    explicit["request_identity"]["request_id"] = "f06-explicit"
    accepted = run_machine(config, explicit)
    assert accepted["status"] == "published_formal", accepted
    assert len(list((service.root / "catalog/commits").glob("*.json"))) == 1


def test_real_data_only_machine_needs_no_legacy_source_roles(tmp_path):
    service = make_data_service(tmp_path / "seed", roles=set(WRITE_ROLES))
    # Preserve the seed's writer identity; a different caller must not activate
    # its committed head merely because it has a publish role.
    config = machine_config(tmp_path, service.root, "data_only", WRITE_ROLES,
                            caller_id="r1-test")
    document = request([scalar_output("f06", "f06.synthetic", "7")], "f06-data-only")
    assert "source_bundle" not in document
    accepted = run_machine(config, document)
    assert accepted["state"] == "published_formal", accepted
    commits = len(list((service.root / "catalog/commits").glob("*.json")))

    # Adding the legacy role structure is not a workaround: data_only explicitly
    # rejects it, keeping the two contracts independent.
    polluted = copy.deepcopy(document)
    polluted["request_identity"]["request_id"] = "f06-data-only-polluted"
    polluted["expected_parent_snapshot_id"] = accepted["snapshot_id"]
    polluted["source_bundle"] = {"source_roles": {
        "f06": [{"source_id": "fixture", "roles": ["definer"]}]}}
    denied = run_machine(config, polluted)
    assert denied["state"] == "rejected", denied
    # The public data_only schema excludes source_bundle before metadata-level
    # admission runs, so the precise boundary failure is SCHEMA_INVALID.
    assert issue_codes(denied) == {"SCHEMA_INVALID"}, denied
    assert any("source_bundle" in issue["message"] for issue in denied["errors"]), denied
    assert len(list((service.root / "catalog/commits").glob("*.json"))) == commits
