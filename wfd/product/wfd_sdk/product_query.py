"""P4a1 bounded product read over the existing WFDProductService.

This module is a narrow, fixed-snapshot query wrapper.  It deliberately does
not implement a second storage reader and it does not call the service's
private read path.  The authoritative eligibility/version decision remains
inside ``WFDProductService.read`` (public method), which also performs source
admission and the public projection.  This wrapper adds only:

* fixed request schema validation (``wfd.read/1.3-product1``);
* a preflight scan budget over the product's manifest files;
* exact ``IdentityRef`` subject matching;
* typed business-time role / interval matching;
* typed value-field projection with exact decimals and value states;
* deterministic ordering and query-bound cursors.

``system_held_at`` is intentionally rejected: the source bundle's
``_wfd_received_time`` is not target-instance holding evidence.  P4a2 must add
the instance ledger before that perspective can be declared.
"""
from __future__ import annotations

import base64
import binascii
import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from .duckdb_sdk import canonical, sha
from .product_governance import NULL_STATES
from . import product_calendar
from .product_service import SERVICE_VERSION, current_only_business
from . import row_version_objects


PROTOCOL_VERSION = "wfd.read/1.3-product1"
PROTOCOL_VERSION_P4B = "wfd.read/1.3-product1b"
RESULT_FORMAT = "wfd.read-product-result/0.1"
CAPABILITY_FORMAT = "wfd.product-query-capabilities/0.1"
CURSOR_FORMAT = "wfd.cursor/1"
SCHEMA_NAME = "wfd-read-product.schema.json"

MAX_PAGE_SIZE = 500
MAX_SCAN_BYTES = 256 * 1024 * 1024
MAX_SCAN_ROWS = 200_000

SORT_KEYS = [
    "business_time_known",
    "business_time_earliest_utc",
    "business_time_latest_exclusive_utc",
    "product_id",
    "logical_key",
    "revision_id",
]

P4A1_CONTEXT_OPERATIONS = {
    "read_company_context",
    "read_relation_graph",
    "read_applicable_rules",
    "read_event_timeline",
}
P4B_OPERATIONS = P4A1_CONTEXT_OPERATIONS | {"trace_evidence"}
DATA_ONLY_PUBLIC_QUERY_OPERATIONS = P4A1_CONTEXT_OPERATIONS | {"read_product"}

NON_NULL_STATES = {"valid_value", "reported_zero"}
VALID_VALUE_STATES = NON_NULL_STATES | set(NULL_STATES)

LIMITATIONS = [
    "P4a1 data_only 公开 read_product 以及四个有界上下文操作"
    "（read_company_context/read_relation_graph/read_applicable_rules/"
    "read_event_timeline）；trace_evidence 属 BD 来源/证据追溯，不向 data_only 开放。",
    "上下文读取只返回 WFD 结构化业务数据、身份、业务时间、记录/版本身份、内部定义"
    "和四合同引用；不返回来源/证据/加工定位，也不代理 BD 追溯。",
    "规则只覆盖有限主体/市场、有效期、历史资格与冲突并列；不支持优先级裁决、"
    "例外表达式或规则解释器，不新增表达式框架。",
    "system_held_at 使用既有 WFD 实例持有台账；不把来源 _wfd_received_time "
    "冒充目标实例持有。",
    "没有文件范围/行组时间索引；max_scan_bytes 与 max_nodes 保守按该产品全部 manifest "
    "文件预检，不声明下推。",
    "底层存储 SDK 没有可中断的硬执行时间预算；不支持 max_execution_time_ms，"
    "不把读完后检查冒充限时。",
    "这是 P4a1 有界实现，不声明完整 P4、规则优先级/例外解释器、P5、P6 或 P7 已完成。",
]


class ProductQueryError(ValueError):
    """Structured, deterministic rejection for the product query boundary."""

    def __init__(self, code: str, message: str, details=None):
        self.code = str(code)
        self.message = str(message)
        self.details = copy.deepcopy(details or {})
        super().__init__(self.code + ": " + self.message)

    def as_dict(self):
        return {"code": self.code, "message": self.message,
                "details": copy.deepcopy(self.details)}


def _utc(value: str):
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _utc_text(value: datetime):
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _schema_error(exc) -> dict:
    return {"path": getattr(exc, "json_path", "$"),
            "message": str(exc.message)}


def load_product_schema(protocol_root=None):
    """Load the product read schema and a resolver-backed validator.

    The shared ``wfd.read/1.3-candidate`` schema is not modified; this loader
    only reads the existing ``wfd-common`` definitions and the new product
    schema.  ``check_schema`` is called at construction time so a malformed
    schema fails before any request is served.
    """
    root = Path(protocol_root) if protocol_root is not None else (
        Path(__file__).resolve().parents[1] / "protocol")
    schema_dir = root / "schemas"
    documents, raw_schema = {}, None
    for path in sorted(schema_dir.glob("*.schema.json")):
        if path.name.startswith("._"):
            continue
        raw = path.read_bytes()
        if path.name == SCHEMA_NAME:
            raw_schema = raw
        documents[path.name] = json.loads(raw.decode("utf-8"))
    if SCHEMA_NAME not in documents or raw_schema is None:
        raise ProductQueryError("READ_SCHEMA_NOT_FOUND",
                                "Product read schema is missing",
                                {"path": str(schema_dir / SCHEMA_NAME)})
    schema = documents[SCHEMA_NAME]
    registry = Registry()
    for document in documents.values():
        registry = registry.with_resource(document["$id"], Resource.from_contents(document))
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, registry=registry)
    return (schema, validator, "sha256:" + sha(raw_schema),
            "sha256:" + sha(canonical(schema)))


def _product_key(product):
    return (product.get("product_id"),
            (product.get("contract_ref") or {}).get("digest", "legacy"))


def _declaration_fields(product):
    """Return the value fields declared by one fixed product contract."""
    declaration = product.get("declaration") or {}
    if product.get("payload_kind") == "scalar_rows":
        return {"value_decimal": {
            "field_code": "value_decimal",
            "data_type": "decimal",
            "unit_code": declaration.get("unit_code"),
            "measurement_nature": declaration.get("measurement_nature"),
            "time_role": declaration.get("time_role"),
        }}
    fields = {}
    for field in declaration.get("field_definitions", []) or []:
        if isinstance(field, dict) and field.get("field_code"):
            fields[field["field_code"]] = copy.deepcopy(field)
    return fields


def _unique_dicts(values):
    result, seen = [], set()
    for value in values:
        if value is None:
            continue
        key = canonical(value)
        if key in seen:
            continue
        seen.add(key)
        result.append(copy.deepcopy(value))
    return result


