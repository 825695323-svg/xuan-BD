"""F09: selected fixed identities are read by bounded SQL, never full-read/slice."""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from test_r1_data_only import request, scalar_output, UNITS, NAMESPACE
from test_product_service import ALL_ROLES, HERE
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator, canonical, sha
from wfd_sdk.product_data_service import WFDDataOnlyService


FORMAT = "wfd.fixed-read-page/1"


def make_data_service(tmp_path, roles=ALL_ROLES):
    # Match the machine's real data_only assembly; the legacy write schema
    # correctly rejects the data_only internal publication document.
    engine = WFDDuckDBPrototype(tmp_path / "store", load_protocol_validator(
        HERE / "protocol", entry="wfd-data-only-write.schema.json"),
        runtime_root=tmp_path / "runtime", sandbox=False, writer_host="r1-test")
    return WFDDataOnlyService(engine, caller_roles=roles, caller_id="r1-test",
                             unit_registry=UNITS, trusted_actor_namespaces={NAMESPACE})


def seed(tmp_path):
    service = make_data_service(tmp_path)
    refs, receipt = [], None
    # UTF-8 order differs from UTF-16 order for the final two IDs.
    for index, keys in enumerate((("a", "é", "\ue000"), ("z", "\U00010000"))):
        output = scalar_output("metric", "f09.fixed-page", "1")
        output["payload"]["rows"] = [
            {**copy.deepcopy(output["payload"]["rows"][0]), "business_key": key,
             "value_decimal": str(index + position + 1)}
            for position, key in enumerate(keys)
        ]
        receipt = service.submit(request([output], f"f09-part-{index}",
                                         parent=receipt["snapshot_id"] if receipt else None))
        assert receipt["state"] == "published_formal", receipt
        refs.extend(receipt["output_results"][0]["records"])
    product_id = receipt["output_results"][0]["product_id"]
    # A fixed page must not read an unrelated product's payload.
    other = service.submit(request([scalar_output("other", "f09.unrelated", "9")],
                                   "f09-other", parent=receipt["snapshot_id"]))
    assert other["state"] == "published_formal", other
    return service, other["snapshot_id"], product_id, [
        {key: item[key] for key in ("record_id", "record_version")} for item in refs]


def refs_of(rows):
    return [{key: row[key] for key in ("record_id", "record_version")} for row in rows]


def inventory(root):
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob("*") if path.is_file()}


def test_fixed_pages_sql_selection_public_shape_digests_and_replay(tmp_path, monkeypatch):
    service, sid, pid, refs = seed(tmp_path)
    original = service.read(pid, snapshot_id=sid)
    expected = {item["record_id"]: item for item in original["rows"]}
    before = inventory(service.root)

    def forbidden(*args, **kwargs):
        raise AssertionError("Fixed pages must not use a full payload reader")

    for name in ("read", "_read"):
        monkeypatch.setattr(service, name, forbidden)
    for name in ("read_snapshot", "read_product"):
        monkeypatch.setattr(service.engine, name, forbidden)
    import wfd_sdk.duckdb_storage as storage
    monkeypatch.setattr(storage, "rows_from_parquet", forbidden)

    selected = list(reversed(refs))
    ordered = sorted(selected, key=lambda item: (item["record_id"].encode("utf-8"),
                                                item["record_version"].encode("utf-8")))
    selection_digest = "sha256:" + sha(canonical(ordered))
    query_digest = "sha256:" + sha(canonical({
        "format_version": FORMAT, "profile": "data_only", "snapshot_id": sid,
        "product_id": pid, "selection_digest": selection_digest,
        "page_size": 2, "max_page_bytes": 1048576,
        "perspective": "snapshot_contents", "include_history": False,
    }))
    kwargs = dict(snapshot_id=sid, record_refs=selected, page_size=2)
    rows, cursor = [], None
    while True:
        page = service.read_page(pid, cursor=cursor, **kwargs)
        replay = service.read_page(pid, cursor=cursor, **kwargs)
        assert replay == page
        assert page["profile"] == "data_only"
        assert (page["snapshot_id"], page["product_id"], page["dataset_id"]) == (sid, pid, "wfd_r1_local")
        assert page["pagination"]["format_version"] == FORMAT
        assert page["pagination"]["selection_count"] == len(refs)
        assert 0 < page["pagination"]["returned_rows"] == len(page["rows"]) <= 2
        assert page["integrity"]["selection_digest"] == selection_digest
        assert page["integrity"]["query_digest"] == query_digest
        assert page["integrity"]["page_digest"] == "sha256:" + sha(canonical(refs_of(page["rows"])))
        assert len(canonical(page)) <= 1048576
        for row in page["rows"]:
            assert row == expected[row["record_id"]]
            assert row["record_ref"]["snapshot_id"] == sid
            assert row["definition_ref"]["digest"].startswith("sha256:")
        rows.extend(page["rows"])
        cursor = page["pagination"]["next_cursor"]
        assert bool(cursor) == page["pagination"]["has_more"]
        if cursor is None:
            break
    assert refs_of(rows) == ordered
    snapshot = service.engine._valid_snapshot_exact(sid, verify_payloads=False)
    assert page["integrity"]["manifest_digest"] == "sha256:" + sha(
        (service.root / snapshot["manifest_relpath"]).read_bytes())
    assert inventory(service.root) == before


