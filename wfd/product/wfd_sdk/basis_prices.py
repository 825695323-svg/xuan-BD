#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Basis-price reference resolution for adjustment anchors (P2-R2).

P2-R1 answered *which* anchor version governs a write.  The anchor's
``basis_price_ref`` was still only checked for **shape** (``kind`` /
``namespace`` / ``id`` / ``version`` / ``digest`` / ``field_code``), so an
anchor could name a product that does not exist, a field that was never
declared, an unpinned definition, a snapshot that was never taken, or a price
whose measurement is a different subject, unit or currency from the one the
anchor declares.

This module upgrades the reference from "shape-valid" to "really resolvable".
It stays a pure resolver: no writes, no cache of authoritative state, one code
per failing step, never one merged code::

    referenced product not registered in this store    ADJUSTMENT_BASIS_PRODUCT_UNREGISTERED
    field not declared by the product definition       ADJUSTMENT_BASIS_FIELD_UNDEFINED
    definition version / digest not pinned             ADJUSTMENT_BASIS_VERSION_UNPINNED
    pinned snapshot missing or does not hold it        ADJUSTMENT_BASIS_SNAPSHOT_MISSING
    unit / currency / subject disagree with the anchor  ADJUSTMENT_BASIS_UNIT_MISMATCH
                                                        ADJUSTMENT_BASIS_CURRENCY_MISMATCH
                                                        ADJUSTMENT_BASIS_SUBJECT_MISMATCH
    no basis record at the anchor's basis instant      ADJUSTMENT_BASIS_TIME_MISMATCH
    anchor and record declare different timezones      ADJUSTMENT_BASIS_TIMEZONE_CONFLICT
    several basis records fit the window                ADJUSTMENT_BASIS_AMBIGUOUS
    day precision, but no unique record of that day     ADJUSTMENT_BASIS_PRECISION_MISMATCH
    day anchor vs a coarser (month/quarter/year) record ADJUSTMENT_BASIS_PRECISION_UNSUPPORTED
    the unit definition names no currency               ADJUSTMENT_BASIS_CURRENCY_UNKNOWN
    basis record not yet knowable at the replay point   ADJUSTMENT_BASIS_HISTORY_INELIGIBLE
    definition or snapshot bytes changed since the pin  ADJUSTMENT_BASIS_REVISED_SINCE_REGISTRATION
    reference itself is not an object                   ADJUSTMENT_BASIS_REFERENCE_INVALID

A ``rule`` basis (``{"rule": "..."}``) names no catalog object at all; only its
shape is checked and the report says so (``state="rule"``, ``verified=False``).
That is the one form that cannot be resolved against a store, and it is never
silently treated as resolved.  A *formal write* (P2-R3) therefore refuses a
``rule`` basis outright (``ADJUSTMENT_BASIS_RULE_UNVERIFIED``): a shape check is
not a verified price.  Registration and read-only inspection keep accepting it.

Two measurement questions are answered from authority, never from a spelling:

* **currency** - from the formal unit definition only (the pinned product's
  ``contracts.semantic.unit_definitions`` first, then the trusted unit registry
  of the machine configuration).  A unit code that merely *looks* like a
  currency (``cny_per_share``) proves nothing; when no authority names a
  currency the reference is refused (``ADJUSTMENT_BASIS_CURRENCY_UNKNOWN``).
* **day** - a bare business date is a *local* day, so the day is interpreted in
  a declared zone: the anchor's ``basis_price_ref.timezone`` when it declares
  one, otherwise the record's own ``observation_time.source_timezone``.  When
  neither declares a zone the day cannot be located and nothing is matched.
  A zone declared by *both* is not a priority question: two declarations of the
  same fact that disagree are refused (``ADJUSTMENT_BASIS_TIMEZONE_CONFLICT``),
  never resolved by "anchor wins".  One side only is single-sided evidence and
  stays authoritative for that side.

Two precision boundaries are likewise explicit rather than silently absorbed:

* A day-precision anchor is matched by the **local day the record starts in**, so
  a record that spills over a local midnight is never counted as the next day's
  price, and ``tolerance_seconds`` is *not* applied to it (tolerance widens
  instant matching only; a day basis is compared as a calendar day).
* A day-precision anchor cannot be filled by a *coarser* record (month, quarter,
  year, or an unspecific interval spanning the day): using it would silently
  narrow a month to its first day.  That combination is refused
  (``ADJUSTMENT_BASIS_PRECISION_UNSUPPORTED``) instead of degraded.

