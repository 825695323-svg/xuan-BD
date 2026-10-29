"""The actual independent financial closure and one missing-dependency check."""
import copy
import json

import pytest

from test_product_service import make_service
from wfd_sdk.product_bundle import export_financial_bundle, import_financial_bundle


def _source_with_fixed_dependency(tmp_path):
    service, doc = make_service(tmp_path)
    service.allowed_sources["fixture"].update(
        may_export=True, may_export_evidence=True, export_scope="user_local_validation_only")
    reference = service.submit(doc)
    dependency_id = reference["output_results"][0]["product_id"]
    main_doc = copy.deepcopy(doc)
    main_doc["request_identity"]["request_id"] = "bundle_main"
    main_doc["expected_parent_snapshot_id"] = reference["snapshot_id"]
    main = main_doc["outputs"][0]
    main["new_definition_declaration"]["semantic_code"] += "_with_fixed_reference"
    main["payload"]["rows"][0]["business_key"] = "main_record"
    main_doc["source_bundle"]["product_service"] = {
        "version": "wfd.product-service/0.2", "outputs": {main["output_key"]: {
            "read_dependencies": [{"dataset_id": doc["request_identity"]["dataset_id"],
                "product_id": dependency_id, "snapshot_id": reference["snapshot_id"],
                "role": "reference", "required": True}]}}}
    published = service.submit(main_doc)
    assert published["output_results"][0]["publication_state"] == "published_formal"
    return service, published, dependency_id, reference["snapshot_id"]


def test_financial_bundle_reads_without_source_or_activation(tmp_path):
    service, published, dependency_id, dependency_snapshot = _source_with_fixed_dependency(tmp_path)
    pid, sid = published["output_results"][0]["product_id"], published["snapshot_id"]
    expected = [item["row"] for item in service.read(pid, snapshot_id=sid)["rows"]]
    bundle = tmp_path / "bundle"
    descriptor = export_financial_bundle(service, [pid], bundle, snapshot_id=sid)
    assert descriptor["read_dependencies"][0]["product_id"] == dependency_id
    assert descriptor["additional_products"]
    service.root.rename(tmp_path / "source_unavailable")

    target = tmp_path / "independent_store"
    trusted = {source_id: {"may_read": True, "may_read_evidence": True,
                           "usage_scope": "local_use"}
               for source_id in service.allowed_sources}
    imported, report = import_financial_bundle(
        bundle, target, runtime_root=tmp_path / "independent_runtime",
        allowed_sources=trusted)
    target_sid = report["target_snapshot_id"]
    assert target_sid != sid
    assert [item["row"] for item in imported.read(pid, snapshot_id=target_sid)["rows"]] == expected
    assert len(imported.read(dependency_id, snapshot_id=target_sid)["rows"]) == 1
    assert all(e["verified"] for e in imported.trace(pid, snapshot_id=target_sid)["evidence"])
    product = imported.read(pid, snapshot_id=target_sid)["products"][0]
    contract_digest = product["contract_ref"]["digest"].removeprefix("sha256:")
    assert (target / f"catalog/product_service/contracts/{contract_digest}.json").is_file()
    assert report["read_self_contained"] is True
    assert report["write_authority_granted"] is False
    assert imported.engine.state.read()["active_head"] is None
    assert imported.engine.state.read()["imported_head"] == target_sid
    assert imported.allowed_sources and imported.can_register is False
    assert all(policy["usage_scope"] == "local_use" for policy in imported.allowed_sources.values())


def test_missing_fixed_dependency_cannot_be_imported_as_complete(tmp_path):
    service, published, _, dependency_snapshot = _source_with_fixed_dependency(tmp_path)
    pid, sid = published["output_results"][0]["product_id"], published["snapshot_id"]
    bundle = tmp_path / "bundle"
    descriptor = export_financial_bundle(service, [pid], bundle, snapshot_id=sid)
    package = bundle / descriptor["storage_packages"][0]["directory"]
    inventory = json.loads((package / "inventory.json").read_text())
    victim = next(obj for obj in inventory["objects"]
                  if any(rel.startswith(("foundation/", "observations/", "events/"))
                         for rel in obj["rel_paths"]))
    (package / "objects" / victim["sha256"]).unlink()
    target = tmp_path / "incomplete_target"
    with pytest.raises(ValueError, match="BUNDLE_INTEGRITY_FAILED"):
        import_financial_bundle(
            bundle, target, runtime_root=tmp_path / "runtime_target",
            allowed_sources={source_id: {"may_read": True, "may_read_evidence": True,
                                         "usage_scope": "local_use"}
                             for source_id in service.allowed_sources})
    assert not target.exists()


def test_bundle_checks_all_source_ids_and_redistribution_role(tmp_path):
    service, doc = make_service(tmp_path)
    service.allowed_sources["restricted"] = {
        "may_submit": True, "may_publish_formal": True, "may_read": True,
        "may_export": False, "may_export_evidence": False,
        "usage_scope": "restricted_test", "may_redistribute": False,
        "allowed_roles": ["deliverer"],
    }
    doc["source_bundle"]["source_ids"] = ["fixture", "restricted"]
    doc["source_bundle"]["source_roles"] = {
        doc["outputs"][0]["output_key"]: [
            {"source_id": "fixture", "roles": ["definer"]},
            {"source_id": "restricted", "roles": ["deliverer"]},
        ]}
    result = service.submit(doc)
    assert result["status"] == "published_formal"
    pid, sid = result["output_results"][0]["product_id"], result["snapshot_id"]
    with pytest.raises(ValueError, match="BUNDLE_EXPORT_PERMISSION_MISSING:restricted"):
        export_financial_bundle(service, [pid], tmp_path / "restricted-bundle", snapshot_id=sid)

    # Even when both sources are exportable, redistribution needs the caller
    # role and every source's explicit redistribution grant.
    service.allowed_sources["fixture"]["may_redistribute"] = True
    service.allowed_sources["restricted"].update(
        may_export=True, may_export_evidence=True, export_scope="restricted_user_local")
    service.allowed_sources["restricted"]["may_redistribute"] = False
    with pytest.raises(ValueError, match="BUNDLE_REDISTRIBUTION_PERMISSION_MISSING:restricted"):
        export_financial_bundle(service, [pid], tmp_path / "redistribute-bundle",
                                snapshot_id=sid, redistribution_requested=True)
