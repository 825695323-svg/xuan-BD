"""P4a1 targeted checks: bounded fixed-snapshot product reads.

These tests exercise the new query boundary only.  They reuse the already
verified real stores/snapshots from P3a5, P1b and the 0.2 release for read-back,
then use small synthetic stores for projection, time, pagination, budget and
history semantics.  The storage engine and the shared product service are not
re-validated as a whole.
"""
from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_query import (
    MAX_PAGE_SIZE,
    PROTOCOL_VERSION,
    ProductQuery,
    ProductQueryError,
)
from wfd_sdk.product_service import SERVICE_VERSION, WFDProductService


HERE = Path(__file__).resolve().parents[1]
ROOT = HERE.parents[1]
EVIDENCE_ROOT = ROOT / "03_测试与验证记录"

ALL_ROLES = {"evidence_write", "register", "submit", "publish",
             "read", "read_evidence", "export", "redistribute"}
READ_ROLES = {"read", "read_evidence"}
SOURCE_POLICY = {
    "may_submit": True, "may_publish_formal": True,
    "may_read": True, "may_read_evidence": True,
    "allowed_roles": ["definer", "first_publisher", "republisher",
                      "deliverer", "compiler", "acquirer"],
    "allowed_authorities": ["portoflosangeles.official", "p1.test", "p3.test",
                            "p3.real", "p4a1.test", "audit"],
    "may_export": True, "may_export_evidence": True,
    "export_scope": "user_local_validation_only", "usage_scope": "test_only",
}
UNIT_REGISTRY = {
    "vehicle": {"dimension": "quantity"},
    "share": {"dimension": "quantity"},
    "text": {"dimension": "text"},
    "boolean": {"dimension": "boolean"},
    "date": {"dimension": "date"},
}
CN = ZoneInfo("Asia/Shanghai")
UTC = timezone.utc


def known_day(year, month, day, zone=CN):
    start = datetime(year, month, day, tzinfo=zone)
    end = start + timedelta(days=1)
    return {
        "status": "known", "precision": "day",
        "earliest_utc": start.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "latest_exclusive_utc": end.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_timezone": "Asia/Shanghai",
    }


def known_second(year, month, day, hour=0, minute=0, second=0):
    start = datetime(year, month, day, hour, minute, second, tzinfo=UTC)
    end = start + timedelta(seconds=1)
    return {
        "status": "known", "precision": "second",
        "earliest_utc": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "latest_exclusive_utc": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_timezone": "UTC",
    }


def known_year(year, zone=CN):
    start = datetime(year, 1, 1, tzinfo=zone)
    end = datetime(year + 1, 1, 1, tzinfo=zone)
    return {
        "status": "known", "precision": "year",
        "earliest_utc": start.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "latest_exclusive_utc": end.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_timezone": "Asia/Shanghai",
    }


def unknown_time():
    return {"status": "unknown", "precision": "unknown",
            "earliest_utc": None, "latest_exclusive_utc": None,
            "source_timezone": "UTC"}


def field(code, data_type, unit, nature="flow", role="observation"):
    return {"field_code": code, "data_type": data_type, "unit_code": unit,
            "measurement_nature": nature, "time_role": role}


def new_service(store, runtime, *, roles=ALL_ROLES, caller="p4a1-test",
                unit_registry=UNIT_REGISTRY, source_policy=None):
    engine = WFDDuckDBPrototype(
        store, load_protocol_validator(HERE / "protocol"),
        runtime_root=runtime, sandbox=False, writer_host=caller)
    policy = dict(SOURCE_POLICY if source_policy is None else source_policy)
    return WFDProductService(
        engine, allowed_sources={"fixture": policy},
        caller_roles=roles, caller_id=caller,
        unit_registry=unit_registry,
        trusted_actor_namespaces={"wfd.test.curated"})


def base_document(tmp_path):
    service = new_service(tmp_path / "store", tmp_path / "runtime")
    evidence_path = tmp_path / "source.txt"
    evidence_path.write_text("P4a1 synthetic projection fixture, not financial data.")
    evidence = service.register_evidence(evidence_path)
    doc = json.loads((HERE / "fixtures/port_annual_autos.json").read_text("utf-8"))
    output = doc["outputs"][0]
    doc["source_bundle"] = {
        "source_id": "fixture",
        "source_ids": ["fixture"],
        "license": "test_only",
        "usage_scope": "test_only",
        "source_roles": {
            output["output_key"]: [{"source_id": "fixture",
                                    "roles": ["compiler", "deliverer"]}],
        },
        "product_service": {
            "version": SERVICE_VERSION,
            "outputs": {output["output_key"]: {"read_dependencies": []}},
        },
    }
    output["evidence_refs"] = [evidence]
    return service, doc


def sync_source_roles(doc):
    doc["source_bundle"]["source_roles"] = {
        output["output_key"]: [{"source_id": "fixture",
                                "roles": ["compiler", "deliverer"]}]
        for output in doc["outputs"]
    }
    doc["source_bundle"]["product_service"] = {
        "version": SERVICE_VERSION,
        "outputs": {output["output_key"]: {"read_dependencies": []}
                    for output in doc["outputs"]},
    }
    return doc


def submit_ok(service, doc):
    result = service.submit(doc)
    assert result["status"] == "published_formal", result
    return result


def request(dataset_id, snapshot_id, product_id, fields, **overrides):
    value = {
        "protocol_version": PROTOCOL_VERSION,
        "dataset_id": dataset_id,
        "operation": "read_product",
        "snapshot_id": snapshot_id,
        "history_mode": "snapshot_contents",
        "knowledge_cutoff": None,
        "held_scope": None,
        "usable_stage": None,
        "subject": None,
        "max_nodes": 1000,
        "product_id": product_id,
        "fields": list(fields),
        "page_size": 100,
        "max_scan_bytes": 50_000_000,
        "cursor": None,
        "business_time_range": None,
    }
    value.update(overrides)
    return value


