"""P4b context operations: relation graph, company context, events, rules, trace."""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from test_product_query import (  # noqa: E402
    EVIDENCE_ROOT, HERE, READ_ROLES, SOURCE_POLICY, base_document, field,
    known_day, new_service, real_query, request, submit_ok, sync_source_roles,
)
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator  # noqa: E402
from wfd_sdk.product_query import (  # noqa: E402
    PROTOCOL_VERSION_P4B, ProductQuery, ProductQueryError,
)
from wfd_sdk.product_service import WFDProductService  # noqa: E402


P3A6_STORE = (EVIDENCE_ROOT / "P3_通用入库与更新_2026-10-27" /
              "run_20261027_p3a6/store")
P3A6_SID = "s_75ba1080a80c944a7cb5e89e"
P3A6_DATASET = "p3a_real_2026_v2"
ENTITY = {"kind": "entity", "namespace": "wfd.cn", "id": "entity_000001"}


def span(start_year, end_year):
    return {"status": "known", "precision": "interval",
            "earliest_utc": f"{start_year}-01-01T00:00:00Z",
            "latest_exclusive_utc": f"{end_year}-01-01T00:00:00Z",
            "source_timezone": "UTC"}


def p4b_request(dataset_id, snapshot_id, operation, subject, **overrides):
    value = {
        "protocol_version": PROTOCOL_VERSION_P4B,
        "dataset_id": dataset_id,
        "operation": operation,
        "snapshot_id": snapshot_id,
        "history_mode": "snapshot_contents",
        "knowledge_cutoff": None,
        "held_scope": None,
        "usable_stage": None,
        "subject": subject,
        "max_nodes": 1000,
        "page_size": 100,
        "max_scan_bytes": 80_000_000,
        "cursor": None,
        "business_time_range": None,
    }
    value.update(overrides)
    return value


def real_service(store, snapshot_id, label, *, may_read=None, may_read_evidence=None):
    snapshot = json.loads((store / f"catalog/snapshots/{snapshot_id}.json").read_text("utf-8"))
    source_ids = set()
    for entry in snapshot["files"]:
        bundle = entry.get("source_bundle") or {}
        source_ids.update(bundle.get("source_ids") or [])
        if bundle.get("source_id"):
            source_ids.add(bundle["source_id"])
        for source in bundle.get("sources") or []:
            if source.get("source_id"):
                source_ids.add(source["source_id"])
    policy = {}
    for source_id in sorted(source_ids):
        policy[source_id] = {
            "may_read": True if may_read is None else may_read.get(source_id, True),
            "may_read_evidence": (True if may_read_evidence is None
                                  else may_read_evidence.get(source_id, True)),
            "usage_scope": "local_use", "license": "local_use_only",
        }
    engine = WFDDuckDBPrototype(
        store, load_protocol_validator(HERE / "protocol"),
        runtime_root=Path(str(engine_runtime(store, label))),
        sandbox=False, writer_host=label)
    service = WFDProductService(engine, allowed_sources=policy,
                                caller_roles=READ_ROLES, caller_id=label)
    return ProductQuery(service)


def engine_runtime(store, label):
    # Keep runtime outside the real store; caller owns the temp directory.
    import tempfile
    return Path(tempfile.mkdtemp(prefix=f"wfd_p4b_{label}_"))