def test_fixed_page_only_selected_records_not_the_accumulated_product(tmp_path):
    service, sid, pid, refs = seed(tmp_path)
    selection = [refs[1], refs[-1]]
    page = service.read_page(pid, snapshot_id=sid, record_refs=selection)
    assert refs_of(page["rows"]) == sorted(selection, key=lambda item: item["record_id"].encode("utf-8"))
    assert page["pagination"]["has_more"] is False
    assert len(page["rows"]) == 2


def test_page_validation_and_cursors_fail_closed_and_survive_head_advance(tmp_path):
    service, sid, pid, refs = seed(tmp_path)
    base = dict(snapshot_id=sid, record_refs=refs, page_size=2)
    variants = [
        ({"record_refs": []}, "PAGE_SELECTION_INVALID"),
        ({"record_refs": refs * 1001}, "PAGE_SELECTION_INVALID"),
        ({"record_refs": refs + [refs[0]]}, "PAGE_SELECTION_DUPLICATE"),
        ({"record_refs": [{**refs[0], "unexpected": True}]}, "PAGE_SELECTION_INVALID"),
        ({"record_refs": [{"record_id": "x", "record_version": "unknown"}]}, "PAGE_RECORD_NOT_VISIBLE"),
        ({"page_size": True}, "PAGE_SIZE_INVALID"),
        ({"page_size": 1001}, "PAGE_SIZE_INVALID"),
        ({"max_page_bytes": 0}, "PAGE_BYTES_INVALID"),
        ({"max_page_bytes": 4194305}, "PAGE_BYTES_INVALID"),
        ({"snapshot_id": "../../elsewhere"}, "PAGE_SNAPSHOT_INVALID"),
        ({"cursor": "!!!"}, "PAGE_CURSOR_INVALID"),
    ]
    before = inventory(service.root)
    for changes, code in variants:
        with pytest.raises(ValueError, match=code):
            service.read_page(pid, **{**base, **changes})
    first = service.read_page(pid, **base)
    cursor = first["pagination"]["next_cursor"]
    for changes in ({"page_size": 3}, {"max_page_bytes": 1048575}, {"record_refs": refs[:-1]}):
        with pytest.raises(ValueError, match="PAGE_CURSOR_INVALID"):
            service.read_page(pid, cursor=cursor, **{**base, **changes})
    with pytest.raises(ValueError, match="PAGE_CURSOR_INVALID"):
        service.read_page("p_" + "0" * 24, cursor=cursor, **base)
    token = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    token["body"]["after"] = refs[-1]
    broken = base64.urlsafe_b64encode(canonical(token)).decode("ascii").rstrip("=")
    with pytest.raises(ValueError, match="PAGE_CURSOR_INVALID"):
        service.read_page(pid, cursor=broken, **base)
    assert inventory(service.root) == before
    expected_next = service.read_page(pid, cursor=cursor, **base)
    advanced = service.submit(request([scalar_output("next", "f09.advance", "3")],
                                      "f09-advance", parent=sid))
    assert advanced["state"] == "published_formal", advanced
    assert service.read_page(pid, cursor=cursor, **base) == expected_next
    with pytest.raises(ValueError, match="PAGE_CURSOR_INVALID"):
        service.read_page(pid, cursor=cursor, **{**base, "snapshot_id": advanced["snapshot_id"]})