def real_snapshot(store, snapshot_id):
    return json.loads((store / f"catalog/snapshots/{snapshot_id}.json").read_text("utf-8"))


def real_query(store, snapshot_id, tmp_path, label):
    snapshot = real_snapshot(store, snapshot_id)
    source_ids = set()
    for entry in snapshot["files"]:
        bundle = entry.get("source_bundle") or {}
        source_ids.update(bundle.get("source_ids") or [])
        if bundle.get("source_id"):
            source_ids.add(bundle["source_id"])
        for source in bundle.get("sources") or []:
            if source.get("source_id"):
                source_ids.add(source["source_id"])
    policy = {
        source_id: {
            "may_read": True, "may_read_evidence": True,
            "usage_scope": "local_use", "license": "local_use_only",
        }
        for source_id in sorted(source_ids)
    }
    engine = WFDDuckDBPrototype(
        store, load_protocol_validator(HERE / "protocol"),
        runtime_root=tmp_path / f"runtime_{label}",
        sandbox=False, writer_host=label)
    service = WFDProductService(
        engine, allowed_sources=policy, caller_roles=READ_ROLES,
        caller_id=label)
    return ProductQuery(service), snapshot


def product_bindings(snapshot):
    products = {}
    for entry in snapshot["files"]:
        binding = entry["source_bundle"]["_wfd_product_bindings"][entry["output_key"]]
        products[entry["product_id"]] = binding["product"]
    return products


# ---------------------------------------------------------------------------
# 1. Real verified fixed samples read back through the new boundary
# ---------------------------------------------------------------------------
def test_real_verified_fixed_samples_read_back(tmp_path):
    p3a5_store = (EVIDENCE_ROOT / "P3_通用入库与更新_2026-10-27" /
                  "run_20261027_p3a5/store")
    p1b_store = (EVIDENCE_ROOT / "P1_正式契约与治理_2026-10-27" /
                 "p1b_real_slice2/store")
    v02_store = (EVIDENCE_ROOT / "金融产品建设_2026-10-27" /
                 "run_20261026T164019Z/store")
    for store in (p3a5_store, p1b_store, v02_store):
        if not store.is_dir():
            pytest.skip("verified real store missing: " + str(store))

    # P3a5: actual market close from the verified real slice.
    p3a5_sid = "s_99eb1926ff005636c2e6b8e2"
    query, _ = real_query(p3a5_store, p3a5_sid, tmp_path, "p3a5")
    result = query.execute(request(
        "p3a_real_2026_v2", p3a5_sid, "p_41bd2793733d9dff596d0802",
        ["close_price", "price_adjustment", "source_basis"],
        subject={"kind": "instrument", "namespace": "wfd.cn",
                 "id": "instrument_000001_a"},
        max_nodes=10, max_scan_bytes=20_000_000))
    assert result["result_status"] == "rows"
    assert result["complete"] is True
    assert len(result["rows"]) == 1
    row = result["rows"][0]
    assert row["values"]["close_price"]["value"] == "11.41"
    assert row["values"]["close_price"]["data_type"] == "decimal"
    assert row["values"]["close_price"]["value_state"] == "valid_value"
    assert row["values"]["price_adjustment"]["value"] == "unknown"
    assert row["values"]["price_adjustment"]["value_state"] == "valid_value"
    assert row["business_time"]["earliest_utc"] == "2025-12-30T16:00:00Z"
    assert row["business_time"]["latest_exclusive_utc"] == "2025-12-31T16:00:00Z"
    assert row["times"]["observation_time"] == row["business_time"]
    assert row["subject"] == {"id": "instrument_000001_a", "kind": "instrument",
                              "namespace": "wfd.cn"}
    assert row["source_binding"]["source_ids"] == ["market_20251231"]
    assert row["evidence_refs"]

    # Do not use the old P3a5 market row_public_times (trading day was misused
    # as publication time).  Use the fixed announcement-time financial row for
    # an eligibility read-back, explicitly without claiming a new historical
    # proof.
    after = query.execute(request(
        "p3a_real_2026_v2", p3a5_sid, "p_02ec6055541fbe0a36213c05",
        ["revenue_cny_100million"], history_mode="market_known_at",
        knowledge_cutoff=known_day(2026, 3, 22),
        subject={"kind": "entity", "namespace": "wfd.cn", "id": "entity_000001"},
        max_nodes=10, max_scan_bytes=20_000_000))
    assert len(after["rows"]) == 1
    assert after["cutoff"]["rule"] == "coarse_precision_conservative_lower_bound"
    assert after["rows"][0]["eligibility"]["decision"] == "eligible"
    before = query.execute(request(
        "p3a_real_2026_v2", p3a5_sid, "p_02ec6055541fbe0a36213c05",
        ["revenue_cny_100million"], history_mode="market_known_at",
        knowledge_cutoff=known_day(2026, 3, 20),
        subject={"kind": "entity", "namespace": "wfd.cn", "id": "entity_000001"},
        max_nodes=10, max_scan_bytes=20_000_000))
    assert before["rows"] == []
    assert before["diagnostics"][0]["decision"] == "ineligible"

    # P1b: the compatible additive definition is read from its fixed contract;
    # the old snapshot does not define the added field and must reject it.
    p1b_new = "s_65e4da423bac718a9acbc789"
    p1b_old = "s_9f3edb73a442f1940a54a1d8"
    p1b_query, _ = real_query(p1b_store, p1b_new, tmp_path, "p1b_new")
    p1b = p1b_query.execute(request(
        "wfd_cn_000001_financial_products", p1b_new,
        "p_26be7d18c2302505ea79da68",
        ["company_name", "uscc", "audit_note"],
        subject={"kind": "entity", "namespace": "cn.uscc",
                 "id": "91440300192185379H"},
        max_nodes=10, max_scan_bytes=60_000_000))
    assert len(p1b["rows"]) == 1
    values = p1b["rows"][0]["values"]
    assert values["company_name"]["value"] == "平安银行股份有限公司"
    assert values["audit_note"]["value"] == "p1b-compatible-definition-version"
    old_query, _ = real_query(p1b_store, p1b_old, tmp_path, "p1b_old")
    with pytest.raises(ProductQueryError) as rejected:
        old_query.execute(request(
            "wfd_cn_000001_financial_products", p1b_old,
            "p_26be7d18c2302505ea79da68",
            ["company_name", "uscc", "audit_note"],
            subject={"kind": "entity", "namespace": "cn.uscc",
                     "id": "91440300192185379H"},
            max_nodes=10, max_scan_bytes=60_000_000))
    assert rejected.value.code == "FIELD_NOT_DEFINED"

    # Fixed company identity public time is unknown in this snapshot.  Unknown
    # must not be inferred as old/new market knowledge.
    unknown_history = p1b_query.execute(request(
        "wfd_cn_000001_financial_products", p1b_new,
        "p_26be7d18c2302505ea79da68", ["company_name"],
        history_mode="market_known_at",
        knowledge_cutoff=known_day(2020, 1, 2),
        subject={"kind": "entity", "namespace": "cn.uscc",
                 "id": "91440300192185379H"},
        max_nodes=10, max_scan_bytes=60_000_000))
    assert unknown_history["rows"] == []
    assert unknown_history["diagnostics"]
    assert all(item["reason"] == "PUBLICATION_OR_HELD_TIME_UNKNOWN"
               for item in unknown_history["diagnostics"])

    # 0.2: select every value-bearing fixed product.  Relation/event products
    # declare no value fields and are accurately rejected rather than invented.
    v02_sid = "s_9f3edb73a442f1940a54a1d8"
    v02_query, snapshot = real_query(v02_store, v02_sid, tmp_path, "v02")
    products = product_bindings(snapshot)
    total, rejected_products = 0, {}
    for product_id, product in products.items():
        declaration = product.get("declaration") or {}
        if product.get("payload_kind") == "scalar_rows":
            fields = ["value_decimal"]
        elif declaration.get("field_definitions"):
            fields = [declaration["field_definitions"][0]["field_code"]]
        else:
            with pytest.raises(ProductQueryError) as rejected:
                v02_query.execute(request(
                    product["dataset_id"], v02_sid, product_id,
                    ["value_decimal"], max_nodes=1000,
                    max_scan_bytes=60_000_000))
            rejected_products[product_id] = rejected.value.code
            continue
        read = v02_query.execute(request(
            product["dataset_id"], v02_sid, product_id, fields,
            max_nodes=1000, max_scan_bytes=60_000_000))
        total += len(read["rows"])
    assert total == 172
    assert rejected_products == {
        "p_83d329d1df6707e11c101566": "FIELD_NOT_DEFINED",
        "p_b3139543720b08b051b36da0": "FIELD_NOT_DEFINED",
        "p_da3b0f2d3c9d8d1afe38e5f2": "FIELD_NOT_DEFINED",
        "p_4dd691214f2ac2afd5998508": "FIELD_NOT_DEFINED",
    }


