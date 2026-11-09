"""F09-02: full current product views, distinct from selected-ref paging."""
from __future__ import annotations

import base64
import copy
import json
import shutil
from types import SimpleNamespace

import pytest

from test_fixed_read_pages import inventory, machine_call, refs_of, seed
from test_product_service import HERE
from test_r1_data_only import NAMESPACE, UNITS, make_data_service, request, scalar_output
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, canonical, sha
from wfd_sdk.product_data_service import WFDDataOnlyService


FORMAT = "wfd.fixed-product-page/1"


def ordered(refs):
    return sorted(refs, key=lambda item: (item["record_id"].encode("utf-8"),
                                         item["record_version"].encode("utf-8")))


def test_full_product_page_complete_view_public_contracts_and_replay(tmp_path, monkeypatch):
    service, sid, pid, refs = seed(tmp_path)
    original = service.read(pid, snapshot_id=sid)
    expected = {row["record_id"]: row for row in original["rows"]}
    # Before implementation this preserves actual old selected-page cursors
    # and complete public responses, for a post-change interoperability probe.
    old_first = service.read_page(pid, snapshot_id=sid, record_refs=refs, page_size=2)
    old_second = service.read_page(pid, snapshot_id=sid, record_refs=refs, page_size=2,
                                   cursor=old_first["pagination"]["next_cursor"])
    (tmp_path / "selected-compat-oracle.json").write_text(json.dumps({
        "store": str(service.root.resolve()), "snapshot_id": sid, "product_id": pid,
        "record_refs": refs, "page_size": 2, "unit_registry": service.unit_registry,
        "pages": [old_first, old_second],
    }, ensure_ascii=False, indent=2), "utf-8")
    before = inventory(service.root)

    def forbidden(*args, **kwargs):
        raise AssertionError("Full-product pages must not call any full reader or public selected-page API")

    for name in ("read", "_read", "read_page"):
        monkeypatch.setattr(service, name, forbidden)
    for name in ("read_snapshot", "read_product"):
        monkeypatch.setattr(service.engine, name, forbidden)
    import wfd_sdk.duckdb_storage as storage
    monkeypatch.setattr(storage, "rows_from_parquet", forbidden)

    view = ordered(refs)
    view_digest = "sha256:" + sha(canonical(view))
    query_digest = "sha256:" + sha(canonical({
        "format_version": FORMAT, "profile": "data_only", "read_scope": "full_product",
        "snapshot_id": sid, "product_id": pid, "view_digest": view_digest,
        "page_size": 2, "max_page_bytes": 1048576,
        "perspective": "snapshot_contents", "include_history": False,
    }))
    rows, cursor = [], None
    while True:
        page = service.read_product_page(pid, snapshot_id=sid, page_size=2, cursor=cursor)
        assert service.read_product_page(pid, snapshot_id=sid, page_size=2, cursor=cursor) == page
        assert page["read_scope"] == "full_product" and page["profile"] == "data_only"
        assert (page["snapshot_id"], page["product_id"], page["dataset_id"]) == (sid, pid, "wfd_r1_local")
        assert page["pagination"]["format_version"] == FORMAT
        assert page["pagination"]["total_rows"] == 5
        assert "selection_count" not in page["pagination"]
        assert "selection_digest" not in page["integrity"]
        assert page["integrity"]["view_digest"] == view_digest
        assert page["integrity"]["query_digest"] == query_digest
        assert page["integrity"]["page_digest"] == "sha256:" + sha(canonical(refs_of(page["rows"])))
        assert 0 < len(page["rows"]) <= 2 and len(canonical(page)) <= 1048576
        for row in page["rows"]:
            assert row == expected[row["record_id"]]
            product = next(item for item in page["products"] if item["contract_ref"] == row["contract_ref"])
            prior = next(item for item in original["products"] if item["contract_ref"] == row["contract_ref"])
            assert product == {key: value for key, value in prior.items() if key != "content_digest"}
            projection = next(item for item in page["public_projection"]["contract_projections"]
                              if item["original_contract_ref"] == product["contract_ref"])
            assert projection["projection_digest"] == "sha256:" + sha(canonical(product))
            assert "content_digest" not in product
        rows.extend(page["rows"])
        cursor = page["pagination"]["next_cursor"]
        assert bool(cursor) == page["pagination"]["has_more"]
        if cursor is None:
            break
    assert refs_of(rows) == view
    snapshot = service.engine._valid_snapshot_exact(sid, verify_payloads=False)
    assert page["integrity"]["manifest_digest"] == "sha256:" + sha(
        (service.root / snapshot["manifest_relpath"]).read_bytes())
    assert inventory(service.root) == before


def reopen(service, runtime, *, roles=("read",)):
    assert not runtime.exists()
    engine = WFDDuckDBPrototype.open_existing(
        service.root, service.engine.validator, runtime_root=runtime, sandbox=False, read_only=True)
    return WFDDataOnlyService(engine, caller_roles=roles, caller_id="r1-test",
                              unit_registry=UNITS, trusted_actor_namespaces={NAMESPACE})