def test_superseded_and_withdrawn_refs_are_rejected_not_silently_omitted(tmp_path):
    service, sid, pid, refs = seed(tmp_path)
    old = service.read(pid, snapshot_id=sid)["rows"][0]
    output = scalar_output("metric", "f09.fixed-page", "100")
    output["payload"]["rows"][0]["business_key"] = old["record_id"]
    output.update(definition_mode="reuse", definition_ref=old["definition_ref"],
                  definition=None, input_mode="source_correction")
    output["revisions"] = {old["record_id"]: {"previous": old["record_ref"], "reason": "test correction"}}
    corrected = service.submit(request([output], "f09-correct", parent=sid))
    assert corrected["state"] == "published_formal", corrected
    new_ref = {key: corrected["output_results"][0]["records"][0][key]
               for key in ("record_id", "record_version")}
    with pytest.raises(ValueError, match="PAGE_RECORD_NOT_VISIBLE"):
        service.read_page(pid, snapshot_id=corrected["snapshot_id"], record_refs=refs)
    current = service.read_page(pid, snapshot_id=corrected["snapshot_id"], record_refs=[new_ref])
    assert current["rows"][0]["row"]["value_decimal"] == "100"
    output["input_mode"] = "withdrawal"
    output["payload"]["rows"] = [copy.deepcopy(current["rows"][0]["row"])]
    output["revisions"] = {new_ref["record_id"]: {
        "previous": current["rows"][0]["record_ref"], "reason": "test withdrawal"}}
    withdrawn = service.submit(request([output], "f09-withdraw", parent=corrected["snapshot_id"]))
    assert withdrawn["state"] == "published_formal", withdrawn
    removed = withdrawn["output_results"][0]["records"][0]
    with pytest.raises(ValueError, match="PAGE_RECORD_NOT_VISIBLE"):
        service.read_page(pid, snapshot_id=withdrawn["snapshot_id"], record_refs=[
            {key: removed[key] for key in ("record_id", "record_version")}])
    assert refs_of(service.read_page(pid, snapshot_id=sid, record_refs=[refs[0]])["rows"]) == [refs[0]]


def test_branch_gate_on_explicit_in_memory_metadata_candidate(tmp_path):
    service, sid, pid, refs = seed(tmp_path)
    snapshot = copy.deepcopy(service.engine._valid_snapshot_exact(sid, verify_payloads=False))
    entry = next(part for part in snapshot["files"] if part["product_id"] == pid)
    versions = entry["source_bundle"]["_wfd_row_versions"][entry["output_key"]]
    first = next(iter(versions.values()))
    branch = {**first, "revision_id": "r_synthetic_branch", "supersedes": None}
    versions["synthetic_unmaterialized_key"] = branch
    entry["row_count"] += 1
    # Unit candidate only; no snapshot/manifest/receipt is patched or persisted.
    with pytest.raises(ValueError, match="PAGE_RECORD_NOT_VISIBLE"):
        service._page_parts(snapshot, pid, service._page_selection(refs))


@pytest.mark.parametrize("target", ["payload", "contract", "manifest"])
def test_payload_and_contract_and_manifest_integrity_are_not_bypassed(tmp_path, target):
    service, sid, pid, refs = seed(tmp_path)
    snapshot = service.engine._valid_snapshot_exact(sid, verify_payloads=False)
    entries = [part for part in snapshot["files"] if part["product_id"] == pid]
    if target == "payload":
        # Even an unselected part of this product must retain its file SHA proof.
        artifact = service.root / entries[-1]["file_relpath"]
    elif target == "contract":
        product = entries[0]["source_bundle"]["_wfd_product_bindings"][entries[0]["output_key"]]["product"]
        digest = product["contract_refs"]["semantic"]["digest"].removeprefix("sha256:")
        artifact = service.root / "catalog/product_service/contracts/semantic" / (digest + ".json")
    else:
        artifact = service.root / snapshot["manifest_relpath"]
    artifact.write_bytes(artifact.read_bytes() + b" ")
    with pytest.raises(ValueError, match="CHECKSUM_MISMATCH|CONTRACT_|SNAPSHOT_UNAVAILABLE_OR_INVALID"):
        service.read_page(pid, snapshot_id=sid, record_refs=[refs[0]])


