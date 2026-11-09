"""R07-B：``filter_objects`` 最小只读候选（spec/v1.4 候选，未发行）。

职责：在**固定快照**上，按产品已登记的字段与 Decimal 常量筛选对象，
返回合格对象与逐条数值回执。不计算、不派生、不写入，不改变旧六项只读操作。

实现路径：先 ``discover_products`` 取字段定义，再复用 ``ProductQuery`` 的
``read_product`` 取行，最后用 ``Decimal`` 比对。不直接扫描 Parquet。
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation

try:  # 仅在机器进程内可用；单独导入本模块做纯函数测试时不强制依赖
    from wfd_sdk.product_query import ProductQueryError
except Exception:  # noqa: BLE001
    class ProductQueryError(Exception):  # type: ignore[no-redef]
        code = "UNKNOWN"
        details = None

FILTER_PROTOCOL_VERSION = "wfd.filter-objects/1.4-candidate"
READ_PROTOCOL_VERSION = "wfd.read/1.3-product1"
SUPPORTED_HISTORY_MODES = ("snapshot_contents",)
SUPPORTED_OPS = ("=", ">=", "<=", ">", "<")

_ALLOWED = {"protocol_version", "dataset_id", "operation", "snapshot_id", "history_mode",
            "knowledge_cutoff", "held_scope", "usable_stage", "universe", "product_id",
            "business_time_range", "predicate", "page_size", "max_scan_bytes", "max_nodes"}
_REQUIRED = ("protocol_version", "dataset_id", "operation", "snapshot_id", "history_mode",
             "universe", "product_id", "business_time_range", "predicate",
             "page_size", "max_scan_bytes", "max_nodes")


class FilterRejected(Exception):
    """请求被明确拒绝；不是空集，也不降级为别的模式。"""

    def __init__(self, code: str, message: str, details=None):
        super().__init__(code + ": " + message)
        self.code = code
        self.message = message
        self.details = details


def _reject(code, message, details=None):
    raise FilterRejected(code, message, details)


def _exact(arguments):
    extra = sorted(set(arguments) - _ALLOWED)
    if extra:
        _reject("REQUEST_INVALID", "unexpected fields " + ",".join(extra))
    missing = [key for key in _REQUIRED if key not in arguments]
    if missing:
        _reject("REQUEST_INVALID", "missing fields " + ",".join(missing))


def _decimal(text, field):
    if not isinstance(text, str) or not text:
        _reject("PREDICATE_INVALID", f"{field} 必须是十进制字符串，不接受浮点。")
    try:
        value = Decimal(text)
    except (InvalidOperation, ValueError):
        _reject("PREDICATE_INVALID", f"{field} 不是合法十进制：{text!r}")
    if not value.is_finite():
        _reject("PREDICATE_INVALID", f"{field} 必须是有限值。")
    return value


def _compare(left: Decimal, op: str, right: Decimal) -> bool:
    if op == "=":
        return left == right
    if op == ">=":
        return left >= right
    if op == "<=":
        return left <= right
    if op == ">":
        return left > right
    if op == "<":
        return left < right
    _reject("UNSUPPORTED_OPERATOR", f"未支持的比较算子：{op}")


def _resolve_product(discovered, product_id, subject):
    products = discovered.get("products") or []
    for product in products:
        if product.get("product_id") != product_id:
            continue
        declared = (product.get("subject") or {})
        if subject is not None and declared and declared != subject:
            continue
        return product
    _reject("PRODUCT_NOT_IN_SNAPSHOT",
            f"固定快照内没有产品 {product_id}，或该产品不绑定此对象。",
            {"product_id": product_id, "snapshot_id": discovered.get("snapshot_id")})


def _field_definition(product, field_code):
    declaration = product.get("declaration") or {}
    for entry in declaration.get("field_definitions") or []:
        if entry.get("field_code") == field_code:
            return entry
    return None


def _inner_request(arguments, subject):
    return {
        "protocol_version": READ_PROTOCOL_VERSION,
        "dataset_id": arguments["dataset_id"],
        "operation": "read_product",
        "snapshot_id": arguments["snapshot_id"],
        "history_mode": "snapshot_contents",
        "knowledge_cutoff": None,
        "held_scope": None,
        "usable_stage": None,
        "subject": subject,
        "max_nodes": int(arguments["max_nodes"]),
        "product_id": arguments["product_id"],
        "fields": [((arguments.get("predicate") or {}).get("compare") or {}).get("field")],
        "page_size": int(arguments["page_size"]),
        "max_scan_bytes": int(arguments["max_scan_bytes"]),
        "business_time_range": arguments["business_time_range"],
    }


def run(service, config, arguments, query_factory, service_identity):
    """执行一次最小只读筛选；返回结果字典。拒绝时抛 FilterRejected。"""
    service.require_permission("read")
    if arguments.get("protocol_version") == "wfd.filter-objects/1.4-product1":
        from .filter_plan import run as run_plan
        return run_plan(service, config, arguments, query_factory, service_identity)
    _exact(arguments)

    if arguments.get("protocol_version") != FILTER_PROTOCOL_VERSION:
        _reject("PROTOCOL_VERSION_UNSUPPORTED",
                f"本候选只接受 {FILTER_PROTOCOL_VERSION}；旧版本不识别该操作。",
                {"required": FILTER_PROTOCOL_VERSION})
    if arguments.get("operation") != "filter_objects":
        _reject("REQUEST_INVALID", "operation 必须是 filter_objects。")

    history_mode = arguments.get("history_mode")
    if history_mode not in SUPPORTED_HISTORY_MODES:
        _reject("QUALIFICATION_INSUFFICIENT",
                f"本候选只支持 snapshot_contents；{history_mode} 需要公开时间或持有资格证据，"
                "不降级为 snapshot_contents。",
                {"requested": history_mode, "supported": list(SUPPORTED_HISTORY_MODES)})

    universe = arguments.get("universe") or {}
    if universe.get("kind") != "explicit_subjects":
        _reject("UNSUPPORTED_CAPABILITY", "本版只支持显式对象集合 universe。",
                {"requested": universe.get("kind")})
    subjects = universe.get("subjects") or []
    if len(subjects) != 1:
        _reject("UNSUPPORTED_CAPABILITY", "本版只支持单对象；多对象排序与分页未实现。",
                {"subjects": len(subjects)})
    subject = subjects[0]
    if subject.get("kind") != "instrument":
        _reject("UNSUPPORTED_CAPABILITY", "本版只支持 instrument 对象。", {"kind": subject.get("kind")})

    business_time_range = arguments.get("business_time_range") or {}
    if business_time_range.get("role") != "observation":
        _reject("UNSUPPORTED_CAPABILITY", "本版只支持 observation 时间角色。",
                {"role": business_time_range.get("role")})

    discovered = service.discover_products(snapshot_id=arguments["snapshot_id"], subject=subject)
    product = _resolve_product(discovered, arguments["product_id"], subject)

    predicate = arguments.get("predicate") or {}
    compare = predicate.get("compare")
    if not isinstance(compare, dict):
        _reject("UNSUPPORTED_PREDICATE",
                "本版只支持单个 compare 谓词；and/or/not、between、in、compare_metrics 未实现。")
    field_code = compare.get("field")
    op = compare.get("op")
    raw_value = compare.get("value") or {}

    definition = _field_definition(product, field_code)
    if definition is None:
        _reject("FIELD_NOT_REGISTERED", f"产品未登记字段 {field_code}。",
                {"field": field_code,
                 "registered": [e.get("field_code") for e in
                                (product.get("declaration") or {}).get("field_definitions") or []]})
    if raw_value.get("data_type") != "decimal":
        _reject("UNSUPPORTED_CAPABILITY", "本版只支持 decimal 常量比较。",
                {"data_type": raw_value.get("data_type")})
    if definition.get("data_type") != "decimal":
        _reject("UNSUPPORTED_CAPABILITY", f"字段 {field_code} 不是 decimal，本版不支持比较。",
                {"data_type": definition.get("data_type")})
    if op not in SUPPORTED_OPS:
        _reject("UNSUPPORTED_OPERATOR", f"未支持的比较算子：{op}", {"supported": list(SUPPORTED_OPS)})
    declared_unit = definition.get("unit_code")
    requested_unit = raw_value.get("unit_code")
    if requested_unit != declared_unit:
        _reject("UNIT_INCOMPATIBLE",
                f"谓词单位 {requested_unit} 与已登记单位 {declared_unit} 不一致；不做隐式换算。",
                {"requested": requested_unit, "declared": declared_unit})
    threshold = _decimal(raw_value.get("value"), "predicate.compare.value.value")

    budget = int(arguments["max_nodes"])
    budget_exhausted = None
    try:
        read = query_factory().execute(_inner_request(arguments, subject))
    except ProductQueryError as error:
        # 扫描预算不够是「执行未完成」，不是空集、也不是命中；必须带出已发生的扫描量。
        if getattr(error, "code", "") not in ("ROW_BUDGET_EXCEEDED", "SCAN_BUDGET_EXCEEDED"):
            raise
        details = getattr(error, "details", None) or {}
        read = {"rows": [], "page": {
            "total_rows": int(details.get("candidate_rows") or 0),
            "has_more": True, "page_complete": False}}
        budget_exhausted = getattr(error, "code", "ROW_BUDGET_EXCEEDED")
    page = read.get("page") or {}
    rows = read.get("rows") or []
    candidate_rows = int(page.get("total_rows") or 0)
    has_more = bool(page.get("has_more"))

    matched = []
    indeterminate = []
    for row in rows:
        cell = (row.get("values") or {}).get(field_code)
        if not cell or cell.get("value_state") not in {"valid_value", "reported_zero"} or cell.get("value") is None:
            indeterminate.append({"subject": row.get("subject"),
                                  "reason": (cell or {}).get("value_state") or "missing_field"})
            continue
        value = _decimal(cell.get("value"), f"{field_code}.value")
        if _compare(value, op, threshold):
            matched.append((row, cell))

    scan_complete = bool(page.get("page_complete")) and not has_more
    if budget_exhausted is not None:
        status = "scan_incomplete"
        gaps = [{"code": budget_exhausted,
                 "message": "候选行超出 max_nodes 预算；本次未完成扫描，不返回部分结果冒充完整。",
                 "candidate_rows": candidate_rows, "row_budget": budget}]
    elif candidate_rows == 0:
        status = "coverage_insufficient"
        gaps = [{"code": "NO_QUALIFIED_RECORD_IN_RANGE",
                 "message": "该观察时间区间内没有合格记录；不补零、不外推。",
                 "business_time_range": business_time_range}]
    elif not scan_complete:
        status = "scan_incomplete"
        gaps = [{"code": "SCAN_INCOMPLETE", "message": "扫描未完成，结果不完整。"}]
    elif matched:
        status = "matched"
        gaps = []
    elif indeterminate:
        status = "coverage_insufficient"
        gaps = [{"code": "VALUE_INDETERMINATE", "message": "存在缺值；不能声明完整空集。"}]
    else:
        status = "empty"
        gaps = []

    objects = []
    for row, cell in matched:
        objects.append({
            "subject": row.get("subject"),
            "business_time": row.get("business_time"),
            "business_time_role": row.get("business_time_role"),
            "record_ref": row.get("record_ref"),
            "revision": row.get("revision"),
            "revision_state": row.get("revision_state"),
            "eligibility": row.get("eligibility"),
            "predicate_result": True,
            "values": {field_code: cell},
            "definition_ref": product.get("definition_ref"),
            "contract_ref": row.get("contract_ref"),
        })

    return {
        "format_version": "wfd.filter-objects-result/0.1",
        "protocol_version": FILTER_PROTOCOL_VERSION,
        "operation": "filter_objects",
        "dataset_id": arguments["dataset_id"],
        "snapshot_id": arguments["snapshot_id"],
        "product_id": arguments["product_id"],
        "history_mode": history_mode,
        "status": status,
        "predicate": {"field": field_code, "op": op, "value": str(threshold),
                      "unit_code": declared_unit, "data_type": "decimal"},
        "universe": universe,
        "business_time_range": business_time_range,
        "objects": objects,
        "object_count": len(objects),
        "indeterminate": indeterminate,
        "scan_receipt": {
            "candidate_rows": candidate_rows,
            "budget_exhausted": budget_exhausted,
            "scanned_rows": len(rows),
            "matched_objects": len(objects),
            "indeterminate_rows": len(indeterminate),
            "row_budget": budget,
            "has_more": has_more,
            "scan_complete": scan_complete,
        },
        "gaps": gaps,
        "service_identity": service_identity,
    }