def decode_cursor(cursor):
    return json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))


def encode_cursor(body):
    return base64.urlsafe_b64encode(canonical({
        "body": body, "digest": "sha256:" + sha(canonical(body)),
    })).decode("ascii").rstrip("=")


def walk(service, sid, pid, **kwargs):
    rows, pages, cursors = [], [], set()
    cursor = None
    while True:
        page = service.read_product_page(pid, snapshot_id=sid, cursor=cursor, **kwargs)
        pages.append(page)
        rows.extend(page["rows"])
        assert len(rows) <= page["pagination"]["total_rows"]
        assert len({(item["record_id"], item["record_version"]) for item in rows}) == len(rows)
        cursor = page["pagination"]["next_cursor"]
        assert bool(cursor) is page["pagination"]["has_more"]
        if cursor is None:
            assert len(rows) == page["pagination"]["total_rows"]
            break
        assert page["rows"] and cursor not in cursors
        cursors.add(cursor)
    return rows, pages


def revise(service, sid, pid, keys, mode, request_id):
    current = {row["record_id"]: row for row in service.read(pid, snapshot_id=sid)["rows"]}
    output = scalar_output("metric", "f09.fixed-page", "100")
    output.update(definition_mode="reuse", definition_ref=current[keys[0]]["definition_ref"],
                  definition=None, input_mode=mode)
    output["payload"]["rows"] = [copy.deepcopy(current[key]["row"]) for key in keys]
    if mode != "withdrawal":
        for index, row in enumerate(output["payload"]["rows"]):
            row["value_decimal"] = str(100 + index)
    output["revisions"] = {key: {"previous": current[key]["record_ref"],
                                  "reason": "owned synthetic full-view test"} for key in keys}
    receipt = service.submit(request([output], request_id, parent=sid))
    assert receipt["state"] == "published_formal", receipt
    return receipt


def test_full_page_exact_values_and_limits_fail_closed(tmp_path):
    service, sid, pid, _ = seed(tmp_path)
    base = {"product_id": pid, "snapshot_id": sid}
    variants = [
        ({"snapshot_id": None}, "PAGE_SNAPSHOT_INVALID"),
        ({"snapshot_id": "current"}, "PAGE_SNAPSHOT_INVALID"),
        ({"snapshot_id": "s_" + "A" * 24}, "PAGE_SNAPSHOT_INVALID"),
        ({"product_id": "latest"}, "PAGE_PRODUCT_INVALID"),
        ({"product_id": None}, "PAGE_PRODUCT_INVALID"),
        ({"page_size": True}, "PAGE_SIZE_INVALID"),
        ({"page_size": 0}, "PAGE_SIZE_INVALID"),
        ({"page_size": 1001}, "PAGE_SIZE_INVALID"),
        ({"page_size": 2.0}, "PAGE_SIZE_INVALID"),
        ({"max_page_bytes": False}, "PAGE_BYTES_INVALID"),
        ({"max_page_bytes": 0}, "PAGE_BYTES_INVALID"),
        ({"max_page_bytes": 4194305}, "PAGE_BYTES_INVALID"),
        ({"max_page_bytes": "1024"}, "PAGE_BYTES_INVALID"),
        ({"cursor": ""}, "PAGE_CURSOR_INVALID"),
        ({"cursor": "!!!"}, "PAGE_CURSOR_INVALID"),
        ({"cursor": True}, "PAGE_CURSOR_INVALID"),
        ({"cursor": {}}, "PAGE_CURSOR_INVALID"),
    ]
    before = inventory(service.root)
    for changes, code in variants:
        with pytest.raises(ValueError, match=code):
            service.read_product_page(**{**base, **changes})
    with pytest.raises(ValueError, match="PAGE_PRODUCT_NOT_FOUND"):
        service.read_product_page("p_" + "0" * 24, snapshot_id=sid)
    with pytest.raises(ValueError, match="PAGE_METADATA_TOO_LARGE|PAGE_ITEM_TOO_LARGE"):
        service.read_product_page(pid, snapshot_id=sid, max_page_bytes=1)
    assert inventory(service.root) == before


@pytest.mark.parametrize("extra", [
    {"record_refs": []}, {"include_history": False}, {"perspective": "snapshot_contents"},
    {"at": None}, {"subject": None}, {"fields": []}, {"read_dependencies": []},
    {"row_projection": "full"}, {"verify_contract_files": False},
    {"store": "/untrusted/store"}, {"profile": "data_only"},
    {"_machine_result_fields": {}}, {"_result_budget": 4194304},
])
def test_full_machine_rejects_every_extra_argument_even_false_or_null(tmp_path, extra):
    service, sid, pid, _ = seed(tmp_path)
    before = inventory(service.root)
    response = machine_call(tmp_path, service, "fixed_read_product_page", {
        "snapshot_id": sid, "product_id": pid, **extra})
    assert response["ok"] is False and response["error"]["code"] == "REQUEST_INVALID", response
    assert inventory(service.root) == before


