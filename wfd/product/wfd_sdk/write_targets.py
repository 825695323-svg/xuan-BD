#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Formal write-target binding for the data-only product catalog.

The binding answers one question only: *which* registered product may a given
dataset formally write into.  It is deliberately narrow:

* the target is identified by ``product_family_id`` + ``product_id`` +
  ``definition_ref`` (digest), not by a re-derived semantic match;
* the write is refused when the submitted declaration differs on any of the
  declared axes (adjustment direction, per-field unit code, whole definition
  digest), instead of silently forking a new product in the same family;
* a family that already holds product records but has no binding is refused
  outright, so an existing product is never auto-selected by resemblance;
* a binding is created only by (a) the first formal publication into a family
  that held no product records, or (b) an explicit registration operation.
  There is no implicit rebind.

P2 adds the declared adjustment **method** (``qfq`` / ``hfq``) as a locked
axis: a bound qfq target must refuse an hfq submission and vice versa.  The
``anchor_ref`` is still carried here as an opaque reference -- resolving it to
a registered anchor, its version/digest, its basis and its corporate-action
cutoff is the job of :mod:`wfd_sdk.adjustment_anchors`, which the service runs
between the method step and the unit step.
"""
from __future__ import annotations

import copy
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Mapping

from .duckdb_sdk import canonical, sha

FORMAT_VERSION = "wfd.write-targets/1.0"
RELATIVE_PATH = "catalog/product_service/write_targets.json"
SNAPSHOT_RELATIVE = "catalog/snapshots/{snapshot_id}.json"
MAX_ANCESTRY = 100_000

STATUS_BOUND = "bound"
STATUS_NEVER_REGISTERED = "never_registered"
STATUS_FAMILY_WITHOUT_TARGET = "family_without_target"
STATUS_CONFLICT = "conflict"
STATUS_QUERY_FAILED = "query_failed"

DIRECTION_KNOWN = {"raw", "adjusted"}
DIRECTION_ANCHORED = {"adjusted_qfq", "adjusted_hfq"}


def subject_digest(subject: Any) -> str:
    return "sha256:" + sha(canonical(subject))


def family_id_for(dataset_id: str, logical_domain: str, subject: Any,
                  declaration: Mapping[str, Any]) -> str:
    """Same derivation as WFDProductService._family_records (identity only)."""
    return "pf_" + sha(canonical([
        dataset_id, logical_domain, subject,
        declaration.get("semantic_code"), declaration.get("definition_authority"),
    ]))[:24]


def stable_product_id(family_id: str) -> str:
    return "p_" + sha(canonical([family_id, "stable_product"]))[:24]


def axes_of(declaration: Mapping[str, Any]) -> dict:
    """Declared axes that a write target must lock."""
    context = declaration.get("semantic_context")
    statistical = (context or {}).get("statistical") if isinstance(context, dict) else None
    financial = (context or {}).get("financial") if isinstance(context, dict) else None
    # The declared adjustment caliber lives on the financial axis; the
    # statistical axis only carries price_basis (nominal/real).
    adjustment = (financial or {}).get("price_adjustment") if isinstance(financial, dict) else None
    if not isinstance(adjustment, dict):
        adjustment = {}
    units: dict[str, str] = {}
    for field in declaration.get("field_definitions") or []:
        if not isinstance(field, dict):
            continue
        code = field.get("field_code")
        unit = field.get("unit_code")
        if isinstance(code, str) and isinstance(unit, str):
            units[code] = unit
    top_unit = declaration.get("unit_code")
    return {
        "direction": adjustment.get("direction"),
        "method": adjustment.get("method"),
        "anchor_ref": copy.deepcopy(adjustment.get("anchor_ref")),
        "price_basis": copy.deepcopy((statistical or {}).get("price_basis")
                                     if isinstance(statistical, dict) else None),
        "unit_code": top_unit if isinstance(top_unit, str) else None,
        "units": dict(sorted(units.items())),
        "semantic_code": declaration.get("semantic_code"),
        "definition_authority": declaration.get("definition_authority"),
        "measurement_nature": declaration.get("measurement_nature"),
    }


def target_of(*, dataset_id: str, logical_domain: str, subject: Any,
              declaration: Mapping[str, Any], definition_ref: Mapping[str, Any]) -> dict:
    """The write target a submission currently declares, derived without the registry."""
    family = family_id_for(dataset_id, logical_domain, subject, declaration)
    axes = axes_of(declaration)
    return {
        "dataset_id": dataset_id,
        "product_family_id": family,
        "logical_domain": logical_domain,
        "subject_digest": subject_digest(subject),
        "definition_ref": copy.deepcopy(dict(definition_ref)),
        "declaration_digest": "sha256:" + sha(canonical(declaration)),
        **axes,
    }


def binding_key(entry: Mapping[str, Any]) -> tuple[str, str]:
    return (str(entry.get("dataset_id")), str(entry.get("product_family_id")))


def empty_document() -> dict:
    return {"format_version": FORMAT_VERSION, "sequence": 0, "entries": []}


def load(root: str | Path) -> dict:
    """Read the binding catalog.  Never creates or repairs it."""
    path = Path(root) / RELATIVE_PATH
    if not path.is_file() or path.is_symlink():
        return empty_document()
    raw = path.read_text("utf-8")
    doc = json.loads(raw)
    if not isinstance(doc, dict) or doc.get("format_version") != FORMAT_VERSION:
        raise ValueError("WRITE_TARGET_CATALOG_INVALID:format_version")
    if not isinstance(doc.get("entries"), list):
        raise ValueError("WRITE_TARGET_CATALOG_INVALID:entries")
    return doc


def chain(doc: Mapping[str, Any], dataset_id: str, family: str) -> list[dict]:
    return [entry for entry in doc.get("entries") or []
            if isinstance(entry, dict)
            and entry.get("dataset_id") == dataset_id
            and entry.get("product_family_id") == family]


def latest(doc: Mapping[str, Any], dataset_id: str, family: str) -> dict | None:
    entries = chain(doc, dataset_id, family)
    if not entries:
        return None
    return max(entries, key=lambda entry: int(entry.get("sequence") or 0))


def families_for(doc: Mapping[str, Any], dataset_id: str) -> list[str]:
    seen = {entry.get("product_family_id") for entry in doc.get("entries") or []
            if isinstance(entry, dict) and entry.get("dataset_id") == dataset_id}
    return sorted(name for name in seen if isinstance(name, str) and name)


def ancestry(root: str | Path, snapshot_id: str) -> list[str]:
    """Snapshot ids from ``snapshot_id`` down to the first root, oldest last."""
    out: list[str] = []
    cursor = snapshot_id
    while isinstance(cursor, str) and cursor:
        if len(out) >= MAX_ANCESTRY:
            raise ValueError("WRITE_TARGET_ANCESTRY_TOO_DEEP")
        path = Path(root) / SNAPSHOT_RELATIVE.format(snapshot_id=cursor)
        if not path.is_file() or path.is_symlink():
            raise ValueError("WRITE_TARGET_SNAPSHOT_MISSING:" + cursor)
        data = json.loads(path.read_text("utf-8"))
        if data.get("snapshot_id") != cursor:
            raise ValueError("WRITE_TARGET_SNAPSHOT_IDENTITY_MISMATCH:" + cursor)
        out.append(cursor)
        cursor = data.get("parent_snapshot_id")
    return out


def visible_entry(entry: Mapping[str, Any], reachable: set[str] | None) -> bool:
    if reachable is None:
        return True
    bound = entry.get("bound_snapshot_id")
    if not isinstance(bound, str) or not bound:
        # A registration that is not yet carried by any snapshot cannot be
        # read as binding for a fixed snapshot.
        return False
    return bound in reachable


def visible_document(root: str | Path, doc: Mapping[str, Any],
                     dataset_id: str, snapshot_id: str | None) -> dict:
    """Bindings of one dataset that are effective at ``snapshot_id``."""
    reachable = None if snapshot_id is None else set(ancestry(root, snapshot_id))
    out = {}
    for family in families_for(doc, dataset_id):
        entry = latest(doc, dataset_id, family)
        if entry is not None and visible_entry(entry, reachable):
            out[family] = entry
    return out


def compare(binding: Mapping[str, Any], derived: Mapping[str, Any]) -> list[dict]:
    """Axis-level differences between a bound target and a submitted one."""
    issues: list[dict] = []

    def add(code: str, detail: dict) -> None:
        issues.append({"code": code, "detail": detail})

    if binding.get("product_family_id") != derived.get("product_family_id"):
        add("WRITE_TARGET_FAMILY_MISMATCH", {
            "bound": binding.get("product_family_id"),
            "submitted": derived.get("product_family_id"),
        })
    bound_direction = binding.get("direction")
    submitted_direction = derived.get("direction")
    if bound_direction != submitted_direction:
        add("WRITE_TARGET_DIRECTION_MISMATCH", {
            "bound": bound_direction, "submitted": submitted_direction,
            "note": "an unknown direction is never read as a known caliber",
        })
    bound_method = binding.get("method")
    submitted_method = derived.get("method")
    if bound_method != submitted_method:
        add("WRITE_TARGET_METHOD_MISMATCH", {
            "bound": bound_method, "submitted": submitted_method,
            "note": "the adjustment method is a locked axis; a qfq target never accepts hfq",
        })
    if (bound_direction in DIRECTION_ANCHORED or submitted_direction in DIRECTION_ANCHORED) \
            and canonical(binding.get("anchor_ref")) != canonical(derived.get("anchor_ref")):
        add("WRITE_TARGET_ANCHOR_MISMATCH", {
            "bound": copy.deepcopy(binding.get("anchor_ref")),
            "submitted": copy.deepcopy(derived.get("anchor_ref")),
            "note": "anchor reference compared as declared; not resolved to factor data",
        })
    bound_units = dict(binding.get("units") or {})
    submitted_units = dict(derived.get("units") or {})
    if bound_units != submitted_units:
        fields = sorted(set(bound_units) | set(submitted_units))
        add("WRITE_TARGET_UNIT_MISMATCH", {
            "fields": {name: {"bound": bound_units.get(name),
                              "submitted": submitted_units.get(name)}
                       for name in fields
                       if bound_units.get(name) != submitted_units.get(name)},
        })
    bound_digest = ((binding.get("definition_ref") or {}).get("digest"))
    submitted_digest = ((derived.get("definition_ref") or {}).get("digest"))
    if bound_digest != submitted_digest:
        add("WRITE_TARGET_DEFINITION_DRIFT", {
            "bound": bound_digest, "submitted": submitted_digest,
            "note": "definition identity differs from the bound target; rebind is an explicit operation",
        })
    return issues


def next_entry(*, doc: Mapping[str, Any], target: Mapping[str, Any], origin: str,
               registered_by: str, registered_at: str, reason: str,
               bound_snapshot_id: str | None, product_id: str | None = None) -> dict:
    family = str(target.get("product_family_id"))
    dataset_id = str(target.get("dataset_id"))
    prior = latest(doc, dataset_id, family)
    entry = {
        "sequence": int(doc.get("sequence") or 0) + 1,
        "dataset_id": dataset_id,
        "product_family_id": family,
        "product_id": product_id,
        "logical_domain": target.get("logical_domain"),
        "subject_digest": target.get("subject_digest"),
        "definition_ref": copy.deepcopy(target.get("definition_ref")),
        "declaration_digest": target.get("declaration_digest"),
        "direction": target.get("direction"),
        "method": target.get("method"),
        "anchor_ref": copy.deepcopy(target.get("anchor_ref")),
        "price_basis": copy.deepcopy(target.get("price_basis")),
        "unit_code": target.get("unit_code"),
        "units": copy.deepcopy(target.get("units")),
        "semantic_code": target.get("semantic_code"),
        "definition_authority": target.get("definition_authority"),
        "measurement_nature": target.get("measurement_nature"),
        "origin": origin,
        "registered_by": registered_by,
        "registered_at": registered_at,
        "bound_snapshot_id": bound_snapshot_id,
        "reason": reason,
        "supersedes": ({"sequence": prior.get("sequence"),
                        "product_id": prior.get("product_id"),
                        "definition_ref": copy.deepcopy(prior.get("definition_ref"))}
                       if prior is not None else None),
    }
    return entry


def rendered(doc: Mapping[str, Any], entry: Mapping[str, Any]) -> bytes:
    body = {"format_version": FORMAT_VERSION, "sequence": entry["sequence"],
            "entries": [copy.deepcopy(item) for item in doc.get("entries") or []]
            + [copy.deepcopy(entry)]}
    return (json.dumps(body, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def write_entry(root: str | Path, doc: Mapping[str, Any], entry: Mapping[str, Any]) -> str:
    """Append one binding entry; atomic replace, previous file left as backup."""
    root = Path(root)
    path = root / RELATIVE_PATH
    payload = rendered(doc, entry)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        backup = path.with_name(path.name + f".bak-seq{entry['sequence']:04d}")
        if not backup.exists():
            backup.write_bytes(path.read_bytes())
    fd, tmp = tempfile.mkstemp(prefix=".wfd_write_targets_", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return RELATIVE_PATH


__all__ = [
    "FORMAT_VERSION", "RELATIVE_PATH", "STATUS_BOUND", "STATUS_NEVER_REGISTERED",
    "STATUS_FAMILY_WITHOUT_TARGET", "STATUS_CONFLICT", "STATUS_QUERY_FAILED",
    "axes_of", "target_of", "family_id_for", "stable_product_id", "subject_digest",
    "load", "latest", "families_for", "visible_document", "compare", "next_entry",
    "write_entry", "ancestry",
]
