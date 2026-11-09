"""Opt-in duplicate append: synthetic stores only, no current runtime/config."""
from __future__ import annotations

import copy

import pytest

from test_r1_data_only import request, scalar_output
from test_fixed_read_pages import make_data_service
from test_market_current_only import bar_output


def opted(outputs, request_id, parent=None, **kwargs):
    return {**request(outputs, request_id, parent=parent, **kwargs),
            "duplicate_policy": "skip_identical_append"}


def output(rows, key="data", semantic="dedup.metric"):
    result = scalar_output(key, semantic, "10")
    template = result["payload"]["rows"][0]
    result["payload"]["rows"] = [{**copy.deepcopy(template), "business_key": name,
                                  "value_decimal": value} for name, value in rows]
    return result


def commits(service):
    return sorted(path.name for path in (service.root / "catalog/commits").glob("*.json"))


def test_strict_legacy_and_all_duplicate_new_identity_no_publication(tmp_path):
    service = make_data_service(tmp_path)
    original = output([("a", "10")])
    first = service.submit(request([original], "first"))
    sid = first["snapshot_id"]
    baseline = commits(service)
    legacy = service.submit(request([original], "legacy-duplicate", parent=sid))
    assert "DUPLICATE_LOGICAL_KEY_REQUIRES_REVISION" in str(legacy)
    doc = opted([original], "second", sid)
    result = service.submit(doc)
    assert result["state"] == "unchanged", result
    assert result["new_snapshot_created"] is False
    assert result["formal_publication_verified"] is False
    assert result["snapshot_id"] == sid
    assert result["row_summary"] == {"inserted": 0, "duplicate_skipped": 1,
                                     "conflict_pending": 0, "pending_publication": 0}
    assert result["output_results"][0]["records"] == first["output_results"][0]["records"]
    assert result["output_results"][0]["row_results"][0]["row_index"] == 0
    assert commits(service) == baseline
    assert make_data_service(tmp_path).submit(doc)["idempotent_replay"] is True


def test_mixed_append_exactly_new_rows_conflicts_and_recovery_keep_original_counts(tmp_path):
    service = make_data_service(tmp_path)
    first = service.submit(request([output([("a", "10"), ("b", "20")])], "seed"))
    sid = first["snapshot_id"]
    doc = opted([output([("a", "10"), ("c", "30"), ("b", "999")], key="new-output")], "mixed", sid)
    result = service.submit(doc)
    assert result["state"] == "partially_published_formal", result
    assert result["row_summary"] == {"inserted": 1, "duplicate_skipped": 1,
                                     "conflict_pending": 1, "pending_publication": 0}
    outcome = result["output_results"][0]
    assert [row["state"] for row in outcome["row_results"]] == ["duplicate_skipped", "inserted", "conflict_pending"]
    assert len(outcome["records"]) == 2 and len(outcome["inserted_records"]) == 1
    conflict = outcome["row_results"][2]
    assert conflict["difference_fields"] == ["row.value_decimal"]
    assert conflict["existing_records"][0]["snapshot_id"] == sid
    assert conflict["existing_records"][0]["record_id"] == "b"
    read = service.read(outcome["product_id"], snapshot_id=result["snapshot_id"])
    assert {row["row"]["business_key"]: row["row"]["value_decimal"] for row in read["rows"]} == {
        "a": "10", "b": "20", "c": "30"}
    # Drop only the mutable status: plan/formal/commit remain the recovery authority.
    (service.root / service._status_path(result["request_key"])).unlink()
    recovered = make_data_service(tmp_path).request_status(doc["request_identity"])
    assert recovered["state"] == result["state"], recovered
    assert recovered["row_summary"] == result["row_summary"]
    assert recovered["output_results"] == result["output_results"]
    assert service.submit(doc)["row_summary"] == result["row_summary"]
    mutated = copy.deepcopy(doc); mutated["outputs"][0]["payload"]["rows"][1]["value_decimal"] = "31"
    assert service.submit(mutated)["errors"][0]["code"] == "REQUEST_ID_CONFLICT"


def test_all_conflict_no_empty_commit_and_missing_status_recovers_fixed_noop(tmp_path):
    service = make_data_service(tmp_path)
    first = service.submit(request([output([("a", "10")])], "seed"))
    sid = first["snapshot_id"]; before = commits(service)
    doc = opted([output([("a", "11")])], "conflict", sid)
    result = service.submit(doc)
    assert result["state"] == "conflicts_pending", result
    assert result["new_snapshot_created"] is False and commits(service) == before
    assert result["output_results"][0]["records"] == []
    (service.root / service._status_path(result["request_key"])).unlink()
    recovered = make_data_service(tmp_path).request_status(doc["request_identity"])
    assert recovered["output_results"] == result["output_results"]
    assert recovered["state"] == "conflicts_pending"
    assert make_data_service(tmp_path).submit(doc)["idempotent_replay"] is True


