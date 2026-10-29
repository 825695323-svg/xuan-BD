#!/usr/bin/env python3
"""Bounded P2 foundation run: real evidence pack, fixed-snapshot readback, gaps.

This script does not claim the P2 package is complete.  It builds one real
foundation set from the prepared 2026-10-16 candidates, submits it through the
unchanged generic product service, reads it back in a new instance and records
every remaining evidence gap.  Boundary behaviour (code switch, cross-market
ambiguity, partial membership) is covered by the dedicated pytest fixture.
"""
from __future__ import annotations

import csv
import json
from decimal import Decimal
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
PROJECT = ENGINE.parents[1]
sys.path.insert(0, str(ENGINE))

from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator  # noqa: E402
from wfd_sdk.product_service import SERVICE_VERSION, WFDProductService  # noqa: E402
from wfd_sdk import product_foundations as f  # noqa: E402


ROLES = {"evidence_write", "register", "submit", "publish", "read", "read_evidence",
         "export", "redistribute"}
READ_ROLES = {"read", "read_evidence"}
POLICY = {
    "may_submit": True, "may_publish_formal": True, "may_read": True,
    "may_read_evidence": True, "may_export": True, "may_export_evidence": True,
    "export_scope": "user_local_validation_only", "usage_scope": "p2_foundations_local",
    "license": "local_use_only_external_redistribution_unknown",
}
DATASET = "wfd_p2_foundations_20261027"
NAMESPACE = "wfd.p2.foundations"
CAND = PROJECT / "03_测试与验证记录/首发数据准备_2026-10-27/prepared_candidates"
SAMPLES = PROJECT / "03_测试与验证记录/首发数据准备_2026-10-27/samples"
COMPLETION = PROJECT / "03_测试与验证记录/首发数据准备_2026-10-27/evidence_completion"
DAILY_ROOT = Path("/Users/mashiro/数据清洗 特征提取 标注 前期汇总原包/静态数据库/原包/每日日线/按交易日")
P2 = PROJECT / "03_测试与验证记录/P2_基础身份与语义_2026-10-27"
RUN = P2 / ("run_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
ENGINE_DIR = "产品开发"


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", "utf-8")


def make_service(root, runtime, roles, caller):
    engine = WFDDuckDBPrototype(root, load_protocol_validator(ENGINE / "protocol"),
                                runtime_root=runtime, sandbox=False, writer_host=caller)
    units = {"cny": {"dimension": "money"}, "cny_10000": {"dimension": "money"},
             "cny_100million": {"dimension": "money"},
             "lot_100_shares": {"dimension": "quantity"},
             "cny_per_share": {"dimension": "money_per_share"},
             "teu": {"dimension": "quantity"},
             "ten_thousand_teu": {"dimension": "quantity"}}
    return WFDProductService(engine, allowed_sources={f.EVIDENCE_SOURCE_ID: dict(POLICY)},
                             caller_roles=roles, caller_id=caller, unit_registry=units,
                             trusted_actor_namespaces={NAMESPACE})


def daily_file(day):
    return next((DAILY_ROOT / day[:4]).glob(day + "*.csv"))


def daily_row(day, code):
    path = daily_file(day)
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            if row.get("股票代码") == code:
                return row
    raise SystemExit("DAILY_ROW_MISSING:%s:%s" % (day, code))


def custody(service, path, label, evidence, meta):
    ref = service.register_evidence(path)
    evidence[label] = ref
    meta[label] = {"path": str(path), "content_sha256": ref["content_sha256"],
                   "size": path.stat().st_size}
    return ref


def read_calendar():
    prepared = json.loads((CAND / "p2_calendar_2021_2025.json").read_text("utf-8"))
    raw = json.loads((SAMPLES / "szse_calendar_2021_2025.json").read_text("utf-8"))
    raw_dates = sorted(day["jyrq"] for month in raw["months"] for day in month["days"]
                       if str(day.get("jybz")) == "1")
    if raw_dates != prepared["dates"]:
        raise SystemExit("CALENDAR_SOURCE_MISMATCH")
    if len(raw_dates) != prepared["count"] or len(raw_dates) != 1212:
        raise SystemExit("CALENDAR_COUNT_MISMATCH")
    if any(month.get("http_status") != 200 for month in raw["months"]):
        raise SystemExit("CALENDAR_HTTP_STATUS_MISMATCH")
    return prepared, raw


def read_stock_rows(codes):
    path = Path(json.loads((CAND / "p2_identity_candidates.json").read_text("utf-8"))
                ["companies"]["000001"]["current"]["source_file"])
    if not path.is_file():
        raise SystemExit("STOCK_SOURCE_MISSING:" + str(path))
    found = {}
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        for row in reader:
            code = row.get("股票代码")
            if code in codes:
                found[code] = (row, reader.line_num)
    if set(found) != set(codes):
        raise SystemExit("STOCK_ROW_MISSING:" + ",".join(sorted(set(codes) - set(found))))
    return path, found


def build_pack(evidence):
    candidates = json.loads((CAND / "p2_identity_candidates.json").read_text("utf-8"))
    prepared_calendar, raw_calendar = read_calendar()
    codes = sorted(candidates["companies"])
    stock_path, stock_rows = read_stock_rows(codes)
    cninfo = json.loads((SAMPLES / "cninfo_stocklist_candidates.json").read_text("utf-8"))["candidates"]
    bse_text = {
        "920185": (CAND / "evidence/920185_bse_listing.txt").read_text("utf-8"),
        "920077": (CAND / "evidence/920077_bse_listing.txt").read_text("utf-8"),
    }
    if not all("2021 年 11 月 15 日" in text or "2021年11月15日" in text for text in bse_text.values()):
        raise SystemExit("BSE_LISTING_DATE_EVIDENCE_MISSING")
    icbc_text = (SAMPLES / "excerpts/601398_2025_annual_summary.txt").read_text("utf-8")
    if "H 股 工商银行 1398 香港联合交易所有限公司" not in icbc_text:
        raise SystemExit("ICBC_AH_EVIDENCE_MISSING")
    unit_candidates = json.loads((CAND / "p2_unit_candidates.json").read_text("utf-8"))
    if not any(item.get("name") == "minute.volume" and item.get("unit") == "unknown"
               for item in unit_candidates["definitions"]):
        raise SystemExit("MINUTE_UNIT_UNKNOWN_NOT_PRESERVED")
    daily_header = (SAMPLES / "minute_20250102_sample.csv").read_text("utf-8-sig").splitlines()[0]
    if ("成交量" not in daily_header or "成交额" not in daily_header
            or "成交量（" in daily_header or "成交额（" in daily_header):
        raise SystemExit("MINUTE_HEADER_EVIDENCE_MISMATCH")

    old_fixture = ENGINE / "fixtures/financial_slice/inputs.json"
    old_data = json.loads(old_fixture.read_text("utf-8"))
    if old_data.get("security_code") != "000001":
        raise SystemExit("OLD_000001_FIXTURE_MISMATCH")
    st_events = json.loads((COMPLETION / "p2_st_events.json").read_text("utf-8"))["events"]
    bse_evidence = json.loads((COMPLETION / "bse_code_switch_evidence.json").read_text("utf-8"))
    port_text = (SAMPLES / "pdf/600018_2025_annual_summary.txt").read_text("utf-8")
    if "上海港公共\n码头运营商" not in port_text and "上海港公共码头运营商" not in port_text:
        raise SystemExit("PORT_OPERATOR_SENTENCE_MISSING")
    if "5506.3万标准箱" not in port_text:
        raise SystemExit("PORT_TEU_VALUE_MISSING")
    sample = daily_row("20250102", "000001")
    sample_amount_wan = sample["成交额（万元）"]
    sample_volume_lots = sample["成交量（手）"]
    sample_close = sample["收盘价（元）"]

    pack = {
        "dataset_id": DATASET, "observed_at": "2026-10-16",
        "regions": [{"id": "region_cn", "code": "CN", "name": "中国",
                     "evidence_labels": ["macro", "stock_20261016"]}],
        "markets": [
            {"id": "market_szse", "code": "SZSE", "name": "深圳证券交易所",
             "region_id": "region_cn", "evidence_labels": ["stock_20261016", "calendar_raw"]},
            {"id": "market_sse", "code": "SSE", "name": "上海证券交易所",
             "region_id": "region_cn", "evidence_labels": ["stock_20261016", "icbc_report"]},
            {"id": "market_bse", "code": "BSE", "name": "北京证券交易所",
             "region_id": "region_cn", "evidence_labels": ["stock_20261016", "bse_920185_listing", "bse_920077_listing"]},
            {"id": "market_hkex", "code": "HKEX", "name": "香港联合交易所有限公司",
             "region_id": "region_cn", "evidence_labels": ["icbc_report"]},
        ],
        "entities": [], "instruments": [], "listings": [], "name_claims": [],
        "physical_objects": [{
            "id": "physical_shanghai_port", "name": "上海港（母港）", "object_type": "port",
            "region_id": None, "region_status": "unknown", "observed_at": "2026-10-16",
            "object_scope": "company_home_port_container_throughput",
            "operator_scope": "public_terminal_operator_statement",
            "scope_note": "年报称上港集团为上海港公共码头运营商；5506.3万TEU是公司母港口径，不延伸全上海港经营权或全港统计",
            "source_file": str(SAMPLES / "pdf/600018_2025_annual_summary.txt"),
            "evidence_labels": ["port_pdf_text"]}],
        "relations": [],
        "calendar": {"market_id": "market_szse", "market_code": "SZSE",
                     "dates": prepared_calendar["dates"],
                     "range": prepared_calendar["range"],
                     "evidence_labels": ["calendar_raw"]},
        "units": [
            {"unit_code": "cny", "dimension": "money", "display_name": "人民币元",
             "base_unit": "cny", "scale_factor": "1", "period_basis": "per_definition",
             "null_rule": "unknown", "status": "source_header",
             "definition_scope": "人民币基础元；价格/成交额换算基准",
             "evidence_basis": "日线/分钟价格表头（元）", "evidence_labels": ["unit_headers", "daily_20250102"]},
            {"unit_code": "cny_10000", "dimension": "money", "display_name": "人民币万元",
             "base_unit": "cny", "scale_factor": "10000", "period_basis": "per_definition",
             "null_rule": "unknown", "status": "source_header",
             "definition_scope": "日线成交额表头万元；1 万元 = 10,000 元",
             "evidence_basis": "每日日线表头：成交额（万元）", "evidence_labels": ["daily_20250102"]},
            {"unit_code": "cny_100million", "dimension": "money", "display_name": "人民币亿元",
             "base_unit": "cny", "scale_factor": "100000000", "period_basis": "per_definition",
             "null_rule": "unknown", "status": "source_note",
             "definition_scope": "宏观表注亿元；不等于日线成交额万元",
             "evidence_basis": "宏观表注：亿元，当年价格", "evidence_labels": ["macro"]},
            {"unit_code": "lot_100_shares", "dimension": "quantity", "display_name": "手（100股）",
             "base_unit": "share", "scale_factor": "100", "period_basis": "flow",
             "null_rule": "unknown", "status": "source_header",
             "definition_scope": "日线成交量表头手；1 手 = 100 股（表头口径）",
             "evidence_basis": "日线表头：成交量（手）", "evidence_labels": ["unit_headers", "daily_20250102"]},
            {"unit_code": "cny_per_share", "dimension": "money_per_share", "display_name": "元/股",
             "base_unit": "cny_per_share", "scale_factor": "1", "period_basis": "point_in_time",
             "null_rule": "unknown", "status": "source_header",
             "definition_scope": "价格表头元；复权状态未知，不称未复权",
             "evidence_basis": "日线表头：开盘价（元）等；调整状态未知",
             "evidence_labels": ["unit_headers", "daily_20250102", "semantic_evidence"]},
            {"unit_code": "teu", "dimension": "quantity", "display_name": "标准箱（TEU）",
             "base_unit": "teu", "scale_factor": "1", "period_basis": "flow",
             "null_rule": "unknown", "status": "source_text",
             "definition_scope": "基础 TEU；不直接绑定原文的万标准箱值",
             "evidence_basis": "上港集团 2025 年报摘要：万标准箱",
             "evidence_labels": ["port_pdf_text"]},
            {"unit_code": "ten_thousand_teu", "dimension": "quantity", "display_name": "万标准箱（万TEU）",
             "base_unit": "teu", "scale_factor": "10000", "period_basis": "flow",
             "null_rule": "unknown", "status": "source_text",
             "definition_scope": "公司母港口径；1 万TEU = 10,000 TEU",
             "evidence_basis": "上港集团 2025 年报摘要：母港 5506.3 万标准箱",
             "evidence_labels": ["port_pdf_text"]},
        ],
        "metric_bindings": [
            {"metric_code": "daily.price", "unit_code": "cny_per_share", "unit_status": "known",
             "period_basis": "point_in_time", "null_rule": "unknown", "adjustment_basis": "unknown",
             "sample_value": sample_close, "sample_unit": "元/股", "sample_basis": "2025-01-02 000001 收盘价",
             "conversion_rule": "元/股 × 1 = 元/股；复权状态未知",
             "scope_note": "表头元；不能把复权因子原值等同未复权价",
             "evidence_basis": "每日日线表头；复权因子无定义", "evidence_labels": ["unit_headers", "daily_20250102", "semantic_evidence"]},
            {"metric_code": "daily.volume", "unit_code": "lot_100_shares", "unit_status": "known",
             "period_basis": "flow", "null_rule": "unknown", "adjustment_basis": "not_applicable",
             "sample_value": sample_volume_lots, "sample_unit": "手", "sample_basis": "2025-01-02 000001 成交量",
             "conversion_rule": "手 × 100 = 股（表头口径）",
             "scope_note": "日线成交量表头单位手",
             "evidence_basis": "每日日线表头：成交量（手）", "evidence_labels": ["daily_20250102"]},
            {"metric_code": "daily.amount", "unit_code": "cny_10000", "unit_status": "known",
             "period_basis": "flow", "null_rule": "unknown", "adjustment_basis": "not_applicable",
             "sample_value": sample_amount_wan, "sample_unit": "万元", "sample_basis": "2025-01-02 000001 成交额",
             "conversion_rule": "万元 × 10000 = 元",
             "scope_note": "日线成交额表头万元；原值有浮点尾数",
             "evidence_basis": "每日日线表头：成交额（万元）", "evidence_labels": ["daily_20250102"]},
            {"metric_code": "minute.price", "unit_code": "cny_per_share", "unit_status": "known",
             "period_basis": "unknown", "null_rule": "unknown", "adjustment_basis": "unknown",
             "sample_value": None, "sample_unit": "元/股（表头）", "sample_basis": "1分钟表头开盘价（元）",
             "conversion_rule": "元/股 × 1；调整状态未知",
             "scope_note": "分钟价格表头元；复权状态未知",
             "evidence_basis": "1分钟表头：开盘价（元）等；调整状态未知",
             "evidence_labels": ["unit_headers", "semantic_evidence"]},
            {"metric_code": "minute.volume", "unit_code": None, "unit_status": "unknown",
             "period_basis": "unknown", "null_rule": "unknown", "adjustment_basis": "not_applicable",
             "sample_value": None, "sample_unit": None, "sample_basis": "表头只写成交量",
             "conversion_rule": "不推断；股仅为对账候选",
             "scope_note": "未知保持未知",
             "evidence_basis": "表头只写成交量；股仅为对账推断，不登记", "evidence_labels": ["unit_headers", "semantic_evidence"]},
            {"metric_code": "minute.amount", "unit_code": None, "unit_status": "unknown",
             "period_basis": "unknown", "null_rule": "unknown", "adjustment_basis": "not_applicable",
             "sample_value": None, "sample_unit": None, "sample_basis": "表头只写成交额",
             "conversion_rule": "不推断；元仅为对账候选",
             "scope_note": "未知保持未知",
             "evidence_basis": "表头只写成交额；元仅为对账推断，不登记", "evidence_labels": ["unit_headers", "semantic_evidence"]},
            {"metric_code": "financial.amount", "unit_code": "cny", "unit_status": "known",
             "period_basis": "duration", "null_rule": "unknown", "adjustment_basis": "not_applicable",
             "sample_value": None, "sample_unit": "元", "sample_basis": "TDX 财务原值",
             "conversion_rule": "元 × 1；与年报百万元口径分列",
             "scope_note": "TDX 元与年报百万元不可混同",
             "evidence_basis": "TDX 财务元；与年报百万元口径存在小额差异", "evidence_labels": ["unit_candidates"]},
            {"metric_code": "macro.gdp", "unit_code": "cny_100million", "unit_status": "known",
             "period_basis": "year", "null_rule": "unknown", "adjustment_basis": "current_prices",
             "sample_value": "1349083.5", "sample_unit": "亿元", "sample_basis": "2024 GDP 原值",
             "conversion_rule": "亿元 × 100000000 = 元",
             "scope_note": "宏观亿元；当年价格；不连续年份不补造",
             "evidence_basis": "《2025年中国统计摘要》3-1 表注：亿元，当年价格", "evidence_labels": ["macro"]},
            {"metric_code": "physical.teu", "unit_code": "ten_thousand_teu", "unit_status": "known",
             "period_basis": "year", "null_rule": "unknown", "adjustment_basis": "not_applicable",
             "sample_value": "5506.3", "sample_unit": "万标准箱", "sample_basis": "2025 公司母港集装箱吞吐量",
             "conversion_rule": "万TEU × 10000 = TEU；5506.3 万TEU = 55,063,000 TEU",
             "scope_note": "公司母港口径，不是全上海港统计；经营关系仅限公共码头运营商陈述",
             "evidence_basis": "上港集团 2025 年报摘要：母港 5506.3 万标准箱", "evidence_labels": ["port_pdf_text"]},
        ],
    }

    for code in codes:
        row, line = stock_rows[code]
        current = candidates["companies"][code]["current"]
        entity_id = "entity_" + code
        legal_name = row.get("股票全称") or current.get("name")
        org = cninfo.get(code, {}).get("orgId")
        if code == "000001":
            entity = old_data["company"]
            legal_name = entity.get("公司全称") or legal_name
            display_name = old_data.get("security_name") or current["name"]
            observed_at = "2026-10-16"
            source_as_of = "2026-10-14"
            labels = ["old_fixture", "stock_20261016", "company_20261016"]
            source_file = current["source_file"]
            source_line = candidates["pingan_history_claim"]["source_line"]
            name_basis = "observed_only"
        else:
            display_name = current["name"]
            observed_at = "2026-10-16"
            source_as_of = observed_at
            labels = ["stock_20261016"]
            if code in {"920185", "920077"}:
                labels.extend(["bse_%s_listing" % code, "bse_rule_excerpt"])
            if code == "601398":
                labels.append("icbc_report")
            source_file = str(stock_path)
            source_line = line
            name_basis = "observed_only"
        pack["entities"].append({
            "id": entity_id, "display_name": display_name, "legal_name": legal_name,
            "org_id": org, "region_id": "region_cn", "observed_at": observed_at,
            "name_basis": name_basis, "source_as_of": source_as_of,
            "source_file": source_file, "source_line": source_line, "evidence_labels": labels})
        pack["instruments"].append({
            "id": "instrument_%s_a" % code, "issuer_id": entity_id, "instrument_type": "equity",
            "share_class": "A", "display_name": display_name, "org_id": org,
            "observed_at": "2026-10-16", "name_basis": "observed_only",
            "source_file": str(stock_path), "source_line": line, "evidence_labels": labels})

    # ICBC H share is a distinct instrument, not a second listing of the A share.
    pack["instruments"].append({
        "id": "instrument_601398_h", "issuer_id": "entity_601398", "instrument_type": "equity",
        "share_class": "H", "display_name": "工商银行", "org_id": cninfo["601398"]["orgId"],
        "observed_at": "2026-10-16", "name_basis": "observed_only",
        "source_file": str(SAMPLES / "excerpts/601398_2025_annual_summary.txt"),
        "source_line": 33, "evidence_labels": ["icbc_report", "stock_20261016"]})

    market_for = {"000001": ("market_szse", "主板"), "000002": ("market_szse", "主板"),
                  "002157": ("market_szse", "主板"), "300750": ("market_szse", "创业板"),
                  "600018": ("market_sse", "主板"), "600519": ("market_sse", "主板"),
                  "601318": ("market_sse", "主板"), "601398": ("market_sse", "主板"),
                  "603363": ("market_sse", "主板"), "688981": ("market_sse", "科创板"),
                  "920185": ("market_bse", "北交所"), "920077": ("market_bse", "北交所")}
    for code in codes:
        market_id, board = market_for[code]
        listing_id = "listing_%s_%s" % (code, market_id.replace("market_", ""))
        labels = ["stock_20261016"]
        if code == "601398":
            labels.append("icbc_report")
        if code in {"920185", "920077"}:
            labels.append("bse_%s_listing" % code)
        effective_from = "2006-10-27" if code == "601398" else None
        validity = "proven_start_open_end" if effective_from else "observed_only"
        pack["listings"].append({
            "id": listing_id, "instrument_id": "instrument_%s_a" % code, "market_id": market_id,
            "code": code, "board": board, "currency": "CNY", "status": "上市",
            "observed_at": "2026-10-16", "effective_from": effective_from,
            "effective_to": None, "observed_to": "2026-10-16",
            "validity_basis": validity, "code_role": "current",
            "source_file": str(stock_path), "source_line": stock_rows[code][1],
            "evidence_labels": labels})

    pack["listings"].append({
        "id": "listing_601398_hkex_1398", "instrument_id": "instrument_601398_h",
        "market_id": "market_hkex", "code": "1398", "board": "主板", "currency": "HKD",
        "status": "上市", "observed_at": "2026-10-16", "effective_from": "2006-10-27",
        "effective_to": None, "observed_to": "2026-10-16",
        "validity_basis": "proven_start_open_end", "code_role": "current",
        "source_file": str(SAMPLES / "excerpts/601398_2025_annual_summary.txt"), "source_line": 33,
        "evidence_labels": ["icbc_report"]})

    # BSE old codes are proven only by the same cninfo orgId; the switch rule
    # response bytes are not in evidence_completion, so validity stays unknown.
    for old, new in (("835185", "920185"), ("836077", "920077")):
        pack["listings"].append({
            "id": "listing_%s_bse_%s" % (new, old), "instrument_id": "instrument_%s_a" % new,
            "market_id": "market_bse", "code": old, "board": "北交所", "currency": "CNY",
            "status": "历史代码候选", "observed_at": "2026-10-16", "effective_from": None,
            "effective_to": None, "observed_to": "2026-10-16",
            "validity_basis": "legacy_alias_pending_2025_10_09_rule_evidence",
            "code_role": "legacy_alias",
            "source_file": str(COMPLETION / "bse_code_switch_evidence.json"),
            "source_line": None,
            "evidence_labels": ["cninfo_list", "bse_rule_excerpt", "bse_%s_listing" % new]})

    # Formal ST rename events: announcement effective dates are the legal
    # boundaries; daily quote names only supply observed first/last evidence.
    from datetime import timedelta
    risk_events = {}
    for event in st_events:
        if event.get("event") in {"risk_warning_implement", "risk_warning_cancel"}:
            risk_events.setdefault(event["code"], []).append(event)
    observed_segments = candidates["historical_names"]
    for code, events in sorted(risk_events.items()):
        events = sorted(events, key=lambda item: item["effective_date"])
        observed = observed_segments[code]
        if len(observed) != len(events) + 1:
            raise SystemExit("ST_SEGMENT_COUNT_MISMATCH:" + code)
        for index, segment in enumerate(observed):
            if index == 0:
                event = events[0]
                name = event["before_name"]
                valid_from = "2021-01-04"
                valid_to = (datetime.strptime(event["effective_date"], "%Y-%m-%d").date()
                            - timedelta(days=1)).isoformat()
                basis = "observed_start_formal_end"
                label = "st_%s_%s" % (code, "implement")
            else:
                event = events[index - 1]
                name = event["after_name"]
                valid_from = event["effective_date"]
                if index < len(events):
                    next_event = events[index]
                    valid_to = (datetime.strptime(next_event["effective_date"], "%Y-%m-%d").date()
                                - timedelta(days=1)).isoformat()
                    basis = "announcement_effective_date"
                else:
                    valid_to = None
                    basis = "announcement_effective_date_open_end"
                label = "st_%s_%s" % (code, "cancel" if event["event"] == "risk_warning_cancel" else "implement")
            claims_observed_to = segment.get("end") or "2025-12-31"
            start_label = "daily_" + segment["start"].replace("-", "")
            end_label = "daily_" + claims_observed_to.replace("-", "")
            labels = sorted({label, start_label, end_label})
            pack["name_claims"].append({
                "id": "claim_%s_%d" % (code, index), "entity_id": "entity_" + code,
                "name": name, "valid_from": valid_from, "valid_to": valid_to,
                "observed_from": segment["start"], "observed_to": claims_observed_to,
                "validity_basis": basis, "status": "announcement_text_confirmed",
                "observed_at": segment["start"], "source_file": event.get("pdf", ""),
                "source_line": None, "evidence_labels": labels})
    pack["name_claims"].append({
        "id": "claim_000001_sdb", "entity_id": "entity_000001",
        "name": "深圳发展银行股份有限公司", "valid_from": None, "valid_to": None,
        "observed_from": "2026-10-16", "observed_to": "2026-10-16",
        "validity_basis": "claim_effective_date_unknown", "status": "claim_no_effective_date_no_old_code",
        "observed_at": "2026-10-16", "source_file": candidates["pingan_history_claim"]["source_file"],
        "source_line": candidates["pingan_history_claim"]["source_line"],
        "evidence_labels": ["company_intro", "company_20261016"]})

    # Issuer, listing and industry relations.  Unknown effective dates stay
    # unknown; observed membership sets are partial, so absence never implies exit.
    for instrument in pack["instruments"]:
        pack["relations"].append({
            "id": "rel_issued_by_" + instrument["id"], "subject": {"kind": "instrument", "id": instrument["id"]},
            "object": {"kind": "entity", "id": instrument["issuer_id"]}, "relation_type": "issued_by",
            "set_id": "issuer_links_observed_20261016", "set_completeness": "partial",
            "set_absence_means": "unknown", "definition_authority": "cninfo_orgid_and_annual_report",
            "observed_from": "2026-10-16", "observed_to": "2026-10-16",
            "relation_scope": "issuer_identity_observed_only",
            "scope_note": "2026-10-16 观察到的工具-发行人关系；不据此声明历史有效期",
            "evidence_labels": instrument["evidence_labels"]})
    for listing in pack["listings"]:
        for rtype, obj_kind, obj_id in (
                ("listing_of", "instrument", listing["instrument_id"]),
                ("listed_on", "market", listing["market_id"])):
            pack["relations"].append({
                "id": "rel_%s_%s" % (rtype, listing["id"]),
                "subject": {"kind": "listing", "id": listing["id"]},
                "object": {"kind": obj_kind, "id": obj_id}, "relation_type": rtype,
                "set_id": rtype + "_links_observed_20261016", "set_completeness": "partial",
                "set_absence_means": "unknown", "definition_authority": "observed_listing_identity",
                "effective_from": listing.get("effective_from"), "effective_to": listing.get("effective_to"),
                "observed_from": "2026-10-16", "observed_to": "2026-10-16",
                "relation_scope": "listing_identity_observed_only",
                "scope_note": "挂牌关系有效期仅在来源已证范围内使用",
                "evidence_labels": listing["evidence_labels"]})
    import hashlib
    for code in codes:
        row, _ = stock_rows[code]
        industry = row.get("所属行业") or "unknown"
        industry_id = "industry_" + hashlib.sha256(industry.encode("utf-8")).hexdigest()[:12]
        pack["relations"].append({
            "id": "rel_industry_" + code, "subject": {"kind": "entity", "id": "entity_" + code},
            "object": {"kind": "definition", "id": industry_id}, "relation_type": "classified_as",
            "set_id": "industry_members_observed_20261016", "set_completeness": "partial",
            "set_absence_means": "unknown", "definition_authority": "stock_list_20261016",
            "public_from": "2026-10-16", "observed_from": "2026-10-16", "observed_to": "2026-10-16",
            "relation_scope": "industry_membership_observed_partial",
            "scope_note": "12 家观察样本，partial；成员缺席不推断退出",
            "evidence_labels": ["stock_20261016"]})
    pack["relations"].append({
        "id": "rel_port_operated_by_600018",
        "subject": {"kind": "physical_object", "id": "physical_shanghai_port"},
        "object": {"kind": "entity", "id": "entity_600018"}, "relation_type": "operated_by",
        "set_id": "physical_operator_observed_2025", "set_completeness": "partial",
        "set_absence_means": "unknown", "definition_authority": "2025_annual_report_summary",
        "observed_from": "2026-10-16", "observed_to": "2026-10-16",
        "relation_scope": "public_terminal_operator_statement_not_all_port_rights",
        "scope_note": "年报原句只称上港集团为上海港公共码头运营商；不延伸全上海港经营权或全港统计",
        "evidence_labels": ["port_pdf_text"]})

    f.validate_pack(pack)
    return pack, {"prepared_calendar": prepared_calendar, "raw_calendar": raw_calendar,
                  "stock_path": str(stock_path), "bse_old_codes": {"835185": "920185", "836077": "920077"}}


def run_bse_probe():
    """Targeted BSE switch probe using the official indexed page extract.

    No full real-base rerun: this store contains only two BSE issuers, their
    A-share instruments, old/new code listings and the BSE trading-day probe.
    """
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    probe = P2 / ("bse_probe_" + stamp)
    probe.mkdir(parents=True, exist_ok=False)
    official = (PROJECT / "03_测试与验证记录/首发数据准备_2026-10-27/"
                "主审核_语义与官方代码证据/北交所官方检索摘录.json")
    semantic = (PROJECT / "03_测试与验证记录/首发数据准备_2026-10-27/"
                "主审核_语义与官方代码证据/语义表现场核对.json")
    candidates = json.loads((CAND / "p2_identity_candidates.json").read_text("utf-8"))
    codes = ["920185", "920077"]
    stock_path, stock_rows = read_stock_rows(codes)
    cninfo = json.loads((SAMPLES / "cninfo_stocklist_candidates.json").read_text("utf-8"))["candidates"]
    official_data = json.loads(official.read_text("utf-8"))
    evidence, meta = {}, {}
    writer = make_service(probe / "store", probe / "runtime_writer", ROLES, "p2-bse-probe")
    for label, path in {
            "bse_official_index": official, "bse_semantic_check": semantic,
            "stock_20261016": stock_path,
            "bse_920185_listing": CAND / "evidence/920185_bse_listing.txt",
            "bse_920077_listing": CAND / "evidence/920077_bse_listing.txt",
            "cninfo_list": SAMPLES / "cninfo_stocklist_candidates.json"}.items():
        custody(writer, path, label, evidence, meta)
    pack = {
        "dataset_id": "wfd_p2_bse_switch_" + stamp,
        "observed_at": "2026-10-26",
        "regions": [{"id": "region_cn", "code": "CN", "name": "中国",
                     "evidence_labels": ["bse_official_index"]}],
        "markets": [{"id": "market_bse", "code": "BSE", "name": "北京证券交易所",
                     "region_id": "region_cn",
                     "evidence_labels": ["bse_official_index", "stock_20261016"]}],
        "entities": [], "instruments": [], "listings": [], "name_claims": [],
        "physical_objects": [], "relations": [],
        "calendar": {"market_id": "market_bse", "market_code": "BSE",
                     "dates": ["2025-10-09"], "range": ["2025-10-09", "2025-10-09"],
                     "evidence_labels": ["bse_official_index"]},
        "units": [], "metric_bindings": [],
    }
    for code in codes:
        row, line = stock_rows[code]
        name = row.get("股票名称") or candidates["companies"][code]["current"]["name"]
        org = cninfo[code]["orgId"]
        entity_id, instrument_id = "entity_" + code, "instrument_%s_a" % code
        pack["entities"].append({
            "id": entity_id, "display_name": name, "legal_name": row.get("股票全称") or name,
            "org_id": org, "region_id": "region_cn", "observed_at": "2026-10-16",
            "name_basis": "observed_only", "source_as_of": "2026-10-16",
            "source_file": str(stock_path), "source_line": line,
            "evidence_labels": ["stock_20261016", "bse_%s_listing" % code]})
        pack["instruments"].append({
            "id": instrument_id, "issuer_id": entity_id, "instrument_type": "equity",
            "share_class": "A", "display_name": name, "org_id": org,
            "observed_at": "2026-10-16", "name_basis": "observed_only",
            "source_file": str(stock_path), "source_line": line,
            "evidence_labels": ["stock_20261016", "bse_%s_listing" % code]})
        mapping = next(item for item in official_data["claims"][1]["records"]
                       if item["new_code"] == code)
        old = mapping["old_code"]
        rows = official_data["claims"][1]["records"]
        row_number = mapping["table_row"]
        for listing_code, role, start, end, basis in [
                (old, "legacy_alias", None, "2025-10-09",
                 "official_indexed_notice_end_boundary_not_raw_html"),
                (code, "current", "2025-10-09", None,
                 "official_indexed_notice_effective_date_not_raw_html")]:
            listing_id = "listing_%s_bse_%s" % (code, listing_code)
            pack["listings"].append({
                "id": listing_id, "instrument_id": instrument_id, "market_id": "market_bse",
                "code": listing_code, "board": "北交所", "currency": "CNY",
                "status": "代码切换已公告", "observed_at": "2026-10-26",
                "effective_from": start, "effective_to": end, "observed_to": "2026-10-26",
                "validity_basis": basis, "code_role": role,
                "evidence_kind": "indexed_official_page_extract",
                "source_note": ("北证公告〔2025〕46号：2025-10-09 起启用新代码；"
                                "官方对照表 row %s；仅官方索引派生文本，未取得原始 HTML 字节" % row_number),
                "source_file": str(official), "source_line": row_number,
                "evidence_labels": ["bse_official_index", "cninfo_list",
                                    "bse_%s_listing" % code]})
            pack["relations"].extend([
                {"id": "rel_lof_" + listing_id, "subject": {"kind": "listing", "id": listing_id},
                 "object": {"kind": "instrument", "id": instrument_id},
                 "relation_type": "listing_of", "set_id": "bse_listing_of_set",
                 "set_completeness": "partial", "set_absence_means": "unknown",
                 "definition_authority": "bse_official_indexed_extract",
                 "effective_from": start, "effective_to": end, "observed_to": "2026-10-26",
                 "relation_scope": "bse_code_switch_2025_only",
                 "scope_note": "只声明 2025-10-09 切换附近；更早历史未证",
                 "evidence_labels": ["bse_official_index"]},
                {"id": "rel_lon_" + listing_id, "subject": {"kind": "listing", "id": listing_id},
                 "object": {"kind": "market", "id": "market_bse"},
                 "relation_type": "listed_on", "set_id": "bse_listed_on_set",
                 "set_completeness": "partial", "set_absence_means": "unknown",
                 "definition_authority": "bse_official_indexed_extract",
                 "effective_from": start, "effective_to": end, "observed_to": "2026-10-26",
                 "relation_scope": "bse_code_switch_2025_only",
                 "scope_note": "只声明 2025-10-09 切换附近；更早历史未证",
                 "evidence_labels": ["bse_official_index"]},
            ])
        pack["relations"].append({
            "id": "rel_issued_by_" + instrument_id,
            "subject": {"kind": "instrument", "id": instrument_id},
            "object": {"kind": "entity", "id": entity_id},
            "relation_type": "issued_by", "set_id": "bse_issuer_set",
            "set_completeness": "partial", "set_absence_means": "unknown",
            "definition_authority": "stock_list_20261016",
            "observed_from": "2026-10-16", "observed_to": "2026-10-16",
            "evidence_labels": ["stock_20261016"]})
    f.validate_pack(pack)
    outputs = (f.build_identity_outputs(pack, evidence)
               + f.build_relation_outputs(pack, evidence)
               + f.build_calendar_output(pack, evidence))
    result = writer.submit(f.make_request(pack["dataset_id"], "bse-switch-probe", outputs))
    if result.get("status") != "published_formal":
        save(probe / "summary.json", {"status": "failed", "result": result})
        raise SystemExit("BSE_PROBE_SUBMIT_FAILED:" + str(result.get("status")))
    reader = make_service(probe / "store", probe / "runtime_reader", READ_ROLES, "p2-bse-reader")
    catalog = f.FoundationCatalog.from_snapshot(reader, result["snapshot_id"])
    new_at_switch = catalog.resolve_code("920185", market="BSE", at="2025-10-10")
    old_at_switch = catalog.resolve_code("835185", market="BSE", at="2025-10-08")
    old_after = catalog.resolve_code("835185", market="BSE", at="2025-10-10")
    new_before = catalog.resolve_code("920185", market="BSE", at="2025-10-08")
    listing_product = catalog.listings[0].product_id
    trace = reader.trace(listing_product, snapshot_id=result["snapshot_id"])
    old_record = next(r for r in catalog.listings if r.value("code") == "835185")
    checks = {
        "new_code_after_switch_resolved": new_at_switch["status"] == "resolved"
            and new_at_switch["selected"]["code"] == "920185",
        "old_code_before_switch_unknown": old_at_switch["status"] == "indeterminate",
        "old_code_after_switch_excluded": old_after["status"] == "not_found",
        "new_code_before_switch_excluded": new_before["status"] == "not_found",
        "old_code_start_not_invented": old_record.value("effective_from") is None,
        "source_note_is_indexed_extract": (
            old_record.value("evidence_kind") == "indexed_official_page_extract"
            and "未取得原始 HTML" in (old_record.value("source_note") or "")
            and old_record.value("validity_basis").endswith("not_raw_html")),
        "evidence_verified": all(item["verified"] for item in trace["evidence"]),
        "counts": catalog.counts()["entities"] == 2 and catalog.counts()["listings"] == 4,
    }
    summary = {
        "status": "bse_switch_probe_verified_with_scoped_evidence" if all(checks.values())
                  else "bse_switch_probe_incomplete",
        "run_dir": str(probe.relative_to(PROJECT)),
        "snapshot_id": result["snapshot_id"],
        "counts": catalog.counts(),
        "checks": checks,
        "checks_passed": sum(1 for value in checks.values() if value),
        "checks_total": len(checks),
        "new_at_2025_10_10": new_at_switch,
        "old_at_2025_10_08": old_at_switch,
        "old_at_2025_10_10": old_after,
        "new_at_2025_10_08": new_before,
        "evidence": meta,
        "evidence_kind": "indexed_official_page_extract",
        "raw_origin_html_custodied": False,
        "source_note": ("北证公告〔2025〕46号 + 官网新旧代码对照表由主审核官方域检索实际读到；"
                        "仅作为派生文本证据承接，不冒充原始 HTML；更早未证历史保持 unknown。"),
        "scope_note": "只验证 BSE 2025-10-09 切换附近的代码有效关系与读回，不重跑完整真实基础集。",
    }
    save(probe / "summary.json", summary)
    print(json.dumps({key: summary[key] for key in ("status", "run_dir", "snapshot_id",
                                                    "checks", "raw_origin_html_custodied")},
                     ensure_ascii=False, indent=2))
    if not all(checks.values()):
        raise SystemExit("BSE_PROBE_CHECKS_FAILED:" + ",".join(k for k, v in checks.items() if not v))


def main():
    RUN.mkdir(parents=True, exist_ok=False)
    store = RUN / "store"
    writer = make_service(store, RUN / "runtime_writer", ROLES, "p2-writer")
    evidence, evidence_meta = {}, {}

    files = {
        "stock_20261016": Path(json.loads((CAND / "p2_identity_candidates.json").read_text("utf-8"))
                               ["companies"]["000001"]["current"]["source_file"]),
        "company_20261016": Path(json.loads((CAND / "p2_identity_candidates.json").read_text("utf-8"))
                                 ["pingan_history_claim"]["source_file"]),
        "company_intro": CAND / "evidence/000001_company_intro.txt",
        "old_fixture": ENGINE / "fixtures/financial_slice/inputs.json",
        "icbc_report": SAMPLES / "excerpts/601398_2025_annual_summary.txt",
        "bse_920185_listing": CAND / "evidence/920185_bse_listing.txt",
        "bse_920077_listing": CAND / "evidence/920077_bse_listing.txt",
        "cninfo_list": SAMPLES / "cninfo_stocklist_candidates.json",
        "calendar_raw": SAMPLES / "szse_calendar_2021_2025.json",
        "macro": SAMPLES / "macro_gdp_1978_2024.json",
        "port_report": SAMPLES / "excerpts/600018_2025_annual_summary.txt",
        "port_pdf_text": SAMPLES / "pdf/600018_2025_annual_summary.txt",
        "unit_headers": SAMPLES / "minute_20250102_sample.csv",
        "daily_20250102": Path("/Users/mashiro/数据清洗 特征提取 标注 前期汇总原包/静态数据库/原包/每日日线/按交易日/2025/20250102@余哈哈的数据仓库 原创整理.csv"),
        "unit_candidates": CAND / "p2_unit_candidates.json",
        "semantic_evidence": CAND / "semantic_evidence.json",
        "daily_20210104": daily_file("20210104"),
        "daily_20230428": daily_file("20230428"),
        "daily_20240607": daily_file("20240607"),
        "daily_20240429": daily_file("20240429"),
        "daily_20250516": daily_file("20250516"),
        "daily_20251231": daily_file("20251231"),
        "daily_20230505": daily_file("20230505"),
        "daily_20240612": daily_file("20240612"),
        "daily_20240506": daily_file("20240506"),
        "daily_20250520": daily_file("20250520"),
        "bse_rule_excerpt": COMPLETION / "bse_code_switch_evidence.json",
        "st_002157_implement": SAMPLES / "pdf/002157_2023_st_suspension.pdf",
        "st_002157_cancel": SAMPLES / "pdf/002157_2024_cancel_st_suspension.pdf",
        "st_603363_implement": SAMPLES / "pdf/603363_2024_st_suspension.pdf",
        "st_603363_cancel": SAMPLES / "pdf/603363_2025_cancel_st_suspension.pdf",
    }
    for label, path in files.items():
        if not path.is_file():
            raise SystemExit("EVIDENCE_FILE_MISSING:%s:%s" % (label, path))
        custody(writer, path, label, evidence, evidence_meta)
    if "成交量（手）" not in (files["daily_20250102"].read_text("utf-8-sig").splitlines()[0]):
        raise SystemExit("DAILY_HEADER_EVIDENCE_MISMATCH")

    pack, source_meta = build_pack(evidence)
    save(RUN / "pack_summary.json", {
        "dataset_id": pack["dataset_id"], "counts": {
            "entities": len(pack["entities"]), "instruments": len(pack["instruments"]),
            "listings": len(pack["listings"]), "markets": len(pack["markets"]),
            "regions": len(pack["regions"]), "physical_objects": len(pack["physical_objects"]),
            "name_claims": len(pack["name_claims"]), "relations": len(pack["relations"]),
            "calendar_days": len(pack["calendar"]["dates"]), "units": len(pack["units"]),
            "metric_bindings": len(pack["metric_bindings"])},
        "evidence": evidence_meta, "calendar_source": {
            "months": len(source_meta["raw_calendar"]["months"]),
            "trading_days": len(source_meta["prepared_calendar"]["dates"]),
            "all_http_200": all(m["http_status"] == 200 for m in source_meta["raw_calendar"]["months"]),
            "by_year": source_meta["prepared_calendar"]["by_year"]},
        "bse_old_codes": source_meta["bse_old_codes"]})

    # 1) units, 2) identities/relations/calendar, 3) unit-dependent bindings.
    units = f.build_unit_outputs(pack, evidence)
    first = writer.submit(f.make_request(pack["dataset_id"], "p2_units", units))
    if first.get("status") != "published_formal":
        save(RUN / "summary.json", {"status": "failed", "phase": "units", "result": first})
        raise SystemExit("P2_UNIT_SUBMIT_FAILED:" + str(first.get("status")))
    unit_result = first["output_results"][0]

    outputs = (f.build_identity_outputs(pack, evidence)
               + f.build_relation_outputs(pack, evidence)
               + f.build_calendar_output(pack, evidence))
    request = f.make_request(pack["dataset_id"], "p2_identities", outputs)
    request["expected_parent_snapshot_id"] = first["snapshot_id"]
    second = writer.submit(request)
    if second.get("status") != "published_formal":
        save(RUN / "summary.json", {"status": "failed", "phase": "identities", "result": second})
        raise SystemExit("P2_IDENTITY_SUBMIT_FAILED:" + str(second.get("status")))

    bindings, dependencies = f.build_binding_outputs(
        pack, evidence, unit_result["product_id"], first["snapshot_id"])
    request = f.make_request(pack["dataset_id"], "p2_bindings", bindings, dependencies)
    request["expected_parent_snapshot_id"] = second["snapshot_id"]
    third = writer.submit(request)
    if third.get("status") != "published_formal":
        save(RUN / "summary.json", {"status": "failed", "phase": "bindings", "result": third})
        raise SystemExit("P2_BINDING_SUBMIT_FAILED:" + str(third.get("status")))
    final_snapshot = third["snapshot_id"]

    # New service instance: only read roles, same store, fixed snapshot.
    reader = make_service(store, RUN / "runtime_reader", READ_ROLES, "p2-reader")
    catalog = f.FoundationCatalog.from_snapshot(reader, final_snapshot)
    counts = catalog.counts()
    expected = {"entities": 12, "instruments": 13, "listings": 15, "markets": 4,
                "regions": 1, "physical_objects": 1, "name_claims": 7,
                "calendar_days": 1212, "units": 7, "metric_bindings": 9}

    icbc_a = catalog.resolve_code("601398", market="SSE", at="2010-01-01")
    icbc_h = catalog.resolve_code("1398", market="HKEX", at="2010-01-01")
    bse_new = catalog.resolve_code("920185", market="BSE", at="2025-10-10")
    current_name = catalog.resolve_name("平安银行", at="2023-06-01")
    observed_name = catalog.resolve_name("平安银行", at="2026-10-16")
    st_name = catalog.resolve_name("*ST正邦", at="2023-06-01")
    relations = catalog.relations_for("instrument_601398_a", at="2010-01-01")
    view = catalog.entity_view("entity_601398", at="2010-01-01", allow_unknown_association=True)
    calendar_view = catalog.company_calendar("entity_000001", start="2025-01-02",
                                             end="2025-12-31", at="2025-01-02", mode="strict")
    calendar_candidates = catalog.company_calendar("entity_000001", start="2025-01-02",
                                                   end="2025-12-31", at="2025-01-02", mode="candidates")
    unit_amount = catalog.unit_binding("daily.amount")
    unit_minute = catalog.unit_binding("minute.volume")
    unit_macro = catalog.unit_binding("macro.gdp")
    unit_teu = catalog.unit_binding("physical.teu")
    members = catalog.members_of("industry_members_observed_20261016", at="2026-10-16")
    members_2010 = catalog.members_of("industry_members_observed_20261016", at="2010-01-01")
    st_open_end_2035 = catalog.resolve_name("正邦科技", at="2035-01-01")
    st_ended_2035 = catalog.resolve_name("*ST正邦", at="2035-01-01")
    amount_base = Decimal(unit_amount["sample_value"]) * Decimal(unit_amount["unit"]["scale_factor"])
    macro_base = Decimal(unit_macro["sample_value"]) * Decimal(unit_macro["unit"]["scale_factor"])
    teu_base = Decimal(unit_teu["sample_value"]) * Decimal(unit_teu["unit"]["scale_factor"])
    physical = catalog.physical_objects[0]
    physical_relation = next(r for r in catalog.relations
                             if r.row.get("relation_type") == "operated_by")

    entity_product = next(r.product_id for r in catalog.entities if r.subject["id"] == "entity_000001")
    trace = reader.trace(entity_product, snapshot_id=final_snapshot)
    evidence_verified = bool(trace["evidence"]) and all(item["verified"] for item in trace["evidence"])
    request_state = reader.request_status(request["request_identity"])

    icbc_text = (SAMPLES / "excerpts/601398_2025_annual_summary.txt").read_text("utf-8")
    sample = daily_row("20250102", "000001")
    sample_amount_wan = sample["成交额（万元）"]
    boundary = subprocess.run(
        [sys.executable, "-m", "pytest", str(ENGINE / "tests/test_product_foundations.py"), "-q"],
        cwd=str(ENGINE), text=True, capture_output=True, timeout=180)

    checks = {
        "counts_match": counts == {**expected, "relations": counts["relations"]},
        "new_instance_fixed_readback": counts["entities"] == 12 and len(reader.read(
            catalog.entities[0].product_id, snapshot_id=final_snapshot)["rows"]) == 1,
        "company_instrument_listing_separated": (
            {r.subject["kind"] for r in catalog.entities} == {"entity"}
            and {r.subject["kind"] for r in catalog.instruments} == {"instrument"}
            and {r.subject["kind"] for r in catalog.listings} == {"listing"}),
        "icbc_a_and_h_same_entity_two_instruments": (
            icbc_a["status"] == "resolved" and icbc_h["status"] == "resolved"
            and icbc_a["selected"]["instrument_id"] == "instrument_601398_a"
            and icbc_h["selected"]["instrument_id"] == "instrument_601398_h"
            and view["entity_id"] == "entity_601398"),
        "icbc_same_day_listing_quote_location": (
            "2006 年 10 月 27 日" in icbc_text and "同日挂" in icbc_text
            and "601398" in icbc_text and "1398" in icbc_text),
        "bse_real_switch_remains_indeterminate": (
            bse_new["status"] == "indeterminate"
            and catalog.resolve_code("835185", market="BSE", at="2025-10-10")["status"] == "indeterminate"
            and bse_new["candidates"][0]["instrument_id"]
            == catalog.resolve_code("835185", market="BSE", at="2025-10-10")["candidates"][0]["instrument_id"]),
        "observed_name_not_backfilled": (
            current_name["status"] == "indeterminate"
            and observed_name["status"] in {"resolved", "ambiguous"}
            and observed_name["candidates"]
            and all(c["validity"]["state"] == "valid" for c in observed_name["candidates"])),
        "observed_st_name_2035_not_extrapolated": (
            st_name["status"] == "resolved"
            and st_ended_2035["status"] == "not_found"
            and st_open_end_2035["status"] == "indeterminate"
            and any(c["validity"].get("reason") == "AFTER_OBSERVED_EVIDENCE_END"
                    for c in st_open_end_2035["candidates"])),
        "unknown_relation_effective_not_known": (
            relations["relations"] == []
            and any(x["reason"] == "EFFECTIVE_PERIOD_UNKNOWN" for x in relations["indeterminate"])),
        "partial_membership_no_exit": (
            members["set_completeness"] == "partial" and members["exits_inferable"] is False
            and len(members["members"]) == 12),
        "membership_before_observed_window_no_negative_inference": (
            members_2010["members"] == []
            and members_2010["exits_inferable"] is False),
        "unit_dependency_verified": (
            unit_amount["dependency_verified"] is True
            and unit_amount["unit"]["unit_code"] == "cny_10000"
            and unit_minute["unit_code"] is None and unit_minute["unit_status"] == "unknown"),
        "unit_scales_recompute_real_values": (
            Decimal(sample_amount_wan) * Decimal(unit_amount["unit"]["scale_factor"]) == amount_base
            and amount_base == Decimal(sample_amount_wan) * 10000
            and unit_macro["unit"]["unit_code"] == "cny_100million"
            and macro_base == Decimal("1349083.5") * 100000000
            and unit_teu["unit"]["unit_code"] == "ten_thousand_teu"
            and unit_teu["sample_unit"] == "万标准箱"
            and teu_base == Decimal("5506.3") * 10000
            and teu_base == 55063000),
        "physical_scope_narrowed": (
            physical.value("object_scope") == "company_home_port_container_throughput"
            and physical.value("operator_scope") == "public_terminal_operator_statement"
            and physical_relation.value("relation_scope") ==
                "public_terminal_operator_statement_not_all_port_rights"
            and physical.value("region_status") == "unknown"),
        "calendar_source_response_verified": (
            len(source_meta["prepared_calendar"]["dates"]) == 1212
            and len(source_meta["raw_calendar"]["months"]) == 60
            and all(m["http_status"] == 200 for m in source_meta["raw_calendar"]["months"])),
        "company_calendar_strict_vs_candidate": (
            calendar_view["status"] == "indeterminate" and calendar_view["calendars"] == []
            and calendar_candidates["status"] == "ok"
            and calendar_candidates["candidate_only"] is True
            and calendar_candidates["calendars"][0]["calendar_status"] == "candidate_indeterminate"
            and calendar_candidates["calendars"][0]["count"] == 243),
        "custodied_evidence_verified": evidence_verified,
        "request_state_readback": request_state.get("state") == "published_formal",
        "boundary_fixture_suite": boundary.returncode == 0,
    }

    gaps = [
        {"id": "P2-G1", "topic": "BSE 2025-10-09 code-switch rule response bytes",
         "status": "candidate_evidence_only",
         "detail": "evidence_completion now contains the rule excerpt/quote and same-orgId mapping; official response bytes/table were not obtained. A 2026-10-27 curl attempt returned HTTP 403 (saved in evidence_recheck/), so effective dates remain candidate/unknown."},
        {"id": "P2-G2", "topic": "000001 historical name effective date and old code",
         "status": "missing", "detail": "The company introduction states a rename from 深圳发展银行, but no effective date or old code. Not backfilled."},
        {"id": "P2-G3", "topic": "002157/603363 formal ST renames",
         "status": "integrated_selected_examples",
         "detail": "Four risk-warning implement/cancel announcements supply legal effective dates and are bound as name claims. The 2023-12-07 temporary-suspension item is not a rename and was not used. 000001/other full history remains limited."},
        {"id": "P2-G4", "topic": "BSE 2025-12-31 official member list",
         "status": "missing", "detail": "Only a 288-company count corroboration exists; official member list is not obtained, so completeness is not claimed."},
        {"id": "P2-G5", "topic": "Other four A/H issuer pairs",
         "status": "not_required_for_first_issue", "detail": "Not expanded; only the proven ICBC 601398/1398 pair is retained."},
        {"id": "P2-G6", "topic": "Minute volume/amount units and session rules",
         "status": "unknown", "detail": "Headers carry no unit; 股/元 are reconciliation guesses and remain unknown. 241/271 labels are observed grids, not trading rules."},
        {"id": "P2-G7", "topic": "Physical object region relation",
         "status": "unknown", "detail": "Port object is narrowed to company-home-port throughput and public-terminal-operator statement; region/administrative relation is not proven and was not fabricated."},
        {"id": "P2-G8", "topic": "Historical validity for 12 current A-share listings",
         "status": "observed_only", "detail": "Current code/name is a 2026-10-16 observation; no historical code/name span is asserted for them."},
        {"id": "P2-G9", "topic": "P1b persistent unit contract adaptation",
         "status": "adapted_recheck",
         "detail": "P1b now persists/projects unit_definitions and merges same-name unit changes inside the generic contract. P2 binds via a unit catalogue product + read dependency and public source_binding fallback; recheck after P1b finishes its read-permission/same-name unit fixes."},
        {"id": "P2-G10", "topic": "BSE pre-2021 venue",
         "status": "candidate",
         "detail": "2021-11-15 before, the two companies were NEEQ selected-layer, not BSE; local 2021-2025 data backfill 920 codes and do not prove historical venue by themselves."},
    ]

    summary = {
        "status": "bounded_p2_foundation_verified_with_gaps" if all(checks.values()) else "bounded_p2_foundation_incomplete",
        "p2_package_pass": False,
        "production_publishable": False,
        "service_version": SERVICE_VERSION,
        "foundation_version": f.FOUNDATION_VERSION,
        "run_dir": str(RUN.relative_to(PROJECT)),
        "store": str(store.relative_to(PROJECT)),
        "snapshots": {"units": first["snapshot_id"], "identities": second["snapshot_id"],
                      "bindings": final_snapshot},
        "counts": counts,
        "expected_counts": expected,
        "checks": checks,
        "checks_passed": sum(1 for value in checks.values() if value),
        "checks_total": len(checks),
        "boundary_fixture": {"returncode": boundary.returncode,
                             "tail": (boundary.stdout or boundary.stderr).strip().splitlines()[-6:]},
        "icbc_a": icbc_a, "icbc_h": icbc_h, "bse_new": bse_new,
        "current_name_2023": current_name, "observed_name_2026": observed_name,
        "st_name_2023": st_name, "relations_2010": relations,
        "entity_view_2010": view, "company_calendar_2025": calendar_view,
        "unit_daily_amount": unit_amount, "unit_minute_volume": unit_minute,
        "unit_macro_gdp": unit_macro, "unit_physical_teu": unit_teu,
        "unit_recompute": {"daily_amount_base_cny": str(amount_base),
                           "macro_gdp_base_cny": str(macro_base),
                           "physical_teu_base": str(teu_base)},
        "physical_object": {"object_scope": physical.value("object_scope"),
                            "operator_scope": physical.value("operator_scope"),
                            "scope_note": physical.value("scope_note"),
                            "relation_scope": physical_relation.value("relation_scope")},
        "membership": members, "membership_2010": members_2010,
        "st_open_end_2035": st_open_end_2035,
        "company_calendar_candidates": calendar_candidates,
        "request_state": {"state": request_state.get("state"),
                          "phases": request_state.get("phases")},
        "custodied_evidence_verified": evidence_verified,
        "evidence_meta": evidence_meta,
        "capabilities": f.capabilities(),
        "gaps": gaps,
        "scope": {
            "local_macos_only": True,
            "windows_and_pulled_disk": "P7 separate acceptance; not performed",
            "relationship_traversal": "P4; this run only does P2 identity joins",
            "external_redistribution": "unknown/not granted; local user authorization only",
            "files_left_unchanged": "original evidence and older releases were read-only; no large downloads",
        },
    }
    save(RUN / "summary.json", summary)
    (P2 / "LATEST").write_text(RUN.name + "\n", "utf-8")
    print(json.dumps({key: summary[key] for key in (
        "status", "checks_passed", "checks_total", "counts", "snapshots", "gaps")},
        ensure_ascii=False, indent=2))
    if not all(checks.values()):
        failed = [name for name, value in checks.items() if not value]
        raise SystemExit("P2_CHECKS_FAILED:" + ",".join(failed))


if __name__ == "__main__":
    if "--bse-probe" in sys.argv:
        run_bse_probe()
    else:
        main()