Resolution is pinned by *identity*, not by "current head": the pinned snapshot
and the pinned definition version are read back as they were, so a later price
revision never silently re-interprets an old anchor.  When the pinned bytes no
longer match the snapshot's own declared digest, the resolver reports
``ADJUSTMENT_BASIS_REVISED_SINCE_REGISTRATION`` instead of returning a quietly
different price.
"""
from __future__ import annotations

import copy
import json
import re
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping
from zoneinfo import ZoneInfo

FORMAT_VERSION = "wfd.basis-price-resolution/1.1"
PRODUCT_RELATIVE = "catalog/product_service/products"
SNAPSHOT_RELATIVE = "catalog/snapshots/{snapshot_id}.json"
SNAPSHOT_ID = re.compile(r"^s_[0-9a-f]{8,64}$")
SEQUENCE = re.compile(r"^(?:version_|definition_)?(\d{1,9})$", re.IGNORECASE)

PRODUCT_KINDS = {"product"}
PRICE_DIMENSION = "money_per_share"
CURRENCY_CODES = ("cny", "usd", "hkd", "eur", "jpy", "gbp", "chf", "aud", "cad")
INSTRUMENT_MARKERS = ("instrument", "secur", "symbol", "ticker")
TIME_PRECISIONS = {"second", "minute", "hour", "day", "month", "year"}
#: Precisions finer than one business day.  A day-precision anchor may accept
#: exactly one of them as the day's price; several are not a day price at all.
SUB_DAY_PRECISIONS = {"second", "minute", "hour"}
#: Precisions coarser than one business day.  A day-precision anchor may never be
#: satisfied by one of them: the anchor asks for a day price and the record only
#: holds a month/quarter/year (or an unspecific interval), so taking it would
#: silently narrow the coarser grain to the day the interval happens to start on.
COARSER_THAN_DAY = {"quarter", "month", "year", "interval"}
#: Record precisions a day-precision anchor is allowed to be matched against.
DAY_PRECISIONS = {"day"} | SUB_DAY_PRECISIONS

CODE_REFERENCE_INVALID = "ADJUSTMENT_BASIS_REFERENCE_INVALID"
CODE_PRODUCT = "ADJUSTMENT_BASIS_PRODUCT_UNREGISTERED"
CODE_FIELD = "ADJUSTMENT_BASIS_FIELD_UNDEFINED"
CODE_VERSION = "ADJUSTMENT_BASIS_VERSION_UNPINNED"
CODE_SNAPSHOT = "ADJUSTMENT_BASIS_SNAPSHOT_MISSING"
CODE_UNIT = "ADJUSTMENT_BASIS_UNIT_MISMATCH"
CODE_SUBJECT = "ADJUSTMENT_BASIS_SUBJECT_MISMATCH"
CODE_CURRENCY = "ADJUSTMENT_BASIS_CURRENCY_MISMATCH"
CODE_CURRENCY_UNKNOWN = "ADJUSTMENT_BASIS_CURRENCY_UNKNOWN"
CODE_TIME = "ADJUSTMENT_BASIS_TIME_MISMATCH"
CODE_TIMEZONE_CONFLICT = "ADJUSTMENT_BASIS_TIMEZONE_CONFLICT"
CODE_AMBIGUOUS = "ADJUSTMENT_BASIS_AMBIGUOUS"
CODE_PRECISION = "ADJUSTMENT_BASIS_PRECISION_MISMATCH"
CODE_PRECISION_UNSUPPORTED = "ADJUSTMENT_BASIS_PRECISION_UNSUPPORTED"
CODE_HISTORY = "ADJUSTMENT_BASIS_HISTORY_INELIGIBLE"
CODE_REVISED = "ADJUSTMENT_BASIS_REVISED_SINCE_REGISTRATION"
CODE_RULE_UNVERIFIED = "ADJUSTMENT_BASIS_RULE_UNVERIFIED"

RESOLUTION_CODES = (
    CODE_REFERENCE_INVALID, CODE_PRODUCT, CODE_FIELD, CODE_VERSION, CODE_SNAPSHOT,
    CODE_UNIT, CODE_SUBJECT, CODE_CURRENCY, CODE_CURRENCY_UNKNOWN, CODE_TIME,
    CODE_TIMEZONE_CONFLICT, CODE_AMBIGUOUS, CODE_PRECISION, CODE_PRECISION_UNSUPPORTED,
    CODE_HISTORY, CODE_REVISED, CODE_RULE_UNVERIFIED,
)

CHECK_NAMES = ("product", "field", "version", "snapshot", "unit", "currency",
               "subject", "time", "history", "immutability")


# ------------------------------------------------------------------ primitives
def _instant(value: Any, field: str) -> datetime:
    """Business date or explicit instant -> aware UTC time (bare date = 00:00Z)."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(CODE_REFERENCE_INVALID + ":field " + field
                         + " must be a non-empty string")
    text = value.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    candidate = text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        raise ValueError(CODE_REFERENCE_INVALID + ":field " + field
                         + " is not an ISO date/instant: " + text) from None
    if parsed.tzinfo is None:
        raise ValueError(CODE_REFERENCE_INVALID + ":field " + field
                         + " must carry an explicit UTC offset: " + text)
    return parsed.astimezone(timezone.utc)