def test_batch_duplicates_and_unequal_keys_are_classified_before_publication(tmp_path):
    service = make_data_service(tmp_path)
    doc = opted([output([("a", "10"), ("a", "10"), ("a", "10")])], "same-batch")
    same = service.submit(doc)
    assert same["state"] == "published_formal", same
    assert same["row_summary"]["inserted"] == 1 and same["row_summary"]["duplicate_skipped"] == 2
    rows = same["output_results"][0]["row_results"]
    assert [row["row_index"] for row in rows] == [0, 1, 2]
    assert len({row["record_version"] for row in rows}) == 1
    sid = same["snapshot_id"]; before = commits(service)
    cross = service.submit(opted([
        output([("new-key", "12")] * 4, "left"), output([("new-key", "13")], "right")], "cross-conflict", sid))
    assert cross["state"] == "conflicts_pending", cross
    assert cross["row_summary"]["conflict_pending"] == 5
    assert commits(service) == before
    assert len(cross["output_results"][0]["row_results"][0]["conflicting_rows"]) == 2
    assert cross["output_results"][0]["row_results"][0]["conflicting_rows"][-1]["output_key"] == "right"


def test_consistency_group_blocks_all_new_members_on_row_conflict(tmp_path):
    service = make_data_service(tmp_path)
    seed = service.submit(request([output([("a", "10")])], "seed"))
    doc = opted([output([("a", "11")], "bad"), output([("new", "30")], "other")],
                "group", seed["snapshot_id"], consistency_groups={"together": ["bad", "other"]})
    before = commits(service)
    result = service.submit(doc)
    assert result["state"] == "conflicts_pending", result
    assert result["row_summary"]["inserted"] == 0
    assert commits(service) == before
    assert result["output_results"][1]["row_results"][0]["reason"] == "CONSISTENCY_GROUP_FAILED"


@pytest.mark.parametrize("kind", ["complete_snapshot", "source_correction", "withdrawal"])
def test_opt_in_never_filters_snapshot_or_revision_modes(tmp_path, kind):
    service = make_data_service(tmp_path)
    item = output([("a", "10")]); item["input_mode"] = kind
    result = service.submit(opted([item], "invalid-mode"))
    assert result["state"] == "rejected"
    assert result["errors"][0]["code"] == "DUPLICATE_POLICY_APPEND_ONLY"
    assert commits(service) == []


def test_current_bar_interval_conflict_retains_actual_old_reference(tmp_path):
    service = make_data_service(tmp_path)
    original = bar_output()
    first = service.submit(request([original], "bar-seed"))
    changed = copy.deepcopy(original)
    changed["payload"]["rows"][0]["business_key"] = "other-key-same-interval"
    result = service.submit(opted([changed], "bar-conflict", first["snapshot_id"]))
    assert result["state"] == "conflicts_pending", result
    row = result["output_results"][0]["row_results"][0]
    assert row["reason"] == "CURRENT_ONLY_BUSINESS_KEY_CONFLICT"
    assert row["existing_records"][0]["record_id"] == "explicit-bar-key"
    assert row["existing_records"][0]["product_id"] == first["output_results"][0]["product_id"]


def test_sparse_matches_use_multiple_small_value_pages(tmp_path, monkeypatch):
    import wfd_sdk.product_data_service as module
    service = make_data_service(tmp_path)
    seed = service.submit(request([output([(f"key-{n:02d}", str(n)) for n in range(9)])], "seed"))
    monkeypatch.setattr(module, "FIXED_PAGE_MAX_SIZE", 2)
    monkeypatch.setattr(service, "_read", lambda *args, **kwargs: pytest.fail("full product decoded"))
    result = service.submit(opted([output([(f"key-{n:02d}", str(n)) for n in (4, 6, 8)])], "sparse", seed["snapshot_id"]))
    assert result["state"] == "unchanged", result
    assert result["row_summary"]["duplicate_skipped"] == 3


def test_state_missing_after_commit_keeps_inserted_and_duplicate_classification(tmp_path, monkeypatch):
    service = make_data_service(tmp_path)
    seed = service.submit(request([output([("a", "10")])], "seed"))
    doc = opted([output([("a", "10"), ("b", "20")])], "lost-return", seed["snapshot_id"])
    original = service.engine.submit
    def lose_return(document):
        original(document)
        raise OSError("synthetic lost commit return")
    monkeypatch.setattr(service.engine, "submit", lose_return)
    unknown = service.submit(doc)
    assert unknown["state"] == "publication_unknown"
    recovered = make_data_service(tmp_path).submit(doc)
    assert recovered["state"] == "published_formal", recovered
    assert recovered["row_summary"]["inserted"] == recovered["row_summary"]["duplicate_skipped"] == 1
    assert len(commits(service)) == 2


