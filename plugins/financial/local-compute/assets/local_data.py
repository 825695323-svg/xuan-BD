"""显式本地记录的字段映射、历史快照、逐条回放与条件筛选。"""

from copy import deepcopy
from datetime import datetime, time
from decimal import Decimal, InvalidOperation
import json
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from _common import exact_keys, integer, number, require, validate_bars


OPERATIONS = ("normalize_bars", "daily_snapshot", "replay_daily", "normalize_quotes",
              "normalize_positions", "normalize_orders", "filter_rows")
PRICE_FIELDS = ("open", "high", "low", "close")


def _text(value, label):
    require(isinstance(value, str) and bool(value.strip()), label + "须为非空字符串")
    return value


def _zone(value):
    _text(value, "timezone")
    try:
        return ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise ValueError("timezone须为有效IANA时区") from error


def _numeric_cell(value, label, positive=False, nonnegative=False, nullable=False, integral=False):
    if nullable and (value is None or value == ""):
        return None
    if integral:
        require(type(value) in (int, float, str), label + "须为整数数量")
        try:
            exact = Decimal(str(value))
        except InvalidOperation as error:
            raise ValueError(label + "须为整数数量") from error
        require(exact.is_finite() and exact == exact.to_integral_value(), label + "须为有限整数数量")
        number(float(exact), label)
        require(not positive or exact > 0, label + "须大于0")
        require(not nonnegative or exact >= 0, label + "不能为负数")
        return int(exact)
    if isinstance(value, str):
        require(bool(value.strip()), label + "缺少数值")
        try:
            value = float(value)
        except ValueError as error:
            raise ValueError(label + "不能转为数值") from error
    value = number(value, label, positive=positive, nonnegative=nonnegative)
    if integral:
        require(value.is_integer(), label + "须为整数数量")
        return int(value)
    return value


def _fields(value, required, optional=()):
    exact_keys(value, required, optional, label="params.fields")
    for key, source in value.items():
        _text(source, "fields." + key)
    require(len(set(value.values())) == len(value), "映射到的原列不能重复")
    return value


def _mapped(record, fields, key, label, nullable=False):
    if key not in fields:
        require(nullable, "未映射所需字段" + key)
        return None
    column = fields[key]
    require(column in record, label + "缺少显式映射列" + column)
    return record[column]


def _normalize_bars(request):
    p, data = request["params"], request["data"]
    exact_keys(p, ("fields", "date_format", "price_transform"),
               ("output_adjustment", "output_adjustment_basis"), label="params")
    fields = _fields(p["fields"], ("timestamp",) + PRICE_FIELDS, ("volume", "amount", "price_factor"))
    require(p["date_format"] in ("%Y-%m-%d", "%Y%m%d"), "date_format须为%Y-%m-%d或%Y%m%d")
    require(p["price_transform"] in ("none", "factor"), "price_transform须为none/factor")
    exact_keys(data, ("metadata", "columns", "records"), label="data")
    metadata = deepcopy(data["metadata"])
    require(isinstance(metadata, dict), "metadata须为对象")
    _zone(metadata.get("timezone"))
    for key in ("volume", "amount"):
        if key in fields:
            _text(metadata.get(key + "_unit"), "metadata." + key + "_unit")
    columns, records = data["columns"], data["records"]
    require(isinstance(columns, list) and bool(columns), "columns须为非空原列名数组")
    for column in columns:
        _text(column, "columns")
    require(len(set(columns)) == len(columns), "columns不能重复")
    require(set(fields.values()) <= set(columns), "显式映射列不在columns中")
    require(isinstance(records, list) and bool(records), "records须为非空记录数组")
    factor_mode = p["price_transform"] == "factor"
    if factor_mode:
        require("price_factor" in fields, "factor模式须映射price_factor")
        require(metadata.get("adjustment") == "unadjusted", "factor模式输入须声明unadjusted，避免重复复权")
        require(p.get("output_adjustment") in ("forward_adjusted", "backward_adjusted"), "须声明因子输出复权类型")
        _text(p.get("output_adjustment_basis"), "params.output_adjustment_basis")
    else:
        require("price_factor" not in fields and "output_adjustment" not in p and "output_adjustment_basis" not in p,
                "none模式不得提供因子或输出复权声明")
    rows, missing_optional = [], set()
    for i, record in enumerate(records, 1):
        require(isinstance(record, dict) and set(record) == set(columns), "第%d条记录的列须与columns一致" % i)
        value = _mapped(record, fields, "timestamp", "第%d条" % i)
        _text(value, "第%d条timestamp" % i)
        try:
            parsed = datetime.strptime(value, p["date_format"]).date()
        except ValueError as error:
            raise ValueError("第%d条日期格式无效" % i) from error
        require(parsed.strftime(p["date_format"]) == value, "日期须严格符合date_format")
        factor = _numeric_cell(_mapped(record, fields, "price_factor", "第%d条" % i),
                               "price_factor", positive=True) if factor_mode else 1.0
        row = {"timestamp": parsed.isoformat()}
        for field in PRICE_FIELDS:
            raw = _numeric_cell(_mapped(record, fields, field, "第%d条" % i), field, positive=True)
            row[field] = number(raw * factor, "变换后" + field, positive=True)
        for field in ("volume", "amount"):
            value = _numeric_cell(_mapped(record, fields, field, "第%d条" % i, nullable=True),
                                  field, nonnegative=True, nullable=True)
            row[field] = value
            if value is None:
                missing_optional.add(field)
        rows.append(row)
    # 先验证输入口径与顺序，输出口径只在统一四价变换完成后更新。
    validate_bars({"metadata": metadata, "rows": rows}, required=PRICE_FIELDS)
    if factor_mode:
        metadata["adjustment"] = p["output_adjustment"]
        metadata["adjustment_basis"] = p["output_adjustment_basis"]
    return {"metadata": metadata, "rows": rows,
            "diagnostics": [{"code": "missing_optional_field", "field": field, "value": None}
                            for field in sorted(missing_optional)],
            "method": {"price_transform": "one_explicit_factor_multiplied_into_all_four_prices" if factor_mode else "mapped_four_prices_as_declared",
                       "date_format": p["date_format"], "sort_or_fill": False,
                       "factor_semantics_verified": False, "volume_amount_transformed": False}}


