"""First financial-product slice over the unchanged rc5 storage engine.

V1.3 structured input is kept intact at the public boundary.  Product metadata
is embedded in each committed source bundle so fixed reads do not consult a
newer registry.  This local service is not a frozen network protocol.
"""
from __future__ import annotations

import copy
import json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import product_calendar
from .duckdb_sdk import (
    canonical, sha, eligibility_at, check_time,
    product_content_digest, product_content_records,
    derived_output_digest, external_processing_record_errors,
)
from .product_governance import (
    CONTRACT_VERSION, SOURCE_FLAGS, SOURCE_LINEAGE_ROLES, CONFLICT_MODES,
    WARMUP_STATUSES, DERIVED_VALIDITY_STATES,
    normalize_caller_roles, normalize_source_policies, normalize_unit_registry,
    normalize_semantic_context, normalize_algorithm_definition,
    source_origin_key, validate_definition,
    validate_payload, validate_units,
)
from .writerlock import writer_lock


COMMON = "https://wfd.example/spec/v1.3/wfd-common.schema.json#/$defs/"
SERVICE_VERSION = "wfd.product-service/0.3"
SUPPORTED_EXTENSION_VERSIONS = {"wfd.product-service/0.2", SERVICE_VERSION}
CONTRACT_ROLE_BODY = {
    "semantic": "semantic",
    "read_layout": "read",
    "algorithm_dependency": "compute_dependencies",
    "update_release": "publication",
}
REVISION_MODES = {"source_correction", "processing_repair", "withdrawal"}
APPEND_MODES = {"complete_snapshot", "partial_observation", "explicit_increment"}
_UNPROVIDED_COVERAGE_BASE = object()
CURRENT_ONLY_BUSINESS = "current_only_business"


def current_only_business(declaration):
    context = (declaration or {}).get("semantic_context") or {}
    return (context.get("version_axis") or {}).get("revision_mode") == CURRENT_ONLY_BUSINESS