def test_definition_units_adjustment_and_state_changes_never_skip_as_identical(tmp_path):
    service = make_data_service(tmp_path)
    original = output([("a", "10")])
    seed = service.submit(request([original], "seed"))
    parent = seed["snapshot_id"]
    # Lexical decimal and complete time/state differences are deliberately not normalized.
    for index, variant in enumerate(("decimal", "time", "state", "definition", "adjustment")):
        item = copy.deepcopy(original)
        if variant == "decimal": item["payload"]["rows"][0]["value_decimal"] = "10.0"
        elif variant == "time": item["payload"]["rows"][0]["observation_time"]["source_timezone"] = "Etc/UTC"
        elif variant == "state":
            item["payload"]["rows"][0].update(value_decimal=None, value_state="unknown")
        elif variant == "definition": item["definition"]["semantic_context"]["notes"] = "different definition"
        else: item["definition"]["semantic_context"]["financial"]["price_adjustment"] = {"direction": "unknown"}
        result = service.submit(opted([item], "different-" + variant, parent))
        assert result.get("row_summary", {}).get("duplicate_skipped", 0) == 0, result
        if result.get("new_snapshot_created"): parent = result["snapshot_id"]
    service.unit_registry["count"] = {"dimension": "quantity", "multiplier": "1000"}
    different_unit = service.submit(opted([original], "different-unit", parent))
    assert "UNIT_SEMANTIC_CONFLICT" in str(different_unit)


def test_machine_row_pages_and_summary_are_explicit(tmp_path):
    from test_fixed_read_pages import machine_call
    service = make_data_service(tmp_path)
    doc = opted([output([("a", "10"), ("b", "20"), ("c", "30")])], "paged")
    published = service.submit(doc)
    all_rows = []
    for offset in (0, 2):
        reply = machine_call(tmp_path, service, "request_status", {
            "request_identity": doc["request_identity"], "output_offset": 0, "output_limit": 1,
            "output_detail": "full", "row_offset": offset, "row_limit": 2})
        assert reply["ok"] is True, reply
        page = reply["result"]["output_results"][0]
        assert page["row_results_total"] == 3 and page["row_results_offset"] == offset
        assert page["row_results_complete"] is False
        assert page["next_row_offset"] == (2 if offset == 0 else None)
        all_rows.extend(page["row_results"])
        assert len(page["records"]) == len(page["row_results"])
    assert all_rows == published["output_results"][0]["row_results"]
    reply = machine_call(tmp_path, service, "request_status", {
        "request_identity": doc["request_identity"], "output_detail": "summary"})
    summary = reply["result"]["output_results"][0]
    assert summary["row_results_total"] == 3 and summary["row_results_complete"] is False
    assert "row_results" not in summary


def test_volume_partial_and_noop_use_same_authority_and_native_plan(tmp_path):
    from test_p4b_precise_hydration import _volume
    service, target = _volume(tmp_path, "target")
    seed = service.submit(opted([output([("a", "10"), ("b", "20")])], "seed"))
    assert seed["state"] == "published_formal", seed
    doc = opted([output([("a", "10"), ("b", "99"), ("c", "30")], "new-output")], "volume-mixed", seed["snapshot_id"])
    mixed = service.submit(doc)
    assert mixed["state"] == "partially_published_formal", mixed
    assert mixed["row_summary"]["inserted"] == mixed["row_summary"]["duplicate_skipped"] == mixed["row_summary"]["conflict_pending"] == 1
    assert not (target / "catalog/product_service/data_only_status").exists()
    assert service.request_status(doc["request_identity"])["row_summary"] == mixed["row_summary"]
    assert service.submit(doc)["snapshot_id"] == mixed["snapshot_id"]
    unchanged_doc = opted([output([("a", "10")], "another-output")], "volume-noop", mixed["snapshot_id"])
    before = sorted((target / "catalog/commits").glob("*.json"))
    unchanged = service.submit(unchanged_doc)
    assert unchanged["state"] == "unchanged", unchanged
    assert unchanged["new_snapshot_created"] is False
    assert sorted((target / "catalog/commits").glob("*.json")) == before
    assert service.submit(unchanged_doc)["idempotent_replay"] is True


