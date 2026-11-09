"""Actual submit regression: unchanged coverage is not a new coverage version.

All stores are disposable.  The bundle's exact product/contract ambiguity guard
must remain intact; no snapshots, receipts or product bindings are patched.
"""
from __future__ import annotations

import copy

import pytest

from test_product_service import make_service
from wfd_sdk.duckdb_sdk import canonical
from wfd_sdk.product_bundle import _source_product


def publish_next(service, original, receipt, label, *, coverage=None):
    document = copy.deepcopy(original)
    document["request_identity"]["request_id"] = label
    document["expected_parent_snapshot_id"] = receipt["snapshot_id"]
    output = document["outputs"][0]
    output.update(definition_mode="reuse",
                  definition_ref=receipt["output_results"][0]["definition_ref"],
                  new_definition_declaration=None)
    output["payload"]["rows"][0]["business_key"] = label
    if coverage is not None:
        output["coverage"] = copy.deepcopy(coverage)
    result = service.submit(document)
    assert result["status"] == "published_formal", result
    assert result["output_results"][0]["product_id"] == receipt["output_results"][0]["product_id"]
    return document, result


def bound_products(service, snapshot_id, product_id):
    snapshot = service.engine.read_snapshot(snapshot_id)
    return [entry["source_bundle"]["_wfd_product_bindings"][entry["output_key"]]["product"]
            for entry in snapshot["files"] if entry["product_id"] == product_id]


def test_unchanged_coverage_append_preserves_binding_and_old_snapshot(tmp_path):
    service, document = make_service(tmp_path)
    first = service.submit(document)
    assert first["status"] == "published_formal", first
    product_id = first["output_results"][0]["product_id"]
    original_snapshot = canonical(service.engine.read_snapshot(first["snapshot_id"]))
    _, second = publish_next(service, document, first, "synthetic-second-period")
    products = bound_products(service, second["snapshot_id"], product_id)
    assert len(products) == 2
    assert products[0]["coverage_ref"] == products[1]["coverage_ref"]
    assert all(product["coverage_predecessor_ref"] is None for product in products)
    assert len({canonical(product) for product in products}) == 1
    assert _source_product(service, second["snapshot_id"], product_id)[2] == products[0]
    assert len(service.read(product_id, snapshot_id=first["snapshot_id"])["rows"]) == 1
    assert len(service.read(product_id, snapshot_id=second["snapshot_id"])["rows"]) == 2
    assert canonical(service.engine.read_snapshot(first["snapshot_id"])) == original_snapshot


def test_real_coverage_change_still_advances_lineage_and_rejects_ambiguous_bundle(tmp_path):
    service, document = make_service(tmp_path)
    first = service.submit(document)
    assert first["status"] == "published_formal", first
    product_id = first["output_results"][0]["product_id"]
    initial = bound_products(service, first["snapshot_id"], product_id)[0]
    coverage = copy.deepcopy(document["outputs"][0]["coverage"])
    coverage["scope"] = {"synthetic_scope_revision": "different coverage is not silently merged"}
    _, second = publish_next(service, document, first, "synthetic-new-coverage", coverage=coverage)
    changed = next(product for product in bound_products(service, second["snapshot_id"], product_id)
                   if product["coverage_ref"] != initial["coverage_ref"])
    assert changed["coverage_predecessor_ref"] == initial["coverage_ref"]
    with pytest.raises(ValueError, match="BUNDLE_PRODUCT_VERSION_AMBIGUOUS"):
        _source_product(service, second["snapshot_id"], product_id)


def test_unchanged_append_after_coverage_change_preserves_real_predecessor(tmp_path):
    service, document = make_service(tmp_path)
    first = service.submit(document)
    assert first["status"] == "published_formal", first
    product_id = first["output_results"][0]["product_id"]
    initial = bound_products(service, first["snapshot_id"], product_id)[0]
    coverage = copy.deepcopy(document["outputs"][0]["coverage"])
    coverage["scope"] = {"synthetic_scope_revision": "preserve actual predecessor"}
    second_document, second = publish_next(service, document, first, "synthetic-scope-two", coverage=coverage)
    _, third = publish_next(service, second_document, second, "synthetic-scope-two-next-period")
    products = [product for product in bound_products(service, third["snapshot_id"], product_id)
                if product["coverage_ref"] != initial["coverage_ref"]]
    assert len(products) == 2
    assert all(product["coverage_predecessor_ref"] == initial["coverage_ref"] for product in products)
    assert len({canonical(product) for product in products}) == 1
    with pytest.raises(ValueError, match="BUNDLE_PRODUCT_VERSION_AMBIGUOUS"):
        _source_product(service, third["snapshot_id"], product_id)