def test_real_p3a6_company_context_event_graph_rules_and_trace(tmp_path):
    if not P3A6_STORE.is_dir():
        pytest.skip("P3a6 verified store is missing")
    query = real_service(P3A6_STORE, P3A6_SID, "p4b_real")

    company = query.execute(p4b_request(
        P3A6_DATASET, P3A6_SID, "read_company_context", ENTITY, max_depth=1))
    assert company["operation"] == "read_company_context"
    assert company["coverage"]["permission_denied_products"] == []
    assert company["rows"]
    assert any(row.get("row_type") == "event" and row["event"]["event_type"] == "dividend"
               for row in company["rows"])
    assert any(row.get("row_type") == "value" for row in company["rows"])
    # P2 real relation validity is unknown in this snapshot: never confirm connectivity.
    assert company["edges"]
    assert all(edge["connectivity"] == "indeterminate" for edge in company["edges"])
    assert [node["identity"] for node in company["nodes"]] == [ENTITY]

    events = query.execute(p4b_request(
        P3A6_DATASET, P3A6_SID, "read_event_timeline", ENTITY,
        event_types=["dividend"]))
    assert len(events["rows"]) == 2
    natures = {row["event"]["content_nature"] for row in events["rows"]}
    statuses = {row["event"]["status"] for row in events["rows"]}
    assert natures == {"plan"}
    assert "planned" in statuses
    assert any("implementation" in status for status in statuses)
    assert all(row["times"].get("public_time") for row in events["rows"])

    graph = query.execute(p4b_request(
        P3A6_DATASET, P3A6_SID, "read_relation_graph", ENTITY,
        max_depth=2, max_edges=100))
    assert len(graph["nodes"]) == 1
    assert graph["edges"]
    assert all(edge["connectivity"] == "indeterminate" for edge in graph["edges"])

    rules = query.execute(p4b_request(
        P3A6_DATASET, P3A6_SID, "read_applicable_rules", ENTITY))
    assert rules["status"] == "no_rule_products"
    assert any(gap["code"] == "NO_RULE_PRODUCTS" for gap in rules["gaps"])

    traced = query.execute(p4b_request(
        P3A6_DATASET, P3A6_SID, "trace_evidence", ENTITY,
        product_id="p_02ec6055541fbe0a36213c05",
        trace_fields=["revenue_cny_100million"]))
    assert traced["status"] == "verified_with_scope"
    assert traced["evidence"]
    assert traced["evidence"][0]["verified"] is True
    assert any(gap["code"] == "TRACE_FIELD_INDEX_NOT_AVAILABLE" for gap in traced["gaps"])

    # A denied source produces an explicit product gap; no row/field detail leaks.
    denied = real_service(
        P3A6_STORE, P3A6_SID, "p4b_denied",
        may_read={"cninfo_1225022887": False})
    denied_result = denied.execute(p4b_request(
        P3A6_DATASET, P3A6_SID, "read_company_context", ENTITY, max_depth=1))
    assert "p_02ec6055541fbe0a36213c05" in denied_result["coverage"]["permission_denied_products"]
    assert not any(row.get("product_id") == "p_02ec6055541fbe0a36213c05"
                   for row in denied_result["rows"])
    assert any(gap["code"] == "SOURCE_READ_PERMISSION_MISSING"
               for gap in denied_result["gaps"])

    denied_trace = denied.execute(p4b_request(
        P3A6_DATASET, P3A6_SID, "trace_evidence", ENTITY,
        product_id="p_02ec6055541fbe0a36213c05"))
    assert denied_trace["status"] == "permission_denied"
    assert "evidence" not in denied_trace or not denied_trace.get("evidence")


def _relation_output(template, output_key, semantic, subject, rows):
    output = copy.deepcopy(template)
    output["output_key"] = output_key
    output["logical_domain"] = "foundation"
    output["subject"] = subject
    output["definition_mode"] = "create"
    output["new_definition_declaration"] = {
        "semantic_code": semantic, "measurement_nature": "relation",
        "unit_code": "not_applicable", "definition_authority": "p4a1.test",
        "time_role": "validity",
    }
    output["payload"] = {"kind": "relation_edges", "rows": rows}
    output["coverage"] = {
        "scope": {"test": "p4b"}, "basis": "observed_partial",
        "completeness": "partial", "coverage_evidence": [],
        "absence_means": "unknown",
    }
    return output


