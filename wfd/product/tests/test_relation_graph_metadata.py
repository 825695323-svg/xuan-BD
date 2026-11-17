"""Synthetic projection units: edges must keep their own fixed contract metadata.

These units do not stand in for admission or an end-to-end historical read.
"""
from copy import deepcopy
from types import SimpleNamespace

from wfd_sdk.product_query import ProductQuery, _product_key


def product(suffix):
    return {
        "product_id": "synthetic-relations",
        "contract_ref": {"digest": f"sha256:contract-{suffix}"},
        "contract_refs": {"business": {"digest": f"sha256:business-{suffix}"}},
        "contract_bundle_ref": {"digest": f"sha256:bundle-{suffix}"},
        "declaration": {
            "definition_authority": f"synthetic-authority-{suffix}",
            "semantic_context": {
                "source": {"publisher_ref": {"id": f"synthetic-publisher-{suffix}"}},
                "content_nature": "source_claim" if suffix == "a" else "rule_assertion",
            },
        },
    }


def item(meta, key):
    return {
        "product_id": meta["product_id"],
        "contract_ref": deepcopy(meta["contract_ref"]),
        "record_ref": {"product_id": meta["product_id"], "logical_key": key,
                       "revision_id": "synthetic-v1"},
        "row": {
            "relation_type": "synthetic_membership",
            "subject": {"kind": "entity", "id": "synthetic-subject"},
            "object": {"kind": "entity", "id": key},
            "effective_period": {"status": "known", "earliest_utc": "2026-01-01T00:00:00Z",
                                 "latest_exclusive_utc": "2027-01-01T00:00:00Z"},
        },
    }


def session(metas, rows):
    return {"cache": {"synthetic-relations": {
        "status": "ok", "product": metas[0],
        "products": {_product_key(meta): meta for meta in metas},
        "result": {"rows": rows},
    }}, "business_range": None, "gaps": []}


def test_edges_use_each_rows_exact_product_contract_metadata(tmp_path):
    query = ProductQuery(SimpleNamespace(root=tmp_path, profile="data_only"))
    first, second = product("a"), product("b")
    state = session([first, second], [item(second, "second"), item(first, "first")])
    edges = query._graph_edges(state, "synthetic-relations")
    assert len(edges) == 2
    for edge, meta in zip(edges, [second, first]):
        business = query._business_definition(meta)
        assert edge["contract_ref"] == meta["contract_ref"]
        assert edge["contract_refs"] == meta["contract_refs"]
        assert edge["contract_bundle_ref"] == meta["contract_bundle_ref"]
        assert edge["definer"] == business["definition_authority"]
        for field in ("definition_authority", "publisher", "content_nature"):
            assert edge[field] == business[field]
        assert edge["connectivity"] == "confirmed"
    assert state["gaps"] == []


def test_missing_contract_metadata_is_gap_not_first_contract_fallback(tmp_path):
    query = ProductQuery(SimpleNamespace(root=tmp_path, profile="data_only"))
    first, missing = product("a"), product("b")
    state = session([first], [item(missing, "unbound")])
    assert query._graph_edges(state, "synthetic-relations") == []
    assert state["gaps"] == [{
        "code": "PRODUCT_METADATA_NOT_AVAILABLE", "product_id": missing["product_id"],
        "contract_ref": missing["contract_ref"], "scope": "product",
    }]
