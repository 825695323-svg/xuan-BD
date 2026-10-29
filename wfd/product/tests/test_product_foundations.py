"""P2 foundation checks: explicit fixtures, not claims about real securities."""
import copy
import json
from decimal import Decimal
import tempfile
from pathlib import Path

import pytest

from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_service import WFDProductService
from wfd_sdk import product_foundations as f


HERE = Path(__file__).resolve().parents[1]
ROLES = {"evidence_write", "register", "submit", "publish", "read", "read_evidence",
         "export", "redistribute"}
POLICY = {"may_submit": True, "may_publish_formal": True, "may_read": True,
          "may_read_evidence": True, "may_export": True, "may_export_evidence": True,
          "export_scope": "user_local_validation_only", "usage_scope": "p2_boundary_test"}


def boundary_pack():
    pack = {
        "dataset_id": "p2_boundary_fixture",
        "observed_at": "2026-10-16",
        "regions": [{"id": "region_r", "code": "R", "name": "Boundary Region",
                     "evidence_labels": ["e"]}],
        "markets": [
            {"id": "market_m1", "code": "M1", "name": "Market One", "region_id": "region_r",
             "evidence_labels": ["e"]},
            {"id": "market_m2", "code": "M2", "name": "Market Two", "region_id": "region_r",
             "evidence_labels": ["e"]},
            {"id": "market_m3", "code": "M3", "name": "Market Three", "region_id": "region_r",
             "evidence_labels": ["e"]},
        ],
        "entities": [
            {"id": "entity_e1", "display_name": "Entity One", "legal_name": "Entity One Ltd",
             "org_id": "org_1", "region_id": "region_r", "observed_at": "2026-10-16",
             "name_basis": "observed_only", "evidence_labels": ["e"]},
            {"id": "entity_e2", "display_name": "Entity Two", "legal_name": "Entity Two Ltd",
             "org_id": "org_2", "region_id": "region_r", "observed_at": "2026-10-16",
             "name_basis": "observed_only", "evidence_labels": ["e"]},
        ],
        "instruments": [
            {"id": "instrument_i1", "issuer_id": "entity_e1", "instrument_type": "equity",
             "share_class": "A", "display_name": "Entity One A", "org_id": "org_1",
             "observed_at": "2026-10-16", "name_basis": "observed_only", "evidence_labels": ["e"]},
            {"id": "instrument_i2", "issuer_id": "entity_e2", "instrument_type": "equity",
             "share_class": "A", "display_name": "Entity Two A", "org_id": "org_2",
             "observed_at": "2026-10-16", "name_basis": "observed_only", "evidence_labels": ["e"]},
        ],
        "listings": [],
        "physical_objects": [
            {"id": "physical_p1", "name": "Boundary Port", "object_type": "port",
             "region_id": None, "region_status": "unknown", "observed_at": "2026-10-16",
             "source_file": "fixture", "evidence_labels": ["e"]},
        ],
        "name_claims": [
            {"id": "claim_e1_old", "entity_id": "entity_e1", "name": "Old Entity One",
             "valid_from": "2010-01-01", "valid_to": "2015-01-01",
             "observed_from": "2010-01-01", "observed_to": "2015-01-01",
             "validity_basis": "observed_interval_bounded", "status": "observed",
             "observed_at": "2010-01-01", "source_file": "fixture", "source_line": 1,
             "evidence_labels": ["e"]},
            {"id": "claim_e1_unknown", "entity_id": "entity_e1", "name": "Former Entity One",
             "valid_from": None, "valid_to": None, "validity_basis": "claim_effective_date_unknown",
             "status": "claim_no_effective_date", "observed_at": "2026-10-16",
             "source_file": "fixture", "source_line": 2, "evidence_labels": ["e"]},
            {"id": "claim_e1_open", "entity_id": "entity_e1", "name": "Open Entity One",
             "valid_from": "2010-01-01", "valid_to": None,
             "observed_from": "2010-01-01", "observed_to": "2010-01-01",
             "validity_basis": "observed_daily_quote_name_open_end",
             "status": "observed_open_end", "observed_at": "2010-01-01",
             "source_file": "fixture", "source_line": 3, "evidence_labels": ["e"]},
        ],
        "relations": [
            {"id": "rel_issue_1", "subject": {"kind": "instrument", "id": "instrument_i1"},
             "object": {"kind": "entity", "id": "entity_e1"}, "relation_type": "issued_by",
             "set_id": "issuer_set", "set_completeness": "partial",
             "set_absence_means": "unknown", "definition_authority": "fixture",
             "evidence_labels": ["e"]},
            {"id": "rel_issue_2", "subject": {"kind": "instrument", "id": "instrument_i2"},
             "object": {"kind": "entity", "id": "entity_e2"}, "relation_type": "issued_by",
             "set_id": "issuer_set", "set_completeness": "partial",
             "set_absence_means": "unknown", "definition_authority": "fixture",
             "effective_from": "2010-01-01", "effective_to": "2015-12-31",
             "observed_from": "2010-01-01", "observed_to": "2015-12-31",
             "evidence_labels": ["e"]},
            {"id": "rel_member_complete", "subject": {"kind": "entity", "id": "entity_e1"},
             "object": {"kind": "definition", "id": "class_one"}, "relation_type": "classified_as",
             "set_id": "members_complete", "set_completeness": "complete",
             "set_absence_means": "explicitly_absent", "definition_authority": "fixture",
             "effective_from": "2020-01-01", "evidence_labels": ["e"]},
            {"id": "rel_member_partial", "subject": {"kind": "entity", "id": "entity_e1"},
             "object": {"kind": "definition", "id": "class_two"}, "relation_type": "classified_as",
             "set_id": "members_partial", "set_completeness": "partial",
             "set_absence_means": "unknown", "definition_authority": "fixture",
             "effective_from": "2020-01-01", "evidence_labels": ["e"]},
        ],
        "calendar": {"market_id": "market_m2", "market_code": "M2",
                     "dates": ["2012-01-03", "2012-01-04", "2012-01-05"],
                     "range": ["2012-01-03", "2012-01-05"], "evidence_labels": ["e"]},
        "units": [
            {"unit_code": "cny", "dimension": "money", "display_name": "CNY",
             "base_unit": "cny", "scale_factor": "1", "period_basis": "per_definition",
             "null_rule": "unknown", "status": "source_header", "evidence_basis": "fixture",
             "evidence_labels": ["e"]},
            {"unit_code": "cny_10000", "dimension": "money", "display_name": "CNY 10k",
             "base_unit": "cny", "scale_factor": "10000", "period_basis": "per_definition",
             "null_rule": "unknown", "status": "source_header", "evidence_basis": "fixture",
             "evidence_labels": ["e"]},
            {"unit_code": "ten_thousand_teu", "dimension": "quantity", "display_name": "10k TEU",
             "base_unit": "teu", "scale_factor": "10000", "period_basis": "flow",
             "null_rule": "unknown", "status": "source_text", "evidence_basis": "fixture",
             "evidence_labels": ["e"]},
        ],
        "metric_bindings": [
            {"metric_code": "price", "unit_code": "cny", "unit_status": "known",
             "period_basis": "point_in_time", "null_rule": "unknown",
             "adjustment_basis": "unknown", "evidence_basis": "fixture",
             "evidence_labels": ["e"]},
            {"metric_code": "minute_volume", "unit_code": None, "unit_status": "unknown",
             "period_basis": "interval", "null_rule": "unknown",
             "adjustment_basis": "not_applicable", "evidence_basis": "fixture",
             "evidence_labels": ["e"]},
            {"metric_code": "amount", "unit_code": "cny_10000", "unit_status": "known",
             "period_basis": "flow", "null_rule": "unknown", "adjustment_basis": "not_applicable",
             "sample_value": "12.3456", "sample_unit": "万元",
             "sample_basis": "fixture", "conversion_rule": "万元 x 10000 = 元",
             "scope_note": "fixture", "evidence_basis": "fixture", "evidence_labels": ["e"]},
            {"metric_code": "throughput", "unit_code": "ten_thousand_teu", "unit_status": "known",
             "period_basis": "year", "null_rule": "unknown", "adjustment_basis": "not_applicable",
             "sample_value": "5506.3", "sample_unit": "万标准箱",
             "sample_basis": "fixture", "conversion_rule": "万TEU x 10000 = TEU",
             "scope_note": "fixture", "evidence_basis": "fixture", "evidence_labels": ["e"]},
        ],
    }
    listings = [
        ("listing_l1", "instrument_i1", "market_m1", "000001", "2000-01-01", "2010-12-31",
         "proven_interval", "current"),
        ("listing_l2", "instrument_i1", "market_m2", "000001", "2000-01-01", "2010-12-31",
         "proven_interval", "current"),
        ("listing_l3", "instrument_i1", "market_m1", "000001", "2015-01-01", "2025-12-31",
         "proven_interval", "current"),
        ("listing_old", "instrument_i1", "market_m3", "835185", "2021-11-15", "2025-10-08",
         "proven_interval", "legacy"),
        ("listing_new", "instrument_i1", "market_m3", "920185", "2025-10-09", None,
         "proven_start_open_end", "current"),
    ]
    for lid, inst, market, code, start, end, basis, role in listings:
        pack["listings"].append({
            "id": lid, "instrument_id": inst, "market_id": market, "code": code,
            "board": "main", "currency": "CNY", "status": "listed",
            "observed_at": "2026-10-16", "effective_from": start, "effective_to": end,
            "validity_basis": basis, "code_role": role, "evidence_labels": ["e"]})
        pack["relations"].append({
            "id": "rel_lof_" + lid, "subject": {"kind": "listing", "id": lid},
            "object": {"kind": "instrument", "id": inst}, "relation_type": "listing_of",
            "set_id": "listing_of_set", "set_completeness": "partial",
            "set_absence_means": "unknown", "definition_authority": "fixture",
            "effective_from": start, "effective_to": end, "evidence_labels": ["e"]})
        pack["relations"].append({
            "id": "rel_lon_" + lid, "subject": {"kind": "listing", "id": lid},
            "object": {"kind": "market", "id": market}, "relation_type": "listed_on",
            "set_id": "listed_on_set", "set_completeness": "partial",
            "set_absence_means": "unknown", "definition_authority": "fixture",
            "effective_from": start, "effective_to": end, "evidence_labels": ["e"]})
    pack["listings"].append({
        "id": "listing_future_m2", "instrument_id": "instrument_i2", "market_id": "market_m2",
        "code": "999999", "board": "main", "currency": "CNY", "status": "listed",
        "observed_at": "2026-10-16", "effective_from": "2010-01-01",
        "effective_to": "2015-12-31", "observed_to": "2015-12-31",
        "validity_basis": "proven_interval", "code_role": "current", "evidence_labels": ["e"]})
    pack["relations"].extend([
        {"id": "rel_lof_future", "subject": {"kind": "listing", "id": "listing_future_m2"},
         "object": {"kind": "instrument", "id": "instrument_i2"}, "relation_type": "listing_of",
         "set_id": "listing_of_set", "set_completeness": "partial",
         "set_absence_means": "unknown", "definition_authority": "fixture",
         "effective_from": "2010-01-01", "effective_to": "2015-12-31",
         "observed_from": "2010-01-01", "observed_to": "2015-12-31", "evidence_labels": ["e"]},
        {"id": "rel_lon_future", "subject": {"kind": "listing", "id": "listing_future_m2"},
         "object": {"kind": "market", "id": "market_m2"}, "relation_type": "listed_on",
         "set_id": "listed_on_set", "set_completeness": "partial",
         "set_absence_means": "unknown", "definition_authority": "fixture",
         "effective_from": "2010-01-01", "effective_to": "2015-12-31",
         "observed_from": "2010-01-01", "observed_to": "2015-12-31", "evidence_labels": ["e"]},
    ])
    # Path-qualification counterexample: entity_e3 has one all-known path to
    # market_m2 and one unknown-issuer path; entity_e4 has only the unknown path.
    pack["entities"].extend([
        {"id": "entity_e3", "display_name": "Entity Three", "legal_name": "Entity Three Ltd",
         "org_id": "org_3", "region_id": "region_r", "observed_at": "2026-10-16",
         "name_basis": "observed_only", "evidence_labels": ["e"]},
        {"id": "entity_e4", "display_name": "Entity Four", "legal_name": "Entity Four Ltd",
         "org_id": "org_4", "region_id": "region_r", "observed_at": "2026-10-16",
         "name_basis": "observed_only", "evidence_labels": ["e"]},
    ])
    pack["instruments"].extend([
        {"id": "instrument_i3", "issuer_id": "entity_e3", "instrument_type": "equity",
         "share_class": "A", "display_name": "Entity Three A", "org_id": "org_3",
         "observed_at": "2026-10-16", "name_basis": "observed_only", "evidence_labels": ["e"]},
        {"id": "instrument_i4", "issuer_id": "entity_e3", "instrument_type": "equity",
         "share_class": "A", "display_name": "Entity Three B", "org_id": "org_3",
         "observed_at": "2026-10-16", "name_basis": "observed_only", "evidence_labels": ["e"]},
        {"id": "instrument_i5", "issuer_id": "entity_e4", "instrument_type": "equity",
         "share_class": "A", "display_name": "Entity Four A", "org_id": "org_4",
         "observed_at": "2026-10-16", "name_basis": "observed_only", "evidence_labels": ["e"]},
    ])
    for lid, inst, code in [("listing_l5", "instrument_i3", "700001"),
                            ("listing_l6", "instrument_i4", "700002"),
                            ("listing_l7", "instrument_i5", "700003")]:
        pack["listings"].append({
            "id": lid, "instrument_id": inst, "market_id": "market_m2", "code": code,
            "board": "main", "currency": "CNY", "status": "listed",
            "observed_at": "2026-10-16", "effective_from": "2010-01-01",
            "effective_to": "2020-12-31", "observed_to": "2015-12-31",
            "validity_basis": "proven_interval", "code_role": "current", "evidence_labels": ["e"]})
        pack["relations"].extend([
            {"id": "rel_lof_" + lid, "subject": {"kind": "listing", "id": lid},
             "object": {"kind": "instrument", "id": inst}, "relation_type": "listing_of",
             "set_id": "listing_of_set", "set_completeness": "partial",
             "set_absence_means": "unknown", "definition_authority": "fixture",
             "effective_from": "2010-01-01", "effective_to": "2020-12-31",
             "observed_from": "2010-01-01", "observed_to": "2015-12-31",
             "evidence_labels": ["e"]},
            {"id": "rel_lon_" + lid, "subject": {"kind": "listing", "id": lid},
             "object": {"kind": "market", "id": "market_m2"}, "relation_type": "listed_on",
             "set_id": "listed_on_set", "set_completeness": "partial",
             "set_absence_means": "unknown", "definition_authority": "fixture",
             "effective_from": "2010-01-01", "effective_to": "2020-12-31",
             "observed_from": "2010-01-01", "observed_to": "2015-12-31",
             "evidence_labels": ["e"]},
        ])
    pack["relations"].extend([
        {"id": "rel_issue_i3_unknown", "subject": {"kind": "instrument", "id": "instrument_i3"},
         "object": {"kind": "entity", "id": "entity_e3"}, "relation_type": "issued_by",
         "set_id": "issuer_set", "set_completeness": "partial",
         "set_absence_means": "unknown", "definition_authority": "fixture",
         "observed_from": "2026-10-16", "observed_to": "2026-10-16", "evidence_labels": ["e"]},
        {"id": "rel_issue_i4_known", "subject": {"kind": "instrument", "id": "instrument_i4"},
         "object": {"kind": "entity", "id": "entity_e3"}, "relation_type": "issued_by",
         "set_id": "issuer_set", "set_completeness": "partial",
         "set_absence_means": "unknown", "definition_authority": "fixture",
         "effective_from": "2010-01-01", "effective_to": "2020-12-31",
         "observed_from": "2010-01-01", "observed_to": "2015-12-31",
         "evidence_labels": ["e"]},
        {"id": "rel_issue_i5_unknown", "subject": {"kind": "instrument", "id": "instrument_i5"},
         "object": {"kind": "entity", "id": "entity_e4"}, "relation_type": "issued_by",
         "set_id": "issuer_set", "set_completeness": "partial",
         "set_absence_means": "unknown", "definition_authority": "fixture",
         "observed_from": "2026-10-16", "observed_to": "2026-10-16", "evidence_labels": ["e"]},
    ])
    return pack