@pytest.mark.parametrize("missing", ["snapshot_id", "product_id"])
def test_full_machine_requires_both_fixed_identities(tmp_path, missing):
    service, sid, pid, _ = seed(tmp_path)
    arguments = {"snapshot_id": sid, "product_id": pid}
    del arguments[missing]
    response = machine_call(tmp_path, service, "fixed_read_product_page", arguments)
    assert response["ok"] is False and response["error"]["code"] == "REQUEST_INVALID", response


def test_full_machine_capabilities_projection_complete_budget_and_legacy_profile(tmp_path):
    service, sid, pid, refs = seed(tmp_path)
    before = inventory(service.root)
    caps = machine_call(tmp_path, service, "capabilities", {})["result"]
    advertised = caps["operations"]["fixed_read_product_page"]
    assert advertised["supported"] is True and advertised["format_version"] == FORMAT
    assert advertised["read_scope"] == "full_product" and "selection_limit" not in advertised
    assert advertised["include_history"] is False
    assert advertised["page_size"] == {"default": 256, "max": 1000}
    assert advertised["max_page_bytes"]["default"] == 1048576
    assert advertised["max_page_bytes"]["max"] == 4194304
    assert advertised["calendar_qualification"]["supported"] is False
    assert caps["operations"]["fixed_read_page"]["selection_limit"] == 5000
    assert caps["limits"]["max_request_bytes"] == 1048576
    assert caps["limits"]["max_response_bytes"] == 33554432
    assert caps["process"]["read_only"] is True
    args = {"snapshot_id": sid, "product_id": pid}
    response = machine_call(tmp_path, service, "fixed_read_product_page", args)
    assert response["ok"] is True, response
    full = response["result"]
    assert full["row_count"] == len(refs) and full["row_projection"] == "full"
    assert full["service_identity"] and full["row_projection_note"]
    assert full["pagination"]["page_size"] == 256 and len(canonical(full)) <= 1048576
    budget = len(canonical(full)) - 500
    bounded = machine_call(tmp_path, service, "fixed_read_product_page", {**args, "max_page_bytes": budget})
    assert bounded["ok"] is True, bounded
    result = bounded["result"]
    assert 0 < result["row_count"] < len(refs)
    assert result["pagination"]["has_more"] is True and result["pagination"]["next_cursor"]
    assert len(canonical(result)) <= budget
    expected = {row["record_id"]: row for row in full["rows"]}
    assert all(row == expected[row["record_id"]] for row in result["rows"])
    legacy = machine_call(tmp_path, service, "capabilities", {}, profile="legacy")["result"]
    assert "fixed_read_product_page" not in legacy["operations"]
    rejected = machine_call(tmp_path, service, "fixed_read_product_page", args, profile="legacy")
    assert rejected["ok"] is False and rejected["error"]["code"] == "OPERATION_UNSUPPORTED", rejected
    old = machine_call(tmp_path, service, "fixed_read", args)
    assert old["ok"] is True and old["result"]["row_count"] == len(refs)
    assert all(row == expected[row["record_id"]] for row in old["result"]["rows"])
    assert inventory(service.root) == before


def test_full_budget_whole_rows_internal_metadata_and_first_item_errors(tmp_path):
    service, sid, pid, refs = seed(tmp_path)
    full = service.read_product_page(pid, snapshot_id=sid)
    budget = len(canonical(full)) - 500
    page = service.read_product_page(pid, snapshot_id=sid, max_page_bytes=budget)
    assert 0 < len(page["rows"]) < len(refs) and len(canonical(page)) <= budget
    assert page["pagination"]["next_cursor"]
    with pytest.raises(ValueError, match="PAGE_METADATA_TOO_LARGE"):
        service.read_product_page(pid, snapshot_id=sid, _result_budget=1)
    with pytest.raises(ValueError, match="PAGE_METADATA_TOO_LARGE"):
        service.read_product_page(pid, snapshot_id=sid, max_page_bytes=65536,
                                  _machine_result_fields={"row_projection_note": "x" * 65536})
    with pytest.raises(ValueError, match="PAGE_RESULT_METADATA_INVALID"):
        service.read_product_page(pid, snapshot_id=sid, _machine_result_fields={"rows": []})
    big = make_data_service(tmp_path / "big")
    output = scalar_output("metric", "f09.full-big-key", "1")
    output["payload"]["rows"][0]["business_key"] = "large-" + "x" * 10000
    receipt = big.submit(request([output], "full-big-key"))
    assert receipt["state"] == "published_formal", receipt
    before = inventory(big.root)
    with pytest.raises(ValueError, match="PAGE_ITEM_TOO_LARGE"):
        big.read_product_page(receipt["output_results"][0]["product_id"],
                              snapshot_id=receipt["snapshot_id"], max_page_bytes=4096)
    assert inventory(big.root) == before