# ---------------------------------------------------------------------------
# 2. Typed projection preserves exact decimal / unknown / not_applicable
# ---------------------------------------------------------------------------
def test_typed_projection_preserves_exact_decimal_and_null_states(tmp_path):
    service, doc = base_document(tmp_path)
    subject = {"kind": "physical_object", "namespace": "p4a1.test", "id": "thing"}
    tabular = doc["outputs"][0]
    tabular["subject"] = subject
    tabular["definition_mode"] = "create"
    tabular["new_definition_declaration"] = {
        "semantic_code": "p4a1.tabular",
        "measurement_nature": "mixed_observation",
        "unit_code": "per_field",
        "definition_authority": "p4a1.test",
        "time_role": "observation",
        "field_definitions": [
            field("amount", "decimal", "vehicle"),
            field("note", "text", "text"),
            field("flag", "boolean", "boolean"),
        ],
    }
    tabular["payload"] = {"kind": "tabular_rows", "rows": [{
        "business_key": "typed",
        "subject": subject,
        "observation_time": known_day(2025, 12, 31),
        "values": {
            "amount": {"data_type": "decimal", "value_state": "valid_value",
                       "value": "0.100000000000000001"},
            "note": {"data_type": "text", "value_state": "unknown", "value": None},
            "flag": {"data_type": "boolean", "value_state": "not_applicable",
                     "value": None},
        },
    }]}

    scalar = copy.deepcopy(tabular)
    scalar["output_key"] = "p4a1_scalar"
    scalar["logical_domain"] = "observations"
    scalar["new_definition_declaration"] = {
        "semantic_code": "p4a1.scalar",
        "measurement_nature": "flow",
        "unit_code": "vehicle",
        "definition_authority": "p4a1.test",
        "time_role": "statistical_period",
    }
    scalar["payload"] = {"kind": "scalar_rows", "rows": [{
        "business_key": "scalar",
        "value_decimal": "157066",
        "value_state": "valid_value",
        "observation_time": known_year(2025),
    }]}
    doc["outputs"] = [tabular, scalar]
    sync_source_roles(doc)
    result = submit_ok(service, doc)
    ids = {item["output_key"]: item["product_id"]
           for item in result["output_results"]}
    query = ProductQuery(service)

    tabular_read = query.execute(request(
        doc["request_identity"]["dataset_id"], result["snapshot_id"],
        ids[tabular["output_key"]], ["note", "flag", "amount"],
        subject=subject, max_nodes=100))
    assert tabular_read["complete"] is True
    assert tabular_read["fields"] == ["amount", "flag", "note"]
    row = tabular_read["rows"][0]
    assert list(row["values"]) == ["amount", "flag", "note"]
    amount = row["values"]["amount"]
    assert amount["value"] == "0.100000000000000001"
    assert isinstance(amount["value"], str)
    assert amount["value_state"] == "valid_value"
    assert amount["unit"]["unit_code"] == "vehicle"
    assert amount["unit"]["resolved"] is True
    assert row["values"]["note"]["value"] is None
    assert row["values"]["note"]["value_state"] == "unknown"
    assert row["values"]["flag"]["value"] is None
    assert row["values"]["flag"]["value_state"] == "not_applicable"
    assert row["record_ref"]["logical_key"] == "typed"
    assert row["revision"]["revision_id"] == row["record_ref"]["revision_id"]

    scalar_read = query.execute(request(
        doc["request_identity"]["dataset_id"], result["snapshot_id"],
        ids[scalar["output_key"]], ["value_decimal"],
        subject=subject, max_nodes=100))
    assert len(scalar_read["rows"]) == 1
    scalar_cell = scalar_read["rows"][0]["values"]["value_decimal"]
    assert scalar_cell["value"] == "157066"
    assert scalar_cell["data_type"] == "decimal"
    assert scalar_cell["unit"]["unit_code"] == "vehicle"
    assert scalar_read["rows"][0]["business_time"]["precision"] == "year"