def test_relation_depth_cycle_unknown_duplicate_future_and_rule_event(tmp_path):
    service, doc = base_document(tmp_path)
    a = {"kind": "physical_object", "namespace": "p4b.test", "id": "a"}
    b = {"kind": "physical_object", "namespace": "p4b.test", "id": "b"}
    c = {"kind": "physical_object", "namespace": "p4b.test", "id": "c"}
    d = {"kind": "physical_object", "namespace": "p4b.test", "id": "d"}
    e = {"kind": "physical_object", "namespace": "p4b.test", "id": "e"}
    template = doc["outputs"][0]

    def edge(key, left, right, effective, public):
        return {"business_key": key, "subject": left, "object": right,
                "relation_type": "linked_to", "effective_period": effective,
                "public_time": public}

    rel1 = _relation_output(template, "p4b_rel1", "p4b.relation.one", a, [
        edge("ab", a, b, span(2020, 2030), known_day(2020, 1, 2)),
        edge("bc", b, c, span(2020, 2030), known_day(2020, 1, 2)),
        edge("ca", c, a, span(2020, 2030), known_day(2020, 1, 2)),
        edge("ad_unknown", a, d,
             {"status": "unknown", "precision": "unknown", "earliest_utc": None,
              "latest_exclusive_utc": None, "source_timezone": "UTC"},
             known_day(2020, 1, 2)),
    ])
    rel2 = _relation_output(template, "p4b_rel2", "p4b.relation.two", a, [
        edge("ab_duplicate", a, b, span(2020, 2030), known_day(2020, 1, 2)),
        edge("ae_future", a, e, span(2020, 2030), known_day(2030, 1, 2)),
    ])
    rule = _relation_output(template, "p4b_rule", "p4b.rule.numeric", a, [{
        "business_key": "rule_1", "subject": a, "object": b,
        "relation_type": "applies_to",
        "effective_period": span(2020, 2030),
        "public_time": known_day(2020, 1, 2),
        "values": {
            "rule_code": {"data_type": "text", "value_state": "valid_value",
                          "value": "R-1"},
            "rule_text": {"data_type": "text", "value_state": "valid_value",
                          "value": "bounded rule"},
        },
    }])
    rule["new_definition_declaration"]["field_definitions"] = [
        field("rule_code", "text", "text"), field("rule_text", "text", "text")]
    event = copy.deepcopy(template)
    event["output_key"] = "p4b_event"
    event["logical_domain"] = "events"
    event["subject"] = a
    event["definition_mode"] = "create"
    event["new_definition_declaration"] = {
        "semantic_code": "p4b.event.lifecycle", "measurement_nature": "event",
        "unit_code": "not_applicable", "definition_authority": "p4a1.test",
        "time_role": "event",
        "field_definitions": [field("stage", "text", "not_applicable")],
    }
    event["payload"] = {"kind": "event_records", "rows": [
        {"event_id": "e_plan", "subject": a, "event_type": "dividend",
         "content_nature": "plan", "event_time": known_day(2025, 1, 2),
         "public_time": known_day(2025, 1, 2),
         "expected_time": known_day(2025, 6, 1), "status": "planned",
         "values": {"stage": {"data_type": "text", "value_state": "valid_value",
                              "value": "plan"}}},
        {"event_id": "e_actual", "subject": a, "event_type": "dividend",
         "content_nature": "observed_fact", "event_time": known_day(2025, 7, 1),
         "public_time": known_day(2025, 7, 1),
         "expected_time": known_day(2025, 7, 1), "status": "completed",
         "values": {"stage": {"data_type": "text", "value_state": "valid_value",
                              "value": "actual"}}},
    ]}
    value = copy.deepcopy(template)
    value["output_key"] = "p4b_value"
    value["logical_domain"] = "observations"
    value["subject"] = a
    value["definition_mode"] = "create"
    value["new_definition_declaration"] = {
        "semantic_code": "p4b.value.context", "measurement_nature": "flow",
        "unit_code": "per_field", "definition_authority": "p4a1.test",
        "time_role": "observation",
        "field_definitions": [field("amount", "decimal", "vehicle")],
    }
    value["payload"] = {"kind": "tabular_rows", "rows": [{
        "business_key": "value_1", "subject": a,
        "observation_time": known_day(2025, 6, 1),
        "values": {"amount": {"data_type": "decimal",
                              "value_state": "valid_value", "value": "7"}},
    }]}
    doc["outputs"] = [rel1, rel2, rule, event, value]
    sync_source_roles(doc)
    result = submit_ok(service, doc)
    dataset_id = doc["request_identity"]["dataset_id"]
    snapshot_id = result["snapshot_id"]
    query = ProductQuery(service)

    graph = query.execute(p4b_request(
        dataset_id, snapshot_id, "read_relation_graph", a,
        max_depth=3, max_edges=100))
    keys = {node["identity"]["id"] for node in graph["nodes"]}
    assert keys == {"a", "b", "c", "e"}
    assert "d" not in keys
    assert any(edge["connectivity"] == "indeterminate" for edge in graph["edges"])
    assert graph["cycles"]
    ab_edges = [edge for edge in graph["edges"]
                if edge["subject"]["id"] == "a" and edge["object"]["id"] == "b"]
    # Different definitions/contracts are independent bases; they must not be
    # silently collapsed into one edge.
    assert len(ab_edges) == 2
    assert len({edge["definition_ref"]["digest"] for edge in ab_edges}) == 2
    assert all(edge["basis_count"] == 2 and edge["multi_basis"] for edge in ab_edges)
    assert graph["truncated"] is False

    bounded = query.execute(p4b_request(
        dataset_id, snapshot_id, "read_relation_graph", a,
        max_depth=3, max_edges=1))
    assert bounded["truncated"] is True
    assert len(bounded["edges"]) <= 1

    future = query.execute(p4b_request(
        dataset_id, snapshot_id, "read_relation_graph", a,
        history_mode="market_known_at", knowledge_cutoff=known_day(2025, 1, 2),
        max_depth=3, max_edges=100))
    assert "e" not in {node["identity"]["id"] for node in future["nodes"]}

    rules = query.execute(p4b_request(
        dataset_id, snapshot_id, "read_applicable_rules", a,
        rule_codes=["R-1"]))
    assert rules["status"] == "rows"
    assert len(rules["rules"]) == 1
    assert rules["rules"][0]["rule"]["rule_code"] == "R-1"
    assert rules["rules"][0]["rule"]["effective_period"]["status"] == "known"

    company_role = query.execute(p4b_request(
        dataset_id, snapshot_id, "read_company_context", a, max_depth=1,
        business_time_range={"role": "observation", "start": "2025-06-01",
                             "end": "2025-06-01", "timezone": "Asia/Shanghai"}))
    assert any(row.get("row_type") == "value"
               and row["values"]["amount"]["value"] == "7"
               for row in company_role["rows"])

    events = query.execute(p4b_request(
        dataset_id, snapshot_id, "read_event_timeline", a,
        event_types=["dividend"]))
    assert len(events["rows"]) == 2
    event_role = query.execute(p4b_request(
        dataset_id, snapshot_id, "read_event_timeline", a,
        event_types=["dividend"],
        business_time_range={"role": "event", "start": "2025-07-01",
                             "end": "2025-07-01", "timezone": "Asia/Shanghai"}))
    assert len(event_role["rows"]) == 1
    assert event_role["rows"][0]["event"]["status"] == "completed"
    assert {row["event"]["content_nature"] for row in events["rows"]} == \
        {"plan", "observed_fact"}
    assert {row["event"]["status"] for row in events["rows"]} == \
        {"planned", "completed"}

    denied_service = new_service(
        service.root, tmp_path / "runtime_denied",
        roles=READ_ROLES, caller="p4b-denied",
        source_policy={**SOURCE_POLICY, "may_read": False,
                       "may_read_evidence": False})
    denied = ProductQuery(denied_service)
    denied_context = denied.execute(p4b_request(
        dataset_id, snapshot_id, "read_company_context", a, max_depth=1))
    assert denied_context["rows"] == []
    assert denied_context["coverage"]["permission_denied_products"]
    assert all(gap["code"] == "SOURCE_READ_PERMISSION_MISSING"
               for gap in denied_context["gaps"])

    with pytest.raises(ProductQueryError) as budget:
        query.execute(p4b_request(
            dataset_id, snapshot_id, "read_relation_graph", a,
            max_depth=3, max_scan_bytes=1))
    assert budget.value.code == "SCAN_BUDGET_EXCEEDED"


