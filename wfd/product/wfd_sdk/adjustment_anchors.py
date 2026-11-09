#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Formal adjustment-anchor registry (P2) and the anchor reference resolver.

P1 answered *which* product a dataset may write into and locked the declared
adjustment **direction** (raw / adjusted / unknown).  It carried
``price_adjustment.anchor_ref`` as an opaque blob and refused to look at it at
all (``INTERNAL_REFERENCE_NOT_IMPLEMENTED``), so ``direction=adjusted`` could
never be written: a qfq and an hfq series were indistinguishable.

P2 splits the two objects the design keeps apart:

* **method** - how the series was computed (``qfq`` / ``hfq``).  Carried on the
  declaration as ``semantic_context.financial.price_adjustment.method``; it
  says nothing about *which* point in time is the basis.
* **anchor** - which point in time is the basis, how it was priced, which
  instrument scope and business window it applies to, and up to which
  corporate action the adjustment is complete.  Registered here as a formal,
  versioned, append-only catalog object.

Anchors are registered only by the explicit ``register_adjustment_anchor``
operation (permissions ``register`` + ``publish``).  A submission that happens
to mention a new digest never creates an anchor.

Layout (design §2)::

    catalog/product_service/adjustment_anchors/<anchor_id>/version_<n>.json
    catalog/product_service/adjustment_anchors/<anchor_id>.json   # pointer

Version files are written once with temp-file + ``os.replace`` and are never
rewritten or deleted.  The pointer only names the current version for
convenience reads; supersession is derived from the version chain, so marking
an old version ``superseded`` never touches its file (design §6: old published
data keeps being explained by its own anchor version).

Resolution codes (one code per step, never merged):

