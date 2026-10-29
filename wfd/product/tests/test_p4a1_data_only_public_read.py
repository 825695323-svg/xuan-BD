"""P4A1 data_only public context reads: four operations, pure data projection.

The fixture is an explicitly synthetic WFD business store.  It is not real
financial data and contains no source/evidence/BD processing metadata.  The
three groups mirror the assigned acceptance scope:

A. real machine process, four operations, synthetic values/identity/refs, no BD
   fields, trace denied;
B. company relation historical eligibility, rule validity/conflict, plan vs
   actual events;
C. cross-process page stability, changed qualification/field cursor rejection,
   outer/inner mismatch, read-permission priority and budget truncation.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_data_service import DATA_ONLY_PROTOCOL, WFDDataOnlyService
from wfd_sdk.product_holdings import HoldingLedger
from wfd_sdk.product_query import (
    PROTOCOL_VERSION_P4B, ProductQuery, ProductQueryError,
)
from wfd_sdk import product_machine


HERE = Path(__file__).resolve().parents[1]
NAMESPACE = "wfd.p4a1.synthetic"
DATASET = "wfd_p4a1_synthetic"
ALL_ROLES = {"read", "register", "submit", "publish"}
UNITS = {
    "count": {"dimension": "quantity"},
    "text": {"dimension": "text"},
    "identifier": {"dimension": "identifier"},
    "cny": {"dimension": "money"},
    "cny_per_share": {"dimension": "money_per_share"},
}
ENTITY = {"kind": "entity", "namespace": NAMESPACE, "id": "company_synthetic"}
INSTRUMENT = {"kind": "instrument", "namespace": NAMESPACE, "id": "instrument_synthetic"}
MARKET = {"kind": "market", "namespace": NAMESPACE, "id": "market_synthetic"}
REGION = {"kind": "region", "namespace": NAMESPACE, "id": "region_synthetic"}
UNKNOWN = {"kind": "entity", "namespace": NAMESPACE, "id": "unknown_synthetic"}
FUTURE = {"kind": "entity", "namespace": NAMESPACE, "id": "future_synthetic"}


def day(year, month, day_of_month):
    start = datetime(year, month, day_of_month, tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    return {"status": "known", "precision": "day",
            "earliest_utc": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "latest_exclusive_utc": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source_timezone": "UTC"}


def period(start_year, end_year):
    return {"status": "known", "precision": "interval",
            "earliest_utc": f"{start_year}-01-01T00:00:00Z",
            "latest_exclusive_utc": f"{end_year}-01-01T00:00:00Z",
            "source_timezone": "UTC"}


def unknown_interval():
    return {"status": "unknown", "precision": "unknown",
            "earliest_utc": None, "latest_exclusive_utc": None,
            "source_timezone": "UTC"}


def semantic_context(nature):
    return {
        "version": "wfd.semantic-context/1.0",
        "content_nature": nature,
        "time": {"period_type": "natural", "frequency": "year", "interval": "closed"},
        "statistical": {"price_basis": "nominal", "period_aggregation": "period"},
        "financial": {"consolidation_scope": "not_applicable",
                      "price_adjustment": {"direction": "raw"}},
    }


def field(code, data_type, unit, role="observation"):
    return {"field_code": code, "data_type": data_type, "unit_code": unit,
            "measurement_nature": "flow", "time_role": role}


def declaration(semantic_code, nature, *, measurement="flow", unit="not_applicable",
                authority="wfd.p4a1.synthetic", role="observation", fields=None,
                publisher="synthetic_publisher"):
    context = semantic_context(nature)
    context["source"] = {
        "definition_authority": authority,
        "publisher_ref": {"kind": "organization", "namespace": NAMESPACE,
                          "id": publisher},
    }
    value = {"semantic_code": semantic_code, "measurement_nature": measurement,
             "unit_code": unit, "definition_authority": authority,
             "time_role": role, "semantic_context": context}
    if fields:
        value["field_definitions"] = fields
    return value


def output(key, subject, definition, payload, domain="observations"):
    return {
        "output_key": key,
        "logical_domain": domain,
        "subject": subject,
        "definition_mode": "create",
        "definition_ref": None,
        "definition": definition,
        "input_mode": "partial_observation",
        "coverage": {"scope": {"synthetic": True,
                               "fixture": "p4a1_data_only_public_read"},
                     "basis": "observed_partial", "completeness": "partial",
                     "absence_means": "unknown"},
        "payload": payload,
    }


def relation_rows():
    def edge(key, left, right, rel_type, effective, public):
        return {"business_key": key, "subject": left, "object": right,
                "relation_type": rel_type, "effective_period": effective,
                "public_time": public}
    return [
        edge("rel_company_instrument", ENTITY, INSTRUMENT, "listed_as",
             period(2020, 2030), day(2020, 1, 2)),
        edge("rel_instrument_market", INSTRUMENT, MARKET, "traded_on",
             period(2020, 2030), day(2020, 1, 2)),
        edge("rel_market_region", MARKET, REGION, "located_in",
             period(2020, 2030), day(2020, 1, 2)),
        edge("rel_unknown", ENTITY, UNKNOWN, "related_to",
             unknown_interval(), day(2020, 1, 2)),
        edge("rel_future_public", ENTITY, FUTURE, "related_to",
             period(2020, 2030), day(2030, 1, 2)),
    ]


def fixture_document():
    financial = output("fin", ENTITY, declaration(
        "synthetic.company.financial.revenue", "observed_fact",
        measurement="flow", unit="per_field", role="observation",
        fields=[field("revenue", "decimal", "cny")]), {
        "kind": "tabular_rows", "rows": [{
            "business_key": "fin_2025", "subject": ENTITY,
            "observation_time": day(2025, 6, 1),
            "values": {"revenue": {"data_type": "decimal",
                                   "value_state": "valid_value", "value": "100"}},
        }]})
    quote = output("quote", INSTRUMENT, declaration(
        "synthetic.market.close", "observed_fact", measurement="stock",
        unit="per_field", fields=[field("close_price", "decimal", "cny_per_share")]), {
        "kind": "tabular_rows", "rows": [{
            "business_key": "quote_2025", "subject": INSTRUMENT,
            "observation_time": day(2025, 6, 1),
            "values": {"close_price": {"data_type": "decimal",
                                       "value_state": "valid_value", "value": "11.41"}},
        }]})
    # A value product whose semantic_code contains "rule" but whose business
    # declaration is observed_fact.  It must not be classified as a rule.
    decoy = output("rule_decoy", ENTITY, declaration(
        "synthetic.rule.decoy", "observed_fact", measurement="flow",
        unit="per_field", fields=[field("amount", "decimal", "cny")]), {
        "kind": "tabular_rows", "rows": [{
            "business_key": "decoy_2025", "subject": ENTITY,
            "observation_time": day(2025, 6, 1),
            "values": {"amount": {"data_type": "decimal",
                                  "value_state": "valid_value", "value": "7"}},
        }]})
    relations = output("relations", ENTITY, declaration(
        "synthetic.relation.company", "observed_fact", measurement="relation",
        role="validity"), {"kind": "relation_edges", "rows": relation_rows()},
        domain="foundation")
    rules = []
    for key, authority in (("rule_a", "rule.authority.a"),
                           ("rule_b", "rule.authority.b")):
        rules.append(output(key, ENTITY, declaration(
            "synthetic.rule.tax", "definition_rule", measurement="relation",
            authority=authority, role="validity",
            fields=[field("rule_code", "text", "text", role="validity"),
                    field("rule_text", "text", "text", role="validity")]), {
            "kind": "relation_edges", "rows": [{
                "business_key": key + "_r1", "subject": ENTITY, "object": INSTRUMENT,
                "relation_type": "applies_to", "effective_period": period(2020, 2030),
                "public_time": day(2020, 1, 2),
                "values": {
                    "rule_code": {"data_type": "text", "value_state": "valid_value",
                                  "value": "R-1"},
                    "rule_text": {"data_type": "text", "value_state": "valid_value",
                                  "value": key},
                },
            }]}, domain="foundation"))
    events = []
    for key, row_nature, declaration_nature, event_id, when, expected, status in (
            ("event_plan", "plan", "plan", "ev_plan", day(2025, 1, 2),
             day(2025, 6, 1), "planned"),
            ("event_actual", "outcome", "observed_fact", "ev_actual", day(2025, 7, 1),
             day(2025, 7, 1), "completed")):
        events.append(output(key, ENTITY, declaration(
            "synthetic.company.event." + key, declaration_nature, measurement="event",
            role="event", fields=[field("stage", "text", "text", role="event")]), {
            "kind": "event_records", "rows": [{
                "event_id": event_id, "subject": ENTITY, "event_type": "dividend",
                "content_nature": row_nature, "event_time": when, "public_time": when,
                "expected_time": expected, "status": status,
                "values": {"stage": {"data_type": "text", "value_state": "valid_value",
                                     "value": status}},
            }]}, domain="events"))
    return {
        "protocol_version": DATA_ONLY_PROTOCOL,
        "request_identity": {"dataset_id": DATASET,
                             "trusted_actor_namespace": NAMESPACE,
                             "request_id": "p4a1-synthetic-fixture",
                             "submission_digest": "sha256:" + "0" * 64},
        "intent": "submit",
        "producer_namespace": NAMESPACE,
        "expected_parent_snapshot_id": None,
        "outputs": [financial, quote, decoy, relations, *rules, *events],
    }


def _service(tmp_path, roles=ALL_ROLES):
    engine = WFDDuckDBPrototype(
        tmp_path / "store", load_protocol_validator(HERE / "protocol"),
        runtime_root=tmp_path / "runtime", sandbox=False, writer_host="p4a1-test")
    return WFDDataOnlyService(
        engine, caller_roles=roles, caller_id="p4a1-test", unit_registry=UNITS,
        trusted_actor_namespaces={NAMESPACE})


def _machine_config(tmp_path, service, *, roles=("read",)):
    config = {
        "protocol_version": product_machine.MACHINE_CONFIG_PROTOCOL,
        "connection_id": "p4a1-machine",
        "profile": "data_only",
        "store": str(service.root),
        "runtime": str(tmp_path / "machine-runtime"),
        "project_root": str(HERE),
        "protocol_root": str(HERE / "protocol"),
        "caller": {"caller_id": "p4a1-machine-read",
                   "trusted_actor_namespace": NAMESPACE,
                   "roles": list(roles)},
        "units": UNITS,
    }
    path = tmp_path / "machine-config.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    return path


@pytest.fixture()
def synthetic_store(tmp_path):
    service = _service(tmp_path)
    result = service.submit(fixture_document())
    assert result["state"] == "published_formal", result
    pids = {item["output_key"]: item["product_id"]
            for item in result["output_results"]}
    fixture = {
        "tmp_path": tmp_path,
        "service": service,
        "snapshot_id": result["snapshot_id"],
        "dataset_id": DATASET,
        "product_ids": pids,
        "config": _machine_config(tmp_path, service),
    }
    return fixture


def machine_call(config, operation, arguments, *, env=None):
    request = {"protocol_version": product_machine.MACHINE_PROTOCOL,
               "request_id": "p4a1-" + operation.replace("_", "-"),
               "operation": operation, "arguments": arguments}
    process_env = dict(os.environ)
    process_env.update(env or {})
    completed = subprocess.run(
        [sys.executable, "-m", "wfd_sdk.product_machine", "--config", str(config)],
        input=json.dumps(request).encode("utf-8"), stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, cwd=HERE, env=process_env, timeout=90)
    assert completed.returncode == 0, completed.stderr.decode("utf-8", "replace")
    return json.loads(completed.stdout.decode("utf-8"))


def query_request(snapshot_id, operation, *, history_mode="snapshot_contents",
                  cutoff=None, held_scope=None, usable_stage=None, **overrides):
    value = {
        "protocol_version": PROTOCOL_VERSION_P4B,
        "dataset_id": DATASET,
        "operation": operation,
        "snapshot_id": snapshot_id,
        "history_mode": history_mode,
        "knowledge_cutoff": cutoff,
        "held_scope": held_scope,
        "usable_stage": usable_stage,
        "subject": ENTITY,
        "max_nodes": 1000,
        "page_size": 100,
        "max_scan_bytes": 80_000_000,
        "cursor": None,
        "business_time_range": None,
    }
    value.update(overrides)
    return value


BD_KEYS = {
    "source_binding", "evidence_refs", "evidence", "source_ids", "source_id",
    "source_roles", "original_path", "original_local_path", "local_path",
    "file_path", "storage_path", "processing_record", "processing_evidence",
    "processing", "derived_lineage", "lineage", "bd_ref", "bd_locator",
    "locator", "record_locator", "raw_source", "source_url", "license",
}


def _find_bd_keys(value, path="$"):
    problems = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key in BD_KEYS:
                problems.append(path + "." + key)
            problems.extend(_find_bd_keys(child, path + "." + str(key)))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            problems.extend(_find_bd_keys(child, f"{path}[{index}]"))
    return problems


def _contract_refs(item):
    refs = item.get("contract_refs") or {}
    assert set(refs) == {"semantic", "read_layout", "algorithm_dependency",
                         "update_release"}, refs
    assert item.get("contract_bundle_ref", {}).get("digest", "").startswith("sha256:")
    return refs


# ---------------------------------------------------------------------------
# A. real machine process, four operations, pure data, trace denied
# ---------------------------------------------------------------------------
def test_machine_process_four_data_only_ops_are_pure_and_trace_denied(
        synthetic_store):
    snapshot_id = synthetic_store["snapshot_id"]
    config = synthetic_store["config"]
    pids = synthetic_store["product_ids"]

    caps = machine_call(config, "capabilities", {})
    assert caps["ok"] is True, caps
    for name in ("read_company_context", "read_relation_graph",
                 "read_applicable_rules", "read_event_timeline"):
        assert name in caps["result"]["operations"], name
    assert "trace" not in caps["result"]["operations"]
    query_caps = caps["result"]["query_capabilities"]
    assert set(query_caps["supported_operations"]) == {
        "read_product", "read_company_context", "read_relation_graph",
        "read_applicable_rules", "read_event_timeline"}
    assert query_caps["outer_inner_must_match"] is True
    assert query_caps["trace_evidence"]["supported"] is False
    direct_caps = ProductQuery(synthetic_store["service"]).capabilities()
    assert direct_caps["operations"]["trace_evidence"]["supported"] is False
    assert direct_caps["operations"]["trace_evidence"]["scope"] == "BD_not_WFD"
    assert direct_caps["projection"]["source_binding"] == "omitted"
    assert direct_caps["projection"]["evidence_refs"] == "omitted"

    company = machine_call(config, "read_company_context", {"request": query_request(
        snapshot_id, "read_company_context", max_depth=2, page_size=50)})
    assert company["ok"] is True, company
    context = company["result"]
    assert context["operation"] == "read_company_context"
    assert context["snapshot_id"] == snapshot_id
    assert _find_bd_keys(context) == []
    assert context["coverage"]["identity_kinds"] == ["entity", "instrument"]
    rows = context["rows"]
    financial = [row for row in rows if row["product_id"] == pids["fin"]][0]
    quote = [row for row in rows if row["product_id"] == pids["quote"]][0]
    assert financial["subject"] == ENTITY and quote["subject"] == INSTRUMENT
    assert financial["values"]["revenue"]["value"] == "100"
    assert quote["values"]["close_price"]["value"] == "11.41"
    assert financial["record_id"] == "fin_2025"
    assert financial["record_version"].startswith("r_")
    assert financial["record_ref"]["revision_id"] == financial["record_version"]
    assert financial["definition_authority"] == "wfd.p4a1.synthetic"
    assert financial["publisher"]["id"] == "synthetic_publisher"
    assert _contract_refs(financial)
    assert _contract_refs(quote)

    graph = machine_call(config, "read_relation_graph", {"request": query_request(
        snapshot_id, "read_relation_graph", max_depth=3, max_edges=100)})
    assert graph["ok"] is True, graph
    graph_result = graph["result"]
    assert _find_bd_keys(graph_result) == []
    node_ids = {node["identity"]["id"] for node in graph_result["nodes"]}
    assert {"company_synthetic", "instrument_synthetic", "market_synthetic",
            "region_synthetic"} <= node_ids
    assert "unknown_synthetic" not in node_ids
    unknown_edges = [edge for edge in graph_result["edges"]
                     if edge["object"]["id"] == "unknown_synthetic"]
    assert unknown_edges and unknown_edges[0]["connectivity"] == "indeterminate"
    assert _contract_refs(graph_result["edges"][0])
    assert graph_result["edges"][0]["record_id"]
    assert graph_result["edges"][0]["record_version"]

    rules = machine_call(config, "read_applicable_rules", {"request": query_request(
        snapshot_id, "read_applicable_rules", rule_codes=["R-1"])})
    assert rules["ok"] is True, rules
    rule_result = rules["result"]
    assert _find_bd_keys(rule_result) == []
    assert len(rule_result["rules"]) == 2
    assert {row["rule"]["definition_authority"] for row in rule_result["rules"]} == {
        "rule.authority.a", "rule.authority.b"}
    assert all(row["rule"]["conflict"] is True for row in rule_result["rules"])
    assert rule_result["rule_conflicts"][0]["rule_code"] == "R-1"
    assert rule_result["rule_semantics"]["priority_engine"] == "not_implemented"
    assert rule_result["rule_semantics"]["expression_framework_added"] is False
    assert not any(row["product_id"] == pids["rule_decoy"]
                   for row in rule_result["rules"])

    events = machine_call(config, "read_event_timeline", {"request": query_request(
        snapshot_id, "read_event_timeline", event_types=["dividend"])})
    assert events["ok"] is True, events
    event_result = events["result"]
    assert _find_bd_keys(event_result) == []
    assert len(event_result["rows"]) == 2
    assert {row["event"]["content_nature"] for row in event_result["rows"]} == {
        "plan", "outcome"}
    assert {row["event"]["status"] for row in event_result["rows"]} == {
        "planned", "completed"}

    # trace is not a data_only machine operation and direct query rejects it.
    denied = machine_call(config, "trace", {"product_id": pids["fin"],
                                            "snapshot_id": snapshot_id})
    assert denied["ok"] is False
    assert denied["error"]["code"] == "EXTERNAL_METADATA_OPERATION_UNSUPPORTED"
    direct = ProductQuery(synthetic_store["service"])
    with pytest.raises(ProductQueryError) as trace_error:
        direct.execute(query_request(snapshot_id, "trace_evidence",
                                     product_id=pids["fin"]))
    assert trace_error.value.code == "QUERY_OPERATION_UNSUPPORTED"
    assert "BD" in trace_error.value.message


# ---------------------------------------------------------------------------
# B. historical relation eligibility, rule validity/conflict, plan/actual
# ---------------------------------------------------------------------------
def test_company_relation_rule_history_and_event_plan_actual(synthetic_store):
    query = ProductQuery(synthetic_store["service"])
    snapshot_id = synthetic_store["snapshot_id"]
    pids = synthetic_store["product_ids"]

    observation_day = {"role": "observation", "start": "2025-06-01",
                       "end": "2025-06-01", "timezone": "UTC"}
    company = query.execute(query_request(
        snapshot_id, "read_company_context", max_depth=2,
        business_time_range=observation_day))
    financial = [row for row in company["rows"] if row["product_id"] == pids["fin"]][0]
    quote = [row for row in company["rows"] if row["product_id"] == pids["quote"]][0]
    # Financial belongs to the company; the quote belongs to the instrument.
    assert financial["subject"] == ENTITY
    assert quote["subject"] == INSTRUMENT
    assert "close_price" not in financial["values"]
    assert "revenue" not in quote["values"]

    validity_day = {"role": "validity", "start": "2025-06-01",
                    "end": "2025-06-01", "timezone": "UTC"}
    graph = query.execute(query_request(
        snapshot_id, "read_relation_graph", history_mode="market_known_at",
        cutoff=day(2025, 6, 2), max_depth=3, max_edges=100,
        business_time_range=validity_day))
    node_ids = {node["identity"]["id"] for node in graph["nodes"]}
    assert node_ids == {"company_synthetic", "instrument_synthetic",
                        "market_synthetic", "region_synthetic"}
    assert "future_synthetic" not in node_ids
    assert "unknown_synthetic" not in node_ids
    assert any(edge["connectivity"] == "indeterminate"
               and edge["object"]["id"] == "unknown_synthetic"
               for edge in graph["edges"])
    assert all(edge["connectivity"] == "confirmed" for edge in graph["edges"]
               if edge["object"]["id"] != "unknown_synthetic")

    rules = query.execute(query_request(
        snapshot_id, "read_applicable_rules", history_mode="market_known_at",
        cutoff=day(2025, 6, 2), rule_codes=["R-1"],
        business_time_range=validity_day))
    assert len(rules["rules"]) == 2
    assert rules["rule_conflicts"][0]["basis_count"] == 2
    assert len({row["definition_ref"]["digest"] for row in rules["rules"]}) == 2
    assert all(row["rule"]["conflict"] is True for row in rules["rules"])
    assert all(row["record_id"] and row["record_version"] for row in rules["rules"])
    expired = query.execute(query_request(
        snapshot_id, "read_applicable_rules", rule_codes=["R-1"],
        business_time_range={"role": "validity", "start": "2031-01-01",
                             "end": "2031-01-01", "timezone": "UTC"}))
    assert expired["rules"] == []

    before_public = query.execute(query_request(
        snapshot_id, "read_applicable_rules", history_mode="market_known_at",
        cutoff=day(2019, 12, 31), rule_codes=["R-1"]))
    assert before_public["rules"] == []
    assert before_public["query_hash"] != rules["query_hash"]

    events = query.execute(query_request(
        snapshot_id, "read_event_timeline", event_types=["dividend"]))
    assert len(events["rows"]) == 2
    plan = [row for row in events["rows"]
            if row["event"]["content_nature"] == "plan"][0]
    actual = [row for row in events["rows"]
              if row["event"]["content_nature"] == "outcome"][0]
    assert plan["event"]["status"] == "planned"
    assert actual["event"]["status"] == "completed"
    assert plan["record_id"] != actual["record_id"]
    assert plan["event"]["event_time"] != actual["event"]["event_time"]
    assert plan["event"]["expected_time"] is not None


# ---------------------------------------------------------------------------
# C. cross-process pages, qualification/field binding, permissions, budget
# ---------------------------------------------------------------------------
def test_cross_process_cursor_binding_outer_inner_and_budget(synthetic_store, monkeypatch):
    snapshot_id = synthetic_store["snapshot_id"]
    config = synthetic_store["config"]
    query = ProductQuery(synthetic_store["service"])

    first_request = query_request(snapshot_id, "read_company_context",
                                  page_size=2)
    first = machine_call(config, "read_company_context", {"request": first_request})
    assert first["ok"] is True, first
    cursor = first["result"]["page"]["next_cursor"]
    assert cursor and first["result"]["page"]["has_more"] is True
    second_request = dict(first_request, cursor=cursor)
    second = machine_call(config, "read_company_context", {"request": second_request})
    assert second["ok"] is True, second
    assert first["result"]["query_hash"] == second["result"]["query_hash"]
    assert second["result"]["page"]["offset"] == 2
    first_keys = [row["record_ref"]["logical_key"] for row in first["result"]["rows"]]
    second_keys = [row["record_ref"]["logical_key"] for row in second["result"]["rows"]]
    assert not (set(first_keys) & set(second_keys))

    # A changed field projection is a different query; the old cursor is rejected.
    field_request = query_request(snapshot_id, "read_company_context",
                                  page_size=1, fields=["revenue"])
    field_page = machine_call(config, "read_company_context", {"request": field_request})
    assert field_page["ok"] is True, field_page
    changed_fields = machine_call(config, "read_company_context", {"request": dict(
        field_request, cursor=field_page["result"]["page"]["next_cursor"],
        fields=["close_price"])})
    assert changed_fields["ok"] is False
    assert changed_fields["error"]["code"] == "CURSOR_QUERY_MISMATCH"

    # A changed cutoff is a different query; the old cursor is rejected.
    cutoff_request = query_request(snapshot_id, "read_company_context",
                                   history_mode="market_known_at",
                                   cutoff=day(2025, 6, 2), page_size=1)
    cutoff_page = machine_call(config, "read_company_context", {"request": cutoff_request})
    assert cutoff_page["ok"] is True, cutoff_page
    changed_cutoff = machine_call(config, "read_company_context", {"request": dict(
        cutoff_request, cursor=cutoff_page["result"]["page"]["next_cursor"],
        knowledge_cutoff=day(2026, 6, 2))})
    assert changed_cutoff["ok"] is False
    assert changed_cutoff["error"]["code"] == "CURSOR_QUERY_MISMATCH"

    # held_scope/usable_stage are part of the hash, even before payload reads.
    base = query_request(snapshot_id, "read_event_timeline",
                         history_mode="system_held_at",
                         cutoff=day(2025, 6, 2),
                         held_scope="wfd-instance-a",
                         usable_stage="published_readable")
    base_session = {"cutoff_info": {"effective_utc": "2025-06-02T00:00:00Z",
                                    "rule": "second_precision_point"},
                    "business_range": None}
    base_hash = query._p4b_query_hash(base, base_session)
    other_instance = dict(base, held_scope="wfd-instance-b")
    other_stage = dict(base, usable_stage="custodied")
    assert query._p4b_query_hash(other_instance, base_session) != base_hash
    assert query._p4b_query_hash(other_stage, base_session) != base_hash
    cursor = query._encode_offset_cursor(base_hash, 1)
    with pytest.raises(ProductQueryError) as cursor_error:
        query._decode_offset_cursor(
            cursor, query._p4b_query_hash(other_instance, base_session))
    assert cursor_error.value.code == "CURSOR_QUERY_MISMATCH"

    # Actual cross-process system_held_at page: changing instance or stage
    # rejects the old cursor before any payload read, even without facts for
    # the changed qualification.
    monkeypatch.setenv("WFD_HOLDINGS_TEST_MODE", "1")
    instance = "wfd-p4a1-instance-a"
    ledger = HoldingLedger(synthetic_store["service"].root, instance)
    for output_key in ("event_plan", "event_actual"):
        product_id = synthetic_store["product_ids"][output_key]
        row = synthetic_store["service"].read(
            product_id, snapshot_id=snapshot_id)["rows"][0]
        ledger.record_test_fixture(
            snapshot_id=snapshot_id, product_id=product_id,
            records=[{"record_id": row["record_id"],
                      "record_version": row["record_version"]}],
            acquired_at="2025-07-02T00:00:00Z",
            custodied_at="2025-07-02T00:00:00Z",
            readable_at="2025-07-02T00:00:00Z")
    held_request = query_request(
        snapshot_id, "read_event_timeline", history_mode="system_held_at",
        cutoff=day(2025, 8, 1), held_scope=instance,
        usable_stage="published_readable", page_size=1)
    held_page = machine_call(config, "read_event_timeline",
                             {"request": held_request})
    assert held_page["ok"] is True, held_page
    held_cursor = held_page["result"]["page"]["next_cursor"]
    assert held_cursor
    changed_instance = machine_call(config, "read_event_timeline", {"request": dict(
        held_request, cursor=held_cursor, held_scope="wfd-p4a1-instance-b")})
    assert changed_instance["ok"] is False
    assert changed_instance["error"]["code"] == "CURSOR_QUERY_MISMATCH"
    changed_stage = machine_call(config, "read_event_timeline", {"request": dict(
        held_request, cursor=held_cursor, usable_stage="custodied")})
    assert changed_stage["ok"] is False
    assert changed_stage["error"]["code"] == "CURSOR_QUERY_MISMATCH"

    # outer/inner must match; read_product cannot carry an arbitrary query.
    mismatch = machine_call(config, "read_product", {"request": query_request(
        snapshot_id, "read_relation_graph", max_depth=1)})
    assert mismatch["ok"] is False
    assert mismatch["error"]["code"] == "QUERY_OPERATION_UNSUPPORTED"
    assert mismatch["error"]["details"]["outer_operation"] == "read_product"
    assert mismatch["error"]["details"]["inner_operation"] == "read_relation_graph"
    reverse = machine_call(config, "read_company_context", {"request": query_request(
        snapshot_id, "read_product", product_id="p_test", fields=["x"],
        page_size=1, max_scan_bytes=1000)})
    assert reverse["ok"] is False
    assert reverse["error"]["code"] == "QUERY_OPERATION_UNSUPPORTED"
    assert reverse["error"]["details"]["outer_operation"] == "read_company_context"

    # Missing read permission is checked before inner mismatch/schema/field details.
    no_read_config = _machine_config(synthetic_store["tmp_path"],
                                     synthetic_store["service"],
                                     roles=("register", "submit", "publish"))
    denied = machine_call(no_read_config, "read_company_context", {"request": {
        "operation": "read_relation_graph"}})
    assert denied["ok"] is False
    assert denied["error"]["code"] == "CALLER_PERMISSION_DENIED"
    assert denied["error"]["details"] is None or "inner_operation" not in (
        denied["error"].get("details") or {})

    # Resource truncation and hard preflight budget are explicit.
    truncated = query.execute(query_request(
        snapshot_id, "read_relation_graph", max_depth=3, max_edges=1))
    assert truncated["truncated"] is True
    assert len(truncated["edges"]) <= 1
    with pytest.raises(ProductQueryError) as budget:
        query.execute(query_request(
            snapshot_id, "read_relation_graph", max_depth=3, max_scan_bytes=1))
    assert budget.value.code == "SCAN_BUDGET_EXCEEDED"