def test_page_byte_budget_returns_whole_rows_or_an_explicit_error(tmp_path):
    service, sid, pid, refs = seed(tmp_path)
    full = service.read_page(pid, snapshot_id=sid, record_refs=refs)
    budget = len(canonical(full)) - 500
    page = service.read_page(pid, snapshot_id=sid, record_refs=refs, max_page_bytes=budget)
    assert 0 < len(page["rows"]) < len(refs)
    assert len(canonical(page)) <= budget
    assert page["pagination"]["has_more"] is True
    assert page["pagination"]["next_cursor"]
    with pytest.raises(ValueError, match="PAGE_METADATA_TOO_LARGE|PAGE_ITEM_TOO_LARGE"):
        service.read_page(pid, snapshot_id=sid, record_refs=refs, max_page_bytes=100)


def test_readonly_and_denied_caller_never_write_store(tmp_path):
    from test_r1_data_only import NAMESPACE, UNITS
    from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype
    from wfd_sdk.product_data_service import WFDDataOnlyService
    service, sid, pid, refs = seed(tmp_path)
    before = inventory(service.root)
    engine = WFDDuckDBPrototype.open_existing(service.root, service.engine.validator,
                                            runtime_root=tmp_path / "new-read-runtime", read_only=True)
    reader = WFDDataOnlyService(engine, caller_roles={"read"}, unit_registry=UNITS,
                               trusted_actor_namespaces={NAMESPACE})
    assert reader.read_page(pid, snapshot_id=sid, record_refs=refs)["row_count"] == len(refs)
    denied = WFDDataOnlyService(engine, caller_roles=set(), unit_registry=UNITS)
    with pytest.raises(PermissionError):
        denied.read_page(pid, snapshot_id=sid, record_refs=refs)
    assert inventory(service.root) == before
    assert not (tmp_path / "new-read-runtime").exists()


def machine_call(tmp_path, service, operation, arguments, *, roles=("read",), profile="data_only"):
    from test_product_service import HERE
    from test_store_opening import machine_config, _AUDITED_MACHINE
    child_root = tmp_path / ("machine-" + str(len(list(tmp_path.glob("machine-*")))))
    child_root.mkdir()
    config = machine_config(child_root, service.root, profile, roles, caller_id="r1-test")
    prefix = child_root / "cache"
    assert not prefix.exists()
    bootstrap = "import sys; sys.path.insert(0, " + repr(str(HERE)) + ");\n" + _AUDITED_MACHINE
    document = {"protocol_version": "wfd.product-machine/0.1", "request_id": "f09-machine",
                "operation": operation, "arguments": arguments}
    completed = subprocess.run(
        [sys.executable, "-I", "-B", "-X", "pycache_prefix=" + str(prefix), "-c", bootstrap,
         str(service.root), str(config)], input=json.dumps(document), text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60,
        cwd=HERE, env={**os.environ, "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1"})
    (child_root / "response.json").write_text(completed.stdout, "utf-8")
    (child_root / "stderr.txt").write_text(completed.stderr, "utf-8")
    assert completed.returncode in {0, 2}, completed.stderr
    assert json.loads(completed.stderr)["store_write_attempts"] == []
    return json.loads(completed.stdout)


