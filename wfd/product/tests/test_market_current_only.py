"""Current business bars, with pinned technical reads retained for recovery."""
from __future__ import annotations

import copy

import pytest

from test_r1_data_only import make_data_service, request, scalar_output
from test_product_query import request as query_request, known_second
from wfd_sdk.product_query import ProductQuery, ProductQueryError


def bar_output(*, frequency="day", subject="security_000001", policy=True):
    fields = ["open", "high", "low", "close", "volume", "amount"]
    output = scalar_output("bars", "test.basic-bars", "1")
    output["subject"] = {"kind": "instrument", "namespace": "wfd.local", "id": subject}
    definition = output["definition"]
    definition.update(unit_code="per_field", measurement_nature="mixed_observation",
                      field_definitions=[{"field_code": name, "data_type": "decimal", "unit_code": "count",
                                          "measurement_nature": "stock" if i < 4 else "flow",
                                          "time_role": "observation"} for i, name in enumerate(fields)])
    context = definition["semantic_context"]
    context["time"] = {"period_type": "natural", "frequency": frequency,
                       "interval": "half_open", "timezone": "Asia/Shanghai"}
    if policy:
        context["version_axis"] = {"revision_mode": "current_only_business"}
    output["payload"] = {"kind": "tabular_rows", "rows": [{
        "business_key": "explicit-bar-key", "subject": copy.deepcopy(output["subject"]),
        "observation_time": {"status": "known", "precision": frequency,
                             "earliest_utc": "2026-01-05T01:30:00Z",
                             "latest_exclusive_utc": "2026-01-05T01:31:00Z" if frequency == "minute" else "2026-01-06T01:30:00Z",
                             "source_timezone": "Asia/Shanghai"},
        "values": {name: {"data_type": "decimal", "value_state": "valid_value", "value": value}
                   for name, value in zip(fields, ["10", "12", "9", "11", "100", "1100"])}}]}
    return output


def publish(service, output, request_id, parent=None):
    result = service.submit(request([output], request_id, parent=parent))
    assert result["state"] == "published_formal", {"state": result["state"], "errors": result.get("errors"),
        "outputs": [{"key": item.get("output_key"), "errors": item.get("errors")}
                    for item in result.get("output_results", [])]}
    return result["snapshot_id"], result["output_results"][0]["product_id"]


def correction(service, output, sid, pid, *, value="11.5"):
    updated = copy.deepcopy(output)
    previous = service.read(pid, snapshot_id=sid)["rows"][0]["record_ref"]
    updated["input_mode"] = "source_correction"
    updated["revisions"] = {updated["payload"]["rows"][0]["business_key"]: {
        "previous": previous, "reason": "explicit fixture correction"}}
    updated["payload"]["rows"][0]["values"]["close"]["value"] = value
    return updated


def test_current_business_replacement_contracts_and_pinned_technical_read(tmp_path):
    service = make_data_service(tmp_path)
    original = bar_output(frequency="minute")
    sid1, pid = publish(service, original, "current-first")
    sid2, pid2 = publish(service, correction(service, original, sid1, pid), "current-correct", sid1)
    assert pid2 == pid
    current = service.read(pid, snapshot_id=sid2)
    assert len(current["rows"]) == 1
    assert current["rows"][0]["row"]["values"]["close"]["value"] == "11.5"
    pinned = service.read(pid, snapshot_id=sid1)
    assert pinned["rows"][0]["row"]["values"]["close"]["value"] == "11"
    assert pinned["rows"][0]["record_version"] != current["rows"][0]["record_version"]
    product = current["products"][0]
    assert product["contracts"]["read"]["perspectives"] == ["snapshot_contents"]
    assert product["contracts"]["read"]["business_snapshot"] == "active_head"
    assert product["contracts"]["read"]["technical_fixed_snapshot_read"] is True
    assert product["contracts"]["publication"]["physical_storage"] == "append_only"
    assert product["contracts"]["publication"]["business_view"] == "unique_current_leaf"
    assert set(product["contract_refs"]) == {"semantic", "read_layout", "algorithm_dependency", "update_release"}
    assert len(ProductQuery(service).execute(query_request("wfd_r1_local", sid2, pid, ["close"]))["rows"]) == 1
    # Subject and frequency remain product identity dimensions.
    for index, variant in enumerate([bar_output(subject="security_000002"), bar_output(frequency="day")]):
        sid2, other = publish(service, variant, "current-distinct-" + str(index), sid2)
        assert other != pid


