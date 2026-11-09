"""Small generated daily fixtures, never historical/market evidence.

Only deterministic test inputs live in source.  Stores, evidence, snapshots and
versions are created by the real service under the caller's new temporary root.
No historical product/snapshot ID is reused and no admission method is patched.
"""
from __future__ import annotations

import copy
import hashlib
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, canonical, load_protocol_validator
from wfd_sdk.product_service import SERVICE_VERSION, WFDProductService


HERE = Path(__file__).resolve().parents[1]
DATASET = "synthetic_daily"
SUBJECT = {"kind": "instrument", "namespace": "wfd.synthetic", "id": "daily_000001"}
SOURCE_IDS = ("synthetic_market", "synthetic_units")
AUTHORITY = "wfd.synthetic.daily"
ACTOR = "wfd.synthetic.fixtures"
ALL_ROLES = {"evidence_write", "register", "submit", "publish", "read",
             "read_evidence", "export", "redistribute"}


def known_day(value: str) -> dict:
    start = datetime.combine(date.fromisoformat(value), datetime.min.time(),
                             tzinfo=ZoneInfo("Asia/Shanghai"))
    end = start + timedelta(days=1)
    return {"status": "known", "precision": "day",
            "earliest_utc": start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "latest_exclusive_utc": end.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source_timezone": "Asia/Shanghai"}


def daily_rows() -> list[dict]:
    """43 artificial weekday rows; values deliberately are not historical prices."""
    rows = []
    day = date(2025, 11, 3)
    while day <= date(2025, 12, 31):
        if day.weekday() < 5:
            price = Decimal("100.00") + Decimal(len(rows)) / Decimal(100)
            rows.append({
                "business_key": "daily_000001_" + day.strftime("%Y%m%d"),
                "subject": copy.deepcopy(SUBJECT), "observation_time": known_day(day.isoformat()),
                "values": {
                    "close_price": {"data_type": "decimal", "value_state": "valid_value", "value": format(price, ".2f")},
                    "price_adjustment": {"data_type": "text", "value_state": "valid_value", "value": "unknown"},
                    "source_basis": {"data_type": "text", "value_state": "valid_value", "value": "synthetic_fixture_not_market_data"},
                },
            })
        day += timedelta(days=1)
    assert len(rows) == 43
    return rows


def source_policy() -> dict:
    return {"may_submit": True, "may_publish_formal": True,
            "may_read": True, "may_read_evidence": True,
            "may_export": True, "may_export_evidence": True,
            "export_scope": "user_local_validation_only", "usage_scope": "test_only",
            "allowed_roles": ["definer", "compiler", "deliverer"],
            "allowed_authorities": [AUTHORITY], "may_redistribute": False}


def _output(key: str, fields: list[dict], rows: list[dict], evidence: dict) -> dict:
    return {"output_key": key, "logical_domain": "observations",
            "subject": copy.deepcopy(SUBJECT), "definition_mode": "create", "definition_ref": None,
            "new_definition_declaration": {
                "semantic_code": "synthetic." + key, "measurement_nature": "stock",
                "unit_code": "per_field", "definition_authority": AUTHORITY,
                "time_role": "observation", "field_definitions": fields},
            "input_mode": "partial_observation",
            "coverage": {"scope": {"synthetic_test_only": True}, "basis": "observed_partial",
                         "completeness": "partial", "coverage_evidence": [], "absence_means": "unknown"},
            "payload": {"kind": "tabular_rows", "rows": rows}, "evidence_refs": [evidence]}


def _document(output: dict, source_id: str, request_id: str, *, parent=None, dependencies=()) -> dict:
    key = output["output_key"]
    doc = {"protocol_version": "wfd.ingest/1.3-candidate",
           "request_identity": {"dataset_id": DATASET, "trusted_actor_namespace": ACTOR,
                                "request_id": request_id},
           "intent": "submit", "producer_namespace": ACTOR,
           "expected_parent_snapshot_id": parent, "outputs": [output],
           "source_bundle": {
               "source_id": source_id, "source_ids": [source_id], "license": "synthetic_test_only",
               "usage_scope": "test_only", "raw_source_bytes_custodied": True,
               "source_roles": {key: [{"source_id": source_id, "roles": ["definer", "compiler", "deliverer"]}]},
               "public_time": known_day("2024-01-01"),
               "product_service": {"version": SERVICE_VERSION,
                                   "outputs": {key: {"read_dependencies": list(dependencies)}}}}}
    doc["request_identity"]["submission_digest"] = "sha256:" + hashlib.sha256(canonical(doc)).hexdigest()
    return doc


@dataclass(frozen=True)
class DailyFixture:
    store: Path
    service: WFDProductService
    engine: WFDDuckDBPrototype
    snapshot_id: str
    product_id: str
    unit_snapshot_id: str
    unit_product_id: str
    row_count: int


def make_daily_store(root: Path) -> DailyFixture:
    """Explicitly initialize a new disposable root, then publish two actual products."""
    root = Path(root)
    if root.exists() or root.is_symlink():
        raise ValueError("synthetic daily fixture requires a new, nonexistent temporary root")
    root.mkdir(parents=True)
    engine = WFDDuckDBPrototype.initialize_new(
        root / "store", load_protocol_validator(HERE / "protocol"),
        runtime_root=root / "runtime", sandbox=False, writer_host="synthetic-daily")
    service = WFDProductService(
        engine, allowed_sources={source: source_policy() for source in SOURCE_IDS},
        caller_roles=ALL_ROLES, caller_id="synthetic-daily",
        trusted_actor_namespaces={ACTOR},
        unit_registry={"cny_per_share": {"dimension": "money_per_share", "currency": "CNY", "multiplier": "1"}})
    evidence_path = root / "synthetic-source.txt"
    evidence_path.write_text("Generated test input only. Not real prices, licensing, or historical evidence.\n", "utf-8")
    evidence = service.register_evidence(evidence_path)
    unit = _output("daily_unit", [
        {"field_code": "unit_label", "data_type": "text", "unit_code": "not_applicable",
         "measurement_nature": "stock", "time_role": "observation"}], [{
             "business_key": "synthetic_unit", "subject": copy.deepcopy(SUBJECT),
             "observation_time": known_day("2024-01-02"),
             "values": {"unit_label": {"data_type": "text", "value_state": "valid_value", "value": "CNY/share"}}}], evidence)
    unit_result = service.submit(_document(unit, SOURCE_IDS[1], "synthetic-unit-v1"))
    assert unit_result["status"] == "published_formal", unit_result
    unit_pid = unit_result["output_results"][0]["product_id"]
    unit_sid = unit_result["snapshot_id"]
    fields = [{"field_code": name, "data_type": kind, "unit_code": unit_code,
               "measurement_nature": "stock", "time_role": "observation"}
              for name, kind, unit_code in [("close_price", "decimal", "cny_per_share"),
                                             ("price_adjustment", "text", "not_applicable"),
                                             ("source_basis", "text", "not_applicable")]]
    rows = daily_rows()
    daily = _output("daily_prices", fields, rows, evidence)
    dependency = {"dataset_id": DATASET, "snapshot_id": unit_sid, "product_id": unit_pid,
                  "role": "unit", "required": True}
    result = service.submit(_document(daily, SOURCE_IDS[0], "synthetic-daily-v1",
                                      parent=unit_sid, dependencies=[dependency]))
    assert result["status"] == "published_formal", result
    return DailyFixture(root / "store", service, engine, result["snapshot_id"],
                        result["output_results"][0]["product_id"], unit_sid, unit_pid, len(rows))