def _daily_snapshot(request):
    exact_keys(request["params"], (), label="params")
    metadata, rows = validate_bars(request["data"], required=("close",))
    _zone(metadata["timezone"])
    last = rows[-1]
    previous = rows[-2]["close"] if len(rows) >= 2 else None
    record = {"series_id": metadata["series_id"], "timestamp": last["timestamp"], "price": last["close"],
              "previous_observed_close": previous,
              "change_from_previous_observation": number((last["close"] - previous) / previous, "日线观察变化率") if previous is not None else None,
              "snapshot_kind": "last_daily_bar", "is_realtime": False}
    for key in ("open", "high", "low", "volume", "amount"):
        record[key] = last.get(key)
    diagnostics = []
    if previous is None:
        diagnostics.append({"code": "previous_observed_close_unavailable", "value": None})
    for field in ("volume", "amount"):
        if record[field] is None:
            diagnostics.append({"code": "missing_optional_field", "field": field, "value": None})
    return {"metadata": metadata, "rows": [record], "diagnostics": diagnostics,
            "method": {"source": "last_supplied_daily_observation", "is_realtime": False,
                       "previous_price": "prior_supplied_observation_not_verified_exchange_preclose"}}


def iter_daily_observations(data, at_time, start_seq):
    """纯迭代器：只消费已提供的历史日线；不睡眠、不订阅、不访问本机时间。"""
    metadata, rows = validate_bars(data, required=("close",))
    zone = _zone(metadata["timezone"])
    integer(start_seq, "params.start_seq")
    _text(at_time, "params.at_time")
    try:
        clock = time.fromisoformat(at_time)
    except ValueError as error:
        raise ValueError("at_time须为HH:MM:SS本地观察标记时间") from error
    require(clock.tzinfo is None and clock.strftime("%H:%M:%S") == at_time,
            "at_time须严格为HH:MM:SS，不含时区或小数秒")
    for index, row in enumerate(rows):
        day = datetime.strptime(row["timestamp"], "%Y-%m-%d").date()
        stamp = datetime.combine(day, clock, tzinfo=zone).isoformat()
        yield {"seq": start_seq + index, "timestamp": stamp, "type": "price", "price": row["close"]}


def _replay_daily(request):
    p = request["params"]
    exact_keys(p, ("at_time", "start_seq", "quantity_unit"), label="params")
    _text(p["quantity_unit"], "params.quantity_unit")
    events = list(iter_daily_observations(request["data"], p["at_time"], p["start_seq"]))
    meta = request["data"]["metadata"]
    event_metadata = {"series_id": meta["series_id"], "timezone": meta["timezone"],
                      "price_unit": meta["price_unit"], "quantity_unit": p["quantity_unit"],
                      "adjustment": meta["adjustment"], "adjustment_basis": meta["adjustment_basis"],
                      "observation_kind": "daily_close_observations"}
    return {"metadata": event_metadata, "rows": events, "diagnostics": [],
            "method": {"replay": "one_supplied_daily_close_per_event", "event_time": "date_plus_user_assigned_local_marker",
                       "at_time": p["at_time"], "intraday_or_tick_evidence": False,
                       "source_daily_metadata": deepcopy(meta)}}