def test_full_cursors_domain_query_store_binding_and_cold_resume(tmp_path):
    service, sid, pid, refs = seed(tmp_path)
    base = {"snapshot_id": sid, "page_size": 2}
    first = service.read_product_page(pid, **base)
    cursor = first["pagination"]["next_cursor"]
    expected_next = service.read_product_page(pid, cursor=cursor, **base)
    old = service.read_page(pid, record_refs=refs, **base)
    with pytest.raises(ValueError, match="PAGE_CURSOR_INVALID"):
        service.read_page(pid, record_refs=refs, cursor=cursor, **base)
    with pytest.raises(ValueError, match="PAGE_CURSOR_INVALID"):
        service.read_product_page(pid, cursor=old["pagination"]["next_cursor"], **base)
    for changes in ({"page_size": 3}, {"max_page_bytes": 1048575}):
        with pytest.raises(ValueError, match="PAGE_CURSOR_INVALID"):
            service.read_product_page(pid, cursor=cursor, **{**base, **changes})
    snapshot = service.engine._valid_snapshot_exact(sid, verify_payloads=False)
    other_pid = next(entry["product_id"] for entry in snapshot["files"] if entry["product_id"] != pid)
    with pytest.raises(ValueError, match="PAGE_CURSOR_INVALID"):
        service.read_product_page(other_pid, cursor=cursor, **base)
    token = decode_cursor(cursor)
    assert token["body"]["format_version"] == FORMAT
    assert token["body"]["read_scope"] == "full_product" and "selection_digest" not in token["body"]
    for key, value in (("profile", "legacy"), ("read_scope", "selected"),
                       ("view_digest", "sha256:" + "0" * 64), ("order", "reversed"),
                       ("after", ordered(refs)[-1])):
        body = {**token["body"], key: value}
        with pytest.raises(ValueError, match="PAGE_CURSOR_INVALID"):
            service.read_product_page(pid, cursor=encode_cursor(body), **base)
    broken = copy.deepcopy(token)
    broken["body"]["after"] = ordered(refs)[0]
    bad_checksum = base64.urlsafe_b64encode(canonical(broken)).decode("ascii").rstrip("=")
    with pytest.raises(ValueError, match="PAGE_CURSOR_INVALID"):
        service.read_product_page(pid, cursor=bad_checksum, **base)
    reader = reopen(service, tmp_path / "cold-runtime")
    assert reader.read_product_page(pid, cursor=cursor, **base) == expected_next
    assert not (tmp_path / "cold-runtime").exists()
    # A test-only clone of this owned synthetic store isolates root binding:
    # immutable snapshot/product/query are identical; only the resolved root differs.
    clone_root = tmp_path / "owned-clone"
    assert not clone_root.exists()
    shutil.copytree(service.root, clone_root)
    clone_engine = WFDDuckDBPrototype.open_existing(
        clone_root, service.engine.validator, runtime_root=tmp_path / "clone-runtime", read_only=True)
    clone = WFDDataOnlyService(clone_engine, caller_roles={"read"}, unit_registry=UNITS)
    assert clone.read_product_page(pid, **base)["integrity"] == first["integrity"]
    with pytest.raises(ValueError, match="PAGE_CURSOR_INVALID"):
        clone.read_product_page(pid, cursor=cursor, **base)
    advanced = service.submit(request([scalar_output("next", "f09.full-advance", "3")],
                                      "full-head-advance", parent=sid))
    assert advanced["state"] == "published_formal", advanced
    assert reader.read_product_page(pid, cursor=cursor, **base) == expected_next
    with pytest.raises(ValueError, match="PAGE_CURSOR_INVALID"):
        reader.read_product_page(pid, cursor=cursor, **{**base, "snapshot_id": advanced["snapshot_id"]})
    assert not (tmp_path / "clone-runtime").exists()


def test_full_cursor_checksum_never_grants_permission_and_each_page_is_readonly(tmp_path):
    service, sid, pid, _ = seed(tmp_path)
    reader = reopen(service, tmp_path / "readonly-runtime")
    first = reader.read_product_page(pid, snapshot_id=sid, page_size=1)
    body = decode_cursor(first["pagination"]["next_cursor"])["body"]
    cursor = encode_cursor(body)  # Public checksum can be recomputed; it is not an authorization secret.
    before = inventory(service.root)
    reader.caller_roles = frozenset()
    with pytest.raises(PermissionError, match="CALLER_PERMISSION_DENIED"):
        reader.read_product_page(pid, snapshot_id=sid, page_size=1, cursor=cursor)
    denied = machine_call(tmp_path, service, "fixed_read_product_page", {
        "snapshot_id": sid, "product_id": pid, "page_size": 1, "cursor": cursor}, roles=())
    assert denied["ok"] is False and denied["error"]["code"] == "CALLER_PERMISSION_DENIED", denied
    assert inventory(service.root) == before and not (tmp_path / "readonly-runtime").exists()