# ---------------------------------------------------------------------------
# 3. Business-time role/interval and complete IdentityRef matching
# ---------------------------------------------------------------------------
def test_business_time_interval_and_full_identity_subject(tmp_path):
    service, doc = base_document(tmp_path)
    subject = {"kind": "physical_object", "namespace": "p4a1.test", "id": "same"}
    other_namespace = {"kind": "physical_object", "namespace": "p4a1.other",
                       "id": "same"}
    output = doc["outputs"][0]
    output["subject"] = subject
    output["definition_mode"] = "create"
    output["new_definition_declaration"] = {
        "semantic_code": "p4a1.time",
        "measurement_nature": "flow",
        "unit_code": "per_field",
        "definition_authority": "p4a1.test",
        "time_role": "observation",
        "field_definitions": [field("amount", "decimal", "vehicle")],
    }

    def row(key, row_subject, observation_time, value):
        return {
            "business_key": key,
            "subject": row_subject,
            "observation_time": observation_time,
            "values": {"amount": {"data_type": "decimal",
                                  "value_state": "valid_value",
                                  "value": value}},
        }

    output["payload"] = {"kind": "tabular_rows", "rows": [
        row("day_ns1", subject, known_day(2025, 12, 31), "1"),
        row("year_ns2", other_namespace, known_year(2025), "2"),
        row("year_ns1", subject, known_year(2025), "3"),
        row("unknown_ns1", subject, unknown_time(), "4"),
    ]}
    sync_source_roles(doc)
    result = submit_ok(service, doc)
    product_id = result["output_results"][0]["product_id"]
    snapshot_id = result["snapshot_id"]
    dataset_id = doc["request_identity"]["dataset_id"]
    query = ProductQuery(service)

    year = query.execute(request(
        dataset_id, snapshot_id, product_id, ["amount"], subject=subject,
        business_time_range={"role": "observation", "start": "2025-01-01",
                             "end": "2025-12-31", "timezone": "Asia/Shanghai"},
        max_nodes=100))
    # Stable sort is by business-time start; the year row starts earlier and
    # therefore precedes the single-day row.
    assert [row["record_ref"]["logical_key"] for row in year["rows"]] == \
        ["year_ns1", "day_ns1"]
    assert year["business_time_range"]["start_utc"] == "2024-12-31T16:00:00Z"
    assert year["business_time_range"]["end_utc"] == "2025-12-31T16:00:00Z"
    assert [item["code"] for item in year["diagnostics"]] == ["BUSINESS_TIME_UNKNOWN"]
    assert year["complete"] is False
    assert all(row["subject"] == subject for row in year["rows"])

    one_day = query.execute(request(
        dataset_id, snapshot_id, product_id, ["amount"], subject=subject,
        business_time_range={"role": "observation", "start": "2025-12-31",
                             "end": "2025-12-31", "timezone": "Asia/Shanghai"},
        max_nodes=100))
    assert [row["record_ref"]["logical_key"] for row in one_day["rows"]] == ["day_ns1"]
    codes = {item["code"] for item in one_day["diagnostics"]}
    assert codes == {"BUSINESS_TIME_OVERLAP_QUERY_RANGE", "BUSINESS_TIME_UNKNOWN"}
    overlap = next(item for item in one_day["diagnostics"]
                   if item["code"] == "BUSINESS_TIME_OVERLAP_QUERY_RANGE")
    assert overlap["decision"] == "indeterminate"
    assert overlap["business_key"] == "year_ns1"

    # Same id but a different namespace is not the same IdentityRef.
    other = query.execute(request(
        dataset_id, snapshot_id, product_id, ["amount"],
        subject=other_namespace,
        business_time_range={"role": "observation", "start": "2025-01-01",
                             "end": "2025-12-31", "timezone": "Asia/Shanghai"},
        max_nodes=100))
    assert [row["record_ref"]["logical_key"] for row in other["rows"]] == ["year_ns2"]

    wrong_kind = query.execute(request(
        dataset_id, snapshot_id, product_id, ["amount"],
        subject={"kind": "instrument", "namespace": "p4a1.test", "id": "same"},
        max_nodes=100))
    assert wrong_kind["rows"] == []
    assert wrong_kind["result_status"] == "no_rows"

    with pytest.raises(ProductQueryError) as bad_zone:
        query.execute(request(
            dataset_id, snapshot_id, product_id, ["amount"], subject=subject,
            business_time_range={"role": "observation", "start": "2025-01-01",
                                 "end": "2025-12-31", "timezone": "No/Such_Zone"},
            max_nodes=100))
    assert bad_zone.value.code == "BUSINESS_TIMEZONE_UNKNOWN"