def _second_now():
    start = datetime.now(timezone.utc).replace(microsecond=0)
    return {"status": "known", "precision": "second",
            "earliest_utc": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "latest_exclusive_utc": (start + timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source_timezone": "UTC"}


def _issue(code, message):
    return {"code": code, "message": message}


class WFDProductService:
    """Register, submit and read a small, version-pinned financial product set.

    ``allowed_sources`` is supplied by the trusted local caller, not by input
    documents. Submission, formal publication, export and redistribution are
    separate explicit grants; absent permissions deny. A policy describes local
    admission, not a redistribution licence.
    """

    def __init__(self, engine, *, allowed_sources: dict, can_register=True,
                 caller_roles=None, caller_id="local", unit_registry=None,
                 trusted_actor_namespaces=None):
        self.engine = engine
        self.root = engine.root
        self.caller_id = str(caller_id)
        self.caller_roles = normalize_caller_roles(caller_roles)
        self.allowed_sources = normalize_source_policies(allowed_sources)
        self.unit_registry = normalize_unit_registry(unit_registry)
        namespaces = trusted_actor_namespaces or []
        if isinstance(namespaces, str):
            namespaces = [namespaces]
        if any(not isinstance(x, str) or not x for x in namespaces):
            raise ValueError("TRUSTED_ACTOR_NAMESPACE_INVALID")
        self.trusted_actor_namespaces = frozenset(namespaces)
        self.can_register = bool(can_register and self.has_permission("register"))
        # 显式审计/技术固定复现的事项编号；只由受控机器入口在单次请求内设置。
        self._usage_audit_issue_id = None

    def has_permission(self, permission):
        return permission in self.caller_roles

    def require_permission(self, permission):
        if not self.has_permission(permission):
            raise PermissionError("CALLER_PERMISSION_DENIED:" + permission)
        return True

    def actor_namespace_allowed(self, actor_namespace):
        return actor_namespace in self.trusted_actor_namespaces

    def _source_ids(self, source):
        values = list(source.get("source_ids", []))
        if source.get("source_id"):
            values.append(source["source_id"])
        return list(dict.fromkeys(x for x in values if isinstance(x, str) and x))

    def _source_policies(self, source):
        source_ids = self._source_ids(source)
        if not source_ids:
            raise ValueError("SOURCE_ID_REQUIRED")
        policies = []
        for source_id in source_ids:
            if source_id not in self.allowed_sources:
                raise ValueError("SOURCE_NOT_ADMITTED:" + source_id)
            policies.append((source_id, self.allowed_sources[source_id]))
        return policies

    def _authorize_sources(self, source_ids, *, evidence=False):
        if not source_ids:
            raise PermissionError("SOURCE_READ_PERMISSION_MISSING:")
        flag = "may_read_evidence" if evidence else "may_read"
        for sid in source_ids:
            policy = self.allowed_sources.get(sid, {})
            if policy.get(flag) is not True:
                raise PermissionError("SOURCE_READ_PERMISSION_MISSING:" + sid)
        return True

    def _write_status(self, relative, value):
        target = self.root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        raw = canonical(value)
        fd, tmp = tempfile.mkstemp(prefix=".wfd_status_", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, target)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def _request_identity_key(self, identity, fingerprint=None):
        key = sha(canonical([identity["dataset_id"], identity["trusted_actor_namespace"], identity["request_id"]]))
        return key, fingerprint

    def _persist_request_status(self, request_key, request_identity, fingerprint, state,
                                phases, output_results=None, snapshot_id=None,
                                formal_publication=None, errors=None, service_status=None,
                                publication_intent=None):
        record = {
            "format_version": "wfd.product-request-state/0.3",
            "service_version": SERVICE_VERSION,
            "request_key": request_key,
            "request_identity": copy.deepcopy(request_identity),
            "input_fingerprint": fingerprint,
            "state": state,
            "service_status": service_status or state,
            "phases": phases,
            "output_results": copy.deepcopy(output_results or []),
            "snapshot_id": snapshot_id,
            "formal_publication": copy.deepcopy(formal_publication),
            "publication_intent": publication_intent,
            "errors": copy.deepcopy(errors or []),
            "caller_id": self.caller_id,
        }
        self._write_status(f"catalog/product_service/request_status/{request_key}.json", record)
        return record

    def request_status(self, request_identity):
        """Read the last persisted state using the original request identity."""
        self.require_permission("read")
        key = self._request_identity_key(request_identity)[0]
        path = self.root / f"catalog/product_service/request_status/{key}.json"
        if path.is_file():
            return json.loads(path.read_text("utf-8"))
        return {"format_version": "wfd.product-request-state/0.3", "service_version": SERVICE_VERSION,
                "request_key": key, "request_identity": copy.deepcopy(request_identity),
                "state": "unknown", "phases": {}, "output_results": [], "snapshot_id": None,
                "formal_publication": None, "errors": [], "caller_id": self.caller_id}

    def _identity_info(self, doc):
        try:
            identity = doc.get("request_identity")
            if not isinstance(identity, dict):
                return None
            required = ("dataset_id", "trusted_actor_namespace", "request_id")
            if any(not isinstance(identity.get(k), str) or not identity.get(k) for k in required):
                return None
            return identity, self.engine._request_key(doc), self.engine._request_fingerprint(doc)
        except (KeyError, TypeError, ValueError):
            return None

    def _read_status(self, request_key):
        path = self.root / f"catalog/product_service/request_status/{request_key}.json"
        return json.loads(path.read_text("utf-8")) if path.is_file() else None

    @staticmethod
    def _terminal_state(state):
        return state in {
            "published_formal", "partially_published_formal",
            "published_sandbox", "partially_published_sandbox",
            "published_commit_pending_head", "partially_committed_pending_head",
        }

    def _replay_response(self, status):
        formal = status.get("formal_publication") or {}
        results = copy.deepcopy(status.get("output_results", []))
        summary = {name: sum(item.get("publication_state") == name for item in results)
                   for name in ("published_formal", "published_sandbox", "committed_pending_activation", "not_published")}
        engine_receipt = copy.deepcopy(self.engine._known_request(status["request_key"]))
        if engine_receipt is not None:
            engine_receipt["idempotent_replay"] = True
        return {
            "status": status.get("service_status", status.get("state")),
            "request_key": status["request_key"],
            "request_state": status.get("state"),
            "snapshot_id": status.get("snapshot_id"),
            "publication_summary": summary,
            "output_results": results,
            "engine_receipt": engine_receipt,
            "commit_receipt": engine_receipt,
            "formal_publication_receipt": formal.get("path"),
            "formal_publication_checks": (formal.get("record") or {}).get("checks"),
            "formal_publication_verified": bool(formal.get("path")),
            "idempotent_replay": True,
            "service_version": SERVICE_VERSION,
            "production_publishable": False,
        }

    def _persist_rejection(self, identity_info, code, message, phase):
        identity, key, fingerprint = identity_info
        existing = self._read_status(key)
        if existing and existing.get("input_fingerprint") != fingerprint:
            return False
        if existing:
            if self._terminal_state(existing.get("state")):
                return False
            if existing.get("state") in {"publication_unknown", "publication_pending_activation",
                                         "registered_not_published"}:
                existing["last_attempt"] = {
                    "phase": phase, "code": code, "message": message,
                    "at": _second_now(),
                }
                self._write_status(f"catalog/product_service/request_status/{key}.json", existing)
                return True
        self._persist_request_status(
            key, identity, fingerprint, "rejected",
            {"received": "accepted", "custody": "not_reached", "registration": "not_reached",
             "validation": "failed", "publication": "not_published"},
            [], None, None, [{"code": code, "message": message}], service_status="rejected",
        )
        return True

    def _reject_response(self, identity_info, code, message, persist=True):
        if identity_info and persist:
            self._persist_rejection(identity_info, code, message, "preflight")
        return {"status": "rejected", "errors": [{"code": code, "message": message}],
                "output_results": [], "request_key": identity_info[1] if identity_info else None,
                "request_state": "rejected", "production_publishable": False,
                "service_version": SERVICE_VERSION}

    def _current_authorization_errors(self, normalized):
        if not self.has_permission("submit"):
            return [_issue("CALLER_PERMISSION_DENIED", "Caller lacks submit role")]
        source = normalized.get("source_bundle", {})
        try:
            policies = self._source_policies(source)
        except ValueError as exc:
            return [_issue(str(exc).split(":")[0], str(exc))]
        errors = []
        bindings = source.get("_wfd_product_bindings", {})
        for out in normalized.get("outputs", []):
            admission = self._merge_source_admissions(
                source.get("_wfd_metadata_versions", {}).get(out["output_key"], {}).get("source_admission"),
                bindings.get(out["output_key"], {}).get("source_admission"))
            selected = admission.get("source_ids") or []
            if not selected:
                errors.append(_issue("SOURCE_ROLE_ASSIGNMENT_REQUIRED", "Output has no fixed source admission"))
                continue
            roles = admission.get("roles", {})
            authority = admission.get("definition_authority")
            for sid in selected:
                policy = self.allowed_sources.get(sid)
                if not policy or policy.get("may_submit") is not True:
                    errors.append(_issue("SOURCE_NOT_ADMITTED", "Explicit may_submit missing: " + sid))
                    continue
                allowed_roles = policy.get("allowed_roles", [])
                if set(roles.get(sid, [])) - set(allowed_roles):
                    errors.append(_issue("SOURCE_ROLE_DENIED", "Source role no longer allowed: " + sid))
                if set(roles.get(sid, [])) & {"definer", "first_publisher"}:
                    allowed = policy.get("allowed_authorities", [])
                    if not any(authority == x or str(authority).startswith(x + ".") for x in allowed):
                        errors.append(_issue("SOURCE_AUTHORITY_DENIED", "Definition authority no longer allowed: " + sid))
                domains = policy.get("allowed_domains", [])
                if domains and out.get("logical_domain") not in domains:
                    errors.append(_issue("SOURCE_SCOPE_DENIED",
                                         f"Source {sid} is not admitted for this logical domain"))
        if errors:
            return errors
        for binding in bindings.values():
            product = binding.get("product", {})
            if product.get("declaration", {}).get("measurement_nature") == "derived":
                if not self.has_permission("compute"):
                    errors.append(_issue("CALLER_PERMISSION_DENIED", "Caller lacks compute role for a derived result"))
                if not self.has_permission("read"):
                    errors.append(_issue("CALLER_PERMISSION_DENIED", "Caller lacks read role for derived inputs"))
                lineage = (source.get("_wfd_derived_lineage") or {}).get(
                    next((key for key, binding in bindings.items() if binding is not None
                          and binding.get("product") is product), None), {})
                for input_source_id in (lineage or {}).get("input_source_ids", []):
                    if self.allowed_sources.get(input_source_id, {}).get("may_read") is not True:
                        errors.append(_issue("SOURCE_READ_PERMISSION_MISSING",
                                             "Input source no longer readable: " + input_source_id))
            try:
                self._check_dependencies(product.get("contracts", {}).get("read", {}).get("dependencies", []),
                                         product.get("dataset_id"))
            except ValueError as exc:
                errors.append(_issue(str(exc).split(":")[0], str(exc)))
            except PermissionError as exc:
                errors.append(_issue("CALLER_PERMISSION_DENIED", str(exc)))
        return errors

    def _capability_schema_closure(self):
        schema = self.engine.validator.schema
        root_id = schema.get("$id", "wfd-ingest.schema.json")
        resources = getattr(getattr(self.engine.validator, "_registry", None), "_resources", {})
        seen = {}
        queue = [root_id]
        while queue:
            uri = queue.pop(0)
            if uri in seen:
                continue
            resource = resources.get(uri)
            contents = resource.contents if resource is not None else None
            if contents is None:
                continue
            seen[uri] = sha(canonical(contents))
            refs = set()
            def walk(value):
                if isinstance(value, dict):
                    if isinstance(value.get("$ref"), str):
                        refs.add(value["$ref"].split("#", 1)[0])
                    for child in value.values():
                        walk(child)
                elif isinstance(value, list):
                    for child in value:
                        walk(child)
            walk(contents)
            queue.extend(sorted(refs))
        closure = sorted(seen.items())
        return {
            "root": root_id,
            "root_sha256": sha(canonical(schema)),
            "references": [{"id": uri, "sha256": digest} for uri, digest in closure if uri != root_id],
            "closure_sha256": sha(canonical(closure)),
        }

    def capabilities(self):
        """Machine-readable scope of this running 0.3 product service."""
        try:
            schema_id = self.engine.validator.schema.get("$id", "wfd-ingest.schema.json")
        except AttributeError:
            schema_id = "wfd-ingest.schema.json"
        return {
            "format_version": "wfd.product-capabilities/0.2",
            "service_version": SERVICE_VERSION,
            "api_semantic_version": "wfd.product-service-semantics/1.0",
            "contract_version": CONTRACT_VERSION,
            "ingest_protocol": "wfd.ingest/1.3-candidate",
            "structural_validation": {
                "enforced": True,
                "validator": "jsonschema Draft202012Validator",
                "schema_id": schema_id,
                "schema": self._capability_schema_closure(),
                "note": "engine validator runs on submit before product-service contract checks",
            },
            "operations": {
                "submit": {
                    "supported": True,
                    "required_fields": ["protocol_version", "request_identity", "intent",
                                        "producer_namespace", "expected_parent_snapshot_id",
                                        "outputs", "source_bundle"],
                    "output_fields": ["output_key", "logical_domain", "subject", "definition_mode",
                                      "definition_ref", "new_definition_declaration", "input_mode",
                                      "coverage", "payload", "evidence_refs"],
                    "required_source_extensions": [
                        "source_bundle.product_service.version",
                        "source_bundle.product_service.outputs[output_key]",
                        "source_bundle.product_service.outputs[output_key].read_dependencies",
                    ],
                    "status_states": ["published_formal", "partially_published_formal",
                                      "published_sandbox", "partially_published_sandbox",
                                      "published_commit_pending_head", "partially_committed_pending_head",
                                      "registered_not_published", "publication_unknown", "rejected"],
                    "request_states": ["published_formal", "published_sandbox",
                                       "publication_pending_activation", "published_commit_pending_head",
                                       "partially_committed_pending_head", "registered_not_published",
                                       "publication_unknown", "rejected"],
                    "recovery_actions": {
                        "publication_unknown": "retry the same request_identity; verify actual commit and current permissions",
                        "publication_pending_activation": "retry after HEAD activation; do not treat as sandbox",
                        "published_commit_pending_head": "activate the committed snapshot; do not republish",
                        "partially_committed_pending_head": "activate the committed snapshot; inspect rejected outputs",
                    },
                    "result_states": ["published_formal", "partially_published_formal",
                                      "published_sandbox", "partially_published_sandbox",
                                      "published_commit_pending_head", "partially_committed_pending_head",
                                      "registered_not_published", "publication_unknown", "rejected"],
                },
                "request_status": {"supported": True, "key": "original request_identity"},
                "contract_discovery": {"supported": True, "operation": "discover_products"},
                "fixed_read": {"supported": True, "requires_snapshot": True},
                "evidence_trace": {"supported": True, "requires_caller": "read_evidence",
                                   "requires_source": "may_read_evidence"},
                "company_view": {"supported": True},
                "calendar_read": {"supported": True},
                "source_provenance": {
                    "supported": True,
                    "scope": "per-output first_publisher/republisher chain, field evidence and independent-origin count",
                    "conflict_modes": sorted(CONFLICT_MODES),
                    "independent_origin_key": "first_publisher_id + first_publication_id + original_content_sha256",
                },
                "derived_submission": {
                    "supported": True,
                    "execution": "external",
                    "requires_caller_role": "compute",
                    "requires": ["fixed input dataset/product/snapshot/content digest",
                                 "custodied method and parameter version/digest",
                                 "verified processing evidence", "warmup and validity state"],
                },
            },
            "semantic_templates": (lambda meta: None if meta is None else {
                "supported": True,
                "template_ref": meta["template_ref"],
                "status": meta["status"],
                "business_group_count": len(meta["business_groups"]),
                "finance_subdomain_count": len(meta["finance_subdomains"]),
                "note": "templates are discovery dimensions, not registered products or an allowlist",
            })(self._semantic_template_metadata()),
            "semantic_context": {
                "version": "wfd.semantic-context/1.0",
                "content_nature_dimension": "orthogonal to measurement_nature",
                "field_level_overrides": True,
                "unknown_axes": "explicit and comparison-limiting; no default guessed",
            },
            "contract_identity": {
                "roles": ["semantic", "read_layout", "algorithm_dependency", "update_release"],
                "independent_id_version_digest": True,
                "bundle_ref": True,
            },
            "source_permissions": sorted(SOURCE_FLAGS),
            "caller_roles": sorted(self.caller_roles),
            "unit_semantics": {
                "source": "trusted constructor unit_registry; persisted in semantic contract",
                "unknown_unit": "registered only, not formally published",
            },
            "unsupported": [
                {"operation": "external_machine_process", "reason": "P6 thin adapter not implemented"},
                {"operation": "delta_packages", "reason": "P5 not implemented"},
                {"operation": "strict_historical_eligibility_slicing", "reason": "P5 not implemented"},
                {"operation": "full_unit_catalogue", "reason": "P2 catalogue not completed"},
                {"operation": "derived_recompute", "reason": "WFD does not compute; an external producer must submit fixed results"},
                {"operation": "windows_and_pull_disk_validation", "reason": "P7 separate platform/removal acceptance not completed"},
            ],
        }

    @staticmethod
    def _semantic_template_path():
        return Path(__file__).resolve().parent.parent / "protocol/templates/wfd-semantic-templates.json"

    def _semantic_template_metadata(self):
        path = self._semantic_template_path()
        if not path.is_file():
            return None
        raw = path.read_bytes()
        data = json.loads(raw)
        return {"template_ref": {"kind": "semantic_template", "namespace": "wfd.product",
                                 "id": "tpl_" + sha(raw)[:24],
                                 "version": "v_" + sha(raw)[:16],
                                 "digest": "sha256:" + sha(raw),
                                 "resolution": "pinned", "required": False},
                "format_version": data.get("format_version"),
                "status": data.get("status"),
                "business_groups": copy.deepcopy(data.get("business_groups", [])),
                "finance_subdomains": copy.deepcopy(data.get("finance_subdomains", [])),
                "finance_leaf_count": data.get("finance_leaf_count"),
                "finance_detail_coverage": copy.deepcopy(data.get("finance_detail_coverage")),
                "not_an_allowlist": data.get("not_an_allowlist")}

    def discover_semantic_templates(self):
        """Return template structure only; never register products or data."""
        self.require_permission("read")
        metadata = self._semantic_template_metadata()
        if metadata is None:
            raise ValueError("SEMANTIC_TEMPLATE_NOT_FOUND")
        return metadata

    def _read_json(self, relative):
        return json.loads((self.root / relative).read_text("utf-8"))

    def register_evidence(self, path):
        """Custody the actual supplied bytes; do not assert a licence or date."""
        self.require_permission("evidence_write")
        raw = Path(path).read_bytes()
        digest = sha(raw)
        with writer_lock(self.root):
            self.engine._write_immutable(f"evidence/sha256/{digest}", raw)
            meta = f"catalog/product_service/evidence/{digest}.json"
            if not (self.root / meta).exists():
                self.engine._write_immutable(meta, canonical({
                    "content_sha256": "sha256:" + digest,
                    "received_time": _second_now(), "size": len(raw),
                    "original_name": Path(path).name}))
        return {"ref_kind": "content", "ref_id": "e_" + digest[:24],
                "content_sha256": "sha256:" + digest,
                "binding_digest": None, "locator_generation": None}

    def _time_errors(self, value):
        errors = list(self.engine.validator.evolve(schema={"$ref": COMMON + "TimeWithPrecision"}).iter_errors(value))
        if errors:
            return [_issue("SOURCE_TIME_INVALID", errors[0].message)]
        return check_time(value, "source_bundle.public_time")

    def _definition(self, output, dataset_id, extension=None):
        extension = extension or {}
        if output["definition_mode"] == "create":
            declaration = copy.deepcopy(output["new_definition_declaration"])
            if "semantic_context" in extension:
                if (declaration.get("semantic_context") is not None
                        and declaration.get("semantic_context") != extension["semantic_context"]):
                    raise ValueError("SEMANTIC_CONTEXT_CONFLICT")
                declaration["semantic_context"] = copy.deepcopy(extension["semantic_context"])
            if "field_semantic_context" in extension:
                if (declaration.get("field_semantic_context") is not None
                        and declaration.get("field_semantic_context") != extension["field_semantic_context"]):
                    raise ValueError("SEMANTIC_CONTEXT_CONFLICT")
                declaration["field_semantic_context"] = copy.deepcopy(extension["field_semantic_context"])
            declaration, semantic_issues = normalize_semantic_context(
                declaration, output["payload"]["kind"],
                allow_deterministic_without_lineage=(getattr(self, "profile", None) == "data_only"))
            declaration, algorithm_issues = normalize_algorithm_definition(declaration)
            semantic_issues.extend(algorithm_issues)
            if semantic_issues:
                first = semantic_issues[0]
                raise ValueError(first["code"] + ":" + first["message"])
        else:
            if any(key in extension for key in ("semantic_context", "field_semantic_context")):
                raise ValueError("SEMANTIC_CONTEXT_REUSE_NOT_ALLOWED")
            ref = output["definition_ref"]
            digest = (ref.get("digest") or "").removeprefix("sha256:")
            if len(digest) != 64:
                raise ValueError("DEFINITION_DIGEST_REQUIRED")
            path = f"catalog/product_service/definitions/{digest}.json"
            if not (self.root / path).exists():
                raise ValueError("DEFINITION_NOT_REGISTERED")
            record = self._read_json(path)
            if record["definition_ref"] != ref:
                raise ValueError("DEFINITION_REFERENCE_MISMATCH")
            declaration = record["declaration"]
            if sha(canonical(declaration)) != digest:
                raise ValueError("DEFINITION_DIGEST_MISMATCH")
        payload_kind = output["payload"]["kind"]
        if payload_kind == "metadata_revision":
            if output["definition_mode"] != "reuse":
                raise ValueError("COVERAGE_REVISION_REUSE_REQUIRED")
            prior_kind = None
            for path in (self.root / "catalog/product_service/products").rglob("*.json"):
                try:
                    candidate = self._read_json(path.relative_to(self.root))
                except (OSError, ValueError):
                    continue
                if candidate.get("definition_ref") == ref:
                    prior_kind = candidate.get("payload_kind")
                    break
            if prior_kind is None:
                raise ValueError("COVERAGE_REVISION_PRODUCT_REQUIRED")
            payload_kind = prior_kind
        contract_issues = validate_definition(declaration, payload_kind)
        if contract_issues:
            first = contract_issues[0]
            raise ValueError(first["code"] + ":" + first["message"])
        digest = sha(canonical(declaration))
        ref = {"kind": "definition_version", "dataset_id": dataset_id,
               "namespace": "wfd.product", "id": "def_" + digest[:24],
               "version": "v_" + digest[:16], "digest": "sha256:" + digest,
               "resolution": "pinned", "required": True, "dependency_type": "read"}
        return copy.deepcopy(declaration), ref

    @staticmethod
    def _contracts_with_parts(contracts):
        result = copy.deepcopy(contracts)
        result["contract_set_version"] = CONTRACT_VERSION
        result["part_digests"] = {
            part: "sha256:" + sha(canonical(result[part]))
            for part in ("semantic", "read", "compute_dependencies", "publication")
        }
        return result

    def _build_contract_refs(self, product, contracts):
        refs = {}
        for role, body_key in CONTRACT_ROLE_BODY.items():
            body = contracts[body_key]
            digest = sha(canonical(body))
            stable = sha(canonical([product["dataset_id"], product["product_id"], role]))[:24]
            ref = {"kind": "contract", "role": role,
                   "dataset_id": product["dataset_id"], "namespace": "wfd.product",
                   "id": "contract_" + role + "_" + stable,
                   "version": "v_" + digest[:16], "digest": "sha256:" + digest,
                   "resolution": "pinned", "required": True, "dependency_type": "read"}
            self.engine._write_immutable(
                f"catalog/product_service/contracts/{role}/{digest}.json",
                canonical(body))
            refs[role] = ref
        bundle = {"format_version": "wfd.contract-bundle/1.0",
                  "product_id": product["product_id"],
                  "dataset_id": product["dataset_id"],
                  "roles": sorted(refs),
                  "contracts": {role: copy.deepcopy(refs[role]) for role in sorted(refs)}}
        bundle_digest = sha(canonical(bundle))
        bundle_ref = {"kind": "contract_bundle", "dataset_id": product["dataset_id"],
                      "namespace": "wfd.product",
                      "id": "cb_" + bundle_digest[:24],
                      "version": "v_" + bundle_digest[:16],
                      "digest": "sha256:" + bundle_digest,
                      "roles": sorted(refs),
                      "resolution": "pinned", "required": True, "dependency_type": "read"}
        self.engine._write_immutable(
            f"catalog/product_service/contract_bundles/{bundle_digest}.json",
            canonical(bundle))
        return refs, bundle_ref

    def _verify_contract_refs(self, product, verify_files=True):
        refs = product.get("contract_refs")
        bundle_ref = product.get("contract_bundle_ref")
        if refs is None and bundle_ref is None:
            return True
        if set(refs or {}) != set(CONTRACT_ROLE_BODY):
            raise ValueError("CONTRACT_ROLE_SET_MISMATCH")
        contracts = product.get("contracts") or {}
        for role, body_key in CONTRACT_ROLE_BODY.items():
            ref = refs[role]
            body = contracts.get(body_key)
            if body is None:
                raise ValueError("CONTRACT_BODY_MISSING:" + role)
            digest = sha(canonical(body))
            stable = sha(canonical([product["dataset_id"], product["product_id"], role]))[:24]
            if (ref.get("digest") != "sha256:" + digest
                    or ref.get("role") != role
                    or ref.get("dataset_id") != product["dataset_id"]
                    or ref.get("id") != "contract_" + role + "_" + stable
                    or ref.get("version") != "v_" + digest[:16]):
                raise ValueError("CONTRACT_DIGEST_MISMATCH:" + role)
            if verify_files:
                path = self.root / f"catalog/product_service/contracts/{role}/{digest}.json"
                if not path.is_file():
                    raise ValueError("CONTRACT_REF_NOT_FOUND:" + role)
                raw = path.read_bytes()
                if sha(raw) != digest:
                    raise ValueError("CONTRACT_FILE_DIGEST_MISMATCH:" + role)
                stored = json.loads(raw)
                if canonical(stored) != canonical(body):
                    raise ValueError("CONTRACT_REF_MISMATCH:" + role)
        bundle = {"format_version": "wfd.contract-bundle/1.0",
                  "product_id": product["product_id"],
                  "dataset_id": product["dataset_id"],
                  "roles": sorted(refs),
                  "contracts": {role: refs[role] for role in sorted(refs)}}
        bundle_digest = sha(canonical(bundle))
        if (bundle_ref.get("digest") != "sha256:" + bundle_digest
                or bundle_ref.get("roles") != sorted(refs)
                or bundle_ref.get("version") != "v_" + bundle_digest[:16]):
            raise ValueError("CONTRACT_BUNDLE_DIGEST_MISMATCH")
        if verify_files:
            bundle_path = self.root / f"catalog/product_service/contract_bundles/{bundle_digest}.json"
            if not bundle_path.is_file() or sha(bundle_path.read_bytes()) != bundle_digest:
                raise ValueError("CONTRACT_BUNDLE_REF_NOT_FOUND")
            stored_bundle = json.loads(bundle_path.read_bytes())
            if canonical(stored_bundle) != canonical(bundle):
                raise ValueError("CONTRACT_BUNDLE_REF_MISMATCH")
        return True

    @staticmethod
    def _current_business_contracts(contracts, declaration):
        if current_only_business(declaration):
            contracts["read"].update(perspectives=["snapshot_contents"],
                                     business_snapshot="active_head", include_history=False,
                                     technical_fixed_snapshot_read=True)
            contracts["publication"]["business_view"] = "unique_current_leaf"
        return contracts

    @staticmethod
    def _definition_relation(prior, declaration):
        if prior is None:
            return "initial"
        if prior.get("declaration") == declaration:
            return "same"
        old, new = prior.get("declaration", {}), declaration
        field_keys = {"field_definitions", "field_semantic_context"}
        old_non_fields = {k: v for k, v in old.items() if k not in field_keys}
        new_non_fields = {k: v for k, v in new.items() if k not in field_keys}
        if old_non_fields != new_non_fields:
            return "breaking"
        old_fields = {f.get("field_code"): f for f in old.get("field_definitions", []) if isinstance(f, dict)}
        new_fields = {f.get("field_code"): f for f in new.get("field_definitions", []) if isinstance(f, dict)}
        old_contexts = old.get("field_semantic_context") or {}
        new_contexts = new.get("field_semantic_context") or {}
        if (set(old_fields).issubset(new_fields)
                and all(new_fields[k] == v for k, v in old_fields.items())
                and all(new_contexts.get(k) == old_contexts.get(k) for k in old_fields)):
            return "compatible_additive"
        return "breaking"

    def _family_records(self, dataset_id, output, declaration):
        family_id = "pf_" + sha(canonical([
            dataset_id, output["logical_domain"], output["subject"],
            declaration.get("semantic_code"), declaration.get("definition_authority"),
        ]))[:24]
        records = []
        product_dir = self.root / "catalog/product_service/products"
        if product_dir.is_dir():
            for path in product_dir.rglob("*.json"):
                try:
                    candidate = self._read_json(path.relative_to(self.root))
                except (OSError, ValueError):
                    continue
                candidate_decl = candidate.get("declaration", {})
                if (candidate.get("dataset_id") == dataset_id
                        and candidate.get("logical_domain") == output["logical_domain"]
                        and candidate.get("subject") == output["subject"]
                        and candidate_decl.get("semantic_code") == declaration.get("semantic_code")
                        and candidate_decl.get("definition_authority") == declaration.get("definition_authority")):
                    records.append(candidate)
        return family_id, records

    def _definition_family(self, dataset_id, output, declaration):
        """Return family, latest *published* predecessor, and max registry sequence.

        Failed/draft registrations keep their facts but cannot become identity
        predecessors.  The registration sequence is allocated separately from
        the published binding used for compatibility and parent_ref.
        """
        family_id, records = self._family_records(dataset_id, output, declaration)
        max_sequence = max((r.get("definition_sequence", 1) for r in records), default=0)
        prior = None
        head = self.engine.head()
        if head:
            for entry in head.get("files", []):
                binding = entry.get("source_bundle", {}).get("_wfd_product_bindings", {}).get(entry.get("output_key"))
                candidate = (binding or {}).get("product")
                if not candidate:
                    continue
                candidate_decl = candidate.get("declaration", {})
                if (candidate.get("dataset_id") == dataset_id
                        and candidate.get("logical_domain") == output["logical_domain"]
                        and candidate.get("subject") == output["subject"]
                        and candidate_decl.get("semantic_code") == declaration.get("semantic_code")
                        and candidate_decl.get("definition_authority") == declaration.get("definition_authority")):
                    if prior is None or candidate.get("definition_sequence", 1) > prior.get("definition_sequence", 1):
                        prior = candidate
        return family_id, prior, max_sequence

    def _persistent_unit_definitions(self, declaration):
        codes = []
        top = declaration.get("unit_code")
        if top not in {None, "", "per_field", "not_applicable"}:
            codes.append(top)
        for field in declaration.get("field_definitions", []):
            code = field.get("unit_code") if isinstance(field, dict) else None
            if code not in {None, "", "per_field", "not_applicable"}:
                codes.append(code)
        result = {}
        for code in sorted(set(codes)):
            definition = copy.deepcopy(self.unit_registry.get(code, {}))
            result[code] = {"definition": definition,
                            "digest": "sha256:" + sha(canonical({"code": code, "definition": definition}))}
        return result

    @staticmethod
    def _data_only_dependencies(declaration, dataset_id, extension):
        compiled = product_calendar.dependencies(declaration, dataset_id)
        requested = (extension or {}).get("read_dependencies") or []
        ordered = sorted(compiled, key=lambda dep: canonical(dep))
        if canonical(ordered) != canonical(
                sorted(requested, key=lambda dep: canonical(dep))):
            raise ValueError("DATA_ONLY_READ_DEPENDENCY_MISMATCH")
        return ordered

    def _verify_fixed_definition_version(self, *, product_id, sequence, family_id,
                                         dataset_id, output, declaration, ref,
                                         dependencies):
        """Verify the real definition_N record, not just a snapshot product."""
        if not isinstance(product_id, str) or not product_id:
            raise ValueError("DATA_ONLY_REGISTRATION_IDENTITY_MISMATCH:product_id")
        if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 1:
            raise ValueError("DATA_ONLY_REGISTRATION_IDENTITY_MISMATCH:sequence")
        version_rel = (f"catalog/product_service/products/{product_id}/"
                       f"definition_{sequence}.json")
        path = self.root / version_rel
        if path.is_symlink() or not path.is_file():
            raise ValueError("DATA_ONLY_REGISTRATION_VERSION_MISSING:" + version_rel)
        record = self._read_json(version_rel)
        if (record.get("product_id") != product_id
                or record.get("definition_sequence") != sequence):
            raise ValueError("DATA_ONLY_REGISTRATION_IDENTITY_MISMATCH:" + version_rel)
        if (record.get("product_family_id") != family_id
                or record.get("dataset_id") != dataset_id
                or record.get("logical_domain") != output.get("logical_domain")
                or canonical(record.get("subject")) != canonical(output.get("subject"))):
            raise ValueError("DATA_ONLY_REGISTRATION_SCOPE_MISMATCH:" + version_rel)
        if (canonical(record.get("declaration")) != canonical(declaration)
                or canonical(record.get("definition_ref")) != canonical(ref)):
            raise ValueError("DATA_ONLY_REGISTRATION_DECLARATION_MISMATCH:" + version_rel)
        stored = ((record.get("contracts") or {}).get("read") or {}
                  ).get("dependencies")
        if canonical(sorted(stored or [], key=canonical)) != canonical(
                sorted(dependencies, key=canonical)):
            raise ValueError("DATA_ONLY_REGISTRATION_DEPENDENCY_MISMATCH:" + version_rel)
        return record

    def _register(self, output, dataset_id, extension=None):
        if not self.can_register:
            raise ValueError("REGISTRATION_PERMISSION_DENIED")
        declaration, ref = self._definition(output, dataset_id, extension)
        data_only = bool(extension and extension.get("_wfd_data_only") is True)
        compiled_dependencies = []
        if data_only:
            compiled_dependencies = self._data_only_dependencies(
                declaration, dataset_id, extension)
        family_id, prior_family, max_sequence = self._definition_family(dataset_id, output, declaration)
        compatibility = self._definition_relation(prior_family, declaration)
        current_units = self._persistent_unit_definitions(declaration)
        prior_units = (prior_family or {}).get("contracts", {}).get("semantic", {}).get("unit_definitions", {})
        for code, entry in current_units.items():
            if not entry.get("definition"):
                continue
            if code in prior_units and entry != prior_units[code]:
                raise ValueError("UNIT_SEMANTIC_CONFLICT:" + code)
        if prior_family and compatibility == "same":
            if data_only:
                self._verify_fixed_definition_version(
                    product_id=prior_family.get("product_id"),
                    sequence=prior_family.get("definition_sequence"),
                    family_id=family_id, dataset_id=dataset_id, output=output,
                    declaration=declaration, ref=ref,
                    dependencies=compiled_dependencies)
            return prior_family, "reused"
        sequence = max_sequence + 1
        if prior_family and compatibility in {"same", "compatible_additive"}:
            pid = prior_family["product_id"]
        elif prior_family and compatibility == "breaking":
            pid = "p_" + sha(canonical([family_id, "breaking", sequence, declaration]))[:24]
        else:
            pid = "p_" + sha(canonical([family_id, "stable_product"]))[:24]
        merged_units = copy.deepcopy(prior_units) if prior_family else {}
        merged_units.update({code: entry for code, entry in current_units.items() if entry.get("definition")})
        semantic_context = copy.deepcopy(declaration.get("semantic_context"))
        contracts = {
            "semantic": {"definition_ref": ref, "fields": declaration.get("field_definitions", []),
                         "unit_code": declaration.get("unit_code"),
                         "measurement_nature": declaration.get("measurement_nature"),
                         "semantic_context": semantic_context,
                         "semantic_context_version": (semantic_context or {}).get("version", "legacy"),
                         "semantic_context_digest": ("sha256:" + sha(canonical(semantic_context))
                                                     if semantic_context is not None else None),
                         "field_semantic_context": copy.deepcopy(declaration.get("field_semantic_context")),
                         "unit_definitions": merged_units},
            "read": {"perspectives": ["snapshot_contents", "market_known_at", "system_held_at"],
                     "held_scope": "received_structured", "fixed_snapshot_required": True,
                     "primary_key": "event_id" if output["payload"]["kind"] == "event_records" else "business_key",
                     "business_time_field": {"event_records": "event_time",
                                             "relation_edges": "effective_period"}.get(
                                                 output["payload"]["kind"], "observation_time"),
                     "dependencies": []},
            "compute_dependencies": {"execution": "external", "dependencies": [],
                                     "derived_submission": "verified_fixed_lineage"},
            "publication": {"updates": "append_only", "duplicate_keys": "reject",
                            "revision_modes": sorted(REVISION_MODES), "withdrawal": "tombstone",
                            "formal_publish_requires": ["caller_publish_role", "source_formal_grant",
                                                        "validated_contracts", "verified_dependencies",
                                                        "custodied_evidence", "verified_snapshot"]},
        }
        if data_only:
            contracts["read"]["dependencies"] = copy.deepcopy(compiled_dependencies)
        if extension and extension.get("_wfd_data_only") is True:
            contracts["publication"] = {
                "updates": "immutable_logical_versions", "duplicate_keys": "reject_without_revision",
                "revision_modes": sorted(REVISION_MODES), "withdrawal": "tombstone",
                "physical_storage": "append_only",
                "compaction": "requires_preserving_per_row_bindings",
                "formal_publish_requires": ["caller_publish_role", "validated_contracts",
                                            "verified_dependencies", "verified_snapshot",
                                            "active_head_matches"],
            }
            algorithm = declaration.get("algorithm_definition")
            if algorithm is not None:
                contracts["compute_dependencies"] = {
                    "execution": "not_executed_by_wfd",
                    "derived_submission": "business_definition_only",
                    "result_definition": copy.deepcopy(algorithm),
                    "dependencies": [],
                    "input_custody": "BD_not_stored",
                }
            else:
                contracts["compute_dependencies"] = {
                    "execution": "not_applicable",
                    "derived_submission": "not_required",
                    "dependencies": [],
                }
        if data_only:
            self._current_business_contracts(contracts, declaration)
        record = {"service_version": SERVICE_VERSION, "product_id": pid,
                  "dataset_id": dataset_id, "logical_domain": output["logical_domain"],
                  "subject": output["subject"], "payload_kind": output["payload"]["kind"],
                  "declaration": declaration, "definition_ref": ref,
                  "semantic_context": semantic_context,
                  "semantic_context_version": (semantic_context or {}).get("version", "legacy"),
                  "semantic_context_digest": ("sha256:" + sha(canonical(semantic_context))
                                              if semantic_context is not None else None),
                  "field_semantic_context": copy.deepcopy(declaration.get("field_semantic_context")),
                  "product_family_id": family_id,
                  "definition_sequence": sequence,
                  "definition_parent_ref": (prior_family.get("definition_ref") if prior_family else None),
                  "definition_compatibility": compatibility,
                  "contracts": self._contracts_with_parts(contracts)}
        version_path = f"catalog/product_service/products/{pid}/definition_{sequence}.json"
        if (self.root / version_path).exists():
            prior = self._read_json(version_path)
            stable = ("product_id", "dataset_id", "logical_domain", "subject", "payload_kind", "declaration", "definition_ref")
            if any(prior[k] != record[k] for k in stable):
                raise ValueError("PRODUCT_CONTRACT_CONFLICT")
            if data_only:
                self._verify_fixed_definition_version(
                    product_id=pid, sequence=sequence, family_id=family_id,
                    dataset_id=dataset_id, output=output,
                    declaration=declaration, ref=ref,
                    dependencies=compiled_dependencies)
            return prior, "reused"
        digest = ref["digest"].removeprefix("sha256:")
        self.engine._write_immutable(f"catalog/product_service/definitions/{digest}.json",
                                     canonical({"definition_ref": ref, "declaration": declaration}))
        self.engine._write_immutable(version_path, canonical(record))
        # Legacy flat template remains readable for pre-0.3 tools; never
        # overwrite an existing one, and never use it to infer a newer version.
        flat = f"catalog/product_service/products/{pid}.json"
        if not (self.root / flat).exists():
            self.engine._write_immutable(flat, canonical(record))
        return record, "registered"

    def _extensions(self, source, output_keys):
        """0.2 input extension, inside the existing extensible source bundle.

        product_service = {version, outputs: {output_key: {
            read_dependencies: [{dataset_id, product_id, snapshot_id, role, required: true}],
            revisions: {logical_key: {previous: <read.record_ref>, reason: <text>}}
        }}}. Omitted dependencies mean an explicit empty binding for this batch.
        """
        extension = source.get("product_service", {})
        if not extension:
            return {}
        if not isinstance(extension, dict) or extension.get("version") not in SUPPORTED_EXTENSION_VERSIONS:
            raise ValueError("PRODUCT_SERVICE_VERSION_UNSUPPORTED")
        if set(extension) - {"version", "outputs", "consistency_groups"} or not isinstance(extension["outputs"], dict):
            raise ValueError("PRODUCT_SERVICE_EXTENSION_INVALID")
        groups = extension.get("consistency_groups", {})
        if not isinstance(groups, dict) or any(
                not isinstance(members, list) or not members or len(set(members)) != len(members)
                or any(not isinstance(key, str) or key not in output_keys for key in members)
                for members in groups.values()):
            raise ValueError("CONSISTENCY_GROUP_INVALID")
        if set(extension["outputs"]) - set(output_keys):
            raise ValueError("PRODUCT_SERVICE_OUTPUT_UNKNOWN")
        for value in extension["outputs"].values():
            if not isinstance(value, dict) or set(value) - {
                    "read_dependencies", "revisions", "source_lineage",
                    "conflict_resolution", "derived_lineage",
                    "semantic_context", "field_semantic_context"}:
                raise ValueError("PRODUCT_SERVICE_OUTPUT_INVALID")
            if not isinstance(value.get("read_dependencies", []), list) or not isinstance(value.get("revisions", {}), dict):
                raise ValueError("PRODUCT_SERVICE_OUTPUT_INVALID")
            if "source_lineage" in value and not isinstance(value["source_lineage"], list):
                raise ValueError("PRODUCT_SERVICE_OUTPUT_INVALID")
            if "conflict_resolution" in value and not isinstance(value["conflict_resolution"], dict):
                raise ValueError("PRODUCT_SERVICE_OUTPUT_INVALID")
            if "derived_lineage" in value and not isinstance(value["derived_lineage"], dict):
                raise ValueError("PRODUCT_SERVICE_OUTPUT_INVALID")
            for key in ("semantic_context", "field_semantic_context"):
                if key in value and not isinstance(value[key], (dict, type(None))):
                    raise ValueError("PRODUCT_SERVICE_OUTPUT_INVALID")
        return {"outputs": extension["outputs"], "consistency_groups": groups}

    def _select_metadata(self, snapshot, product_id, perspective=None, at=None):
        candidates = [entry for entry in snapshot.get("metadata_versions", [])
                      if entry.get("product_id") == product_id]
        if perspective in {"market_known_at", "system_held_at"} and at is not None:
            eligible = []
            for entry in candidates:
                instant = entry.get("public_time") if perspective == "market_known_at" else entry.get("received_time")
                if eligibility_at(instant, at, mode=perspective)["decision"] == "eligible":
                    eligible.append(entry)
            candidates = eligible
        if not candidates:
            return None
        return max(candidates, key=lambda item: item.get("metadata_sequence", 0))

    def _head_product_binding(self, product_id, head):
        """Resolve the product's latest batch from snapshot parent/child diffs.

        HEAD file arrays are cumulative; neither array order nor receipt time is
        a version order.  Walk newest-to-oldest and compare file identities with
        the immediate parent.  New files in the newest snapshot containing the
        product are that product's latest publication batch.
        """
        if not head:
            return None
        snapshot = head
        seen = set()
        while snapshot:
            sid = snapshot.get("snapshot_id")
            if not sid or sid in seen:
                break
            seen.add(sid)
            entries = []
            for entry in snapshot.get("files", []):
                if entry.get("product_id") != product_id:
                    continue
                binding = entry.get("source_bundle", {}).get("_wfd_product_bindings", {}).get(entry.get("output_key"))
                product = (binding or {}).get("product")
                if product and product.get("product_id") == product_id:
                    entries.append((entry, product))
            if entries:
                parent_id = snapshot.get("parent_snapshot_id")
                parent = None
                if parent_id:
                    try:
                        parent = self.engine._valid_snapshot_exact(
                            parent_id, verify_payloads=False)
                    except (ValueError, OSError):
                        parent = None
                parent_keys = set()
                if parent:
                    for entry in parent.get("files", []):
                        if entry.get("product_id") == product_id:
                            parent_keys.add((entry.get("file_relpath"), entry.get("file_sha256")))
                new_entries = [item for item in entries
                               if (item[0].get("file_relpath"), item[0].get("file_sha256")) not in parent_keys]
                selected = new_entries or (entries if parent is None else [])
                if selected:
                    merged = copy.deepcopy(selected[0][1])
                    dependencies = []
                    for _, product in selected:
                        dependencies.extend(product.get("contracts", {}).get("read", {}).get("dependencies", []))
                    unique = {}
                    for dep in dependencies:
                        unique[canonical(dep)] = copy.deepcopy(dep)
                    merged.setdefault("contracts", {}).setdefault("read", {})["dependencies"] = [
                        unique[key] for key in sorted(unique)
                    ]
                    metadata = self._select_metadata(head, product_id)
                    if metadata:
                        merged["coverage"] = copy.deepcopy(metadata.get("coverage"))
                        merged["coverage_ref"] = metadata.get("coverage_ref")
                        merged["coverage_predecessor_ref"] = metadata.get("predecessor_ref")
                    return merged
            parent_id = snapshot.get("parent_snapshot_id")
            if not parent_id:
                break
            try:
                snapshot = self.engine._valid_snapshot_exact(
                    parent_id, verify_payloads=False)
            except (ValueError, OSError):
                break
        return None
    def _bind_contract(self, product, extension, prior_product=None, derived_lineage=None):
        bound = copy.deepcopy(product)
        prior_dependencies = copy.deepcopy((prior_product or {}).get("contracts", {}).get("read", {}).get("dependencies", []))
        if "read_dependencies" not in extension and prior_dependencies:
            raise ValueError("READ_DEPENDENCY_DECLARATION_REQUIRED")
        dependencies = extension.get("read_dependencies", [])
        for dep in dependencies:
            if not isinstance(dep, dict) or set(dep) != {"dataset_id", "product_id", "snapshot_id", "role", "required"}:
                raise ValueError("READ_DEPENDENCY_INVALID")
            if not all(isinstance(dep[k], str) and dep[k] for k in ("dataset_id", "product_id", "snapshot_id", "role")):
                raise ValueError("READ_DEPENDENCY_INVALID")
            if dep["required"] is not True:
                raise ValueError("OPTIONAL_READ_DEPENDENCY_NOT_IMPLEMENTED")
        for prior in prior_dependencies:
            if prior.get("required") is not True:
                continue
            if not any(dep.get("role") == prior.get("role")
                       and dep.get("dataset_id") == prior.get("dataset_id")
                       and dep.get("required") is True
                       for dep in dependencies):
                raise ValueError("READ_DEPENDENCY_ROLE_MISSING:" + str(prior.get("role")))
        self._check_dependencies(dependencies, product["dataset_id"])
        bound["service_version"] = SERVICE_VERSION
        bound["contracts"]["read"]["dependencies"] = sorted(copy.deepcopy(dependencies), key=lambda d: canonical(d))
        data_only = extension.get("_wfd_data_only") is True
        bound["contracts"]["publication"] = {"updates": "immutable_logical_versions", "duplicate_keys": "reject_without_revision",
            "revision_modes": sorted(REVISION_MODES), "withdrawal": "tombstone", "physical_storage": "append_only",
            "compaction": "requires_preserving_per_row_bindings",
            "formal_publish_requires": (["caller_publish_role", "validated_contracts",
                                         "verified_dependencies", "verified_snapshot",
                                         "active_head_matches"] if data_only else
                                        ["caller_publish_role", "source_formal_grant", "validated_contracts",
                                         "verified_dependencies", "custodied_evidence", "verified_snapshot"])}
        if data_only:
            algorithm = product["declaration"].get("algorithm_definition")
            if algorithm is not None:
                bound["contracts"]["compute_dependencies"] = {
                    "execution": "not_executed_by_wfd",
                    "derived_submission": "business_definition_only",
                    "result_definition": copy.deepcopy(algorithm),
                    "dependencies": [],
                    "input_custody": "BD_not_stored",
                }
            else:
                bound["contracts"]["compute_dependencies"] = {
                    "execution": "not_applicable",
                    "derived_submission": "not_required",
                    "dependencies": [],
                }
        elif derived_lineage is not None:
            lineage_digest = derived_lineage["lineage_digest"]
            bound["contracts"]["compute_dependencies"] = {
                "execution": "external",
                "derived_submission": "verified_fixed_lineage",
                "dependencies": self._compute_dependency_refs(derived_lineage),
                "input_source_ids": copy.deepcopy(derived_lineage.get("input_source_ids", [])),
                "output_digest": derived_lineage.get("output_digest"),
                "processing_record": copy.deepcopy(derived_lineage.get("processing_record")),
                "method": copy.deepcopy(derived_lineage["method"]),
                "warmup": copy.deepcopy(derived_lineage["warmup"]),
                "validity": copy.deepcopy(derived_lineage["validity"]),
                "lineage_ref": {"kind": "derived_lineage",
                                "dataset_id": product["dataset_id"],
                                "namespace": "wfd.product",
                                "id": "dl_" + lineage_digest.removeprefix("sha256:")[:24],
                                "version": "v_" + lineage_digest.removeprefix("sha256:")[:16],
                                "digest": lineage_digest,
                                "resolution": "pinned", "required": True,
                                "dependency_type": "compute"},
            }
        else:
            algorithm = product["declaration"].get("algorithm_definition")
            if algorithm is not None:
                bound["contracts"]["compute_dependencies"] = {
                    "execution": "external",
                    "derived_submission": "not_required_data_only",
                    "result_definition": copy.deepcopy(algorithm),
                    "dependencies": [],
                    "input_custody": "BD_not_stored",
                }
            else:
                bound["contracts"]["compute_dependencies"] = {
                    "execution": "external", "derived_submission": "verified_fixed_lineage",
                    "dependencies": [],
                }
        if data_only:
            self._current_business_contracts(bound["contracts"], bound["declaration"])
        bound["contracts"] = self._contracts_with_parts(bound["contracts"])
        bound["contract_refs"], bound["contract_bundle_ref"] = self._build_contract_refs(
            bound, bound["contracts"])
        digest = sha(canonical(bound["contracts"]))
        ref = {"kind": "contract", "dataset_id": product["dataset_id"], "namespace": "wfd.product",
               "id": "contract_" + digest[:24], "version": "v_" + digest[:16], "digest": "sha256:" + digest,
               "resolution": "pinned", "required": True, "dependency_type": "read"}
        bound["contract_ref"] = ref
        self.engine._write_immutable(f"catalog/product_service/contracts/{digest}.json",
                                     canonical({"contract_ref": ref, "contracts": bound["contracts"]}))
        return bound

    def _check_dependencies(self, dependencies, dataset_id, checked=None):
        checked = set() if checked is None else checked
        pending = list(dependencies)
        while pending:
            dep = pending.pop()
            identity = (dep["dataset_id"], dep["product_id"], dep["snapshot_id"])
            if identity in checked:
                continue
            if dep["dataset_id"] != dataset_id:
                raise ValueError("DEPENDENCY_DATASET_UNSUPPORTED:" + dep["dataset_id"])
            try:
                available = self._discover_products(snapshot_id=dep["snapshot_id"])["products"]
            except ValueError as exc:
                raise ValueError("DEPENDENCY_SNAPSHOT_UNAVAILABLE:" + dep["snapshot_id"]) from exc
            matches = [p for p in available if p["product_id"] == dep["product_id"]]
            if not matches:
                raise ValueError("DEPENDENCY_PRODUCT_UNAVAILABLE:" + dep["product_id"])
            checked.add(identity)
            for product in matches:
                pending.extend(product["contracts"]["read"].get("dependencies", []))

    def _verify_binding(self, product, verify_contract_files=True):
        if product["definition_ref"]["digest"] != "sha256:" + sha(canonical(product["declaration"])):
            raise ValueError("DEFINITION_DIGEST_MISMATCH")
        context = product.get("semantic_context")
        if context is not None:
            expected = "sha256:" + sha(canonical(context))
            if (product.get("semantic_context_digest") != expected
                    or product.get("contracts", {}).get("semantic", {}).get("semantic_context_digest") != expected):
                raise ValueError("SEMANTIC_CONTEXT_DIGEST_MISMATCH")
        contracts = product.get("contracts") or {}
        part_digests = contracts.get("part_digests")
        if part_digests:
            for part_key, digest in part_digests.items():
                if part_key not in contracts or digest != "sha256:" + sha(canonical(contracts[part_key])):
                    raise ValueError("CONTRACT_PART_DIGEST_MISMATCH:" + part_key)
        if product.get("contract_ref") and product["contract_ref"]["digest"] != "sha256:" + sha(canonical(contracts)):
            raise ValueError("CONTRACT_DIGEST_MISMATCH")
        self._verify_contract_refs(product, verify_files=verify_contract_files)

    @staticmethod
    def _version_leaves(items):
        superseded = {item["revision"].get("supersedes") for item in items}
        return [item for item in items if item["record_ref"]["revision_id"] not in superseded]

    def _prepare_versions(self, out, product, extension, head_id, fingerprint, source=None, *,
                          prior_coverage_ref=_UNPROVIDED_COVERAGE_BASE,
                          _current_rows=_UNPROVIDED_COVERAGE_BASE):
        mode = out["input_mode"]
        if mode not in APPEND_MODES | REVISION_MODES | {"coverage_revision"}:
            raise ValueError("INPUT_MODE_NOT_IMPLEMENTED:" + mode)
        revisions = extension.get("revisions", {})
        if revisions and mode not in REVISION_MODES:
            raise ValueError("REVISION_MODE_REQUIRED")
        key_field = "event_id" if out["payload"]["kind"] == "event_records" else "business_key"
        logical_keys = {row[key_field] for row in out["payload"].get("rows", [])}
        if len(logical_keys) != len(out["payload"].get("rows", [])):
            raise ValueError("DUPLICATE_BUSINESS_KEY")
        if mode in REVISION_MODES and set(revisions) != logical_keys:
            raise ValueError("REVISION_PREDECESSOR_REQUIRED")
        current = (_current_rows if _current_rows is not _UNPROVIDED_COVERAGE_BASE else
                   self._read(product["product_id"], snapshot_id=head_id, include_history=True)["rows"] if head_id else [])
        by_key = {}
        for item in current:
            by_key.setdefault(item["record_ref"]["logical_key"], []).append(item)
        if extension.get("_wfd_data_only") is True and current_only_business(product["declaration"]):
            self._check_current_bar_keys(out, product, current, key_field)
        leaves = {key: self._version_leaves(items) for key, items in by_key.items()}
        coverage = out.get("coverage", {})
        physical, versions = copy.deepcopy(out), {}
        physical_rows = []

        def add_version(row, logical, previous, revision_mode, withdrawn=False, reason=None):
            previous_id = previous["record_ref"]["revision_id"] if previous else None
            revision_id = "r_" + sha(canonical([product["product_id"], row, revision_mode, previous_id, fingerprint, out["output_key"]]))[:32]
            physical_key = "revision_" + revision_id if previous_id or withdrawn else logical
            row[key_field] = physical_key
            versions[physical_key] = {"logical_key": logical, "revision_id": revision_id,
                "supersedes": previous_id, "input_mode": revision_mode,
                "withdrawn": withdrawn, "reason": reason}
            physical_rows.append(row)

        if mode == "complete_snapshot":
            if current and (coverage.get("completeness") != "complete"
                            or coverage.get("absence_means") != "explicitly_absent"):
                raise ValueError("COMPLETE_SNAPSHOT_COVERAGE_REQUIRED")
            scope = coverage.get("scope", {}) if isinstance(coverage.get("scope"), dict) else {}
            scope_keys = scope.get("business_keys")
            if scope_keys is not None:
                if not isinstance(scope_keys, list) or not scope_keys or any(not isinstance(k, str) for k in scope_keys):
                    raise ValueError("SCOPE_BUSINESS_KEYS_INVALID")
                if set(logical_keys) - set(scope_keys):
                    raise ValueError("SCOPE_MEMBER_OUTSIDE_DECLARED_RANGE")
                scoped = set(scope_keys)
            else:
                scoped = None
            unsupported_scope = set(scope) - {"product", "business_keys"}
            if unsupported_scope:
                raise ValueError("SCOPE_UNSUPPORTED:" + sorted(unsupported_scope)[0])
            existing = {key: items[0] for key, items in leaves.items()
                        if len(items) == 1 and (scoped is None or key in scoped)}
            missing = sorted(set(existing) - logical_keys)
            for row in list(physical["payload"]["rows"]):
                logical = row[key_field]
                previous = existing.get(logical)
                add_version(copy.deepcopy(row), logical, previous, "complete_snapshot",
                            reason="Complete snapshot replacement" if previous else None)
            for logical in missing:
                previous = existing[logical]
                row = copy.deepcopy(previous["row"])
                row[key_field] = logical
                add_version(row, logical, previous, "withdrawal", withdrawn=True,
                            reason="Complete snapshot absence")
        elif mode == "coverage_revision":
            if out["payload"].get("kind") != "metadata_revision":
                raise ValueError("COVERAGE_METADATA_PAYLOAD_REQUIRED")
            if not current:
                raise ValueError("COVERAGE_REVISION_REQUIRES_EXISTING")
            # Explicit current coverage (including None) is not its historical predecessor.
            # Omitted keywords retain the old private-call fallback for other profiles.
            predecessor = ((product.get("coverage_predecessor_ref")
                            or (current[0].get("coverage_ref") if current else None))
                           if prior_coverage_ref is _UNPROVIDED_COVERAGE_BASE else prior_coverage_ref)
            requested = coverage.get("predecessor_ref")
            if requested is not None and requested != predecessor:
                raise ValueError("COVERAGE_PREDECESSOR_MISMATCH")
            coverage_ref = "sha256:" + sha(canonical(coverage))
            if coverage_ref == predecessor:
                raise ValueError("COVERAGE_REVISION_UNCHANGED")
            physical = copy.deepcopy(out)
            physical["payload"] = {"kind": "metadata_revision"}
            physical["input_mode"] = "coverage_revision"
            raw_roles = (source or {}).get("source_roles", {}).get(out["output_key"], [])
            if isinstance(raw_roles, dict):
                raw_roles = [{"source_id": sid, "roles": value} for sid, value in raw_roles.items()]
            source_ids = [entry["source_id"] for entry in raw_roles]
            physical["_wfd_metadata"] = {
                "coverage": copy.deepcopy(coverage),
                "coverage_ref": coverage_ref,
                "predecessor_ref": predecessor,
                "predecessor_snapshot_id": head_id,
                "evidence_refs": copy.deepcopy(out.get("evidence_refs", [])),
                "public_time": copy.deepcopy((source or {}).get("public_time")),
                "received_time": _second_now(),
                "definition_ref": copy.deepcopy(product.get("definition_ref")),
                "contract_ref": copy.deepcopy(product.get("contract_ref")),
                "input_mode": "coverage_revision",
                "source_admission": {
                    "source_ids": source_ids,
                    "roles": {entry["source_id"]: list(entry["roles"]) for entry in raw_roles},
                    "definition_authority": product["declaration"].get("definition_authority"),
                    "permissions": {sid: {flag: self.allowed_sources.get(sid, {}).get(flag)
                                          for flag in sorted(SOURCE_FLAGS)} for sid in source_ids},
                },
            }
            return physical, {}
        else:
            for row in list(physical["payload"]["rows"]):
                logical = row[key_field]
                prior = leaves.get(logical, [])
                latest = prior[0] if len(prior) == 1 else None
                previous_id, reason = None, None
                if mode in REVISION_MODES:
                    change = revisions[logical]
                    if not isinstance(change, dict) or set(change) != {"previous", "reason"} or not isinstance(change["reason"], str) or not change["reason"].strip():
                        raise ValueError("REVISION_DECLARATION_INVALID")
                    previous = change["previous"]
                    if not isinstance(previous, dict) or set(previous) != {"product_id", "snapshot_id", "logical_key", "revision_id"}:
                        raise ValueError("REVISION_REFERENCE_INVALID")
                    if previous["product_id"] != product["product_id"] or previous["logical_key"] != logical:
                        raise ValueError("REVISION_TARGET_MISMATCH")
                    try:
                        fixed = self._read(product["product_id"], snapshot_id=previous["snapshot_id"], include_history=True)["rows"]
                    except ValueError as exc:
                        raise ValueError("REVISION_SNAPSHOT_UNAVAILABLE") from exc
                    targets = [r for r in fixed if r["record_ref"] == previous]
                    if len(targets) != 1:
                        raise ValueError("REVISION_TARGET_NOT_FOUND")
                    if latest is None or latest["record_ref"]["revision_id"] != previous["revision_id"]:
                        raise ValueError("REVISION_STALE_PREDECESSOR")
                    if mode == "withdrawal" and row != targets[0]["row"]:
                        raise ValueError("WITHDRAWAL_MUST_REFERENCE_UNCHANGED_ROW")
                    add_version(copy.deepcopy(row), logical, latest, mode,
                                withdrawn=mode == "withdrawal", reason=change["reason"])
                elif prior:
                    raise ValueError("DUPLICATE_LOGICAL_KEY_REQUIRES_REVISION")
                else:
                    add_version(copy.deepcopy(row), logical, None, mode)
        physical["payload"]["rows"] = physical_rows
        if any(v.get("supersedes") or v.get("input_mode") in REVISION_MODES | {"coverage_revision"} for v in versions.values()):
            physical["input_mode"] = "explicit_increment"
        return physical, versions

    @staticmethod
    def _check_current_bar_keys(out, product, current, key_field):
        frequency = product["declaration"]["semantic_context"]["time"]["frequency"]
        subject = product["subject"]

        def identity(row):
            time = row.get("observation_time") or {}
            if (row.get("subject", subject) != subject or time.get("status") != "known"
                    or time.get("precision") != frequency):
                raise ValueError("CURRENT_ONLY_BUSINESS_KEY_CONFLICT:subject or business interval")
            try:
                start, end = [datetime.fromisoformat(time[key].replace("Z", "+00:00"))
                              for key in ("earliest_utc", "latest_exclusive_utc")]
            except (KeyError, TypeError, ValueError, AttributeError) as exc:
                raise ValueError("CURRENT_ONLY_BUSINESS_KEY_CONFLICT:business interval") from exc
            if start.tzinfo is None or end.tzinfo is None or end <= start:
                raise ValueError("CURRENT_ONLY_BUSINESS_KEY_CONFLICT:business interval")
            return (canonical(subject), start.astimezone(timezone.utc).isoformat(),
                    end.astimezone(timezone.utc).isoformat(), frequency)

        key_to_interval, interval_to_key = {}, {}
        for item in current:
            key = item["record_ref"]["logical_key"]
            interval = identity(item["row"])
            key_to_interval[key] = interval
            interval_to_key[interval] = key
        batch_intervals = set()
        for row in out["payload"]["rows"]:
            key, interval = row[key_field], identity(row)
            if ((key in key_to_interval and key_to_interval[key] != interval)
                    or (interval in interval_to_key and interval_to_key[interval] != key)
                    or interval in batch_intervals):
                raise ValueError("CURRENT_ONLY_BUSINESS_KEY_CONFLICT:one key per business interval")
            batch_intervals.add(interval)
        return batch_intervals

    def _admit_output(self, out, source, policies):
        errors = []
        for source_id, policy in policies:
            domains = policy.get("allowed_domains", [])
            if domains and out["logical_domain"] not in domains:
                errors.append(_issue("SOURCE_SCOPE_DENIED", f"Source {source_id} is not admitted for this logical domain"))
        content = [e for e in out["evidence_refs"] if e.get("ref_kind") == "content"]
        if not content:
            errors.append(_issue("EVIDENCE_REQUIRED", "At least one custodied content reference is required"))
        for ev in content:
            digest = (ev.get("content_sha256") or "").removeprefix("sha256:")
            path = self.root / "evidence/sha256" / digest
            if len(digest) != 64 or not path.is_file() or sha(path.read_bytes()) != digest:
                errors.append(_issue("EVIDENCE_CUSTODY_UNVERIFIED", "Referenced source bytes are not in verified custody"))
        public = source.get("public_time")
        if public is not None:
            errors.extend(self._time_errors(public))
        times = source.get("row_public_times", {}).get(out["output_key"], {})
        for value in times.values():
            errors.extend(self._time_errors(value))
        return errors

    # ------------------------------------------------------------------
    # P3c: original-publisher chains, field evidence and source conflicts
    # ------------------------------------------------------------------
    @staticmethod
    def _selected_role_entries(source, output_key):
        assignment = (source.get("source_roles") or {}).get(output_key)
        if isinstance(assignment, dict):
            assignment = [{"source_id": sid, "roles": roles}
                          for sid, roles in assignment.items()]
        if not isinstance(assignment, list):
            raise ValueError("SOURCE_ROLE_ASSIGNMENT_REQUIRED")
        return [{"source_id": entry.get("source_id"),
                 "roles": list(entry.get("roles") or [])}
                for entry in assignment
                if isinstance(entry, dict) and isinstance(entry.get("roles"), list)]

    @staticmethod
    def _payload_fields(out):
        if out["payload"]["kind"] == "metadata_revision":
            return set()
        if out["payload"]["kind"] == "scalar_rows":
            return {"value_decimal"}
        fields = set()
        for row in out["payload"].get("rows", []):
            values = row.get("values")
            if isinstance(values, dict):
                fields.update(values)
        return fields

    @staticmethod
    def _output_cell(out, business_key, field):
        for row in out["payload"].get("rows", []):
            key = row.get("event_id", row.get("business_key"))
            if key != business_key:
                continue
            if out["payload"]["kind"] == "scalar_rows":
                return row.get("value_state"), row.get("value_decimal")
            cell = (row.get("values") or {}).get(field)
            if not isinstance(cell, dict):
                return None, None
            return cell.get("value_state"), cell.get("value")
        return None, None

    @staticmethod
    def _value_equal(data_type, state_a, value_a, state_b, value_b):
        if state_a != state_b:
            return False
        if state_a not in {"valid_value", "reported_zero"}:
            return state_a == state_b
        if data_type in {"decimal", "integer"}:
            try:
                from decimal import Decimal
                return Decimal(str(value_a)) == Decimal(str(value_b))
            except Exception:
                return value_a == value_b
        return value_a == value_b

    @staticmethod
    def _normalize_lineage_field(out, field):
        if not isinstance(field, str) or not field:
            raise ValueError("SOURCE_LINEAGE_FIELD_INVALID")
        if out["payload"]["kind"] == "scalar_rows" and field == "value":
            return "value_decimal"
        return field

    def _lineage_ref_id(self, out, ref_id):
        for ref in out.get("evidence_refs", []):
            if ref.get("ref_id") == ref_id:
                return ref
        raise ValueError("SOURCE_LINEAGE_EVIDENCE_UNKNOWN:" + str(ref_id))

    @staticmethod
    def _content_digest(ref):
        return (ref.get("content_sha256") or "").removeprefix("sha256:")

    def _custody_ref_ok(self, ref):
        digest = self._content_digest(ref)
        path = self.root / "evidence/sha256" / digest
        return len(digest) == 64 and path.is_file() and sha(path.read_bytes()) == digest

    def _first_publisher_trust(self, source, first_publisher_id, declaration, role_by_source):
        """Trusted source policy check for a claimed original publisher.

        A self-declared string is not an independent origin.  The first
        publisher must be admitted in this request, its trusted policy must
        allow the first_publisher role and the declaration authority, and it
        must not be selected under a non-publisher role only.
        """
        if not isinstance(first_publisher_id, str) or not first_publisher_id:
            return False, "invalid_first_publisher_id"
        request_source_ids = set(source.get("source_ids") or [])
        if source.get("source_id"):
            request_source_ids.add(source["source_id"])
        if first_publisher_id not in request_source_ids:
            return False, "first_publisher_not_in_request_sources"
        policy = self.allowed_sources.get(first_publisher_id)
        if not policy:
            return False, "first_publisher_not_admitted"
        if "first_publisher" not in policy.get("allowed_roles", []):
            return False, "first_publisher_role_not_allowed"
        authority = str(declaration.get("definition_authority", ""))
        allowed = policy.get("allowed_authorities", [])
        if not any(authority == item or authority.startswith(item + ".") for item in allowed):
            return False, "first_publisher_authority_not_allowed"
        selected_roles = role_by_source.get(first_publisher_id)
        if selected_roles is not None and "first_publisher" not in selected_roles:
            return False, "selected_without_first_publisher_role"
        return True, "trusted_source_policy_and_custodied_original_bytes"

    @staticmethod
    def _output_payload_digest(out):
        return derived_output_digest(out)

    def _prepare_source_provenance(self, out, product, source, extension):
        output_key = out["output_key"]
        lineage = extension.get("source_lineage")
        conflict_contract = extension.get("conflict_resolution")
        if out["payload"]["kind"] == "metadata_revision":
            if lineage or conflict_contract:
                raise ValueError("SOURCE_LINEAGE_METADATA_REVISION_UNSUPPORTED")
            return None
        selected = self._selected_role_entries(source, output_key)
        if not selected:
            raise ValueError("SOURCE_ROLE_ASSIGNMENT_REQUIRED")
        role_by_source = {entry["source_id"]: set(entry["roles"]) for entry in selected}
        publisher_sources = {sid for sid, roles in role_by_source.items()
                             if roles & SOURCE_LINEAGE_ROLES}
        needs_lineage = (any("republisher" in roles
                             for roles in role_by_source.values())
                         or len(publisher_sources) > 1)
        required_lineage_sources = set(publisher_sources) if needs_lineage else {
            sid for sid, roles in role_by_source.items() if "republisher" in roles}
        if lineage is None:
            if conflict_contract:
                raise ValueError("CONFLICT_RESOLUTION_WITHOUT_LINEAGE")
            if needs_lineage:
                raise ValueError("SOURCE_LINEAGE_REQUIRED")
            return None
        if not isinstance(lineage, list) or not lineage:
            raise ValueError("SOURCE_LINEAGE_REQUIRED")
        fields = self._payload_fields(out)
        declaration = product["declaration"]
        field_defs = {f.get("field_code"): f for f in declaration.get("field_definitions", [])
                      if isinstance(f, dict)}
        evidence_by_digest = {}
        evidence_by_id = {}
        for ref in out.get("evidence_refs", []):
            if ref.get("ref_kind") != "content":
                continue
            evidence_by_id[ref.get("ref_id")] = ref
            evidence_by_digest.setdefault(self._content_digest(ref), []).append(ref)

        entries = []
        seen_sources = set()
        publisher_content = {}
        allowed_keys = {"source_id", "first_publisher_id", "first_publication_id",
                        "original_content_sha256", "content_sha256", "publication_chain",
                        "evidence_ref_ids", "field_evidence", "values"}
        for raw in lineage:
            if not isinstance(raw, dict) or set(raw) - allowed_keys:
                raise ValueError("SOURCE_LINEAGE_INVALID")
            sid = raw.get("source_id")
            if sid not in role_by_source:
                raise ValueError("SOURCE_LINEAGE_SOURCE_UNKNOWN:" + str(sid))
            if sid in seen_sources:
                raise ValueError("SOURCE_LINEAGE_DUPLICATE:" + str(sid))
            seen_sources.add(sid)
            first_publisher_id = raw.get("first_publisher_id")
            first_publication_id = raw.get("first_publication_id")
            original_digest = (raw.get("original_content_sha256") or "").removeprefix("sha256:")
            if not all(isinstance(x, str) and x for x in
                       (first_publisher_id, first_publication_id)) or len(original_digest) != 64:
                raise ValueError("SOURCE_LINEAGE_ORIGIN_REQUIRED")
            roles = role_by_source[sid]
            if "first_publisher" in roles and first_publisher_id != sid:
                raise ValueError("SOURCE_LINEAGE_PUBLISHER_MISMATCH:" + sid)
            chain = raw.get("publication_chain")
            if chain is None:
                chain = [first_publisher_id] if sid == first_publisher_id else [first_publisher_id, sid]
            if (not isinstance(chain, list) or len(chain) < 1
                    or any(not isinstance(x, str) or not x for x in chain)
                    or chain[0] != first_publisher_id or chain[-1] != sid):
                raise ValueError("SOURCE_LINEAGE_CHAIN_INVALID:" + sid)
            if "republisher" in roles and len(chain) < 2:
                raise ValueError("SOURCE_LINEAGE_CHAIN_INVALID:" + sid)
            ref_ids = raw.get("evidence_ref_ids")
            if not isinstance(ref_ids, list) or not ref_ids:
                raise ValueError("SOURCE_LINEAGE_EVIDENCE_REQUIRED:" + sid)
            refs = []
            for ref_id in ref_ids:
                ref = evidence_by_id.get(ref_id)
                if ref is None or not self._custody_ref_ok(ref):
                    raise ValueError("SOURCE_LINEAGE_EVIDENCE_UNKNOWN:" + str(ref_id))
                refs.append(ref)
            content_digest = (raw.get("content_sha256") or ("sha256:" + original_digest)).removeprefix("sha256:")
            if len(content_digest) != 64 or content_digest not in evidence_by_digest:
                raise ValueError("SOURCE_LINEAGE_CONTENT_UNVERIFIED:" + sid)
            if original_digest not in evidence_by_digest:
                raise ValueError("SOURCE_LINEAGE_ORIGIN_UNVERIFIED:" + sid)
            field_evidence = raw.get("field_evidence") or {}
            if not isinstance(field_evidence, dict):
                raise ValueError("SOURCE_LINEAGE_EVIDENCE_INVALID:" + sid)
            normalized_field_evidence = {}
            for field, field_ref_ids in field_evidence.items():
                field = self._normalize_lineage_field(out, field)
                if field not in fields:
                    raise ValueError("SOURCE_LINEAGE_FIELD_UNKNOWN:" + field)
                if not isinstance(field_ref_ids, list) or not field_ref_ids:
                    raise ValueError("SOURCE_LINEAGE_EVIDENCE_REQUIRED:" + sid)
                for ref_id in field_ref_ids:
                    ref = evidence_by_id.get(ref_id)
                    if ref is None or not self._custody_ref_ok(ref):
                        raise ValueError("SOURCE_LINEAGE_EVIDENCE_UNKNOWN:" + str(ref_id))
                normalized_field_evidence[field] = list(field_ref_ids)
            values = raw.get("values") or []
            if not isinstance(values, list):
                raise ValueError("SOURCE_LINEAGE_VALUE_INVALID:" + sid)
            normalized_values = []
            for value in values:
                if (not isinstance(value, dict)
                        or set(value) - {"business_key", "field", "value_state", "value", "evidence_ref_ids"}):
                    raise ValueError("SOURCE_LINEAGE_VALUE_INVALID:" + sid)
                key = value.get("business_key")
                field = self._normalize_lineage_field(out, value.get("field"))
                state = value.get("value_state")
                if not isinstance(key, str) or not key or field not in fields:
                    raise ValueError("SOURCE_LINEAGE_VALUE_INVALID:" + sid)
                if field not in normalized_field_evidence:
                    raise ValueError("SOURCE_FIELD_EVIDENCE_MISSING:" + field)
                if state in {"valid_value", "reported_zero"}:
                    if value.get("value") is None:
                        raise ValueError("SOURCE_LINEAGE_VALUE_INVALID:" + sid)
                elif state in {"unknown", "not_reported", "not_collected", "out_of_coverage",
                               "not_applicable", "not_yet_effective", "not_matured",
                               "insufficient_warmup", "source_conflict"}:
                    if value.get("value") is not None:
                        raise ValueError("SOURCE_LINEAGE_VALUE_INVALID:" + sid)
                else:
                    raise ValueError("SOURCE_LINEAGE_VALUE_INVALID:" + sid)
                normalized_values.append({"business_key": key, "field": field,
                                          "value_state": state, "value": value.get("value")})
            origin_verified, origin_trust_basis = self._first_publisher_trust(
                source, first_publisher_id, declaration, role_by_source)
            origin_key = (source_origin_key(first_publisher_id, first_publication_id,
                                            "sha256:" + original_digest)
                          if origin_verified else "o_unverified")
            previous = publisher_content.get((first_publisher_id, first_publication_id))
            if previous is not None and previous != original_digest:
                raise ValueError("SOURCE_ORIGIN_CONTENT_MISMATCH:" + first_publication_id)
            publisher_content[(first_publisher_id, first_publication_id)] = original_digest
            entries.append({
                "source_id": sid, "roles": sorted(roles),
                "first_publisher_id": first_publisher_id,
                "first_publication_id": first_publication_id,
                "origin_verified": origin_verified,
                "origin_trust_basis": origin_trust_basis,
                "publication_chain": list(chain),
                "original_content_sha256": "sha256:" + original_digest,
                "content_sha256": "sha256:" + content_digest,
                "evidence_ref_ids": list(ref_ids),
                "field_evidence": normalized_field_evidence,
                "values": normalized_values,
                "origin_key": origin_key,
            })
        missing = [sid for sid in required_lineage_sources if sid not in seen_sources]
        if missing:
            raise ValueError("SOURCE_LINEAGE_REQUIRED:" + sorted(missing)[0])
        for field in sorted(fields):
            covered = {entry["origin_key"] for entry in entries
                       if field in entry["field_evidence"]}
            if not covered:
                raise ValueError("SOURCE_FIELD_EVIDENCE_MISSING:" + field)

        origins = {}
        diagnostics = []
        for entry in entries:
            if entry["origin_verified"]:
                origin = origins.setdefault(entry["origin_key"], {
                    "origin_key": entry["origin_key"],
                    "verified": True,
                    "trust_status": "trusted_first_publisher",
                    "trust_basis": entry["origin_trust_basis"],
                    "first_publisher_id": entry["first_publisher_id"],
                    "first_publication_id": entry["first_publication_id"],
                    "original_content_sha256": entry["original_content_sha256"],
                    "source_ids": [], "evidence_ref_ids": [],
                })
            else:
                origin = origins.setdefault("o_unverified", {
                    "origin_key": "o_unverified",
                    "verified": False,
                    "trust_status": "unverified_first_publisher",
                    "trust_basis": entry["origin_trust_basis"],
                    "first_publisher_id": None,
                    "first_publication_id": None,
                    "original_content_sha256": None,
                    "claimed_first_publisher_ids": [],
                    "claimed_first_publication_ids": [],
                    "source_ids": [], "evidence_ref_ids": [],
                })
                for key, value in (("claimed_first_publisher_ids", entry["first_publisher_id"]),
                                   ("claimed_first_publication_ids", entry["first_publication_id"])):
                    if value not in origin[key]:
                        origin[key].append(value)
                diagnostics.append({
                    "code": "SOURCE_ORIGIN_UNVERIFIED",
                    "source_id": entry["source_id"],
                    "first_publisher_id": entry["first_publisher_id"],
                    "first_publication_id": entry["first_publication_id"],
                    "reason": entry["origin_trust_basis"],
                    "message": "Claimed first publisher is not a trusted first_publisher source for this authority; the claimed identity is preserved but not counted as an independent origin.",
                })
            if entry["source_id"] not in origin["source_ids"]:
                origin["source_ids"].append(entry["source_id"])
            for ref_id in entry["evidence_ref_ids"]:
                if ref_id not in origin["evidence_ref_ids"]:
                    origin["evidence_ref_ids"].append(ref_id)
        attribution_fields = {}
        for field in sorted(fields):
            origin_keys = sorted({entry["origin_key"] for entry in entries
                                  if field in entry["field_evidence"]})
            verified_keys = [key for key in origin_keys if origins[key]["verified"]]
            attribution_fields[field] = {
                "independent_origin_count": len(verified_keys),
                "unverified_origin_count": len(origin_keys) - len(verified_keys),
                "independence_status": "confirmed" if verified_keys else "unconfirmed",
                "origin_keys": origin_keys,
                "source_ids": sorted({entry["source_id"] for entry in entries
                                      if field in entry["field_evidence"]}),
            }
        attribution = {
            "format_version": "wfd.source-attribution/1.0",
            "sources": entries,
            "origins": [origins[key] for key in sorted(origins)],
            "fields": attribution_fields,
            "diagnostics": diagnostics,
            "repost_independence_note": "Only a trusted first_publisher plus its original content identity forms a confirmed origin. Untrusted claimed publishers are preserved as one unconfirmed group and never counted as independent corroboration.",
        }

        # Compare declared values per (row, field).  Same-origin reposts are one
        # origin; only different origins can corroborate or conflict.
        groups = {}
        for entry in entries:
            for value in entry["values"]:
                groups.setdefault((value["business_key"], value["field"]), {}).setdefault(
                    entry["origin_key"], []).append({
                        "source_id": entry["source_id"], "value_state": value["value_state"],
                        "value": value["value"], "origin_key": entry["origin_key"],
                        "first_publisher_id": entry["first_publisher_id"],
                        "first_publication_id": entry["first_publication_id"],
                    })
        data_types = {code: f.get("data_type") for code, f in field_defs.items()}
        if out["payload"]["kind"] == "scalar_rows":
            data_types["value_decimal"] = "decimal"
        # A source that claims field-level evidence for a field is claiming
        # support for that cell.  Without an explicit per-source scope, each
        # such source must supply a candidate for every payload cell it claims
        # (including a legal null state).  A union of candidates from other
        # sources must not hide one source's empty claim.
        entry_pairs = {
            entry["source_id"]: {(value["business_key"], value["field"])
                                 for value in entry["values"]}
            for entry in entries
        }
        for payload_row in out["payload"].get("rows", []):
            key = payload_row.get("event_id", payload_row.get("business_key"))
            if out["payload"]["kind"] == "scalar_rows":
                field_states = ["value_decimal"]
            else:
                field_states = list((payload_row.get("values") or {}).keys())
            for field in field_states:
                for entry in entries:
                    if field not in entry["field_evidence"]:
                        continue
                    if (key, field) not in entry_pairs[entry["source_id"]]:
                        raise ValueError("SOURCE_VALUE_ATTRIBUTION_REQUIRED:"
                                         + str(entry["source_id"]) + ":"
                                         + str(key) + ":" + str(field))
        conflicts = []
        for (business_key, field) in sorted(groups):
            by_origin = groups[(business_key, field)]
            origin_values = {}
            for origin_key, candidates in by_origin.items():
                canonical_value = candidates[0]
                for candidate in candidates[1:]:
                    if not self._value_equal(data_types.get(field, "text"),
                                             canonical_value["value_state"], canonical_value["value"],
                                             candidate["value_state"], candidate["value"]):
                        raise ValueError("SOURCE_ORIGIN_INCONSISTENT:" + business_key + ":" + field)
                origin_values[origin_key] = canonical_value
            if len(origin_values) > 1:
                values = list(origin_values.values())
                differs = any(not self._value_equal(data_types.get(field, "text"),
                                                   values[0]["value_state"], values[0]["value"],
                                                   item["value_state"], item["value"])
                              for item in values[1:])
                if differs:
                    conflicts.append({"business_key": business_key, "field": field,
                                      "origin_values": origin_values})
                    continue
            # Unanimous declared evidence must match the submitted payload; a
            # mismatch means the payload silently uses an undeclared value.
            state, value = self._output_cell(out, business_key, field)
            expected = next(iter(origin_values.values()))
            if not self._value_equal(data_types.get(field, "text"),
                                     state, value, expected["value_state"], expected["value"]):
                raise ValueError("SOURCE_VALUE_ATTRIBUTION_MISMATCH:" + business_key + ":" + field)
        if not conflicts:
            if conflict_contract:
                raise ValueError("CONFLICT_RESOLUTION_WITHOUT_CONFLICT")
            return {"attribution": attribution, "conflicts": []}

        if not isinstance(conflict_contract, dict):
            raise ValueError("SOURCE_CONFLICT_UNRESOLVED")
        comparison_set = out.get("comparison_set")
        if not isinstance(comparison_set, dict):
            raise ValueError("SOURCE_CONFLICT_CONTRACT_REQUIRED")
        mode = conflict_contract.get("mode")
        if mode not in CONFLICT_MODES:
            raise ValueError("CONFLICT_MODE_INVALID")
        if set(conflict_contract) - {"comparison_set_id", "mode", "rule_version",
                                     "comparability", "candidates", "selection"}:
            raise ValueError("CONFLICT_CONTRACT_INVALID")
        rule_version = conflict_contract.get("rule_version")
        if not isinstance(rule_version, str) or not rule_version.strip():
            raise ValueError("CONFLICT_RULE_VERSION_REQUIRED")
        if set(comparison_set) != {"comparison_set_id", "input_refs",
                                   "comparability_contract_ref", "decisions"}:
            raise ValueError("COMPARISON_SET_INVALID")
        if (comparison_set.get("comparison_set_id") != conflict_contract.get("comparison_set_id")
                or not isinstance(conflict_contract.get("comparison_set_id"), str)):
            raise ValueError("COMPARISON_SET_ID_MISMATCH")
        candidate_refs = {}
        candidates = conflict_contract.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            raise ValueError("CONFLICT_CANDIDATES_REQUIRED")
        for candidate in candidates:
            if (not isinstance(candidate, dict)
                    or set(candidate) - {"candidate_ref", "source_id", "business_key",
                                         "field", "value_state", "value", "evidence_ref_ids"}):
                raise ValueError("CONFLICT_CANDIDATE_INVALID")
            ref = candidate.get("candidate_ref")
            sid = candidate.get("source_id")
            if not isinstance(ref, str) or not ref or ref in candidate_refs:
                raise ValueError("CONFLICT_CANDIDATE_INVALID")
            entry = next((item for item in entries if item["source_id"] == sid), None)
            if entry is None:
                raise ValueError("CONFLICT_CANDIDATE_SOURCE_UNKNOWN:" + str(sid))
            field = self._normalize_lineage_field(out, candidate.get("field"))
            group = groups.get((candidate.get("business_key"), field))
            if not group or entry["origin_key"] not in group:
                raise ValueError("CONFLICT_CANDIDATE_OUTSIDE_CONFLICT:" + ref)
            declared = group[entry["origin_key"]][0]
            if not self._value_equal(data_types.get(field, "text"),
                                     declared["value_state"], declared["value"],
                                     candidate.get("value_state"), candidate.get("value")):
                raise ValueError("CONFLICT_CANDIDATE_VALUE_MISMATCH:" + ref)
            candidate_refs[ref] = {"candidate_ref": ref, "source_id": sid,
                                   "origin_key": entry["origin_key"],
                                   "business_key": candidate.get("business_key"),
                                   "field": field, "value_state": declared["value_state"],
                                   "value": declared["value"], "data_type": data_types.get(field, "text"),
                                   "first_publisher_id": entry["first_publisher_id"],
                                   "first_publication_id": entry["first_publication_id"],
                                   "evidence_ref_ids": list(candidate.get("evidence_ref_ids") or [])}
        conflict_keys = {(item["business_key"], item["field"]) for item in conflicts}
        for candidate in candidate_refs.values():
            if (candidate["business_key"], candidate["field"]) not in conflict_keys:
                raise ValueError("CONFLICT_CANDIDATE_OUTSIDE_CONFLICT:" + candidate["candidate_ref"])
        for conflict in conflicts:
            expected_origins = set(conflict["origin_values"])
            selected_origins = {item["origin_key"] for item in candidate_refs.values()
                                if item["business_key"] == conflict["business_key"]
                                and item["field"] == conflict["field"]}
            if selected_origins != expected_origins:
                raise ValueError("CONFLICT_CANDIDATE_SET_MISMATCH:"
                                 + conflict["business_key"] + ":" + conflict["field"])
        decisions = comparison_set.get("decisions")
        if not isinstance(decisions, list) or not decisions:
            raise ValueError("COMPARISON_DECISIONS_REQUIRED")
        decision_by_ref = {}
        valid_status = {"selected", "excluded", "unresolved"}
        for decision in decisions:
            if (not isinstance(decision, dict)
                    or set(decision) != {"candidate_ref", "selection_status",
                                         "affected_scope", "reason_code"}):
                raise ValueError("COMPARISON_DECISION_INVALID")
            ref = decision.get("candidate_ref")
            if ref not in candidate_refs or ref in decision_by_ref:
                raise ValueError("COMPARISON_DECISION_INVALID")
            if decision.get("selection_status") not in valid_status:
                raise ValueError("COMPARISON_DECISION_INVALID")
            if (not isinstance(decision.get("reason_code"), str)
                    or not decision["reason_code"].strip()):
                raise ValueError("COMPARISON_DECISION_INVALID")
            scope = decision.get("affected_scope")
            candidate = candidate_refs[ref]
            if (not isinstance(scope, dict)
                    or scope.get("business_key") != candidate["business_key"]
                    or scope.get("field") != candidate["field"]):
                raise ValueError("COMPARISON_DECISION_SCOPE_MISMATCH:" + ref)
            decision_by_ref[ref] = copy.deepcopy(decision)
        if set(decision_by_ref) != set(candidate_refs):
            raise ValueError("COMPARISON_DECISION_SET_MISMATCH")
        selections = conflict_contract.get("selection")
        if selections is None:
            selections = []
        elif isinstance(selections, dict):
            selections = [selections]
        if not isinstance(selections, list):
            raise ValueError("CONFLICT_SELECTION_INVALID")
        selection_by_candidate = {}
        for selection in selections:
            if (not isinstance(selection, dict)
                    or set(selection) - {"candidate_ref", "reason_code", "reason"}):
                raise ValueError("CONFLICT_SELECTION_INVALID")
            ref = selection.get("candidate_ref")
            if ref not in candidate_refs or ref in selection_by_candidate:
                raise ValueError("CONFLICT_SELECTION_INVALID")
            if not isinstance(selection.get("reason_code"), str) or not selection["reason_code"].strip():
                raise ValueError("CONFLICT_SELECTION_INVALID")
            selection_by_candidate[ref] = copy.deepcopy(selection)
        for conflict in conflicts:
            conflict_refs = [ref for ref, item in candidate_refs.items()
                             if item["business_key"] == conflict["business_key"]
                             and item["field"] == conflict["field"]]
            selected_refs = [ref for ref in conflict_refs
                             if decision_by_ref[ref]["selection_status"] == "selected"]
            if mode == "select":
                if len(selected_refs) != 1 or selected_refs[0] not in selection_by_candidate:
                    raise ValueError("CONFLICT_SELECTION_REQUIRED:"
                                     + conflict["business_key"] + ":" + conflict["field"])
                for ref in conflict_refs:
                    if ref != selected_refs[0] and decision_by_ref[ref]["selection_status"] != "excluded":
                        raise ValueError("CONFLICT_DECISION_STATUS_INVALID:" + ref)
                selected = candidate_refs[selected_refs[0]]
                state, value = self._output_cell(out, conflict["business_key"], conflict["field"])
                if not self._value_equal(selected["data_type"], state, value,
                                         selected["value_state"], selected["value"]):
                    raise ValueError("CONFLICT_SELECTED_VALUE_MISMATCH:"
                                     + conflict["business_key"] + ":" + conflict["field"])
                conflict.update(resolution="select", selected_candidate_ref=selected_refs[0],
                                selected=copy.deepcopy(selected),
                                selection=copy.deepcopy(selection_by_candidate[selected_refs[0]]))
            else:
                if selections:
                    raise ValueError("CONFLICT_SELECTION_NOT_APPLICABLE")
                if any(decision_by_ref[ref]["selection_status"] != "unresolved"
                       for ref in conflict_refs):
                    raise ValueError("CONFLICT_DECISION_STATUS_INVALID")
                state, value = self._output_cell(out, conflict["business_key"], conflict["field"])
                if state != "source_conflict" or value is not None:
                    raise ValueError("CONFLICT_PRESERVE_ROW_STATE_REQUIRED:"
                                     + conflict["business_key"] + ":" + conflict["field"])
                conflict.update(resolution=mode, selected_candidate_ref=None, selected=None,
                                selection=None)
        candidate_digests = set()
        input_refs = comparison_set.get("input_refs")
        if not isinstance(input_refs, list) or not input_refs:
            raise ValueError("COMPARISON_INPUT_REFS_REQUIRED")
        for ref in input_refs:
            if not isinstance(ref, dict):
                raise ValueError("COMPARISON_INPUT_REFS_INVALID")
            if ref.get("ref_kind") == "content":
                digest = self._content_digest(ref)
                path = self.root / "evidence/sha256" / digest
                if len(digest) != 64 or not path.is_file() or sha(path.read_bytes()) != digest:
                    raise ValueError("COMPARISON_INPUT_REFS_INVALID")
                candidate_digests.add(digest)
            elif not (isinstance(ref.get("digest"), str) and len(ref["digest"].removeprefix("sha256:")) == 64):
                raise ValueError("COMPARISON_INPUT_REFS_INVALID")
        for candidate in candidate_refs.values():
            if candidate["evidence_ref_ids"]:
                for ref_id in candidate["evidence_ref_ids"]:
                    ref = evidence_by_id.get(ref_id)
                    if ref is None:
                        raise ValueError("CONFLICT_CANDIDATE_EVIDENCE_UNKNOWN:" + ref_id)
                    if self._content_digest(ref) not in candidate_digests:
                        raise ValueError("CONFLICT_CANDIDATE_EVIDENCE_NOT_IN_COMPARISON:" + ref_id)
        comparability = conflict_contract.get("comparability")
        comparability_ref = comparison_set.get("comparability_contract_ref")
        if not isinstance(comparability, dict) or not isinstance(comparability_ref, dict):
            raise ValueError("COMPARABILITY_CONTRACT_REQUIRED")
        if (comparability.get("mode") != mode
                or comparability.get("rule_version") != rule_version
                or comparability.get("semantic_code") != declaration.get("semantic_code")
                or comparability.get("unit_code") != declaration.get("unit_code")):
            raise ValueError("COMPARABILITY_CONTRACT_INVALID")
        expected_groups = []
        for conflict in conflicts:
            expected_groups.append({"business_key": conflict["business_key"],
                                    "field": conflict["field"],
                                    "origin_keys": sorted(conflict["origin_values"])})
        if comparability.get("groups") != expected_groups:
            raise ValueError("COMPARABILITY_GROUPS_MISMATCH")
        digest = "sha256:" + sha(canonical(comparability))
        if (comparability_ref.get("digest") != digest
                or comparability_ref.get("dataset_id") != product.get("dataset_id")
                or comparability_ref.get("resolution") != "pinned"):
            raise ValueError("COMPARABILITY_DIGEST_MISMATCH")
        self.engine._write_immutable(
            f"catalog/product_service/comparability/{digest.removeprefix('sha256:')}.json",
            canonical(comparability))
        for conflict in conflicts:
            conflict_refs = [ref for ref, item in candidate_refs.items()
                             if item["business_key"] == conflict["business_key"]
                             and item["field"] == conflict["field"]]
            conflict["candidates"] = [copy.deepcopy(candidate_refs[ref])
                                      for ref in sorted(conflict_refs)]
            conflict["decisions"] = [copy.deepcopy(decision_by_ref[ref])
                                     for ref in sorted(conflict_refs)]
            verified_origin_count = sum(1 for key in conflict["origin_values"]
                                        if origins[key]["verified"])
            conflict["independent_origin_count"] = verified_origin_count
            conflict["unverified_origin_count"] = len(conflict["origin_values"]) - verified_origin_count
            conflict["all_original_values_retained"] = True
            conflict["comparison_set_id"] = comparison_set["comparison_set_id"]
            conflict["rule_version"] = rule_version
            conflict["comparability_contract_ref"] = copy.deepcopy(comparability_ref)
            conflict["comparability"] = copy.deepcopy(comparability)
            conflict["outcome"] = ("selected" if mode == "select" else
                                   ("preserved" if mode == "preserve" else "compared_different"))
            conflict.pop("origin_values", None)
        return {"attribution": attribution, "conflicts": conflicts}

    # ------------------------------------------------------------------
    # P3c: externally computed derived results with fixed lineage
    # ------------------------------------------------------------------
    def _derived_warmup_errors(self, out, lineage):
        warmup = lineage.get("warmup")
        validity = lineage.get("validity")
        if not isinstance(warmup, dict) or not isinstance(validity, dict):
            raise ValueError("DERIVED_WARMUP_REQUIRED")
        status = warmup.get("status")
        required = warmup.get("required_observations")
        available = warmup.get("available_observations")
        if status not in WARMUP_STATUSES:
            raise ValueError("DERIVED_WARMUP_STATUS_INVALID")
        if type(required) is not int or type(available) is not int or required < 0 or available < 0:
            raise ValueError("DERIVED_WARMUP_COUNT_INVALID")
        expected = {"sufficient": "valid", "partial": "partial",
                    "insufficient": "insufficient_warmup"}[status]
        if validity.get("state") not in DERIVED_VALIDITY_STATES or validity.get("state") != expected:
            raise ValueError("DERIVED_VALIDITY_STATE_MISMATCH")
        if status in {"sufficient", "partial"} and available < required:
            raise ValueError("DERIVED_WARMUP_COUNT_INVALID")
        if status == "insufficient" and available >= required:
            raise ValueError("DERIVED_WARMUP_COUNT_INVALID")
        states = []
        for row in out["payload"].get("rows", []):
            if "value_state" in row:
                states.append(row.get("value_state"))
            for cell in (row.get("values") or {}).values():
                if isinstance(cell, dict):
                    states.append(cell.get("value_state"))
        insufficient = sum(1 for value in states if value == "insufficient_warmup")
        non_null = sum(1 for value in states if value in {"valid_value", "reported_zero"})
        if status == "sufficient" and insufficient:
            raise ValueError("DERIVED_WARMUP_STATE_MISMATCH")
        if status == "insufficient" and (non_null or not insufficient):
            raise ValueError("DERIVED_WARMUP_STATE_MISMATCH")
        if status == "partial" and (not insufficient or not non_null):
            raise ValueError("DERIVED_WARMUP_STATE_MISMATCH")

    def _resolve_content_ref(self, out, value):
        if isinstance(value, str):
            return self._lineage_ref_id(out, value)
        if isinstance(value, dict):
            for ref in out.get("evidence_refs", []):
                if ref.get("ref_kind") != "content":
                    continue
                if value.get("ref_id") and ref.get("ref_id") == value["ref_id"]:
                    return ref
                if value.get("content_sha256") and ref.get("content_sha256") == value["content_sha256"]:
                    return ref
        return None

    def _prepare_method_code(self, method, out):
        code = method.get("code")
        code_ref = method.get("code_ref")
        if not ((isinstance(code, str) and code.strip()) or code_ref is not None):
            raise ValueError("DERIVED_METHOD_CODE_REQUIRED")
        code_format = method.get("code_format")
        if not isinstance(code_format, str) or not code_format.strip():
            raise ValueError("DERIVED_METHOD_CODE_FORMAT_REQUIRED")
        if isinstance(code, str) and code.strip():
            body = {"code_format": code_format, "code": code}
            storage = "inline"
            content_sha256 = None
        elif code is not None:
            raise ValueError("DERIVED_METHOD_CODE_REQUIRED")
        else:
            ref = self._resolve_content_ref(out, code_ref)
            if ref is None or not self._custody_ref_ok(ref):
                raise ValueError("DERIVED_METHOD_CODE_REQUIRED")
            body = {"code_format": code_format,
                    "content_sha256": ref["content_sha256"]}
            storage = "content_ref"
            content_sha256 = ref["content_sha256"]
        digest = "sha256:" + sha(canonical(body))
        self.engine._write_immutable(
            f"catalog/product_service/derived_method_code/{digest.removeprefix('sha256:')}.json",
            canonical(body))
        return {"code_format": code_format, "code_digest": digest,
                "code_storage": storage, "code_content_sha256": content_sha256}

    def _prepare_processing_evidence(self, derived, out, normalized_inputs,
                                     method_digest, method_code_digest,
                                     parameter_digest):
        raw_evidence = derived.get("processing_evidence")
        if not isinstance(raw_evidence, list) or not raw_evidence:
            raise ValueError("DERIVED_PROCESSING_EVIDENCE_REQUIRED")
        expected = {
            "output_key": out["output_key"],
            "input_digests": sorted(item["content_digest"] for item in normalized_inputs),
            "method_digest": method_digest,
            "method_code_digest": method_code_digest,
            "parameter_digest": parameter_digest,
            "output_digest": self._output_payload_digest(out),
        }
        normalized = []
        valid_record = None
        saw_json = False
        for raw in raw_evidence:
            ref = self._resolve_content_ref(out, raw)
            if ref is None or not self._custody_ref_ok(ref):
                raise ValueError("DERIVED_PROCESSING_EVIDENCE_UNVERIFIED")
            entry = {"ref_id": ref.get("ref_id"), "ref_kind": "content",
                     "content_sha256": ref.get("content_sha256"),
                     "binding_verified": False}
            digest = self._content_digest(ref)
            try:
                record = json.loads((self.root / "evidence/sha256" / digest).read_bytes())
            except (OSError, ValueError, UnicodeDecodeError):
                record = None
            if isinstance(record, dict) and isinstance(record.get("processing_record"), dict):
                record = record["processing_record"]
            if isinstance(record, dict):
                saw_json = True
                record_errors = external_processing_record_errors(record, **expected)
                if not record_errors:
                    entry["binding_verified"] = True
                    valid_record = {
                        "ref_id": entry["ref_id"],
                        "content_sha256": entry["content_sha256"],
                        "output_digest": expected["output_digest"],
                        "input_digests": expected["input_digests"],
                    }
            normalized.append(entry)
        if valid_record is None:
            if saw_json:
                raise ValueError("DERIVED_PROCESSING_BINDING_MISMATCH")
            raise ValueError("DERIVED_PROCESSING_RECORD_REQUIRED")
        return normalized, valid_record

    def _prepare_derived_lineage(self, out, product, extension, source, dataset_id,
                                 output_policies):
        derived = extension.get("derived_lineage")
        declaration = product["declaration"]
        semantic_context = declaration.get("semantic_context") or {}
        derivation = semantic_context.get("derivation") or {}
        requires_lineage = (declaration.get("measurement_nature") == "derived"
                            or derivation.get("required") is True)
        if not requires_lineage:
            if derived is not None:
                raise ValueError("DERIVED_LINEAGE_NOT_APPLICABLE")
            return None
        if not self.has_permission("compute"):
            raise ValueError("CALLER_PERMISSION_DENIED:compute")
        if not self.has_permission("read"):
            raise ValueError("CALLER_PERMISSION_DENIED:read")
        if out["input_mode"] not in {"partial_observation", "explicit_increment"}:
            raise ValueError("DERIVED_INPUT_MODE_UNSUPPORTED:" + str(out["input_mode"]))
        if out["payload"]["kind"] == "metadata_revision":
            raise ValueError("DERIVED_METADATA_REVISION_NOT_SUPPORTED")
        if not isinstance(derived, dict):
            raise ValueError("DERIVED_LINEAGE_REQUIRED")
        if set(derived) - {"method", "inputs", "processing_evidence", "warmup", "validity"}:
            raise ValueError("DERIVED_LINEAGE_INVALID")
        method = derived.get("method")
        if not isinstance(method, dict):
            raise ValueError("DERIVED_METHOD_REQUIRED")
        method_id = method.get("method_id")
        version = method.get("version")
        declaration_body = method.get("declaration")
        if (not isinstance(method_id, str) or not method_id
                or not isinstance(version, str) or not version
                or not isinstance(declaration_body, dict) or not declaration_body):
            raise ValueError("DERIVED_METHOD_NOT_VERIFIABLE")
        parameter_version = method.get("parameter_version")
        parameters = method.get("parameters")
        if (not isinstance(parameter_version, str) or not parameter_version
                or not isinstance(parameters, dict)):
            raise ValueError("DERIVED_PARAMETERS_REQUIRED")
        method_body = {"method_id": method_id, "version": version,
                       "declaration": declaration_body}
        method_digest = "sha256:" + sha(canonical(method_body))
        parameter_body = {"method_id": method_id, "version": version,
                          "parameter_version": parameter_version, "parameters": parameters}
        parameter_digest = "sha256:" + sha(canonical(parameter_body))
        if method.get("digest") is not None and method.get("digest") != method_digest:
            raise ValueError("DERIVED_METHOD_DIGEST_MISMATCH")
        if method.get("parameter_digest") is not None and method.get("parameter_digest") != parameter_digest:
            raise ValueError("DERIVED_PARAMETER_DIGEST_MISMATCH")
        code_info = self._prepare_method_code(method, out)
        if (method.get("code_digest") is not None
                and method.get("code_digest") != code_info["code_digest"]):
            raise ValueError("DERIVED_METHOD_CODE_DIGEST_MISMATCH")
        inputs = derived.get("inputs")
        if not isinstance(inputs, list) or not inputs:
            raise ValueError("DERIVED_INPUT_REQUIRED")
        normalized_inputs = []
        seen = set()
        ancestry = None
        for pinned in inputs:
            if (not isinstance(pinned, dict)
                    or set(pinned) - {"dataset_id", "product_id", "snapshot_id",
                                      "content_digest", "role"}):
                raise ValueError("DERIVED_INPUT_INVALID")
            pinned_dataset = pinned.get("dataset_id")
            product_id = pinned.get("product_id")
            snapshot_id = pinned.get("snapshot_id")
            content_digest = pinned.get("content_digest")
            if not all(isinstance(value, str) and value for value in
                       (pinned_dataset, product_id, snapshot_id, content_digest)):
                raise ValueError("DERIVED_INPUT_INVALID")
            if pinned_dataset != dataset_id:
                # Specific refusal before any local product lookup: a foreign
                # dataset must never be resolved as this store's same-named object.
                raise ValueError("DERIVED_INPUT_DATASET_UNSUPPORTED:" + pinned_dataset)
            identity = (pinned_dataset, product_id, snapshot_id)
            if identity in seen:
                raise ValueError("DERIVED_INPUT_DUPLICATE")
            seen.add(identity)
            try:
                snapshot = self.engine._valid_snapshot_exact(snapshot_id, verify_payloads=True)
            except ValueError as exc:
                raise ValueError("DERIVED_INPUT_SNAPSHOT_UNAVAILABLE:" + snapshot_id) from exc
            if ancestry is None:
                ancestry = self.engine._active_ancestry()
            if snapshot_id not in ancestry:
                raise ValueError("DERIVED_INPUT_NOT_PUBLISHED:" + snapshot_id)
            discovered = self._discover_products(snapshot_id=snapshot_id)
            input_source_ids = sorted(discovered.get("source_ids_by_product", {}).get(product_id, []))
            if not input_source_ids:
                raise ValueError("DERIVED_INPUT_SOURCE_UNKNOWN:" + product_id)
            for input_source_id in input_source_ids:
                if self.allowed_sources.get(input_source_id, {}).get("may_read") is not True:
                    raise ValueError("SOURCE_READ_PERMISSION_MISSING:" + input_source_id)
            parts = self.engine._snapshot_product_parts(snapshot, product_id)
            if not parts:
                raise ValueError("DERIVED_INPUT_PRODUCT_UNAVAILABLE:" + product_id)
            actual = product_content_digest(product_id, parts)
            if actual != content_digest:
                raise ValueError("DERIVED_INPUT_DIGEST_MISMATCH:" + product_id)
            normalized_inputs.append({"dataset_id": pinned_dataset,
                                      "product_id": product_id,
                                      "snapshot_id": snapshot_id,
                                      "content_digest": content_digest,
                                      "role": pinned.get("role") or "input",
                                      "source_ids": input_source_ids})
        self._derived_warmup_errors(out, derived)
        normalized_evidence, processing_record = self._prepare_processing_evidence(
            derived, out, normalized_inputs, method_digest,
            code_info["code_digest"], parameter_digest)
        self.engine._write_immutable(
            f"catalog/product_service/derived_methods/{method_digest.removeprefix('sha256:')}.json",
            canonical(method_body))
        self.engine._write_immutable(
            f"catalog/product_service/derived_parameters/{parameter_digest.removeprefix('sha256:')}.json",
            canonical(parameter_body))
        body = {
            "format_version": "wfd.derived-lineage/1.0",
            "output_key": out["output_key"],
            "product_id": product["product_id"],
            "dataset_id": dataset_id,
            "declaration_digest": "sha256:" + sha(canonical(declaration)),
            "definition_authority": declaration.get("definition_authority"),
            "computation": "external",
            "method": {"method_id": method_id, "version": version,
                       "digest": method_digest,
                       "declaration_digest": "sha256:" + sha(canonical(declaration_body)),
                       "code_format": code_info["code_format"],
                       "code_digest": code_info["code_digest"],
                       "code_storage": code_info["code_storage"],
                       "code_content_sha256": code_info["code_content_sha256"],
                       "parameter_version": parameter_version,
                       "parameter_digest": parameter_digest},
            "inputs": normalized_inputs,
            "input_source_ids": sorted({sid for item in normalized_inputs
                                        for sid in item["source_ids"]}),
            "processing_evidence": normalized_evidence,
            "processing_record": processing_record,
            "output_digest": self._output_payload_digest(out),
            "warmup": copy.deepcopy(derived["warmup"]),
            "validity": copy.deepcopy(derived["validity"]),
            "semantic_derivation": copy.deepcopy(derivation),
            "source_ids": sorted(sid for sid, _ in output_policies),
        }
        lineage_digest = "sha256:" + sha(canonical(body))
        body["lineage_digest"] = lineage_digest
        self.engine._write_immutable(
            f"catalog/product_service/derived_lineage/{lineage_digest.removeprefix('sha256:')}.json",
            canonical({key: value for key, value in body.items() if key != "lineage_digest"}))
        return body

    @staticmethod
    def _compute_dependency_refs(lineage):
        refs = []
        for pinned in lineage["inputs"]:
            refs.append({
                "kind": "product_version", "dataset_id": pinned["dataset_id"],
                "namespace": "wfd.product", "id": pinned["product_id"],
                "version": pinned["snapshot_id"], "digest": pinned["content_digest"],
                "resolution": "pinned", "required": True, "dependency_type": "compute",
            })
        return refs

    def _formal_output_keys(self, prep, results):
        bindings = prep["normalized_doc"]["source_bundle"].get("_wfd_product_bindings", {})
        keys = []
        for item in results:
            if item.get("errors") or item.get("engine_publication_state") not in {None, "published_verified"}:
                continue
            metadata = prep["normalized_doc"]["source_bundle"].get("_wfd_metadata_versions", {}).get(item["output_key"], {})
            admission = self._merge_source_admissions(
                metadata.get("source_admission"), bindings.get(item["output_key"], {}).get("source_admission"))
            source_ids = admission.get("source_ids") or self._source_ids(prep["normalized_doc"]["source_bundle"])
            if source_ids and self.has_permission("publish") and self.engine.sandbox is False and all(
                    self.allowed_sources.get(sid, {}).get("may_publish_formal") is True for sid in source_ids):
                keys.append(item["output_key"])
        return keys

    def _publication_intent(self, prep):
        return "formal" if self._formal_output_keys(prep, prep.get("output_results", [])) else "sandbox"

    def _formal_publication(self, request_key, prep, publication, results, formal_keys=None):
        """Persist a formal publication decision only when every check is real."""
        successes = [item for item in results if item.get("engine_publication_state") == "published_verified"
                     and (formal_keys is None or item["output_key"] in formal_keys)]
        if not successes:
            return None, None
        normalized = prep["normalized_doc"]
        source = normalized["source_bundle"]
        bindings = source.get("_wfd_product_bindings", {})
        sid_for_meta = publication.get("snapshot_id")
        snapshot = self.engine.read_snapshot(sid_for_meta) if sid_for_meta else {"metadata_versions": []}
        formal_admissions = [self._merge_source_admissions(
            (self._select_metadata(snapshot, bindings.get(item["output_key"], {}).get("product", {}).get("product_id"), None, None) or {}).get("source_admission"),
            bindings.get(item["output_key"], {}).get("source_admission")) for item in successes]
        source_ids = sorted({sid for admission in formal_admissions
                             for sid in (admission.get("source_ids") or self._source_ids(source))})
        checks = {
            "caller_publish_role": self.has_permission("publish"),
            "source_formal_grant": bool(source_ids) and all(
                self.allowed_sources.get(sid, {}).get("may_publish_formal") is True for sid in source_ids
            ),
            "engine_not_sandbox": self.engine.sandbox is False,
        }
        sid = publication.get("snapshot_id")
        snap_path = self.root / f"catalog/snapshots/{sid}.json" if sid else None
        commit_path = self.root / f"catalog/commits/{sid}.json" if sid else None
        checks["snapshot_present"] = bool(snap_path and snap_path.is_file())
        checks["commit_marker_present"] = bool(commit_path and commit_path.is_file())
        checks["valid_commit"] = bool(sid and any(x.get("snapshot_id") == sid for x in self.engine._valid_snapshots()))
        checks["contracts_verified"] = True
        checks["dependencies_verified"] = True
        checks["evidence_custodied"] = True
        checks["fixed_readback_verified"] = True
        has_derived = any(
            (bindings.get(item["output_key"], {}).get("product", {}).get("declaration", {})
             .get("measurement_nature") == "derived") for item in successes)
        if has_derived:
            checks["derived_lineage_verified"] = True
            checks["input_source_read_authorized"] = True
        metadata_versions = self.engine.read_snapshot(sid).get("metadata_versions", []) if sid else []
        output_records = []
        for item in successes:
            key = item["output_key"]
            binding = bindings.get(key, {})
            product = binding.get("product")
            if not product:
                checks["contracts_verified"] = False
                continue
            try:
                self._verify_binding(product)
                self._check_dependencies(product["contracts"]["read"].get("dependencies", []), product["dataset_id"])
            except (ValueError, PermissionError):
                checks["dependencies_verified"] = False
            output = next((out for out in normalized["outputs"] if out["output_key"] == key), None)
            if product.get("declaration", {}).get("measurement_nature") == "derived":
                lineage = (source.get("_wfd_derived_lineage") or {}).get(key)
                if not isinstance(lineage, dict):
                    checks["derived_lineage_verified"] = False
                else:
                    digest = lineage.get("lineage_digest")
                    body = {k: copy.deepcopy(v) for k, v in lineage.items() if k != "lineage_digest"}
                    if digest != "sha256:" + sha(canonical(body)):
                        checks["derived_lineage_verified"] = False
                    lineages = product.get("contracts", {}).get("compute_dependencies", {})
                    if (lineages.get("lineage_ref", {}).get("digest") != digest
                            or lineages.get("derived_submission") != "verified_fixed_lineage"):
                        checks["derived_lineage_verified"] = False
                    try:
                        stored = self.engine._custodied_lineage_record(
                            "catalog/product_service/derived_lineage", digest,
                            {"format_version", "output_key", "product_id", "inputs", "method"})
                        if canonical(stored) != canonical(body):
                            checks["derived_lineage_verified"] = False
                        method = lineage.get("method") or {}
                        self.engine._custodied_lineage_record(
                            "catalog/product_service/derived_methods", method.get("digest"),
                            {"method_id", "version", "declaration"})
                        self.engine._custodied_lineage_record(
                            "catalog/product_service/derived_parameters", method.get("parameter_digest"),
                            {"method_id", "version", "parameter_version", "parameters"})
                        code_body = self.engine._custodied_lineage_record(
                            "catalog/product_service/derived_method_code", method.get("code_digest"),
                            {"code_format"})
                        if code_body.get("code_format") != method.get("code_format"):
                            checks["derived_lineage_verified"] = False
                        if "code" in code_body:
                            if not isinstance(code_body.get("code"), str) or not code_body["code"].strip():
                                checks["derived_lineage_verified"] = False
                        elif "content_sha256" in code_body:
                            code_digest = (code_body.get("content_sha256") or "").removeprefix("sha256:")
                            code_path = self.root / "evidence/sha256" / code_digest
                            if (len(code_digest) != 64 or not code_path.is_file()
                                    or sha(code_path.read_bytes()) != code_digest):
                                checks["derived_lineage_verified"] = False
                        else:
                            checks["derived_lineage_verified"] = False
                        for input_source_id in lineage.get("input_source_ids", []):
                            if self.allowed_sources.get(input_source_id, {}).get("may_read") is not True:
                                checks["input_source_read_authorized"] = False
                        readback = self._read(product["product_id"], snapshot_id=sid)
                        if not any((item.get("derived_lineage") or {}).get("lineage_digest") == digest
                                   for item in readback.get("products", [])):
                            checks["derived_lineage_verified"] = False
                    except (ValueError, OSError):
                        checks["derived_lineage_verified"] = False
            if (output or {}).get("payload", {}).get("kind") == "metadata_revision":
                metadata = self._select_metadata(snapshot, product["product_id"])
                if metadata is None:
                    checks["fixed_readback_verified"] = False
                    continue
                if metadata.get("coverage_ref") != "sha256:" + sha(canonical(metadata.get("coverage"))):
                    checks["fixed_readback_verified"] = False
                    continue
                if metadata.get("definition_ref") != product.get("definition_ref"):
                    checks["contracts_verified"] = False
                for ref in metadata.get("evidence_refs", []):
                    if ref.get("ref_kind") != "content":
                        continue
                    digest = (ref.get("content_sha256") or "").removeprefix("sha256:")
                    path = self.root / "evidence/sha256" / digest
                    if len(digest) != 64 or not path.is_file() or sha(path.read_bytes()) != digest:
                        checks["evidence_custodied"] = False
                readback = self._read(product["product_id"], snapshot_id=sid)
                readback_coverage = next((p.get("coverage_ref") for p in readback.get("products", [])
                                          if p.get("product_id") == product["product_id"]), None)
                if readback_coverage != metadata.get("coverage_ref"):
                    checks["fixed_readback_verified"] = False
                output_records.append({
                    "output_key": key, "product_id": product["product_id"],
                    "contract_ref": product.get("contract_ref"),
                    "contract_refs": copy.deepcopy(product.get("contract_refs")),
                    "contract_bundle_ref": copy.deepcopy(product.get("contract_bundle_ref")),
                    "metadata_ref": "sha256:" + sha(canonical(metadata)),
                    "coverage_ref": metadata.get("coverage_ref"),
                    "predecessor_ref": metadata.get("predecessor_ref"),
                    "published_revision_ids": [],
                    "published_content_sha256": None,
                })
                continue
            key_field = "event_id" if (output or {}).get("payload", {}).get("kind") == "event_records" else "business_key"
            versions = source.get("_wfd_row_versions", {}).get(key, {})
            expected = []
            for physical_row in (output or {}).get("payload", {}).get("rows", []):
                physical_key = physical_row.get(key_field)
                version = versions.get(physical_key)
                if not version:
                    checks["fixed_readback_verified"] = False
                    continue
                expected.append({
                    "revision_id": version["revision_id"],
                    "withdrawn": version["withdrawn"],
                    "logical_key": version["logical_key"],
                    "row": {**copy.deepcopy(physical_row), key_field: version["logical_key"]},
                })
            actual_by_revision = {}
            if expected:
                try:
                    readback = self._read(product["product_id"], snapshot_id=sid, include_history=True)
                    actual_by_revision = {item["record_ref"]["revision_id"]: item
                                          for item in readback.get("rows", [])
                                          if item["product_id"] == product["product_id"]}
                    for expected_row in expected:
                        actual = actual_by_revision.get(expected_row["revision_id"])
                        if (actual is None
                                or canonical(actual["row"]) != canonical(expected_row["row"])
                                or bool(actual["revision"]["withdrawn"]) != bool(expected_row["withdrawn"])):
                            checks["fixed_readback_verified"] = False
                            break
                except (ValueError, PermissionError):
                    checks["fixed_readback_verified"] = False
            else:
                checks["fixed_readback_verified"] = False
            evidenced_rows = [
                {**expected_row, "row": expected_row["row"]}
                for expected_row in expected
                if expected_row["revision_id"] in actual_by_revision
            ]
            revision_ids = sorted(x["revision_id"] for x in expected)
            evidence = []
            for ref in (output or {}).get("evidence_refs", []):
                if ref.get("ref_kind") != "content":
                    continue
                digest = (ref.get("content_sha256") or "").removeprefix("sha256:")
                path = self.root / "evidence/sha256" / digest
                ok = len(digest) == 64 and path.is_file() and sha(path.read_bytes()) == digest
                checks["evidence_custodied"] = checks["evidence_custodied"] and ok
                evidence.append({"content_sha256": "sha256:" + digest, "verified": ok})
            output_records.append({
                "output_key": key,
                "product_id": product["product_id"],
                "contract_ref": product.get("contract_ref"),
                "contract_refs": copy.deepcopy(product.get("contract_refs")),
                "contract_bundle_ref": copy.deepcopy(product.get("contract_bundle_ref")),
                "derived_lineage_digest": ((source.get("_wfd_derived_lineage") or {})
                                           .get(key, {}).get("lineage_digest")),
                "published_revision_ids": revision_ids,
                "published_content_sha256": "sha256:" + sha(canonical([
                    {"revision_id": x["revision_id"], "withdrawn": x["withdrawn"], "row": x["row"]}
                    for x in sorted(evidenced_rows, key=lambda z: z["revision_id"])
                ])),
                "evidence": evidence,
            })
        if not all(checks.values()):
            return None, checks
        record = {
            "format_version": "wfd.formal-publication/0.3",
            "service_version": SERVICE_VERSION,
            "request_key": request_key,
            "request_identity": copy.deepcopy(normalized["request_identity"]),
            "input_fingerprint": prep["input_fingerprint"],
            "snapshot_id": sid,
            "snapshot_file_sha256": sha(snap_path.read_bytes()),
            "commit_marker_sha256": sha(commit_path.read_bytes()),
            "raw_engine_status": publication.get("status"),
            "source_ids": source_ids,
            "source_formal_grants": {x: True for x in source_ids},
            "checks": checks,
            "outputs": output_records,
            "formal_publication_state": "published_formal",
        }
        path = f"catalog/product_service/formal_publications/{request_key}.json"
        self.engine._write_immutable(path, canonical(record))
        return path, record

    @staticmethod
    def _public_request_state(results, formal_verified):
        states = [item.get("publication_state") for item in results]
        if any(x == "committed_pending_activation" for x in states):
            return "publication_pending_activation"
        if formal_verified and any(x == "published_formal" for x in states):
            return "published_formal" if all(x == "published_formal" for x in states) else "partially_published_formal"
        if any(x == "published_sandbox" for x in states):
            return "published_sandbox" if all(x == "published_sandbox" for x in states) else "partially_published_sandbox"
        if any(item.get("registration_state") in {"registered", "reused"} for item in results):
            return "registered_not_published"
        return "rejected"

    def _persist_status_result(self, request_key, prep, publication, results,
                               formal_path=None, formal_record=None, service_status=None,
                               state=None, publication_intent=None):
        states = [item.get("publication_state") for item in results]
        content_refs = [
            ref for out in prep["normalized_doc"]["outputs"] for ref in out.get("evidence_refs", [])
            if ref.get("ref_kind") == "content"
        ]
        custody = "not_reached" if not content_refs else (
            "verified" if all(
                (ref.get("content_sha256") or "").removeprefix("sha256:") and
                (self.root / "evidence/sha256" / (ref.get("content_sha256") or "").removeprefix("sha256:")).is_file()
                for ref in content_refs) else "failed")
        phases = {
            "received": "accepted",
            "custody": custody,
            "registration": "registered" if any(
                item.get("registration_state") in {"registered", "reused"} for item in results) else "not_reached",
            "validation": "passed" if all("errors" not in item for item in results) else "failed",
            "publication": "published" if any(x in {"published_formal", "published_sandbox"} for x in states) else
                           ("pending" if "committed_pending_activation" in states else "not_published"),
        }
        state = state or self._public_request_state(results, formal_record is not None)
        self._persist_request_status(
            request_key, prep["normalized_doc"]["request_identity"], prep["input_fingerprint"],
            state, phases, results, publication.get("snapshot_id"),
            {"path": formal_path, "record": formal_record} if formal_record else None,
            [item.get("errors", []) for item in results if item.get("errors")],
            service_status=service_status or state,
            publication_intent=publication_intent,
        )
        return state

    def submit(self, doc):
        """Return separate registration and publication facts per output."""
        with writer_lock(self.root):
            return self._submit(doc)

    @staticmethod
    def _merge_source_admissions(*admissions):
        source_ids = set()
        roles = {}
        permissions = {}
        authority = None
        for admission in admissions:
            if not isinstance(admission, dict):
                continue
            source_ids.update(admission.get("source_ids", []))
            roles.update(copy.deepcopy(admission.get("roles", {})))
            permissions.update(copy.deepcopy(admission.get("permissions", {})))
            authority = admission.get("definition_authority") or authority
        return {"source_ids": sorted(source_ids), "roles": roles,
                "permissions": permissions, "definition_authority": authority}

    def _output_policies(self, source, output_key, policies, declaration=None):
        roles = source.get("source_roles")
        if not roles or roles is False:
            raise ValueError("SOURCE_ROLE_ASSIGNMENT_REQUIRED")
        if not isinstance(roles, dict) or output_key not in roles:
            raise ValueError("SOURCE_ROLE_ASSIGNMENT_REQUIRED")
        assignment = roles[output_key]
        if isinstance(assignment, dict):
            assignment = [{"source_id": sid, "roles": value}
                          for sid, value in assignment.items()]
        if not isinstance(assignment, list) or not assignment:
            raise ValueError("SOURCE_ROLE_ASSIGNMENT_INVALID")
        by_id = {sid: policy for sid, policy in policies}
        selected = []
        valid_roles = {"definer", "first_publisher", "republisher", "deliverer", "compiler", "acquirer"}
        for entry in assignment:
            if not isinstance(entry, dict) or set(entry) != {"source_id", "roles"}:
                raise ValueError("SOURCE_ROLE_ASSIGNMENT_INVALID")
            sid = entry["source_id"]
            role_list = entry["roles"]
            if sid not in by_id or not isinstance(role_list, list) or not role_list:
                raise ValueError("SOURCE_ROLE_ASSIGNMENT_INVALID")
            if set(role_list) - valid_roles:
                raise ValueError("SOURCE_ROLE_UNSUPPORTED")
            permitted = by_id[sid].get("allowed_roles", [])
            if set(role_list) - set(permitted):
                raise ValueError("SOURCE_ROLE_DENIED:" + sid)
            if declaration and set(role_list) & {"definer", "first_publisher"}:
                authority = str(declaration.get("definition_authority", ""))
                allowed = by_id[sid].get("allowed_authorities", [])
                if not any(authority == x or authority.startswith(x + ".") for x in allowed):
                    raise ValueError("SOURCE_AUTHORITY_DENIED:" + sid)
            selected.append((sid, by_id[sid]))
        if not selected:
            raise ValueError("SOURCE_ROLE_ASSIGNMENT_REQUIRED")
        return selected, "explicit"

    def _submit(self, doc):
        identity_info = self._identity_info(doc)
        prior_status = None
        if identity_info:
            identity, candidate_key, candidate_fingerprint = identity_info
            if not self.has_permission("submit"):
                return self._reject_response(None, "CALLER_PERMISSION_DENIED", "Caller lacks submit role", persist=False)
            if not self.actor_namespace_allowed(identity["trusted_actor_namespace"]):
                return self._reject_response(None, "ACTOR_NAMESPACE_UNTRUSTED",
                                             "Request actor namespace is not bound to this trusted caller", persist=False)
            prior_status = self._read_status(candidate_key)
            if prior_status and prior_status.get("input_fingerprint") != candidate_fingerprint:
                return self._reject_response(None, "REQUEST_ID_CONFLICT", "Original request contents changed", persist=False)
            if prior_status and self._terminal_state(prior_status.get("state")):
                return self._replay_response(prior_status)
        schema_errors = list(self.engine.validator.iter_errors(doc))
        if schema_errors:
            if identity_info:
                self._persist_rejection(identity_info, "SCHEMA_INVALID", schema_errors[0].message, "schema")
            return {"status": "rejected", "errors": [_issue("SCHEMA_INVALID", e.message) for e in schema_errors[:5]],
                    "output_results": [], "request_key": identity_info[1] if identity_info else None,
                    "request_state": "rejected", "production_publishable": False, "service_version": SERVICE_VERSION}
        if not doc["outputs"] or len({o["output_key"] for o in doc["outputs"]}) != len(doc["outputs"]):
            return self._reject_response(identity_info, "OUTPUT_KEYS_INVALID", "Nonempty unique output keys required")
        if not self.has_permission("submit"):
            return self._reject_response(identity_info, "CALLER_PERMISSION_DENIED", "Caller lacks submit role")
        source = doc["source_bundle"]
        try:
            policies = self._source_policies(source)
        except ValueError as exc:
            return self._reject_response(identity_info, str(exc).split(":")[0], str(exc))
        denied = [sid for sid, policy in policies if policy.get("may_submit") is not True]
        if denied:
            return self._reject_response(identity_info, "SOURCE_NOT_ADMITTED", "Explicit may_submit missing: " + ",".join(denied))
        try:
            extensions = self._extensions(source, [out["output_key"] for out in doc["outputs"]])
        except ValueError as exc:
            return self._reject_response(identity_info, str(exc), str(exc))
        request_key = self.engine._request_key(doc)
        fingerprint = self.engine._request_fingerprint(doc)
        prep_path = f"catalog/product_service/requests/{request_key}.json"
        if (self.root / prep_path).exists():
            prep = self._read_json(prep_path)
            if prep["input_fingerprint"] != fingerprint:
                return self._reject_response(None, "REQUEST_ID_CONFLICT", "Original request contents changed")
            auth_errors = self._current_authorization_errors(prep["normalized_doc"])
            if auth_errors:
                for error in auth_errors:
                    self._persist_rejection(identity_info, error["code"], error["message"], "current_authorization")
                return {"status": "rejected", "errors": auth_errors, "output_results": [],
                        "request_key": request_key, "request_state": "rejected",
                        "production_publishable": False, "service_version": SERVICE_VERSION}
        else:
            dataset_id = doc["request_identity"]["dataset_id"]
            dataset_path = "catalog/product_service/dataset.json"
            if (self.root / dataset_path).exists() and self._read_json(dataset_path)["dataset_id"] != dataset_id:
                return {"status": "rejected", "errors": [_issue("DATASET_MISMATCH", "One store must keep one dataset identity")],
                        "output_results": [], "production_publishable": False, "service_version": SERVICE_VERSION}
            self.engine._write_immutable(dataset_path, canonical({"dataset_id": dataset_id}))
            normalized = copy.deepcopy(doc)
            normalized["outputs"] = []
            bindings, results, batch_keys, row_versions, resolved_product_ids = {}, [], {}, {}, {}
            head = self.engine.head()
            current_products = {f["product_id"] for f in head["files"]} if head else set()
            for out in doc["outputs"]:
                item = {"output_key": out["output_key"], "registration_state": "not_registered", "publication_state": "not_published"}
                try:
                    output_policies, source_role_mode = self._output_policies(source, out["output_key"], policies,
                                                                              out.get("new_definition_declaration"))
                    errors = self._admit_output(out, source, output_policies)
                except ValueError as exc:
                    output_policies, source_role_mode, errors = [], "invalid", [_issue(str(exc).split(":")[0], str(exc))]
                if not errors:
                    try:
                        product, state = self._register(
                            out, dataset_id,
                            extensions.get("outputs", {}).get(out["output_key"], {}))
                        item.update(product_id=product["product_id"], definition_ref=product["definition_ref"],
                                    registration_state=state)
                        # Reuse has no new declaration in the request; authorize
                        # against the already resolved product declaration.
                        output_policies, source_role_mode = self._output_policies(
                            source, out["output_key"], policies, product["declaration"])
                        prior_product = self._head_product_binding(product["product_id"], head)
                        if prior_product is None and "read_dependencies" not in extensions.get("outputs", {}).get(out["output_key"], {}):
                            raise ValueError("READ_DEPENDENCY_DECLARATION_REQUIRED")
                        output_extension = extensions.get("outputs", {}).get(out["output_key"], {})
                        source_provenance = self._prepare_source_provenance(
                            out, product, source, output_extension)
                        derived_lineage = self._prepare_derived_lineage(
                            out, product, output_extension, source, dataset_id, output_policies)
                        product = self._bind_contract(product, output_extension, prior_product,
                                                      derived_lineage)
                        product["coverage"] = copy.deepcopy(out.get("coverage"))
                        product["coverage_ref"] = ("sha256:" + sha(canonical(product["coverage"]))
                                                   if product.get("coverage") is not None else None)
                        prior_coverage = (prior_product or {}).get("coverage")
                        prior_coverage_ref = ((prior_product or {}).get("coverage_ref")
                                              or ("sha256:" + sha(canonical(prior_coverage))
                                                  if prior_coverage is not None else None))
                        # Unchanged coverage preserves lineage rather than inventing a self-predecessor.
                        product["coverage_predecessor_ref"] = (
                            prior_product.get("coverage_predecessor_ref")
                            if prior_product and prior_coverage_ref is not None
                            and product["coverage_ref"] == prior_coverage_ref else prior_coverage_ref)
                        item["contract_ref"] = product["contract_ref"]
                        item["contract_refs"] = copy.deepcopy(product.get("contract_refs"))
                        item["contract_bundle_ref"] = copy.deepcopy(product.get("contract_bundle_ref"))
                        item["semantic_context"] = copy.deepcopy(product.get("semantic_context"))
                        item["semantic_context_version"] = product.get("semantic_context_version")
                    except ValueError as exc:
                        errors.append(_issue(str(exc).split(":")[0], str(exc)))
                if not errors:
                    keys = {row.get("business_key", row.get("event_id")) for row in out["payload"].get("rows", [])}
                    if keys & batch_keys.get(product["product_id"], set()):
                        errors.append(_issue("DUPLICATE_BATCH_BUSINESS_KEY", "Outputs for one product overlap within this request"))
                    payload_issues = ([] if out["payload"].get("kind") == "metadata_revision"
                                      else validate_payload(out, product["declaration"]))
                    payload_issues.extend(validate_units(product["declaration"], self.unit_registry))
                    errors.extend([_issue(x["code"], x["message"]) for x in payload_issues])
                if not errors:
                    try:
                        engine_out, versions = self._prepare_versions(out, product, extensions.get("outputs", {}).get(out["output_key"], {}),
                                                                     head["snapshot_id"] if head else None, fingerprint, source,
                                                                     prior_coverage_ref=prior_coverage_ref)
                    except ValueError as exc:
                        errors.append(_issue(str(exc).split(":")[0], str(exc)))
                if errors:
                    item["errors"] = errors
                else:
                    engine_out.update(definition_mode="create", definition_ref=None, new_definition_declaration=product["declaration"])
                    metadata = engine_out.pop("_wfd_metadata", None)
                    if metadata is not None:
                        normalized["source_bundle"].setdefault("_wfd_metadata_versions", {})[out["output_key"]] = metadata
                    if source_provenance is not None:
                        normalized["source_bundle"].setdefault("_wfd_source_attribution", {})[out["output_key"]] = source_provenance["attribution"]
                        normalized["source_bundle"].setdefault("_wfd_source_conflicts", {})[out["output_key"]] = source_provenance["conflicts"]
                    if derived_lineage is not None:
                        normalized["source_bundle"].setdefault("_wfd_derived_lineage", {})[out["output_key"]] = derived_lineage
                    normalized["outputs"].append(engine_out)
                    resolved_product_ids[out["output_key"]] = product["product_id"]
                    bindings[out["output_key"]] = {
                        "product": product,
                        "source_role_mode": source_role_mode,
                        "source_admission": {
                            "source_ids": [sid for sid, _ in output_policies],
                            "roles": {entry["source_id"]: list(entry["roles"])
                                      for entry in (source.get("source_roles", {}).get(out["output_key"], [])
                                                    if isinstance(source.get("source_roles"), dict) else [])},
                            "definition_authority": product["declaration"].get("definition_authority"),
                            "permissions": {sid: {flag: policy.get(flag) for flag in sorted(SOURCE_FLAGS)}
                                            for sid, policy in output_policies},
                            "input_source_ids": (copy.deepcopy(derived_lineage.get("input_source_ids", []))
                                                 if derived_lineage is not None else []),
                        },
                    }
                    row_versions[out["output_key"]] = versions
                    original_times = source.get("row_public_times", {}).get(out["output_key"], {})
                    normalized["source_bundle"].setdefault("row_public_times", {})[out["output_key"]] = {
                        physical: original_times[version["logical_key"]] for physical, version in versions.items()
                        if version["logical_key"] in original_times}
                    batch_keys.setdefault(product["product_id"], set()).update(keys)
                results.append(item)
            groups = extensions.get("consistency_groups", {})
            failed_keys = {item["output_key"] for item in results if item.get("errors")}
            changed = True
            while changed:
                changed = False
                for members in groups.values():
                    if any(key in failed_keys for key in members):
                        for item in results:
                            if item["output_key"] in members and not item.get("errors"):
                                item["errors"] = [_issue("CONSISTENCY_GROUP_FAILED",
                                                         "Consistency group has a failed member; no member is published")]
                                item["publication_state"] = "not_published"
                                failed_keys.add(item["output_key"])
                                changed = True
            if failed_keys:
                normalized["outputs"] = [out for out in normalized["outputs"]
                                         if out["output_key"] not in failed_keys]
            publish_plan = {
                "outputs": [out["output_key"] for out in doc["outputs"]],
                "consistency_groups": copy.deepcopy(groups),
                "independent_outputs": [out["output_key"] for out in doc["outputs"]
                                        if not any(out["output_key"] in members for members in groups.values())],
            }
            normalized["source_bundle"].update({
                "raw_source_bytes_custodied": True,
                "source_ids": [sid for sid, _ in policies],
                "_wfd_product_bindings": bindings,
                "_wfd_resolved_product_ids": resolved_product_ids,
                "_wfd_received_time": _second_now(),
                "_wfd_service_version": SERVICE_VERSION,
                "_wfd_row_versions": row_versions,
                "_wfd_source_admission": {
                    sid: {flag: policy.get(flag) for flag in sorted(SOURCE_FLAGS)}
                    for sid, policy in policies
                },
            })
            prep = {"input_fingerprint": fingerprint, "normalized_doc": normalized,
                    "output_results": results, "publish_plan": publish_plan}
            self.engine._write_immutable(prep_path, canonical(prep))
        normalized = prep["normalized_doc"]
        results = copy.deepcopy(prep["output_results"])
        current_intent = self._publication_intent(prep)
        publication_intent = (prior_status or {}).get("publication_intent") or current_intent
        if not normalized["outputs"]:
            state = self._persist_status_result(request_key, prep, {}, results)
            rejected_status = "registered_not_published" if any(
                item.get("registration_state") in {"registered", "reused"} for item in results) else "rejected"
            return {"status": rejected_status, "request_key": request_key, "request_state": state,
                    "output_results": results, "production_publishable": False, "service_version": SERVICE_VERSION}
        try:
            receipt = self.engine.submit(normalized)
        except Exception as exc:
            # The engine may have committed before losing its return. Preserve
            # the committed snapshot identity for recovery, but do not claim a
            # formal decision that was never completed.
            recovered_publication = {}
            try:
                recovered_snapshots = {s["snapshot_id"]: s for s in self.engine._valid_snapshots()}
                committed = next((s for s in recovered_snapshots.values()
                    if s.get("request_key") == request_key and
                    s.get("request_fingerprint") == self.engine._request_fingerprint(normalized)), None)
                if committed is not None:
                    recovered_publication = committed.get("receipt", {})
            except Exception:
                recovered_publication = {}
            state = self._persist_status_result(
                request_key, prep, recovered_publication, results, state="publication_unknown",
                service_status="publication_unknown", publication_intent=publication_intent,
            )
            return {"status": "publication_unknown", "request_key": request_key,
                    "request_state": state, "snapshot_id": recovered_publication.get("snapshot_id"),
                    "output_results": results,
                    "errors": [_issue("PUBLICATION_UNKNOWN", repr(exc))],
                    "production_publishable": False, "service_version": SERVICE_VERSION}
        snapshots = {s["snapshot_id"]: s for s in self.engine._valid_snapshots()}
        publication = receipt
        if not receipt.get("outputs_success"):
            committed = next((s for s in snapshots.values()
                if s.get("request_key") == request_key and
                s.get("request_fingerprint") == self.engine._request_fingerprint(normalized)), None)
            if committed is not None:
                publication = committed["receipt"]
        succeeded = set(publication.get("outputs_success", []))
        rejected = {r["output_key"]: r["errors"] for r in publication.get("outputs_rejected", publication.get("output_results", [])) if "output_key" in r}
        active_lineage = set()
        state = self.engine.diagnose_head()
        if state["ok"]:
            cursor = state.get("snapshot_id")
            while cursor and cursor not in active_lineage:
                active_lineage.add(cursor)
                cursor = snapshots.get(cursor, {}).get("parent_snapshot_id")
        pending = bool(succeeded) and publication.get("snapshot_id") not in active_lineage
        for item in results:
            key = item["output_key"]
            if key in succeeded:
                item["engine_publication_state"] = "committed_pending_activation" if pending else "published_verified"
                item["snapshot_id"] = publication["snapshot_id"]
                item["publication_state"] = "committed_pending_activation" if pending else "published_sandbox"
            elif key in rejected:
                item["errors"] = rejected[key]
            elif "errors" not in item:
                item["errors"] = receipt.get("errors", [_issue("NOT_PUBLISHED", receipt["status"])])
        formal_keys = self._formal_output_keys(prep, results)
        formal_path, formal_checks = (None, None)
        if succeeded and not pending:
            if receipt.get("idempotent_replay"):
                prior_formal_path = self.root / f"catalog/product_service/formal_publications/{request_key}.json"
                if prior_formal_path.is_file():
                    formal_path = str(prior_formal_path.relative_to(self.root))
                    formal_checks = self._read_json(prior_formal_path.relative_to(self.root)).get("checks")
                elif prior_status and prior_status.get("state") == "publication_pending_activation":
                    if current_intent == "formal":
                        formal_path, formal_checks = self._formal_publication(request_key, prep, publication, results, formal_keys)
                    else:
                        state = self._persist_status_result(
                            request_key, prep, publication, results, state="publication_unknown",
                            service_status="publication_unknown", publication_intent=publication_intent)
                        return {"status": "publication_unknown", "request_key": request_key,
                                "request_state": state, "output_results": results,
                                "errors": [_issue("FORMAL_PUBLICATION_PERMISSION_REQUIRED",
                                                  "Pending formal publication cannot continue with current permissions")],
                                "production_publishable": False, "service_version": SERVICE_VERSION}
                elif prior_status and prior_status.get("state") == "publication_unknown":
                    if publication_intent == "formal" and current_intent == "formal":
                        formal_path, formal_checks = self._formal_publication(request_key, prep, publication, results, formal_keys)
                    elif publication_intent == "formal":
                        state = self._persist_status_result(
                            request_key, prep, publication, results, state="publication_unknown",
                            service_status="publication_unknown", publication_intent=publication_intent)
                        return {"status": "publication_unknown", "request_key": request_key,
                                "request_state": state, "output_results": results,
                                "errors": [_issue("FORMAL_PUBLICATION_PERMISSION_REQUIRED",
                                                  "Original formal publication cannot continue with current permissions")],
                                "production_publishable": False, "service_version": SERVICE_VERSION}
            else:
                formal_path, formal_checks = self._formal_publication(request_key, prep, publication, results, formal_keys)
            if formal_path:
                for item in results:
                    if item.get("engine_publication_state") == "published_verified" and item["output_key"] in formal_keys:
                        item["publication_state"] = "published_formal"
        summary_names = ("published_formal", "published_sandbox", "committed_pending_activation", "not_published")
        summary = {name: sum(item["publication_state"] == name for item in results) for name in summary_names}
        status = publication["status"]
        if summary["committed_pending_activation"]:
            status = "partially_committed_pending_head" if summary["not_published"] else "published_commit_pending_head"
        elif summary["published_formal"] and (summary["not_published"] or summary["published_sandbox"]):
            status = "partially_published_formal"
        elif summary["published_formal"]:
            status = "published_formal"
        elif summary["published_sandbox"] and summary["not_published"]:
            status = "partially_published_sandbox"
        elif summary["published_sandbox"]:
            status = "published_sandbox"
        elif any(item.get("registration_state") in {"registered", "reused"} for item in results):
            status = "registered_not_published"
        public_state = self._persist_status_result(request_key, prep, publication, results, formal_path, formal_checks,
                                                    service_status=status, publication_intent=publication_intent)
        return {"status": status, "snapshot_id": publication.get("snapshot_id"),
                "publication_summary": summary, "output_results": results,
                "engine_receipt": receipt, "commit_receipt": publication,
                "request_key": request_key, "request_state": public_state,
                "formal_publication_receipt": formal_path,
                "formal_publication_checks": formal_checks,
                "formal_publication_verified": bool(formal_path),
                "idempotent_replay": bool(receipt.get("idempotent_replay")),
                "service_version": SERVICE_VERSION, "production_publishable": False}

    @staticmethod
    def _public_evidence_ref(ref):
        allowed = {"ref_id", "ref_kind", "content_sha256", "binding_digest"}
        return {key: ref.get(key) for key in sorted(allowed) if key in ref}

    @staticmethod
    def _public_unit_definitions(units):
        allowed = {"dimension", "base_unit", "multiplier", "currency",
                   "scale_decimal", "scale", "version", "authority"}
        result = {}
        for code, entry in (units or {}).items():
            definition = entry.get("definition", {}) if isinstance(entry, dict) else {}
            result[code] = {
                "definition": {key: definition.get(key) for key in sorted(allowed) if key in definition},
                "digest": entry.get("digest") if isinstance(entry, dict) else None,
            }
        return result

    def _public_product(self, product):
        public = copy.deepcopy(product)
        semantic = public.setdefault("contracts", {}).setdefault("semantic", {})
        semantic["unit_definitions"] = self._public_unit_definitions(semantic.get("unit_definitions", {}))
        admission = public.get("source_admission")
        if isinstance(admission, dict):
            public["source_admission"] = {
                "source_ids": copy.deepcopy(admission.get("source_ids", [])),
                "permissions": copy.deepcopy(admission.get("permissions", {})),
            }
        return public

    def _public_projection_metadata(self, products, source_ids):
        projections = []
        for product in products:
            body = copy.deepcopy(product)
            projections.append({
                "product_id": product.get("product_id"),
                "original_contract_ref": copy.deepcopy(product.get("contract_ref")),
                "original_contract_refs": copy.deepcopy(product.get("contract_refs")),
                "original_contract_bundle_ref": copy.deepcopy(product.get("contract_bundle_ref")),
                "projection_digest": "sha256:" + sha(canonical(body)),
                "projection_scope": "public product body (unit provenance paths/raw originals omitted)",
                "complete_contract_body": False,
            })
        return {
            "format_version": "wfd.public-projection/0.1",
            "source_paths": "omitted",
            "raw_original_text": "omitted",
            "evidence_refs": "content digests only; locator fields omitted",
            "source_ids": copy.deepcopy(source_ids),
            "contract_bodies": "partial",
            "complete_contract_bodies": False,
            "contract_projections": projections,
            "contract_refs": [copy.deepcopy(product.get("contract_ref")) for product in products],
            "contract_role_refs": [copy.deepcopy(product.get("contract_refs")) for product in products],
            "contract_bundle_refs": [copy.deepcopy(product.get("contract_bundle_ref")) for product in products],
        }

    def _public_read_result(self, result):
        # 正式用途治理的唯一共用闸口：data_only.fixed_read、固定分页、
        # system_held、整产品页与 ProductQuery 的批次优化路径都汇于此。
        # 每次调用都从 catalog 重读当前事项，不缓存到进程启动时。
        from . import usage_suspension
        governance = usage_suspension.enforce_read(
            self.root, result, audit_issue_id=self._usage_audit_issue_id)
        public = copy.deepcopy(result)
        if governance is not None:
            notes = list(public.get("diagnostics") or [])
            for issue in governance["known_issues"]:
                notes.append({"code": "USAGE_KNOWN_ISSUE", "decision": "audit_reproduction",
                              "diagnostic_source": "usage_governance",
                              "message": issue["reason"], "issue_id": issue["issue_id"],
                              "error_type": issue["error_type"], "issue_state": issue["state"],
                              "publishable": False, "compute_eligible": False})
            public["diagnostics"] = notes
            public["usage_governance"] = governance
        rows = []
        for item in result.get("rows", []):
            item_public = {key: copy.deepcopy(value) for key, value in item.items()
                           if key not in {"source", "evidence_refs", "source_ids",
                                          "source_attribution", "source_conflicts",
                                          "derived_lineage_digest"}}
            item_public["evidence_refs"] = [self._public_evidence_ref(ref)
                                            for ref in item.get("evidence_refs", [])]
            source_binding = {
                "source_ids": copy.deepcopy(item.get("source_ids", [])),
                "contract_ref": copy.deepcopy(item.get("contract_ref")),
            }
            if item.get("source_attribution"):
                source_binding["source_attribution"] = copy.deepcopy(item["source_attribution"])
            if item.get("source_conflicts"):
                source_binding["source_conflicts"] = copy.deepcopy(item["source_conflicts"])
            if item.get("derived_lineage_digest"):
                source_binding["derived_lineage_digest"] = item["derived_lineage_digest"]
            item_public["source_binding"] = source_binding
            rows.append(item_public)
        public["rows"] = rows
        public["products"] = [self._public_product(product) for product in result.get("products", [])]
        public["public_projection"] = self._public_projection_metadata(
            public["products"], result.get("source_ids", []))
        public.pop("source_ids_by_product", None)
        return public

    def discover_products(self, *, snapshot_id, subject=None):
        """Discover the actual fixed contract bindings, not the latest registry."""
        self.require_permission("read")
        result = self._discover_products(snapshot_id=snapshot_id, subject=subject)
        self._authorize_sources(result.get("source_ids", []))
        result["products"] = [self._public_product(product) for product in result.get("products", [])]
        result["public_projection"] = self._public_projection_metadata(
            result.get("products", []), result.get("source_ids", []))
        result.pop("source_ids_by_product", None)
        return result

    def _discover_products(self, *, snapshot_id, subject=None):
        if not snapshot_id:
            raise ValueError("FIXED_SNAPSHOT_REQUIRED")
        snapshot = self.engine.read_snapshot(snapshot_id)
        products = {}
        source_ids = set()
        source_ids_by_product = {}
        for entry in snapshot["files"]:
            binding = entry["source_bundle"].get("_wfd_product_bindings", {}).get(entry["output_key"])
            if not binding or binding["product"]["product_id"] != entry["product_id"]:
                raise ValueError("PRODUCT_METADATA_NOT_AVAILABLE")
            product = copy.deepcopy(binding["product"])
            lineage = (entry.get("source_bundle", {}).get("_wfd_derived_lineage") or {}).get(entry["output_key"])
            if lineage:
                product["derived_lineage"] = copy.deepcopy(lineage)
            attribution = (entry.get("source_bundle", {}).get("_wfd_source_attribution") or {}).get(entry["output_key"])
            if attribution:
                product["source_attribution"] = copy.deepcopy(attribution)
            metadata = self._select_metadata(snapshot, product["product_id"])
            if metadata:
                product["coverage"] = copy.deepcopy(metadata.get("coverage"))
                product["coverage_ref"] = metadata.get("coverage_ref")
                product["coverage_predecessor_ref"] = metadata.get("predecessor_ref")
                product["source_admission"] = copy.deepcopy(metadata.get("source_admission"))
            self._verify_binding(product)
            if subject is None or product["subject"] == subject:
                key = (product["product_id"], (product.get("contract_ref") or {}).get("digest", "legacy"))
                products[key] = copy.deepcopy(product)
                admission = self._merge_source_admissions(
                    (metadata or {}).get("source_admission"), binding.get("source_admission"))
                ids = set(admission.get("source_ids") or self._source_ids(entry.get("source_bundle", {})))
                ids.update(admission.get("input_source_ids", []))
                if lineage:
                    ids.update(lineage.get("input_source_ids", []))
                source_ids.update(ids)
                source_ids_by_product.setdefault(product["product_id"], set()).update(ids)
        return {"snapshot_id": snapshot_id, "products": list(products.values()),
                "source_ids": sorted(source_ids),
                "source_ids_by_product": {key: sorted(value) for key, value in source_ids_by_product.items()}}

    def _derived_stale_basis(self, lineage, snapshot):
        """Expose fixed lineage impact evidence; P4 owns the stale decision."""
        evaluated = snapshot.get("snapshot_id")
        inputs = []
        for pinned in lineage.get("inputs", []):
            record = {"product_id": pinned.get("product_id"),
                      "pinned_snapshot_id": pinned.get("snapshot_id"),
                      "pinned_content_digest": pinned.get("content_digest"),
                      "observed_content_digest": None,
                      "changed_since_pin": None,
                      "state": "indeterminate"}
            if evaluated == pinned.get("snapshot_id"):
                record.update(observed_content_digest=pinned.get("content_digest"),
                              changed_since_pin=False, state="unchanged")
                inputs.append(record)
                continue
            cursor = evaluated
            seen = set()
            ancestor = False
            while cursor and cursor not in seen:
                seen.add(cursor)
                if cursor == pinned.get("snapshot_id"):
                    ancestor = True
                    break
                try:
                    parent = self.engine._valid_snapshot_exact(cursor, verify_payloads=False)
                except ValueError:
                    break
                cursor = parent.get("parent_snapshot_id")
            if not ancestor:
                inputs.append(record)
                continue
            try:
                parts = self.engine._snapshot_product_parts(snapshot, pinned.get("product_id"))
                observed = product_content_digest(pinned["product_id"], parts) if parts else None
            except (ValueError, OSError):
                observed = None
            if observed is None:
                inputs.append(record)
                continue
            changed = observed != pinned.get("content_digest")
            record.update(observed_content_digest=observed,
                          changed_since_pin=changed,
                          state="changed" if changed else "unchanged")
            inputs.append(record)
        states = {item["state"] for item in inputs}
        if "changed" in states:
            basis_state = "input_changed"
        elif states == {"unchanged"}:
            basis_state = "current"
        else:
            basis_state = "indeterminate"
        return {"format_version": "wfd.derived-stale-basis/1.0",
                "evaluated_at_snapshot": evaluated,
                "lineage_digest": lineage.get("lineage_digest"),
                "inputs": inputs,
                "basis_state": basis_state,
                "decision_owner": "P4",
                "note": "P3c preserves the pinned input and exposes digest impact; it does not recompute or silently replace the result."}

    def read(self, product_id=None, *, snapshot_id, perspective="snapshot_contents", at=None, subject=None, include_history=False, verify_contract_files=True):
        self.require_permission("read")
        result = self._read(product_id, snapshot_id=snapshot_id, perspective=perspective, at=at,
                            subject=subject, include_history=include_history,
                            verify_contract_files=verify_contract_files)
        self._authorize_sources(result.get("source_ids", []))
        return self._public_read_result(result)

    def _read(self, product_id=None, *, snapshot_id, perspective="snapshot_contents", at=None, subject=None, include_history=False, verify_contract_files=True):
        if not snapshot_id:
            raise ValueError("FIXED_SNAPSHOT_REQUIRED")
        if perspective not in {"snapshot_contents", "market_known_at", "system_held_at"}:
            raise ValueError("UNSUPPORTED_READ_PERSPECTIVE")
        if perspective != "snapshot_contents":
            if at is None:
                raise ValueError("HISTORICAL_CUTOFF_REQUIRED")
            datetime.strptime(at, "%Y-%m-%dT%H:%M:%SZ")
        snapshot = self.engine.read_snapshot(snapshot_id)
        rows, diagnostics, products, checked_dependencies = [], [], {}, set()
        source_ids = set()
        source_ids_by_product = {}
        source = {}
        entries = [entry for entry in snapshot["files"] if not product_id or entry["product_id"] == product_id]
        blocks = self.engine.read_product(product_id, snapshot_id=snapshot["snapshot_id"])
        parts_by_product = {}
        for entry, block in zip(entries, blocks):
            parts_by_product.setdefault(entry["product_id"], []).append({
                "output_key": entry["output_key"], "payload_kind": entry["payload_kind"],
                "input_mode": entry.get("input_mode"), "rows": block["rows"],
                "source": block["source"]})
        content_digests = {pid: product_content_digest(pid, parts)
                           for pid, parts in parts_by_product.items()}
        for entry, block in zip(entries, blocks):
            source = block["source"]
            # The manifest's declaration, subject and file output key identify
            # the embedded binding, not the newest live registration file.
            binding = source.get("_wfd_product_bindings", {}).get(entry["output_key"])
            if not binding or binding["product"]["product_id"] != block["product_id"]:
                raise ValueError("PRODUCT_METADATA_NOT_AVAILABLE")
            product = copy.deepcopy(binding["product"])
            product["content_digest"] = content_digests.get(product["product_id"])
            lineage = (source.get("_wfd_derived_lineage") or {}).get(entry["output_key"])
            if lineage:
                product["derived_lineage"] = copy.deepcopy(lineage)
                product["derived_stale_basis"] = self._derived_stale_basis(lineage, snapshot)
            metadata = self._select_metadata(snapshot, product["product_id"], perspective, at)
            if metadata:
                product["coverage"] = copy.deepcopy(metadata.get("coverage"))
                product["coverage_ref"] = metadata.get("coverage_ref")
                product["coverage_predecessor_ref"] = metadata.get("predecessor_ref")
                product["source_admission"] = copy.deepcopy(metadata.get("source_admission"))
            admission = self._merge_source_admissions(
                (metadata or {}).get("source_admission"), binding.get("source_admission"))
            input_source_ids = sorted(set(admission.get("input_source_ids", []))
                                       | set((lineage or {}).get("input_source_ids", [])))
            if input_source_ids:
                admission["input_source_ids"] = input_source_ids
            product["source_admission"] = admission
            entry_source_ids = sorted(set(admission.get("source_ids") or self._source_ids(source))
                                      | set(input_source_ids))
            source_ids.update(entry_source_ids)
            source_ids_by_product.setdefault(entry["product_id"], set()).update(entry_source_ids)
            self._verify_binding(product, verify_contract_files=verify_contract_files)
            self._check_dependencies(product["contracts"]["read"].get("dependencies", []), product["dataset_id"], checked_dependencies)
            contract_ref = product.get("contract_ref")
            products[(product["product_id"], (contract_ref or {}).get("digest", "legacy"))] = product
            versions = source.get("_wfd_row_versions", {}).get(entry["output_key"], {})
            for physical_row in block["rows"]:
                row = copy.deepcopy(physical_row)
                key_field = "event_id" if entry["payload_kind"] == "event_records" else "business_key"
                physical_key = row[key_field]
                version = versions.get(physical_key)
                if version is None:
                    # Deterministic compatibility identity for already-published
                    # 0.1 records; no source file or old snapshot is rewritten.
                    version = {"logical_key": physical_key, "revision_id": "r_legacy_" + sha(canonical([product["product_id"], row]))[:32],
                               "supersedes": None, "input_mode": entry["input_mode"], "withdrawn": False, "reason": None}
                row[key_field] = version["logical_key"]
                row_subject = row.get("subject", product["subject"])
                if subject is not None and row_subject != subject:
                    continue
                time = row.get("public_time", source.get("public_time"))
                business_key = version["logical_key"]
                time = source.get("row_public_times", {}).get(entry["output_key"], {}).get(physical_key, time)
                if perspective == "system_held_at":
                    time = source.get("_wfd_received_time")
                eligibility = eligibility_at(time, at, mode=perspective)
                item = {"product_id": product["product_id"], "row": row, "subject": row_subject,
                        "definition_ref": product["definition_ref"], "eligibility": eligibility,
                        "evidence_refs": block["evidence"], "source": source,
                        "source_ids": list(entry_source_ids), "contract_ref": contract_ref,
                        "revision": copy.deepcopy(version),
                        "record_ref": {"product_id": product["product_id"], "snapshot_id": snapshot_id,
                                       "logical_key": business_key, "revision_id": version["revision_id"]}}
                attribution = (source.get("_wfd_source_attribution") or {}).get(entry["output_key"])
                if attribution:
                    item["source_attribution"] = copy.deepcopy(attribution)
                conflicts = (source.get("_wfd_source_conflicts") or {}).get(entry["output_key"]) or []
                item_conflicts = [copy.deepcopy(conflict) for conflict in conflicts
                                  if conflict.get("business_key") == business_key]
                if item_conflicts:
                    item["source_conflicts"] = item_conflicts
                if lineage:
                    item["derived_lineage_digest"] = lineage.get("lineage_digest")
                if eligibility["decision"] == "eligible":
                    rows.append(item)
                else:
                    diagnostics.append({"product_id": product["product_id"], "business_key": business_key,
                                        "subject": row_subject, "object": row.get("object"),
                                        "relation_type": row.get("relation_type"), "contract_ref": contract_ref,
                                        "revision_id": version["revision_id"], **eligibility})
        # Eligibility is evaluated above, before supersession. A correction or
        # withdrawal that was not knowable at T cannot hide the earlier value.
        grouped = {}
        for item in rows:
            grouped.setdefault((item["product_id"], item["record_ref"]["logical_key"]), []).append(item)
        selected = []
        for group in grouped.values():
            leaves = self._version_leaves(group)
            leaf_ids = {item["record_ref"]["revision_id"] for item in leaves}
            for item in group:
                item["revision_state"] = ("withdrawn" if item["revision"]["withdrawn"] else
                    "current" if item["record_ref"]["revision_id"] in leaf_ids else "superseded")
            if include_history:
                selected.extend(group)
                continue
            if len(leaves) != 1 or leaves[0]["revision"]["withdrawn"]:
                item = group[-1]
                diagnostics.append({"product_id": item["product_id"], "business_key": item["record_ref"]["logical_key"],
                    "subject": item["subject"], "object": item["row"].get("object"),
                    "relation_type": item["row"].get("relation_type"), "contract_ref": item["contract_ref"],
                    "decision": "ineligible" if len(leaves) == 1 else "indeterminate",
                    "reason": "WITHDRAWN_AT_PERSPECTIVE" if len(leaves) == 1 else "REVISION_BRANCH_CONFLICT"})
            else:
                selected.extend(leaves)
        rows = selected
        visible_products = {(item["product_id"], (item.get("contract_ref") or {}).get("digest", "legacy")) for item in rows + diagnostics}
        visible_product_ids = {key[0] for key in visible_products}
        if product_id is not None or subject is not None:
            source_ids = set()
            for pid in visible_product_ids:
                source_ids.update(source_ids_by_product.get(pid, set()))
        return {"snapshot_id": snapshot["snapshot_id"], "perspective": perspective, "at": at,
                "held_scope": "received_structured" if perspective == "system_held_at" else None,
                "rows": rows, "diagnostics": diagnostics, "include_history": include_history,
                "products": [p for key, p in products.items() if key in visible_products],
                "source_ids": sorted(source_ids),
                "source_ids_by_product": {key: sorted(value) for key, value in source_ids_by_product.items()}}

    def company_view(self, company_ref, *, snapshot_id, perspective="snapshot_contents", at=None):
        self.require_permission("read")
        result = self._read(snapshot_id=snapshot_id, perspective=perspective, at=at)
        identities, relations, matched_relations = [company_ref], [], set()
        directions = {"issued_by": ("object", "subject", "entity", "instrument"),
                      "has_security": ("subject", "object", "entity", "instrument"),
                      "listing_of": ("object", "subject", "instrument", "listing"),
                      "has_listing": ("subject", "object", "instrument", "listing"),
                      "listed_on": ("subject", "object", "listing", "market")}
        for item in result["rows"]:
            row = item["row"]
            if row.get("relation_type") not in directions:
                continue
            if at is not None:
                period = row.get("effective_period", {})
                if period.get("status") != "known" or not (period["earliest_utc"] <= at < period["latest_exclusive_utc"]):
                    result["diagnostics"].append({"product_id": item["product_id"], "business_key": row["business_key"],
                        "subject": item["subject"], "object": row.get("object"), "relation_type": row["relation_type"],
                        "contract_ref": item.get("contract_ref"),
                        "decision": "indeterminate" if period.get("status") != "known" else "ineligible",
                        "reason": "RELATION_EFFECTIVE_PERIOD"})
                    continue
            relations.append(item)
        # Three typed links only: company -> instrument -> listing -> market.
        for _ in range(3):
            for item in relations:
                row = item["row"]
                origin, target, origin_kind, target_kind = directions[row["relation_type"]]
                left, right = row[origin], row[target]
                if left in identities and left["kind"] == origin_kind and right["kind"] == target_kind:
                    matched_relations.add(id(item))
                    if right not in identities:
                        identities.append(right)
        result["rows"] = [item for item in result["rows"] if
            id(item) in matched_relations or
            (item["row"].get("relation_type") not in directions and item["subject"] in identities)]
        result["diagnostics"] = [item for item in result["diagnostics"]
            if item.get("subject") in identities or
            (item.get("relation_type") in directions and item.get("object") in identities)]
        visible_products = {(item["product_id"], (item.get("contract_ref") or {}).get("digest", "legacy"))
                            for item in result["rows"] + result["diagnostics"]}
        result["products"] = [p for p in result["products"]
            if (p["product_id"], (p.get("contract_ref") or {}).get("digest", "legacy")) in visible_products]
        relevant_ids = {product["product_id"] for product in result["products"]}
        relevant_sources = set()
        for pid in relevant_ids:
            relevant_sources.update(result.get("source_ids_by_product", {}).get(pid, []))
        result["source_ids"] = sorted(relevant_sources)
        self._authorize_sources(result["source_ids"])
        public = self._public_read_result(result)
        public["company"] = company_ref
        public["identities"] = identities
        public["relation_scope"] = "company_instrument_listing_market"
        return public

    def read_calendar(self, product_id, *, snapshot_id, start_date=None, end_date=None,
                      perspective="snapshot_contents", at=None):
        self.require_permission("read")
        discovered = self._discover_products(snapshot_id=snapshot_id)
        products = [p for p in discovered["products"] if p["product_id"] == product_id]
        if not products:
            raise ValueError("PRODUCT_NOT_FOUND")
        self._authorize_sources(discovered.get("source_ids_by_product", {}).get(product_id, []))
        fields = {f["field_code"]: f["data_type"] for f in products[0]["declaration"].get("field_definitions", [])}
        if fields.get("session_date") != "text" or fields.get("is_open") != "boolean":
            raise ValueError("CALENDAR_CONTRACT_REQUIRED")
        for value in (start_date, end_date):
            if value is not None:
                datetime.strptime(value, "%Y-%m-%d")
        if start_date and end_date and start_date > end_date:
            raise ValueError("CALENDAR_RANGE_INVALID")
        result = self._read(product_id, snapshot_id=snapshot_id, perspective=perspective, at=at)
        self._authorize_sources(result.get("source_ids", []))
        result["rows"] = [item for item in result["rows"]
            if (not start_date or item["row"]["values"]["session_date"]["value"] >= start_date)
            and (not end_date or item["row"]["values"]["session_date"]["value"] <= end_date)]
        result["rows"].sort(key=lambda item: item["row"]["values"]["session_date"]["value"])
        public = self._public_read_result(result)
        public.update(start_date=start_date, end_date=end_date)
        return public

    def trace(self, product_id, *, snapshot_id):
        """Return fixed definition/contracts and verified evidence locations."""
        self.require_permission("read")
        self.require_permission("read_evidence")
        result = self._read(product_id, snapshot_id=snapshot_id, include_history=True)
        self._authorize_sources(result.get("source_ids", []), evidence=True)
        projected = self._public_read_result(result)
        evidence = {}
        for item in projected["rows"]:
            for ref in item["evidence_refs"]:
                digest = (ref.get("content_sha256") or "").removeprefix("sha256:")
                if not digest:
                    continue
                rel = f"evidence/sha256/{digest}"
                path = self.root / rel
                evidence[digest] = {"reference": ref, "relative_path": rel,
                                    "verified": path.is_file() and sha(path.read_bytes()) == digest}
        return {"snapshot_id": snapshot_id, "products": projected["products"],
                "evidence": list(evidence.values()), "public_projection": projected["public_projection"]}