def test_full_view_corrected_multi_part_withdrawn_leaf_count_and_old_snapshot(tmp_path):
    service, sid, pid, refs = seed(tmp_path)
    original = service.read(pid, snapshot_id=sid)
    old_page = service.read_product_page(pid, snapshot_id=sid, page_size=2)
    correction = revise(service, sid, pid, ["a", "z"], "source_correction", "full-correction")
    corrected_sid = correction["snapshot_id"]
    withdrawal = revise(service, corrected_sid, pid, ["é"], "withdrawal", "full-withdraw-one")
    current_sid = withdrawal["snapshot_id"]
    oracle = service.read(pid, snapshot_id=current_sid)
    expected = {row["record_id"]: row for row in oracle["rows"]}
    rows, pages = walk(service, current_sid, pid, page_size=1)
    assert set(expected) == {"a", "z", "\ue000", "\U00010000"}
    assert all(row == expected[row["record_id"]] for row in rows)
    assert all(page["pagination"]["total_rows"] == 4 for page in pages)
    assert {row["record_id"]: row["row"]["value_decimal"] for row in rows} == {
        "a": "100", "z": "101", "\ue000": "3", "\U00010000": "3"}
    superseded = {ref["record_version"] for ref in refs if ref["record_id"] in {"a", "z", "é"}}
    assert all(row["record_version"] not in superseded for row in rows)
    assert service.read_product_page(pid, snapshot_id=sid, page_size=2) == old_page
    assert service.read(pid, snapshot_id=sid) == original
    (tmp_path / "correction-withdrawal-receipts.json").write_text(json.dumps(
        [correction, withdrawal], ensure_ascii=False, indent=2), "utf-8")


def test_full_all_withdrawn_has_one_empty_terminal_page_and_intact_products(tmp_path):
    service, sid, pid, refs = seed(tmp_path)
    prior = service.read_product_page(pid, snapshot_id=sid, page_size=1)
    withdrawal = revise(service, sid, pid, [ref["record_id"] for ref in ordered(refs)],
                        "withdrawal", "full-withdraw-all")
    empty_sid = withdrawal["snapshot_id"]
    before = inventory(service.root)
    empty = service.read_product_page(pid, snapshot_id=empty_sid, page_size=1)
    assert empty["rows"] == [] and empty["row_count"] == 0 and empty["products"]
    assert empty["product_count"] == len(empty["products"])
    assert empty["pagination"] == {"format_version": FORMAT, "page_size": 1,
                                  "max_page_bytes": 1048576, "returned_rows": 0,
                                  "total_rows": 0, "has_more": False, "next_cursor": None}
    empty_digest = "sha256:" + sha(canonical([]))
    assert empty["integrity"]["view_digest"] == empty["integrity"]["page_digest"] == empty_digest
    assert empty["products"][0]["contracts"] == prior["products"][0]["contracts"]
    assert empty["products"][0]["contract_refs"] == prior["products"][0]["contract_refs"]
    assert service.read_product_page(pid, snapshot_id=empty_sid, page_size=1) == empty
    with pytest.raises(ValueError, match="PAGE_CURSOR_INVALID"):
        service.read_product_page(pid, snapshot_id=empty_sid, page_size=1,
                                  cursor=prior["pagination"]["next_cursor"])
    body = decode_cursor(prior["pagination"]["next_cursor"])["body"]
    body.update(snapshot_id=empty_sid, manifest_digest=empty["integrity"]["manifest_digest"],
                view_digest=empty_digest, query_digest=empty["integrity"]["query_digest"])
    with pytest.raises(ValueError, match="PAGE_CURSOR_INVALID"):
        service.read_product_page(pid, snapshot_id=empty_sid, page_size=1, cursor=encode_cursor(body))
    with pytest.raises(ValueError, match="PAGE_METADATA_TOO_LARGE"):
        service.read_product_page(pid, snapshot_id=empty_sid, max_page_bytes=1)
    result = machine_call(tmp_path, service, "fixed_read_product_page", {
        "snapshot_id": empty_sid, "product_id": pid})
    assert result["ok"] is True and result["result"]["products"] and result["result"]["row_count"] == 0, result
    assert result["result"]["pagination"]["next_cursor"] is None
    assert inventory(service.root) == before


def candidate(service, sid):
    """Unit-only metadata candidate; never overwrite a manifest, snapshot or receipt."""
    return copy.deepcopy(service.engine._valid_snapshot_exact(sid, verify_payloads=False))


def use_candidate(monkeypatch, service, sid, snapshot):
    def fixed(requested, **kwargs):
        assert requested == sid and kwargs.get("verify_payloads") is False
        return copy.deepcopy(snapshot)
    monkeypatch.setattr(service.engine, "_valid_snapshot_exact", fixed)


def test_full_view_fork_on_later_key_rejects_before_any_payload_page(tmp_path, monkeypatch):
    import wfd_sdk.product_data_service as data_module
    service, sid, pid, _ = seed(tmp_path)
    snapshot = candidate(service, sid)
    entry = [entry for entry in snapshot["files"] if entry["product_id"] == pid][-1]
    versions = entry["source_bundle"]["_wfd_row_versions"][entry["output_key"]]
    late = next(version for version in versions.values() if version["logical_key"] == "\U00010000")
    versions["unit-only-fork-key"] = {**late, "revision_id": "r_unit_only_fork", "supersedes": None}
    entry["row_count"] += 1
    use_candidate(monkeypatch, service, sid, snapshot)
    def forbidden(*args, **kwargs):
        raise AssertionError("A fork anywhere must reject before SQL/business payload materialization")
    monkeypatch.setattr(data_module, "selected_rows_page", forbidden)
    before = inventory(service.root)
    with pytest.raises(ValueError, match="PAGE_VIEW_BRANCH_CONFLICT"):
        service.read_product_page(pid, snapshot_id=sid, page_size=1)
    assert inventory(service.root) == before