# ---------------------------------------------------------------------------
# 4. Stable pagination, query-bound cursor, fixed snapshot across HEAD change
# ---------------------------------------------------------------------------
def test_cursor_pagination_is_stable_across_instances_and_head_change(
        tmp_path, monkeypatch):
    service, doc = base_document(tmp_path)
    subject = {"kind": "physical_object", "namespace": "p4a1.test", "id": "page"}
    output = doc["outputs"][0]
    output["subject"] = subject
    output["definition_mode"] = "create"
    output["new_definition_declaration"] = {
        "semantic_code": "p4a1.pages",
        "measurement_nature": "flow",
        "unit_code": "per_field",
        "definition_authority": "p4a1.test",
        "time_role": "observation",
        "field_definitions": [field("amount", "decimal", "vehicle")],
    }
    output["payload"] = {"kind": "tabular_rows", "rows": [{
        "business_key": "row_" + str(index),
        "subject": subject,
        "observation_time": known_day(2025, 12, index),
        "values": {"amount": {"data_type": "decimal",
                              "value_state": "valid_value",
                              "value": str(index)}},
    } for index in range(1, 6)]}
    sync_source_roles(doc)
    first = submit_ok(service, doc)
    product_id = first["output_results"][0]["product_id"]
    snapshot_one = first["snapshot_id"]
    dataset_id = doc["request_identity"]["dataset_id"]
    query = ProductQuery(service)

    page_one = query.execute(request(
        dataset_id, snapshot_one, product_id, ["amount"], subject=subject,
        page_size=2, max_nodes=100))
    assert [row["record_ref"]["logical_key"] for row in page_one["rows"]] == \
        ["row_1", "row_2"]
    assert page_one["page"]["has_more"] is True
    assert page_one["page"]["total_rows"] == 5
    cursor = page_one["page"]["next_cursor"]
    assert cursor

    # HEAD moves to a new snapshot after the first page.  The cursor must stay
    # on the original fixed snapshot and must not pick up the new row.
    second_doc = copy.deepcopy(doc)
    second_doc["request_identity"]["request_id"] = "p4a1-pages-second"
    second_doc["expected_parent_snapshot_id"] = snapshot_one
    second_doc["outputs"][0].update(
        definition_mode="reuse",
        definition_ref=first["output_results"][0]["definition_ref"],
        new_definition_declaration=None,
        input_mode="explicit_increment",
        payload={"kind": "tabular_rows", "rows": [{
            "business_key": "row_6",
            "subject": subject,
            "observation_time": known_day(2025, 12, 6),
            "values": {"amount": {"data_type": "decimal",
                                  "value_state": "valid_value",
                                  "value": "6"}},
        }]})
    sync_source_roles(second_doc)
    second = submit_ok(service, second_doc)
    assert second["snapshot_id"] != snapshot_one

    # A new service/query instance resumes the cursor without in-memory state.
    resumed_service = new_service(service.root, tmp_path / "runtime_resumed")
    resumed = ProductQuery(resumed_service)
    page_two = resumed.execute(request(
        dataset_id, snapshot_one, product_id, ["amount"], subject=subject,
        page_size=2, max_nodes=100, cursor=cursor))
    assert page_two["snapshot_id"] == snapshot_one
    assert page_two["page"]["total_rows"] == 5
    assert page_two["page"]["remaining_rows"] == 3
    assert [row["record_ref"]["logical_key"] for row in page_two["rows"]] == \
        ["row_3", "row_4"]
    assert page_two["rows"][0]["record_ref"]["snapshot_id"] == snapshot_one
    page_three = resumed.execute(request(
        dataset_id, snapshot_one, product_id, ["amount"], subject=subject,
        page_size=2, max_nodes=100, cursor=page_two["page"]["next_cursor"]))
    assert [row["record_ref"]["logical_key"] for row in page_three["rows"]] == ["row_5"]
    assert page_three["page"]["has_more"] is False
    assert page_three["page"]["total_rows"] == 5
    assert page_three["complete"] is True

    # Changing any fixed query condition invalidates the cursor.
    with pytest.raises(ProductQueryError) as mismatch:
        resumed.execute(request(
            dataset_id, snapshot_one, product_id, ["amount"],
            subject={"kind": "physical_object", "namespace": "p4a1.other",
                     "id": "page"},
            page_size=2, max_nodes=100, cursor=cursor))
    assert mismatch.value.code == "CURSOR_QUERY_MISMATCH"

    # Every page re-checks the caller's read permission.
    unprivileged_service = new_service(
        service.root, tmp_path / "runtime_unprivileged", roles=set(),
        caller="p4a1-unprivileged")
    unprivileged = ProductQuery(unprivileged_service)
    with pytest.raises(PermissionError):
        unprivileged.execute(request(
            dataset_id, snapshot_one, product_id, ["amount"], subject=subject,
            page_size=2, max_nodes=100, cursor=cursor))


