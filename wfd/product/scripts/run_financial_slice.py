#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用户本地真实材料 → 产品登记/提交 → 固定读取；不宣称公司公告原件已齐全。"""
from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import json
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
PROJECT = ENGINE.parents[1]
FIXTURES = ENGINE / "fixtures/financial_slice"
MATERIALS = Path("/Users/mashiro/数据清洗 特征提取 标注 前期汇总原包")
UNKNOWN = {"status": "unknown", "precision": "unknown", "earliest_utc": None,
           "latest_exclusive_utc": None, "source_timezone": "Asia/Shanghai"}
SOURCE_ID = "user-materials"
OFFICIAL_URL = "https://static.cninfo.com.cn/finalpage/2026-08-15/1225475348.PDF"


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", "utf-8")


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def interval(start, end, precision):
    def utc(text):
        return datetime.fromisoformat(text + "+08:00").astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"status": "known", "precision": precision, "earliest_utc": utc(start),
            "latest_exclusive_utc": utc(end), "source_timezone": "Asia/Shanghai"}


def day_time(day):
    start = datetime.strptime(day, "%Y%m%d")
    return interval(start.strftime("%Y-%m-%dT00:00:00"),
                    (start + timedelta(days=1)).strftime("%Y-%m-%dT00:00:00"), "day")