@pytest.mark.parametrize("field,value", [
    ("logical_key", ""), ("logical_key", "bad\x00key"),
    ("revision_id", ""), ("revision_id", "bad\x00revision"),
    ("supersedes", ""), ("supersedes", "bad\x00previous"),
    ("withdrawn", "false"),
])
def test_full_view_validates_all_metadata_identities_before_page(tmp_path, monkeypatch, field, value):
    import wfd_sdk.product_data_service as data_module
    service, sid, pid, _ = seed(tmp_path)
    snapshot = candidate(service, sid)
    entry = [entry for entry in snapshot["files"] if entry["product_id"] == pid][-1]
    versions = entry["source_bundle"]["_wfd_row_versions"][entry["output_key"]]
    late = next(version for version in versions.values() if version["logical_key"] == "\U00010000")
    late[field] = value
    use_candidate(monkeypatch, service, sid, snapshot)
    def forbidden(*args, **kwargs):
        raise AssertionError("Malformed late-key version metadata must reject before fetching any row")
    monkeypatch.setattr(data_module, "selected_rows_page", forbidden)
    before = inventory(service.root)
    with pytest.raises(ValueError, match="PAGE_VERSION_METADATA_INVALID"):
        service.read_product_page(pid, snapshot_id=sid, page_size=1)
    assert inventory(service.root) == before


def test_full_view_missing_late_leaf_is_not_silently_omitted(tmp_path, monkeypatch):
    service, sid, pid, _ = seed(tmp_path)
    snapshot = candidate(service, sid)
    entry = [entry for entry in snapshot["files"] if entry["product_id"] == pid][-1]
    versions = entry["source_bundle"]["_wfd_row_versions"][entry["output_key"]]
    key = next(key for key, version in versions.items() if version["logical_key"] == "\U00010000")
    versions["unit-only-missing-physical-row"] = versions.pop(key)
    use_candidate(monkeypatch, service, sid, snapshot)
    with pytest.raises(ValueError, match="PAGE_RECORD_MATERIALIZATION_MISMATCH"):
        service.read_product_page(pid, snapshot_id=sid, page_size=1)


@pytest.mark.parametrize("copies", [0, 2])
def test_sql_visible_identity_must_materialize_exactly_once(tmp_path, copies):
    from wfd_sdk.duckdb_storage import parquet_from_rows, selected_rows_page
    # Standalone SQL unit fixture, not a published snapshot or synthetic success receipt.
    subject = {"kind": "physical_object", "namespace": "wfd.local", "id": "object_1"}
    pid = "p_" + "1" * 24
    row = scalar_output("metric", "unit.sql-materialization", "1")["payload"]["rows"][0]
    row["business_key"] = "physical-key" if copies else "different-key"
    path = tmp_path / "sql-unit.parquet"
    path.write_bytes(parquet_from_rows(pid, "metric", subject, "scalar_rows", [copy.deepcopy(row)] * max(1, copies)))
    parts = [{"path": path, "product_id": pid, "output_key": "metric"}]
    selected = [{"position": 1, "part_index": 0, "physical_key": "physical-key"}]
    with pytest.raises(ValueError, match="PAGE_RECORD_MATERIALIZATION_MISMATCH"):
        selected_rows_page(parts, selected, after_position=0, row_limit=2, max_row_bytes=1048576)


@pytest.mark.parametrize("target", ["payload", "contract", "contract_bundle", "manifest", "definition"])
def test_full_continuation_rechecks_all_target_integrity(tmp_path, monkeypatch, target):
    service, sid, pid, _ = seed(tmp_path)
    cursor = service.read_product_page(pid, snapshot_id=sid, page_size=1)["pagination"]["next_cursor"]
    snapshot = candidate(service, sid)
    entries = [entry for entry in snapshot["files"] if entry["product_id"] == pid]
    product = entries[-1]["source_bundle"]["_wfd_product_bindings"][entries[-1]["output_key"]]["product"]
    if target == "definition":
        # Definition proof is the immutable binding's complete declaration hash.
        product["declaration"]["semantic_code"] = "unit-only-wrong-definition"
        use_candidate(monkeypatch, service, sid, snapshot)
    else:
        if target == "payload":
            artifact = service.root / entries[-1]["file_relpath"]
        elif target == "contract":
            digest = product["contract_refs"]["semantic"]["digest"].removeprefix("sha256:")
            artifact = service.root / "catalog/product_service/contracts/semantic" / (digest + ".json")
        elif target == "contract_bundle":
            digest = product["contract_bundle_ref"]["digest"].removeprefix("sha256:")
            artifact = service.root / "catalog/product_service/contract_bundles" / (digest + ".json")
        else:
            artifact = service.root / snapshot["manifest_relpath"]
        # Deliberately retain the corrupted owned fixture for inspection; never repair/retry it.
        artifact.write_bytes(artifact.read_bytes() + b" ")
    with pytest.raises(ValueError, match="CHECKSUM_MISMATCH|CONTRACT_|DEFINITION_DIGEST_MISMATCH|SNAPSHOT_UNAVAILABLE_OR_INVALID"):
        service.read_product_page(pid, snapshot_id=sid, page_size=1, cursor=cursor)