# ---------------------------------------------------------------------------
# 5. Actual pre-read scan budget: rejection is not an empty successful page
# ---------------------------------------------------------------------------
def test_scan_budget_preflight_rejects_before_payload_read(tmp_path, monkeypatch):
    service, doc = base_document(tmp_path)
    subject = {"kind": "physical_object", "namespace": "p4a1.test", "id": "budget"}
    output = doc["outputs"][0]
    output["subject"] = subject
    output["definition_mode"] = "create"
    output["new_definition_declaration"] = {
        "semantic_code": "p4a1.budget",
        "measurement_nature": "flow",
        "unit_code": "per_field",
        "definition_authority": "p4a1.test",
        "time_role": "observation",
        "field_definitions": [field("amount", "decimal", "vehicle")],
    }
    output["payload"] = {"kind": "tabular_rows", "rows": [{
        "business_key": "row_" + str(index),
        "subject": subject,
        "observation_time": known_day(2025, 12, index),
        "values": {"amount": {"data_type": "decimal",
                              "value_state": "valid_value",
                              "value": str(index)}},
    } for index in range(1, 4)]}
    sync_source_roles(doc)
    result = submit_ok(service, doc)
    product_id = result["output_results"][0]["product_id"]
    snapshot_id = result["snapshot_id"]
    dataset_id = doc["request_identity"]["dataset_id"]

    query = ProductQuery(service)

    def must_not_read(*args, **kwargs):
        pytest.fail("service.read was called before the scan budget was checked")

    monkeypatch.setattr(service, "read", must_not_read)
    with pytest.raises(ProductQueryError) as scan:
        query.execute(request(
            dataset_id, snapshot_id, product_id, ["amount"], subject=subject,
            max_nodes=10, max_scan_bytes=1))
    assert scan.value.code == "SCAN_BUDGET_EXCEEDED"
    required = scan.value.details["required_scan_bytes"]
    assert scan.value.details["max_scan_bytes"] == 1
    assert scan.value.details["file_range_pushdown"] is False
    assert scan.value.details["candidate_rows"] == 3
    assert scan.value.details["read_plan"]["selected_snapshot"][
        "metadata_reads"] == 3
    assert scan.value.details["read_plan"]["selected_snapshot"][
        "verification_payload_bytes"] > 0
    assert scan.value.details["read_plan"]["selected_snapshot"][
        "product_read_payload_bytes"] > 0
    assert scan.value.details["read_plan"]["dependencies"] == []

    with pytest.raises(ProductQueryError) as rows:
        query.execute(request(
            dataset_id, snapshot_id, product_id, ["amount"], subject=subject,
            max_nodes=2, max_scan_bytes=required))
    assert rows.value.code == "ROW_BUDGET_EXCEEDED"
    assert rows.value.details["candidate_rows"] == 3
    assert rows.value.details["max_nodes"] == 2

    with pytest.raises(ProductQueryError) as schema_error:
        query.execute(request(
            dataset_id, snapshot_id, product_id, ["amount"], subject=subject,
            page_size=MAX_PAGE_SIZE + 1, max_nodes=10,
            max_scan_bytes=required))
    assert schema_error.value.code == "READ_REQUEST_SCHEMA_INVALID"

    with pytest.raises(ProductQueryError) as hard_time:
        query.execute(request(
            dataset_id, snapshot_id, product_id, ["amount"], subject=subject,
            max_nodes=10, max_scan_bytes=required,
            max_execution_time_ms=1000))
    assert hard_time.value.code == "HARD_EXECUTION_BUDGET_UNSUPPORTED"

    # Add a newer, unrelated product/snapshot. The exact-budget read of the
    # older snapshot must not touch it.
    unrelated = copy.deepcopy(doc)
    unrelated["request_identity"]["request_id"] = "p4a1-unrelated-newer"
    unrelated["expected_parent_snapshot_id"] = snapshot_id
    unrelated["outputs"][0]["output_key"] = "p4a1_unrelated"
    unrelated["outputs"][0]["new_definition_declaration"]["semantic_code"] =         "p4a1.unrelated"
    unrelated["outputs"][0]["payload"]["rows"] = [{
        "business_key": "unrelated",
        "subject": subject,
        "observation_time": known_day(2025, 12, 10),
        "values": {"amount": {"data_type": "decimal",
                              "value_state": "valid_value", "value": "10"}},
    }]
    sync_source_roles(unrelated)
    unrelated_result = submit_ok(service, unrelated)
    unrelated_snapshot = json.loads(
        (service.root / "catalog/snapshots" /
         (unrelated_result["snapshot_id"] + ".json")).read_text("utf-8"))
    unrelated_entry = next(
        item for item in unrelated_snapshot["files"]
        if item["output_key"] == "p4a1_unrelated")

    monkeypatch.undo()
    events = []
    real_read_bytes = Path.read_bytes

    def traced_read_bytes(self):
        data = real_read_bytes(self)
        events.append((str(self), len(data)))
        return data

    monkeypatch.setattr(Path, "read_bytes", traced_read_bytes)
    valid = query.execute(request(
        dataset_id, snapshot_id, product_id, ["amount"], subject=subject,
        max_nodes=3, max_scan_bytes=required))
    monkeypatch.undo()
    actual_bytes = sum(size for _, size in events)
    assert valid["result_status"] == "rows"
    assert valid["complete"] is True
    assert valid["budget"]["preflight"] == "before_payload_read"
    assert valid["budget"]["within_budget"] is True
    assert valid["budget"]["required_scan_bytes"] == required
    assert valid["budget"]["max_scan_bytes"] == required
    assert valid["budget"]["candidate_rows"] == 3
    assert valid["budget"]["file_range_pushdown"] is False
    assert valid["budget"]["scope"] == \
        "selected_snapshot_all_files_plus_product_read_plus_declared_dependencies"
    assert valid["budget"]["unrelated_snapshots_scanned"] is False
    assert valid["budget"]["read_plan"]["selected_snapshot"][
        "metadata_reads"] == 3
    assert valid["budget"]["read_plan"]["dependencies"] == []
    assert actual_bytes == required, (actual_bytes, required, events)
    assert not any(unrelated_entry["file_relpath"] in path for path, _ in events)
    assert not any("p4a1-unrelated-newer" in path for path, _ in events)