def test_chunked_new_policy_keeps_noop_terminal_state_and_row_summary(tmp_path):
    from wfd_sdk.product_batches import ProductBatchLedger
    service = make_data_service(tmp_path)
    seed = service.submit(opted([output([("a", "10")])], "seed"))
    doc = opted([output([("a", "10")])], "chunked-noop", seed["snapshot_id"])
    rows = doc["outputs"][0]["payload"].pop("rows")
    ledger = ProductBatchLedger(service, ledger_root=tmp_path / "batch-runtime")
    ledger.begin("chunked-noop", header=doc, expected_chunks=[{"output_key": "data", "chunk_id": "1"}])
    ledger.put_chunk("chunked-noop", output_key="data", chunk_id="1", rows=rows)
    result = ledger.finalize("chunked-noop")
    assert result["phase"] == "finalized" and result["state"] == "unchanged", result
    assert result["row_summary"]["duplicate_skipped"] == 1
    assert result["new_snapshot_created"] is False
    assert ledger.finalize("chunked-noop")["snapshot_id"] == seed["snapshot_id"]


def test_withdrawn_leaf_is_conflict_and_can_be_verified_by_existing_fixed_history(tmp_path):
    service = make_data_service(tmp_path)
    original = output([("a", "10")])
    seed = service.submit(request([original], "seed"))
    pid = seed["output_results"][0]["product_id"]
    previous = service.read(pid, snapshot_id=seed["snapshot_id"])["rows"][0]["record_ref"]
    withdrawal = copy.deepcopy(original)
    withdrawal["input_mode"] = "withdrawal"
    withdrawal["revisions"] = {"a": {"previous": previous, "reason": "explicit synthetic withdrawal"}}
    withdrawn = service.submit(request([withdrawal], "withdraw", parent=seed["snapshot_id"]))
    assert withdrawn["state"] == "published_formal", withdrawn
    conflict = service.submit(opted([original], "after-withdraw", withdrawn["snapshot_id"]))
    assert conflict["state"] == "conflicts_pending", conflict
    ref = conflict["output_results"][0]["row_results"][0]["existing_records"][0]
    assert ref["withdrawn"] is True
    history = service.read(pid, snapshot_id=ref["snapshot_id"], include_history=True)
    exact = next(row for row in history["rows"] if row["record_version"] == ref["record_version"])
    assert exact["revision"]["withdrawn"] is True
    assert exact["row"] == original["payload"]["rows"][0]


def test_head_change_at_engine_boundary_never_publishes_stale_classification(tmp_path, monkeypatch):
    service = make_data_service(tmp_path)
    seed = service.submit(opted([output([("a", "10")])], "seed"))
    doc = opted([output([("a", "10"), ("b", "20")])], "stale", seed["snapshot_id"])
    original = service.engine.submit
    def advance_before_submit(document):
        monkeypatch.setattr(service.engine, "submit", original)
        concurrent = service.submit(request([output([("concurrent", "7")])], "other", parent=seed["snapshot_id"]))
        assert concurrent["state"] == "published_formal", concurrent
        return original(document)
    monkeypatch.setattr(service.engine, "submit", advance_before_submit)
    result = service.submit(doc)
    assert "PARENT_CHANGED" in str(result), result
    assert result["row_summary"]["inserted"] == 0
    assert len(commits(service)) == 2
    pid = seed["output_results"][0]["product_id"]
    current = service.read(pid, snapshot_id=service.engine.head()["snapshot_id"])
    assert {row["record_id"] for row in current["rows"]} == {"a", "concurrent"}
    changed = copy.deepcopy(doc); changed["expected_parent_snapshot_id"] = service.engine.head()["snapshot_id"]
    assert service.submit(changed)["errors"][0]["code"] == "REQUEST_ID_CONFLICT"


def test_volume_lost_return_after_activation_recovers_original_partial_rows(tmp_path):
    from test_p4b_precise_hydration import _volume
    service, target = _volume(tmp_path, "target")
    seed = service.submit(opted([output([("a", "10")])], "seed"))
    doc = opted([output([("a", "11"), ("b", "20")])], "lost-volume-return", seed["snapshot_id"])
    def interrupted(stage, details):
        if stage == "after_activate": raise OSError("synthetic target activated before lost return")
    service.fault_injector = interrupted
    try:
        service.submit(doc)
    except OSError:
        pass
    service.fault_injector = None
    pending = service.request_status(doc["request_identity"])
    assert pending["state"] == "published_commit_pending_formal", pending
    recovered = service.submit(doc)
    assert recovered["state"] == "partially_published_formal", recovered
    assert recovered["row_summary"]["inserted"] == recovered["row_summary"]["conflict_pending"] == 1
    before = sorted((target / "catalog/commits").glob("*.json"))
    replay = service.submit(doc)
    assert replay["snapshot_id"] == recovered["snapshot_id"]
    assert sorted((target / "catalog/commits").glob("*.json")) == before