def test_full_page_calendar_non_scalar_and_other_read_dependencies_never_fallback(tmp_path, monkeypatch):
    from test_p4b_precise_hydration import MARKET, _calendar_ref, _day, _trading_calendar
    service = make_data_service(tmp_path)
    calendar = service.submit(request([_trading_calendar("calendar", ["2025-01-02"])], "full-calendar"))
    assert calendar["state"] == "published_formal", calendar
    cal_pid, cal_sid = calendar["output_results"][0]["product_id"], calendar["snapshot_id"]
    output = scalar_output("metric", "f09.full-calendar-dependent", "7")
    output["subject"] = copy.deepcopy(MARKET)
    output["definition"]["semantic_context"]["time"] = {
        "period_type": "trading", "frequency": "day", "interval": "closed",
        "timezone": "Asia/Shanghai", "calendar_ref": _calendar_ref(service, cal_pid, cal_sid)}
    output["payload"]["rows"][0]["observation_time"] = _day("2025-01-02")
    receipt = service.submit(request([output], "full-calendar-dependent", parent=cal_sid))
    assert receipt["state"] == "published_formal", receipt
    pid, sid = receipt["output_results"][0]["product_id"], receipt["snapshot_id"]
    def forbidden(*args, **kwargs):
        raise AssertionError("Unsupported scope must not invoke a full reader or dependency closure")
    with monkeypatch.context() as gates:
        gates.setattr(service, "_read", forbidden)
        gates.setattr(service, "read_page", forbidden)
        gates.setattr(service.engine, "read_snapshot", forbidden)
        with pytest.raises(ValueError, match="PAGED_READ_CALENDAR_UNSUPPORTED"):
            service.read_product_page(pid, snapshot_id=sid)
        with pytest.raises(ValueError, match="PAGED_READ_PRODUCT_UNSUPPORTED"):
            service.read_product_page(cal_pid, snapshot_id=cal_sid)
    # A correctly bound generic dependency is an explicit unit metadata candidate:
    # no immutable manifest, snapshot or formal receipt is forged or rewritten.
    plain, plain_sid, plain_pid, _ = seed(tmp_path / "plain")
    snapshot = candidate(plain, plain_sid)
    entry = next(entry for entry in snapshot["files"] if entry["product_id"] == plain_pid)
    original = entry["source_bundle"]["_wfd_product_bindings"][entry["output_key"]]["product"]
    other_pid = next(entry["product_id"] for entry in snapshot["files"] if entry["product_id"] != plain_pid)
    bound = plain._bind_contract(original, {"_wfd_data_only": True, "read_dependencies": [{
        "dataset_id": original["dataset_id"], "product_id": other_pid,
        "snapshot_id": plain_sid, "role": "unit-only-required-dependency", "required": True}]})
    entry["source_bundle"]["_wfd_product_bindings"][entry["output_key"]]["product"] = bound
    use_candidate(monkeypatch, plain, plain_sid, snapshot)
    monkeypatch.setattr(plain, "_check_dependencies", forbidden)
    monkeypatch.setattr(plain, "_read", forbidden)
    with pytest.raises(ValueError, match="PAGED_READ_DEPENDENCY_UNSUPPORTED"):
        plain.read_product_page(plain_pid, snapshot_id=plain_sid)


def test_full_volume_explicit_forwarding_rechecks_uuid_and_revoked_role(tmp_path):
    from test_r2a_volume_publication import FakeDetector, VOL_UUID
    from wfd_sdk.product_volume_service import WFDVolumeService
    from wfd_sdk.volume_publication import VolumeBinding, VolumeError
    service, sid, pid, _ = seed(tmp_path)
    volume = WFDVolumeService(
        binding=VolumeBinding(mount_point=str(service.root), volume_uuid=VOL_UUID,
                              filesystem="exfat", writer_host="r1-test", writer_epoch=0),
        runtime_root=tmp_path / "volume-runtime", protocol_root=HERE / "protocol",
        caller_roles=("read",), unit_registry=UNITS, trusted_actor_namespaces={NAMESPACE},
        detector=FakeDetector())
    before = inventory(service.root)
    caps = volume.capabilities()
    assert caps["operations"]["fixed_read_product_page"]["format_version"] == FORMAT
    assert "fixed_read_product_page" in caps["volume"]["operations"]
    first = volume.read_product_page(pid, snapshot_id=sid, page_size=1)
    cursor = first["pagination"]["next_cursor"]
    assert volume.engine.read_only is True
    volume.caller_roles.clear()
    with pytest.raises(PermissionError, match="CALLER_PERMISSION_DENIED"):
        volume.read_product_page(pid, snapshot_id=sid, page_size=1, cursor=cursor)
    volume.caller_roles.add("read")
    volume.binding = VolumeBinding(mount_point=str(service.root), volume_uuid="00000000-0000-0000-0000-000000000000",
                                   filesystem="exfat", writer_host="r1-test", writer_epoch=0)
    with pytest.raises(VolumeError, match="STORAGE_TIER_UNAVAILABLE"):
        volume.read_product_page(pid, snapshot_id=sid, page_size=1, cursor=cursor)
    assert inventory(service.root) == before and not (tmp_path / "volume-runtime").exists()


