"""Test-only fixture roles for pre-P3 regression fixtures.

The production service now requires explicit per-output source_roles.  Older
P1 tests predate that field; this pytest-only wrapper adds a fixture definer so
the existing contract regressions remain readable.  Standalone audits and all
production callers do not load conftest and therefore still exercise strict
role admission.
"""
from __future__ import annotations

import copy

import pytest


@pytest.fixture(autouse=True)
def _p1_fixture_source_roles(monkeypatch):
    from wfd_sdk.product_service import WFDProductService

    original = WFDProductService.submit

    def submit(self, doc):
        if isinstance(doc, dict) and isinstance(doc.get("source_bundle"), dict):
            roles = doc["source_bundle"].get("source_roles")
            if not roles:
                doc = copy.deepcopy(doc)
                source = doc["source_bundle"]
                ids = source.get("source_ids") or ([source.get("source_id")] if source.get("source_id") else [])
                if ids:
                    source["source_roles"] = {
                        out["output_key"]: [{"source_id": ids[0], "roles": ["definer"]}]
                        for out in doc.get("outputs", [])
                    }
        return original(self, doc)

    monkeypatch.setattr(WFDProductService, "submit", submit)


@pytest.fixture(autouse=True)
def _p1_fixture_single_output_roles(_p1_fixture_source_roles):
    return None