def test_real_machine_caps_full_shape_result_budget_and_profile_gates(tmp_path):
    service, sid, pid, refs = seed(tmp_path)
    before = inventory(service.root)
    caps = machine_call(tmp_path, service, "capabilities", {})
    operation = caps["result"]["operations"]["fixed_read_page"]
    assert operation["supported"] is True and operation["format_version"] == FORMAT
    assert operation["selection_limit"] == 5000
    assert operation["perspective"] == "snapshot_contents"
    assert operation["calendar_qualification"]["supported"] is False
    assert caps["result"]["process"]["read_only"] is True
    args = {"snapshot_id": sid, "product_id": pid, "record_refs": refs}
    first = machine_call(tmp_path, service, "fixed_read_page", args)
    assert first["ok"] is True, first
    full = first["result"]
    budget = len(canonical(full)) - 500
    page = machine_call(tmp_path, service, "fixed_read_page", {**args, "max_page_bytes": budget})
    assert page["ok"] is True, page
    result = page["result"]
    assert result["service_identity"] and result["row_projection"] == "full"
    assert 0 < result["row_count"] < len(refs)
    assert len(canonical(result)) <= budget
    assert result["pagination"]["has_more"] is True
    denied = machine_call(tmp_path, service, "fixed_read_page", args, roles=())
    assert denied["error"]["code"] == "CALLER_PERMISSION_DENIED"
    legacy = machine_call(tmp_path, service, "capabilities", {}, profile="legacy")
    assert "fixed_read_page" not in legacy["result"]["operations"]
    blocked = machine_call(tmp_path, service, "fixed_read_page", args, profile="legacy")
    assert blocked["ok"] is False
    old = machine_call(tmp_path, service, "fixed_read", {"snapshot_id": sid, "product_id": pid})
    assert old["ok"] is True and old["result"]["row_count"] == len(refs)
    assert inventory(service.root) == before


def test_calendar_and_non_scalar_limits_are_explicit_without_full_read_fallback(tmp_path, monkeypatch):
    from test_p4b_precise_hydration import MARKET, _calendar_ref, _day, _trading_calendar
    service = make_data_service(tmp_path)
    calendar = service.submit(request([_trading_calendar("calendar", ["2025-01-02"])], "f09-calendar"))
    assert calendar["state"] == "published_formal", calendar
    cal_pid, cal_sid = calendar["output_results"][0]["product_id"], calendar["snapshot_id"]
    ref = _calendar_ref(service, cal_pid, cal_sid)
    output = scalar_output("metric", "f09.calendar-dependent", "7")
    output["subject"] = copy.deepcopy(MARKET)
    output["definition"]["semantic_context"]["time"] = {
        "period_type": "trading", "frequency": "day", "interval": "closed",
        "timezone": "Asia/Shanghai", "calendar_ref": ref}
    output["payload"]["rows"][0]["observation_time"] = _day("2025-01-02")
    receipt = service.submit(request([output], "f09-calendar-dependent", parent=cal_sid))
    assert receipt["state"] == "published_formal", receipt
    pid, sid = receipt["output_results"][0]["product_id"], receipt["snapshot_id"]
    selected = [{key: item[key] for key in ("record_id", "record_version")}
                for item in receipt["output_results"][0]["records"]]
    assert service.read(pid, snapshot_id=sid)["rows"][0]["row"]["value_decimal"] == "7"

    def forbidden(*args, **kwargs):
        raise AssertionError("Unsupported bounded dependency must not fall back to a full read")

    monkeypatch.setattr(service, "_read", forbidden)
    with pytest.raises(ValueError, match="PAGED_READ_CALENDAR_UNSUPPORTED"):
        service.read_page(pid, snapshot_id=sid, record_refs=selected)
    cal_refs = [{key: item[key] for key in ("record_id", "record_version")}
                for item in calendar["output_results"][0]["records"]]
    with pytest.raises(ValueError, match="PAGED_READ_PRODUCT_UNSUPPORTED"):
        service.read_page(cal_pid, snapshot_id=cal_sid, record_refs=cal_refs)