def test_p4b_audit_regressions_validity_role_basis_and_coverage(tmp_path):
    """Replay the independent P4b auditor's two scenario families."""
    service, doc = base_document(tmp_path)
    a = {"kind": "physical_object", "namespace": "p4b.audit", "id": "a"}
    b = {"kind": "physical_object", "namespace": "p4b.audit", "id": "b"}

    def edge(key):
        return {"business_key": key, "subject": a, "object": b,
                "relation_type": "linked_to",
                "effective_period": span(2020, 2030),
                "public_time": known_day(2020, 1, 2)}

    template = doc["outputs"][0]
    rel_a = _relation_output(template, "rel_a", "audit.relation.alpha", a, [edge("alpha")])
    rel_a["new_definition_declaration"]["definition_authority"] = "p1.test"
    rel_b = _relation_output(template, "rel_b", "audit.relation.beta", a, [edge("beta")])
    rel_b["new_definition_declaration"]["definition_authority"] = "audit"
    rule_row = edge("rule_1")
    rule_row["relation_type"] = "applies_to"
    rule_row["values"] = {"rule_code": {"data_type": "text",
                                        "value_state": "valid_value",
                                        "value": "R-1"}}
    rule = _relation_output(template, "rule", "audit.rule.period", a, [rule_row])
    rule["new_definition_declaration"]["field_definitions"] = [
        field("rule_code", "text", "text")]
    doc["outputs"] = [rel_a, rel_b, rule]
    sync_source_roles(doc)
    result = submit_ok(service, doc)
    sid = result["snapshot_id"]
    did = doc["request_identity"]["dataset_id"]
    query = ProductQuery(service)

    def period(role, start, end):
        return {"role": role, "start": start, "end": end, "timezone": "UTC"}

    def execute(operation, period_value=None):
        extra = {"business_time_range": period_value}
        if operation == "read_relation_graph":
            extra.update(max_depth=2, max_edges=20)
        return query.execute(p4b_request(did, sid, operation, a, **extra))

    no_range = execute("read_applicable_rules")
    declared_full = execute("read_applicable_rules",
                            period("declared", "2020-01-01", "2029-12-31"))
    validity_full = execute("read_applicable_rules",
                            period("validity", "2020-01-01", "2029-12-31"))
    declared_inside = execute("read_applicable_rules",
                              period("declared", "2025-06-01", "2025-06-01"))
    assert len(no_range["rows"]) == 1
    assert len(declared_full["rows"]) == 1
    # Explicit validity role must be accepted by the fixed contract.
    assert len(validity_full["rows"]) == 1
    assert not any(gap["code"] == "BUSINESS_TIME_ROLE_MISMATCH"
                   for gap in validity_full["gaps"])
    # Validity covers the queried business day; it is not observation containment.
    assert len(declared_inside["rows"]) == 1
    assert not any(gap["code"] == "BUSINESS_TIME_OVERLAP_QUERY_RANGE"
                   for gap in declared_inside["gaps"])

    graph_no_range = execute("read_relation_graph")
    graph_declared_full = execute("read_relation_graph",
                                  period("declared", "2020-01-01", "2029-12-31"))
    graph_declared_inside = execute("read_relation_graph",
                                    period("declared", "2025-06-01", "2025-06-01"))
    assert len(graph_no_range["nodes"]) == 2
    assert len(graph_no_range["edges"]) == 2
    assert len(graph_declared_full["nodes"]) == 2
    assert len(graph_declared_full["edges"]) == 2
    assert len(graph_declared_inside["nodes"]) == 2
    assert len(graph_declared_inside["edges"]) == 2
    assert all(edge["connectivity"] == "confirmed"
               for edge in graph_declared_inside["edges"])
    assert {edge["definer"] for edge in graph_no_range["edges"]} == {"p1.test", "audit"}
    assert len({edge["definition_ref"]["digest"]
                for edge in graph_no_range["edges"]}) == 2
    assert all(edge["basis_count"] == 2 and edge["multi_basis"]
               for edge in graph_no_range["edges"])

    fixed_reads = [service.read(pid, snapshot_id=sid) for pid in
                   sorted({entry["product_id"]
                           for entry in json.loads(
                               (service.root / "catalog/snapshots" /
                                f"{sid}.json").read_text("utf-8"))["files"]})]
    assert len(fixed_reads) == 3
    assert all(len(read["rows"]) == 1 for read in fixed_reads)