def test_full_view_over_5000_keeps_selected_guard_and_bounded_sql_materialization(tmp_path, monkeypatch):
    import wfd_sdk.duckdb_storage as storage
    service = make_data_service(tmp_path)
    refs, expected, receipt = [], {}, None
    for part, count in enumerate((2501, 2501)):
        output = scalar_output("metric", "f09.full-over-5000", "1")
        template = output["payload"]["rows"][0]
        output["payload"]["rows"] = [
            {**copy.deepcopy(template), "business_key": f"row-{part * 2501 + index:05d}",
             "value_decimal": str(part + 1)} for index in range(count)]
        expected.update({row["business_key"]: copy.deepcopy(row) for row in output["payload"]["rows"]})
        receipt = service.submit(request([output], f"full-5002-part-{part}",
                                          parent=receipt["snapshot_id"] if receipt else None))
        (tmp_path / f"submit-part-{part}.json").write_text(json.dumps(receipt, ensure_ascii=False), "utf-8")
        assert receipt["state"] == "published_formal", receipt
        refs.extend({key: row[key] for key in ("record_id", "record_version")}
                    for row in receipt["output_results"][0]["records"])
    pid, sid = receipt["output_results"][0]["product_id"], receipt["snapshot_id"]
    assert len(refs) == 5002
    with pytest.raises(ValueError, match="PAGE_SELECTION_INVALID"):
        service.read_page(pid, snapshot_id=sid, record_refs=refs)
    def forbidden(*args, **kwargs):
        raise AssertionError("Full view cannot call full reads/public selected-page API or its external ref validator")
    for name in ("read", "_read", "read_page", "_page_selection"):
        monkeypatch.setattr(service, name, forbidden)
    for name in ("read_snapshot", "read_product"):
        monkeypatch.setattr(service.engine, name, forbidden)
    monkeypatch.setattr(storage, "rows_from_parquet", forbidden)
    actual_duckdb = storage.require_duckdb()
    scans = []
    class ConnectionSpy:
        def __init__(self, conn):
            self.conn, self.payload, self.limit = conn, False, None
        def execute(self, sql, params=None):
            self.payload = sql.startswith("SELECT s.position, p.row_json")
            if self.payload:
                assert "WHERE s.position>? AND s.position<=?" in sql and "ORDER BY s.position LIMIT ?" in sql
                assert "OFFSET" not in sql
                self.limit = params[-1]
                assert self.limit <= 1001
            self.cursor = self.conn.execute(sql, params) if params is not None else self.conn.execute(sql)
            return self
        def executemany(self, *args, **kwargs):
            self.conn.executemany(*args, **kwargs)
            return self
        def fetchall(self):
            result = self.cursor.fetchall()
            if self.payload:
                raw_bytes = sum(len(raw.encode("utf-8")) for _, raw in result)
                assert len(result) <= self.limit and raw_bytes <= 4194304
                scans.append({"materialized_rows": len(result), "raw_business_bytes": raw_bytes,
                              "sql_limit": self.limit, "keyset": True})
            return result
        def close(self):
            self.conn.close()
    monkeypatch.setattr(storage, "require_duckdb", lambda: SimpleNamespace(
        connect=lambda **kwargs: ConnectionSpy(actual_duckdb.connect(**kwargs))))
    before = inventory(service.root)
    rows, pages = walk(service, sid, pid, page_size=1000, max_page_bytes=4194304)
    assert refs_of(rows) == ordered(refs)
    assert all(row["row"] == expected[row["record_id"]] for row in rows)
    assert all(page["pagination"]["total_rows"] == 5002 for page in pages)
    assert all(0 < len(page["rows"]) <= 1000 and len(canonical(page)) <= 4194304 for page in pages)
    assert len(scans) == len(pages) and max(scan["materialized_rows"] for scan in scans) <= 1001
    assert inventory(service.root) == before
    (tmp_path / "full-page-measurement.json").write_text(json.dumps({
        "total_rows": len(rows), "actual_terminal_reached": True,
        "pages": [{"returned_rows": len(page["rows"]), "result_bytes": len(canonical(page)),
                   "page_digest": page["integrity"]["page_digest"]} for page in pages],
        "sql_scans": scans, "metadata_memory_boundary": "O(N); not constant total RAM",
    }, ensure_ascii=False, indent=2), "utf-8")