def test_volume_read_page_forwarding_preserves_readonly_and_uuid_guard(tmp_path):
    from test_product_service import HERE
    from test_r1_data_only import NAMESPACE, UNITS
    from test_r2a_volume_publication import FakeDetector, VOL_UUID
    from wfd_sdk.product_volume_service import WFDVolumeService
    from wfd_sdk.volume_publication import VolumeBinding, VolumeError
    service, sid, pid, refs = seed(tmp_path)
    volume = WFDVolumeService(
        binding=VolumeBinding(mount_point=str(service.root), volume_uuid=VOL_UUID,
                              filesystem="exfat", writer_host="r1-test", writer_epoch=0),
        runtime_root=tmp_path / "volume-runtime", protocol_root=HERE / "protocol",
        caller_roles=("read",), unit_registry=UNITS, trusted_actor_namespaces={NAMESPACE},
        detector=FakeDetector())
    before = inventory(service.root)
    caps = volume.capabilities()
    assert caps["operations"]["fixed_read_page"]["format_version"] == FORMAT
    assert "fixed_read_page" in caps["volume"]["operations"]
    assert volume.read_page(pid, snapshot_id=sid, record_refs=refs)["row_count"] == len(refs)
    assert volume.engine.read_only is True
    volume.binding = VolumeBinding(mount_point=str(service.root), volume_uuid="00000000-0000-0000-0000-000000000000",
                                   filesystem="exfat", writer_host="r1-test", writer_epoch=0)
    with pytest.raises(VolumeError):
        volume.read_page(pid, snapshot_id=sid, record_refs=refs)
    assert inventory(service.root) == before


def test_selection_limit_5000_materializes_only_whole_bounded_sql_pages(tmp_path, monkeypatch):
    service = make_data_service(tmp_path)
    output = scalar_output("metric", "f09.selection-limit", "1")
    row = output["payload"]["rows"][0]
    output["payload"]["rows"] = [
        {**copy.deepcopy(row), "business_key": f"row-{index:04d}"} for index in range(5000)]
    receipt = service.submit(request([output], "f09-5000"))
    (tmp_path / "submit-receipt.json").write_text(json.dumps(receipt, ensure_ascii=False), "utf-8")
    assert receipt["state"] == "published_formal", receipt
    pid, sid = receipt["output_results"][0]["product_id"], receipt["snapshot_id"]
    refs = [{key: item[key] for key in ("record_id", "record_version")}
            for item in receipt["output_results"][0]["records"]]
    assert len(refs) == 5000

    def forbidden(*args, **kwargs):
        raise AssertionError("5000-ref selected pages cannot materialize the whole product")

    monkeypatch.setattr(service, "_read", forbidden)
    monkeypatch.setattr(service.engine, "read_product", forbidden)
    monkeypatch.setattr(service.engine, "read_snapshot", forbidden)
    cursor, seen, pages = None, [], []
    while True:
        page = service.read_page(pid, snapshot_id=sid, record_refs=refs, page_size=1000,
                                 max_page_bytes=4194304, cursor=cursor)
        size = len(canonical(page))
        assert 0 < len(page["rows"]) <= 1000
        assert size <= 4194304
        seen.extend(refs_of(page["rows"]))
        pages.append({"rows": len(page["rows"]), "bytes": size,
                      "page_digest": page["integrity"]["page_digest"]})
        cursor = page["pagination"]["next_cursor"]
        if cursor is None:
            break
    assert seen == sorted(refs, key=lambda ref: ref["record_id"].encode("utf-8"))
    assert len({(item["record_id"], item["record_version"]) for item in seen}) == 5000
    assert len(pages) >= 5
    (tmp_path / "page-measurement.json").write_text(json.dumps(pages, indent=2), "utf-8")


def test_one_oversized_scalar_identity_is_an_error_not_a_truncated_row(tmp_path):
    service = make_data_service(tmp_path)
    output = scalar_output("metric", "f09.big-identity", "1")
    output["payload"]["rows"][0]["business_key"] = "large-" + "x" * 10000
    receipt = service.submit(request([output], "f09-big-identity"))
    assert receipt["state"] == "published_formal", receipt
    refs = [{key: item[key] for key in ("record_id", "record_version")}
            for item in receipt["output_results"][0]["records"]]
    before = inventory(service.root)
    with pytest.raises(ValueError, match="PAGE_ITEM_TOO_LARGE"):
        service.read_page(receipt["output_results"][0]["product_id"],
                          snapshot_id=receipt["snapshot_id"], record_refs=refs, max_page_bytes=4096)
    assert inventory(service.root) == before