===================================================  ======================================
step                                                 code
===================================================  ======================================
anchor id not registered                             ``ADJUSTMENT_ANCHOR_UNREGISTERED``
anchor (or pinned version) retired                   ``ADJUSTMENT_ANCHOR_RETIRED``
version / digest do not match the registration       ``ADJUSTMENT_ANCHOR_DIGEST_MISMATCH``
anchor dataset or instrument scope does not cover    ``ADJUSTMENT_ANCHOR_SCOPE_MISMATCH``
anchor method differs from the declared method       ``ADJUSTMENT_ANCHOR_METHOD_MISMATCH``
business window outside ``applicability``            ``ADJUSTMENT_ANCHOR_NOT_APPLICABLE``
pinned version superseded by a newer registration    ``ADJUSTMENT_ANCHOR_VERSION_NOT_APPLICABLE``
corporate actions not yet known at the replay point  ``ADJUSTMENT_HISTORY_INELIGIBLE``
===================================================  ======================================
"""

from __future__ import annotations

import copy
import json
import os
import re
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

from . import basis_prices
from .duckdb_sdk import canonical, sha

FORMAT_VERSION = "wfd.adjustment-anchors/1.0"
RECORD_FORMAT = "wfd.adjustment-anchor/1.0"
RELATIVE_DIR = "catalog/product_service/adjustment_anchors"
POINTER_NAME = "{anchor_id}.json"
VERSION_NAME = "version_{version}.json"

ANCHOR_KIND = "adjustment_anchor"
ANCHOR_NAMESPACES = {"wfd.adjustment"}
METHODS = {"qfq", "hfq"}
STATUS_ACTIVE = "active"
STATUS_SUPERSEDED = "superseded"
STATUS_RETIRED = "retired"
STATUSES = {STATUS_ACTIVE, STATUS_SUPERSEDED, STATUS_RETIRED}

IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")

RECORD_FIELDS = ("anchor_id", "dataset_id", "instrument_scope", "method", "basis_at",
                 "basis_price_ref", "applicability", "corporate_action_cutoff",
                 "version", "digest", "status", "registered_by", "registered_at",
                 "supersedes")

CODE_UNREGISTERED = "ADJUSTMENT_ANCHOR_UNREGISTERED"
CODE_RETIRED = "ADJUSTMENT_ANCHOR_RETIRED"
CODE_DIGEST = "ADJUSTMENT_ANCHOR_DIGEST_MISMATCH"
CODE_SCOPE = "ADJUSTMENT_ANCHOR_SCOPE_MISMATCH"
CODE_METHOD = "ADJUSTMENT_ANCHOR_METHOD_MISMATCH"
CODE_NOT_APPLICABLE = "ADJUSTMENT_ANCHOR_NOT_APPLICABLE"
CODE_VERSION_NOT_APPLICABLE = "ADJUSTMENT_ANCHOR_VERSION_NOT_APPLICABLE"
CODE_HISTORY = "ADJUSTMENT_HISTORY_INELIGIBLE"
CODE_DEFINITION_INVALID = "ADJUSTMENT_ANCHOR_DEFINITION_INVALID"
CODE_VERSION_EXISTS = "ADJUSTMENT_ANCHOR_VERSION_EXISTS"
CODE_READ_ONLY = "ADJUSTMENT_ANCHOR_READ_ONLY_STORE"

RESOLUTION_CODES = (
    CODE_UNREGISTERED, CODE_RETIRED, CODE_DIGEST, CODE_SCOPE, CODE_METHOD,
    CODE_NOT_APPLICABLE, CODE_VERSION_NOT_APPLICABLE, CODE_HISTORY,
)


# --------------------------------------------------------------------- helpers
def _fail(code: str, detail: Any) -> None:
    raise ValueError(code + ":" + (detail if isinstance(detail, str) else
                                   json.dumps(detail, ensure_ascii=False, sort_keys=True)))


def anchor_digest(record: Mapping[str, Any]) -> str:
    """Digest of the registered body; ``digest`` itself is not digested."""
    body = {key: copy.deepcopy(record.get(key)) for key in RECORD_FIELDS
            if key != "digest"}
    return "sha256:" + sha(canonical(body))


def _instant(value: Any, field: str) -> datetime:
    """Parse a business date or an explicit instant into an aware UTC time.

    A bare date is read as 00:00:00Z.  An instant must carry an explicit UTC
    offset: a local wall-clock time without an offset is not a fixed point.
    """
    if not isinstance(value, str) or not value.strip():
        _fail(CODE_DEFINITION_INVALID, "field " + field + " must be a non-empty string")
    text = value.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    candidate = text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        _fail(CODE_DEFINITION_INVALID, "field " + field + " is not an ISO date/instant: " + text)
    if parsed.tzinfo is None:
        _fail(CODE_DEFINITION_INVALID,
              "field " + field + " must carry an explicit UTC offset: " + text)
    return parsed.astimezone(timezone.utc)


def _optional_instant(value: Any, field: str) -> datetime | None:
    if value is None:
        return None
    return _instant(value, field)


def _day(value: str) -> str:
    return value[:10]


def default_instrument_scope() -> dict:
    return {"kind": "all_subjects"}


# ------------------------------------------------------------------ validation
def _check_scope(scope: Any) -> dict:
    if scope is None:
        return default_instrument_scope()
    if not isinstance(scope, dict):
        _fail(CODE_DEFINITION_INVALID, "instrument_scope must be an object")
    kind = scope.get("kind")
    if kind not in {"all_subjects", "instruments", "subjects"}:
        _fail(CODE_DEFINITION_INVALID,
              "instrument_scope.kind must be all_subjects/instruments/subjects")
    out = {"kind": kind}
    if kind == "all_subjects":
        if set(scope) != {"kind"}:
            _fail(CODE_DEFINITION_INVALID, "instrument_scope.all_subjects carries no identifiers")
        return out
    key = "instrument_ids" if kind == "instruments" else "subject_ids"
    if set(scope) - {"kind", key}:
        _fail(CODE_DEFINITION_INVALID, "instrument_scope has unsupported fields")
    ids = scope.get(key)
    if (not isinstance(ids, list) or not ids
            or any(not isinstance(item, str) or not item for item in ids)):
        _fail(CODE_DEFINITION_INVALID, "instrument_scope." + key + " must be a non-empty string list")
    out[key] = sorted(set(ids))
    return out


def _check_applicability(value: Any) -> dict:
    if not isinstance(value, dict) or set(value) - {"from", "to"}:
        _fail(CODE_DEFINITION_INVALID, "applicability must be an object with from/to")
    if "from" not in value:
        _fail(CODE_DEFINITION_INVALID, "applicability.from is required")
    start = _instant(value["from"], "applicability.from")
    end = _optional_instant(value.get("to"), "applicability.to")
    if end is not None and end < start:
        _fail(CODE_DEFINITION_INVALID, "applicability.to precedes applicability.from")
    return {"from": _day(value["from"]), "to": (None if end is None else _day(value["to"]))}


BASIS_REF_FIELDS = ("kind", "namespace", "id", "version", "digest", "field_code",
                    "snapshot_id", "unit_code", "currency", "instrument_id",
                    "time_precision", "tolerance_seconds", "timezone")
#: Zone names carry separators (``Asia/Shanghai``, ``America/Argentina/Buenos_Aires``)
#: and ``+05:30``-style offsets, so they are *not* bare identifiers.
ZONE_NAME = re.compile(r"^(?:UTC|[A-Za-z][A-Za-z0-9_+\-]*(?:/[A-Za-z0-9_+\-]+)*)$")



def _check_basis_price_ref(value: Any) -> dict:
    """A basis price is either a fixed ref (product field + record identity) or a rule.

    P2-R2 added the fields the real resolver needs: the pinned ``snapshot_id``,
    the declared ``unit_code`` / ``currency`` and the ``instrument_id`` whose
    price is the basis, plus an optional ``time_precision`` /
    ``tolerance_seconds`` window.  All of them are optional in the *shape* --
    whether a reference is complete enough is decided by
    :func:`wfd_sdk.basis_prices.resolve`, which fails closed with its own code.

    P2-R3 adds the optional ``timezone``: the zone a day-precision ``basis_at``
    is read in.  Without it the record's own ``source_timezone`` decides the
    local day; with neither, a day-precision basis is refused rather than read
    as a UTC day.
    """
    if not isinstance(value, dict) or not value:
        _fail(CODE_DEFINITION_INVALID, "basis_price_ref must be an object")
    if "rule" in value:
        if set(value) != {"rule"} or not isinstance(value["rule"], str) or not value["rule"]:
            _fail(CODE_DEFINITION_INVALID, "basis_price_ref.rule must be a non-empty string")
        return {"rule": value["rule"]}
    unknown = sorted(set(value) - set(BASIS_REF_FIELDS))
    if unknown:
        _fail(CODE_DEFINITION_INVALID, "basis_price_ref has unsupported fields " + ",".join(unknown))
    for key in ("kind", "namespace", "id"):
        if not isinstance(value.get(key), str) or not IDENTIFIER.fullmatch(value[key]):
            _fail(CODE_DEFINITION_INVALID, "basis_price_ref." + key + " must be an identifier")
    out = {key: value[key] for key in ("kind", "namespace", "id")}
    if value.get("version") is not None:
        out["version"] = str(value["version"])
    if value.get("digest") is not None:
        if not isinstance(value["digest"], str) or not re.fullmatch(r"sha256:[0-9a-f]{64}",
                                                                    value["digest"]):
            _fail(CODE_DEFINITION_INVALID, "basis_price_ref.digest must be sha256:<64 hex>")
        out["digest"] = value["digest"]
    for key in ("field_code", "snapshot_id", "unit_code", "currency", "instrument_id",
                "time_precision"):
        if value.get(key) is not None:
            if not isinstance(value[key], str) or not IDENTIFIER.fullmatch(value[key]):
                _fail(CODE_DEFINITION_INVALID,
                      "basis_price_ref." + key + " must be an identifier")
            out[key] = value[key]
    if value.get("timezone") is not None:
        zone = value["timezone"]
        if not isinstance(zone, str) or not ZONE_NAME.fullmatch(zone.strip()) \
                or basis_prices.zone_of(zone) is None:
            _fail(CODE_DEFINITION_INVALID,
                  "basis_price_ref.timezone must be a known timezone name")
        out["timezone"] = zone.strip()
    if value.get("tolerance_seconds") is not None:
        tolerance = value["tolerance_seconds"]
        if isinstance(tolerance, bool) or not isinstance(tolerance, int) or tolerance < 0:
            _fail(CODE_DEFINITION_INVALID,
                  "basis_price_ref.tolerance_seconds must be a non-negative integer")
        out["tolerance_seconds"] = tolerance
    return out


def normalize_basis_price_ref(value: Any) -> dict:
    """Public shape normaliser: the exact body that would be registered/digested."""
    return _check_basis_price_ref(value)


def normalize_version(value: Any) -> int:
    if isinstance(value, bool):
        _fail(CODE_DEFINITION_INVALID, "version must be a positive integer")
    if isinstance(value, int):
        number = value
    elif isinstance(value, str):
        text = value.strip()
        match = re.fullmatch(r"(?:v|version_)?(\d{1,9})", text, re.IGNORECASE)
        number = int(match.group(1)) if match else 0
    else:
        number = 0
    if number <= 0:
        _fail(CODE_DEFINITION_INVALID, "version must be a positive integer")
    return number


# ----------------------------------------------------------------------- files
def anchor_dir(root: str | Path, anchor_id: str) -> Path:
    return Path(root) / RELATIVE_DIR / anchor_id


def pointer_path(root: str | Path, anchor_id: str) -> Path:
    return Path(root) / RELATIVE_DIR / (anchor_id + ".json")


def version_path(root: str | Path, anchor_id: str, version: int) -> Path:
    return anchor_dir(root, anchor_id) / VERSION_NAME.format(version=version)


def empty_document() -> dict:
    return {"format_version": FORMAT_VERSION, "anchors": {}}


def load(root: str | Path) -> dict:
    """Read the whole registry.  Never creates, repairs or reorders a record."""
    base = Path(root) / RELATIVE_DIR
    document = empty_document()
    if not base.is_dir():
        return document
    for entry in sorted(base.iterdir()):
        if entry.name.startswith("._") or entry.is_symlink() or not entry.is_dir():
            continue
        anchor_id = entry.name
        if not IDENTIFIER.fullmatch(anchor_id):
            continue
        records = []
        for path in sorted(entry.glob("version_*.json")):
            if path.name.startswith("._") or path.is_symlink():
                continue
            try:
                record = json.loads(path.read_text("utf-8"))
            except (OSError, ValueError) as exc:
                _fail(CODE_DIGEST, f"{anchor_id}/{path.name} unreadable: {exc}")
            records.append(_checked_record(record, anchor_id))
        if records:
            document["anchors"][anchor_id] = records
    return document


def _checked_record(record: Any, anchor_id: str) -> dict:
    if not isinstance(record, dict):
        _fail(CODE_DIGEST, anchor_id + " record is not an object")
    if record.get("anchor_id") != anchor_id:
        _fail(CODE_DIGEST, anchor_id + " record identity mismatch")
    missing = [key for key in RECORD_FIELDS if key not in record]
    if missing:
        _fail(CODE_DIGEST, anchor_id + " record missing " + ",".join(missing))
    extra = sorted(set(record) - set(RECORD_FIELDS))
    if extra:
        _fail(CODE_DIGEST, anchor_id + " record has unsupported fields " + ",".join(extra))
    if record.get("digest") != anchor_digest(record):
        _fail(CODE_DIGEST, anchor_id + " version_" + str(record.get("version"))
              + " digest does not match the registered body")
    return record


def chain(document: Mapping[str, Any], anchor_id: str) -> list[dict]:
    return list(((document.get("anchors") or {}).get(anchor_id) or []))


def versions(document: Mapping[str, Any], anchor_id: str) -> list[int]:
    return sorted(int(record.get("version") or 0) for record in chain(document, anchor_id))


def current(document: Mapping[str, Any], anchor_id: str) -> dict | None:
    records = chain(document, anchor_id)
    if not records:
        return None
    return max(records, key=lambda item: int(item.get("version") or 0))


def select(document: Mapping[str, Any], anchor_id: str, version: Any = None) -> dict | None:
    """The registered record a reference names; ``None`` when it does not exist."""
    records = chain(document, anchor_id)
    if not records:
        return None
    if version is None:
        return max(records, key=lambda item: int(item.get("version") or 0))
    try:
        wanted = normalize_version(version)
    except ValueError:
        return None
    for record in records:
        if int(record.get("version") or 0) == wanted:
            return record
    return None


def register(root: str | Path, *, dataset_id: str, anchor_id: str, method: str,
             basis_at: str, basis_price_ref: Any, applicability: Any,
             corporate_action_cutoff: str, instrument_scope: Any = None,
             status: str = STATUS_ACTIVE, registered_by: str, registered_at: str,
             supersedes: Any = None) -> dict:
    """Append one anchor version.  Existing version files are never touched."""
    if not isinstance(anchor_id, str) or not IDENTIFIER.fullmatch(anchor_id):
        _fail(CODE_DEFINITION_INVALID, "anchor_id must match " + IDENTIFIER.pattern)
    if not isinstance(dataset_id, str) or not IDENTIFIER.fullmatch(dataset_id):
        _fail(CODE_DEFINITION_INVALID, "dataset_id must be a dataset identifier")
    if method not in METHODS:
        _fail(CODE_DEFINITION_INVALID, "method must be qfq or hfq")
    if status not in (STATUS_ACTIVE, STATUS_RETIRED):
        _fail(CODE_DEFINITION_INVALID, "status must be active or retired when registering")
    basis = _instant(basis_at, "basis_at")
    cutoff = _instant(corporate_action_cutoff, "corporate_action_cutoff")
    document = load(root)
    records = chain(document, anchor_id)
    number = (max((int(item.get("version") or 0) for item in records), default=0)) + 1
    prior = current(document, anchor_id)
    if supersedes is None:
        supersedes_body = (None if prior is None else
                           {"version": int(prior["version"]), "digest": prior["digest"]})
    elif isinstance(supersedes, dict):
        supersedes_body = {"version": normalize_version(supersedes.get("version")),
                           "digest": supersedes.get("digest")}
        if prior is None:
            _fail(CODE_DEFINITION_INVALID, "supersedes names no registered predecessor")
        if supersedes_body["version"] != int(prior["version"]):
            _fail(CODE_DEFINITION_INVALID,
                  "supersedes must name the current version " + str(prior["version"]))
        supersedes_body["digest"] = prior["digest"]
    else:
        _fail(CODE_DEFINITION_INVALID, "supersedes must be an object or null")
    record = {
        "anchor_id": anchor_id,
        "dataset_id": dataset_id,
        "instrument_scope": _check_scope(instrument_scope),
        "method": method,
        "basis_at": basis.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "basis_price_ref": _check_basis_price_ref(basis_price_ref),
        "applicability": _check_applicability(applicability),
        "corporate_action_cutoff": cutoff.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "version": number,
        "status": status,
        "registered_by": str(registered_by),
        "registered_at": str(registered_at),
        "supersedes": supersedes_body,
    }
    record["digest"] = anchor_digest(record)
    target = version_path(root, anchor_id, number)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        _fail(CODE_VERSION_EXISTS, f"{anchor_id} version_{number} already exists; anchors are append-only")
    payload = (json.dumps(record, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    fd, temporary = tempfile.mkstemp(prefix=".wfd_anchor_", dir=str(target.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    pointer = {"format_version": FORMAT_VERSION, "anchor_id": anchor_id,
               "version": number, "digest": record["digest"], "method": record["method"],
               "dataset_id": record["dataset_id"], "status": record["status"]}
    pointer_target = pointer_path(root, anchor_id)
    pointer_payload = (json.dumps(pointer, ensure_ascii=False, sort_keys=True, indent=2)
                       + "\n").encode("utf-8")
    fd, temporary = tempfile.mkstemp(prefix=".wfd_anchor_", dir=str(pointer_target.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(pointer_payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, pointer_target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return record


# -------------------------------------------------------------- declaration side
def declared_adjustment(declaration: Mapping[str, Any] | None) -> dict:
    """Direction / method / anchor reference as declared on the financial axis."""
    context = (declaration or {}).get("semantic_context")
    financial = (context or {}).get("financial") if isinstance(context, dict) else None
    adjustment = (financial or {}).get("price_adjustment") if isinstance(financial, dict) else None
    if not isinstance(adjustment, dict):
        adjustment = {}
    return {"direction": adjustment.get("direction"),
            "method": adjustment.get("method"),
            "anchor_ref": copy.deepcopy(adjustment.get("anchor_ref"))}


# ------------------------------------------------------------------- facts
_MAX_ROWS = 200_000


def _row_values(row: Mapping[str, Any]) -> Mapping[str, Any]:
    values = row.get("values")
    return values if isinstance(values, dict) else {}


def _cell_value(cell: Any) -> Any:
    if isinstance(cell, dict):
        return cell.get("value")
    return cell


def observation_facts(internal: Mapping[str, Any] | None, declaration: Mapping[str, Any] | None = None) -> dict:
    """Business dates, instruments and the replay point carried by a submission.

    The replay point ("as of when does this content know the market") is taken
    from the submitted content itself, in this fixed priority order:

    1. payload row ``observation_time.latest_exclusive_utc`` / ``earliest_utc``
       (latest row wins) - the only per-row instant the protocol carries;
    2. the last business date found on the rows, read as that day's end
       (``date + 1 day`` at 00:00:00Z, i.e. deliberately early);
    3. ``semantic_context.time`` cannot name an instant in the frozen
       protocol, so nothing is derived from it.

    When no replay point can be determined the caller must fail closed
    (``ADJUSTMENT_HISTORY_INELIGIBLE``); this function reports ``as_of: None``
    and never assumes "allowed".
    """
    internal = internal or {}
    payload = internal.get("payload") or {}
    rows = payload.get("rows") if isinstance(payload, dict) else None
    rows = rows if isinstance(rows, list) else []
    dates: set[str] = set()
    instants: list[datetime] = []
    instruments: set[str] = set()
    fallback_instruments: set[str] = set()
    for index, row in enumerate(rows[:_MAX_ROWS]):
        if not isinstance(row, dict):
            continue
        observed = row.get("observation_time")
        if isinstance(observed, dict):
            for key in ("latest_exclusive_utc", "earliest_utc"):
                value = observed.get(key)
                if isinstance(value, str) and value:
                    try:
                        moment = _instant(value, "observation_time." + key)
                    except ValueError:
                        continue
                    instants.append(moment)
                    dates.add(moment.date().isoformat())
                    break
        values = _row_values(row)
        for name, cell in values.items():
            text = _cell_value(cell)
            if not isinstance(text, str):
                continue
            low = str(name).lower()
            if any(marker in low for marker in ("instrument", "secur", "symbol", "ticker")):
                if text.strip():
                    instruments.update(part.strip() for part in text.split(",") if part.strip())
            elif low.endswith("_code") and text.strip():
                # Only an instrument-like field name identifies the subject scope;
                # other ``*_code`` columns are kept aside and used only when the
                # batch names no instrument field at all.
                fallback_instruments.update(part.strip() for part in text.split(",")
                                            if part.strip())
            if "date" in low:
                stripped = text.strip()
                if re.fullmatch(r"\d{8}", stripped):
                    dates.add(stripped[:4] + "-" + stripped[4:6] + "-" + stripped[6:])
                elif re.fullmatch(r"\d{4}-\d{2}-\d{2}", stripped):
                    dates.add(stripped)
    if not instruments:
        instruments = fallback_instruments
    source = None
    as_of = None
    if instants:
        as_of = max(instants).strftime("%Y-%m-%dT%H:%M:%SZ")
        source = "payload.rows.observation_time"
    elif dates:
        as_of = (datetime.strptime(max(dates), "%Y-%m-%d").replace(tzinfo=timezone.utc)
                 + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        source = "payload.rows.business_date_end"
    subjects = set()
    subject = internal.get("subject")
    if isinstance(subject, dict) and isinstance(subject.get("id"), str) and subject["id"]:
        subjects.add(subject["id"])
    return {
        "business_dates": sorted(dates),
        "as_of": as_of,
        "as_of_source": source,
        "as_of_basis": ("no replay point carried by the submission; adjusted writes fail closed"
                        if as_of is None else source),
        "instruments": sorted(instruments),
        "subjects": sorted(subjects),
        "row_count": len(rows),
    }


# ---------------------------------------------------------------- resolution
def _ref_parts(ref: Any) -> tuple[str, Any]:
    if not isinstance(ref, dict):
        _fail(CODE_UNREGISTERED, "anchor_ref is not an object")
    if set(ref) - {"kind", "namespace", "id", "version", "digest"}:
        _fail(CODE_UNREGISTERED, "anchor_ref has unsupported fields "
              + ",".join(sorted(set(ref) - {"kind", "namespace", "id", "version", "digest"})))
    if ref.get("kind") != ANCHOR_KIND:
        _fail(CODE_UNREGISTERED, "anchor_ref.kind must be " + ANCHOR_KIND
              + " (got " + str(ref.get("kind")) + ")")
    if ref.get("namespace") not in ANCHOR_NAMESPACES:
        _fail(CODE_UNREGISTERED, "anchor_ref.namespace is not a registered anchor namespace: "
              + str(ref.get("namespace")))
    anchor_id = ref.get("id")
    if not isinstance(anchor_id, str) or not IDENTIFIER.fullmatch(anchor_id):
        _fail(CODE_UNREGISTERED, "anchor_ref.id must be an anchor identifier")
    return anchor_id, ref.get("version")


def _scope_covers(record: Mapping[str, Any], dataset_id: str, instruments, subjects) -> None:
    """Dataset must match; the subject scope is only judged when subjects are known.

    ``None`` means "not assessed here" (dataset-level inspection).  A submission
    always passes the instruments/subjects it actually carries, so an empty
    batch scope fails closed instead of silently passing.
    """
    if record.get("dataset_id") != dataset_id:
        _fail(CODE_SCOPE, {"anchor_dataset_id": record.get("dataset_id"),
                           "submitted_dataset_id": dataset_id})
    scope = record.get("instrument_scope") or {}
    kind = scope.get("kind")
    if kind == "all_subjects":
        return
    if kind == "instruments":
        if instruments is None:
            return
        wanted = set(scope.get("instrument_ids") or [])
        seen = set(instruments)
        if seen and seen <= wanted:
            return
        _fail(CODE_SCOPE, {"anchor_instruments": sorted(wanted),
                           "submitted_instruments": sorted(seen),
                           "note": "the anchor must cover every instrument in the batch"})
    if kind == "subjects":
        if subjects is None:
            return
        wanted = set(scope.get("subject_ids") or [])
        seen = set(subjects)
        if seen and seen <= wanted:
            return
        _fail(CODE_SCOPE, {"anchor_subjects": sorted(wanted),
                           "submitted_subjects": sorted(seen)})
    _fail(CODE_SCOPE, "anchor instrument_scope is not interpretable")


def resolve(ref: Any, dataset_id: str, declaration: Mapping[str, Any] | None = None, *,
            document: Mapping[str, Any] | None = None, instruments=None, subjects=None,
            business_dates=None) -> dict:
    """Resolve ``anchor_ref`` step by step; every failure carries its own code.

    Steps (design §3): existence -> retirement -> version/digest -> scope ->
    method -> applicability.  Version applicability and historical eligibility
    are deliberately *not* decided here; they are the next gate steps and are
    implemented by :func:`version_applicable` and :func:`history_eligible`.
    """
    records_document = document if document is not None else empty_document()
    anchor_id, pinned = _ref_parts(ref)
    record = select(records_document, anchor_id, pinned)
    if record is None:
        existing = versions(records_document, anchor_id)
        _fail(CODE_UNREGISTERED, {"anchor_id": anchor_id, "requested_version": pinned,
                                  "registered_versions": existing})
    if record.get("status") == STATUS_RETIRED:
        _fail(CODE_RETIRED, {"anchor_id": anchor_id, "version": record.get("version")})
    digest = ref.get("digest")
    if digest is not None and digest != record.get("digest"):
        _fail(CODE_DIGEST, {"anchor_id": anchor_id, "version": record.get("version"),
                            "registered_digest": record.get("digest"),
                            "requested_digest": digest})
    _scope_covers(record, dataset_id, instruments, subjects)
    declared = declared_adjustment(declaration)
    if declaration is not None and declared.get("direction") == "adjusted":
        declared_method = declared.get("method")
        if declared_method != record.get("method"):
            _fail(CODE_METHOD, {"anchor_method": record.get("method"),
                                "declared_method": declared_method})
    applicability = record.get("applicability") or {}
    start = _instant(applicability.get("from"), "applicability.from")
    end = _optional_instant(applicability.get("to"), "applicability.to")
    days = [str(day) for day in (business_dates or []) if day]
    if not days:
        _fail(CODE_NOT_APPLICABLE,
              {"anchor_id": anchor_id, "reason": "business time undetermined; an adjusted write "
                                               "must carry a business date or an observation time"})
    outside = []
    for day in days:
        moment = _instant(day, "business_date")
        if moment < start or (end is not None and moment > end):
            outside.append(day)
    if outside:
        _fail(CODE_NOT_APPLICABLE, {"anchor_id": anchor_id, "applicability": dict(applicability),
                                    "outside_business_dates": outside[:8],
                                    "outside_count": len(outside)})
    return copy.deepcopy(record)


def version_applicable(record: Mapping[str, Any], *, document: Mapping[str, Any]) -> dict:
    """A pinned anchor version is admissible only while it is the current one.

    Supersession is derived from the version chain, so an old version file is
    never rewritten to record it.  Already published data keeps being explained
    by the version it was published with (design §6); only *new* writes are
    steered to the current version.
    """
    anchor_id = record.get("anchor_id")
    newest = current(document, anchor_id)
    if newest is None:
        _fail(CODE_UNREGISTERED, {"anchor_id": anchor_id})
    if int(newest.get("version") or 0) != int(record.get("version") or 0):
        _fail(CODE_VERSION_NOT_APPLICABLE,
              {"anchor_id": anchor_id, "requested_version": record.get("version"),
               "current_version": newest.get("version"),
               "note": "a newer anchor version governs new writes; rebind is an explicit operation"})
    if newest.get("status") == STATUS_RETIRED:
        _fail(CODE_RETIRED, {"anchor_id": anchor_id, "version": newest.get("version")})
    return copy.deepcopy(record)


def history_eligible(record: Mapping[str, Any], *, as_of: Any) -> dict:
    """Corporate actions must already have happened at the replay point.

    ``corporate_action_cutoff`` is the last corporate action included in the
    adjustment.  Applying the anchor while writing content that only knows the
    market up to an earlier instant would leak events that had not formed yet
    (design §3 last row, requirement "no future corporate actions in a
    historical replay").
    """
    cutoff = _instant(record.get("corporate_action_cutoff"), "corporate_action_cutoff")
    if as_of is None:
        _fail(CODE_HISTORY, {"anchor_id": record.get("anchor_id"),
                             "corporate_action_cutoff": record.get("corporate_action_cutoff"),
                             "as_of": None,
                             "reason": "no replay point carried by the submission; "
                                       "historical eligibility is not assumed"})
    moment = _instant(as_of, "as_of")
    if moment < cutoff:
        _fail(CODE_HISTORY, {"anchor_id": record.get("anchor_id"),
                             "corporate_action_cutoff": record.get("corporate_action_cutoff"),
                             "as_of": _instant(as_of, "as_of").strftime("%Y-%m-%dT%H:%M:%SZ"),
                             "note": "corporate actions after the replay point must not be exposed"})
    return copy.deepcopy(record)


def eligible(record: Mapping[str, Any], *, document: Mapping[str, Any],
             as_of: Any) -> dict:
    """Gate steps 5-6: anchor version applicability, then historical eligibility.

    Kept as two separate checks with two separate codes; this helper only fixes
    their order so a caller cannot accidentally judge history first.
    """
    version_applicable(record, document=document)
    history_eligible(record, as_of=as_of)
    return copy.deepcopy(record)


def inspect(ref: Any = None, dataset_id: str | None = None, *,
            document: Mapping[str, Any] | None = None, anchor_id: str | None = None,
            version: Any = None, basis_catalog: Any = None, units: Mapping[str, Any] | None = None,
            basis_replay_point: Any = None) -> dict:
    """Read-only report for one anchor reference; never raises for a failed check.

    When ``basis_catalog`` is supplied the anchor's ``basis_price_ref`` is also
    resolved (P2-R2) and reported under ``basis_price``.  That resolution is
    read-only and never changes the anchor state.
    """
    records_document = document if document is not None else empty_document()
    if ref is None:
        if not isinstance(anchor_id, str) or not IDENTIFIER.fullmatch(anchor_id):
            raise ValueError("REQUEST_INVALID:anchor_id")
        ref = {"kind": ANCHOR_KIND, "namespace": sorted(ANCHOR_NAMESPACES)[0], "id": anchor_id}
        if version is not None:
            ref["version"] = str(version)
    result = {"format_version": FORMAT_VERSION, "state": "rejected", "code": None,
              "detail": None, "ref": copy.deepcopy(ref), "anchor": None,
              "versions": [], "current_version": None,
              "basis_price": None, "basis_price_verified": None, "notes": [],
              "checks": {"identity": False, "digest": False, "scope": False,
                         "version_applicability": False}}
    try:
        parsed_id, pinned = _ref_parts(ref)
    except ValueError as exc:
        result["code"] = str(exc).split(":", 1)[0]
        result["detail"] = str(exc)
        return result
    result["anchor_id"] = parsed_id
    result["versions"] = versions(records_document, parsed_id)
    newest = current(records_document, parsed_id)
    result["current_version"] = None if newest is None else newest.get("version")
    record = select(records_document, parsed_id, pinned)
    if record is None:
        result["code"] = CODE_UNREGISTERED
        result["detail"] = json.dumps({"anchor_id": parsed_id,
                                       "registered_versions": result["versions"]},
                                      ensure_ascii=False, sort_keys=True)
        return result
    result["anchor"] = copy.deepcopy(record)
    result["checks"]["identity"] = record.get("status") == STATUS_ACTIVE
    if record.get("status") == STATUS_RETIRED:
        result["code"] = CODE_RETIRED
        result["detail"] = "anchor version is retired"
        return result
    digest = ref.get("digest")
    result["checks"]["digest"] = digest is None or digest == record.get("digest")
    if not result["checks"]["digest"]:
        result["code"] = CODE_DIGEST
        result["detail"] = json.dumps({"registered_digest": record.get("digest"),
                                       "requested_digest": digest},
                                      ensure_ascii=False, sort_keys=True)
        return result
    if dataset_id is not None:
        try:
            _scope_covers(record, dataset_id, None, None)
            result["checks"]["scope"] = True
        except ValueError as exc:
            result["code"] = str(exc).split(":", 1)[0]
            result["detail"] = str(exc)
            return result
    else:
        result["checks"]["scope"] = None
    # P2-R2: the basis price reference resolved right after the anchor identity
    # steps, before the anchor's own version applicability.  A rejection here
    # reports its own code and leaves the anchor untouched.
    if basis_catalog is not None:
        try:
            basis_report = basis_prices.resolve(
                record.get("basis_price_ref"), basis_at=record.get("basis_at"),
                catalog=basis_catalog, units=units,
                instrument_scope=record.get("instrument_scope"),
                corporate_action_cutoff=record.get("corporate_action_cutoff"),
                replay_point=basis_replay_point, dataset_id=dataset_id)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            basis_report = {"format_version": basis_prices.FORMAT_VERSION,
                            "state": "rejected",
                            "code": basis_prices.CODE_REFERENCE_INVALID,
                            "detail": str(exc), "checks": {}, "basis": {}, "notes": []}
        result["basis_price"] = basis_report
        result["basis_price_verified"] = basis_report.get("state") == "resolved"
        if basis_report.get("state") == "rule":
            result["notes"].append(
                "the anchor is registered and current, but its basis price is only a rule: "
                "nothing verifies a price, so a formal adjusted write is refused with "
                + basis_prices.CODE_RULE_UNVERIFIED)
        if basis_report.get("state") == "rejected":
            result["code"] = basis_report.get("code")
            result["detail"] = "basis_price_ref: " + str(basis_report.get("detail"))
            return result
        result["checks"]["basis_price"] = basis_report.get("state")
    newest_version = None if newest is None else int(newest.get("version") or 0)
    result["checks"]["version_applicability"] = (newest_version
                                                 == int(record.get("version") or 0))
    if not result["checks"]["version_applicability"]:
        result["code"] = CODE_VERSION_NOT_APPLICABLE
        result["detail"] = json.dumps({"requested_version": record.get("version"),
                                       "current_version": newest_version},
                                      ensure_ascii=False, sort_keys=True)
        return result
    result["state"] = "resolved"
    return result


__all__ = [
    "FORMAT_VERSION", "RECORD_FORMAT", "RELATIVE_DIR", "ANCHOR_KIND", "ANCHOR_NAMESPACES",
    "METHODS", "STATUS_ACTIVE", "STATUS_SUPERSEDED", "STATUS_RETIRED", "STATUSES",
    "RECORD_FIELDS", "RESOLUTION_CODES", "CODE_UNREGISTERED", "CODE_RETIRED", "CODE_DIGEST",
    "CODE_SCOPE", "CODE_METHOD", "CODE_NOT_APPLICABLE", "CODE_VERSION_NOT_APPLICABLE",
    "CODE_HISTORY", "CODE_DEFINITION_INVALID", "CODE_VERSION_EXISTS", "CODE_READ_ONLY",
    "BASIS_REF_FIELDS", "anchor_digest", "normalize_version", "normalize_basis_price_ref",
    "anchor_dir", "pointer_path", "version_path",
    "empty_document", "load", "chain", "versions", "current", "select", "register",
    "declared_adjustment", "observation_facts", "resolve", "version_applicable",
    "history_eligible", "eligible", "inspect",
]