# ---------------------------------------------------------------------------
# 6. Historical eligibility precedes revision selection; capability truth
# ---------------------------------------------------------------------------
def test_historical_eligibility_precedes_revision_and_capability_truth(
        tmp_path, monkeypatch):
    service, doc = base_document(tmp_path)
    output = doc["outputs"][0]
    output["definition_mode"] = "create"
    output["new_definition_declaration"] = {
        "semantic_code": "p4a1.history",
        "measurement_nature": "flow",
        "unit_code": "vehicle",
        "definition_authority": "p4a1.test",
        "time_role": "statistical_period",
    }
    output["payload"] = {"kind": "scalar_rows", "rows": [{
        "business_key": "history_key",
        "value_decimal": "157066",
        "value_state": "valid_value",
        "observation_time": known_year(2023),
    }]}
    doc["source_bundle"]["public_time"] = known_day(2020, 1, 2)
    sync_source_roles(doc)
    first = submit_ok(service, doc)
    product_id = first["output_results"][0]["product_id"]
    snapshot_one = first["snapshot_id"]
    dataset_id = doc["request_identity"]["dataset_id"]

    original = service.read(product_id, snapshot_id=snapshot_one)["rows"][0]
    correction = copy.deepcopy(doc)
    correction["request_identity"]["request_id"] = "p4a1-correction"
    correction["expected_parent_snapshot_id"] = snapshot_one
    correction["source_bundle"]["public_time"] = known_day(2022, 1, 2)
    correction["outputs"][0]["input_mode"] = "source_correction"
    correction["outputs"][0]["payload"]["rows"][0]["value_decimal"] = "157067"
    sync_source_roles(correction)
    correction["source_bundle"]["product_service"] = {
        "version": SERVICE_VERSION,
        "outputs": {correction["outputs"][0]["output_key"]: {
            "read_dependencies": [],
            "revisions": {"history_key": {
                "previous": original["record_ref"],
                "reason": "P4a1 synthetic source correction",
            }},
        }},
    }
    second = submit_ok(service, correction)
    snapshot_two = second["snapshot_id"]
    corrected = service.read(product_id, snapshot_id=snapshot_two)["rows"][0]

    withdrawal = copy.deepcopy(correction)
    withdrawal["request_identity"]["request_id"] = "p4a1-withdrawal"
    withdrawal["expected_parent_snapshot_id"] = snapshot_two
    withdrawal["source_bundle"]["public_time"] = known_day(2024, 1, 2)
    withdrawal["outputs"][0]["input_mode"] = "withdrawal"
    sync_source_roles(withdrawal)
    withdrawal["source_bundle"]["product_service"] = {
        "version": SERVICE_VERSION,
        "outputs": {withdrawal["outputs"][0]["output_key"]: {
            "read_dependencies": [],
            "revisions": {"history_key": {
                "previous": corrected["record_ref"],
                "reason": "P4a1 synthetic withdrawal",
            }},
        }},
    }
    third = submit_ok(service, withdrawal)
    snapshot_three = third["snapshot_id"]
    query = ProductQuery(service)

    read_calls, storage_reads = [], []
    real_read = service.read

    def counted_read(*args, **kwargs):
        read_calls.append(1)
        return real_read(*args, **kwargs)

    real_storage_read = service.engine.read_product

    def counted_storage(*args, **kwargs):
        storage_reads.append(1)
        return real_storage_read(*args, **kwargs)

    monkeypatch.setattr(service, "read", counted_read)
    monkeypatch.setattr(service.engine, "read_product", counted_storage)
    before_correction = query.execute(request(
        dataset_id, snapshot_two, product_id, ["value_decimal"],
        history_mode="market_known_at",
        knowledge_cutoff=known_day(2021, 1, 2),
        max_nodes=10))
    assert before_correction["rows"][0]["values"]["value_decimal"]["value"] == "157066"
    assert before_correction["rows"][0]["eligibility"]["decision"] == "eligible"
    assert len(read_calls) == 1
    assert len(storage_reads) == 1

    after_correction = query.execute(request(
        dataset_id, snapshot_two, product_id, ["value_decimal"],
        history_mode="market_known_at",
        knowledge_cutoff=known_day(2023, 1, 2),
        max_nodes=10))
    assert after_correction["rows"][0]["values"]["value_decimal"]["value"] == "157067"

    before_publication = query.execute(request(
        dataset_id, snapshot_two, product_id, ["value_decimal"],
        history_mode="market_known_at",
        knowledge_cutoff=known_day(2019, 1, 2),
        max_nodes=10))
    assert before_publication["rows"] == []
    assert {item["decision"] for item in before_publication["diagnostics"]} == \
        {"ineligible"}

    withdrawn = query.execute(request(
        dataset_id, snapshot_three, product_id, ["value_decimal"],
        max_nodes=10))
    assert withdrawn["rows"] == []
    assert withdrawn["diagnostics"]
    assert any(item.get("reason") == "WITHDRAWN_AT_PERSPECTIVE"
               for item in withdrawn["diagnostics"])

    after_withdrawal = query.execute(request(
        dataset_id, snapshot_three, product_id, ["value_decimal"],
        history_mode="market_known_at",
        knowledge_cutoff=known_day(2023, 1, 2),
        max_nodes=10))
    assert after_withdrawal["rows"][0]["values"]["value_decimal"]["value"] == "157067"

    capability = query.capabilities()
    assert capability["operations"]["read_product"]["supported"] is True
    assert capability["operations"]["read_company_context"]["supported"] is True
    assert capability["operations"]["read_event_timeline"]["supported"] is True
    assert capability["read_product"]["history_modes"]["system_held_at"]["supported"] is False
    assert capability["read_product"]["history_modes"]["system_held_at"]["error_code"] == \
        "INSTANCE_HOLDING_SCOPE_NOT_IMPLEMENTED"
    assert capability["read_product"]["budget"]["hard_execution_time_ms"] is False
    assert capability["read_product"]["budget"]["file_range_pushdown"] is False
    assert capability["read_product"]["budget"]["unrelated_snapshots_scanned"] is False
    assert capability["read_product"]["budget"]["counted_actual_objects"][
        "selected_snapshot_verification"] is True
    assert capability["read_product"]["pagination"]["max_page_size"] == MAX_PAGE_SIZE
    assert capability["scope"]["p4_complete"] is False
    assert capability["scope"]["p4a2_instance_holding"] is False
    assert capability["scope"]["p4b_operations"] == "implemented_read_only_scope"
    assert capability["scope"]["p4b_complete"] is False
    assert capability["scope"]["p5"] is False

    with pytest.raises(ProductQueryError) as system_held:
        query.execute(request(
            dataset_id, snapshot_three, product_id, ["value_decimal"],
            history_mode="system_held_at",
            knowledge_cutoff=known_day(2023, 1, 2),
            held_scope="received_structured",
            usable_stage="published_readable",
            max_nodes=10))
    assert system_held.value.code == "INSTANCE_HOLDING_SCOPE_NOT_IMPLEMENTED"

    with pytest.raises(ProductQueryError) as unsupported:
        query.execute({"operation": "read_company_context"})
    assert unsupported.value.code == "READ_REQUEST_SCHEMA_INVALID"

    with pytest.raises(ProductQueryError) as dataset:
        query.execute(request(
            "wrong_dataset", snapshot_three, product_id, ["value_decimal"],
            max_nodes=10))
    assert dataset.value.code == "DATASET_MISMATCH"

