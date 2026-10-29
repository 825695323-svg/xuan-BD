"""P2 foundation identities, unit semantics and fixed-snapshot resolution.

This module is deliberately an adapter over ``WFDProductService``.  It does not
create a second database, a private ingest path or a per-kind submission kernel:
every foundation object is an ordinary declaration submitted through the same
generic product service.  The service stays free to change; this file only uses
its public register/submit/read/trace surface.

Scope actually implemented here:

* separate entity, instrument, listing, market, region and physical-object
  declarations, registered from supplied evidence;
* code + market + effective-date resolution on one fixed snapshot, with
  explicit candidate lists for ambiguity and unproven validity;
* evidence-backed name claims, including an unknown effective date that is
  never filled in from a later observation;
* relation direction, effective period, public time, evidence and set
  completeness as readable row data; no negative membership inference unless a
  set is explicitly complete;
* a versioned unit catalogue and metric-to-unit bindings that are real read
  dependencies of the generic service;
* one trading-day calendar product, with dates only (no session claims).

Not implemented here (do not infer from this module): P4 graph traversal,
legal rename effective dates lacking evidence, historical code validity outside
proven ranges, trade sessions, a global identity table, and cross-dataset
dependencies.
"""
from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

from .product_service import SERVICE_VERSION


FOUNDATION_VERSION = "wfd.product-foundations/0.1"
FOUNDATION_NAMESPACE = "wfd.cn"
EVIDENCE_SOURCE_ID = "wfd_p2_local_evidence"

SEMANTIC = {
    "entity": "wfd.foundation.entity.profile",
    "instrument": "wfd.foundation.instrument.identity",
    "listing": "wfd.foundation.listing.identity",
    "market": "wfd.foundation.market.identity",
    "region": "wfd.foundation.region.identity",
    "physical_object": "wfd.foundation.physical_object.identity",
    "name_claim": "wfd.foundation.entity.name_claim",
    "issuer_relation": "wfd.foundation.relation.issuer",
    "listing_relation": "wfd.foundation.relation.listing",
    "industry_relation": "wfd.foundation.relation.industry",
    "physical_relation": "wfd.foundation.relation.physical",
    "calendar": "wfd.foundation.calendar.trading_days",
    "unit": "wfd.foundation.unit.catalogue",
    "metric_binding": "wfd.foundation.unit.metric_binding",
}

RELATION_SHAPES = {
    "issued_by": ("instrument", "entity"),
    "listing_of": ("listing", "instrument"),
    "listed_on": ("listing", "market"),
    "classified_as": ("entity", "definition"),
    "operated_by": ("physical_object", "entity"),
    "same_issuer": ("instrument", "instrument"),
}

UNIT_DIMENSIONS = {"money", "quantity", "money_per_share", "ratio", "ordinal", "number", "text", "identifier"}

_TEXT = "not_applicable"


def _field(code, data_type="text", nature="mixed_observation", time_role="observation"):
    return {"field_code": code, "data_type": data_type, "unit_code": _TEXT,
            "measurement_nature": nature, "time_role": time_role}


ENTITY_FIELDS = [
    _field("display_name"), _field("legal_name"), _field("org_id"), _field("region_id"),
    _field("observed_at"), _field("name_basis"), _field("name_effective_from"),
    _field("name_effective_to"), _field("source_as_of"), _field("evidence_label"),
    _field("source_file"), _field("source_line"),
]
INSTRUMENT_FIELDS = [
    _field("instrument_type"), _field("share_class"), _field("issuer_id"),
    _field("display_name"), _field("org_id"), _field("observed_at"),
    _field("name_basis"), _field("evidence_label"), _field("source_file"), _field("source_line"),
]
LISTING_FIELDS = [
    _field("code"), _field("instrument_id"), _field("market_id"), _field("board"),
    _field("currency"), _field("status"), _field("observed_at"), _field("effective_from"),
    _field("effective_to"), _field("observed_to"), _field("validity_basis"), _field("code_role"),
    _field("evidence_kind"), _field("source_note"),
    _field("evidence_label"), _field("source_file"), _field("source_line"),
]
MARKET_FIELDS = [_field("code"), _field("name"), _field("region_id"), _field("evidence_label")]
REGION_FIELDS = [_field("code"), _field("name"), _field("evidence_label")]
PHYSICAL_FIELDS = [
    _field("name"), _field("object_type"), _field("region_id"), _field("region_status"),
    _field("object_scope"), _field("operator_scope"), _field("scope_note"),
    _field("observed_at"), _field("evidence_label"), _field("source_file"),
]
NAME_CLAIM_FIELDS = [
    _field("entity_id"), _field("name"), _field("valid_from"), _field("valid_to"),
    _field("observed_from"), _field("observed_to"),
    _field("validity_basis"), _field("status"), _field("observed_at"),
    _field("evidence_label"), _field("source_file"), _field("source_line"),
]
RELATION_FIELDS = [
    _field("set_id"), _field("set_completeness"), _field("set_absence_means"),
    _field("definition_authority"), _field("effective_status"), _field("effective_from"),
    _field("effective_to"), _field("observed_from"), _field("observed_to"),
    _field("public_status"), _field("public_from"), _field("public_to"),
    _field("relation_scope"), _field("scope_note"), _field("evidence_label"), _field("source_file"),
]
CALENDAR_FIELDS = [
    _field("session_date", "text", "event", "validity"),
    _field("is_open", "boolean", "event", "validity"),
    _field("market_code"),
    _field("day_type"),
]
UNIT_FIELDS = [
    _field("unit_code"), _field("dimension"), _field("display_name"),
    _field("base_unit"), _field("scale_factor"), _field("period_basis"),
    _field("null_rule"), _field("status"), _field("definition_scope"), _field("evidence_basis"),
]
METRIC_BINDING_FIELDS = [
    _field("metric_code"), _field("unit_code"), _field("unit_status"),
    _field("period_basis"), _field("null_rule"), _field("adjustment_basis"),
    _field("sample_value"), _field("sample_unit"), _field("sample_basis"),
    _field("conversion_rule"), _field("scope_note"), _field("evidence_basis"),
]


class FoundationInputError(ValueError):
    """The supplied foundation pack is not internally coherent."""


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _digest(value):
    return "sha256:" + hashlib.sha256(_canonical(value)).hexdigest()


def _parse_day(value, label):
    if value in {None, ""}:
        return None
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").date()
    except (TypeError, ValueError) as exc:
        raise FoundationInputError(f"{label}: expected YYYY-MM-DD, got {value!r}") from exc