class ProductQuery:
    """Fixed-snapshot, bounded ``read_product`` query boundary."""

    def __init__(self, service, *, protocol_root=None):
        self.service = service
        self.root = Path(service.root)
        (self.schema, self.validator, self.schema_sha256,
         self.schema_canonical_sha256) = load_product_schema(protocol_root)
        self.schema_id = self.schema.get("$id")

    # ------------------------------------------------------------------ capabilities
    def capabilities(self):
        data_only = getattr(self.service, "profile", None) == "data_only"
        context_scope = "P4a1_data_only_public" if data_only else "P4b_read_only"
        operations = {
            "read_product": {
                "supported": True,
                "scope": "P4a1",
                "fixed_snapshot_required": True,
                "requires_caller_role": "read",
                "source_authorization": "delegated to WFDProductService.read",
            },
            "read_company_context": {
                "supported": True,
                "scope": context_scope,
                "requires": ["fixed snapshot", "subject", "read permission"],
                "identity_rule": "company / instrument / listing / market identities stay separate",
            },
            "read_relation_graph": {
                "supported": True,
                "scope": context_scope,
                "max_depth": 3,
                "unknown_effective_period": "returned as indeterminate, never traversed as confirmed",
                "future_or_unknown_eligibility": "does not expand the identity set",
            },
            "read_applicable_rules": {
                "supported": True,
                "scope": context_scope,
                "identification": "semantic_context.content_nature=definition_rule or a "
                                  "legacy supported rule_code/rule_id declaration; never a "
                                  "semantic-code substring match",
                "no_rule_products": "explicit coverage gap, not an empty success",
                "conflicts": "all matching bases returned side by side",
                "priority_and_exception_interpreter": "not_implemented",
            },
            "read_event_timeline": {
                "supported": True,
                "scope": context_scope,
                "plan_and_actual": "kept as separate content_nature/status",
            },
            "trace_evidence": {
                "supported": not data_only,
                "scope": "BD_not_WFD" if data_only else "P4b_read_only",
                "requires_caller_role": "read_evidence",
                "requires_source": "may_read_evidence",
                "permission_denied": "explicit gap without evidence details",
            },
        }
        if data_only:
            operations["trace_evidence"]["unsupported_reason"] = (
                "trace_evidence is BD source/evidence provenance; data_only exposes "
                "only structured business data and WFD record/version identity")
        return {
            "format_version": CAPABILITY_FORMAT,
            "protocol_version": PROTOCOL_VERSION,
            "profile": "data_only" if data_only else "legacy",
            "schema_id": self.schema_id,
            "schema_sha256": self.schema_sha256,
            "schema_canonical_sha256": self.schema_canonical_sha256,
            "service_version": SERVICE_VERSION,
            "operations": operations,
            "exposed_public_operations": (
                sorted(DATA_ONLY_PUBLIC_QUERY_OPERATIONS)
                if data_only else sorted(P4B_OPERATIONS | {"read_product"})),
            "projection": {
                "data_only": ("context rows/edges return structured values, identity, "
                              "record_id/record_version/record_ref, definition_ref, "
                              "business definition_authority/publisher, four contract_refs "
                              "and contract_bundle_ref; source_binding/evidence_refs and "
                              "processing locators are omitted")
                if data_only else "legacy public read contract retained",
                "source_binding": "omitted" if data_only else "legacy",
                "evidence_refs": "omitted" if data_only else "legacy",
            },
            "read_product": {
                "history_modes": {
                    "snapshot_contents": {
                        "supported": True,
                        "eligibility": "fixed snapshot only; not a PIT claim",
                    },
                    "market_known_at": {
                        "supported": True,
                        "eligibility": "reuses WFDProductService eligibility before revision selection",
                        "knowledge_cutoff_rules": {
                            "second_precision_point": "one-second TimeWithPrecision interval; use earliest_utc",
                            "coarse_precision_conservative_lower_bound":
                                "day/year/etc. interval; use earliest_utc and never treat the whole "
                                "interval as already known",
                            "unknown": "KNOWLEDGE_CUTOFF_UNKNOWN",
                        },
                    },
                    "system_held_at": {
                        "supported": bool(getattr(self.service, "profile", None) == "data_only"),
                        "required": ["held_scope", "usable_stage", "knowledge_cutoff"],
                        "held_scope": "actual WFD instance_id with holding facts",
                        "usable_stage": ["acquired", "custodied", "published_readable"],
                        "unsupported_reason": ("instance holding facts only for data_only; "
                                               "legacy source received time is not used"),
                        **({"error_code": "INSTANCE_HOLDING_SCOPE_NOT_IMPLEMENTED"}
                           if getattr(self.service, "profile", None) != "data_only" else {}),
                    },
                },
                "subject_matching": "exact IdentityRef (kind, namespace, id)",
                "field_projection": {
                    "only_declared_value_fields": True,
                    "scalar_value_decimal": True,
                    "exact_decimal_strings": True,
                    "value_states_preserved": True,
                    "unknown_and_not_applicable_are_not_bare_null": True,
                    "unit_envelope": True,
                },
                "business_time": {
                    "roles": ["observation", "statistical_period", "event", "public",
                              "expected", "effective", "validity", "session_date", "declared"],
                    "role_must_be_declared_by_fixed_contract": True,
                    "session_date_uses_source_timezone_only": True,
                    "dst_gap_fold": "rejected",
                    "real_utc_interval_overlap": True,
                    "timezone_required": True,
                    "inclusion_rule": "the stored row interval must be fully contained in "
                                      "the query interval; partial overlap is indeterminate",
                    "unknown_or_partial_is_indeterminate": True,
                    "row_time_fields": ["observation_time", "event_time", "public_time",
                                        "expected_time", "effective_period", "session_date"],
                },
                "pagination": {
                    "max_page_size": MAX_PAGE_SIZE,
                    "stable_sort": SORT_KEYS,
                    "cursor_binds_query_hash": True,
                    "cursor_binds_last_stable_key": True,
                    "cursor_survives_new_instance": True,
                    "per_page_permission_check": True,
                },
                "budget": {
                    "max_scan_bytes_required": True,
                    "max_nodes_required_as_row_cap": True,
                    "preflight_before_payload_read": True,
                    "scan_scope": "selected_snapshot_all_files_plus_product_read_plus_declared_dependencies",
                    "verification_scope": "selected_snapshot_and_declared_read_dependencies_only",
                    "unrelated_snapshots_scanned": False,
                    "file_range_pushdown": False,
                    "row_range_pushdown": False,
                    "hard_execution_time_ms": False,
                    "max_scan_bytes": MAX_SCAN_BYTES,
                    "max_nodes": MAX_SCAN_ROWS,
                    "counted_actual_objects": {
                        "selected_snapshot_verification": True,
                        "selected_product_payload_read": True,
                        "dependency_snapshot_verification": True,
                        "metadata_repeat_reads": True,
                    },
                    "note": "The selected snapshot's files are verified once, the selected "
                            "product payload is read once, and declared dependency snapshots "
                            "are dereferenced once. Commit/snapshot/manifest repeat reads are "
                            "counted. No unrelated newer snapshot is scanned.",
                },
                "instance_ledger": False,
            },
            "scope": {
                "package": "P4a1",
                "p4_complete": False,
                "p4a1_context_public_read": ("four_operations_data_only" if data_only
                                             else "p4b_read_only_scope"),
                "p4a2_instance_holding": ("first_segment" if data_only else False),
                "p4b_operations": ("data_only_four_context_operations" if data_only
                                   else "implemented_read_only_scope"),
                "p4b_complete": False,
                "rule_priority_exception_engine": False,
                "p5": False,
                "p6": False,
                "p7": False,
            },
            "limitations": list(LIMITATIONS),
        }

    # ------------------------------------------------------------------ request helpers
    def _validate_request(self, request):
        if not isinstance(request, dict):
            raise ProductQueryError("READ_REQUEST_SCHEMA_INVALID",
                                    "Read request must be a JSON object",
                                    {"schema_id": self.schema_id})
        operation = request.get("operation")
        errors = sorted(self.validator.iter_errors(request),
                        key=lambda exc: list(exc.absolute_path))
        if errors:
            raise ProductQueryError(
                "READ_REQUEST_SCHEMA_INVALID",
                "Request does not match " + PROTOCOL_VERSION,
                {"schema_id": self.schema_id, "schema_sha256": self.schema_sha256,
                 "schema_canonical_sha256": self.schema_canonical_sha256,
                 "errors": [_schema_error(exc) for exc in errors[:10]],
                 "error_count": len(errors)})
        if operation in P4B_OPERATIONS and request.get("protocol_version") != PROTOCOL_VERSION_P4B:
            raise ProductQueryError(
                "PROTOCOL_VERSION_REQUIRED",
                "P4b context operations require the product1b protocol version",
                {"operation": operation, "required_protocol_version": PROTOCOL_VERSION_P4B})
        if request.get("max_execution_time_ms") is not None:
            raise ProductQueryError(
                "HARD_EXECUTION_BUDGET_UNSUPPORTED",
                "The storage SDK cannot interrupt a read at a hard time limit",
                {"field": "max_execution_time_ms",
                 "supported": False,
                 "reason": "no interruptible execution deadline in the underlying storage SDK"})

    def _knowledge_cutoff(self, request):
        if request["history_mode"] == "snapshot_contents":
            return None, {"effective_utc": None, "rule": "not_applicable",
                          "coarse": False, "precision": None}
        cutoff = request.get("knowledge_cutoff")
        if not isinstance(cutoff, dict) or cutoff.get("status") != "known":
            raise ProductQueryError(
                "KNOWLEDGE_CUTOFF_UNKNOWN",
                "A market-known read requires a known knowledge cutoff",
                {"knowledge_cutoff": copy.deepcopy(cutoff)})
        earliest, latest = cutoff.get("earliest_utc"), cutoff.get("latest_exclusive_utc")
        if not earliest or not latest:
            raise ProductQueryError("KNOWLEDGE_CUTOFF_INVALID",
                                    "Known cutoff requires both UTC endpoints",
                                    {"knowledge_cutoff": copy.deepcopy(cutoff)})
        try:
            left, right = _utc(earliest), _utc(latest)
        except ValueError as exc:
            raise ProductQueryError("KNOWLEDGE_CUTOFF_INVALID",
                                    "Cutoff endpoints must be second-precision UTC",
                                    {"detail": str(exc)}) from exc
        if right <= left:
            raise ProductQueryError("KNOWLEDGE_CUTOFF_INVALID",
                                    "Cutoff interval must be nonempty",
                                    {"knowledge_cutoff": copy.deepcopy(cutoff)})
        exact_point = (cutoff.get("precision") == "second"
                       and right - left == timedelta(seconds=1))
        rule = "second_precision_point" if exact_point else \
            "coarse_precision_conservative_lower_bound"
        info = {
            "effective_utc": earliest,
            "rule": rule,
            "coarse": not exact_point,
            "precision": cutoff.get("precision"),
            "note": ("A coarse daily/yearly cutoff uses only the interval start. "
                     "Facts that could have become known later inside the cutoff "
                     "interval are not treated as already known."),
        }
        return earliest, info

    @staticmethod
    def _local_to_utc(naive, zone, value):
        """Resolve a local bound to UTC, rejecting DST gaps and folds."""
        first = naive.replace(tzinfo=zone, fold=0).astimezone(timezone.utc)
        second = naive.replace(tzinfo=zone, fold=1).astimezone(timezone.utc)
        first_roundtrip = first.astimezone(zone).replace(tzinfo=None)
        second_roundtrip = second.astimezone(zone).replace(tzinfo=None)
        if first_roundtrip != naive or second_roundtrip != naive:
            raise ProductQueryError(
                "BUSINESS_TIME_NONEXISTENT_LOCAL",
                "Local business-time bound does not exist in the requested timezone",
                {"value": value, "timezone": str(zone),
                 "rule": "DST gap is rejected; no implicit shift"})
        if first != second:
            raise ProductQueryError(
                "BUSINESS_TIME_AMBIGUOUS_LOCAL",
                "Local business-time bound is ambiguous in the requested timezone",
                {"value": value, "timezone": str(zone),
                 "rule": "DST fold is rejected; an explicit offset/fold would be required"})
        return first

    def _business_time_range(self, request):
        raw = request.get("business_time_range")
        if raw is None:
            return None
        timezone_name = raw["timezone"]
        try:
            zone = ZoneInfo(timezone_name)
        except (ZoneInfoNotFoundError, ValueError, TypeError) as exc:
            raise ProductQueryError("BUSINESS_TIMEZONE_UNKNOWN",
                                    "Unknown business-time timezone",
                                    {"timezone": timezone_name}) from exc

        def naive(value):
            if len(value) == 10:
                return datetime.strptime(value, "%Y-%m-%d")
            return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S")

        try:
            start_naive = naive(raw["start"])
            if len(raw["end"]) == 10:
                end_naive = naive(raw["end"]) + timedelta(days=1)
                end_is_second = False
            else:
                end_naive = naive(raw["end"])
                end_is_second = True
            start = self._local_to_utc(start_naive, zone, raw["start"])
            end = self._local_to_utc(end_naive, zone, raw["end"])
            if end_is_second:
                end += timedelta(seconds=1)
        except ProductQueryError:
            raise
        except ValueError as exc:
            raise ProductQueryError("BUSINESS_TIME_RANGE_INVALID",
                                    "Business-time bounds are not valid calendar values",
                                    {"detail": str(exc)}) from exc
        if end <= start:
            raise ProductQueryError("BUSINESS_TIME_RANGE_INVALID",
                                    "Business-time range must be nonempty",
                                    {"start": raw["start"], "end": raw["end"],
                                     "timezone": timezone_name})
        return {
            "role": raw["role"],
            "start": raw["start"],
            "end": raw["end"],
            "timezone": timezone_name,
            "start_utc": _utc_text(start),
            "end_utc": _utc_text(end),
            "boundary_rule": "date-only end is inclusive by whole local day; "
                             "datetime end is inclusive by that second",
            "dst_rule": "nonexistent and ambiguous local bounds are rejected",
        }

    def _query_hash(self, request, cutoff_info, business_range):
        cutoff = request.get("knowledge_cutoff")
        cutoff_for_hash = None
        if cutoff is not None:
            cutoff_for_hash = {
                "status": cutoff.get("status"),
                "precision": cutoff.get("precision"),
                "earliest_utc": cutoff.get("earliest_utc"),
                "latest_exclusive_utc": cutoff.get("latest_exclusive_utc"),
                "source_timezone": cutoff.get("source_timezone"),
                "effective_utc": cutoff_info.get("effective_utc"),
                "rule": cutoff_info.get("rule"),
            }
        body = {
            "protocol_version": PROTOCOL_VERSION,
            "dataset_id": request["dataset_id"],
            "snapshot_id": request["snapshot_id"],
            "product_id": request["product_id"],
            "subject": copy.deepcopy(request.get("subject")),
            "fields": sorted(request["fields"]),
            "business_time_range": copy.deepcopy(business_range),
            "history_mode": request["history_mode"],
            "knowledge_cutoff": cutoff_for_hash,
            "held_scope": request.get("held_scope"),
            "usable_stage": request.get("usable_stage"),
            "sort": list(SORT_KEYS),
        }
        return "sha256:" + sha(canonical(body))

    # ------------------------------------------------------------------ cursor
    @staticmethod
    def _encode_cursor(query_hash, snapshot_id, sort_key):
        payload = {"v": CURSOR_FORMAT, "q": query_hash, "s": snapshot_id,
                   "last": list(sort_key)}
        raw = base64.urlsafe_b64encode(canonical(payload)).rstrip(b"=")
        return raw.decode("ascii")

    @staticmethod
    def _decode_cursor(token):
        try:
            padding = "=" * ((4 - len(token) % 4) % 4)
            raw = base64.urlsafe_b64decode((token + padding).encode("ascii"))
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeError, binascii.Error, json.JSONDecodeError) as exc:
            raise ProductQueryError("CURSOR_INVALID",
                                    "Cursor is not a valid opaque WFD cursor",
                                    {"reason": str(exc)}) from exc
        if not isinstance(data, dict) or set(data) != {"v", "q", "s", "last"}:
            raise ProductQueryError("CURSOR_INVALID", "Cursor fields are invalid")
        if data.get("v") != CURSOR_FORMAT:
            raise ProductQueryError("CURSOR_INVALID", "Cursor version is unsupported",
                                    {"version": data.get("v")})
        if not isinstance(data.get("q"), str) or not data["q"].startswith("sha256:"):
            raise ProductQueryError("CURSOR_INVALID", "Cursor query hash is invalid")
        if not isinstance(data.get("s"), str) or not data["s"]:
            raise ProductQueryError("CURSOR_INVALID", "Cursor snapshot id is invalid")
        last = data.get("last")
        if (not isinstance(last, list) or len(last) != len(SORT_KEYS)
                or type(last[0]) is not int or last[0] not in (0, 1)
                or not all(type(value) is str for value in last[1:])):
            raise ProductQueryError("CURSOR_INVALID", "Cursor sort key is invalid")
        return data

    @staticmethod
    def _sort_key(item):
        business_time = item.get("business_time") or {}
        known = (business_time.get("status") == "known"
                 and bool(business_time.get("earliest_utc"))
                 and bool(business_time.get("latest_exclusive_utc")))
        record = item.get("record_ref") or {}
        return (
            0 if known else 1,
            business_time.get("earliest_utc") or "",
            business_time.get("latest_exclusive_utc") or "",
            str(item.get("product_id") or ""),
            str(record.get("logical_key") or ""),
            str(record.get("revision_id") or ""),
        )

    # ------------------------------------------------------------------ snapshot preflight
    def _rooted(self, relative):
        root = self.root.resolve()
        target = (root / relative).resolve()
        if target != root and root not in target.parents:
            raise ProductQueryError("SNAPSHOT_PATH_INVALID",
                                    "Snapshot metadata path escapes the store root",
                                    {"relative": str(relative)})
        return target

    def _snapshot_metadata(self, snapshot_id):
        """Read one commit/snapshot/manifest chain without scanning payloads."""
        commit_path = self.root / "catalog/commits" / (snapshot_id + ".json")
        try:
            commit_bytes = commit_path.read_bytes()
            marker = json.loads(commit_bytes.decode("utf-8"))
            if marker.get("snapshot_id") != snapshot_id:
                raise ValueError("commit marker snapshot id mismatch")
            snapshot_path = self._rooted(row_version_objects.snapshot_relative(marker, snapshot_id))
            snapshot_bytes = snapshot_path.read_bytes()
            if sha(snapshot_bytes) != marker["snapshot_sha256"]:
                raise ValueError("snapshot digest mismatch")
            snapshot = json.loads(snapshot_bytes.decode("utf-8"))
            if snapshot.get("snapshot_id") != snapshot_id:
                raise ValueError("snapshot id mismatch")
            manifest_path = self._rooted(snapshot["manifest_relpath"])
            manifest_bytes = manifest_path.read_bytes()
            if sha(manifest_bytes) != snapshot["manifest_sha256"]:
                raise ValueError("manifest digest mismatch")
            manifest = json.loads(manifest_bytes.decode("utf-8"))
            if manifest.get("files") != snapshot.get("files"):
                raise ValueError("manifest/snapshot file list mismatch")
            row_version_objects.project_snapshot(self.root, snapshot)
            # Equality above binds the physical lists. Reuse only the validated
            # source projections; iteration/canonical bytes remain physical.
            manifest["files"] = snapshot["files"]
        except ProductQueryError:
            raise
        except (OSError, KeyError, TypeError, ValueError, AttributeError,
                json.JSONDecodeError) as exc:
            raise ProductQueryError(
                "SNAPSHOT_UNAVAILABLE_OR_INVALID",
                "Fixed snapshot metadata is unavailable or fails its declared digests",
                {"snapshot_id": snapshot_id, "detail": str(exc)}) from exc
        return (snapshot, manifest, len(commit_bytes), len(snapshot_bytes),
                len(manifest_bytes))

    def _preflight_snapshot(self, snapshot_id):
        return self._snapshot_metadata(snapshot_id)

    def fixed_filter_products(self, *, snapshot_id, product_ids, max_scan_bytes):
        """Authorize fixed filter bindings without an unbudgeted payload discovery.

        The ordinary service discovery verifies all snapshot payloads. A
        bounded filter instead reads the same authenticated metadata chain,
        then delegates every value/qualification decision to execute().
        """
        self.service.require_permission("read")
        _, manifest, commit_bytes, snapshot_bytes, manifest_bytes = self._preflight_snapshot(snapshot_id)
        object_bytes = row_version_objects.reference_inventory(manifest)["unique_bytes"]
        metadata_bytes = commit_bytes + snapshot_bytes + manifest_bytes + object_bytes
        if metadata_bytes > max_scan_bytes:
            raise ProductQueryError("SCAN_BUDGET_EXCEEDED", "Fixed filter metadata exceeds the scan allowance",
                                    {"required_scan_bytes": metadata_bytes, "max_scan_bytes": max_scan_bytes})
        selected = set(product_ids)
        entries = [entry for entry in manifest["files"] if entry.get("product_id") in selected]
        self._authorize_metadata_sources(self._source_ids_from_entries(entries), require_nonempty=bool(entries))
        products = self._manifest_products(entries)
        return {"products": list(products.values()), "metadata_bytes": metadata_bytes,
                **({"row_version_object_validation_bytes": object_bytes} if object_bytes else {})}

    def _manifest_products(self, entries):
        products = {}
        for entry in entries:
            bindings = (entry.get("source_bundle") or {}).get("_wfd_product_bindings") or {}
            binding = bindings.get(entry.get("output_key"))
            product = (binding or {}).get("product")
            if (not isinstance(product, dict)
                    or product.get("product_id") != entry.get("product_id")):
                raise ProductQueryError(
                    "PRODUCT_METADATA_NOT_AVAILABLE",
                    "Manifest entry does not carry its fixed product binding",
                    {"product_id": entry.get("product_id"),
                     "output_key": entry.get("output_key")})
            products[_product_key(product)] = copy.deepcopy(product)
        return products

    # ------------------------------------------------------------------ metadata authorization/dependencies
    @staticmethod
    def _source_ids_from_entries(entries):
        source_ids = set()
        for entry in entries:
            bundle = entry.get("source_bundle") or {}
            bindings = bundle.get("_wfd_product_bindings") or {}
            binding = bindings.get(entry.get("output_key")) or {}
            admission = binding.get("source_admission") or {}
            source_ids.update(admission.get("source_ids") or [])
            source_ids.update(bundle.get("source_ids") or [])
            if bundle.get("source_id"):
                source_ids.add(bundle["source_id"])
        return sorted(source_id for source_id in source_ids
                      if isinstance(source_id, str) and source_id)

    def _authorize_metadata_sources(self, source_ids, *, require_nonempty=False):
        """Metadata-level source authorization; performs no payload scan."""
        if getattr(self.service, "profile", None) == "data_only":
            # data_only uses WFD caller/data permissions and fixed internal
            # dependencies; there are no external source permissions.
            return
        for source_id in source_ids:
            policy = self.service.allowed_sources.get(source_id, {})
            if policy.get("may_read") is not True:
                raise PermissionError("SOURCE_READ_PERMISSION_MISSING:" + source_id)
        if require_nonempty and not source_ids:
            raise PermissionError("SOURCE_READ_PERMISSION_MISSING:")

    @staticmethod
    def _declared_roles(product):
        declaration = product.get("declaration") or {}
        roles = set()
        if declaration.get("time_role"):
            roles.add(declaration["time_role"])
        fields = declaration.get("field_definitions") or []
        for field in fields:
            if isinstance(field, dict) and field.get("time_role"):
                roles.add(field["time_role"])
        if any(isinstance(field, dict) and field.get("field_code") == "session_date"
               for field in fields):
            roles.add("session_date")
        return roles

    def _validate_business_time_role(self, business_range, manifest_products):
        if business_range is None or business_range.get("role") == "declared":
            return
        requested = business_range["role"]
        available = None
        contracts = []
        for product in manifest_products.values():
            roles = self._declared_roles(product)
            available = roles if available is None else available & roles
            contracts.append({
                "contract_ref": copy.deepcopy(product.get("contract_ref")),
                "top_time_role": (product.get("declaration") or {}).get("time_role"),
                "declared_roles": sorted(roles),
            })
        if not available or requested not in available:
            raise ProductQueryError(
                "BUSINESS_TIME_ROLE_MISMATCH",
                "Requested business-time role is not declared by the fixed product contract",
                {"requested_role": requested,
                 "available_roles": sorted(available or []),
                 "contracts": contracts,
                 "rule": "caller cannot rename observation_time to another role"})

    @staticmethod
    def _contract_dependencies(product):
        read_contract = ((product.get("contracts") or {}).get("read") or {})
        return copy.deepcopy(read_contract.get("dependencies") or [])

    def _dependency_plan(self, request, manifest_products):
        selected_calendar = set()
        for product in manifest_products.values():
            try:
                rules = product_calendar.field_calendar_rules(
                    product.get("declaration") or {}, request.get("fields"))
            except ValueError:
                rules = {}
            for rule in rules.values():
                ref = rule["ref"]
                selected_calendar.add((ref["id"], ref["version"], rule["role"]))
        pending = []
        for product in manifest_products.values():
            for dependency in self._contract_dependencies(product):
                if dependency.get("role") in {"calendar_ref", "accounting_calendar_ref"}:
                    key = (dependency.get("product_id"), dependency.get("snapshot_id"),
                           dependency.get("role"))
                    if key not in selected_calendar:
                        continue
                pending.append(dependency)
        seen, plan = set(), []
        while pending:
            dependency = pending.pop(0)
            identity = (dependency.get("dataset_id"),
                        dependency.get("product_id"),
                        dependency.get("snapshot_id"))
            if identity in seen:
                continue
            seen.add(identity)
            if dependency.get("dataset_id") != request["dataset_id"]:
                raise ProductQueryError(
                    "DEPENDENCY_DATASET_UNSUPPORTED",
                    "Declared dependency dataset differs from the fixed request dataset",
                    {"dependency": copy.deepcopy(dependency)})
            if dependency.get("required") is not True:
                raise ProductQueryError(
                    "OPTIONAL_READ_DEPENDENCY_NOT_IMPLEMENTED",
                    "Optional read dependencies are not implemented",
                    {"dependency": copy.deepcopy(dependency)})
            try:
                snapshot, manifest, commit_bytes, snapshot_bytes, manifest_bytes =                     self._snapshot_metadata(dependency["snapshot_id"])
            except ProductQueryError as exc:
                raise ProductQueryError(
                    "DEPENDENCY_SNAPSHOT_UNAVAILABLE",
                    "Declared read-dependency snapshot is unavailable",
                    {"dependency": copy.deepcopy(dependency),
                     "cause": exc.as_dict()}) from exc
            entries = [entry for entry in manifest["files"]
                       if entry.get("product_id") == dependency["product_id"]]
            if not entries:
                raise ProductQueryError(
                    "DEPENDENCY_PRODUCT_UNAVAILABLE",
                    "Declared read-dependency product is absent from its fixed snapshot",
                    {"dependency": copy.deepcopy(dependency)})
            self._authorize_metadata_sources(
                self._source_ids_from_entries(entries),
                require_nonempty=False)
            files, payload_bytes, candidate_rows = [], 0, 0
            for entry in manifest["files"]:
                path = self._rooted(entry["file_relpath"])
                if not path.is_file():
                    raise ProductQueryError(
                        "MANIFEST_FILE_UNAVAILABLE",
                        "A dependency manifest file is missing",
                        {"file_relpath": entry.get("file_relpath"),
                         "snapshot_id": dependency["snapshot_id"]})
                size = path.stat().st_size
                payload_bytes += size
                candidate_rows += int(entry.get("row_count") or 0)
                files.append({
                    "file_relpath": entry.get("file_relpath"),
                    "bytes": size,
                    "row_count": int(entry.get("row_count") or 0),
                    "output_key": entry.get("output_key"),
                    "product_id": entry.get("product_id"),
                    "read_role": "dependency_snapshot_verification",
                })
            object_inventory = row_version_objects.reference_inventory(manifest)
            object_read_bytes = 2 * (object_inventory["unique_bytes"] + object_inventory["occurrence_bytes"])
            plan.append({
                "snapshot_id": dependency["snapshot_id"],
                "product_id": dependency["product_id"],
                "dataset_id": dependency["dataset_id"],
                "metadata_reads": 2,
                "commit_bytes": commit_bytes,
                "snapshot_bytes": snapshot_bytes,
                "manifest_bytes": manifest_bytes,
                "metadata_bytes": 2 * (commit_bytes + snapshot_bytes + manifest_bytes) + object_read_bytes,
                **({"row_version_object_bytes": object_read_bytes} if object_read_bytes else {}),
                "verification_payload_bytes": payload_bytes,
                "candidate_rows": candidate_rows,
                "files": files,
            })
            dependency_products = self._manifest_products(entries)
            for product in dependency_products.values():
                pending.extend(self._contract_dependencies(product))
        return plan

    # ------------------------------------------------------------------ value projection
    @staticmethod
    def _unit_envelope(product, unit_code):
        semantic = (product.get("contracts") or {}).get("semantic") or {}
        definitions = semantic.get("unit_definitions") or {}
        entry = definitions.get(unit_code) if isinstance(definitions, dict) else None
        definition = copy.deepcopy(entry.get("definition")) if isinstance(entry, dict) else None
        return {
            "unit_code": unit_code,
            "definition": definition,
            "digest": entry.get("digest") if isinstance(entry, dict) else None,
            "resolved": isinstance(entry, dict),
        }

    def _project_cell(self, row, field_code, field_definition, product):
        data_type = field_definition.get("data_type")
        unit_code = field_definition.get("unit_code")
        if not unit_code:
            return None, "FIELD_UNIT_DEFINITION_MISSING", "Declared field has no unit code"
        unit = self._unit_envelope(product, unit_code)
        if product.get("payload_kind") == "scalar_rows":
            if field_code != "value_decimal":
                return None, "FIELD_NOT_DEFINED", "Scalar product only exposes value_decimal"
            state, value = row.get("value_state"), row.get("value_decimal")
        else:
            values = row.get("values")
            if not isinstance(values, dict) or field_code not in values:
                return None, "FIELD_VALUE_MISSING", "Stored row has no requested value field"
            cell = values[field_code]
            if not isinstance(cell, dict):
                return None, "FIELD_VALUE_INVALID", "Stored value cell is not an object"
            if cell.get("data_type") != data_type:
                return None, "FIELD_TYPE_MISMATCH", "Stored data type differs from the declaration"
            state, value = cell.get("value_state"), cell.get("value")
        if state not in VALID_VALUE_STATES:
            return None, "FIELD_VALUE_STATE_INVALID", "Stored value_state is not recognized"
        if state in NULL_STATES and value is not None:
            return None, "FIELD_VALUE_STATE_MISMATCH", "Unknown/not_applicable state must carry null"
        if state in NON_NULL_STATES and value is None:
            return None, "FIELD_VALUE_MISSING", "valid_value/reported_zero must carry a value"
        if state in NON_NULL_STATES:
            if data_type in {"decimal", "integer"} and not isinstance(value, str):
                return None, "FIELD_VALUE_INVALID", \
                    "Decimal/integer values must remain canonical strings"
            if data_type == "boolean" and not isinstance(value, bool):
                return None, "FIELD_VALUE_INVALID", "Boolean value is not a boolean"
            if data_type == "text" and not isinstance(value, str):
                return None, "FIELD_VALUE_INVALID", "Text value is not a string"
        return {
            "field_code": field_code,
            "data_type": data_type,
            "value_state": state,
            "value": copy.deepcopy(value),
            "unit": unit,
        }, None, None

    # ------------------------------------------------------------------ business time
    @staticmethod
    def _time_interval(value):
        if not isinstance(value, dict):
            return None, "BUSINESS_TIME_INVALID", "Business time is not an object"
        status = value.get("status")
        if status == "unknown":
            return copy.deepcopy(value), "BUSINESS_TIME_UNKNOWN", \
                "Business time is explicitly unknown"
        if status == "not_applicable":
            return copy.deepcopy(value), "BUSINESS_TIME_NOT_APPLICABLE", \
                "Business time is not applicable"
        if status != "known":
            return None, "BUSINESS_TIME_INVALID", "Business time status is invalid"
        earliest, latest = value.get("earliest_utc"), value.get("latest_exclusive_utc")
        if not earliest or not latest:
            return None, "BUSINESS_TIME_INTERVAL_INVALID", "Known time lacks UTC endpoints"
        try:
            left, right = _utc(earliest), _utc(latest)
        except ValueError:
            return None, "BUSINESS_TIME_INTERVAL_INVALID", "Business time is not second-precision UTC"
        if right <= left:
            return None, "BUSINESS_TIME_INTERVAL_INVALID", "Business time interval is empty"
        return copy.deepcopy(value), None, None

    def _row_business_time(self, row, role, product):
        declaration = product.get("declaration") or {}
        if role == "declared":
            role = declaration.get("time_role") or "observation"
        mapping = {
            "observation": "observation_time",
            "statistical_period": "observation_time",
            "event": "event_time",
            "public": "public_time",
            "expected": "expected_time",
            "effective": "effective_period",
            "validity": "effective_period",
        }
        if role in mapping:
            key = mapping[role]
            if key not in row:
                return None, "BUSINESS_TIME_ROLE_UNAVAILABLE", \
                    "Stored row has no " + key
            return self._time_interval(row.get(key))
        if role == "session_date":
            values = row.get("values") if isinstance(row.get("values"), dict) else {}
            cell = values.get("session_date") if isinstance(values, dict) else None
            if not isinstance(cell, dict):
                return None, "BUSINESS_TIME_ROLE_UNAVAILABLE", \
                    "Stored row has no usable session_date"
            state = cell.get("value_state")
            if state in {"unknown", "not_reported", "not_collected", "out_of_coverage"}:
                return None, "BUSINESS_TIME_UNKNOWN", "session_date is explicitly unknown"
            if state in {"not_applicable", "not_yet_effective", "not_matured",
                         "insufficient_warmup", "source_conflict"}:
                return None, "BUSINESS_TIME_NOT_APPLICABLE", \
                    "session_date is not applicable"
            if state not in NON_NULL_STATES:
                return None, "BUSINESS_TIME_INVALID", "session_date value_state is invalid"
            value = cell.get("value")
            if not isinstance(value, str):
                return None, "BUSINESS_TIME_INVALID", "session_date is not a date string"
            observation = row.get("observation_time")
            timezone_name = (observation.get("source_timezone")
                             if isinstance(observation, dict) else None)
            if not isinstance(timezone_name, str) or not timezone_name:
                # Never borrow the caller's query timezone: one fixed source
                # date must not become two different UTC facts depending on
                # who is querying.
                return None, "BUSINESS_TIME_UNKNOWN", \
                    "session_date has no explicit source timezone"
            try:
                zone = ZoneInfo(timezone_name)
                start_naive = datetime.strptime(value, "%Y-%m-%d")
                end_naive = start_naive + timedelta(days=1)
                start = self._local_to_utc(start_naive, zone, value)
                end = self._local_to_utc(end_naive, zone, value)
            except ProductQueryError as exc:
                return None, exc.code, exc.message
            except (ZoneInfoNotFoundError, ValueError, TypeError):
                return None, "BUSINESS_TIME_INVALID", "session_date or its timezone is invalid"
            return {
                "status": "known",
                "precision": "day",
                "earliest_utc": _utc_text(start),
                "latest_exclusive_utc": _utc_text(end),
                "source_timezone": timezone_name,
            }, None, None
        return None, "BUSINESS_TIME_ROLE_UNAVAILABLE", "Unsupported business-time role"

    @staticmethod
    def _validity_decision(business_time, business_range):
        """Applicability semantics: validity interval must cover the query."""
        if business_time is None:
            return "unknown"
        start = _utc(business_range["start_utc"])
        end = _utc(business_range["end_utc"])
        left = _utc(business_time["earliest_utc"])
        right = _utc(business_time["latest_exclusive_utc"])
        if right <= start or left >= end:
            return "disjoint"
        if left <= start and right >= end:
            return "qualified"
        return "overlap"

    @staticmethod
    def _time_decision(business_time, business_range):
        if business_time is None:
            return "unknown"
        start = _utc(business_range["start_utc"])
        end = _utc(business_range["end_utc"])
        left = _utc(business_time["earliest_utc"])
        right = _utc(business_time["latest_exclusive_utc"])
        if right <= start or left >= end:
            return "disjoint"
        if left >= start and right <= end:
            return "contained"
        return "overlap"

    def _cursor_window(self, rows, last, page_size):
        """Rows are already sorted by _sort_key; retain only the requested slice.

        This removes a second linear suffix allocation, not the underlying
        service scan or full semantic projection. bisect_right semantics keep
        all keys equal to the last cursor excluded, as the original > filter.
        """
        left, right = 0, len(rows)
        if last is not None:
            while left < right:
                middle = (left + right) // 2
                if self._sort_key(rows[middle]) <= last:
                    left = middle + 1
                else:
                    right = middle
        return rows[left:left + page_size], len(rows) - left

    # ------------------------------------------------------------------ projection
    def _project(self, request, result, manifest_products, *, subject, fields,
                 business_range):
        service_products = {_product_key(product): product
                            for product in result.get("products", [])}
        all_products = dict(manifest_products)
        for key, product in service_products.items():
            manifest = all_products.get(key)
            if (manifest is not None
                    and (manifest.get("dataset_id") != product.get("dataset_id")
                         or canonical(manifest.get("declaration") or {})
                         != canonical(product.get("declaration") or {}))):
                raise ProductQueryError(
                    "PRODUCT_METADATA_MISMATCH",
                    "Public product declaration differs from the fixed manifest declaration",
                    {"product_id": product.get("product_id"),
                     "contract_ref": copy.deepcopy(product.get("contract_ref"))})
            all_products[key] = copy.deepcopy(product)

        diagnostics = []
        for diagnostic in result.get("diagnostics", []):
            if (subject is not None
                    and canonical(diagnostic.get("subject")) != canonical(subject)):
                continue
            copied = copy.deepcopy(diagnostic)
            copied.setdefault("diagnostic_source", "product_service_eligibility")
            diagnostics.append(copied)
        projected_rows = []
        units = {}
        # Fixed product objects are immutable within this projection only.
        # Do not reuse across snapshots/requests or merge distinct contracts.
        field_maps = {}

        for item in result.get("rows", []):
            projected = self._project_row(
                item, all_products, subject=subject, fields=fields,
                business_range=business_range, field_maps=field_maps,
                diagnostics=diagnostics, units=units)
            if projected is not None:
                projected_rows.append(projected)

        projected_rows.sort(key=self._sort_key)
        diagnostics.sort(key=lambda item: (
            str(item.get("product_id") or ""),
            str(item.get("business_key") or ""),
            str(item.get("code") or item.get("reason") or "")))
        return projected_rows, diagnostics, all_products, units

    def _project_batch_window(self, request, batches, manifest_products, *,
                              subject, fields, business_range, last=None):
        """Streaming reducer for execute's metadata-gated data-only batch path.

        Batch row projections are released after consumption. Diagnostics and
        product metadata remain full-domain; this is not constant total RAM.
        """
        import heapq
        products, units, diagnostics, source_ids = dict(manifest_products), {}, [], set()
        total = remaining = 0

        def candidates():
            nonlocal total, remaining
            for batch in batches:
                rows, notes, fixed, batch_units = self._project(
                    request, batch, products, subject=subject,
                    fields=fields, business_range=business_range)
                products.update(fixed)
                units.update(batch_units)
                diagnostics.extend(notes)
                for row in rows:
                    total += 1
                    source_ids.update((row.get("source_binding") or {}).get("source_ids", []) or [])
                    if last is None or self._sort_key(row) > last:
                        remaining += 1
                        yield row

        window = heapq.nsmallest(request["page_size"] + 1, candidates(), key=self._sort_key)
        diagnostics.sort(key=lambda item: (
            str(item.get("product_id") or ""),
            str(item.get("business_key") or ""),
            str(item.get("code") or item.get("reason") or "")))
        return {"rows": window[:request["page_size"]], "total_rows": total,
                "remaining_rows": remaining, "has_more": remaining > request["page_size"],
                "products": products, "units": units, "diagnostics": diagnostics,
                "source_ids": sorted(source_ids)}

    def _project_row(self, item, all_products, *, subject, fields,
                     business_range, field_maps, diagnostics, units):
        """One authoritative row decision; accumulators belong to one projection."""
        item_subject = item.get("subject")
        if subject is not None and canonical(item_subject) != canonical(subject):
            return None
        key = (item.get("product_id"),
               (item.get("contract_ref") or {}).get("digest", "legacy"))
        product = all_products.get(key)
        if product is None and len(all_products) == 1:
            product = next(iter(all_products.values()))
        if product is None:
            diagnostics.append(self._diagnostic(
                "PRODUCT_CONTRACT_UNAVAILABLE",
                "No fixed product contract is available for this row",
                item, decision="indeterminate"))
            return None

        role = business_range["role"] if business_range else \
            ((product.get("declaration") or {}).get("time_role") or "observation")
        business_time, time_code, time_message = self._row_business_time(
            item.get("row") or {}, role, product)
        if time_code:
            if business_range is not None:
                diagnostics.append(self._diagnostic(
                    time_code, time_message, item,
                    decision="indeterminate",
                    business_time_role=role))
                return None
            # Without a range the time is only envelope metadata; keep the
            # explicit unknown/not_applicable object instead of turning it
            # into an unqualified null or silently dropping the row.
            business_time = copy.deepcopy(business_time) if isinstance(
                business_time, dict) else None
        if business_range is not None:
            decision = self._time_decision(business_time, business_range)
            if decision == "disjoint":
                return None
            if decision != "contained":
                diagnostics.append(self._diagnostic(
                    "BUSINESS_TIME_OVERLAP_QUERY_RANGE",
                    "Business-time interval is not fully contained in the requested range",
                    item, decision="indeterminate",
                    business_time_role=role,
                    business_time=copy.deepcopy(business_time),
                    requested_range=copy.deepcopy(business_range),
                    time_decision=decision))
                return None

        product_identity = id(product)
        if product_identity not in field_maps:
            field_maps[product_identity] = _declaration_fields(product)
        field_map = field_maps[product_identity]
        missing = [field for field in fields if field not in field_map]
        if missing:
            diagnostics.append(self._diagnostic(
                "FIELD_NOT_DEFINED_IN_ROW_CONTRACT",
                "Requested field is not declared by this fixed product contract",
                item, decision="indeterminate",
                missing_fields=missing,
                contract_ref=copy.deepcopy(item.get("contract_ref"))))
            return None

        values, invalid = {}, None
        for field in fields:
            cell, code, message = self._project_cell(
                item.get("row") or {}, field, field_map[field], product)
            if code:
                invalid = (field, code, message)
                break
            values[field] = cell
            unit_code = cell["unit"]["unit_code"]
            if unit_code not in units:
                units[unit_code] = copy.deepcopy(cell["unit"])
        if invalid:
            diagnostics.append(self._diagnostic(
                invalid[1], invalid[2], item,
                decision="indeterminate", field_code=invalid[0]))
            return None

        return {
            "product_id": item.get("product_id"),
            "subject": copy.deepcopy(item_subject),
            "business_time": copy.deepcopy(business_time),
            "business_time_role": role,
            "times": {
                key: copy.deepcopy((item.get("row") or {})[key])
                for key in ("observation_time", "event_time", "public_time",
                            "expected_time", "effective_period")
                if isinstance(item.get("row"), dict) and key in item["row"]
            },
            "values": values,
            "eligibility": copy.deepcopy(item.get("eligibility")),
            "revision": copy.deepcopy(item.get("revision")),
            "revision_state": item.get("revision_state"),
            "record_ref": copy.deepcopy(item.get("record_ref")),
            "contract_ref": copy.deepcopy(item.get("contract_ref")),
            "source_binding": copy.deepcopy(item.get("source_binding")),
            "evidence_refs": copy.deepcopy(item.get("evidence_refs", [])),
        }


    @staticmethod
    def _diagnostic(code, message, item, *, decision, **extra):
        record = item.get("record_ref") or {}
        diagnostic = {
            "code": code,
            "message": message,
            "decision": decision,
            "product_id": item.get("product_id"),
            "business_key": record.get("logical_key"),
            "record_ref": copy.deepcopy(record),
            "diagnostic_source": "product_query",
        }
        diagnostic.update(extra)
        return diagnostic

    # ------------------------------------------------------------------ product envelope
    @staticmethod
    def _product_envelope(product_id, manifest_products, selected_fields):
        contracts = []
        contract_refs, definition_refs = [], []
        available_fields = {}
        for product in manifest_products.values():
            contract_refs.append(product.get("contract_ref"))
            definition_refs.append(product.get("definition_ref"))
            field_map = _declaration_fields(product)
            for code in field_map:
                available_fields.setdefault(code, []).append(product.get("contract_ref"))
            declaration = product.get("declaration") or {}
            contracts.append({
                "contract_ref": copy.deepcopy(product.get("contract_ref")),
                "contract_role_refs": copy.deepcopy(product.get("contract_refs")),
                "contract_bundle_ref": copy.deepcopy(product.get("contract_bundle_ref")),
                "definition_ref": copy.deepcopy(product.get("definition_ref")),
                "payload_kind": product.get("payload_kind"),
                "unit_code": declaration.get("unit_code"),
                "time_role": declaration.get("time_role"),
                "measurement_nature": declaration.get("measurement_nature"),
                "semantic_context": copy.deepcopy(declaration.get("semantic_context")),
                "semantic_context_version": (declaration.get("semantic_context") or {}).get("version"),
                "fields": [
                    copy.deepcopy(field_map[code])
                    for code in sorted(field_map)
                ],
            })
        contracts.sort(key=lambda item: canonical(item.get("contract_ref") or {}))
        first = next(iter(manifest_products.values())) if manifest_products else {}
        return {
            "product_id": product_id,
            "dataset_id": first.get("dataset_id"),
            "subject": copy.deepcopy(first.get("subject")),
            "payload_kind": first.get("payload_kind"),
            "contract_refs": _unique_dicts(contract_refs),
            "contract_role_refs": copy.deepcopy(first.get("contract_refs")),
            "contract_bundle_ref": copy.deepcopy(first.get("contract_bundle_ref")),
            "semantic_context": copy.deepcopy((first.get("declaration") or {}).get("semantic_context")),
            "semantic_context_version": ((first.get("declaration") or {}).get("semantic_context") or {}).get("version"),
            "definition_refs": _unique_dicts(definition_refs),
            "contract_versions": contracts,
            "contract_history": {
                "multiple_contract_versions": len(contracts) > 1,
                "technical_metadata_only": True,
                "business_public_time": None,
                "note": "Contract/definition versions are fixed-snapshot technical "
                        "bindings. Their registration/availability is not a market "
                        "public time and does not establish business historical eligibility.",
            },
            "selected_fields": {
                code: _unique_dicts(available_fields.get(code, []))
                for code in selected_fields
            },
        }

    # ------------------------------------------------------------------ budget
    def _stat_manifest_files(self, entries, *, snapshot_id, read_role, product_paths=None):
        files = []
        total_bytes = 0
        total_rows = 0
        for entry in entries:
            path = self._rooted(entry["file_relpath"])
            if not path.is_file():
                raise ProductQueryError(
                    "MANIFEST_FILE_UNAVAILABLE",
                    "A fixed manifest file is missing; the read is not a business empty set",
                    {"file_relpath": entry.get("file_relpath"),
                     "snapshot_id": snapshot_id})
            size = path.stat().st_size
            total_bytes += size
            total_rows += int(entry.get("row_count") or 0)
            roles = [read_role]
            if product_paths is not None and entry["file_relpath"] in product_paths:
                roles.append("product_read")
            files.append({
                "file_relpath": entry.get("file_relpath"),
                "bytes": size,
                "row_count": int(entry.get("row_count") or 0),
                "output_key": entry.get("output_key"),
                "product_id": entry.get("product_id"),
                "read_roles": roles,
            })
        return files, total_bytes, total_rows

    def _budget_preflight(self, request, entries, manifest, commit_bytes,
                          snapshot_bytes, manifest_bytes, dependency_plan,
                          *, bounded_product_pages=False):
        max_scan_bytes = request["max_scan_bytes"]
        max_nodes = request["max_nodes"]
        if max_scan_bytes > MAX_SCAN_BYTES:
            raise ProductQueryError("SCAN_BUDGET_INVALID",
                                    "max_scan_bytes exceeds the P4a1 ceiling",
                                    {"max_scan_bytes": max_scan_bytes,
                                     "ceiling": MAX_SCAN_BYTES})
        if max_nodes > MAX_SCAN_ROWS:
            raise ProductQueryError("SCAN_BUDGET_INVALID",
                                    "max_nodes exceeds the P4a1 row ceiling",
                                    {"max_nodes": max_nodes, "ceiling": MAX_SCAN_ROWS})
        if request["page_size"] > MAX_PAGE_SIZE:
            raise ProductQueryError("SCAN_BUDGET_INVALID",
                                    "page_size exceeds the P4a1 ceiling",
                                    {"page_size": request["page_size"],
                                     "ceiling": MAX_PAGE_SIZE})

        product_paths = {entry["file_relpath"] for entry in entries}
        verification_entries = entries if bounded_product_pages else manifest["files"]
        selected_files, selected_verify_bytes, _ = self._stat_manifest_files(
            verification_entries, snapshot_id=request["snapshot_id"],
            read_role="fixed_product_page_verification" if bounded_product_pages else "selected_snapshot_verification",
            product_paths=product_paths)
        _, selected_product_bytes, candidate_rows = self._stat_manifest_files(
            entries, snapshot_id=request["snapshot_id"],
            read_role="selected_product_read")
        metadata_reads = 2 if bounded_product_pages else 3
        selected_metadata_bytes = metadata_reads * (commit_bytes + snapshot_bytes + manifest_bytes)
        object_validation_bytes = metadata_reads * row_version_objects.reference_inventory(manifest)["unique_bytes"]
        # Applicability reads each selected version map once; the bounded page
        # reads it once again. The generic product read additionally computes
        # its content digest and resolves revisions. Count every such object
        # read instead of treating an on-disk getter as an in-memory lookup.
        object_get_bytes = (2 if bounded_product_pages else 3) * row_version_objects.reference_inventory({"files": entries})["occurrence_bytes"]
        selected_metadata_bytes += object_validation_bytes + object_get_bytes
        contract_metadata_bytes = 0
        if bounded_product_pages:
            for entry in entries:
                product = entry["source_bundle"]["_wfd_product_bindings"][entry["output_key"]]["product"]
                for role, ref in (product.get("contract_refs") or {}).items():
                    digest = ref["digest"].removeprefix("sha256:")
                    contract_metadata_bytes += self._rooted(
                        f"catalog/product_service/contracts/{role}/{digest}.json").stat().st_size
                bundle = product.get("contract_bundle_ref")
                if bundle:
                    digest = bundle["digest"].removeprefix("sha256:")
                    contract_metadata_bytes += 2 * self._rooted(
                        f"catalog/product_service/contract_bundles/{digest}.json").stat().st_size
        dependency_payload_bytes = sum(
            item["verification_payload_bytes"] for item in dependency_plan)
        dependency_metadata_bytes = sum(item["metadata_bytes"] for item in dependency_plan)
        # A fixed product page verifies target files, then SQL scans its
        # selected-identity metadata and bounded row JSON. No unrelated
        # product payload is read by this explicitly admitted path.
        product_read_bytes = selected_product_bytes * (2 if bounded_product_pages else 1)
        payload_bytes = (selected_verify_bytes + product_read_bytes
                         + dependency_payload_bytes)
        metadata_bytes = selected_metadata_bytes + dependency_metadata_bytes + contract_metadata_bytes
        required_scan_bytes = payload_bytes + metadata_bytes
        read_plan = {
            "selected_snapshot": {
                "snapshot_id": request["snapshot_id"],
                "metadata_reads": metadata_reads,
                "commit_bytes": commit_bytes,
                "snapshot_bytes": snapshot_bytes,
                "manifest_bytes": manifest_bytes,
                "metadata_bytes": selected_metadata_bytes,
                **({"row_version_object_validation_bytes": object_validation_bytes,
                    "row_version_object_get_bytes": object_get_bytes}
                   if object_validation_bytes or object_get_bytes else {}),
                **({"contract_metadata_bytes": contract_metadata_bytes} if bounded_product_pages else {}),
                "verification_payload_bytes": selected_verify_bytes,
                "product_read_payload_bytes": product_read_bytes,
                "candidate_rows": candidate_rows,
            },
            "dependencies": dependency_plan,
            "payload_bytes": payload_bytes,
            "metadata_bytes": metadata_bytes,
            "required_scan_bytes": required_scan_bytes,
            "max_scan_bytes": max_scan_bytes,
            "max_nodes": max_nodes,
        }
        all_files = selected_files + [
            file for dependency in dependency_plan for file in dependency["files"]]
        evidence = {
            "preflight": "before_payload_read",
            "within_budget": True,
            "scope": "fixed_product_pages_with_snapshot_metadata" if bounded_product_pages else "selected_snapshot_all_files_plus_product_read_plus_declared_dependencies",
            "conservative": False,
            "file_range_pushdown": False,
            "row_range_pushdown": False,
            "verification_scope": "fixed_snapshot_metadata_and_target_product_files" if bounded_product_pages else "selected_snapshot_and_declared_read_dependencies_only",
            "unrelated_snapshots_scanned": False,
            "candidate_file_count": len(entries),
            "verification_file_count": len(verification_entries),
            "candidate_rows": candidate_rows,
            "payload_bytes": payload_bytes,
            "metadata_bytes": metadata_bytes,
            "fixed_snapshot_metadata_bytes": selected_metadata_bytes,
            "dependency_metadata_bytes": dependency_metadata_bytes,
            "required_scan_bytes": required_scan_bytes,
            "max_scan_bytes": max_scan_bytes,
            "max_nodes": max_nodes,
            "files": all_files,
            "read_plan": read_plan,
            "hard_execution_time_ms": False,
            "note": ("Each bounded tabular batch reserves snapshot metadata twice (query preflight and fixed product page), "
                    "and target payload bytes three times (streamed SHA plus two SQL scans). "
                    "Contract files (including both bundle reads) are counted per binding. "
                    "No unrelated product payload is read; catalog metadata remains fully verified and counted."
                    if bounded_product_pages else "The selected snapshot's files are verified once by read_snapshot; "
                    "the selected product payload is read and verified once by read_product; "
                    "declared read-dependency snapshots are dereferenced and verified once. "
                    "Commit/snapshot/manifest metadata repeat reads are counted (selected 3x, "
                    "each dependency 2x). No unrelated newer snapshot is scanned."),
        }
        if required_scan_bytes > max_scan_bytes:
            raise ProductQueryError(
                "SCAN_BUDGET_EXCEEDED",
                "Preflight scan budget is smaller than the required fixed-snapshot bytes",
                {"required_scan_bytes": required_scan_bytes,
                 "max_scan_bytes": max_scan_bytes,
                 "payload_bytes": payload_bytes,
                 "metadata_bytes": metadata_bytes,
                 "candidate_rows": candidate_rows,
                 "scope": evidence["scope"],
                 "file_range_pushdown": False,
                 "read_plan": read_plan,
                 "files": all_files})
        if candidate_rows > max_nodes:
            raise ProductQueryError(
                "ROW_BUDGET_EXCEEDED",
                "Preflight row budget is smaller than the product's physical candidate rows",
                {"candidate_rows": candidate_rows,
                 "max_nodes": max_nodes,
                 "scope": evidence["scope"],
                 "read_plan": read_plan})
        return evidence

    # ------------------------------------------------------------------ P4b context
    @staticmethod
    def _product_kind(products):
        first = next(iter(products.values()))
        declaration = first.get("declaration") or {}
        kind = first.get("payload_kind")
        semantic_context = declaration.get("semantic_context") or {}
        content_nature = semantic_context.get("content_nature")
        fields = declaration.get("field_definitions") or []
        rule_fields = {field.get("field_code") for field in fields
                       if isinstance(field, dict)}
        declared_rule = bool(rule_fields & {"rule_code", "rule_id"})
        # Rule identity is a business declaration first: data-only products
        # declare definition_rule.  The rule_code/rule_id fallback is kept for
        # legacy products that predate semantic_context; a semantic_code
        # substring such as "rule" is not evidence of a rule product.
        if content_nature == "definition_rule":
            return "rule"
        if declared_rule and content_nature is None:
            # Legacy products predate semantic_context; the declared rule
            # field is a business declaration, not a semantic-code substring.
            return "rule"
        if kind == "relation_edges" or declaration.get("measurement_nature") == "relation":
            return "relation"
        if kind == "event_records":
            return "event"
        return "value"

    @staticmethod
    def _first_meta(products):
        return next(iter(products.values()))

    def _current_business_policy(self, request, products):
        if not self._data_only_projection() or not any(
                current_only_business(product.get("declaration")) for product in products.values()):
            return
        if (request["history_mode"] != "snapshot_contents"
                or request.get("knowledge_cutoff") is not None or request.get("include_history")):
            raise ProductQueryError("CURRENT_ONLY_BUSINESS_HISTORY_UNSUPPORTED",
                                    "This basic-market product exposes only current business values")
        head = self.service.engine.head()
        if head is None or request["snapshot_id"] != head["snapshot_id"]:
            raise ProductQueryError("CURRENT_ONLY_BUSINESS_HEAD_REQUIRED",
                                    "Current business queries must select the active HEAD; pinned old snapshots are technical reads")

    def _p4b_session(self, request):
        if (request["history_mode"] == "system_held_at"
                and getattr(self.service, "profile", None) != "data_only"):
            raise ProductQueryError(
                "INSTANCE_HOLDING_SCOPE_NOT_IMPLEMENTED",
                "The legacy product service has no target-instance holding ledger",
                {"profile": getattr(self.service, "profile", None)})
        cutoff_at, cutoff_info = self._knowledge_cutoff(request)
        business_range = self._business_time_range(request)
        snapshot, manifest, commit_bytes, snapshot_bytes, manifest_bytes = \
            self._preflight_snapshot(request["snapshot_id"])
        groups, metas = {}, {}
        for entry in manifest["files"]:
            groups.setdefault(entry["product_id"], []).append(entry)
        gaps = []
        for product_id, entries in list(groups.items()):
            try:
                products = self._manifest_products(entries)
            except ProductQueryError as exc:
                gaps.append({"code": exc.code, "product_id": product_id})
                groups.pop(product_id, None)
                continue
            datasets = {product.get("dataset_id") for product in products.values()}
            if len(datasets) != 1 or request["dataset_id"] not in datasets:
                gaps.append({"code": "DATASET_MISMATCH", "product_id": product_id})
                groups.pop(product_id, None)
                continue
            metas[product_id] = products
        if not groups:
            raise ProductQueryError(
                "P4B_NO_ELIGIBLE_PRODUCTS",
                "No product in the fixed snapshot matches the requested dataset",
                {"dataset_id": request["dataset_id"], "gaps": gaps})
        session = {
            "request": request, "snapshot": snapshot, "manifest": manifest,
            "commit_bytes": commit_bytes, "snapshot_bytes": snapshot_bytes,
            "manifest_bytes": manifest_bytes, "groups": groups, "metas": metas,
            "cutoff_at": cutoff_at, "cutoff_info": cutoff_info,
            "business_range": business_range, "cache": {},
            "gaps": gaps, "permission_denied": [],
            "budget": {"payload_bytes": 0, "metadata_bytes": 0,
                       "required_scan_bytes": 0, "candidate_rows": 0, "reads": []},
        }
        # Bind the cursor before any product payload read.  This makes a
        # changed instance/stage/cutoff/field/range fail deterministically even
        # when the changed qualification would not hold any rows.
        session["query_hash"] = self._p4b_query_hash(request, session)
        if request.get("cursor") is not None:
            self._decode_offset_cursor(request["cursor"], session["query_hash"])
        return session

    def _read_context_product(self, session, product_id):
        cache = session["cache"]
        if product_id in cache:
            return cache[product_id]
        entries = session["groups"][product_id]
        request = session["request"]
        try:
            self._authorize_metadata_sources(
                self._source_ids_from_entries(entries), require_nonempty=True)
        except PermissionError:
            session["permission_denied"].append(product_id)
            session["gaps"].append({
                "code": "SOURCE_READ_PERMISSION_MISSING",
                "product_id": product_id,
                "scope": "product",
                "detail": "product details are not exposed",
            })
            cache[product_id] = {"status": "permission_denied"}
            return cache[product_id]
        try:
            self._current_business_policy(request, session["metas"][product_id])
        except ProductQueryError as exc:
            session["gaps"].append({"code": exc.code, "product_id": product_id, "scope": "product"})
            cache[product_id] = {"status": "failed"}
            return cache[product_id]
        remaining_bytes = request["max_scan_bytes"] - session["budget"]["required_scan_bytes"]
        remaining_rows = request["max_nodes"] - session["budget"]["candidate_rows"]
        if remaining_bytes <= 0 or remaining_rows <= 0:
            session["gaps"].append({
                "code": "SCAN_BUDGET_EXCEEDED" if remaining_bytes <= 0 else "ROW_BUDGET_EXCEEDED",
                "product_id": product_id, "scope": "cumulative_budget"})
            cache[product_id] = {"status": "budget_exhausted"}
            return cache[product_id]
        local_request = dict(request, product_id=product_id,
                             max_scan_bytes=remaining_bytes,
                             max_nodes=max(1, remaining_rows))
        dependencies = self._dependency_plan(local_request, session["metas"][product_id])
        try:
            budget = self._budget_preflight(
                local_request, entries, session["manifest"], session["commit_bytes"],
                session["snapshot_bytes"], session["manifest_bytes"], dependencies)
        except ProductQueryError as exc:
            if exc.code in {"SCAN_BUDGET_EXCEEDED", "ROW_BUDGET_EXCEEDED"}:
                if not session["cache"]:
                    raise
                session["gaps"].append({
                    "code": exc.code, "product_id": product_id,
                    "scope": "cumulative_budget",
                    "required_scan_bytes": exc.details.get("required_scan_bytes"),
                    "candidate_rows": exc.details.get("candidate_rows")})
                cache[product_id] = {"status": "budget_exhausted"}
                return cache[product_id]
            raise
        session["budget"]["payload_bytes"] += budget["payload_bytes"]
        session["budget"]["metadata_bytes"] += budget["metadata_bytes"]
        session["budget"]["required_scan_bytes"] += budget["required_scan_bytes"]
        session["budget"]["candidate_rows"] += budget["candidate_rows"]
        session["budget"]["reads"].append({
            "product_id": product_id,
            "required_scan_bytes": budget["required_scan_bytes"],
            "candidate_rows": budget["candidate_rows"],
            "scope": budget["scope"],
        })
        try:
            read_kwargs = {"product_id": product_id, "snapshot_id": request["snapshot_id"],
                           "perspective": request["history_mode"],
                           "at": session["cutoff_at"], "verify_contract_files": False}
            if self._data_only_projection():
                # Calendar/instance qualification is a data_only service contract.
                # Legacy projection and time filtering remain bounded in this query layer.
                read_kwargs["fields"] = request.get("fields") or None
                read_kwargs["business_time_range"] = session["business_range"]
                if request["history_mode"] == "system_held_at":
                    read_kwargs["held_scope"] = request.get("held_scope")
                    read_kwargs["usable_stage"] = request.get("usable_stage")
            result = self.service.read(**read_kwargs)
        except PermissionError:
            session["permission_denied"].append(product_id)
            session["gaps"].append({
                "code": "SOURCE_READ_PERMISSION_MISSING",
                "product_id": product_id, "scope": "product",
                "detail": "product details are not exposed"})
            cache[product_id] = {"status": "permission_denied"}
            return cache[product_id]
        except ValueError as exc:
            session["gaps"].append({
                "code": str(exc).split(":", 1)[0] or "READ_FAILED",
                "product_id": product_id, "scope": "product"})
            cache[product_id] = {"status": "failed"}
            return cache[product_id]
        cache[product_id] = {
            "status": "ok", "result": result,
            "product": self._first_meta(session["metas"][product_id]),
            "products": session["metas"][product_id],
            "kind": self._product_kind(session["metas"][product_id]),
            "budget": budget,
        }
        return cache[product_id]

    def _p4b_query_hash(self, request, session):
        cutoff = request.get("knowledge_cutoff")
        cutoff_for_hash = None
        if isinstance(cutoff, dict):
            cutoff_for_hash = {
                "status": cutoff.get("status"),
                "precision": cutoff.get("precision"),
                "earliest_utc": cutoff.get("earliest_utc"),
                "latest_exclusive_utc": cutoff.get("latest_exclusive_utc"),
                "source_timezone": cutoff.get("source_timezone"),
                "effective_utc": (session["cutoff_info"] or {}).get("effective_utc"),
                "rule": (session["cutoff_info"] or {}).get("rule"),
            }
        body = {
            "protocol_version": request.get("protocol_version"),
            "operation": request["operation"],
            "dataset_id": request["dataset_id"],
            "snapshot_id": request["snapshot_id"],
            "history_mode": request["history_mode"],
            "held_scope": request.get("held_scope"),
            "usable_stage": request.get("usable_stage"),
            "knowledge_cutoff": cutoff_for_hash,
            "subject": copy.deepcopy(request.get("subject")),
            "fields": sorted(request.get("fields") or []),
            "business_time_range": copy.deepcopy(session["business_range"]),
            "event_types": sorted(request.get("event_types") or []),
            "relation_types": sorted(request.get("relation_types") or []),
            "rule_codes": sorted(request.get("rule_codes") or []),
            "record_ref": copy.deepcopy(request.get("record_ref")),
            "trace_fields": sorted(request.get("trace_fields") or []),
            "max_depth": request.get("max_depth"),
            "max_edges": request.get("max_edges"),
            "include_history": bool(request.get("include_history")),
        }
        return "sha256:" + sha(canonical(body))

    @staticmethod
    def _decode_offset_cursor(token, query_hash):
        try:
            padding = "=" * ((4 - len(token) % 4) % 4)
            data = json.loads(base64.urlsafe_b64decode((token + padding).encode("ascii")).decode("utf-8"))
        except (ValueError, UnicodeError, binascii.Error, json.JSONDecodeError) as exc:
            raise ProductQueryError("CURSOR_INVALID", "Cursor is invalid", {"reason": str(exc)}) from exc
        if (not isinstance(data, dict) or set(data) != {"v", "q", "off"}
                or data.get("v") != "wfd.cursor/1b"
                or data.get("q") != query_hash
                or type(data.get("off")) is not int or data["off"] < 0):
            raise ProductQueryError("CURSOR_QUERY_MISMATCH",
                                    "Cursor is bound to a different request or is invalid")
        return data["off"]

    @staticmethod
    def _encode_offset_cursor(query_hash, offset):
        raw = base64.urlsafe_b64encode(canonical({
            "v": "wfd.cursor/1b", "q": query_hash, "off": int(offset)}))
        return raw.rstrip(b"=").decode("ascii")

    def _page_p4b(self, request, query_hash, rows):
        offset = 0
        if request.get("cursor") is not None:
            offset = self._decode_offset_cursor(request["cursor"], query_hash)
        page_rows = rows[offset:offset + request["page_size"]]
        next_offset = offset + len(page_rows)
        has_more = next_offset < len(rows)
        return {
            "rows": page_rows,
            "page": {
                "page_size": request["page_size"],
                "returned_rows": len(page_rows),
                "total_rows": len(rows),
                "offset": offset,
                "has_more": has_more,
                "next_cursor": (self._encode_offset_cursor(query_hash, next_offset)
                                if has_more else None),
                "cursor_applied": bool(request.get("cursor")),
            },
        }

    def _data_only_projection(self):
        return getattr(self.service, "profile", None) == "data_only"

    @staticmethod
    def _business_definition(product):
        declaration = product.get("declaration") or {}
        context = declaration.get("semantic_context") or {}
        publisher = (context.get("source") or {}).get("publisher_ref")
        return {
            "definition_authority": declaration.get("definition_authority"),
            "publisher": copy.deepcopy(publisher),
            "content_nature": context.get("content_nature"),
        }

    def _context_item(self, item, product, projected_values, row_type):
        row = item.get("row") or {}
        values = row.get("values") if isinstance(row.get("values"), dict) else {}
        record = item.get("record_ref") or {}
        business = self._business_definition(product)
        result = {
            "row_type": row_type,
            "product_id": item.get("product_id"),
            "subject": copy.deepcopy(item.get("subject")),
            "definition_ref": copy.deepcopy(item.get("definition_ref")),
            "contract_ref": copy.deepcopy(item.get("contract_ref")),
            "eligibility": copy.deepcopy(item.get("eligibility")),
            "revision": copy.deepcopy(item.get("revision")),
            "revision_state": item.get("revision_state"),
            "record_ref": copy.deepcopy(record),
            "times": {
                key: copy.deepcopy(row[key])
                for key in ("observation_time", "event_time", "public_time",
                            "expected_time", "effective_period")
                if key in row
            },
            "values": copy.deepcopy(values) if projected_values is None else projected_values,
        }
        if self._data_only_projection():
            # Pure WFD data projection: no source/evidence/processing locators.
            # Stable record identity, business definition and the four fixed
            # contract refs + bundle remain so BD can correlate by identity.
            result.update({
                "record_id": record.get("logical_key"),
                "record_version": record.get("revision_id"),
                "contract_refs": copy.deepcopy(product.get("contract_refs")),
                "contract_bundle_ref": copy.deepcopy(product.get("contract_bundle_ref")),
                "definition_authority": business["definition_authority"],
                "publisher": copy.deepcopy(business["publisher"]),
                "content_nature": row.get("content_nature") or business["content_nature"],
                "identity_kind": (item.get("subject") or {}).get("kind"),
            })
        else:
            result["source_binding"] = copy.deepcopy(item.get("source_binding"))
            result["evidence_refs"] = copy.deepcopy(item.get("evidence_refs", []))
        if "relation_type" in row:
            result["relation"] = {
                "subject": copy.deepcopy(row.get("subject")),
                "object": copy.deepcopy(row.get("object")),
                "relation_type": row.get("relation_type"),
                "effective_period": copy.deepcopy(row.get("effective_period")),
                "public_time": copy.deepcopy(row.get("public_time")),
                "definer": (values.get("definition_authority") or {}).get("value")
                           if isinstance(values.get("definition_authority"), dict)
                           else (product.get("declaration") or {}).get("definition_authority"),
            }
        if "event_id" in row or product.get("payload_kind") == "event_records":
            result["event"] = {
                "event_id": row.get("event_id"),
                "event_type": row.get("event_type"),
                "content_nature": row.get("content_nature"),
                "status": row.get("status"),
                "event_time": copy.deepcopy(row.get("event_time")),
                "public_time": copy.deepcopy(row.get("public_time")),
                "expected_time": copy.deepcopy(row.get("expected_time")),
            }
        return result

    def _context_time_ok(self, session, item, product, product_id,
                         semantics="observation"):
        if session["business_range"] is None:
            return True
        role = session["business_range"]["role"]
        row = item.get("row") or {}
        business_time, code, message = self._row_business_time(row, role, product)
        if code:
            session["gaps"].append({
                "code": code, "product_id": product_id,
                "business_key": (item.get("record_ref") or {}).get("logical_key"),
                "message": message, "business_time_role": role})
            return False
        if semantics == "validity":
            decision = self._validity_decision(business_time, session["business_range"])
            if decision == "disjoint":
                return False
            if decision != "qualified":
                session["gaps"].append({
                    "code": "BUSINESS_TIME_OVERLAP_QUERY_RANGE",
                    "product_id": product_id,
                    "business_key": (item.get("record_ref") or {}).get("logical_key"),
                    "decision": "indeterminate", "business_time_role": role,
                    "semantics": "validity"})
                return False
            return True
        decision = self._time_decision(business_time, session["business_range"])
        if decision == "disjoint":
            return False
        if decision != "contained":
            session["gaps"].append({
                "code": "BUSINESS_TIME_OVERLAP_QUERY_RANGE",
                "product_id": product_id,
                "business_key": (item.get("record_ref") or {}).get("logical_key"),
                "decision": "indeterminate", "business_time_role": role})
            return False
        return True

    def _context_values(self, item, product, fields, *, session, product_id):
        field_map = _declaration_fields(product)
        if not field_map:
            return None
        selected = list(fields) if fields else sorted(field_map)
        missing = [field for field in selected if field not in field_map]
        if missing:
            session["gaps"].append({
                "code": "FIELD_NOT_DEFINED_FOR_PRODUCT",
                "product_id": product_id, "missing_fields": missing})
        selected = [field for field in selected if field in field_map]
        values, units = {}, {}
        for field in selected:
            cell, code, message = self._project_cell(
                item.get("row") or {}, field, field_map[field], product)
            if code:
                session["gaps"].append({
                    "code": code, "product_id": product_id,
                    "business_key": (item.get("record_ref") or {}).get("logical_key"),
                    "field_code": field, "message": message})
                continue
            values[field] = cell
            units[cell["unit"]["unit_code"]] = cell["unit"]
        return {"values": values, "units": units}

    def _graph_edges(self, session, product_id):
        entry = session["cache"].get(product_id)
        if not entry or entry.get("status") != "ok":
            return []
        product = entry["product"]
        business = self._business_definition(product)
        data_only = self._data_only_projection()
        edges = []
        for item in entry["result"].get("rows", []):
            row = item.get("row") or {}
            if "relation_type" not in row:
                continue
            effective_period = row.get("effective_period")
            effective_time, code, message = self._time_interval(effective_period)
            connectivity, reason = "confirmed", None
            if code:
                connectivity, reason = "indeterminate", code
            elif session["business_range"] is not None:
                decision = self._validity_decision(effective_time, session["business_range"])
                if decision == "disjoint":
                    continue
                if decision != "qualified":
                    connectivity, reason = "indeterminate", "BUSINESS_TIME_OVERLAP_QUERY_RANGE"
            values = row.get("values") if isinstance(row.get("values"), dict) else {}
            definer = (values.get("definition_authority") or {}).get("value") \
                if isinstance(values.get("definition_authority"), dict) else None
            record = item.get("record_ref") or {}
            edge_id = "edge:" + sha(canonical([
                record.get("product_id"), record.get("logical_key"),
                record.get("revision_id")]))
            edge = {
                "edge_id": edge_id,
                "product_id": item.get("product_id"),
                "subject": copy.deepcopy(row.get("subject")),
                "object": copy.deepcopy(row.get("object")),
                "relation_type": row.get("relation_type"),
                "effective_period": copy.deepcopy(effective_period),
                "public_time": copy.deepcopy(row.get("public_time")),
                "definer": definer or (product.get("declaration") or {}).get("definition_authority"),
                "connectivity": connectivity,
                "connectivity_reason": reason,
                "definition_ref": copy.deepcopy(item.get("definition_ref")),
                "contract_ref": copy.deepcopy(item.get("contract_ref")),
                "record_ref": copy.deepcopy(record),
            }
            if data_only:
                edge.update({
                    "record_id": record.get("logical_key"),
                    "record_version": record.get("revision_id"),
                    "contract_refs": copy.deepcopy(product.get("contract_refs")),
                    "contract_bundle_ref": copy.deepcopy(product.get("contract_bundle_ref")),
                    "definition_authority": business["definition_authority"],
                    "publisher": copy.deepcopy(business["publisher"]),
                    "content_nature": business["content_nature"],
                    "identity_kind": (row.get("subject") or {}).get("kind"),
                })
            else:
                edge["source_binding"] = copy.deepcopy(item.get("source_binding"))
                edge["evidence_refs"] = copy.deepcopy(item.get("evidence_refs", []))
            edges.append(edge)
        return edges

    @staticmethod
    def _edge_semantic_key(edge):
        return canonical([edge.get("subject"), edge.get("object"),
                          edge.get("relation_type"), edge.get("effective_period"),
                          edge.get("public_time")])

    @staticmethod
    def _edge_basis_key(edge):
        if "source_binding" not in edge and "evidence_refs" not in edge:
            # data_only: no source/evidence basis exists.  Dedupe on the fixed
            # business identity/version plus definitions/contracts so removing
            # the source fields cannot collapse two distinct business records.
            contract_refs = edge.get("contract_refs") or {}
            return canonical([
                edge.get("subject"), edge.get("object"), edge.get("relation_type"),
                edge.get("effective_period"), edge.get("public_time"),
                edge.get("definer"), edge.get("record_ref"),
                (edge.get("definition_ref") or {}).get("digest"),
                (edge.get("contract_ref") or {}).get("digest"),
                {role: (ref or {}).get("digest")
                 for role, ref in sorted(contract_refs.items())},
                (edge.get("contract_bundle_ref") or {}).get("digest"),
            ])
        refs = sorted((ref.get("content_sha256") or "")
                      for ref in edge.get("evidence_refs", []) if isinstance(ref, dict))
        return canonical([
            edge.get("subject"), edge.get("object"), edge.get("relation_type"),
            edge.get("effective_period"), edge.get("public_time"),
            edge.get("definer"),
            (edge.get("definition_ref") or {}).get("digest"),
            (edge.get("contract_ref") or {}).get("digest"),
            sorted((edge.get("source_binding") or {}).get("source_ids") or []),
            refs,
        ])

    def _graph_walk(self, start, edges, max_depth, max_edges, max_nodes):
        # Dedupe only the exact same semantic basis.  Different definers,
        # definitions, contracts or source/evidence bases remain visible.
        deduped = {}
        for edge in edges:
            deduped.setdefault(self._edge_basis_key(edge), edge)
        groups = {}
        for edge in deduped.values():
            groups.setdefault(self._edge_semantic_key(edge), []).append(edge)
        started = canonical(start)
        visited = {started: {"identity": copy.deepcopy(start), "depth": 0}}
        frontier = [start]
        out, traversed, cycles = [], set(), []
        truncated = False
        for depth in range(1, max_depth + 1):
            frontier_keys = {canonical(identity) for identity in frontier}
            next_frontier = []
            for semantic_key, group in groups.items():
                if semantic_key in traversed:
                    continue
                edge0 = group[0]
                subject, obj = edge0["subject"], edge0["object"]
                skey, okey = canonical(subject), canonical(obj)
                if skey not in frontier_keys and okey not in frontier_keys:
                    continue
                traversed.add(semantic_key)
                confirmed = any(edge["connectivity"] == "confirmed" for edge in group)
                if not confirmed:
                    direction = "forward" if skey in frontier_keys else "reverse"
                    if len(out) + len(group) > max_edges:
                        truncated = True
                        break
                    for edge in group:
                        out.append({**copy.deepcopy(edge), "depth": depth,
                                    "direction": direction, "traversed": False,
                                    "basis_count": len(group),
                                    "multi_basis": len(group) > 1})
                    continue
                if skey in frontier_keys and okey not in visited:
                    direction, identity, key = "forward", obj, okey
                elif okey in frontier_keys and skey not in visited:
                    direction, identity, key = "reverse", subject, skey
                else:
                    direction, identity, key = "cycle", None, None
                if direction == "cycle":
                    if len(out) + len(group) > max_edges:
                        truncated = True
                        break
                    for edge in group:
                        item = {**copy.deepcopy(edge), "depth": depth,
                                "direction": "cycle", "traversed": True,
                                "cycle": True, "basis_count": len(group),
                                "multi_basis": len(group) > 1}
                        out.append(item)
                        cycles.append(copy.deepcopy(item))
                else:
                    if len(visited) >= max_nodes:
                        truncated = True
                        break
                    if len(out) + len(group) > max_edges:
                        truncated = True
                        break
                    visited[key] = {"identity": copy.deepcopy(identity), "depth": depth}
                    next_frontier.append(identity)
                    for edge in group:
                        out.append({**copy.deepcopy(edge), "depth": depth,
                                    "direction": direction, "traversed": True,
                                    "basis_count": len(group),
                                    "multi_basis": len(group) > 1})
            frontier = next_frontier
            if truncated or not frontier:
                break
        return list(visited.values()), out, cycles, truncated

    def _context_focus(self, request):
        focus = request.get("subject")
        if not isinstance(focus, dict):
            raise ProductQueryError("P4B_SUBJECT_REQUIRED",
                                    "A non-null IdentityRef subject is required",
                                    {"operation": request["operation"]})
        return focus

    def _execute_p4b(self, request):
        operation = request["operation"]
        if operation == "read_company_context":
            return self._read_company_context(request)
        if operation == "read_event_timeline":
            return self._read_event_timeline(request)
        if operation == "read_applicable_rules":
            return self._read_applicable_rules(request)
        if operation == "read_relation_graph":
            return self._read_relation_graph(request)
        if operation == "trace_evidence":
            return self._read_trace_evidence(request)
        raise ProductQueryError("OPERATION_NOT_IMPLEMENTED_P4B",
                                "Unsupported P4b operation", {"operation": operation})

    def _read_company_context(self, request):
        session = self._p4b_session(request)
        focus = self._context_focus(request)
        max_depth = int(request.get("max_depth", 1))
        max_edges = int(request.get("max_edges") or 1000)
        relation_edges, diagnostics = [], []
        for product_id, products in session["metas"].items():
            if self._product_kind(products) != "relation":
                continue
            relation_read = self._read_context_product(session, product_id)
            if relation_read.get("status") != "ok":
                continue
            relation_edges.extend(self._graph_edges(session, product_id))
            diagnostics.extend(relation_read["result"].get("diagnostics", []))
        nodes, graph_edges, cycles, truncated = self._graph_walk(
            focus, relation_edges, max_depth, max_edges, max(1, request["max_nodes"]))
        identities = [node["identity"] for node in nodes]
        identity_keys = {canonical(identity) for identity in identities}
        rows = []
        for product_id, products in session["metas"].items():
            kind = self._product_kind(products)
            product = self._first_meta(products)
            if kind == "relation" or (self._data_only_projection() and kind == "rule"):
                continue
            subject = product.get("subject")
            if canonical(subject) not in identity_keys:
                continue
            read = self._read_context_product(session, product_id)
            if read.get("status") != "ok":
                continue
            if session["business_range"] is not None:
                try:
                    self._validate_business_time_role(
                        session["business_range"], read["products"])
                except ProductQueryError as exc:
                    session["gaps"].append(exc.as_dict())
                    continue
            for item in read["result"].get("rows", []):
                if canonical(item.get("subject")) not in identity_keys:
                    continue
                if not self._context_time_ok(session, item, product, product_id):
                    continue
                projection = self._context_values(
                    item, product, request.get("fields"),
                    session=session, product_id=product_id)
                rows.append(self._context_item(
                    item, product,
                    projection["values"] if projection else None,
                    "event" if kind == "event" else "value"))
            diagnostics.extend(read["result"].get("diagnostics", []))
        for edge in graph_edges:
            rows.append({**edge, "row_type": "relation"})
        rows.sort(key=lambda item: (
            str(item.get("row_type") or ""),
            canonical(item.get("subject") or {}),
            str((item.get("record_ref") or {}).get("logical_key") or "")))
        coverage = {
            "products_in_snapshot": len(session["groups"]),
            "authorized_products": sum(1 for entry in session["cache"].values()
                                       if entry.get("status") == "ok"),
            "permission_denied_products": sorted(session["permission_denied"]),
            "truncated": truncated,
            "coverage_basis": "fixed snapshot + current authorization; not a claim of all world information",
        }
        if self._data_only_projection():
            coverage["identity_kinds"] = sorted({
                str((row.get("subject") or {}).get("kind"))
                for row in rows if isinstance(row.get("subject"), dict)
            })
            coverage["data_projection"] = "pure_wfd_data_no_source_or_evidence"
        query_hash = session["query_hash"]
        page = self._page_p4b(request, query_hash, rows)
        return {
            "format_version": "wfd.p4b-context-result/0.1",
            "protocol_version": request["protocol_version"],
            "operation": "read_company_context",
            "dataset_id": request["dataset_id"],
            "snapshot_id": request["snapshot_id"],
            "history_mode": request["history_mode"],
            "knowledge_cutoff": copy.deepcopy(request.get("knowledge_cutoff")),
            "cutoff": copy.deepcopy(session["cutoff_info"]),
            "subject": copy.deepcopy(focus),
            "query_hash": query_hash,
            "identities": identities,
            "nodes": nodes,
            "edges": graph_edges,
            "cycles": cycles,
            "rows": page["rows"],
            "page": page["page"],
            "coverage": coverage,
            "gaps": session["gaps"],
            "eligibility_diagnostics": diagnostics,
            "budget": {**session["budget"], "max_scan_bytes": request["max_scan_bytes"],
                       "max_nodes": request["max_nodes"]},
            "scope": {"p4b_complete": False, "p4a2_instance_holding": False,
                      "dependency_business_history": False},
        }

    def _read_relation_graph(self, request):
        session = self._p4b_session(request)
        focus = self._context_focus(request)
        max_depth = request["max_depth"]
        max_edges = int(request.get("max_edges") or 1000)
        edges, diagnostics = [], []
        for product_id, products in session["metas"].items():
            if self._product_kind(products) != "relation":
                continue
            read = self._read_context_product(session, product_id)
            if read.get("status") != "ok":
                continue
            edges.extend(self._graph_edges(session, product_id))
            diagnostics.extend(read["result"].get("diagnostics", []))
        relation_types = set(request.get("relation_types") or [])
        if relation_types:
            edges = [edge for edge in edges if edge.get("relation_type") in relation_types]
        nodes, graph_edges, cycles, truncated = self._graph_walk(
            focus, edges, max_depth, max_edges, request["max_nodes"])
        query_hash = session["query_hash"]
        page = self._page_p4b(request, query_hash, graph_edges)
        return {
            "format_version": "wfd.p4b-graph-result/0.1",
            "protocol_version": request["protocol_version"],
            "operation": "read_relation_graph",
            "dataset_id": request["dataset_id"],
            "snapshot_id": request["snapshot_id"],
            "history_mode": request["history_mode"],
            "subject": copy.deepcopy(focus),
            "max_depth": max_depth,
            "nodes": nodes,
            "edges": page["rows"],
            "cycles": cycles,
            "page": page["page"],
            "query_hash": query_hash,
            "truncated": truncated or page["page"]["has_more"],
            "gaps": session["gaps"],
            "eligibility_diagnostics": diagnostics,
            "coverage": {
                "relation_products": sum(1 for products in session["metas"].values()
                                         if self._product_kind(products) == "relation"),
                "authorized_products": sum(1 for key in session["cache"] if key not in session["permission_denied"]),
                "permission_denied_products": sorted(session["permission_denied"]),
                "unknown_relation_policy": "indeterminate edges are returned but not traversed",
            },
            "budget": {**session["budget"], "max_scan_bytes": request["max_scan_bytes"],
                       "max_nodes": request["max_nodes"]},
        }

    def _read_event_timeline(self, request):
        session = self._p4b_session(request)
        focus = self._context_focus(request)
        event_types = set(request.get("event_types") or [])
        rows, diagnostics = [], []
        for product_id, products in session["metas"].items():
            if self._product_kind(products) != "event":
                continue
            read = self._read_context_product(session, product_id)
            if read.get("status") != "ok":
                continue
            product = read["product"]
            if session["business_range"] is not None:
                try:
                    self._validate_business_time_role(
                        session["business_range"], read["products"])
                except ProductQueryError as exc:
                    session["gaps"].append(exc.as_dict())
                    continue
            for item in read["result"].get("rows", []):
                if canonical(item.get("subject")) != canonical(focus):
                    continue
                row = item.get("row") or {}
                if event_types and row.get("event_type") not in event_types:
                    continue
                if not self._context_time_ok(session, item, product, product_id):
                    continue
                projection = self._context_values(
                    item, product, request.get("fields"),
                    session=session, product_id=product_id)
                envelope = self._context_item(
                    item, product, projection["values"] if projection else None, "event")
                envelope["event_time_basis"] = "source event_time; plan/actual kept in content_nature/status"
                rows.append(envelope)
            diagnostics.extend(read["result"].get("diagnostics", []))
        rows.sort(key=lambda item: (
            str((item.get("times") or {}).get("event_time", {}).get("earliest_utc") or "~"),
            str((item.get("record_ref") or {}).get("logical_key") or "")))
        query_hash = session["query_hash"]
        page = self._page_p4b(request, query_hash, rows)
        return {
            "format_version": "wfd.p4b-event-timeline/0.1",
            "protocol_version": request["protocol_version"],
            "operation": "read_event_timeline",
            "dataset_id": request["dataset_id"],
            "snapshot_id": request["snapshot_id"],
            "history_mode": request["history_mode"],
            "subject": copy.deepcopy(focus),
            "event_types": sorted(event_types),
            "rows": page["rows"],
            "page": page["page"],
            "query_hash": query_hash,
            "gaps": session["gaps"],
            "eligibility_diagnostics": diagnostics,
            "budget": {**session["budget"], "max_scan_bytes": request["max_scan_bytes"],
                       "max_nodes": request["max_nodes"]},
            "coverage": {"event_products": sum(1 for products in session["metas"].values()
                                               if self._product_kind(products) == "event"),
                         "permission_denied_products": sorted(session["permission_denied"])},
        }

    def _read_applicable_rules(self, request):
        session = self._p4b_session(request)
        focus = self._context_focus(request)
        rule_codes = set(request.get("rule_codes") or [])
        rows = []
        rule_products = [pid for pid, products in session["metas"].items()
                         if self._product_kind(products) == "rule"]
        if not rule_products:
            session["gaps"].append({
                "code": "NO_RULE_PRODUCTS",
                "scope": "snapshot",
                "detail": "No rule product is declared in this fixed snapshot"})
        for product_id in rule_products:
            read = self._read_context_product(session, product_id)
            if read.get("status") != "ok":
                continue
            product = read["product"]
            if session["business_range"] is not None:
                try:
                    self._validate_business_time_role(
                        session["business_range"], read["products"])
                except ProductQueryError as exc:
                    session["gaps"].append(exc.as_dict())
                    continue
            for item in read["result"].get("rows", []):
                row = item.get("row") or {}
                row_subject = row.get("subject")
                matches = (canonical(item.get("subject")) == canonical(focus)
                           or canonical(row_subject) == canonical(focus))
                if self._data_only_projection():
                    matches = matches or canonical(row.get("object")) == canonical(focus)
                if not matches:
                    continue
                values = row.get("values") if isinstance(row.get("values"), dict) else {}
                code_cell = values.get("rule_code") or values.get("rule_id") or {}
                if rule_codes and code_cell.get("value") not in rule_codes:
                    continue
                if not self._context_time_ok(session, item, product, product_id,
                                             semantics="validity"):
                    continue
                projection = self._context_values(
                    item, product, request.get("fields"),
                    session=session, product_id=product_id)
                envelope = self._context_item(
                    item, product, projection["values"] if projection else None, "rule")
                business = self._business_definition(product)
                envelope["rule"] = {
                    "rule_code": code_cell.get("value"),
                    "effective_period": copy.deepcopy(row.get("effective_period")),
                    "public_time": copy.deepcopy(row.get("public_time")),
                    "definition_authority": business["definition_authority"],
                }
                if self._data_only_projection():
                    envelope["rule"]["publisher"] = copy.deepcopy(business["publisher"])
                    envelope["rule"]["conflict"] = False
                    envelope["rule"]["conflict_basis_count"] = 1
                rows.append(envelope)
        rows.sort(key=lambda item: (
            str((item.get("rule") or {}).get("rule_code") or ""),
            str((item.get("record_ref") or {}).get("logical_key") or "")))
        rule_conflicts = []
        if self._data_only_projection():
            grouped = {}
            for row in rows:
                grouped.setdefault((row.get("rule") or {}).get("rule_code"), []).append(row)
            for code, group in sorted(grouped.items(), key=lambda pair: str(pair[0] or "")):
                bases = {
                    canonical([
                        (row.get("definition_ref") or {}).get("digest"),
                        (row.get("contract_ref") or {}).get("digest"),
                        {role: (ref or {}).get("digest")
                         for role, ref in sorted((row.get("contract_refs") or {}).items())},
                        (row.get("contract_bundle_ref") or {}).get("digest"),
                        (row.get("record_ref") or {}).get("revision_id"),
                    ])
                    for row in group
                }
                conflict = len(bases) > 1
                for row in group:
                    row["rule"]["conflict"] = conflict
                    row["rule"]["conflict_basis_count"] = len(bases)
                if conflict:
                    rule_conflicts.append({
                        "rule_code": code,
                        "basis_count": len(bases),
                        "policy": "all_matching_bases_returned; no latest-wins selection",
                    })
        query_hash = session["query_hash"]
        page = self._page_p4b(request, query_hash, rows)
        result = {
            "format_version": "wfd.p4b-rule-result/0.1",
            "protocol_version": request["protocol_version"],
            "operation": "read_applicable_rules",
            "dataset_id": request["dataset_id"],
            "snapshot_id": request["snapshot_id"],
            "history_mode": request["history_mode"],
            "subject": copy.deepcopy(focus),
            "rules": page["rows"],
            "rows": page["rows"],
            "page": page["page"],
            "query_hash": query_hash,
            "status": "no_rule_products" if not rule_products else "rows",
            "gaps": session["gaps"],
            "budget": {**session["budget"], "max_scan_bytes": request["max_scan_bytes"],
                       "max_nodes": request["max_nodes"]},
            "coverage": {"rule_products": len(rule_products),
                         "permission_denied_products": sorted(session["permission_denied"])},
        }
        if self._data_only_projection():
            result["rule_conflicts"] = rule_conflicts
            result["rule_semantics"] = {
                "scope": "limited_subject_or_market_with_effective_period",
                "historical_eligibility": "market_known_at/system_held_at use existing "
                                          "service eligibility before rule matching",
                "conflict_policy": "return_all_matching_bases_side_by_side",
                "priority_engine": "not_implemented",
                "exception_interpreter": "not_implemented",
                "expression_framework_added": False,
            }
        return result

    def _read_trace_evidence(self, request):
        product_id = request["product_id"]
        if not self.service.has_permission("read_evidence"):
            return {"status": "permission_denied",
                    "code": "READ_EVIDENCE_PERMISSION_REQUIRED",
                    "product_id": product_id,
                    "detail": "caller lacks read_evidence; evidence details are not exposed"}
        session = self._p4b_session(request)
        entries = session["groups"].get(product_id)
        if not entries:
            raise ProductQueryError("PRODUCT_NOT_FOUND", "Product is not in the fixed snapshot",
                                    {"product_id": product_id})
        try:
            self._authorize_metadata_sources(
                self._source_ids_from_entries(entries), require_nonempty=True)
        except PermissionError:
            return {"status": "permission_denied",
                    "code": "SOURCE_READ_PERMISSION_MISSING",
                    "product_id": product_id,
                    "detail": "source read permission is missing; evidence details are not exposed"}
        for source_id in self._source_ids_from_entries(entries):
            if self.service.allowed_sources.get(source_id, {}).get("may_read_evidence") is not True:
                return {"status": "permission_denied",
                        "code": "SOURCE_READ_EVIDENCE_PERMISSION_MISSING",
                        "product_id": product_id,
                        "detail": "source evidence permission is missing; evidence details are not exposed"}
        dependencies = self._dependency_plan(request, session["metas"][product_id])
        budget = self._budget_preflight(
            request, entries, session["manifest"], session["commit_bytes"],
            session["snapshot_bytes"], session["manifest_bytes"], dependencies)
        evidence_bytes = 0
        digests = set()
        for entry in entries:
            for ref in entry.get("evidence_refs", []) or []:
                digest = (ref.get("content_sha256") or "").removeprefix("sha256:")
                if digest:
                    digests.add(digest)
        for digest in digests:
            path = self.root / "evidence/sha256" / digest
            if path.is_file():
                evidence_bytes += path.stat().st_size
        required = budget["required_scan_bytes"] + evidence_bytes
        if required > request["max_scan_bytes"]:
            raise ProductQueryError("SCAN_BUDGET_EXCEEDED",
                                    "Trace evidence budget is smaller than required bytes",
                                    {"required_scan_bytes": required,
                                     "max_scan_bytes": request["max_scan_bytes"],
                                     "evidence_bytes": evidence_bytes})
        try:
            traced = self.service.trace(product_id, snapshot_id=request["snapshot_id"])
        except PermissionError:
            return {"status": "permission_denied",
                    "code": "READ_EVIDENCE_PERMISSION_REQUIRED",
                    "product_id": product_id,
                    "detail": "caller or source lacks evidence permission; details are not exposed"}
        evidence = traced.get("evidence", [])
        if request.get("record_ref") or request.get("trace_fields"):
            session["gaps"].append({
                "code": "TRACE_FIELD_INDEX_NOT_AVAILABLE",
                "scope": "trace_evidence",
                "detail": "record/field filtering is echoed but the current public trace "
                          "returns product-level evidence, not a field-indexed map"})
        query_hash = session["query_hash"]
        page = self._page_p4b(request, query_hash, evidence)
        evidence = page["rows"]
        session["budget"]["required_scan_bytes"] += required
        session["budget"]["reads"].append({
            "product_id": product_id, "required_scan_bytes": required,
            "candidate_rows": 0, "scope": "trace_evidence"})
        return {
            "format_version": "wfd.p4b-trace-result/0.1",
            "protocol_version": request["protocol_version"],
            "operation": "trace_evidence",
            "dataset_id": request["dataset_id"],
            "snapshot_id": request["snapshot_id"],
            "product_id": product_id,
            "status": "verified_with_scope",
            "products": traced.get("products", []),
            "evidence": evidence,
            "page": page["page"],
            "query_hash": query_hash,
            "record_ref": copy.deepcopy(request.get("record_ref")),
            "trace_fields": sorted(request.get("trace_fields") or []),
            "public_projection": traced.get("public_projection"),
            "technical_metadata_note": "Contract/definition technical metadata has no business_public_time; "
                                       "it is not a market fact publication time.",
            "budget": {"required_scan_bytes": required,
                       "evidence_bytes": evidence_bytes,
                       "max_scan_bytes": request["max_scan_bytes"],
                       "reads": session["budget"]["reads"]},
            "gaps": session["gaps"],
        }

    # ------------------------------------------------------------------ execute
    def execute(self, request):
        """Validate and execute one fixed-snapshot product read request."""
        # Permission is checked before request parsing, snapshot or manifest
        # inspection, and again on every cursor page because this method runs
        # per request.
        self.service.require_permission("read")
        if (isinstance(request, dict)
                and request.get("operation") == "trace_evidence"
                and getattr(self.service, "profile", None) == "data_only"):
            raise ProductQueryError(
                "QUERY_OPERATION_UNSUPPORTED",
                "data_only does not expose trace_evidence; source/evidence provenance "
                "belongs to BD and WFD returns only record/version identity",
                {"operation": "trace_evidence",
                 "profile": "data_only",
                 "exposed_operations": sorted(DATA_ONLY_PUBLIC_QUERY_OPERATIONS),
                 "bd_boundary": "source/evidence/processing trace is not stored by WFD"})
        self._validate_request(request)
        if request["history_mode"] == "system_held_at":
            if not request.get("held_scope") or not request.get("usable_stage"):
                raise ProductQueryError(
                    "INSTANCE_HOLDING_UNKNOWN",
                    "system_held_at requires held_scope and usable_stage",
                    {"held_scope": request.get("held_scope"),
                     "usable_stage": request.get("usable_stage")})
            if getattr(self.service, "profile", None) != "data_only":
                raise ProductQueryError(
                    "INSTANCE_HOLDING_SCOPE_NOT_IMPLEMENTED",
                    "The legacy product service has no target-instance holding ledger",
                    {"profile": getattr(self.service, "profile", None),
                     "held_scope": request.get("held_scope"),
                     "usable_stage": request.get("usable_stage")})
        if request["operation"] in P4B_OPERATIONS:
            return self._execute_p4b(request)
        cutoff_at, cutoff_info = self._knowledge_cutoff(request)
        business_range = self._business_time_range(request)
        query_hash = self._query_hash(request, cutoff_info, business_range)
        cursor = None
        if request.get("cursor") is not None:
            cursor = self._decode_cursor(request["cursor"])
            if cursor["q"] != query_hash:
                raise ProductQueryError(
                    "CURSOR_QUERY_MISMATCH",
                    "Cursor is bound to a different fixed query",
                    {"cursor_query_hash": cursor["q"],
                     "request_query_hash": query_hash,
                     "cursor_snapshot_id": cursor["s"],
                     "request_snapshot_id": request["snapshot_id"]})
            if cursor["s"] != request["snapshot_id"]:
                raise ProductQueryError(
                    "CURSOR_QUERY_MISMATCH",
                    "Cursor is bound to a different fixed snapshot",
                    {"cursor_snapshot_id": cursor["s"],
                     "request_snapshot_id": request["snapshot_id"]})

        (snapshot, manifest, commit_bytes, snapshot_bytes,
         manifest_bytes) = self._preflight_snapshot(request["snapshot_id"])
        entries = [entry for entry in manifest["files"]
                   if entry.get("product_id") == request["product_id"]]
        if not entries:
            raise ProductQueryError(
                "PRODUCT_NOT_FOUND",
                "Product is not present in the fixed snapshot",
                {"snapshot_id": request["snapshot_id"],
                 "product_id": request["product_id"]})
        # All metadata-level source/range authorization happens before any
        # product structure diagnostic (including FIELD_NOT_DEFINED and its
        # available_fields list).  This does not read payloads.
        self._authorize_metadata_sources(
            self._source_ids_from_entries(entries), require_nonempty=True)
        manifest_products = self._manifest_products(entries)
        datasets = {product.get("dataset_id") for product in manifest_products.values()}
        if len(datasets) != 1:
            raise ProductQueryError(
                "PRODUCT_DATASET_INCONSISTENT",
                "One fixed product binding spans multiple dataset identities",
                {"datasets": sorted(datasets)})
        if request["dataset_id"] not in datasets:
            raise ProductQueryError(
                "DATASET_MISMATCH",
                "Requested dataset does not match the fixed product dataset",
                {"request_dataset_id": request["dataset_id"],
                 "product_dataset_id": next(iter(datasets)),
                 "product_id": request["product_id"]})

        self._current_business_policy(request, manifest_products)

        dependency_plan = self._dependency_plan(request, manifest_products)
        self._validate_business_time_role(business_range, manifest_products)
        perspective = request["history_mode"]
        batch_gate = getattr(self.service, "_query_batches_supported", None)
        use_batches = self._data_only_projection() and callable(batch_gate) and batch_gate(
            perspective=perspective, entries=entries, products=manifest_products)
        bounded_tabular = use_batches and all(entry.get("payload_kind") == "tabular_rows" for entry in entries)
        budget = self._budget_preflight(
            request, entries, manifest, commit_bytes, snapshot_bytes,
            manifest_bytes, dependency_plan, bounded_product_pages=bounded_tabular)

        available = {}
        for product in manifest_products.values():
            for code in _declaration_fields(product):
                available.setdefault(code, []).append(product.get("contract_ref"))
        missing_fields = [field for field in request["fields"] if field not in available]
        if missing_fields:
            raise ProductQueryError(
                "FIELD_NOT_DEFINED",
                "Requested field is not a declared value field for this product",
                {"product_id": request["product_id"],
                 "missing_fields": missing_fields,
                 "available_fields": sorted(available)})

        if use_batches:
            batch_count = 0
            single_pass_bytes = budget["required_scan_bytes"]

            def reserve_batch():
                nonlocal batch_count
                required = single_pass_bytes * (batch_count + 1)
                if required > request["max_scan_bytes"]:
                    raise ProductQueryError(
                        "SCAN_BUDGET_EXCEEDED",
                        "Additional batch exceeds the conservative fixed-read scan allowance",
                        {"required_scan_bytes": required,
                         "max_scan_bytes": request["max_scan_bytes"],
                         "completed_batches": batch_count,
                         "accounting": "bounded_product_page_allowance_per_batch" if bounded_tabular else "whole_fixed_read_allowance_per_batch"})
                batch_count += 1
                if batch_count > 1:
                    budget.update({
                        "required_scan_bytes": required, "conservative": True,
                        "payload_bytes": budget["read_plan"]["payload_bytes"] * batch_count,
                        "metadata_bytes": budget["read_plan"]["metadata_bytes"] * batch_count,
                        "batch_count": batch_count,
                        "read_plan_scope": "single_batch_base_allowance",
                        "fixed_snapshot_metadata_bytes": budget["read_plan"]["selected_snapshot"]["metadata_bytes"] * batch_count,
                        "single_pass_required_scan_bytes": single_pass_bytes,
                        "scope": "bounded_product_page_allowance_per_batch" if bounded_tabular else "whole_fixed_read_allowance_per_batch",
                        "note": ("Each batch reserves its complete fixed-product-page allowance, including the query preflight again conservatively. "
                                if bounded_tabular else "Each batch reserves a complete legacy fixed-read allowance; ") +
                                "this conservatively covers repeated part verification and metadata, "
                                "not measured operating-system or SQL physical IO."})

            try:
                reduced = self._project_batch_window(
                    request, self.service._iter_query_batches(
                        request["product_id"], snapshot_id=request["snapshot_id"],
                        before_batch=reserve_batch),
                    manifest_products, subject=request.get("subject"),
                    fields=sorted(request["fields"]), business_range=business_range,
                    last=tuple(cursor["last"]) if cursor is not None else None)
            except (PermissionError, ProductQueryError):
                raise
            except ValueError as exc:
                text = str(exc)
                code = text.split(":", 1)[0].strip() or "READ_FAILED"
                if not all(part and (part.replace("_", "").isalnum())
                           for part in code.split(".")):
                    code = "READ_FAILED"
                raise ProductQueryError(code, text,
                                        {"snapshot_id": request["snapshot_id"],
                                         "product_id": request["product_id"]}) from exc
            except (OSError, RuntimeError) as exc:
                raise ProductQueryError("READ_FAILED", str(exc),
                                        {"snapshot_id": request["snapshot_id"],
                                         "product_id": request["product_id"]}) from exc
            page_rows, total_rows = reduced["rows"], reduced["total_rows"]
            remaining_rows, has_more = reduced["remaining_rows"], reduced["has_more"]
            diagnostics, products, units = reduced["diagnostics"], reduced["products"], reduced["units"]
            source_ids = reduced["source_ids"]
        else:
            try:
                read_kwargs = {"snapshot_id": request["snapshot_id"],
                               "perspective": perspective, "at": cutoff_at,
                               "verify_contract_files": False}
                if self._data_only_projection():
                    read_kwargs["fields"] = sorted(request["fields"])
                    read_kwargs["business_time_range"] = business_range
                    if perspective == "system_held_at":
                        read_kwargs["held_scope"] = request.get("held_scope")
                        read_kwargs["usable_stage"] = request.get("usable_stage")
                result = self.service.read(request["product_id"], **read_kwargs)
            except (PermissionError, ProductQueryError):
                raise
            except ValueError as exc:
                text = str(exc)
                code = text.split(":", 1)[0].strip() or "READ_FAILED"
                if not all(part and (part.replace("_", "").isalnum())
                           for part in code.split(".")):
                    code = "READ_FAILED"
                raise ProductQueryError(code, text,
                                        {"snapshot_id": request["snapshot_id"],
                                         "product_id": request["product_id"]}) from exc
            except (OSError, RuntimeError) as exc:
                raise ProductQueryError("READ_FAILED", str(exc),
                                        {"snapshot_id": request["snapshot_id"],
                                         "product_id": request["product_id"]}) from exc
            if result.get("snapshot_id") != request["snapshot_id"]:
                raise ProductQueryError(
                    "SNAPSHOT_SELECTION_MISMATCH",
                    "Service returned a different snapshot than the fixed request",
                    {"request_snapshot_id": request["snapshot_id"],
                     "result_snapshot_id": result.get("snapshot_id")})

            rows, diagnostics, products, units = self._project(
                request, result, manifest_products,
                subject=request.get("subject"),
                fields=sorted(request["fields"]),
                business_range=business_range)

            all_rows = rows
            total_rows = len(all_rows)
            last = tuple(cursor["last"]) if cursor is not None else None
            page_rows, remaining_rows = self._cursor_window(
                all_rows, last, request["page_size"])
            has_more = remaining_rows > len(page_rows)
        next_cursor = None
        if has_more and page_rows:
            next_cursor = self._encode_cursor(
                query_hash, request["snapshot_id"], self._sort_key(page_rows[-1]))

        partial_diagnostics = [
            item for item in diagnostics
            if item.get("decision") == "indeterminate"
            or item.get("code") in {
                "FIELD_NOT_DEFINED_IN_ROW_CONTRACT", "FIELD_VALUE_MISSING",
                "FIELD_VALUE_INVALID", "FIELD_VALUE_STATE_INVALID",
                "FIELD_VALUE_STATE_MISMATCH", "FIELD_TYPE_MISMATCH",
                "PRODUCT_CONTRACT_UNAVAILABLE",
            }
        ]
        page_complete = not has_more
        complete = page_complete and not partial_diagnostics
        if page_rows:
            result_status = "rows"
        elif cursor is not None and total_rows and not diagnostics:
            result_status = "cursor_exhausted"
        elif diagnostics:
            result_status = "no_rows_with_diagnostics"
        else:
            result_status = "no_rows"

        product_envelope = self._product_envelope(
            request["product_id"], products, sorted(request["fields"]))
        if not use_batches:
            source_ids = sorted({
                source_id
                for item in all_rows
                for source_id in (item.get("source_binding") or {}).get("source_ids", []) or []
            })
        return {
            "format_version": RESULT_FORMAT,
            "protocol_version": PROTOCOL_VERSION,
            "operation": "read_product",
            "dataset_id": request["dataset_id"],
            "snapshot_id": request["snapshot_id"],
            "product_id": request["product_id"],
            "history_mode": request["history_mode"],
            "knowledge_cutoff": copy.deepcopy(request.get("knowledge_cutoff")),
            "cutoff": copy.deepcopy(cutoff_info),
            "held_scope": request.get("held_scope"),
            "usable_stage": request.get("usable_stage"),
            "subject": copy.deepcopy(request.get("subject")),
            "fields": sorted(request["fields"]),
            "business_time_range": copy.deepcopy(business_range),
            "query_hash": query_hash,
            "sort": list(SORT_KEYS),
            "product": product_envelope,
            "source_ids": source_ids,
            "units": units,
            "rows": page_rows,
            "diagnostics": diagnostics,
            "diagnostics_total": len(diagnostics),
            "diagnostic_notes": ([
                "Service eligibility diagnostics are fixed-snapshot exclusions for the same "
                "exact subject. Their row business time is not re-read (which would be a second "
                "storage scan), so they are not additionally filtered by business_time_range."
            ] if business_range is not None else []),
            "budget": budget,
            "page": {
                "page_size": request["page_size"],
                "returned_rows": len(page_rows),
                "total_rows": total_rows,
                "remaining_rows": remaining_rows,
                "has_more": has_more,
                "next_cursor": next_cursor,
                "cursor_applied": cursor is not None,
                "page_complete": page_complete,
            },
            "result_status": result_status,
            "complete": complete,
            "scope": {
                "package": "P4a1",
                "p4_complete": False,
                "p4a2_instance_holding": "first_segment",
                "p4b_operations": False,
                "p5": False,
                "p6": False,
                "p7": False,
            },
            "limitations": list(LIMITATIONS),
        }


WFDProductQuery = ProductQuery