def fetch_official():
    """仅取得对应单份公告，保留响应字节与本轮真实取得时间。"""
    request = urllib.request.Request(OFFICIAL_URL, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.cninfo.com.cn/"})
    with urllib.request.urlopen(request, timeout=45) as response:
        raw = response.read()
        metadata = {"requested_url": OFFICIAL_URL, "response_url": response.url, "http_status": response.status,
                    "content_type": response.headers.get("Content-Type"), "acquired_at_utc": utc_now(),
                    "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
    if not raw.startswith(b"%PDF-"):
        raise ValueError("官方端点未返回PDF，不能作为公告原件")
    FIXTURES.mkdir(parents=True, exist_ok=True)
    pdf = FIXTURES / "cninfo_1225475348.pdf"
    pdf.write_bytes(raw)
    save(FIXTURES / "official_acquisition.json", metadata)
    pdf_python = "/Users/mashiro/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"
    extracted = subprocess.run([pdf_python, "-c", "from pypdf import PdfReader; import sys; print('\\n\\f\\n'.join(p.extract_text() for p in PdfReader(sys.argv[1]).pages))", str(pdf)],
                               check=True, capture_output=True, text=True)
    (FIXTURES / "cninfo_1225475348.txt").write_text(extracted.stdout, "utf-8")
    return metadata


def prepare_inputs():
    """只抽取已存在材料，不联网、不执行素材中的代码。"""
    sources, quotes = [], []

    def source(path, role):
        sources.append({"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "role": role})
        return len(sources) - 1

    for day in ["20261012", "20261013", "20261014", "20261015", "20261016"]:
        path = MATERIALS / "静态数据库/原包/每日日线/按交易日/2026" / f"{day}@余哈哈的数据仓库 原创整理.csv"
        index = source(path, "compiled_market_data")
        with path.open(encoding="utf-8-sig", newline="") as stream:
            row = next(r for r in csv.DictReader(stream) if r["股票代码"] == "000001")
        quotes.append({"source_index": index, "raw": row})
    identity_path = MATERIALS / "静态数据库/原包/上市企业名单和概念分类/上市公司基本信息/2026/20261014_上市公司基本信息@余哈哈的数据仓库 原创整理.csv"
    identity_index = source(identity_path, "compiled_company_identity")
    with identity_path.open(encoding="utf-8-sig", newline="") as stream:
        company = next(r for r in csv.DictReader(stream) if r["TS股票代码"] == "000001.SZ")
    report_path = MATERIALS / "测试用目录数据类型/提炼_XuanRoot/样例/分析记录_真实内容样例.json"
    report_index = source(report_path, "upstream_analysis_with_announcement_claims")
    report = json.loads(report_path.read_text("utf-8"))
    facts = report["output"]["verified_facts"]
    financial_text = next(f["fact"] for f in facts if "241.41" in f["fact"])
    dividend_text = next(f["fact"] for f in facts if "48.32" in f["fact"])
    profit = re.search(r"2026H1 归母普通股股东净利润 ([\d.]+) 亿元", financial_text).group(1)
    dividend = re.search(r"合计 ([\d.]+) 亿元", dividend_text).group(1)
    per_ten = re.search(r"每 10 股派 ([\d.]+) 元", dividend_text).group(1)
    data = {"acquired_at_utc": utc_now(), "security_code": "000001", "security_name": "平安银行",
            "company": company, "identity_source_index": identity_index, "quotes": quotes,
            "financial": [{"period": "2026H1", "parent_ordinary_shareholders_net_profit_cny_100million": profit,
                           "proposed_dividend_total_cny_100million": dividend, "proposed_dividend_per_10shares_cny": per_ten,
                           "content_nature": "source_claim"}],
            "announcement": {"source_index": report_index, "announcement_no": "2026-031", "board_date_claim": "2026-08-14",
                             "public_date_claim": "2026-08-15", "source_url": report["inputs"]["evidence_refs"][0]["url"],
                             "upstream_evidence_claim": report["inputs"]["evidence_refs"][0],
                             "fact_texts": [f["fact"] for f in facts], "original_pdf_custodied": False,
                             "upstream_integrity_independently_verified": False},
            "sources": sources, "license": "unknown", "usage_scope": "user_local_validation",
            "limitations": ["公告原PDF未在本轮保管；财务与公告为本地真实分析记录的来源转述，不冒充原件独立复核。",
                            "财务只有2026H1归母普通股股东净利润与拟分红字段，不是完整财报；拟分红不冒充已经派息。",
                            "披露日2026-08-15为上游文字主张；上游published_at为空，历史严格资格仍保留unknown。",
                            "上游observed_at、captured_at及claimed SHA只作来源链，不当成本轮WFD历史持有或原件验证。",
                            "关系有效期未知；五个已观测交易日期不等于完整交易日历。",
                            "行情CSV有复权因子但未提供价格复权口径，本轮原值保存且复权状态未知。",
                            "许可及对外分发资格未确认，仅用于用户授权的本机样本库。"]}
    official_path = FIXTURES / "cninfo_1225475348.pdf"
    if official_path.exists():
        official_meta = json.loads((FIXTURES / "official_acquisition.json").read_text("utf-8"))
        official_text = (FIXTURES / "cninfo_1225475348.txt").read_text("utf-8")
        compact = re.sub(r"\s+", "", official_text)
        if "公告编号：2026-031" not in compact or "平安银行股份有限公司董事会决议公告" not in compact:
            raise ValueError("原件公告身份不匹配，停止使用旧样例")
        ordinary_profit = re.search(r"普通股股东的净利润为人民币([\d.]+)亿元", compact).group(1)
        parent_profit = re.search(r"合并报表中归属于本行股东的净利润为人民币([\d.]+)亿元", compact).group(1)
        dividend_total = re.search(r"合计派发现金股利人民币([\d.]+)亿元", compact).group(1)
        dividend_per_ten = re.search(r"每10股派发现金股利人民币([\d.]+)元", compact).group(1)
        data["financial"][0].update(parent_ordinary_shareholders_net_profit_cny_100million=ordinary_profit,
                                    parent_shareholders_net_profit_cny_100million=parent_profit,
                                    proposed_dividend_total_cny_100million=dividend_total,
                                    proposed_dividend_per_10shares_cny=dividend_per_ten)
        data["announcement"].update(original_pdf_custodied=True, official_source_index=source(official_path, "issuer_original_announcement"),
                                    official_acquisition=official_meta, public_time=day_time("20260815"),
                                    upstream_integrity_independently_verified=(official_meta["sha256"] == data["announcement"]["upstream_evidence_claim"]["sha256"].removeprefix("sha256:")),
                                    issuer="平安银行股份有限公司", disclosure_platform="巨潮资讯网",
                                    official_locator="第1页议案二：2026H1两种净利润口径；第2页：拟分红；第3页：公告署期",
                                    prior_sample_values_match=(profit, dividend, per_ten) == (ordinary_profit, dividend_total, dividend_per_ten))
        data["limitations"] = ["已保管并核对对应公司公告原件；公司披露主张不等于平台对财务真实性的独立审计。",
                               "财务仅含2026H1两种净利润口径及拟分红，不是完整财务报表；拟分红不冒充已派息。",
                               "公告公开日期按原件署期保留日精度；没有虚构精确发布时刻。",
                               "历史行情公开时间、证券关系有效期间和价格复权口径仍未知；五日样本不等于完整交易日历。",
                               "实际取得时间为本轮网络下载与本地接收时间；不把上游历史采集时间当WFD已持有。",
                               "许可及对外分发资格未确认，仅用于用户授权的本机样本库。"]
    save(FIXTURES / "inputs.json", data)
    return data


def value(text, datatype="text"):
    return {"data_type": datatype, "value_state": "valid_value", "value": str(text)}


def field(name, datatype, unit, nature="stock", role="observation"):
    return {"field_code": name, "data_type": datatype, "unit_code": unit,
            "measurement_nature": nature, "time_role": role}


def output(key, domain, subject, kind, rows, evidence, definition):
    return {"output_key": key, "logical_domain": domain, "subject": subject,
            "definition_mode": "create", "definition_ref": None, "new_definition_declaration": definition,
            "input_mode": "partial_observation",
            "coverage": {"scope": {"security": "000001.SZ", "sample_only": True},
                         "basis": "observed_partial", "completeness": "partial", "coverage_evidence": [], "absence_means": "unknown"},
            "payload": {"kind": kind, "rows": rows}, "evidence_refs": evidence}


def definition(code, authority, nature="mixed_observation", fields=None):
    result = {"semantic_code": code, "measurement_nature": nature, "unit_code": "per_field",
              "definition_authority": authority, "time_role": "observation"}
    if fields:
        result["field_definitions"] = fields
    return result


def make_documents(data, evidence):
    company = {"kind": "entity", "namespace": "cn.uscc", "id": data["company"]["统一社会信用代码"]}
    security = {"kind": "instrument", "namespace": "cn.szse.security_code", "id": "000001"}
    identity_ev = [evidence[data["identity_source_index"]]]
    announcement = data["announcement"]
    report_ev = [evidence[announcement["source_index"]]]
    if announcement.get("original_pdf_custodied"):
        report_ev = [evidence[announcement["official_source_index"]]]
    identity_fields = [field(k, "text", "text") for k in ["company_name", "security_code", "security_name", "exchange"]]
    identity_row = {"business_key": "identity_000001_material_20261014", "subject": company,
                    "observation_time": copy.deepcopy(UNKNOWN), "values": {
                        "company_name": value(data["company"]["公司全称"]), "security_code": value("000001.SZ"),
                        "security_name": value(data["security_name"]), "exchange": value(data["company"]["交易所"])}}
    relation_def = definition("cn.security.issued_by", "user.materials.company_roster", "relation")
    relation_def.update(unit_code="not_applicable", relation_semantics={"directed": True, "relation_type": "issued_by"})
    relation = {"business_key": "000001_issued_by_91440300192185379H", "subject": security, "object": company,
                "relation_type": "issued_by", "effective_period": copy.deepcopy(UNKNOWN), "public_time": copy.deepcopy(UNKNOWN)}
    foundation = [output("company_identity", "foundation", company, "tabular_rows", [identity_row], identity_ev,
                         definition("cn.company.material_identity", "user.materials.company_roster", fields=identity_fields)),
                  output("security_issuer", "foundation", security, "relation_edges", [relation], identity_ev, relation_def)]
    quote_specs = [("open", "开盘价（元）", "cny_per_share", "stock"), ("high", "最高价（元）", "cny_per_share", "stock"),
                   ("low", "最低价（元）", "cny_per_share", "stock"), ("close", "收盘价（元）", "cny_per_share", "stock"),
                   ("volume_lot", "成交量（手）", "lot_100_shares", "flow"), ("amount_cny_10000", "成交额（万元）", "cny_10000", "flow")]
    quote_rows = [{"business_key": "000001_" + q["raw"]["交易日期"], "subject": security,
                   "observation_time": day_time(q["raw"]["交易日期"]),
                   "values": {key: value(q["raw"][column], "decimal") for key, column, _, _ in quote_specs}}
                  for q in data["quotes"]]
    quotes = [output("daily_bars", "observations", security, "tabular_rows", quote_rows,
                     [evidence[q["source_index"]] for q in data["quotes"]],
                     definition("cn.equity.daily_bar.material_adjustment_unspecified", "user.materials.daily_csv",
                                fields=[field(k, "decimal", unit, nature, "bar_interval") for k, _, unit, nature in quote_specs]))]
    financial_fields = [field("parent_ordinary_shareholders_net_profit", "decimal", "cny_100million", "flow", "reporting_period"),
                        field("proposed_dividend_total", "decimal", "cny_100million", "event", "reporting_period"),
                        field("proposed_dividend_per_10shares", "decimal", "cny_per_10_shares", "event", "reporting_period"),
                        field("content_nature", "text", "text")]
    financial_rows = [{"business_key": "000001_financial_2026H1_announcement_claim", "subject": company,
                       "observation_time": interval("2026-01-01T00:00:00", "2026-07-01T00:00:00", "interval"),
                       "values": {"parent_ordinary_shareholders_net_profit": value(f["parent_ordinary_shareholders_net_profit_cny_100million"], "decimal"),
                                  "proposed_dividend_total": value(f["proposed_dividend_total_cny_100million"], "decimal"),
                                  "proposed_dividend_per_10shares": value(f["proposed_dividend_per_10shares_cny"], "decimal"),
                                  "content_nature": value("source_claim")}}
                      for f in data["financial"]]
    if announcement.get("original_pdf_custodied"):
        financial_fields.append(field("parent_shareholders_net_profit", "decimal", "cny_100million", "flow", "reporting_period"))
        financial_rows[0]["values"]["parent_shareholders_net_profit"] = value(data["financial"][0]["parent_shareholders_net_profit_cny_100million"], "decimal")
    financial = [output("historical_financial_claim", "observations", company, "tabular_rows", financial_rows, report_ev,
                         definition("cn.company.financial.announcement_claim", "user.materials.cninfo_announcement_transcription", fields=financial_fields))]
    event = {"event_id": "pab_board_2026_031", "case_id": "000001_2026H1_dividend_proposal",
             "subject": company, "event_type": "board_resolution_announcement", "content_nature": "source_claim",
             "event_time": day_time("20260814"), "public_time": announcement.get("public_time", copy.deepcopy(UNKNOWN)), "status": "board_approved_proposal",
             "values": {"announcement_no": value(announcement["announcement_no"]), "claimed_public_date": value(announcement["public_date_claim"]),
                        "source_url": value(announcement["source_url"]), "content": value("；".join(announcement["fact_texts"])),
                        "original_pdf_custodied": {"data_type": "boolean", "value_state": "valid_value", "value": announcement["original_pdf_custodied"]}}}
    events = [output("announcement_event_claim", "events", company, "event_records", [event], report_ev,
                      definition("cn.company.board_resolution.announcement_claim", "user.materials.cninfo_announcement_transcription", "event"))]
    groups = [("foundation", foundation), ("market", quotes), ("financial", financial), ("event", events)]
    documents = []
    for name, outputs in groups:
        public_time = announcement.get("public_time", copy.deepcopy(UNKNOWN)) if name in {"financial", "event"} else copy.deepcopy(UNKNOWN)
        if name in {"financial", "event"} and announcement.get("original_pdf_custodied"):
            for out in outputs:
                out["new_definition_declaration"]["definition_authority"] = "cn.pab.issuer_disclosure"
        documents.append({"protocol_version": "wfd.ingest/1.3-candidate", "intent": "submit", "producer_namespace": "wfd.local.financial_slice",
                          "request_identity": {"dataset_id": "cn_000001_first_financial_slice", "trusted_actor_namespace": "wfd.local.financial_slice",
                                               "request_id": "financial_slice_" + name, "submission_digest": "sha256:" + "0" * 64},
                          "expected_parent_snapshot_id": None, "outputs": outputs,
                          "source_bundle": {"source_id": SOURCE_ID, "public_time": public_time,
                                            "acquired_at_utc": data["acquired_at_utc"], "license": "unknown", "usage_scope": "user_local_validation",
                                            "source_materials": data["sources"], "upstream_evidence_claim": announcement["upstream_evidence_claim"],
                                            "upstream_original_custodied": announcement["original_pdf_custodied"],
                                            "official_acquisition": announcement.get("official_acquisition"),
                                            "source_role": "issuer_disclosure" if name in {"financial", "event"} and announcement["original_pdf_custodied"] else "user_provided_compilation",
                                            "product_service": {"version": "wfd.product-service/0.3",
                                                "outputs": {out["output_key"]: {"read_dependencies": []} for out in outputs}},
                                            "limitations": data["limitations"]}})
    return company, documents


def run(data, base):
    sys.path.insert(0, str(ENGINE))
    from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
    from wfd_sdk.product_service import WFDProductService
    from wfd_sdk.duckdb_sdk import canonical, sha
    run_dir = base / datetime.now(timezone.utc).strftime("run_%Y%m%dT%H%M%SZ")
    run_dir.mkdir(parents=True, exist_ok=False)
    policy = {SOURCE_ID: {"may_submit": True, "may_publish_formal": True,
                           "may_read": True, "may_read_evidence": True,
                           "license": "unknown", "usage_scope": "user_local_validation"}}

    def service(runtime):
        engine = WFDDuckDBPrototype(run_dir / "store", load_protocol_validator(ENGINE / "protocol"),
                                   runtime_root=run_dir / runtime, sandbox=False, writer_host="financial-slice")
        return WFDProductService(engine, allowed_sources=policy,
                                 caller_roles={"evidence_write", "register", "submit", "publish",
                                               "read", "read_evidence", "export", "redistribute"},
                                 caller_id="financial-slice",
                                 unit_registry={
                                     "text": {"dimension": "text"},
                                     "identifier": {"dimension": "identifier"},
                                     "cny_per_share": {"dimension": "money_per_share"},
                                     "lot_100_shares": {"dimension": "quantity"},
                                     "share": {"dimension": "quantity"},
                                     "cny": {"dimension": "money"},
                                     "percent": {"dimension": "ratio"},
                                     "cny_100million": {"dimension": "money"},
                                     "cny_per_10_shares": {"dimension": "money_per_share"},
                                     "cny_10000": {"dimension": "money"},
                                     "date": {"dimension": "date"},
                                     "day_of_week": {"dimension": "ordinal"},
                                     "boolean": {"dimension": "boolean"},
                                     "timezone": {"dimension": "identifier"},
                                 },
                                 trusted_actor_namespaces={"wfd.local.financial_slice"})

    writer = service("runtime_writer")
    evidence = []
    for item in data["sources"]:
        ev = writer.register_evidence(item["path"])
        if ev["content_sha256"] != "sha256:" + item["sha256"]:
            raise ValueError("原材料已变化，请重新执行 --prepare-only 更新样本来源")
        evidence.append(ev)
    company, documents = make_documents(data, evidence)
    receipts, submitted = [], []
    for document in documents:
        head = writer.engine.head()
        document["expected_parent_snapshot_id"] = head["snapshot_id"] if head else None
        fingerprint_doc = copy.deepcopy(document)
        fingerprint_doc["request_identity"].pop("submission_digest")
        document["request_identity"]["submission_digest"] = "sha256:" + sha(canonical(fingerprint_doc))
        receipt = writer.submit(document)
        submitted.append(document)
        receipts.append(receipt)
        save(run_dir / "requests.json", submitted)
        save(run_dir / "receipts.json", receipts)
        if not receipt.get("snapshot_id") or any(r["publication_state"] != "published_formal" for r in receipt.get("output_results", [])):
            raise RuntimeError("提交未完整通过，具体回执已保存：" + str(run_dir / "receipts.json"))
    snapshot = receipts[-1]["snapshot_id"]
    reader = service("runtime_reader")
    fixed = reader.read(snapshot_id=snapshot)
    company_view = reader.company_view(company, snapshot_id=snapshot)
    historical = {"market_before": reader.read(snapshot_id=snapshot, perspective="market_known_at", at="2026-08-14T15:59:59Z"),
                  "market_during_public_day": reader.read(snapshot_id=snapshot, perspective="market_known_at", at="2026-08-15T04:00:00Z"),
                  "market_after_public_day": reader.read(snapshot_id=snapshot, perspective="market_known_at", at="2026-08-15T16:00:00Z"),
                  "held_before": reader.read(snapshot_id=snapshot, perspective="system_held_at", at="2026-10-01T00:00:00Z"),
                  "held_after": reader.read(snapshot_id=snapshot, perspective="system_held_at", at="2026-12-31T23:59:59Z")}
    expected = [row for doc in documents for out in doc["outputs"] for row in out["payload"]["rows"]]
    actual = [record["row"] for record in fixed["rows"]]
    matches = sorted(map(canonical, expected)) == sorted(map(canonical, actual))
    save(run_dir / "fixed_read.json", fixed)
    save(run_dir / "company_view.json", company_view)
    save(run_dir / "historical_reads.json", historical)
    traces = [reader.trace(item["product_id"], snapshot_id=snapshot) for receipt in receipts for item in receipt["output_results"]]
    save(run_dir / "source_traces.json", traces)
    summary = {"snapshot_id": snapshot, "store": str(run_dir / "store"), "input_rows": len(expected), "read_rows": len(actual),
               "exact_row_match": matches, "company_view_rows": len(company_view["rows"]),
               "product_count": sum(len(r["output_results"]) for r in receipts), "evidence_files": len(evidence),
               "historical_row_counts": {key: len(result["rows"]) for key, result in historical.items()},
               "product_slice_status": "executed_with_declared_gaps" if matches else "readback_mismatch",
               "official_announcement_complete": data["announcement"]["original_pdf_custodied"], "production_accepted": False, "limitations": data["limitations"]}
    save(run_dir / "summary.json", summary)
    print(json.dumps({"run_dir": str(run_dir), **summary}, ensure_ascii=False, indent=2))
    return 0 if matches else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-only", action="store_true", help="只从授权原包提取小型结构化输入")
    parser.add_argument("--fetch-official", action="store_true", help="联网取得并核对当前单份巨潮公告原件，然后更新输入")
    parser.add_argument("--output", type=Path, default=PROJECT / "03_测试与验证记录/首个金融产品闭环_2026-10-26")
    args = parser.parse_args()
    if args.fetch_official:
        print(json.dumps(fetch_official(), ensure_ascii=False, indent=2))
    if args.prepare_only or args.fetch_official:
        prepared = prepare_inputs()
        print(json.dumps({"inputs": str(FIXTURES / "inputs.json"), "quote_rows": len(prepared["quotes"]), "financial_rows": len(prepared["financial"]),
                          "source_files": len(prepared["sources"]), "limitations": prepared["limitations"]}, ensure_ascii=False, indent=2))
    else:
        raise SystemExit(run(json.loads((FIXTURES / "inputs.json").read_text("utf-8")), args.output))