def test_current_business_rejects_history_stale_queries_and_key_rebinding(tmp_path):
    service = make_data_service(tmp_path)
    original = bar_output()
    sid1, pid = publish(service, original, "gates-first")
    sid2, _ = publish(service, correction(service, original, sid1, pid), "gates-correct", sid1)
    for options in [{"perspective": "market_known_at", "at": "2026-01-07T00:00:00Z"},
                    {"perspective": "system_held_at", "at": "2026-01-07T00:00:00Z"},
                    {"include_history": True}, {"at": "2026-01-07T00:00:00Z"}]:
        with pytest.raises(ValueError, match="CURRENT_ONLY_BUSINESS_HISTORY_UNSUPPORTED"):
            service.read(pid, snapshot_id=sid2, **options)
        with pytest.raises(ValueError, match="CURRENT_ONLY_BUSINESS_HISTORY_UNSUPPORTED"):
            service.read(snapshot_id=sid2, **options)
    query = ProductQuery(service)
    for changes, expected in [({"snapshot_id": sid1}, "CURRENT_ONLY_BUSINESS_HEAD_REQUIRED"),
                              ({"include_history": True}, "CURRENT_ONLY_BUSINESS_HISTORY_UNSUPPORTED"),
                              ({"history_mode": "market_known_at", "knowledge_cutoff": known_second(2026, 1, 7)}, "CURRENT_ONLY_BUSINESS_HISTORY_UNSUPPORTED"),
                              ({"history_mode": "system_held_at", "knowledge_cutoff": known_second(2026, 1, 7),
                                "held_scope": "fixture", "usable_stage": "published_readable"}, "CURRENT_ONLY_BUSINESS_HISTORY_UNSUPPORTED")]:
        with pytest.raises(ProductQueryError) as caught:
            query.execute(dict(query_request("wfd_r1_local", sid2, pid, ["close"]), **changes))
        assert caught.value.code == expected
    # Context queries report an explicit product gap, rather than leaking a
    # stale market row or disabling other products in a mixed dataset.
    for selected_snapshot, history, cutoff, expected in [
            (sid1, "snapshot_contents", None, "CURRENT_ONLY_BUSINESS_HEAD_REQUIRED"),
            (sid2, "market_known_at", known_second(2026, 1, 7), "CURRENT_ONLY_BUSINESS_HISTORY_UNSUPPORTED")]:
        context_request = dict(query_request("wfd_r1_local", selected_snapshot, pid, ["close"]),
                               protocol_version="wfd.read/1.3-product1b", operation="read_company_context",
                               subject=original["subject"], history_mode=history, knowledge_cutoff=cutoff)
        result = query.execute(context_request)
        assert result["rows"] == []
        assert any(gap.get("code") == expected and gap.get("product_id") == pid for gap in result["gaps"])
    for index, changed in enumerate(["same-key-new-interval", "new-key-same-interval", "row-subject-changed"]):
        invalid = correction(service, original, sid2, pid)
        row = invalid["payload"]["rows"][0]
        if changed == "same-key-new-interval":
            row["observation_time"]["earliest_utc"] = "2026-01-06T01:30:00Z"
            row["observation_time"]["latest_exclusive_utc"] = "2026-01-07T01:30:00Z"
        elif changed == "new-key-same-interval":
            row["business_key"] = "arbitrary-new-key"
            invalid.pop("revisions")
            invalid["input_mode"] = "partial_observation"
        else:
            row["subject"]["id"] = "other-security"
        result = service.submit(request([invalid], "invalid-key-" + str(index), parent=sid2))
        assert result["state"] in {"rejected", "registered_not_published"}, result
        assert result["output_results"][0]["errors"][0]["code"] == "CURRENT_ONLY_BUSINESS_KEY_CONFLICT"
        assert service.engine.head()["snapshot_id"] == sid2


