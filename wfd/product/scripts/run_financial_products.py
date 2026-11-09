#!/usr/bin/env python3
# coding: utf-8
"""Build the first bounded financial products from acquired source bytes."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
PROJECT = ENGINE.parents[1]
sys.path.insert(0, str(ENGINE))
from run_financial_slice import (day_time, interval, value, field, definition, UNKNOWN,
                                 new_output_directory, selected_directory, selected_file)
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator, canonical, sha
from wfd_sdk.product_service import WFDProductService, SERVICE_VERSION

DATASET = "wfd_cn_000001_financial_products"
UNITS = [
    ("cny", "人民币元", "money", "cny", "1"),
    ("share", "股", "security_quantity", "share", "1"),
    ("cny_per_share", "人民币元每股", "money_per_share", "cny_per_share", "1"),
    ("lot_100_shares", "本批A股成交量一手等于100股", "security_quantity", "share", "100"),
    ("cny_100million", "人民币亿元", "money", "cny", "100000000"),
    ("cny_per_10_shares", "人民币元每10股", "money_per_share", "cny_per_share", "0.1"),
    ("ratio", "无量纲比例", "ratio", "ratio", "1"),
    ("date", "公历ISO日期，非精确时刻", "date", "not_applicable", None),
    ("day_of_week", "本批深交所日历周序：周日1至周六7", "ordinal", "not_applicable", None),
    ("text", "文本", "text", "not_applicable", None),
    ("identifier", "命名空间内标识，不作数值运算", "identifier", "not_applicable", None),
    ("currency_code", "币种代码，本批CNY对应人民币", "identifier", "not_applicable", None),
    ("timezone", "时区标识，本批使用Asia/Shanghai", "identifier", "not_applicable", None),
    ("boolean", "布尔值", "boolean", "not_applicable", None),
    ("per_field", "复合产品按每个字段的单位解释", "marker", "not_applicable", None),
    ("not_applicable", "该语义不适用数值量纲", "marker", "not_applicable", None),
]


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")


def make_output(key, domain, subject, kind, rows, fields, evidence, authority, *, mode="partial_observation"):
    declaration = definition(key, authority, fields=fields)
    if kind == "relation_edges":
        declaration.update(measurement_nature="relation", unit_code="not_applicable",
                           relation_semantics={"directed": True, "relation_type": rows[0]["relation_type"]})
    elif kind == "event_records":
        declaration.update(measurement_nature="event", unit_code="not_applicable")
    return {"output_key": key, "logical_domain": domain, "subject": subject,
            "definition_mode": "create", "definition_ref": None, "new_definition_declaration": declaration,
            "input_mode": mode,
            "coverage": {"scope": {"dataset": DATASET, "bounded_product_release": True},
                         "basis": "observed_partial", "completeness": "partial",
                         "coverage_evidence": [], "absence_means": "unknown"},
            "payload": {"kind": kind, "rows": rows}, "evidence_refs": evidence}


def build(data, evidence):
    ident = data["identity"]
    company = {"kind": "entity", "namespace": "cn.uscc", "id": ident["company"]["uscc"]}
    security = {"kind": "instrument", "namespace": "wfd.instrument",
                "id": ident["company"]["uscc"] + ":ordinary_a"}
    listing = {"kind": "listing", "namespace": "cn.szse.listing",
               "id": ident["security"]["code"] + ":" + ident["security"]["listing_date"].replace("-", "")}
    market = {"kind": "market", "namespace": "cn.exchange", "id": "szse"}

    def refs(ids):
        return [evidence[i] for i in dict.fromkeys(ids)]

    def table(key, subject, values, unit_fields, *, source_ids, authority, when=None):
        row = {"business_key": key, "subject": subject, "observation_time": when or copy.deepcopy(UNKNOWN),
               "values": {name: value(v, dtype) for name, (v, dtype) in values.items()}}
        return make_output(key, "foundation", subject, "tabular_rows", [row], unit_fields,
                           refs(source_ids), authority)

    identity_sources = ident["source_ids"]
    identity_authority = "szse.security_directory_and_user_company_roster"
    foundations = [
        table("cn.company.identity", company,
              {"company_name": (ident["company"]["name"], "text"), "uscc": (ident["company"]["uscc"], "text")},
              [field("company_name", "text", "text"), field("uscc", "text", "identifier")],
              source_ids=identity_sources, authority=identity_authority),
        table("cn.security.identity", security,
              {"share_class": ("ordinary_a", "text"), "security_name": (ident["security"]["name"], "text")},
              [field("share_class", "text", "text"), field("security_name", "text", "text")],
              source_ids=identity_sources, authority=identity_authority),
        table("cn.listing.identity", listing,
              {"code": (ident["security"]["code"], "text"), "listing_date": (ident["security"]["listing_date"], "text"),
               "currency": (ident["security"]["currency"], "text"), "board": (ident["security"]["board"], "text")},
              [field(k, "text", u) for k, u in [("code", "identifier"), ("listing_date", "date"),
                                                ("currency", "currency_code"), ("board", "text")]],
              source_ids=identity_sources, authority=identity_authority),
        table("cn.market.identity", market, {"name": ("深圳证券交易所", "text"), "timezone": ("Asia/Shanghai", "text")},
              [field("name", "text", "text"), field("timezone", "text", "timezone")],
              source_ids=identity_sources, authority="szse")]
    for key, subject, obj, rel in [("cn.security.issuer", security, company, "issued_by"),
                                    ("cn.listing.security", listing, security, "listing_of"),
                                    ("cn.listing.market", listing, market, "listed_on")]:
        row = {"business_key": key, "subject": subject, "object": obj, "relation_type": rel,
               "effective_period": copy.deepcopy(UNKNOWN), "public_time": copy.deepcopy(UNKNOWN)}
        foundations.append(make_output(key, "foundation", subject, "relation_edges", [row], None,
                                       refs(identity_sources), identity_authority))
    cal = data["calendar"]
    calendar_rows = [{"business_key": "szse:" + row["session_date"], "subject": market,
                      "observation_time": day_time(row["session_date"].replace("-", "")),
                      "values": {"session_date": value(row["session_date"]),
                                 "is_open": {"data_type": "boolean", "value_state": "valid_value", "value": row["is_open"]},
                                 "weekday": value(row["weekday"], "integer")}}
                     for row in cal["rows"]]
    foundations.append(make_output("cn.szse.trading_calendar", "foundation", market, "tabular_rows", calendar_rows,
                                   [field("session_date", "text", "date"), field("is_open", "boolean", "boolean"),
                                    field("weekday", "integer", "day_of_week")], refs(cal["source_ids"]), "szse"))
    semantic_ref = {"kind": "definition", "namespace": "wfd.semantic", "id": "financial_units_v1"}
    unit_rows = [{"business_key": code, "subject": semantic_ref, "observation_time": copy.deepcopy(UNKNOWN),
                  "values": {"unit_code": value(code), "meaning": value(meaning), "dimension": value(dimension),
                             "base_unit": value(base), "scale_decimal": value(scale, "decimal") if scale is not None else
                             {"data_type": "decimal", "value_state": "not_applicable", "value": None}}}
                 for code, meaning, dimension, base, scale in UNITS]
    foundations.append(make_output("cn.semantic.units", "foundation", semantic_ref, "tabular_rows", unit_rows,
                                   [field("unit_code", "text", "identifier"), field("meaning", "text", "text"),
                                    field("dimension", "text", "text"), field("base_unit", "text", "identifier"),
                                    field("scale_decimal", "decimal", "ratio")],
                                   refs(["wfd_declared_units_v1"]), "wfd.base1.1.minimal_semantics"))
    bars = data["market"]
    specifications = [("open", "cny_per_share", "stock"), ("high", "cny_per_share", "stock"),
                      ("low", "cny_per_share", "stock"), ("close", "cny_per_share", "stock"),
                      ("volume_lot", "lot_100_shares", "flow"), ("amount_cny", "cny", "flow")]
    bar_rows = [{"business_key": ident["security"]["code"] + ":" + row["trade_date"], "subject": listing,
                 "observation_time": day_time(row["trade_date"].replace("-", "")),
                 "values": {name: value(row[name], "decimal") for name, _, _ in specifications}}
                for row in bars["rows"]]
    prices = make_output("cn.equity.daily_bar.unadjusted", "observations", listing, "tabular_rows", bar_rows,
                         [field(name, "decimal", unit, nature, "trading_day") for name, unit, nature in specifications],
                         refs(bars["source_ids"]), "eastmoney.unadjusted_daily_bars")
    fin = data["financial"]
    values = {row["field_code"]: value(row["value_decimal"], "decimal") for row in fin["rows"]}
    reporting_end = fin.get("period_end_exclusive") or (
        datetime.strptime(fin["period_end"], "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    fin_row = {"business_key": company["id"] + ":2026H1", "subject": company,
               "observation_time": interval(fin["period_start"] + "T00:00:00", reporting_end + "T00:00:00", "interval"),
               "values": values}
    financial = make_output("cn.company.2026h1.disclosed_financials", "observations", company, "tabular_rows", [fin_row],
                            [field(r["field_code"], "decimal", r["unit_code"],
                                   "event" if r["field_code"].startswith("proposed_") else "flow", "reporting_period")
                             for r in fin["rows"]],
                            refs(fin["source_ids"]), "pingan_bank.issuer_disclosure")
    ann = data["announcement"]
    event_row = {"event_id": ann["event_id"], "case_id": "000001:2026H1:board_resolution", "subject": company,
                 "event_type": "board_resolution_announcement", "content_nature": "source_claim",
                 "event_time": day_time(ann["event_date"].replace("-", "")), "public_time": ann["public_time"],
                 "status": "source_reported", "values": {"announcement_no": value(ann["announcement_no"]),
                    "title": value(ann["title"]), "source_url": value(ann["source_url"]),
                    "dividend_status": value("proposed_not_paid")}}
    # Publish the original first, then genuinely add the listing metadata as a
    # provenance repair, keeping the disclosed event and its values unchanged.
    event = make_output("cn.company.board_resolution", "events", company, "event_records", [event_row], None,
                        refs([ann["pdf_source_id"]]), "pingan_bank.issuer_disclosure")
    return {"company": company, "security": security, "listing": listing, "market": market}, foundations, prices, financial, event


def run(data, output):
    data = copy.deepcopy(data)
    output = new_output_directory(output, *(source["path"] for source in data["sources"]))
    directory = output / datetime.now(timezone.utc).strftime("run_%Y%m%dT%H%M%SZ")
    directory.mkdir(parents=True, exist_ok=False)
    semantic_path = directory / "declared_units.json"
    save(semantic_path, {"version": "wfd.financial-units/1", "nature": "declared_reference_semantics",
                         "units": [dict(zip(("unit_code", "meaning", "dimension", "base_unit", "scale_decimal"), row)) for row in UNITS],
                         "source_basis": {name: data[name]["source_ids"] for name in ("market", "calendar", "financial")}})
    data["sources"].append({"source_id": "wfd_declared_units_v1", "path": str(semantic_path),
                             "sha256": hashlib.sha256(semantic_path.read_bytes()).hexdigest(),
                             "provider": "WFD基础语义声明", "url": None, "license": "user_defined",
                             "created_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                             "nature": "declared_reference_semantics"})
    policy = {s["source_id"]: {"may_submit": True, "may_publish_formal": True,
                               "may_read": True, "may_read_evidence": True,
                               "may_export": True, "may_export_evidence": True,
                               "export_scope": "user_local_validation_only",
                               "usage_scope": "user_local_financial_database",
                               "license": s.get("license", "unknown")}
              for s in data["sources"]}
    def make_service(runtime):
        engine = WFDDuckDBPrototype(directory / "store", load_protocol_validator(ENGINE / "protocol"),
                                   runtime_root=directory / runtime, sandbox=False, writer_host="financial-products")
        return WFDProductService(engine, allowed_sources=policy,
                                 caller_roles={"evidence_write", "register", "submit", "publish",
                                               "read", "read_evidence", "export", "redistribute"},
                                 caller_id="financial-products",
                                 unit_registry={code: {"dimension": dimension} for code, _, dimension, _, _ in UNITS},
                                 trusted_actor_namespaces={"wfd.financial_products"})
    service = make_service("runtime_writer")
    save(directory / "resolved_inputs.json", data)
    evidence = {}
    sources = {s["source_id"]: s for s in data["sources"]}
    for sid, source in sources.items():
        path = Path(source["path"])
        if hashlib.sha256(path.read_bytes()).hexdigest() != source["sha256"]:
            raise ValueError("SOURCE_CHANGED:" + sid)
        evidence[sid] = service.register_evidence(path)
    identities, foundation, market, financial, event = build(data, evidence)
    receipts, documents = [], []
    def submit(name, outputs, source_ids, *, public_time=None, extensions=None):
        head = service.engine.head()
        source_ids = list(dict.fromkeys(source_ids))
        provenance = [{k: v for k, v in sources[s].items() if k not in {"path", "response_file"}}
                      | {"evidence_ref": evidence[s], "original_file_name": Path(sources[s]["path"]).name}
                      for s in source_ids]
        ext = copy.deepcopy(extensions or {})
        for out in outputs:
            ext.setdefault(out["output_key"], {"read_dependencies": []})
        source = {"source_id": source_ids[0], "source_ids": source_ids,
                  "sources": provenance, "license": "unknown",
                  "usage_scope": "user_local_financial_database", "public_time": public_time or copy.deepcopy(UNKNOWN),
                  "product_service": {"version": SERVICE_VERSION, "outputs": ext}}
        doc = {"protocol_version": "wfd.ingest/1.3-candidate", "intent": "submit", "producer_namespace": "wfd.financial_products",
               "request_identity": {"dataset_id": DATASET, "trusted_actor_namespace": "wfd.financial_products",
                                    "request_id": name, "submission_digest": "sha256:" + "0" * 64},
               "expected_parent_snapshot_id": head["snapshot_id"] if head else None, "outputs": outputs, "source_bundle": source}
        fingerprint = copy.deepcopy(doc);fingerprint["request_identity"].pop("submission_digest")
        doc["request_identity"]["submission_digest"] = "sha256:" + sha(canonical(fingerprint))
        result = service.submit(doc)
        documents.append(doc);receipts.append(result)
        save(directory / "requests.json", documents);save(directory / "receipts.json", receipts)
        if not result.get("snapshot_id") or any(x["publication_state"] != "published_formal" for x in result["output_results"]):
            raise RuntimeError("PUBLICATION_INCOMPLETE:" + str(directory / "receipts.json"))
        return result
    used_units = {out["new_definition_declaration"]["unit_code"] for out in foundation + [market, financial, event]}
    used_units.update(field["unit_code"] for out in foundation + [market, financial, event]
                      for field in out["new_definition_declaration"].get("field_definitions", []))
    if used_units - {u[0] for u in UNITS}:
        raise ValueError("UNIT_DEFINITION_MISSING:" + str(sorted(used_units - {u[0] for u in UNITS})))
    f = submit("foundation", foundation, data["identity"]["source_ids"] + data["calendar"]["source_ids"] + ["wfd_declared_units_v1"])
    fixed_dependencies = [{"dataset_id": DATASET, "product_id": item["product_id"], "snapshot_id": f["snapshot_id"],
                           "role": item["output_key"], "required": True} for item in f["output_results"]]
    binding = lambda out: {out["output_key"]: {"read_dependencies": copy.deepcopy(fixed_dependencies)}}
    m = submit("market", [market], data["market"]["source_ids"], extensions=binding(market))
    submit("financial", [financial], data["financial"]["source_ids"], public_time=data["financial"]["public_time"], extensions=binding(financial))
    e = submit("event_original", [event], [data["announcement"]["pdf_source_id"]],
               public_time=data["announcement"]["public_time"], extensions=binding(event))
    before_repair = e["snapshot_id"]
    previous = service.read(e["output_results"][0]["product_id"], snapshot_id=before_repair)["rows"][0]
    repaired = copy.deepcopy(event)
    repaired["input_mode"] = "processing_repair"
    metadata_id = data["announcement"]["metadata_source_id"]
    repaired["evidence_refs"].append(evidence[metadata_id])
    ext = binding(repaired)
    ext[repaired["output_key"]]["revisions"] = {previous["record_ref"]["logical_key"]: {
        "previous": previous["record_ref"], "reason": "补充官方公告列表元数据，与已保管原件按公告身份关联；披露值不变"}}
    last = submit("event_provenance_repair", [repaired], data["announcement"]["source_ids"],
                  public_time=data["announcement"]["public_time"], extensions=ext)
    snapshot = last["snapshot_id"]
    reader = make_service("runtime_reader")
    fixed = reader.read(snapshot_id=snapshot)
    view = reader.company_view(identities["company"], snapshot_id=snapshot)
    calendar_product = next(x["product_id"] for x in f["output_results"] if x["output_key"] == "cn.szse.trading_calendar")
    calendar = reader.read_calendar(calendar_product, snapshot_id=snapshot,
                                    start_date=data["calendar"]["start_date"], end_date=data["calendar"]["end_date"])
    history = reader.read(e["output_results"][0]["product_id"], snapshot_id=snapshot, include_history=True)
    old_event = reader.read(e["output_results"][0]["product_id"], snapshot_id=before_repair)
    historical = {name: reader.read(snapshot_id=snapshot, perspective="market_known_at", at=cutoff)
                  for name, cutoff in [("before_publication", "2026-08-14T15:59:59Z"),
                                       ("during_public_day", "2026-08-15T04:00:00Z"),
                                       ("after_public_day", "2026-08-15T16:00:00Z")]}
    held = reader.read(snapshot_id=snapshot, perspective="system_held_at", at="2026-01-01T00:00:00Z")
    for name, result in [("fixed_read", fixed), ("company_view", view), ("calendar_read", calendar),
                         ("event_version_history", history), ("old_event_snapshot", old_event),
                         ("historical_reads", historical), ("held_before", held)]:
        save(directory / (name + ".json"), result)
    catalogue = reader.discover_products(snapshot_id=snapshot)
    save(directory / "product_catalogue.json", catalogue)
    expected = [row for document in documents[:4] for out in document["outputs"] for row in out["payload"]["rows"]]
    actual = [r["row"] for r in fixed["rows"]]
    exact = sorted(map(canonical, expected)) == sorted(map(canonical, actual))
    product_ids = [m["output_results"][0]["product_id"], receipts[2]["output_results"][0]["product_id"], e["output_results"][0]["product_id"]]
    traces = [reader.trace(pid, snapshot_id=snapshot) for pid in product_ids]
    save(directory / "source_traces.json", traces)
    from wfd_sdk.product_bundle import export_financial_bundle, import_financial_bundle
    exported = export_financial_bundle(reader, product_ids, directory / "financial_bundle", snapshot_id=snapshot)
    save(directory / "bundle_export.json", exported)
    imported = import_financial_bundle(directory / "financial_bundle", directory / "independent_store",
                                       runtime_root=directory / "runtime_independent")
    # The bundle module returns the imported read service and its persisted receipt.
    independent, import_receipt = imported
    save(directory / "bundle_import.json", import_receipt)
    independent_read = independent.read(snapshot_id=snapshot)
    save(directory / "independent_read.json", independent_read)
    independent_matches = sorted(map(canonical, actual)) == sorted(map(canonical, [r["row"] for r in independent_read["rows"]]))
    independent_traces = [independent.trace(pid, snapshot_id=snapshot) for pid in product_ids]
    save(directory / "independent_source_traces.json", independent_traces)
    evidence_verified = all(item["verified"] for trace in traces + independent_traces for item in trace["evidence"])
    old_event_preserved = len(old_event["rows"]) == 1 and old_event["rows"][0]["row"] == previous["row"]
    summary = {"service_version": SERVICE_VERSION, "snapshot_id": snapshot, "before_repair_snapshot_id": before_repair,
               "input_rows": len(expected), "read_rows": len(actual), "exact_row_match": exact,
               "company_view_rows": len(view["rows"]), "foundation_products": len(f["output_results"]),
               "business_products": 3, "source_files": len(evidence), "event_history_rows": len(history["rows"]),
               "market_rows": len(data["market"]["rows"]), "calendar_days": len(data["calendar"]["rows"]),
               "calendar_open_days": sum(r["is_open"] for r in data["calendar"]["rows"]),
               "registered_units": len(UNITS), "all_field_units_defined": True,
               "historical_rows": {name: len(result["rows"]) for name, result in historical.items()},
               "held_before_rows": len(held["rows"]), "independent_read_matches": independent_matches,
               "source_and_independent_evidence_verified": evidence_verified,
               "old_event_snapshot_preserved": old_event_preserved,
               "production_accepted": False, "local_scope": "one_security_2026q2_and_2026h1_disclosures",
               "limitations": data["limitations"]}
    save(directory / "summary.json", summary)
    print(json.dumps({"run_dir": str(directory), **summary}, ensure_ascii=False, indent=2))
    return 0 if exact and independent_matches and evidence_verified and old_event_preserved else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, required=True, help="明确选择的既有 inputs.json")
    parser.add_argument("--materials-root", type=Path, required=True, help="本次明确选择的既有原包根")
    parser.add_argument("--output", type=Path, required=True, help="全新工程外输出目录；父目录须存在")
    args = parser.parse_args()
    materials = selected_directory(args.materials_root)
    inputs = selected_file(args.inputs)
    output = new_output_directory(args.output, materials, inputs)
    data = json.loads(inputs.read_text("utf-8"))
    for source in data["sources"]:
        source["path"] = str(selected_file(source["path"], materials, inputs.parent))
    raise SystemExit(run(data, output))