@pytest.fixture(scope="module")
def submitted(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("p2_boundary")
    engine = WFDDuckDBPrototype(tmp / "store", load_protocol_validator(HERE / "protocol"),
                                runtime_root=tmp / "runtime", sandbox=False, writer_host="p2-test")
    service = WFDProductService(
        engine, allowed_sources={f.EVIDENCE_SOURCE_ID: copy.deepcopy(POLICY)},
        caller_roles=ROLES, caller_id="p2-test",
        unit_registry={unit["unit_code"]: {"dimension": unit["dimension"]}
                       for unit in boundary_pack()["units"]},
        trusted_actor_namespaces={"wfd.p2.foundations"})
    evidence_path = tmp / "boundary_evidence.txt"
    evidence_path.write_text("P2 boundary fixture; not a real security or relation.\n", "utf-8")
    evidence = {"e": service.register_evidence(evidence_path)}
    pack = boundary_pack()
    f.validate_pack(pack)

    units = f.build_unit_outputs(pack, evidence)
    first = service.submit(f.make_request(pack["dataset_id"], "units", units))
    assert first["status"] == "published_formal", first
    unit = first["output_results"][0]

    outputs = (f.build_identity_outputs(pack, evidence)
               + f.build_relation_outputs(pack, evidence)
               + f.build_calendar_output(pack, evidence))
    request = f.make_request(pack["dataset_id"], "identities", outputs)
    request["expected_parent_snapshot_id"] = first["snapshot_id"]
    second = service.submit(request)
    assert second["status"] == "published_formal", second

    bindings, dependencies = f.build_binding_outputs(pack, evidence, unit["product_id"],
                                                      first["snapshot_id"])
    request = f.make_request(pack["dataset_id"], "bindings", bindings, dependencies)
    request["expected_parent_snapshot_id"] = second["snapshot_id"]
    third = service.submit(request)
    assert third["status"] == "published_formal", third

    catalog = f.FoundationCatalog.from_snapshot(service, third["snapshot_id"])
    return {"service": service, "store": tmp, "snapshot": third["snapshot_id"],
            "catalog": catalog, "pack": pack}


def test_real_fixed_snapshot_shows_separate_identity_kinds(submitted):
    catalog = submitted["catalog"]
    assert catalog.counts()["entities"] == 4
    assert catalog.counts()["instruments"] == 5
    assert catalog.counts()["listings"] == 9
    assert catalog.counts()["physical_objects"] == 1
    # A company is not a listing, and a listing is not an instrument.
    assert {r.subject["kind"] for r in catalog.entities} == {"entity"}
    assert {r.subject["kind"] for r in catalog.instruments} == {"instrument"}
    assert {r.subject["kind"] for r in catalog.listings} == {"listing"}
    view = catalog.entity_view("entity_e1", at="2025-01-02", allow_unknown_association=True)
    assert view["status"] == "ok"
    assert view["instruments"] == []
    assert {item["id"] for item in view["instrument_candidates"]} == {"instrument_i1"}
    assert view["listings"] == []
    assert {item["code"] for item in view["listing_candidates"]} == {"000001", "835185"}


def test_code_market_period_resolution_keeps_candidates(submitted):
    catalog = submitted["catalog"]
    ambiguous = catalog.resolve_code("000001", at="2005-06-01")
    assert ambiguous["status"] == "ambiguous"
    assert {c["market_code"] for c in ambiguous["candidates"]} == {"M1", "M2"}
    assert ambiguous["selected"] is None
    # Same code is reused after a gap: the old listing must not answer for 2012.
    assert catalog.resolve_code("000001", at="2012-06-01")["status"] == "not_found"
    assert catalog.resolve_code("000001", at="2016-06-01")["status"] == "resolved"
    assert catalog.resolve_code("000001", at="2016-06-01")["selected"]["listing_id"] == "listing_l3"


def test_code_switch_fixture_same_instrument_different_listing_codes(submitted):
    catalog = submitted["catalog"]
    before = catalog.resolve_code("835185", market="M3", at="2025-01-02")
    after = catalog.resolve_code("920185", market="M3", at="2025-10-10")
    assert before["status"] == after["status"] == "resolved"
    assert before["selected"]["instrument_id"] == after["selected"]["instrument_id"] == "instrument_i1"
    assert before["selected"]["listing_id"] != after["selected"]["listing_id"]


def test_unknown_relation_validity_is_not_historical_truth(submitted):
    catalog = submitted["catalog"]
    result = catalog.relations_for("instrument_i1", at="2005-06-01")
    assert result["relations"] == []
    assert result["indeterminate"][0]["reason"] == "EFFECTIVE_PERIOD_UNKNOWN"
    strict = catalog.entity_view("entity_e1", at="2005-06-01")
    assert strict["instruments"] == []
    assert strict["association_basis"] == "observed_identity_with_unknown_history"


def test_partial_membership_never_infers_exit(submitted):
    catalog = submitted["catalog"]
    complete = catalog.members_of("members_complete", at="2024-01-01")
    assert complete["exits_inferable"] is True
    partial = catalog.members_of("members_partial", at="2024-01-01")
    assert partial["exits_inferable"] is False
    assert partial["set_completeness"] == "partial"
    before = catalog.members_of("members_complete", at="2010-01-01")
    assert before["status"] == "not_effective"
    assert before["exits_inferable"] is False


def test_observed_names_are_not_backfilled(submitted):
    catalog = submitted["catalog"]
    # The current name is an observation at 2026-10-16, not a name valid in 2020.
    observed_now = catalog.resolve_name("Entity One", at="2026-10-16")
    assert observed_now["status"] == "resolved"
    historical = catalog.resolve_name("Entity One", at="2020-01-01")
    assert historical["status"] == "indeterminate"
    claim = catalog.resolve_name("Former Entity One", at="2020-01-01")
    assert claim["status"] == "indeterminate"
    bounded = catalog.resolve_name("Old Entity One", at="2012-01-01")
    assert bounded["status"] == "resolved"
    open_end = catalog.resolve_name("Open Entity One", at="2010-01-01")
    assert open_end["status"] == "resolved"
    beyond = catalog.resolve_name("Open Entity One", at="2035-01-01")
    assert beyond["status"] == "indeterminate"
    assert beyond["candidates"][0]["validity"]["reason"] == "AFTER_OBSERVED_EVIDENCE_END"


def test_unit_catalogue_is_a_read_dependency(submitted):
    catalog = submitted["catalog"]
    binding = catalog.unit_binding("price")
    assert binding["status"] == "resolved"
    assert binding["unit"]["unit_code"] == "cny"
    assert binding["dependency_verified"] is True
    assert binding["read_dependencies"][0]["role"] == "unit_definitions"
    unknown = catalog.unit_binding("minute_volume")
    assert unknown["status"] == "resolved"
    assert unknown["unit_code"] is None
    assert unknown["unit_status"] == "unknown"
    amount = catalog.unit_binding("amount")
    assert amount["unit"]["unit_code"] == "cny_10000"
    assert Decimal(amount["sample_value"]) * Decimal(amount["unit"]["scale_factor"]) == Decimal("123456")
    throughput = catalog.unit_binding("throughput")
    assert throughput["unit"]["unit_code"] == "ten_thousand_teu"
    assert Decimal(throughput["sample_value"]) * Decimal(throughput["unit"]["scale_factor"]) == Decimal("55063000")


def test_invalid_association_excluded_from_candidate_calendar(submitted):
    catalog = submitted["catalog"]
    # entity_e2 / M2 is effective 2010-2015; at 2005 it is a known-invalid
    # association, not an unknown candidate.
    before = catalog.company_calendar("entity_e2", start="2012-01-01", end="2012-12-31",
                                      at="2005-01-01", mode="candidates")
    assert before["calendars"] == []
    assert before["status"] == "not_eligible"
    during = catalog.company_calendar("entity_e2", start="2012-01-01", end="2012-12-31",
                                      at="2012-01-01", mode="strict")
    assert during["status"] == "ok"
    assert during["calendars"][0]["market_code"] == "M2"
    assert during["calendars"][0]["calendar_status"] == "available"


def test_pack_rejects_cross_kind_relation():
    pack = boundary_pack()
    pack["relations"][0] = copy.deepcopy(pack["relations"][0])
    pack["relations"][0]["subject"] = {"kind": "entity", "id": "entity_e1"}
    with pytest.raises(f.FoundationInputError, match="RELATION_SUBJECT_KIND_MISMATCH"):
        f.validate_pack(pack)


def test_pack_rejects_unknown_metric_unit():
    pack = boundary_pack()
    pack["metric_bindings"][0]["unit_code"] = "not_in_catalogue"
    with pytest.raises(f.FoundationInputError, match="METRIC_UNIT_UNKNOWN"):
        f.validate_pack(pack)


def test_candidate_path_qualification_propagates_to_calendar(submitted):
    catalog = submitted["catalog"]
    mixed = catalog.entity_view("entity_e3", at="2012-01-01", allow_unknown_association=True)
    assert {item["id"] for item in mixed["instruments"]} == {"instrument_i4"}
    assert {item["id"] for item in mixed["instrument_candidates"]} == {"instrument_i3"}
    assert {item["id"] for item in mixed["listings"]} == {"listing_l6"}
    assert {item["id"] for item in mixed["listing_candidates"]} == {"listing_l5"}
    assert {item["id"] for item in mixed["markets"]} == {"market_m2"}
    assert mixed["market_candidates"] == []
    calendar_known = catalog.company_calendar("entity_e3", start="2012-01-01", end="2012-12-31",
                                              at="2012-01-01", mode="candidates")
    assert calendar_known["candidate_only"] is False
    assert calendar_known["calendars"][0]["calendar_status"] == "available"
    assert calendar_known["calendars"][0]["association_status"] == "known"
    # Only an unknown issuer path: downstream known listing/market must stay candidate.
    unknown = catalog.entity_view("entity_e4", at="2012-01-01", allow_unknown_association=True)
    assert unknown["instruments"] == []
    assert {item["id"] for item in unknown["instrument_candidates"]} == {"instrument_i5"}
    assert {item["id"] for item in unknown["listings"]} == set()
    assert {item["id"] for item in unknown["listing_candidates"]} == {"listing_l7"}
    assert unknown["markets"] == []
    assert {item["id"] for item in unknown["market_candidates"]} == {"market_m2"}
    calendar_unknown = catalog.company_calendar("entity_e4", start="2012-01-01", end="2012-12-31",
                                               at="2012-01-01", mode="candidates")
    assert calendar_unknown["candidate_only"] is True
    assert calendar_unknown["calendars"][0]["calendar_status"] == "candidate_indeterminate"
    assert calendar_unknown["calendars"][0]["association_status"] == "candidate"