def test_current_business_scope_is_explicit_and_ordinary_history_is_unchanged(tmp_path):
    service = make_data_service(tmp_path)
    old = bar_output(policy=False)
    sid1, old_pid = publish(service, old, "ordinary-first")
    sid2, _ = publish(service, correction(service, old, sid1, old_pid), "ordinary-correct", sid1)
    assert len(service.read(old_pid, snapshot_id=sid2, include_history=True)["rows"]) == 2
    assert service.read(old_pid, snapshot_id=sid2)["products"][0]["contracts"]["read"]["perspectives"] == [
        "snapshot_contents", "market_known_at", "system_held_at"]
    financial = scalar_output("financial", "test.financial.historical", "10")
    financial["subject"] = copy.deepcopy(old["subject"])
    financial["payload"]["rows"][0]["public_time"] = known_second(2026, 1, 1)
    sid2, financial_pid = publish(service, financial, "ordinary-financial", sid2)
    sid2, current_pid = publish(service, bar_output(), "explicit-new-mode", sid2)
    assert current_pid != old_pid
    historical = service.read(financial_pid, snapshot_id=sid2, perspective="market_known_at", at="2026-01-07T00:00:00Z")
    assert len(historical["rows"]) == 1
    assert historical["rows"][0]["row"]["value_decimal"] == "10"
    mixed = dict(query_request("wfd_r1_local", sid2, financial_pid, ["value_decimal"]),
                 protocol_version="wfd.read/1.3-product1b", operation="read_company_context",
                 subject=financial["subject"], history_mode="market_known_at", knowledge_cutoff=known_second(2026, 1, 7))
    mixed_result = ProductQuery(service).execute(mixed)
    assert any(row["product_id"] == financial_pid for row in mixed_result["rows"])
    assert all(row["product_id"] != current_pid for row in mixed_result["rows"])
    assert any(gap.get("code") == "CURRENT_ONLY_BUSINESS_HISTORY_UNSUPPORTED" and gap.get("product_id") == current_pid
               for gap in mixed_result["gaps"])
    for index, variant in enumerate(["company", "year", "forecast", "scalar"]):
        invalid = bar_output()
        if variant == "company":
            invalid["subject"]["kind"] = "company"
        elif variant == "year":
            invalid["definition"]["semantic_context"]["time"]["frequency"] = "year"
        elif variant == "forecast":
            invalid["definition"]["semantic_context"]["content_nature"] = "forecast"
        else:
            invalid = scalar_output("financial", "test.financial", "10")
            invalid["definition"]["semantic_context"]["version_axis"] = {"revision_mode": "current_only_business"}
        result = service.submit(request([invalid], "invalid-scope-" + str(index), parent=sid2))
        assert result["state"] == "rejected", result
        assert "CURRENT_ONLY_BUSINESS_SCOPE_INVALID" in str(result)


def test_current_business_same_interval_cannot_enter_through_two_outputs(tmp_path):
    service = make_data_service(tmp_path)
    first, second = bar_output(), bar_output()
    first["output_key"], second["output_key"] = "bars_a", "bars_b"
    first["payload"]["rows"][0]["business_key"] = "key-a"
    second["payload"]["rows"][0]["business_key"] = "key-b"
    second["payload"]["rows"][0]["values"]["close"]["value"] = "11.5"
    result = service.submit(request([first, second], "cross-output-conflict",
                                    consistency_groups={"same-bar": ["bars_a", "bars_b"]}))
    assert any(error.get("code") == "CURRENT_ONLY_BUSINESS_KEY_CONFLICT"
               for item in result["output_results"] for error in item.get("errors", [])), {
        "state": result.get("state"), "outputs": [{"key": item.get("output_key"), "errors": item.get("errors")}
                                          for item in result.get("output_results", [])]}
    assert service.engine.head() is None
    # A different interval remains a distinct bar of the same product.
    second["payload"]["rows"][0]["observation_time"]["earliest_utc"] = "2026-01-06T01:30:00Z"
    second["payload"]["rows"][0]["observation_time"]["latest_exclusive_utc"] = "2026-01-07T01:30:00Z"
    accepted = service.submit(request([first, second], "cross-output-distinct"))
    assert accepted["state"] == "published_formal", accepted
    ids = {item["product_id"] for item in accepted["output_results"]}
    assert len(ids) == 1
    assert len(service.read(ids.pop(), snapshot_id=accepted["snapshot_id"])["rows"]) == 2


def test_current_business_context_authorization_precedes_policy_diagnostics(tmp_path, monkeypatch):
    service = make_data_service(tmp_path)
    output = bar_output()
    sid, pid = publish(service, output, "authorization-order")
    query = ProductQuery(service)

    def deny_sources(*args, **kwargs):
        raise PermissionError("fixture source authorization denied")

    def policy_must_not_run(*args, **kwargs):
        raise AssertionError("Unauthorized caller must not receive policy diagnostics")

    monkeypatch.setattr(query, "_authorize_metadata_sources", deny_sources)
    monkeypatch.setattr(query, "_current_business_policy", policy_must_not_run)
    request_context = dict(query_request("wfd_r1_local", sid, pid, ["close"]),
                           protocol_version="wfd.read/1.3-product1b", operation="read_company_context",
                           subject=output["subject"])
    result = query.execute(request_context)
    assert result["rows"] == []
    assert any(gap.get("code") == "SOURCE_READ_PERMISSION_MISSING" for gap in result["gaps"])