@pytest.mark.parametrize("declared_predecessor", [False, True])
def test_actual_coverage_revision_replay_noop_rejection_and_next_revision(tmp_path, declared_predecessor):
    service, document = make_service(tmp_path)
    first = service.submit(document)
    assert first["status"] == "published_formal", first
    product_id = first["output_results"][0]["product_id"]
    initial = service.discover_products(snapshot_id=first["snapshot_id"])["products"][0]
    revision = copy.deepcopy(document)
    revision["request_identity"]["request_id"] = "synthetic-coverage-B"
    revision["expected_parent_snapshot_id"] = first["snapshot_id"]
    output = revision["outputs"][0]
    output.update(input_mode="coverage_revision", definition_mode="reuse",
                  definition_ref=initial["definition_ref"], new_definition_declaration=None,
                  payload={"kind": "metadata_revision"})
    output["coverage"]["scope"] = {"synthetic_revision": "B"}
    if declared_predecessor:
        output["coverage"]["predecessor_ref"] = initial["coverage_ref"]
    second = service.submit(revision)
    assert second["status"] == "published_formal", second
    current = service.discover_products(snapshot_id=second["snapshot_id"])["products"][0]
    assert current["coverage_predecessor_ref"] == initial["coverage_ref"]
    assert service.submit(revision)["snapshot_id"] == second["snapshot_id"], "Original request replay is idempotent"
    snapshots_before = {path.name for path in (service.root / "catalog/snapshots").glob("*.json")}
    commits_before = {path.name for path in (service.root / "catalog/commits").glob("*.json")}
    assert snapshots_before and commits_before, "Nonempty actual publication inventories are required"
    duplicate = copy.deepcopy(revision)
    duplicate["request_identity"]["request_id"] = "synthetic-coverage-B-under-new-id"
    duplicate["expected_parent_snapshot_id"] = second["snapshot_id"]
    rejected = service.submit(duplicate)
    assert rejected["status"] != "published_formal", rejected
    expected = "COVERAGE_PREDECESSOR_MISMATCH" if declared_predecessor else "COVERAGE_REVISION_UNCHANGED"
    assert expected in {error["code"] for item in rejected["output_results"] for error in item.get("errors", [])}, rejected
    assert service.engine.head()["snapshot_id"] == second["snapshot_id"]
    assert {path.name for path in (service.root / "catalog/snapshots").glob("*.json")} == snapshots_before
    assert {path.name for path in (service.root / "catalog/commits").glob("*.json")} == commits_before
    third_document = copy.deepcopy(revision)
    third_document["request_identity"]["request_id"] = "synthetic-coverage-C"
    third_document["expected_parent_snapshot_id"] = second["snapshot_id"]
    third_document["outputs"][0]["coverage"]["scope"] = {"synthetic_revision": "C"}
    third_document["outputs"][0]["coverage"]["predecessor_ref"] = current["coverage_ref"]
    third = service.submit(third_document)
    assert third["status"] == "published_formal", third
    newest = service.discover_products(snapshot_id=third["snapshot_id"])["products"][0]
    assert newest["coverage_predecessor_ref"] == current["coverage_ref"]
    _, appended = publish_next(service, document, third, "synthetic-row-after-coverage-C",
                              coverage=third_document["outputs"][0]["coverage"])
    appended_product = next(product for product in bound_products(service, appended["snapshot_id"], product_id)
                            if product["coverage_ref"] == newest["coverage_ref"])
    assert appended_product["coverage_predecessor_ref"] == current["coverage_ref"]
    assert len(service.engine.read_snapshot(appended["snapshot_id"])["metadata_versions"]) == 2


def test_private_builder_distinguishes_unprovided_baseline_from_explicit_none(tmp_path):
    service, document = make_service(tmp_path)
    first = service.submit(document)
    assert first["status"] == "published_formal", first
    product = copy.deepcopy(service.discover_products(snapshot_id=first["snapshot_id"])["products"][0])
    # Old-form in-memory revision candidate, never written to a stored binding.
    product["coverage_predecessor_ref"] = product["coverage_ref"]
    output = copy.deepcopy(document["outputs"][0])
    output["input_mode"] = "coverage_revision"
    output["payload"] = {"kind": "metadata_revision"}
    output["coverage"]["scope"] = {"synthetic_revision": "private builder compatibility only"}
    output["coverage"]["predecessor_ref"] = product["coverage_ref"]
    args = (output, product, {}, first["snapshot_id"], "synthetic-private-builder", document["source_bundle"])
    # Existing internal callers that omit the keyword retain the previous fallback.
    physical, _ = service._prepare_versions(*args)
    assert physical["_wfd_metadata"]["predecessor_ref"] == product["coverage_ref"]
    # An explicit unknown/absent baseline must not borrow a row's known reference.
    with pytest.raises(ValueError, match="COVERAGE_PREDECESSOR_MISMATCH"):
        service._prepare_versions(*args, prior_coverage_ref=None)
    assert service.engine.head()["snapshot_id"] == first["snapshot_id"]