def basis_precision(basis_at: Any, declared: Any = None) -> str:
    """``day`` for a bare business date, otherwise the declared/derived instant precision."""
    if isinstance(basis_at, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", basis_at.strip()):
        return "day"
    if isinstance(declared, str) and declared in TIME_PRECISIONS:
        return declared
    return "second"


def currency_of_unit(unit_code: Any) -> str | None:
    """Deprecated: a unit *code* is a spelling, not a currency authority.

    Kept only so an outside caller does not fail with ``ImportError``; it never
    answers a currency question any more and always returns ``None``.  Use
    :func:`unit_currency` with the formal unit definitions instead.
    """
    return None


_CURRENCY_TOKEN = re.compile(r"^[A-Za-z]{3}$")


def _currency_in(entry: Any) -> str | None:
    """Currency named by one unit-definition entry (``currency`` / ``currency_code``)."""
    if not isinstance(entry, Mapping):
        return None
    for holder in (entry, entry.get("definition")):
        if not isinstance(holder, Mapping):
            continue
        for key in ("currency", "currency_code"):
            value = holder.get(key)
            if isinstance(value, str) and _CURRENCY_TOKEN.fullmatch(value.strip()):
                return value.strip().lower()
    return None


def unit_currency(units: Mapping[str, Any] | None,
                  unit_code: Any) -> tuple[str | None, str | None]:
    """Currency and its authority for one unit code, from the unit definitions.

    ``units`` is the trusted unit registry of the machine configuration; the
    store-side ``contracts.semantic.unit_definitions`` is passed in separately by
    :func:`resolve` because it needs the pinned product.  No prefix is ever
    guessed: ``cny_per_share`` says nothing about the currency of the numbers.
    """
    if not isinstance(unit_code, str) or not unit_code:
        return None, None
    return _currency_in((units or {}).get(unit_code)), "unit_registry"


def unit_dimension(units: Mapping[str, Any] | None, unit_code: str) -> str | None:
    entry = (units or {}).get(unit_code)
    if isinstance(entry, dict):
        for holder in (entry, entry.get("definition")):
            if isinstance(holder, dict) and isinstance(holder.get("dimension"), str):
                return holder["dimension"]
    return None


def store_unit_definition(pinned: Mapping[str, Any] | None, unit_code: Any) -> Any:
    """The pinned definition's own ``contracts.semantic.unit_definitions`` entry."""
    if not isinstance(pinned, Mapping) or not isinstance(unit_code, str):
        return None
    semantic = ((pinned.get("contracts") or {}).get("semantic")
                if isinstance(pinned.get("contracts"), Mapping) else None)
    if not isinstance(semantic, Mapping):
        return None
    definitions = semantic.get("unit_definitions")
    if not isinstance(definitions, Mapping):
        return None
    return definitions.get(unit_code)


def zone_of(name: Any) -> Any:
    """``tzinfo`` for a declared zone name, or ``None`` when it names none."""
    if not isinstance(name, str) or not name.strip():
        return None
    try:
        return ZoneInfo(name.strip())
    except (KeyError, ValueError, OSError):
        return None


def local_day(moment: datetime, zone: Any) -> date:
    """Calendar day of an instant in one zone (UTC when no zone is declared)."""
    return moment.astimezone(zone or timezone.utc).date()


def _field_map(definition: Mapping[str, Any]) -> dict:
    out = {}
    for field in (definition.get("declaration") or {}).get("field_definitions") or []:
        if isinstance(field, dict) and isinstance(field.get("field_code"), str):
            out[field["field_code"]] = field
    return out


def _instrument_field(fields: Mapping[str, Any]) -> str | None:
    for code in sorted(fields):
        low = code.lower()
        if any(marker in low for marker in INSTRUMENT_MARKERS):
            return code
    return None


def _cell(row: Mapping[str, Any], field_code: str) -> Any:
    values = (row.get("row") or row).get("values") if isinstance(row, Mapping) else None
    if isinstance(values, dict):
        cell = values.get(field_code)
    else:
        cell = None
    if isinstance(cell, dict):
        return cell.get("value"), cell.get("value_state")
    return cell, None


def _interval(row: Mapping[str, Any]) -> tuple[datetime | None, datetime | None, str | None,
                                               Any, Any]:
    """Observation interval of one stored row (half open, UTC) and its declared zone."""
    observed = ((row.get("row") or row) if isinstance(row, Mapping) else {}).get("observation_time")
    if not isinstance(observed, dict):
        return None, None, None, None, None
    try:
        start = _instant(observed.get("earliest_utc"), "observation_time.earliest_utc")
    except ValueError:
        start = None
    try:
        end = _instant(observed.get("latest_exclusive_utc"), "observation_time.latest_exclusive_utc")
    except ValueError:
        end = None
    precision = observed.get("precision") if isinstance(observed.get("precision"), str) else None
    declared_zone = observed.get("source_timezone")
    return start, end, precision, zone_of(declared_zone), declared_zone


# --------------------------------------------------------------------- catalog
class StoreCatalog:
    """Read-only catalog view: definitions, snapshot files and pinned rows.

    ``reader`` is anything exposing ``read(product_id, *, snapshot_id)`` (the
    data-only service).  Paths are resolved against ``root``, the store whose
    catalog decides the reference -- for a volume write that is the *target*
    volume, never the disposable preparation store.
    """

    def __init__(self, root: str | Path, reader: Any):
        self.root = Path(root)
        self._reader = reader
        self._definitions: dict[str, list[dict]] = {}
        self._snapshots: dict[str, dict | None] = {}
        self._rows: dict[tuple[str, str], list[dict]] = {}

    # ---------------------------------------------------------- definitions
    def definitions(self, product_id: str) -> list[dict]:
        if product_id in self._definitions:
            return self._definitions[product_id]
        out: list[dict] = []
        base = self.root / PRODUCT_RELATIVE / product_id
        if isinstance(product_id, str) and base.is_dir() and not base.is_symlink():
            for path in sorted(base.glob("definition_*.json")):
                if path.name.startswith("._") or path.is_symlink():
                    continue
                try:
                    record = json.loads(path.read_text("utf-8"))
                except (OSError, ValueError):
                    continue
                if isinstance(record, dict):
                    out.append(record)
        out.sort(key=lambda item: int(item.get("definition_sequence") or 0))
        self._definitions[product_id] = out
        return out

    def latest_definition(self, product_id: str) -> dict | None:
        records = self.definitions(product_id)
        return records[-1] if records else None

    def definition(self, product_id: str, version: Any) -> dict | None:
        records = self.definitions(product_id)
        if not records:
            return None
        text = str(version).strip()
        match = SEQUENCE.fullmatch(text)
        if match:
            wanted = int(match.group(1))
            for record in records:
                if int(record.get("definition_sequence") or 0) == wanted:
                    return record
            return None
        for record in records:
            if str((record.get("definition_ref") or {}).get("version")) == text:
                return record
        return None

    # ------------------------------------------------------------ snapshots
    def snapshot(self, snapshot_id: str) -> dict | None:
        if snapshot_id in self._snapshots:
            return self._snapshots[snapshot_id]
        record = None
        if isinstance(snapshot_id, str) and SNAPSHOT_ID.fullmatch(snapshot_id):
            path = self.root / SNAPSHOT_RELATIVE.format(snapshot_id=snapshot_id)
            if path.is_file() and not path.is_symlink():
                try:
                    candidate = json.loads(path.read_text("utf-8"))
                except (OSError, ValueError):
                    candidate = None
                if isinstance(candidate, dict) and candidate.get("snapshot_id") == snapshot_id:
                    record = candidate
        self._snapshots[snapshot_id] = record
        return record

    # ----------------------------------------------------------------- rows
    def rows(self, product_id: str, snapshot_id: str) -> list[dict]:
        key = (product_id, snapshot_id)
        if key not in self._rows:
            result = self._reader.read(product_id, snapshot_id=snapshot_id)
            self._rows[key] = list(result.get("rows") or [])
        return self._rows[key]


# ---------------------------------------------------------------------- report
def _report(ref: Any) -> dict:
    return {
        "format_version": FORMAT_VERSION,
        "state": "rejected",
        "verified": False,
        "code": None,
        "detail": None,
        "ref": copy.deepcopy(ref),
        "checks": {name: None for name in CHECK_NAMES},
        "basis": {},
        "notes": [],
    }


def _reject(report: dict, code: str, detail: Any) -> dict:
    report["state"] = "rejected"
    report["code"] = code
    report["detail"] = (detail if isinstance(detail, str)
                        else json.dumps(detail, ensure_ascii=False, sort_keys=True))
    return report


def _row_span(start: datetime, end: datetime) -> int:
    return int(max(timedelta(0), end - start).total_seconds())


# --------------------------------------------------------------------- resolve
def resolve(ref: Any, *, basis_at: Any, catalog: StoreCatalog,
            units: Mapping[str, Any] | None = None, instrument_scope: Any = None,
            corporate_action_cutoff: Any = None, replay_point: Any = None,
            dataset_id: str | None = None, require_verified: bool = False) -> dict:
    """Resolve one ``basis_price_ref``; never raises, one code per failing step.

    ``replay_point`` is the instant the submitted content replays as of.  When
    it is ``None`` (registration, no submission yet) the historical-eligibility
    step is reported ``not_assessed`` instead of being assumed to pass.

    ``require_verified`` is set by a *formal write*: a basis that only passed a
    shape check (``state="rule"``) is then refused
    (``ADJUSTMENT_BASIS_RULE_UNVERIFIED``) instead of being accepted as an
    anchor price.  Registration and read-only inspection leave it ``False``, so
    a rule basis stays storable and keeps reporting its own state.
    """
    report = _report(ref)
    if not isinstance(ref, dict) or not ref:
        return _reject(report, CODE_REFERENCE_INVALID, "basis_price_ref is not an object")
    if "rule" in ref:
        report["state"] = "rule"
        report["checks"] = {name: "rule" for name in CHECK_NAMES}
        report["basis"] = {"rule": ref.get("rule")}
        report["notes"].append("a rule basis names no catalog object; only its shape is "
                              "checked, it is never reported as resolved")
        if require_verified:
            return _reject(report, CODE_RULE_UNVERIFIED, {
                "rule": ref.get("rule"),
                "reason": "a rule basis names no registered price record, so no price can be "
                          "verified against it; a formal adjusted write needs a resolvable "
                          "basis_price_ref"})
        return report

    # 1 object identity: the referenced product and field live in this catalog.
    kind = ref.get("kind")
    namespace = ref.get("namespace")
    product_id = ref.get("id")
    field_code = ref.get("field_code")
    if kind not in PRODUCT_KINDS:
        return _reject(report, CODE_PRODUCT, {
            "kind": kind, "supported_kinds": sorted(PRODUCT_KINDS),
            "reason": "a basis price reference must name a product"})
    latest = catalog.latest_definition(product_id) if isinstance(product_id, str) else None
    if latest is None:
        return _reject(report, CODE_PRODUCT, {
            "product_id": product_id,
            "reason": "no registered product definition for this id in this store"})
    if namespace != latest.get("dataset_id"):
        return _reject(report, CODE_PRODUCT, {
            "product_id": product_id, "namespace": namespace,
            "product_dataset_id": latest.get("dataset_id"),
            "reason": "the referenced namespace is not the dataset of the referenced product"})
    report["checks"]["product"] = True
    report["basis"].update({"product_id": product_id,
                            "dataset_id": latest.get("dataset_id"),
                            "product_family_id": latest.get("product_family_id"),
                            "product_subject": copy.deepcopy(latest.get("subject"))})
    if not isinstance(field_code, str) or not field_code:
        return _reject(report, CODE_FIELD, {
            "reason": "basis_price_ref.field_code is required to name the basis price field"})
    latest_fields = _field_map(latest)
    if field_code not in latest_fields:
        return _reject(report, CODE_FIELD, {
            "product_id": product_id, "field_code": field_code,
            "available_fields": sorted(latest_fields)})
    report["checks"]["field"] = True

    # 2 version: the basis price must pin a fixed definition version + digest.
    version = ref.get("version")
    digest = ref.get("digest")
    if version is None or digest is None:
        return _reject(report, CODE_VERSION, {
            "version": version, "digest": digest,
            "reason": "a basis price must pin both a definition version and its digest"})
    pinned = catalog.definition(product_id, version)
    if pinned is None:
        return _reject(report, CODE_VERSION, {
            "product_id": product_id, "version": version,
            "registered_sequences": [item.get("definition_sequence")
                                     for item in catalog.definitions(product_id)],
            "reason": "the pinned definition version is not registered"})
    pinned_ref = pinned.get("definition_ref") or {}
    pinned_digest = pinned_ref.get("digest")
    if digest != pinned_digest:
        return _reject(report, CODE_REVISED, {
            "product_id": product_id, "version": version,
            "requested_digest": digest, "registered_digest": pinned_digest,
            "reason": "the pinned definition no longer matches the pinned digest; "
                      "the basis would otherwise be silently re-interpreted"})
    pinned_fields = _field_map(pinned)
    if field_code not in pinned_fields:
        return _reject(report, CODE_FIELD, {
            "product_id": product_id, "version": version, "field_code": field_code,
            "pinned_fields": sorted(pinned_fields),
            "reason": "the pinned version does not declare the referenced field"})
    report["checks"]["version"] = True
    report["checks"]["immutability"] = True
    report["basis"].update({"definition_sequence": pinned.get("definition_sequence"),
                            "definition_version": pinned_ref.get("version"),
                            "definition_digest": pinned_digest})

    # 3 snapshot: the pinned version must be readable from a fixed snapshot.
    snapshot_id = ref.get("snapshot_id")
    if not isinstance(snapshot_id, str) or not snapshot_id:
        return _reject(report, CODE_SNAPSHOT, {
            "reason": "a basis price must pin the snapshot it can be read back from"})
    snapshot = catalog.snapshot(snapshot_id)
    if snapshot is None:
        return _reject(report, CODE_SNAPSHOT, {
            "snapshot_id": snapshot_id,
            "reason": "the pinned snapshot is missing (or not a readable snapshot of this store)"})
    entries = [entry for entry in snapshot.get("files") or []
               if entry.get("product_id") == product_id]
    if not entries:
        return _reject(report, CODE_SNAPSHOT, {
            "snapshot_id": snapshot_id, "product_id": product_id,
            "reason": "the pinned snapshot holds no file of the referenced product"})
    report["checks"]["snapshot"] = True
    report["basis"]["snapshot_id"] = snapshot_id

    # 4 measurement: unit, then currency, then the subject whose price it is.
    unit = pinned_fields[field_code].get("unit_code")
    declared_unit = ref.get("unit_code")
    if not isinstance(declared_unit, str) or not declared_unit:
        return _reject(report, CODE_UNIT, {
            "actual_unit_code": unit,
            "reason": "basis_price_ref.unit_code is required: the anchor must declare the "
                      "measurement it expects"})
    if declared_unit != unit:
        return _reject(report, CODE_UNIT, {
            "declared_unit_code": declared_unit, "actual_unit_code": unit})
    dimension = unit_dimension(units, unit)
    if dimension != PRICE_DIMENSION:
        return _reject(report, CODE_UNIT, {
            "unit_code": unit, "dimension": dimension,
            "required_dimension": PRICE_DIMENSION,
            "reason": "a basis price must be a per-share money unit"})
    report["checks"]["unit"] = True
    report["basis"]["unit_code"] = unit

    # 4b currency: from the formal unit definition only (P2-R3, item D).
    declared_currency = ref.get("currency")
    store_currency = _currency_in(store_unit_definition(pinned, unit))
    registry_currency, registry_authority = unit_currency(units, unit)
    if store_currency is not None and registry_currency is not None \
            and store_currency != registry_currency:
        return _reject(report, CODE_CURRENCY, {
            "unit_code": unit, "declared_currency": declared_currency,
            "store_currency": store_currency, "registry_currency": registry_currency,
            "reason": "the store definition and the trusted unit registry disagree about the "
                      "currency of this unit; neither can be preferred"})
    currency = store_currency if store_currency is not None else registry_currency
    if currency is None:
        return _reject(report, CODE_CURRENCY_UNKNOWN, {
            "unit_code": unit, "declared_currency": declared_currency,
            "dimension": dimension, "store_definition": store_unit_definition(pinned, unit),
            "registry_entry": (units or {}).get(unit),
            "reason": "no formal unit definition names the currency of this unit; a unit code "
                      "spelling such as cny_per_share is not a currency authority, so the "
                      "basis price cannot be interpreted as money"})
    if declared_currency != currency:
        return _reject(report, CODE_CURRENCY, {
            "declared_currency": declared_currency, "actual_currency": currency,
            "unit_code": unit,
            "currency_source": ("store_definition" if store_currency is not None
                                else registry_authority)})
    report["checks"]["currency"] = True
    report["basis"]["currency"] = currency
    report["basis"]["currency_source"] = ("store_definition" if store_currency is not None
                                          else registry_authority)

    try:
        rows = catalog.rows(product_id, snapshot_id)
    except ValueError as exc:
        text = str(exc)
        code = CODE_REVISED if "CHECKSUM_MISMATCH" in text else CODE_SNAPSHOT
        return _reject(report, code, {
            "snapshot_id": snapshot_id, "product_id": product_id,
            "reason": "the pinned snapshot could not be read back unchanged", "error": text})
    except OSError as exc:
        return _reject(report, CODE_SNAPSHOT, {
            "snapshot_id": snapshot_id, "product_id": product_id,
            "reason": "the pinned snapshot could not be read", "error": str(exc)})

    instrument_id = ref.get("instrument_id")
    if not isinstance(instrument_id, str) or not instrument_id:
        return _reject(report, CODE_SUBJECT, {
            "reason": "basis_price_ref.instrument_id is required: a basis price is the price "
                      "of one subject, not of the whole table"})
    scope = instrument_scope if isinstance(instrument_scope, dict) else {}
    if scope.get("kind") == "instruments" and instrument_id not in set(
            scope.get("instrument_ids") or []):
        return _reject(report, CODE_SUBJECT, {
            "instrument_id": instrument_id,
            "anchor_instruments": sorted(scope.get("instrument_ids") or []),
            "reason": "the basis subject is outside the anchor instrument scope"})
    instrument_field = _instrument_field(pinned_fields)
    if instrument_field is None:
        return _reject(report, CODE_SUBJECT, {
            "product_id": product_id, "pinned_fields": sorted(pinned_fields),
            "reason": "the pinned definition declares no instrument column, so the basis "
                      "subject cannot be identified"})
    candidates = [row for row in rows
                  if str(_cell(row, instrument_field)[0]) == instrument_id]
    if not candidates:
        return _reject(report, CODE_SUBJECT, {
            "instrument_id": instrument_id, "instrument_field": instrument_field,
            "snapshot_id": snapshot_id,
            "reason": "the pinned snapshot holds no record of this subject"})
    report["checks"]["subject"] = True
    report["basis"]["instrument_id"] = instrument_id

    # 5 time: the basis record's own interval must contain the anchor's basis_at.
    try:
        moment = _instant(basis_at, "basis_at")
    except ValueError as exc:
        return _reject(report, CODE_TIME, {"basis_at": basis_at, "error": str(exc)})
    precision = basis_precision(basis_at, ref.get("time_precision"))
    tolerance = ref.get("tolerance_seconds")
    tolerance = tolerance if isinstance(tolerance, int) and not isinstance(tolerance, bool) \
        and tolerance >= 0 else 0
    # The anchor may *declare* the zone its business day is read in; otherwise a
    # record's own ``source_timezone`` decides which local day it belongs to.
    declared_zone_name = ref.get("timezone")
    declared_zone = zone_of(declared_zone_name)
    if declared_zone_name is not None and declared_zone is None:
        return _reject(report, CODE_TIME, {
            "basis_at": basis_at, "timezone": declared_zone_name,
            "reason": "basis_price_ref.timezone is not a known timezone"})
    matched = []
    undated = []
    conflicts = []
    unsupported = []
    window = timedelta(seconds=tolerance)
    for row in candidates:
        start, end, row_precision, row_zone, row_zone_name = _interval(row)
        if start is None or end is None:
            continue
        record_key = row.get("record_id") or (row.get("row") or {}).get("business_key")
        # P2-R4: two declarations of the same fact must agree.  The anchor declares
        # the zone its business day is read in; the record declares the zone its own
        # interval is expressed in.  Both declared and different is a conflict, never
        # an "anchor wins" precedence -- no basis price can be confirmed from two
        # contradictory timezone declarations.  One side only stays authoritative.
        if declared_zone is not None and row_zone is not None \
                and declared_zone_name.strip() != str(row_zone_name).strip():
            conflicts.append({"business_key": record_key,
                              "interval": [start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                           end.strftime("%Y-%m-%dT%H:%M:%SZ")],
                              "record_precision": row_precision,
                              "record_timezone": row_zone_name,
                              "anchor_timezone": declared_zone_name})
            continue
        if precision == "day":
            # A bare business date means "this trading day", so the day is a
            # *local* calendar day, never a UTC one: the same UTC interval sits
            # on different business days in Asia/Shanghai and in UTC.
            effective_zone = declared_zone or row_zone
            if effective_zone is None:
                undated.append({"business_key": record_key,
                                "interval": [start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                             end.strftime("%Y-%m-%dT%H:%M:%SZ")],
                                "source_timezone": row_zone_name})
                continue
            basis_day = local_day(moment, effective_zone)
            if row_precision not in DAY_PRECISIONS:
                # P2-R4: never narrow a coarser grain to the day it starts on.
                day_start_local = datetime.combine(basis_day, time(), tzinfo=effective_zone)
                day_start = day_start_local.astimezone(timezone.utc)
                day_end = (day_start_local + timedelta(days=1)).astimezone(timezone.utc)
                if start < day_end and end > day_start:
                    unsupported.append({"business_key": record_key,
                                        "interval": [start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                                     end.strftime("%Y-%m-%dT%H:%M:%SZ")],
                                        "record_precision": row_precision,
                                        "basis_day": basis_day.isoformat(),
                                        "timezone": declared_zone_name or row_zone_name})
                continue
            if local_day(start, effective_zone) != basis_day:
                continue
            matched.append((start, end, row_precision, row,
                            "day", declared_zone_name or row_zone_name))
            continue
        if start - window <= moment < end + window:
            matched.append((start, end, row_precision, row, precision,
                            declared_zone_name or row_zone_name))
    if conflicts:
        return _reject(report, CODE_TIMEZONE_CONFLICT, {
            "basis_at": basis_at, "precision": precision,
            "anchor_timezone": declared_zone_name,
            "record_timezones": sorted({str(item["record_timezone"]) for item in conflicts}),
            "conflicts": conflicts[:8],
            "instrument_id": instrument_id, "snapshot_id": snapshot_id,
            "reason": "the anchor and the basis record both declare a timezone and they "
                      "disagree; a day read in the anchor's zone and an interval expressed "
                      "in the record's zone are different claims, so neither may be "
                      "silently preferred and no basis price is confirmed"})
    if not matched:
        if unsupported:
            return _reject(report, CODE_PRECISION_UNSUPPORTED, {
                "basis_at": basis_at, "precision": precision,
                "timezone": declared_zone_name,
                "candidates": unsupported[:8],
                "reason": "the anchor declares day precision but the business day is only "
                          "covered by coarser-grained records; collapsing a month/quarter/"
                          "year interval into its first day would change the precision, so "
                          "the combination is refused instead of degraded"})
        if undated:
            return _reject(report, CODE_TIME, {
                "basis_at": basis_at, "precision": precision, "timezone": declared_zone_name,
                "candidates": undated[:8],
                "reason": "a day-precision basis needs the zone its business day is read in: "
                          "neither the anchor nor the record declares one"})
        return _reject(report, CODE_TIME, {
            "basis_at": basis_at, "precision": precision, "tolerance_seconds": tolerance,
            "timezone": declared_zone_name,
            "instrument_id": instrument_id, "snapshot_id": snapshot_id,
            "reason": "no basis record covers the anchor basis instant"})
    values = {(_cell(item[3], field_code)[0]) for item in matched}
    widths = {(item[0], item[1]) for item in matched}
    if len(widths) > 1 or len(values) > 1:
        candidates_detail = [{"business_key": (item[3].get("record_id")
                                               or (item[3].get("row") or {}).get("business_key")),
                              "interval": [item[0].strftime("%Y-%m-%dT%H:%M:%SZ"),
                                           item[1].strftime("%Y-%m-%dT%H:%M:%SZ")],
                              "record_precision": item[2],
                              "data_points": _row_span(item[0], item[1]),
                              "value": _cell(item[3], field_code)[0]}
                             for item in matched[:8]]
        if precision == "day" and any(item[2] in SUB_DAY_PRECISIONS for item in matched):
            # A day-precision anchor that can only be filled by *parts* of a day
            # is not the day's price: several finer records on that day cannot be
            # collapsed into one basis value without picking one by hand.
            return _reject(report, CODE_PRECISION, {
                "basis_at": basis_at, "precision": precision,
                "timezone": declared_zone_name,
                "candidates": candidates_detail,
                "reason": "the anchor declares day precision but the business day only holds "
                          "finer-grained records; the day price is not uniquely determined"})
        return _reject(report, CODE_AMBIGUOUS, {
            "basis_at": basis_at, "precision": precision, "tolerance_seconds": tolerance,
            "timezone": declared_zone_name,
            "candidates": candidates_detail,
            "reason": "the anchor basis instant matches more than one basis record with "
                      "different identity or value; the basis is ambiguous"})
    start, end, row_precision, row, effective_precision, effective_zone_name = sorted(
        matched, key=lambda item: (item[0], item[1],
                                   str(item[3].get("record_id")
                                       or (item[3].get("row") or {}).get("business_key"))))[0]
    value, value_state = _cell(row, field_code)
    if value_state != "valid_value" or value is None or value == "":
        return _reject(report, CODE_FIELD, {
            "field_code": field_code, "value_state": value_state, "value": value,
            "basis_at": basis_at,
            "reason": "the basis record carries no valid value for the referenced field"})
    report["checks"]["time"] = True
    report["basis"].update({
        "field_code": field_code,
        "value": value,
        "value_state": value_state,
        "record_id": (row.get("record_id")
                      or (row.get("row") or {}).get("business_key")),
        "record_version": (row.get("record_version")
                           or ((row.get("row") or {}).get("record_ref") or {}).get("revision_id")),
        "observation_start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "observation_end": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "time_precision": row_precision,
        "match_precision": effective_precision,
        "timezone": effective_zone_name,
        "basis_at": moment.strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    if effective_precision == "day":
        report["basis"]["basis_day"] = local_day(moment, zone_of(effective_zone_name)).isoformat()
        report["basis"]["record_day"] = local_day(start, zone_of(effective_zone_name)).isoformat()
    # P2-R4: state the tolerance semantics of this match instead of leaving the
    # reader to infer them.  ``tolerance_seconds`` widens *instant* matching only:
    # a day-precision basis is compared as a calendar day in the declared zone, so
    # a tolerance can neither pull the neighbouring day in nor be reported as applied.
    report["basis"]["tolerance_seconds"] = tolerance
    report["basis"]["tolerance_applied"] = precision != "day"
    if precision == "day" and tolerance > 0:
        report["notes"].append(
            "day precision: the basis is matched by the local business day the record "
            "starts in; tolerance_seconds is not applied to a day-precision basis")
    if unsupported:
        report["basis"]["coarser_records_not_used"] = unsupported[:8]
        report["notes"].append(
            "coarser-grained records overlap the basis day and were not used to fill a "
            "day-precision basis: a matching day record decides the day price")

    # 6 historical eligibility: the basis record must already be knowable.
    availability = end
    report["basis"]["availability"] = availability.strftime("%Y-%m-%dT%H:%M:%SZ")
    if replay_point is None:
        report["checks"]["history"] = "not_assessed"
        report["notes"].append("no replay point accompany this resolution "
                               "(registration); historical eligibility is not assumed")
    else:
        try:
            replay = _instant(replay_point, "replay_point")
        except ValueError as exc:
            return _reject(report, CODE_HISTORY, {"replay_point": replay_point,
                                                  "error": str(exc)})
        if availability > replay:
            return _reject(report, CODE_HISTORY, {
                "basis_at": basis_at, "availability": report["basis"]["availability"],
                "replay_point": replay.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "corporate_action_cutoff": corporate_action_cutoff,
                "reason": "the basis record was not yet available at the replay point"})
        report["checks"]["history"] = True

    report["state"] = "resolved"
    report["verified"] = True
    return report


__all__ = [
    "FORMAT_VERSION", "PRODUCT_RELATIVE", "SNAPSHOT_RELATIVE", "PRODUCT_KINDS",
    "PRICE_DIMENSION", "CURRENCY_CODES", "RESOLUTION_CODES", "CHECK_NAMES",
    "TIME_PRECISIONS", "SUB_DAY_PRECISIONS", "COARSER_THAN_DAY", "DAY_PRECISIONS",
    "CODE_REFERENCE_INVALID", "CODE_PRODUCT", "CODE_FIELD", "CODE_VERSION",
    "CODE_SNAPSHOT", "CODE_UNIT", "CODE_SUBJECT", "CODE_CURRENCY",
    "CODE_CURRENCY_UNKNOWN", "CODE_TIME", "CODE_TIMEZONE_CONFLICT", "CODE_AMBIGUOUS",
    "CODE_PRECISION", "CODE_PRECISION_UNSUPPORTED",
    "CODE_HISTORY", "CODE_REVISED", "CODE_RULE_UNVERIFIED",
    "StoreCatalog", "basis_precision", "currency_of_unit", "unit_currency",
    "unit_dimension", "store_unit_definition", "zone_of", "local_day", "resolve",
]