# ---------------------------------------------------------------------------
# 7. Metadata authorization, actual time-role matching, session_date timezone
#    and DST gap/fold rejection
# ---------------------------------------------------------------------------
def test_authorization_time_role_session_date_and_dst(tmp_path):
    service, doc = base_document(tmp_path)
    with_source = {"kind": "physical_object", "namespace": "p4a1.test",
                   "id": "with_source"}
    no_source = {"kind": "physical_object", "namespace": "p4a1.test",
                 "id": "no_source"}
    output = doc["outputs"][0]
    output["subject"] = with_source
    output["definition_mode"] = "create"
    output["new_definition_declaration"] = {
        "semantic_code": "p4a1.session_date",
        "measurement_nature": "mixed_observation",
        "unit_code": "per_field",
        "definition_authority": "p4a1.test",
        "time_role": "observation",
        "field_definitions": [field("session_date", "text", "date")],
    }
    output["payload"] = {"kind": "tabular_rows", "rows": [
        {"business_key": "with_source", "subject": with_source,
         "observation_time": known_day(2025, 12, 31),
         "values": {"session_date": {"data_type": "text",
                                     "value_state": "valid_value",
                                     "value": "2025-12-31"}}},
        {"business_key": "no_source", "subject": no_source,
         "observation_time": {"status": "unknown", "precision": "unknown",
                              "earliest_utc": None,
                              "latest_exclusive_utc": None,
                              "source_timezone": ""},
         "values": {"session_date": {"data_type": "text",
                                     "value_state": "valid_value",
                                     "value": "2025-12-31"}}},
    ]}
    sync_source_roles(doc)
    result = submit_ok(service, doc)
    product_id = result["output_results"][0]["product_id"]
    snapshot_id = result["snapshot_id"]
    dataset_id = doc["request_identity"]["dataset_id"]
    query = ProductQuery(service)

    # A requested role that is not declared by the fixed contract is not a
    # rename of observation_time.
    with pytest.raises(ProductQueryError) as role:
        query.execute(request(
            dataset_id, snapshot_id, product_id, ["session_date"],
            subject=with_source,
            business_time_range={"role": "statistical_period",
                                 "start": "2025-01-01", "end": "2025-12-31",
                                 "timezone": "Asia/Shanghai"},
            max_nodes=10))
    assert role.value.code == "BUSINESS_TIME_ROLE_MISMATCH"
    assert role.value.details["requested_role"] == "statistical_period"
    assert role.value.details["available_roles"] == ["observation", "session_date"]

    # The source date has an explicit source timezone and becomes a fixed
    # known interval. The row without a source timezone never borrows the
    # caller's query timezone.
    known = query.execute(request(
        dataset_id, snapshot_id, product_id, ["session_date"],
        subject=with_source,
        business_time_range={"role": "session_date", "start": "2025-12-31",
                             "end": "2025-12-31", "timezone": "Asia/Shanghai"},
        max_nodes=10))
    assert len(known["rows"]) == 1
    assert known["rows"][0]["business_time"] == known_day(2025, 12, 31)
    for zone in ("Asia/Shanghai", "America/Los_Angeles"):
        unknown = query.execute(request(
            dataset_id, snapshot_id, product_id, ["session_date"],
            subject=no_source,
            business_time_range={"role": "session_date", "start": "2025-12-31",
                                 "end": "2025-12-31", "timezone": zone},
            max_nodes=10))
        assert unknown["rows"] == []
        assert [item["code"] for item in unknown["diagnostics"]] ==             ["BUSINESS_TIME_UNKNOWN"]
        assert unknown["diagnostics"][0]["decision"] == "indeterminate"
        assert "query_timezone" not in unknown["diagnostics"][0]

    # DST gap and fold must be rejected, not silently folded.
    for start, end, code in [
        ("2025-03-09T02:30:00", "2025-03-09T02:30:00",
         "BUSINESS_TIME_NONEXISTENT_LOCAL"),
        ("2025-11-02T01:30:00", "2025-11-02T01:30:00",
         "BUSINESS_TIME_AMBIGUOUS_LOCAL"),
    ]:
        with pytest.raises(ProductQueryError) as dst:
            query.execute(request(
                dataset_id, snapshot_id, product_id, ["session_date"],
                subject=with_source,
                business_time_range={"role": "observation", "start": start,
                                     "end": end,
                                     "timezone": "America/Los_Angeles"},
                max_nodes=10))
        assert dst.value.code == code

    # Metadata-level source authorization precedes FIELD_NOT_DEFINED and its
    # available_fields list.
    denied_policy = dict(SOURCE_POLICY)
    denied_policy.update({"may_read": False, "may_read_evidence": False})
    denied_service = new_service(
        service.root, tmp_path / "runtime_denied", roles=READ_ROLES,
        caller="p4a1-denied", source_policy=denied_policy)
    denied = ProductQuery(denied_service)
    for fields in (["session_date"], ["not_declared"]):
        with pytest.raises(PermissionError) as permission:
            denied.execute(request(
                dataset_id, snapshot_id, product_id, fields,
                subject=with_source, max_nodes=10))
        assert "SOURCE_READ_PERMISSION_MISSING" in str(permission.value)