def test_tabular_fixed_pages_preserve_all_field_values_and_versions_without_full_reader(tmp_path, monkeypatch):
    service = make_data_service(tmp_path)
    output = scalar_output('table', 'f09.tabular.fixed-pages', '1')
    output['definition']['unit_code'] = 'per_field'
    output['definition']['field_definitions'] = [
        {'field_code': 'label', 'data_type': 'text', 'unit_code': 'text',
         'measurement_nature': 'stock', 'time_role': 'observation'},
        {'field_code': 'close', 'data_type': 'decimal', 'unit_code': 'count',
         'measurement_nature': 'stock', 'time_role': 'observation'},
    ]
    base = copy.deepcopy(output['payload']['rows'][0])
    output['payload'] = {'kind': 'tabular_rows', 'rows': [
        {key: value for key, value in {
            **base, 'business_key': 'row-' + str(index), 'subject': copy.deepcopy(output['subject']),
            'values': {'label': {'data_type': 'text', 'value_state': 'valid_value', 'value': '原报' + str(index)},
                       'close': {'data_type': 'decimal', 'value_state': 'valid_value', 'value': '9007199254740993.12345678'}},
        }.items() if key not in {'value_decimal', 'value_state'}} for index in range(7)
    ]}
    receipt = service.submit(request([output], 'f09-tabular-append'))
    assert receipt['state'] == 'published_formal', receipt
    pid, sid = receipt['output_results'][0]['product_id'], receipt['snapshot_id']
    refs = [{key: item[key] for key in ('record_id', 'record_version')}
            for item in receipt['output_results'][0]['records']]
    expected = {row['record_ref']['logical_key']: row for row in service.read(pid, snapshot_id=sid)['rows']}

    def forbidden(*args, **kwargs):
        raise AssertionError('Tabular paging must not hydrate a complete product')

    monkeypatch.setattr(service, '_read', forbidden)
    monkeypatch.setattr(service.engine, 'read_snapshot', forbidden)
    cursor, actual, pages = None, [], 0
    while True:
        result = service.read_page(pid, snapshot_id=sid, record_refs=refs, page_size=2, cursor=cursor)
        assert result['pagination']['selection_count'] == 7
        assert len(canonical(result)) <= 1048576
        for row in result['rows']:
            assert row == expected[row['record_id']]
        actual.extend(result['rows'])
        pages += 1
        cursor = result['pagination']['next_cursor']
        if cursor is None:
            break
    assert len(actual) == 7 and pages == 4
    assert service.capabilities()['operations']['fixed_read_page']['payload_kinds'] == ['scalar_rows', 'tabular_rows']


def test_page_binding_reuse_is_exact_and_rechecks_contract_bytes_between_parts(tmp_path,monkeypatch):
    service,sid,pid,refs=seed(tmp_path)
    snapshot=service.engine.read_snapshot(sid)
    original=service._verify_binding;calls=[]
    def checked(product,*args,**kwargs):
        calls.append(product['product_id']);return original(product,*args,**kwargs)
    monkeypatch.setattr(service,'_verify_binding',checked)
    service._page_parts(snapshot,pid,refs)
    assert calls==[pid]
    changed=copy.deepcopy(snapshot)
    targets=[entry for entry in changed['files'] if entry['product_id']==pid]
    targets[1]['source_bundle']['_wfd_product_bindings'][targets[1]['output_key']]['product']['declaration']['definition_authority']='tampered-body'
    with pytest.raises(ValueError,match='DEFINITION_DIGEST_MISMATCH'):
        service._page_parts(changed,pid,refs)
    altered=[]
    def change_after_first(product,*args,**kwargs):
        original(product,*args,**kwargs)
        if not altered:
            role='semantic';digest=product['contract_refs'][role]['digest'].removeprefix('sha256:')
            path=service.root/f'catalog/product_service/contracts/{role}/{digest}.json'
            altered.append((path,path.read_bytes()));path.write_bytes(path.read_bytes()+b'changed-between-parts')
    monkeypatch.setattr(service,'_verify_binding',change_after_first)
    try:
        with pytest.raises(ValueError,match='CONTRACT_FILE_DIGEST_MISMATCH:semantic'):
            service._page_parts(snapshot,pid,refs)
    finally:
        for path,raw in altered:path.write_bytes(raw)
