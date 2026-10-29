#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""取得平安银行首批产品材料；只下载与结构化，不创建数据库或安装依赖。"""
from __future__ import annotations

import csv
import hashlib
import json
import re
import shutil
import subprocess
from decimal import Decimal
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
DEST = ENGINE / "fixtures/financial_products"
MATERIALS = Path("/Users/mashiro/数据清洗 特征提取 标注 前期汇总原包")
START, END = "2026-04-01", "2026-06-30"
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.szse.cn/"}


def now():
    return datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def save(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", "utf-8")


def query(base, **params):
    return base + "?" + urllib.parse.urlencode(params)


def fetch(name, url, provider, form=None, extension=".response"):
    """每个命名请求仅执行一次；原响应与失败同样留存，重启不重复调用。"""
    raw_path = DEST / "sources" / (name + extension)
    meta_path = DEST / "sources" / (name + ".metadata.json")
    if meta_path.exists():
        meta = json.loads(meta_path.read_text("utf-8"))
        raw = raw_path.read_bytes() if raw_path.exists() else b""
    else:
        body = urllib.parse.urlencode(form).encode() if form is not None else None
        headers = dict(HEADERS)
        if "cninfo" in url:
            headers["Referer"] = "https://www.cninfo.com.cn/"
        if body:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        meta = {"source_id": name, "provider": provider, "requested_url": url,
                "request_method": "POST" if body else "GET", "request_form": form,
                "requested_at_utc": now(), "license": "unknown", "usage_scope": "user_local_financial_database"}
        raw = b""
        try:
            req = urllib.request.Request(url, data=body, headers=headers)
            with urllib.request.urlopen(req, timeout=25) as response:
                raw = response.read()
                meta.update(http_status=response.status, response_url=response.url,
                            content_type=response.headers.get("Content-Type"))
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            meta.update(http_status=exc.code, error=str(exc))
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            meta.update(http_status=None, error=f"{type(exc).__name__}: {exc}")
        meta.update(acquired_at_utc=now(), response_sha256=sha(raw), response_bytes=len(raw),
                    response_file=str(raw_path.relative_to(DEST)))
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        raw_path.write_bytes(raw)
        save(meta_path, meta)
    try:
        parsed = json.loads(raw)
    except (ValueError, UnicodeError):
        parsed = None
    return meta, parsed


def acquire():
    tasks = []
    for month in ["2026-04", "2026-05", "2026-06"]:
        tasks.append(("szse_calendar_" + month, query("https://www.szse.cn/api/report/exchange/onepersistenthour/monthList", month=month), "深圳证券交易所", None))
    tasks.append(("eastmoney_bars_2026q2", query("https://push2his.eastmoney.com/api/qt/stock/kline/get",
                  fields1="f1,f2,f3,f4,f5,f6", fields2="f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
                  ut="7eea3edcaed734bea9cbfc24409ed989", secid="0.000001", klt="101", fqt="0", beg="20260401", end="20260630"), "东方财富", None))
    tasks.append(("szse_security_000001", query("https://www.szse.cn/api/report/ShowReport/data", SHOWTYPE="JSON", CATALOGID="1110",
                  tab1PAGENO="1", tab1PAGESIZE="20", TABKEY="tab1", txtDMorJC="000001"), "深圳证券交易所", None))
    tasks.append(("cninfo_2026031_metadata", "https://www.cninfo.com.cn/new/hisAnnouncement/query", "巨潮资讯网",
                  {"pageNum": "1", "pageSize": "30", "column": "szse", "tabName": "fulltext", "stock": "000001,gssz0000001",
                   "searchkey": "", "secid": "", "plate": "sz", "category": "", "trade": "", "seDate": "2026-08-14~2026-08-16", "sortName": "", "sortType": "", "isHLtitle": "true"}))
    tasks.append(("cninfo_summary_1225475343", "https://static.cninfo.com.cn/finalpage/2026-08-15/1225475343.PDF",
                  "平安银行股份有限公司；披露平台：巨潮资讯网", None, ".pdf"))
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda task: fetch(*task), tasks))
    for meta, parsed in results:
        count = len(parsed.get("data", [])) if isinstance(parsed, dict) and isinstance(parsed.get("data"), list) else None
        print(json.dumps({"source_id": meta["source_id"], "status": meta.get("http_status"), "bytes": meta["response_bytes"],
                          "json_type": type(parsed).__name__, "data_count": count, "error": meta.get("error")}, ensure_ascii=False), flush=True)
    return results