def _record_input(data, id_field, fields, key_is_id):
    exact_keys(data, ("metadata", "records"), label="data")
    records = data["records"]
    if key_is_id:
        require(isinstance(records, dict), "key_is_id=true时records须为按标识键控的对象")
        require(id_field not in fields, "键即标识时不得另行映射" + id_field)
        iterable = list(records.items())
    else:
        require(isinstance(records, list), "key_is_id=false时records须为记录数组")
        require(id_field in fields, "须显式映射" + id_field)
        iterable = [(None, row) for row in records]
    for key, row in iterable:
        require(isinstance(row, dict), "每条记录须为对象")
        if key_is_id:
            _text(key, "记录键")
    return iterable


def _snapshot_metadata(value, needs_quantity=False, needs_price=False):
    required = ("snapshot_at", "timezone") + (("quantity_unit",) if needs_quantity else ()) + (("price_unit",) if needs_price else ())
    exact_keys(value, required, ("volume_unit", "amount_unit"), label="metadata")
    for key in required:
        _text(value[key], "metadata." + key)
    zone = _zone(value["timezone"])
    try:
        stamp = datetime.fromisoformat(value["snapshot_at"].replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("snapshot_at无效") from error
    require("T" in value["snapshot_at"] and stamp.utcoffset() is not None,
            "snapshot_at须为含时区偏移的ISO日期时间")
    require(stamp.utcoffset() == stamp.astimezone(zone).utcoffset(), "snapshot_at偏移与timezone不一致")
    return deepcopy(value)


def _normalize_table(request, operation):
    p = request["params"]
    exact_keys(p, ("fields", "key_is_id"), ("status_map",) if operation == "normalize_orders" else (), label="params")
    require(type(p["key_is_id"]) is bool, "key_is_id须为布尔值")
    id_field = "order_id" if operation == "normalize_orders" else "symbol"
    schemas = {
        "normalize_quotes": (("symbol", "price"), ("previous_close", "open", "high", "low", "volume", "amount")),
        "normalize_positions": (("symbol", "quantity", "available_quantity", "average_cost"), ()),
        "normalize_orders": (("order_id", "symbol", "side", "quantity", "filled_quantity", "status"), ("limit_price",)),
    }
    required, optional = schemas[operation]
    fields = _fields(p["fields"], tuple(x for x in required if not (p["key_is_id"] and x == id_field)), optional)
    data = request["data"]
    iterable = _record_input(data, id_field, fields, p["key_is_id"])
    metadata = _snapshot_metadata(data["metadata"], needs_quantity=operation != "normalize_quotes", needs_price=True)
    if "status_map" in p:
        require(isinstance(p["status_map"], dict), "status_map须为对象")
        for key, value in p["status_map"].items():
            _text(key, "status_map键")
            require(value in ("pending", "partially_filled", "filled", "cancelled", "rejected", "unknown"), "status_map输出状态无效")
    output, seen, diagnostics = [], set(), []
    for index, (record_key, raw) in enumerate(iterable):
        label = "第%d条" % (index + 1)
        row = {}
        for field in required + optional:
            if field == id_field and p["key_is_id"]:
                value = record_key
            else:
                value = _mapped(raw, fields, field, label, nullable=field in optional)
            if field in ("symbol", "order_id", "side", "status"):
                row[field] = _text(value, label + field) if value is not None else None
            elif field in ("quantity", "available_quantity", "filled_quantity"):
                row[field] = _numeric_cell(value, label + field, nonnegative=True, integral=True)
            else:
                row[field] = _numeric_cell(value, label + field, positive=field not in ("volume", "amount"),
                                           nonnegative=field in ("volume", "amount"),
                                           nullable=field in optional or field == "average_cost")
        require(row[id_field] not in seen, "规范标识不能重复")
        seen.add(row[id_field])
        if operation == "normalize_quotes":
            for key in ("volume", "amount"):
                if row[key] is not None:
                    _text(metadata.get(key + "_unit"), "metadata." + key + "_unit")
                else:
                    diagnostics.append({"index": index, "code": "missing_optional_field", "field": key, "value": None})
            if all(row[key] is not None for key in ("open", "high", "low")):
                require(row["low"] <= min(row["open"], row["price"]) <= max(row["open"], row["price"]) <= row["high"],
                        "报价开高低与price关系无效")
            for key in ("open", "price"):
                if row[key] is not None:
                    if row["low"] is not None:
                        require(row["low"] <= row[key], key + "不能低于已提供low")
                    if row["high"] is not None:
                        require(row[key] <= row["high"], key + "不能高于已提供high")
            row["is_realtime"] = False
            row["snapshot_kind"] = "provided_records"
        elif operation == "normalize_positions":
            require(row["available_quantity"] <= row["quantity"], "可用数量不能超过持仓数量")
            require(row["average_cost"] is not None if row["quantity"] else row["average_cost"] is None,
                    "有持仓须有正成本；零持仓成本须为null")
        else:
            require(row["side"] in ("buy", "sell"), "side须为buy/sell")
            require(row["quantity"] > 0, "委托数量须大于0")
            require(row["filled_quantity"] <= row["quantity"], "成交数量不能超过委托数量")
            if "status_map" in p:
                require(row["status"] in p["status_map"], "原状态未在status_map显式映射")
                row["status"] = p["status_map"][row["status"]]
            require(row["status"] in ("pending", "partially_filled", "filled", "cancelled", "rejected", "unknown"), "委托状态须为规范状态或显式映射")
            if row["status"] == "filled":
                require(row["filled_quantity"] == row["quantity"], "filled状态须显式全量成交")
            elif row["status"] == "partially_filled":
                require(0 < row["filled_quantity"] < row["quantity"], "partially_filled数量矛盾")
            elif row["status"] in ("pending", "rejected"):
                require(row["filled_quantity"] == 0, "pending/rejected状态不得含已成交数量")
        row["snapshot_at"] = metadata["snapshot_at"]
        output.append(row)
    return {"metadata": metadata, "rows": output, "diagnostics": diagnostics,
            "method": {"conversion": operation, "key_is_id": p["key_is_id"],
                       "execution_or_account_connection": False, "input_status_is_not_external_verification": True}}


def _filter_rows(request):
    p, data = request["params"], request["data"]
    exact_keys(p, ("combine", "conditions"), label="params")
    require(p["combine"] in ("all", "any"), "combine须为all/any（与/或）")
    require(isinstance(p["conditions"], list) and bool(p["conditions"]), "conditions须为非空数组")
    exact_keys(data, ("metadata", "records"), label="data")
    exact_keys(data["metadata"], ("dataset_id",), label="metadata")
    _text(data["metadata"]["dataset_id"], "metadata.dataset_id")
    require(isinstance(data["records"], list), "records须为记录数组")
    for condition in p["conditions"]:
        exact_keys(condition, ("field", "operator", "value"), label="condition")
        _text(condition["field"], "condition.field")
        require(condition["operator"] in ("eq", "ne", "gt", "ge", "lt", "le"), "比较符无效")
        if type(condition["value"]) in (int, float):
            number(condition["value"], "condition.value")
        else:
            _text(condition["value"], "condition.value")
            require(condition["operator"] in ("eq", "ne"), "文本只支持eq/ne")
    matched, unknown, evaluations, missing_fields = [], [], [], set()
    compare = {"eq": lambda a, b: a == b, "ne": lambda a, b: a != b,
               "gt": lambda a, b: a > b, "ge": lambda a, b: a >= b,
               "lt": lambda a, b: a < b, "le": lambda a, b: a <= b}
    for index, row in enumerate(data["records"]):
        require(isinstance(row, dict), "筛选记录须为对象")
        values, details = [], []
        for condition in p["conditions"]:
            field, expected = condition["field"], condition["value"]
            value = row.get(field)
            reason = None
            if value is None:
                result, reason = None, "missing_or_null"
                missing_fields.add(field)
            elif (type(expected) in (int, float) and type(value) not in (int, float)) or (isinstance(expected, str) and not isinstance(value, str)):
                result, reason = None, "incompatible_type"
            else:
                if type(value) in (int, float):
                    number(value, "record." + field)
                result = compare[condition["operator"]](value, expected)
            values.append(result)
            details.append({"field": field, "result": result, "reason": reason})
        if p["combine"] == "all":
            result = False if False in values else None if None in values else True
        else:
            result = True if True in values else None if None in values else False
        if result is True:
            matched.append(deepcopy(row))
        elif result is None:
            unknown.append(deepcopy(row))
        evaluations.append({"index": index, "result": result, "conditions": details})
    return {"metadata": deepcopy(data["metadata"]), "rows": matched, "unknown_rows": unknown,
            "evaluations": evaluations,
            "diagnostics": [{"code": "missing_comparison_field", "field": field} for field in sorted(missing_fields)],
            "method": {"comparison": "explicit_fields_only", "combine": p["combine"],
                       "missing_semantics": "three_valued_unknown", "text_or_formula_evaluation": False}}


def run(request):
    operation = request.get("operation")
    require(operation in OPERATIONS, "未知data操作")
    require("state" not in request, "data操作不接受state")
    functions = {"normalize_bars": _normalize_bars, "daily_snapshot": _daily_snapshot,
                 "replay_daily": _replay_daily, "filter_rows": _filter_rows}
    result = functions[operation](request) if operation in functions else _normalize_table(request, operation)
    result["execution_executed"] = False
    json.dumps(result, ensure_ascii=False, allow_nan=False)
    return result