def day_time(value):
    """A known local (Asia/Shanghai) day as a UTC half-open interval."""
    parsed = _parse_day(value, "day")
    if parsed is None:
        raise FoundationInputError("day_time requires a date")
    local_start = datetime(parsed.year, parsed.month, parsed.day, tzinfo=timezone(timedelta(hours=8)))
    start = local_start.astimezone(timezone.utc)
    end = (local_start + timedelta(days=1)).astimezone(timezone.utc)
    return {"status": "known", "precision": "day",
            "earliest_utc": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "latest_exclusive_utc": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source_timezone": "Asia/Shanghai"}


def unknown_time():
    return {"status": "unknown", "precision": "unknown", "earliest_utc": None,
            "latest_exclusive_utc": None, "source_timezone": "UTC"}


def open_period(start=None, end=None):
    if start is None:
        return unknown_time()
    period = day_time(start)
    if end is not None:
        period = copy.deepcopy(period)
        period["precision"] = "interval"
        period["latest_exclusive_utc"] = day_time(end)["earliest_utc"]
    return period


def _cell_text(value):
    if value in {None, ""}:
        return {"data_type": "text", "value_state": "unknown", "value": None}
    return {"data_type": "text", "value_state": "valid_value", "value": str(value)}


def _cell_bool(value):
    if value is None:
        return {"data_type": "boolean", "value_state": "unknown", "value": None}
    return {"data_type": "boolean", "value_state": "valid_value", "value": bool(value)}


def _row(values, *, subject, observation_time, business_key):
    fields = {}
    for code, value in values.items():
        if isinstance(value, bool):
            fields[code] = _cell_bool(value)
        else:
            fields[code] = _cell_text(value)
    return {"business_key": business_key, "subject": copy.deepcopy(subject),
            "observation_time": observation_time, "values": fields}


def _coverage(scope, completeness, evidence, absence_means="unknown", basis="observed_partial"):
    return {"scope": scope, "basis": basis, "completeness": completeness,
            "coverage_evidence": copy.deepcopy(evidence),
            "absence_means": absence_means}


def _declaration(semantic, fields, authority, time_role):
    return {"semantic_code": semantic, "measurement_nature":
            "relation" if semantic.startswith("wfd.foundation.relation.") else "mixed_observation",
            "unit_code": ("not_applicable" if semantic.startswith("wfd.foundation.relation.")
                          else "per_field" if fields else "not_applicable"),
            "definition_authority": authority, "time_role": time_role,
            "field_definitions": copy.deepcopy(fields)}


def _output(key, subject, declaration, rows, evidence_refs, coverage, input_mode="partial_observation"):
    return {"output_key": key, "logical_domain": "foundation", "subject": copy.deepcopy(subject),
            "definition_mode": "create", "definition_ref": None,
            "new_definition_declaration": declaration, "input_mode": input_mode,
            "coverage": coverage, "payload": {"kind": "tabular_rows" if not declaration["semantic_code"].startswith("wfd.foundation.relation.") else "relation_edges", "rows": rows},
            "evidence_refs": copy.deepcopy(evidence_refs)}


def _subject(kind, ident):
    return {"kind": kind, "namespace": FOUNDATION_NAMESPACE, "id": ident}


def _ev(evidence, labels):
    refs, seen = [], set()
    for label in labels:
        if label not in evidence:
            raise FoundationInputError("EVIDENCE_LABEL_UNKNOWN:" + str(label))
        ref = evidence[label]
        key = ref.get("content_sha256") or ref.get("ref_id")
        if key not in seen:
            seen.add(key)
            refs.append(copy.deepcopy(ref))
    if not refs:
        raise FoundationInputError("EVIDENCE_REQUIRED")
    return refs


# ---------------------------------------------------------------------------
# Pack validation


def validate_pack(pack):
    """Reject mixed identity kinds, dangling references and incoherent sets."""
    if not isinstance(pack, dict):
        raise FoundationInputError("PACK_INVALID")
    required = ("dataset_id", "entities", "instruments", "listings", "markets", "regions",
                "physical_objects", "name_claims", "relations", "calendar", "units", "metric_bindings")
    for key in required:
        if key not in pack:
            raise FoundationInputError("PACK_KEY_MISSING:" + key)
    data = {key: pack[key] for key in required}
    for key in ("entities", "instruments", "listings", "markets", "regions",
                "physical_objects", "name_claims", "relations", "units", "metric_bindings"):
        if not isinstance(data[key], list):
            raise FoundationInputError("PACK_LIST_INVALID:" + key)
    ids = {}
    singular = {"entities": "entity", "instruments": "instrument", "listings": "listing",
                "markets": "market", "regions": "region", "physical_objects": "physical_object"}
    for kind in singular:
        for item in data[kind]:
            ident = item.get("id")
            if not isinstance(ident, str) or not ident:
                raise FoundationInputError(f"{kind}: missing id")
            if ident in ids:
                raise FoundationInputError(f"DUPLICATE_ID:{ident}")
            ids[ident] = singular[kind]
    for entity in data["entities"]:
        if entity.get("region_id") not in {None, ""} and ids.get(entity["region_id"]) != "region":
            raise FoundationInputError("ENTITY_REGION_KIND_MISMATCH:" + str(entity.get("id")))
    for instrument in data["instruments"]:
        if ids.get(instrument.get("issuer_id")) != "entity":
            raise FoundationInputError("INSTRUMENT_ISSUER_KIND_MISMATCH:" + str(instrument.get("id")))
    for listing in data["listings"]:
        if ids.get(listing.get("instrument_id")) != "instrument":
            raise FoundationInputError("LISTING_INSTRUMENT_KIND_MISMATCH:" + str(listing.get("id")))
        if ids.get(listing.get("market_id")) != "market":
            raise FoundationInputError("LISTING_MARKET_KIND_MISMATCH:" + str(listing.get("id")))
        if not isinstance(listing.get("code"), str) or not listing["code"]:
            raise FoundationInputError("LISTING_CODE_REQUIRED:" + str(listing.get("id")))
    for obj in data["physical_objects"]:
        if obj.get("region_id") not in {None, ""} and ids.get(obj["region_id"]) != "region":
            raise FoundationInputError("PHYSICAL_REGION_KIND_MISMATCH:" + str(obj.get("id")))
    for claim in data["name_claims"]:
        if ids.get(claim.get("entity_id")) != "entity":
            raise FoundationInputError("NAME_CLAIM_ENTITY_KIND_MISMATCH:" + str(claim.get("id")))
    sets = {}
    for relation in data["relations"]:
        subject, obj = relation.get("subject", {}), relation.get("object", {})
        rtype = relation.get("relation_type")
        if rtype not in RELATION_SHAPES:
            raise FoundationInputError("RELATION_TYPE_UNSUPPORTED:" + str(rtype))
        want_subject, want_object = RELATION_SHAPES[rtype]
        if subject.get("kind") != want_subject or ids.get(subject.get("id")) != want_subject:
            raise FoundationInputError("RELATION_SUBJECT_KIND_MISMATCH:" + str(relation.get("id")))
        if obj.get("kind") != want_object:
            raise FoundationInputError("RELATION_OBJECT_KIND_MISMATCH:" + str(relation.get("id")))
        if want_object != "definition" and ids.get(obj.get("id")) != want_object:
            raise FoundationInputError("RELATION_OBJECT_KIND_MISMATCH:" + str(relation.get("id")))
        set_id = relation.get("set_id")
        if not isinstance(set_id, str) or not set_id:
            raise FoundationInputError("RELATION_SET_REQUIRED:" + str(relation.get("id")))
        signature = (rtype, relation.get("set_completeness"), relation.get("set_absence_means"),
                     relation.get("definition_authority"))
        if set_id in sets and sets[set_id] != signature:
            raise FoundationInputError("RELATION_SET_INCOHERENT:" + set_id)
        sets[set_id] = signature
        for name in ("effective_from", "effective_to", "public_from", "public_to"):
            _parse_day(relation.get(name), f"{relation.get('id')}.{name}")
        if relation.get("effective_from") and relation.get("effective_to"):
            if _parse_day(relation["effective_from"], "from") >= _parse_day(relation["effective_to"], "to"):
                raise FoundationInputError("RELATION_PERIOD_INVALID:" + str(relation.get("id")))
    calendar = data["calendar"]
    if ids.get(calendar.get("market_id")) != "market":
        raise FoundationInputError("CALENDAR_MARKET_KIND_MISMATCH")
    dates = calendar.get("dates")
    if not isinstance(dates, list) or not dates:
        raise FoundationInputError("CALENDAR_DATES_REQUIRED")
    parsed = [_parse_day(item, "calendar date") for item in dates]
    if len(set(parsed)) != len(parsed) or parsed != sorted(parsed):
        raise FoundationInputError("CALENDAR_DATES_NOT_SORTED_UNIQUE")
    units = {}
    for unit in data["units"]:
        code = unit.get("unit_code")
        if not isinstance(code, str) or not code:
            raise FoundationInputError("UNIT_CODE_REQUIRED")
        if code in units:
            raise FoundationInputError("DUPLICATE_UNIT:" + code)
        if unit.get("dimension") not in UNIT_DIMENSIONS:
            raise FoundationInputError("UNIT_DIMENSION_INVALID:" + code)
        units[code] = unit
    for binding in data["metric_bindings"]:
        if not binding.get("metric_code"):
            raise FoundationInputError("METRIC_CODE_REQUIRED")
        code = binding.get("unit_code")
        if binding.get("unit_status") == "unknown":
            if code not in {None, ""}:
                raise FoundationInputError("UNKNOWN_UNIT_MUST_NOT_NAME_A_CODE:" + str(binding.get("metric_code")))
        elif code not in units:
            raise FoundationInputError("METRIC_UNIT_UNKNOWN:" + str(binding.get("metric_code")))
    return data


# ---------------------------------------------------------------------------
# Generic request construction


def make_request(dataset_id, request_id, outputs, dependencies=None, namespace="wfd.p2.foundations"):
    dependencies = dependencies or {}
    ext = {"version": SERVICE_VERSION,
           "outputs": {out["output_key"]: {"read_dependencies": copy.deepcopy(dependencies.get(out["output_key"], []))}
                       for out in outputs}}
    return {
        "protocol_version": "wfd.ingest/1.3-candidate",
        "request_identity": {"dataset_id": dataset_id, "trusted_actor_namespace": namespace,
                             "request_id": request_id, "submission_digest": _digest(outputs)},
        "intent": "submit", "producer_namespace": namespace,
        "expected_parent_snapshot_id": None,
        "outputs": copy.deepcopy(outputs),
        "source_bundle": {
            "source_id": EVIDENCE_SOURCE_ID, "source_ids": [EVIDENCE_SOURCE_ID],
            "license": "user_local_validation_only",
            "usage_scope": "p2_foundations_local_validation",
            "raw_source_bytes_custodied": True,
            "product_service": ext,
        },
    }


# ---------------------------------------------------------------------------
# Output builders


def build_unit_outputs(pack, evidence):
    rows = []
    for unit in sorted(pack["units"], key=lambda item: item["unit_code"]):
        labels = unit.get("evidence_labels", [])
        rows.append(_row({
            "unit_code": unit["unit_code"], "dimension": unit["dimension"],
            "display_name": unit.get("display_name"), "base_unit": unit.get("base_unit"),
            "scale_factor": unit.get("scale_factor"), "period_basis": unit.get("period_basis"),
            "null_rule": unit.get("null_rule"), "status": unit.get("status"),
            "definition_scope": unit.get("definition_scope"),
            "evidence_basis": unit.get("evidence_basis"),
        }, subject=_subject("definition", "wfd_unit_catalogue"),
           observation_time=day_time(pack["observed_at"]),
           business_key="unit_" + unit["unit_code"]))
    labels = sorted({label for unit in pack["units"] for label in unit.get("evidence_labels", [])})
    declaration = _declaration(SEMANTIC["unit"], UNIT_FIELDS, "wfd.p2.unit_catalogue", "unit_definition")
    return [_output("unit_catalogue", _subject("definition", "wfd_unit_catalogue"), declaration,
                    rows, _ev(evidence, labels),
                    _coverage({"units": len(rows), "catalogue": "p2_evidence_backed"},
                              "complete" if rows else "unknown", _ev(evidence, labels), "unknown",
                              "declared_full"))]


def build_identity_outputs(pack, evidence):
    outputs = []
    for entity in pack["entities"]:
        labels = entity.get("evidence_labels") or []
        row = _row({
            "display_name": entity.get("display_name"), "legal_name": entity.get("legal_name"),
            "org_id": entity.get("org_id"), "region_id": entity.get("region_id"),
            "observed_at": entity.get("observed_at"), "name_basis": entity.get("name_basis"),
            "name_effective_from": entity.get("name_effective_from"),
            "name_effective_to": entity.get("name_effective_to"),
            "source_as_of": entity.get("source_as_of"), "evidence_label": ",".join(labels),
            "source_file": entity.get("source_file"), "source_line": entity.get("source_line"),
        }, subject=_subject("entity", entity["id"]),
           observation_time=day_time(entity.get("observed_at", pack["observed_at"])),
           business_key="entity_profile_" + entity["id"])
        declaration = _declaration(SEMANTIC["entity"], ENTITY_FIELDS, "wfd.p2.identity", "identity")
        outputs.append(_output("entity_" + entity["id"], _subject("entity", entity["id"]),
                               declaration, [row], _ev(evidence, labels),
                               _coverage({"object": entity["id"], "observed_at": entity.get("observed_at")},
                                         "partial", _ev(evidence, labels))))
    for instrument in pack["instruments"]:
        labels = instrument.get("evidence_labels") or []
        row = _row({
            "instrument_type": instrument.get("instrument_type"), "share_class": instrument.get("share_class"),
            "issuer_id": instrument.get("issuer_id"), "display_name": instrument.get("display_name"),
            "org_id": instrument.get("org_id"), "observed_at": instrument.get("observed_at"),
            "name_basis": instrument.get("name_basis"), "evidence_label": ",".join(labels),
            "source_file": instrument.get("source_file"), "source_line": instrument.get("source_line"),
        }, subject=_subject("instrument", instrument["id"]),
           observation_time=day_time(instrument.get("observed_at", pack["observed_at"])),
           business_key="instrument_identity_" + instrument["id"])
        declaration = _declaration(SEMANTIC["instrument"], INSTRUMENT_FIELDS, "wfd.p2.identity", "identity")
        outputs.append(_output("instrument_" + instrument["id"], _subject("instrument", instrument["id"]),
                               declaration, [row], _ev(evidence, labels),
                               _coverage({"object": instrument["id"], "observed_at": instrument.get("observed_at")},
                                         "partial", _ev(evidence, labels))))
    for listing in pack["listings"]:
        labels = listing.get("evidence_labels") or []
        row = _row({
            "code": listing.get("code"), "instrument_id": listing.get("instrument_id"),
            "market_id": listing.get("market_id"), "board": listing.get("board"),
            "currency": listing.get("currency"), "status": listing.get("status"),
            "observed_at": listing.get("observed_at"), "effective_from": listing.get("effective_from"),
            "effective_to": listing.get("effective_to"), "observed_to": listing.get("observed_to"),
            "validity_basis": listing.get("validity_basis"),
            "code_role": listing.get("code_role"),
            "evidence_kind": listing.get("evidence_kind"), "source_note": listing.get("source_note"),
            "evidence_label": ",".join(labels),
            "source_file": listing.get("source_file"), "source_line": listing.get("source_line"),
        }, subject=_subject("listing", listing["id"]),
           observation_time=day_time(listing.get("observed_at", pack["observed_at"])),
           business_key="listing_identity_" + listing["id"])
        declaration = _declaration(SEMANTIC["listing"], LISTING_FIELDS, "wfd.p2.identity", "validity")
        outputs.append(_output("listing_" + listing["id"], _subject("listing", listing["id"]),
                               declaration, [row], _ev(evidence, labels),
                               _coverage({"object": listing["id"], "code": listing.get("code")},
                                         "partial", _ev(evidence, labels))))
    for market in pack["markets"]:
        labels = market.get("evidence_labels") or []
        row = _row({"code": market.get("code"), "name": market.get("name"),
                    "region_id": market.get("region_id"), "evidence_label": ",".join(labels)},
                   subject=_subject("market", market["id"]), observation_time=day_time(pack["observed_at"]),
                   business_key="market_identity_" + market["id"])
        declaration = _declaration(SEMANTIC["market"], MARKET_FIELDS, "wfd.p2.identity", "identity")
        outputs.append(_output("market_" + market["id"], _subject("market", market["id"]),
                               declaration, [row], _ev(evidence, labels),
                               _coverage({"object": market["id"]}, "partial", _ev(evidence, labels))))
    for region in pack["regions"]:
        labels = region.get("evidence_labels") or []
        row = _row({"code": region.get("code"), "name": region.get("name"),
                    "evidence_label": ",".join(labels)},
                   subject=_subject("region", region["id"]), observation_time=day_time(pack["observed_at"]),
                   business_key="region_identity_" + region["id"])
        declaration = _declaration(SEMANTIC["region"], REGION_FIELDS, "wfd.p2.identity", "identity")
        outputs.append(_output("region_" + region["id"], _subject("region", region["id"]),
                               declaration, [row], _ev(evidence, labels),
                               _coverage({"object": region["id"]}, "partial", _ev(evidence, labels))))
    for obj in pack["physical_objects"]:
        labels = obj.get("evidence_labels") or []
        row = _row({
            "name": obj.get("name"), "object_type": obj.get("object_type"),
            "region_id": obj.get("region_id"), "region_status": obj.get("region_status"),
            "observed_at": obj.get("observed_at"),
            "object_scope": obj.get("object_scope"), "operator_scope": obj.get("operator_scope"),
            "scope_note": obj.get("scope_note"), "evidence_label": ",".join(labels),
            "source_file": obj.get("source_file"),
        }, subject=_subject("physical_object", obj["id"]),
           observation_time=day_time(obj.get("observed_at", pack["observed_at"])),
           business_key="physical_identity_" + obj["id"])
        declaration = _declaration(SEMANTIC["physical_object"], PHYSICAL_FIELDS, "wfd.p2.identity", "identity")
        outputs.append(_output("physical_object_" + obj["id"], _subject("physical_object", obj["id"]),
                               declaration, [row], _ev(evidence, labels),
                               _coverage({"object": obj["id"]}, "partial", _ev(evidence, labels))))
    if pack["name_claims"]:
        rows = []
        for claim in pack["name_claims"]:
            labels = claim.get("evidence_labels") or []
            rows.append(_row({
                "entity_id": claim["entity_id"], "name": claim.get("name"),
                "valid_from": claim.get("valid_from"), "valid_to": claim.get("valid_to"),
                "observed_from": claim.get("observed_from"), "observed_to": claim.get("observed_to"),
                "validity_basis": claim.get("validity_basis"), "status": claim.get("status"),
                "observed_at": claim.get("observed_at"), "evidence_label": ",".join(labels),
                "source_file": claim.get("source_file"), "source_line": claim.get("source_line"),
            }, subject=_subject("entity", claim["entity_id"]),
               observation_time=day_time(claim.get("observed_at", pack["observed_at"])),
               business_key="name_claim_" + claim["id"]))
        labels = sorted({label for claim in pack["name_claims"] for label in claim.get("evidence_labels", [])})
        declaration = _declaration(SEMANTIC["name_claim"], NAME_CLAIM_FIELDS, "wfd.p2.identity", "validity")
        outputs.append(_output("name_claims", _subject("region", pack["regions"][0]["id"]),
                               declaration, rows, _ev(evidence, labels),
                               _coverage({"claims": len(rows)}, "partial", _ev(evidence, labels))))
    return outputs


def build_relation_outputs(pack, evidence):
    grouped = {}
    for relation in pack["relations"]:
        grouped.setdefault(relation["set_id"], []).append(relation)
    outputs = []
    for set_id, relations in sorted(grouped.items()):
        # A set is one relation type and one completeness declaration.
        rtype = relations[0]["relation_type"]
        semantic = {"issued_by": SEMANTIC["issuer_relation"],
                    "listing_of": SEMANTIC["listing_relation"],
                    "listed_on": SEMANTIC["listing_relation"],
                    "classified_as": SEMANTIC["industry_relation"],
                    "operated_by": SEMANTIC["physical_relation"],
                    "same_issuer": SEMANTIC["issuer_relation"]}.get(rtype, SEMANTIC["issuer_relation"])
        fields = RELATION_FIELDS
        declaration = _declaration(semantic, fields, relations[0].get("definition_authority", "wfd.p2.relations"),
                                   "validity")
        rows = []
        labels = set()
        for relation in relations:
            item_labels = relation.get("evidence_labels") or []
            labels.update(item_labels)
            effective_status = "known" if relation.get("effective_from") or relation.get("effective_to") else "unknown"
            public_status = "known" if relation.get("public_from") or relation.get("public_to") else "unknown"
            values = {
                "set_id": set_id, "set_completeness": relation.get("set_completeness"),
                "set_absence_means": relation.get("set_absence_means"),
                "definition_authority": relation.get("definition_authority"),
                "effective_status": effective_status, "effective_from": relation.get("effective_from"),
                "effective_to": relation.get("effective_to"),
                "observed_from": relation.get("observed_from"), "observed_to": relation.get("observed_to"),
                "public_status": public_status,
                "public_from": relation.get("public_from"), "public_to": relation.get("public_to"),
                "relation_scope": relation.get("relation_scope"), "scope_note": relation.get("scope_note"),
                "evidence_label": ",".join(item_labels), "source_file": relation.get("source_file"),
            }
            rows.append({
                "business_key": relation["id"],
                "subject": _subject(relation["subject"]["kind"], relation["subject"]["id"]),
                "object": _subject(relation["object"]["kind"], relation["object"]["id"]),
                "relation_type": rtype,
                "effective_period": open_period(relation.get("effective_from"), relation.get("effective_to")),
                "public_time": open_period(relation.get("public_from"), relation.get("public_to")),
                "values": {code: (_cell_bool(value) if isinstance(value, bool) else _cell_text(value))
                           for code, value in values.items()},
            })
        completeness = relations[0].get("set_completeness", "unknown")
        absence = relations[0].get("set_absence_means", "unknown")
        outputs.append(_output("relation_" + set_id, _subject("region", pack["regions"][0]["id"]),
                               declaration, rows, _ev(evidence, sorted(labels)),
                               _coverage({"set_id": set_id, "members": len(rows)},
                                         completeness, _ev(evidence, sorted(labels)), absence,
                                         "observed_partial" if completeness != "complete" else "declared_full")))
    return outputs


def build_calendar_output(pack, evidence):
    calendar = pack["calendar"]
    labels = calendar.get("evidence_labels") or []
    rows = []
    for item in calendar["dates"]:
        rows.append(_row({"session_date": item, "is_open": True,
                          "market_code": calendar.get("market_code", "SZSE"),
                          "day_type": "trading_day"},
                         subject=_subject("market", calendar["market_id"]),
                         observation_time=day_time(item), business_key="trading_day_" + item))
    declaration = _declaration(SEMANTIC["calendar"], CALENDAR_FIELDS, "wfd.p2.calendar", "validity")
    return [_output("calendar_trading_days", _subject("market", calendar["market_id"]), declaration,
                    rows, _ev(evidence, labels),
                    _coverage({"market_id": calendar["market_id"], "range": calendar.get("range"),
                               "dates": len(rows), "claim": "trading_dates_only"},
                              "complete", _ev(evidence, labels), "unknown", "declared_full"),
                    input_mode="complete_snapshot")]


def build_binding_outputs(pack, evidence, unit_product, unit_snapshot_id):
    labels = sorted({label for binding in pack["metric_bindings"] for label in binding.get("evidence_labels", [])})
    rows = []
    for binding in sorted(pack["metric_bindings"], key=lambda item: item["metric_code"]):
        rows.append(_row({
            "metric_code": binding["metric_code"], "unit_code": binding.get("unit_code"),
            "unit_status": binding.get("unit_status"), "period_basis": binding.get("period_basis"),
            "null_rule": binding.get("null_rule"), "adjustment_basis": binding.get("adjustment_basis"),
            "sample_value": binding.get("sample_value"), "sample_unit": binding.get("sample_unit"),
            "sample_basis": binding.get("sample_basis"), "conversion_rule": binding.get("conversion_rule"),
            "scope_note": binding.get("scope_note"), "evidence_basis": binding.get("evidence_basis"),
        }, subject=_subject("definition", "wfd_metric_unit_bindings"),
           observation_time=day_time(pack["observed_at"]),
           business_key="metric_binding_" + binding["metric_code"]))
    declaration = _declaration(SEMANTIC["metric_binding"], METRIC_BINDING_FIELDS,
                               "wfd.p2.unit_bindings", "unit_definition")
    output = _output("metric_unit_bindings", _subject("definition", "wfd_metric_unit_bindings"),
                     declaration, rows, _ev(evidence, labels),
                     _coverage({"bindings": len(rows)}, "complete", _ev(evidence, labels), "unknown",
                               "declared_full"),
                     input_mode="partial_observation")
    dependency = {"dataset_id": pack["dataset_id"], "product_id": unit_product,
                  "snapshot_id": unit_snapshot_id, "role": "unit_definitions", "required": True}
    return [output], {output["output_key"]: [dependency]}


# ---------------------------------------------------------------------------
# Fixed-snapshot catalog and resolution


@dataclass
class Record:
    product_id: str
    semantic: str
    row: dict
    subject: dict
    evidence_refs: list
    source: dict
    contract_ref: dict | None
    definition_ref: dict | None

    def value(self, code):
        cell = (self.row.get("values") or {}).get(code)
        if not isinstance(cell, dict) or cell.get("value_state") != "valid_value":
            return None
        return cell.get("value")

    def state(self, code):
        cell = (self.row.get("values") or {}).get(code)
        return cell.get("value_state") if isinstance(cell, dict) else None


def _validity(at, start, end, observed_at, basis, observed_from=None, observed_to=None):
    """Separate legal/effective validity from the observed evidence interval.

    An open-ended legal period is never silently extended past the last dated
    evidence.  ``observed_only`` means exactly the observation day; a declared
    observed interval is bounded by its actual first/last evidence dates.
    """
    if at is None:
        return {"state": "not_evaluated", "basis": basis}
    at_day = _parse_day(at, "at")
    start_day = _parse_day(start, "start")
    end_day = _parse_day(end, "end")
    obs_start = _parse_day(observed_from, "observed_from") or _parse_day(observed_at, "observed_at")
    obs_end = _parse_day(observed_to, "observed_to") or _parse_day(observed_at, "observed_at")
    observed_interval = bool(obs_start and obs_end)
    observed_state = ("valid" if observed_interval and obs_start <= at_day <= obs_end else
                      "invalid" if observed_interval else "unknown")
    legal_interval = bool(start_day or end_day)
    if legal_interval:
        if start_day and end_day:
            legal_state = "valid" if start_day <= at_day < end_day else "invalid"
            reason = None if legal_state == "valid" else "OUTSIDE_EFFECTIVE_INTERVAL"
        elif start_day and not end_day:
            if at_day < start_day:
                legal_state, reason = "invalid", "BEFORE_EFFECTIVE_START"
            elif obs_end and at_day > obs_end:
                legal_state, reason = "unknown", "AFTER_OBSERVED_EVIDENCE_END"
            else:
                legal_state, reason = "valid", None
        else:  # only an end is known
            if at_day >= end_day:
                legal_state, reason = "invalid", "AT_OR_AFTER_EFFECTIVE_END"
            else:
                legal_state, reason = "unknown", "EFFECTIVE_START_UNKNOWN"
        result = {"state": legal_state, "basis": basis or "proven_interval",
                  "effective_from": str(start_day) if start_day else None,
                  "effective_to": str(end_day) if end_day else None,
                  "observed_from": str(obs_start) if obs_start else None,
                  "observed_to": str(obs_end) if obs_end else None,
                  "legal_interval": True, "observed": observed_state == "valid",
                  "reason": reason}
        if legal_state == "valid" and observed_state != "valid":
            result["evidence_note"] = "LEGAL_PERIOD_VALID_OUTSIDE_OBSERVED_EVIDENCE"
        return result
    # No legal interval: only the observed evidence interval can support a fact.
    if observed_interval and observed_state == "valid":
        return {"state": "valid", "basis": basis or "observed_interval",
                "effective_from": None, "effective_to": None,
                "observed_from": str(obs_start), "observed_to": str(obs_end),
                "legal_interval": False, "observed": True, "reason": None}
    if basis == "observed_only" and obs_start and at_day == obs_start:
        return {"state": "valid", "basis": "observed_only",
                "effective_from": None, "effective_to": None,
                "observed_from": str(obs_start), "observed_to": str(obs_end),
                "legal_interval": False, "observed": True, "reason": None}
    return {"state": "unknown", "basis": basis or "validity_unknown",
            "effective_from": None, "effective_to": None,
            "observed_from": str(obs_start) if obs_start else None,
            "observed_to": str(obs_end) if obs_end else None,
            "legal_interval": False, "observed": False,
            "reason": "OBSERVED_EVIDENCE_MISSING_OR_OUTSIDE_INTERVAL"}


class FoundationCatalog:
    """Read-only view over one fixed product snapshot."""

    def __init__(self, service, snapshot_id, records, products):
        self.service = service
        self.snapshot_id = snapshot_id
        self.records = records
        self.products = products
        self.entities = [r for r in records if r.semantic == SEMANTIC["entity"]]
        self.instruments = [r for r in records if r.semantic == SEMANTIC["instrument"]]
        self.listings = [r for r in records if r.semantic == SEMANTIC["listing"]]
        self.markets = [r for r in records if r.semantic == SEMANTIC["market"]]
        self.regions = [r for r in records if r.semantic == SEMANTIC["region"]]
        self.physical_objects = [r for r in records if r.semantic == SEMANTIC["physical_object"]]
        self.name_claims = [r for r in records if r.semantic == SEMANTIC["name_claim"]]
        self.relations = [r for r in records if r.semantic.startswith("wfd.foundation.relation.")]
        self.calendar = [r for r in records if r.semantic == SEMANTIC["calendar"]]
        self.units = [r for r in records if r.semantic == SEMANTIC["unit"]]
        self.bindings = [r for r in records if r.semantic == SEMANTIC["metric_binding"]]

    @classmethod
    def from_snapshot(cls, service, snapshot_id):
        read = service.read(snapshot_id=snapshot_id, include_history=False)
        products = {product["product_id"]: product for product in read["products"]}
        records = []
        for item in read["rows"]:
            product = products.get(item["product_id"])
            if not product:
                continue
            records.append(Record(
                product_id=item["product_id"],
                semantic=product["declaration"]["semantic_code"],
                row=copy.deepcopy(item["row"]), subject=copy.deepcopy(item["subject"]),
                evidence_refs=copy.deepcopy(item["evidence_refs"]),
                source=copy.deepcopy(item.get("source") or item.get("source_binding") or {}),
                contract_ref=item.get("contract_ref"), definition_ref=item.get("definition_ref")))
        return cls(service, snapshot_id, records, products)

    # -- helpers ---------------------------------------------------------
    def _entity_profile(self, entity_id, at_date=None):
        candidates = [r for r in self.entities if (r.row.get("subject") or {}).get("id") == entity_id]
        if not candidates:
            return None
        if at_date:
            at = _parse_day(at_date, "at")
            eligible = [r for r in candidates if r.value("observed_at")
                        and _parse_day(r.value("observed_at"), "observed_at") <= at]
            if eligible:
                candidates = eligible
        return max(candidates, key=lambda r: (r.value("observed_at") or "", r.product_id))

    def _record(self, kind_list, ident):
        for record in kind_list:
            if (record.row.get("subject") or {}).get("id") == ident:
                return record
        return None

    def _display(self, kind_list, ident, field):
        record = self._record(kind_list, ident)
        return record.value(field) if record else None

    def _relation_validity(self, record, at_date):
        return _validity(at_date, record.value("effective_from"), record.value("effective_to"),
                         None, record.value("effective_status") or "unknown",
                         observed_from=record.value("observed_from"),
                         observed_to=record.value("observed_to"))

    def _public_validity(self, record, at_date):
        return _validity(at_date, record.value("public_from"), record.value("public_to"),
                         None, record.value("public_status") or "unknown",
                         observed_from=record.value("observed_from"),
                         observed_to=record.value("observed_to"))

    # -- code and name resolution ---------------------------------------
    def resolve_code(self, code, *, market=None, at=None, allow_unknown_alongside=False):
        at_date = _parse_day(at, "at") if at else None
        candidates = []
        for record in self.listings:
            if record.value("code") != str(code):
                continue
            market_id = record.value("market_id")
            market_code = None
            market_record = self._record(self.markets, market_id)
            if market_record:
                market_code = market_record.value("code")
            if market and str(market) not in {market_id, market_code}:
                continue
            validity = _validity(at, record.value("effective_from"), record.value("effective_to"),
                                 record.value("observed_at"), record.value("validity_basis"),
                                 observed_from=record.value("observed_at"),
                                 observed_to=record.value("observed_to"))
            candidates.append({
                "listing_id": record.subject["id"], "instrument_id": record.value("instrument_id"),
                "market_id": market_id, "market_code": market_code, "code": record.value("code"),
                "code_role": record.value("code_role"), "validity": validity,
                "validity_basis": record.value("validity_basis"),
                "observed_at": record.value("observed_at"),
                "evidence_label": record.value("evidence_label"),
                "source_file": record.value("source_file"), "source_line": record.value("source_line"),
                "product_id": record.product_id,
            })
        valid = [c for c in candidates if c["validity"]["state"] == "valid"]
        unknown = [c for c in candidates if c["validity"]["state"] == "unknown"]
        diagnostics = []
        if at is None and candidates:
            status = "resolved" if len(candidates) == 1 else "ambiguous"
            return {"query": {"code": str(code), "market": market, "at": at},
                    "status": status, "selected": candidates[0] if status == "resolved" else None,
                    "candidates": candidates, "diagnostics": diagnostics,
                    "snapshot_id": self.snapshot_id, "perspective": "p2_fixed_snapshot"}
        if not candidates:
            status = "not_found"
        elif len(valid) == 1 and (not unknown or allow_unknown_alongside):
            status = "resolved"
            diagnostics = [{"reason": "OTHER_CANDIDATES_UNKNOWN_VALIDITY", "listing_id": c["listing_id"]}
                           for c in unknown]
        elif len(valid) > 1:
            status = "ambiguous"
            diagnostics = [{"reason": "MULTIPLE_VALID_LISTINGS"}]
        elif len(valid) == 1 and unknown:
            status = "indeterminate"
            diagnostics = [{"reason": "VALID_AND_UNKNOWN_CANDIDATES",
                            "listing_id": valid[0]["listing_id"]}]
        elif not valid and not unknown:
            status = "not_found"
            diagnostics = [{"reason": "NO_VALID_LISTING_AT_DATE"}]
        else:
            status = "indeterminate"
            diagnostics = [{"reason": "CODE_VALIDITY_UNKNOWN_AT_DATE"}]
        return {"query": {"code": str(code), "market": market, "at": at},
                "status": status, "selected": valid[0] if status == "resolved" else None,
                "candidates": candidates, "diagnostics": diagnostics,
                "snapshot_id": self.snapshot_id, "perspective": "p2_fixed_snapshot"}

    def resolve_name(self, name, *, at=None):
        at_date = _parse_day(at, "at") if at else None
        candidates = []
        for record in self.entities:
            for field in ("display_name", "legal_name"):
                if record.value(field) == name:
                    candidates.append({
                        "kind": "entity", "id": record.subject["id"], "field": field,
                        "validity": _validity(at_date, record.value("name_effective_from"),
                                              record.value("name_effective_to"),
                                              record.value("observed_at"), record.value("name_basis"),
                                              observed_from=record.value("observed_at"),
                                              observed_to=record.value("observed_at")),
                        "name_basis": record.value("name_basis"),
                        "observed_at": record.value("observed_at"), "product_id": record.product_id,
                    })
        for record in self.instruments:
            if record.value("display_name") == name:
                candidates.append({
                    "kind": "instrument", "id": record.subject["id"], "field": "display_name",
                    "validity": _validity(at_date, None, None, record.value("observed_at"),
                                          record.value("name_basis"),
                                          observed_from=record.value("observed_at"),
                                          observed_to=record.value("observed_at")),
                    "name_basis": record.value("name_basis"),
                    "observed_at": record.value("observed_at"), "product_id": record.product_id,
                })
        for record in self.name_claims:
            if record.value("name") == name:
                candidates.append({
                    "kind": "entity", "id": record.value("entity_id"), "field": "name_claim",
                    "validity": _validity(at_date, record.value("valid_from"), record.value("valid_to"),
                                          record.value("observed_at"), record.value("validity_basis"),
                                          observed_from=record.value("observed_from"),
                                          observed_to=record.value("observed_to")),
                    "name_basis": record.value("validity_basis"), "status": record.value("status"),
                    "observed_at": record.value("observed_at"), "product_id": record.product_id,
                })
        valid = [c for c in candidates if c["validity"]["state"] == "valid"]
        unknown = [c for c in candidates if c["validity"]["state"] == "unknown"]
        if at is None and candidates:
            return {"query": {"name": name, "at": at},
                    "status": "resolved" if len(candidates) == 1 else "ambiguous",
                    "selected": candidates[0] if len(candidates) == 1 else None,
                    "candidates": candidates, "diagnostics": [],
                    "snapshot_id": self.snapshot_id}
        if not candidates:
            status = "not_found"
        elif len(valid) == 1 and not unknown:
            status = "resolved"
        elif len(valid) > 1:
            status = "ambiguous"
        elif valid:
            status = "indeterminate"
        elif not unknown:
            status = "not_found"
        else:
            status = "indeterminate"
        return {"query": {"name": name, "at": at}, "status": status,
                "selected": valid[0] if status == "resolved" else None,
                "candidates": candidates,
                "diagnostics": ([] if len(valid) == 1 else
                                [{"reason": "NO_UNIQUE_VALID_NAME_AT_DATE",
                                  "valid": len(valid), "unknown": len(unknown)}]),
                "snapshot_id": self.snapshot_id}

    # -- relations and membership ---------------------------------------
    def relations_for(self, subject_id, *, at=None, require_public_time=False):
        at_date = _parse_day(at, "at") if at else None
        known, indeterminate = [], []
        for record in self.relations:
            if (record.row.get("subject") or {}).get("id") != subject_id:
                continue
            effective = self._relation_validity(record, at_date)
            public = self._public_validity(record, at_date)
            item = {"relation_id": record.row["business_key"],
                    "relation_type": record.row.get("relation_type"),
                    "subject": copy.deepcopy(record.row.get("subject")),
                    "object": copy.deepcopy(record.row.get("object")),
                    "set_id": record.value("set_id"), "effective": effective, "public": public,
                    "product_id": record.product_id}
            if effective["state"] == "not_evaluated":
                known.append(item)
            elif effective["state"] != "valid":
                item["reason"] = "EFFECTIVE_PERIOD_UNKNOWN" if effective["state"] == "unknown" else "NOT_EFFECTIVE_AT_DATE"
                indeterminate.append(item)
            elif require_public_time and public["state"] != "valid":
                item["reason"] = "PUBLIC_TIME_UNKNOWN" if public["state"] == "unknown" else "NOT_PUBLIC_AT_DATE"
                indeterminate.append(item)
            else:
                known.append(item)
        return {"subject_id": subject_id, "at": at, "relations": known,
                "indeterminate": indeterminate, "snapshot_id": self.snapshot_id,
                "note": "P2 reads known edges only; full graph traversal is P4."}

    def members_of(self, set_id, *, at=None):
        at_date = _parse_day(at, "at") if at else None
        records = [r for r in self.relations if r.value("set_id") == set_id]
        if not records:
            return {"set_id": set_id, "status": "not_found", "members": [],
                    "exits_inferable": False, "snapshot_id": self.snapshot_id}
        completeness = {r.value("set_completeness") for r in records}
        absence = {r.value("set_absence_means") for r in records}
        authority = {r.value("definition_authority") for r in records}
        coherent = len(completeness) == 1 and len(absence) == 1
        starts = [_parse_day(r.value("effective_from"), "start") for r in records
                  if r.value("effective_from")]
        ends = [_parse_day(r.value("effective_to"), "end") for r in records
                if r.value("effective_to")]
        observed_ends = [_parse_day(r.value("observed_to"), "observed_to") for r in records
                         if r.value("observed_to")]
        set_start = min(starts) if starts else None
        set_end = max(ends) if ends else None
        set_observed_end = min(observed_ends) if observed_ends else None
        if at_date is not None:
            if set_start and at_date < set_start:
                return {"set_id": set_id, "status": "not_effective", "members": [],
                        "indeterminate": [], "set_completeness": "unknown",
                        "set_absence_means": "unknown", "definition_authority": None,
                        "exits_inferable": False,
                        "reason": "SET_NOT_EFFECTIVE_AT_DATE", "snapshot_id": self.snapshot_id}
            if set_end and at_date >= set_end:
                return {"set_id": set_id, "status": "not_effective", "members": [],
                        "indeterminate": [], "set_completeness": "unknown",
                        "set_absence_means": "unknown", "definition_authority": None,
                        "exits_inferable": False,
                        "reason": "SET_ENDED_BEFORE_DATE", "snapshot_id": self.snapshot_id}
            if set_observed_end and at_date > set_observed_end:
                return {"set_id": set_id, "status": "indeterminate", "members": [],
                        "indeterminate": [], "set_completeness": "unknown",
                        "set_absence_means": "unknown", "definition_authority": None,
                        "exits_inferable": False,
                        "reason": "AFTER_OBSERVED_EVIDENCE_END", "snapshot_id": self.snapshot_id}
        members, indeterminate, invalid = [], [], []
        for record in records:
            effective = self._relation_validity(record, at_date)
            item = {"member_id": (record.row.get("subject") or {}).get("id"),
                    "relation_id": record.row["business_key"], "effective": effective}
            if effective["state"] in {"valid", "not_evaluated"}:
                members.append(item)
            elif effective["state"] == "unknown":
                item["reason"] = effective.get("reason") or "EFFECTIVE_PERIOD_UNKNOWN"
                indeterminate.append(item)
            else:
                item["reason"] = effective.get("reason") or "NOT_EFFECTIVE_AT_DATE"
                invalid.append(item)
        complete = coherent and completeness == {"complete"} and absence == {"explicitly_absent"}
        exits = bool(complete and not indeterminate and not invalid and
                     (at_date is None or members))
        return {
            "set_id": set_id, "status": "ok" if coherent else "incoherent",
            "members": members, "indeterminate": indeterminate, "invalid": invalid,
            "set_completeness": next(iter(completeness)) if len(completeness) == 1 else "unknown",
            "set_absence_means": next(iter(absence)) if len(absence) == 1 else "unknown",
            "definition_authority": next(iter(authority)) if len(authority) == 1 else None,
            "set_effective_from": str(set_start) if set_start else None,
            "set_effective_to": str(set_end) if set_end else None,
            "set_observed_to": str(set_observed_end) if set_observed_end else None,
            "exits_inferable": exits,
            "negative_membership_note": ("complete set within its effective/observed window: absence means explicit exit"
                                         if exits else "partial/unknown/out-of-window set: observed members never imply exit"),
            "snapshot_id": self.snapshot_id,
        }

    @staticmethod
    def _assoc_bucket(effective):
        if effective["state"] in {"valid", "not_evaluated"}:
            return "known"
        if effective["state"] == "unknown":
            return "candidate"
        return "invalid"

    def entity_view(self, entity_id, *, at=None, allow_unknown_association=False):
        """Three typed identity joins only (entity->instrument->listing->market).

        Known-invalid links are always excluded from both known and candidate
        paths.  Unknown links are candidates, never determined history.
        """
        entity = self._entity_profile(entity_id, at_date=at)
        if entity is None:
            return {"status": "not_found", "entity_id": entity_id, "snapshot_id": self.snapshot_id}
        instruments, instrument_candidates = [], []
        listings, listing_candidates = [], []
        markets, market_candidates = [], []
        diagnostics = []
        for record in self.relations:
            if record.row.get("relation_type") != "issued_by":
                continue
            if (record.row.get("object") or {}).get("id") != entity_id:
                continue
            effective = self._relation_validity(record, at)
            instrument_id = (record.row.get("subject") or {}).get("id")
            bucket = self._assoc_bucket(effective)
            if bucket == "known":
                instruments.append(instrument_id)
            elif bucket == "candidate" and allow_unknown_association:
                instrument_candidates.append(instrument_id)
                diagnostics.append({"relation_id": record.row["business_key"],
                                    "instrument_id": instrument_id,
                                    "association_validity": "unknown",
                                    "reason": effective.get("reason") or "EFFECTIVE_PERIOD_UNKNOWN"})
            else:
                diagnostics.append({"relation_id": record.row["business_key"],
                                    "instrument_id": instrument_id,
                                    "association_validity": "invalid" if bucket == "invalid" else "unknown",
                                    "reason": effective.get("reason") or
                                              ("NOT_EFFECTIVE_AT_DATE" if bucket == "invalid" else "EFFECTIVE_PERIOD_UNKNOWN")})
        instruments = list(dict.fromkeys(instruments))
        instrument_candidates = list(dict.fromkeys(instrument_candidates))
        known_instruments = set(instruments)
        candidate_instruments = set(instrument_candidates) - known_instruments

        listing_known, listing_candidate = set(), set()
        for record in self.relations:
            if record.row.get("relation_type") != "listing_of":
                continue
            instrument_id = (record.row.get("object") or {}).get("id")
            if instrument_id not in known_instruments | candidate_instruments:
                continue
            effective = self._relation_validity(record, at)
            listing_id = (record.row.get("subject") or {}).get("id")
            bucket = self._assoc_bucket(effective)
            if bucket == "invalid":
                diagnostics.append({"relation_id": record.row["business_key"],
                                    "listing_id": listing_id,
                                    "association_validity": "invalid",
                                    "reason": effective.get("reason") or "NOT_EFFECTIVE_AT_DATE"})
            elif bucket == "known" and instrument_id in known_instruments:
                listing_known.add(listing_id)
            elif allow_unknown_association:
                listing_candidate.add(listing_id)
                diagnostics.append({"relation_id": record.row["business_key"],
                                    "listing_id": listing_id,
                                    "association_validity": "unknown",
                                    "upstream_instrument_candidate": instrument_id in candidate_instruments,
                                    "reason": (effective.get("reason") or "EFFECTIVE_PERIOD_UNKNOWN")
                                              if instrument_id in known_instruments else "UPSTREAM_INSTRUMENT_UNKNOWN"})
            else:
                diagnostics.append({"relation_id": record.row["business_key"],
                                    "listing_id": listing_id,
                                    "association_validity": "invalid" if bucket == "invalid" else "unknown",
                                    "reason": effective.get("reason") or "NOT_EFFECTIVE_AT_DATE"})
        listings = sorted(listing_known)
        listing_candidates = sorted(listing_candidate - listing_known)
        known_listings = set(listings)
        candidate_listings = set(listing_candidates)

        market_known, market_candidate = set(), set()
        for record in self.relations:
            if record.row.get("relation_type") != "listed_on":
                continue
            listing_id = (record.row.get("subject") or {}).get("id")
            if listing_id not in known_listings | candidate_listings:
                continue
            effective = self._relation_validity(record, at)
            market_id = (record.row.get("object") or {}).get("id")
            bucket = self._assoc_bucket(effective)
            if bucket == "invalid":
                diagnostics.append({"relation_id": record.row["business_key"],
                                    "market_id": market_id,
                                    "association_validity": "invalid",
                                    "reason": effective.get("reason") or "NOT_EFFECTIVE_AT_DATE"})
            elif bucket == "known" and listing_id in known_listings:
                market_known.add(market_id)
            elif allow_unknown_association:
                market_candidate.add(market_id)
                diagnostics.append({"relation_id": record.row["business_key"],
                                    "market_id": market_id,
                                    "association_validity": "unknown",
                                    "upstream_listing_candidate": listing_id in candidate_listings,
                                    "reason": (effective.get("reason") or "EFFECTIVE_PERIOD_UNKNOWN")
                                              if listing_id in known_listings else "UPSTREAM_LISTING_UNKNOWN"})
            else:
                diagnostics.append({"relation_id": record.row["business_key"],
                                    "market_id": market_id,
                                    "association_validity": "invalid" if bucket == "invalid" else "unknown",
                                    "reason": effective.get("reason") or "NOT_EFFECTIVE_AT_DATE"})
        markets = sorted(market_known)
        market_candidates = sorted(market_candidate - market_known)
        has_unknown = bool(instrument_candidates or listing_candidates or market_candidates
                           or any(d.get("association_validity") == "unknown" for d in diagnostics))
        has_invalid = any(d.get("association_validity") == "invalid" for d in diagnostics)
        return {
            "status": "ok", "entity_id": entity_id,
            "entity": {"id": entity_id, "display_name": entity.value("display_name"),
                       "legal_name": entity.value("legal_name"), "org_id": entity.value("org_id")},
            "instruments": [{"id": i, "display_name": self._display(self.instruments, i, "display_name")}
                            for i in instruments],
            "instrument_candidates": [{"id": i, "display_name": self._display(self.instruments, i, "display_name")}
                                      for i in instrument_candidates],
            "listings": [{"id": l, "code": self._display(self.listings, l, "code"),
                          "market_id": self._display(self.listings, l, "market_id")}
                         for l in listings],
            "listing_candidates": [{"id": l, "code": self._display(self.listings, l, "code"),
                                    "market_id": self._display(self.listings, l, "market_id")}
                                   for l in listing_candidates],
            "markets": [{"id": m, "code": self._display(self.markets, m, "code")}
                        for m in markets],
            "market_candidates": [{"id": m, "code": self._display(self.markets, m, "code")}
                                  for m in market_candidates],
            "diagnostics": diagnostics,
            "has_invalid_associations": has_invalid,
            "relation_scope": "entity_instrument_listing_market",
            "relation_traversal": "limited_p2_identity_join; full traversal P4",
            "association_basis": ("observed_identity_with_unknown_history" if has_unknown
                                  else "known_effective_relations"),
            "snapshot_id": self.snapshot_id,
        }

    def company_calendar(self, entity_id, *, start=None, end=None, at=None, mode="strict"):
        """Company calendar through entity->instrument->listing->market.

        ``strict`` uses only known-effective associations.  ``candidates``
        includes unknown associations but labels every result as candidate;
        known-invalid links are excluded in both modes.
        """
        if mode not in {"strict", "candidates"}:
            raise ValueError("CALENDAR_ASSOCIATION_MODE_UNSUPPORTED")
        view = self.entity_view(entity_id, at=at, allow_unknown_association=(mode == "candidates"))
        if view.get("status") != "ok":
            return {"status": "not_found", "entity_id": entity_id, "snapshot_id": self.snapshot_id}
        known_markets = view["markets"]
        candidate_markets = view["market_candidates"] if mode == "candidates" else []
        if not known_markets and not candidate_markets:
            invalid = view.get("has_invalid_associations")
            return {"status": "not_eligible" if invalid else "indeterminate", "entity_id": entity_id,
                    "start": start, "end": end, "calendars": [],
                    "markets": [], "market_candidates": [],
                    "reason": "ASSOCIATIONS_INVALID_OR_OUTSIDE_PERIOD" if invalid
                              else "ASSOCIATION_UNKNOWN",
                    "identity_association": view["association_basis"],
                    "diagnostics": view["diagnostics"], "snapshot_id": self.snapshot_id}
        calendars = []
        for market, status in [(m, "known") for m in known_markets] + [
                (m, "candidate") for m in candidate_markets]:
            rows = [r for r in self.calendar if r.value("market_code") == market.get("code")]
            dates = [r.value("session_date") for r in rows
                     if (not start or r.value("session_date") >= start)
                     and (not end or r.value("session_date") <= end)]
            calendars.append({"market_id": market["id"], "market_code": market.get("code"),
                              "calendar_product_id": rows[0].product_id if rows else None,
                              "dates": sorted(set(d for d in dates if d)),
                              "count": len(set(d for d in dates if d)),
                              "calendar_status": ("available" if status == "known" else
                                                  "candidate_indeterminate") if rows else "unknown",
                              "association_status": status,
                              "warnings": ([] if rows else ["NO_CALENDAR_FOR_MARKET"]) +
                                          ([] if status == "known" else ["IDENTITY_ASSOCIATION_UNKNOWN"]),
                              "claim": "trading_dates_only_no_session_times"})
        return {"status": "ok", "entity_id": entity_id, "start": start, "end": end,
                "mode": mode, "calendars": calendars,
                "markets": known_markets, "market_candidates": candidate_markets,
                "identity_association": view["association_basis"],
                "candidate_only": mode == "candidates" and bool(candidate_markets),
                "diagnostics": view["diagnostics"], "snapshot_id": self.snapshot_id}

    def unit_binding(self, metric_code):
        binding = next((r for r in self.bindings if r.value("metric_code") == metric_code), None)
        if binding is None:
            return {"status": "not_found", "metric_code": metric_code, "snapshot_id": self.snapshot_id}
        code = binding.value("unit_code")
        unit = next((r for r in self.units if r.value("unit_code") == code), None)
        product = self.products.get(binding.product_id) or {}
        dependencies = copy.deepcopy(product.get("contracts", {}).get("read", {}).get("dependencies", []))
        unit_products = {r.product_id for r in self.units}
        dependency_verified = any(dep.get("product_id") in unit_products
                                  and dep.get("role") == "unit_definitions" and dep.get("required") is True
                                  for dep in dependencies)
        return {
            "status": "resolved" if (code is None or unit is not None) else "indeterminate",
            "metric_code": metric_code, "unit_code": code,
            "unit_status": binding.value("unit_status"),
            "unit": ({"unit_code": unit.value("unit_code"), "dimension": unit.value("dimension"),
                      "display_name": unit.value("display_name"), "base_unit": unit.value("base_unit"),
                      "scale_factor": unit.value("scale_factor")} if unit else None),
            "period_basis": binding.value("period_basis"), "null_rule": binding.value("null_rule"),
            "adjustment_basis": binding.value("adjustment_basis"),
            "sample_value": binding.value("sample_value"), "sample_unit": binding.value("sample_unit"),
            "sample_basis": binding.value("sample_basis"), "conversion_rule": binding.value("conversion_rule"),
            "scope_note": binding.value("scope_note"),
            "read_dependencies": dependencies, "dependency_verified": dependency_verified,
            "snapshot_id": self.snapshot_id,
            "note": "unknown unit stays unknown; no code is inferred from reconciliation",
        }

    def counts(self):
        return {"entities": len(self.entities), "instruments": len(self.instruments),
                "listings": len(self.listings), "markets": len(self.markets),
                "regions": len(self.regions), "physical_objects": len(self.physical_objects),
                "name_claims": len(self.name_claims), "relations": len(self.relations),
                "calendar_days": len(self.calendar), "units": len(self.units),
                "metric_bindings": len(self.bindings)}


def capabilities():
    return {
        "format_version": FOUNDATION_VERSION,
        "service_version": SERVICE_VERSION,
        "supported": {
            "identity_registration_via_generic_submit": ["entity", "instrument", "listing", "market",
                                                          "region", "physical_object"],
            "fixed_snapshot_readback": True,
            "code_market_date_resolution": "candidate_list_with_explicit_validity",
            "name_resolution": "observed_claims_only; unknown effective dates retained",
            "limited_identity_join": "entity_instrument_listing_market",
            "relation_read": "direction/effective/public/set_completeness",
            "membership_negative_inference": "only when set explicitly complete",
            "calendar_read": "trading_dates_only",
            "unit_catalogue_read_dependency": True,
        },
        "unsupported": {
            "relationship_graph_traversal": "P4 (at most P2 typed identity joins here)",
            "global_identity_table": "not constructed; evidence-scoped entries only",
            "legal_rename_effective_dates_without_evidence": "unknown, never backfilled",
            "historical_code_validity_outside_proven_range": "indeterminate candidates",
            "trade_session_times_or_auction_rules": "not claimed",
            "cross_dataset_dependencies": "generic service still rejects them",
            "automatic_unit_inference": "unknown units remain unknown",
        },
        "production_publishable": False,
    }