def local_source(name, path, provider, *, acquisition=None):
    """本地资料保留原始文件字节；原取得日期仅在有既有记录时引用。"""
    target = DEST / "sources" / (name + path.suffix)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, target)
    meta = {"source_id": name, "provider": provider, "original_local_path": str(path),
            "request_method": "LOCAL_READ", "requested_url": None, "http_status": None,
            "acquired_at_utc": acquisition.get("acquired_at_utc") if acquisition else now(),
            "local_copied_at_utc": now(), "response_file": str(target.relative_to(DEST)),
            "response_sha256": sha(target.read_bytes()), "response_bytes": target.stat().st_size,
            "license": "unknown", "usage_scope": "user_local_financial_database"}
    if acquisition:
        meta.update(requested_url=acquisition["requested_url"], original_http_status=acquisition["http_status"], original_acquisition=acquisition)
    save(DEST / "sources" / (name + ".metadata.json"), meta)
    return meta


def day_time(day):
    from datetime import timedelta
    start = datetime.fromisoformat(day + "T00:00:00+08:00").astimezone(timezone.utc)
    return {"status": "known", "precision": "day", "earliest_utc": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "latest_exclusive_utc": (start + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ"), "source_timezone": "Asia/Shanghai"}


def assemble():
    def response(name):
        meta = json.loads((DEST / "sources" / (name + ".metadata.json")).read_text("utf-8"))
        return meta, json.loads((DEST / meta["response_file"]).read_bytes())

    market_meta, market_raw = response("eastmoney_bars_2026q2")
    assert market_raw["data"]["code"] == "000001"
    market_rows = []
    for line in market_raw["data"]["klines"]:
        fields = line.split(",")
        market_rows.append({"trade_date": fields[0], "open": fields[1], "close": fields[2], "high": fields[3], "low": fields[4],
                            "volume_lot": fields[5], "volume_shares": format(Decimal(fields[5]) * 100, "f"),
                            "turnover_amount_cny": fields[6], "amplitude_pct": fields[7], "change_pct": fields[8],
                            "change_cny": fields[9], "turnover_rate_pct": fields[10], "source_id": market_meta["source_id"]})
    calendar_rows, calendar_ids = [], []
    for month in ["2026-04", "2026-05", "2026-06"]:
        meta, raw = response("szse_calendar_" + month)
        calendar_ids.append(meta["source_id"])
        assert {row["jybz"] for row in raw["data"]} <= {"0", "1"}
        calendar_rows.extend({"trade_date": row["jyrq"], "is_trading_day": row["jybz"] == "1", "weekday_sunday_1": row["zrxh"],
                              "raw_trade_status": row["jybz"], "source_id": meta["source_id"]} for row in raw["data"])
    identity_meta, identity_raw = response("szse_security_000001")
    listing_block = next(block for block in identity_raw if block["metadata"]["tabkey"] == "tab1")
    listing = next(row for row in listing_block["data"] if row["agdm"] == "000001")
    ann_meta, ann_raw = response("cninfo_2026031_metadata")
    announcement = next(row for row in ann_raw["announcements"] if row["announcementId"] == "1225475348" and row["secCode"] == "000001")
    slice_dir = ENGINE / "fixtures/financial_slice"
    original_acquisition = json.loads((slice_dir / "official_acquisition.json").read_text("utf-8"))
    board_meta = local_source("cninfo_board_1225475348", slice_dir / "cninfo_1225475348.pdf", "平安银行股份有限公司；披露平台：巨潮资讯网", acquisition=original_acquisition)
    assert board_meta["response_sha256"] == original_acquisition["sha256"]
    local_source("cninfo_board_1225475348_text", slice_dir / "cninfo_1225475348.txt", "已保管公告原PDF的文字提取")
    company_path = MATERIALS / "静态数据库/原包/上市企业名单和概念分类/上市公司基本信息/2026/20261014_上市公司基本信息@余哈哈的数据仓库 原创整理.csv"
    stock_path = MATERIALS / "静态数据库/原包/上市企业名单和概念分类/股票基础信息及概念分类/2026/20261016_股票基础信息及概念分类@余哈哈的数据仓库 原创整理.csv"
    company_meta = local_source("company_roster_20261014", company_path, "余哈哈的数据仓库；用户本地资料")
    stock_meta = local_source("stock_roster_20261016", stock_path, "余哈哈的数据仓库；用户本地资料")
    with company_path.open(encoding="utf-8-sig", newline="") as stream:
        company = next(row for row in csv.DictReader(stream) if row["TS股票代码"] == "000001.SZ")
    with stock_path.open(encoding="utf-8-sig", newline="") as stream:
        stock = next(row for row in csv.DictReader(stream) if row["股票代码"] == "000001")
    assert listing["agssrq"].replace("-", "") == stock["上市日期"]
    board_text = re.sub(r"\s+", "", (slice_dir / "cninfo_1225475348.txt").read_text("utf-8"))
    ordinary = re.search(r"普通股股东的净利润为人民币([\d.]+)亿元", board_text).group(1)
    parent = re.search(r"合并报表中归属于本行股东的净利润为人民币([\d.]+)亿元", board_text).group(1)
    total = re.search(r"合计派发现金股利人民币([\d.]+)亿元", board_text).group(1)
    per_ten = re.search(r"每10股派发现金股利人民币([\d.]+)元", board_text).group(1)
    company_ref = {"kind": "entity", "namespace": "cn.uscc", "id": company["统一社会信用代码"]}
    security_ref = {"kind": "instrument", "namespace": "cn.szse.security_code", "id": "000001"}
    publication = day_time("2026-08-15")
    trade_dates = {row["trade_date"] for row in calendar_rows if row["is_trading_day"]}
    market_dates = {row["trade_date"] for row in market_rows}
    sources = []
    for path in sorted((DEST / "sources").glob("*.metadata.json")):
        source = json.loads(path.read_text("utf-8"))
        source.update(path=str(DEST / source["response_file"]), sha256=source["response_sha256"], url=source.get("requested_url"))
        sources.append(source)
    data = {"format_version": "wfd.financial-products-inputs/0.1", "assembled_at_utc": now(), "source_root": str(DEST), "sources": sources,
            "identity": {"company_ref": company_ref, "security_ref": security_ref,
                         "company": {"legal_name": company["公司全称"], "uscc": company["统一社会信用代码"], "source_ids": [company_meta["source_id"], board_meta["source_id"]]},
                         "security": {"code": "000001", "ts_code": "000001.SZ", "name": re.sub(r"<[^>]*>", "", listing["agjc"]),
                                      "currency": stock["交易货币"], "source_ids": [identity_meta["source_id"], stock_meta["source_id"]]},
                         "listing": {"exchange_id": "SZSE", "exchange_name": "深圳证券交易所", "board": listing["bk"], "listed_at_date": listing["agssrq"],
                                     "delisted_at_date": None, "delisting_status": "unknown", "listing_status": "listed_in_current_exchange_roster",
                                     "provider_asof_date": listing_block["metadata"]["subname"].strip(), "source_ids": [identity_meta["source_id"]]},
                         "issuer_relation": {"subject": security_ref, "object": company_ref, "relation_type": "issued_by", "effective_from": None, "effective_to": None,
                                             "effective_period_status": "unknown", "public_time": publication,
                                             "source_ids": [board_meta["source_id"], ann_meta["source_id"]],
                                             "limitation": "公告明确公司与证券代码对应，但不能用当前名单或上市日倒填整个历史关系有效期。"}},
            "calendar": {"exchange_id": "SZSE", "start_date": START, "end_date": END, "timezone": "Asia/Shanghai", "source_ids": calendar_ids,
                         "weekday_convention": "1=Sunday, 2=Monday, ..., 7=Saturday; raw zrxh preserved", "rows": calendar_rows},
            "market": {"security_ref": security_ref, "start_date": START, "end_date": END, "frequency": "day", "adjustment": "unadjusted",
                       "adjustment_evidence": "实际请求fqt=0；资料包adata接口实现声明0=不复权", "source_ids": [market_meta["source_id"]],
                       "public_time_status": "unknown", "units": {"open": "cny_per_share", "high": "cny_per_share", "low": "cny_per_share", "close": "cny_per_share",
                       "volume_lot": "lot_100_shares", "volume_shares": "share", "turnover_amount_cny": "cny", "amplitude_pct": "percent", "change_pct": "percent", "change_cny": "cny_per_share", "turnover_rate_pct": "percent"},
                       "rows": market_rows},
            "financial": {"company_ref": company_ref, "period_start": "2026-01-01", "period_end_exclusive": "2026-07-01", "reporting_period": "2026H1",
                          "public_time": publication, "content_nature": "source_claim", "audited": False, "report_type": "board_announcement_financial_disclosure",
                          "source_ids": [board_meta["source_id"], ann_meta["source_id"]],
                          "rows": [{"reporting_period": "2026H1", "net_profit_attributable_to_parent_cny_100million": parent,
                                    "net_profit_ordinary_shareholders_cny_100million": ordinary, "revenue_cny_100million": None,
                                    "operating_cashflow_cny_100million": None, "proposed_dividend_total_cny_100million": total,
                                    "proposed_dividend_per_10shares_cny": per_ten}],
                          "field_sources": {"net_profit_attributable_to_parent_cny_100million": [board_meta["source_id"]], "net_profit_ordinary_shareholders_cny_100million": [board_meta["source_id"]],
                                            "proposed_dividend_total_cny_100million": [board_meta["source_id"]], "proposed_dividend_per_10shares_cny": [board_meta["source_id"]]},
                          "units": {"net_profit_attributable_to_parent_cny_100million": "cny_100million", "net_profit_ordinary_shareholders_cny_100million": "cny_100million",
                                    "revenue_cny_100million": "cny_100million", "operating_cashflow_cny_100million": "cny_100million", "proposed_dividend_total_cny_100million": "cny_100million", "proposed_dividend_per_10shares_cny": "cny_per_10_shares"}},
            "announcement": {"company_ref": company_ref, "announcement_id": "1225475348", "announcement_no": "2026-031", "title": announcement["announcementTitle"],
                             "board_meeting_date": "2026-08-14", "public_date": "2026-08-15", "public_time": publication, "effective_time_status": "unknown",
                             "event_type": "board_approved_dividend_proposal", "dividend_status": "proposed_not_evidenced_paid", "content_nature": "source_claim",
                             "issuer": "平安银行股份有限公司", "disclosure_platform": "巨潮资讯网", "source_ids": [ann_meta["source_id"], board_meta["source_id"]],
                             "pdf_path": str(DEST / board_meta["response_file"]), "pdf_sha256": board_meta["response_sha256"], "metadata": announcement},
            "coverage": {"market_rows": len(market_rows), "calendar_days": len(calendar_rows), "calendar_trading_days": len(trade_dates),
                         "missing_market_trade_dates": sorted(trade_dates - market_dates), "market_dates_not_trading": sorted(market_dates - trade_dates),
                         "complete_requested_market_period": trade_dates == market_dates},
            "limitations": ["当前接口响应取得于本轮，不能倒推WFD在历史时点已持有。", "行情和日历历史公开时间未得到原始发布证据，保留unknown。",
                            "上市日期是官方身份属性，不代表当前公司名称及证券—公司关系从该日起始且一直不变。", "财务是公司披露口径；拟分红不冒充已经支付。",
                            "许可与再分发资格未知，按用户授权本机使用保留。"]}
    summary_meta_path = DEST / "sources/cninfo_summary_1225475343.metadata.json"
    if summary_meta_path.exists():
        summary_meta = json.loads(summary_meta_path.read_text("utf-8"))
        if summary_meta.get("http_status") == 200:
            summary_pdf = DEST / summary_meta["response_file"]
            summary_text = summary_pdf.with_suffix(".txt")
            if not summary_text.exists():
                pdf_python = "/Users/mashiro/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"
                extraction = subprocess.run([pdf_python, "-c", "from pypdf import PdfReader; import sys; print('\\n\\f\\n'.join(p.extract_text() for p in PdfReader(sys.argv[1]).pages))", str(summary_pdf)],
                                            capture_output=True, text=True, check=True)
                summary_text.write_text(extraction.stdout, "utf-8")
            report_text = summary_text.read_text("utf-8")
            assert "2026 年半年度报告摘要" in report_text and "人民币百万元" in report_text
            selected = {"revenue_cny_100million": r"营业收入\s+([\d,]+)\s+",
                        "net_profit_attributable_to_parent_cny_100million": r"(?m)^归属于本行股东的净利润\s+([\d,]+)\s+",
                        "operating_cashflow_cny_100million": r"经营活动产生的现金流量净额\s+([\d,]+)\s+"}
            original_values = {}
            for field_code, pattern in selected.items():
                number = re.search(pattern, report_text).group(1).replace(",", "")
                original_values[field_code] = {"value_decimal": number, "unit_code": "cny_million", "column": "2026年1—6月", "page": 3,
                                               "conversion": "目标亿元 = 原始百万元 / 100"}
                converted = format(Decimal(number) / 100, ".2f")
                if field_code == "net_profit_attributable_to_parent_cny_100million":
                    assert converted == parent, "财报摘要与董事会公告净利口径不一致"
                data["financial"]["rows"][0][field_code] = converted
                data["financial"]["field_sources"][field_code] = [summary_meta["source_id"]]
            data["financial"].update(report_type="official_halfyear_report_summary_with_board_dividend", reviewed_by_auditor=True,
                                     primary_report_pdf_source_id=summary_meta["source_id"], primary_report_pdf_path=str(summary_pdf),
                                     primary_report_announcement_no="2026-032", original_report_values=original_values,
                                     primary_report_metadata=next(row for row in ann_raw["announcements"] if row["announcementId"] == "1225475343"))
            data["financial"]["source_ids"].insert(0, summary_meta["source_id"])
    data["identity"]["company"]["name"] = company["公司全称"]
    data["identity"]["security"].update(listing_date=listing["agssrq"], share_class="ordinary_a", board=listing["bk"])
    data["identity"]["listing"]["exchange"] = "szse"
    data["identity"]["source_ids"] = [company_meta["source_id"], stock_meta["source_id"], identity_meta["source_id"], board_meta["source_id"]]
    for row in calendar_rows:
        row.update(session_date=row["trade_date"], is_open=row["is_trading_day"], weekday=row["weekday_sunday_1"])
    for row in market_rows:
        row["amount_cny"] = row["turnover_amount_cny"]
    data["market"]["public_time"] = {"status": "unknown", "precision": "unknown", "earliest_utc": None, "latest_exclusive_utc": None, "source_timezone": "Asia/Shanghai"}
    data["financial"]["period_end"] = "2026-06-30"
    data["financial"]["reported_values"] = data["financial"]["rows"][0]
    meanings = {"net_profit_attributable_to_parent_cny_100million": "2026H1合并报表归属于本行股东的净利润（未扣优先股股息及永续债利息）",
                "net_profit_ordinary_shareholders_cny_100million": "2026H1合并报表归属于本行普通股股东的净利润（扣除优先股股息及永续债利息）",
                "revenue_cny_100million": "2026H1合并口径营业收入", "operating_cashflow_cny_100million": "2026H1经营活动现金流量净额",
                "proposed_dividend_total_cny_100million": "董事会通过的2026年中期拟派现金股利总额，非已支付金额",
                "proposed_dividend_per_10shares_cny": "董事会通过的2026年中期每10股拟派现金股利（含税），非已支付金额"}
    data["financial"]["rows"] = [{"field_code": key, "value_decimal": val, "unit_code": data["financial"]["units"][key], "meaning": meanings[key],
                                  "source_ids": data["financial"]["field_sources"].get(key, [])}
                                 for key, val in data["financial"]["reported_values"].items() if key in meanings and val is not None]
    data["announcement"].update(event_id="pab_board_2026_031", event_date="2026-08-14", source_url=original_acquisition["requested_url"],
                                pdf_source_id=board_meta["source_id"], metadata_source_id=ann_meta["source_id"])
    save(DEST / "inputs.json", data)
    print(json.dumps({"inputs": str(DEST / "inputs.json"), "coverage": data["coverage"], "source_count": len(sources)}, ensure_ascii=False), flush=True)
    return data


if __name__ == "__main__":
    acquire()
    assemble()
