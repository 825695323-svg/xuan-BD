"""Explicit daily-series operators. No formula parser or dynamic evaluation."""
import math
from copy import deepcopy
from datetime import date

from _common import exact_keys, integer, number, require, rolling, validate_bars


OPERATIONS = ("ABS", "MIN", "MAX", "IF", "REF", "MA", "EMA", "SMA", "SUM",
              "HHV", "LLV", "COUNT", "CROSS", "EVERY", "EXIST", "BARSLAST",
              "FILTER", "AVEDEV", "STD")


def combine(function, *sequences):
    return [None if any(x is None for x in values) else function(*values)
            for values in zip(*sequences)]


def ref(values, period=1, previous=None):
    if period == 0:
        return list(values)
    history = [None] * period if previous is None else list(previous)
    return (history + list(values))[:len(values)]


def smooth(values, period, weight, previous=None):
    """Seed first finite input if previous is None; missing observations emit null.

    A missing observation after initialization invalidates recurrence thereafter.
    Leading nulls do not constitute observations of the recurrence.
    """
    result = []
    started = previous is not None
    invalidated = False
    current = previous
    for value in values:
        if invalidated or (value is None and started):
            result.append(None)
            invalidated = True
        elif value is None:
            result.append(None)
        elif not started:
            current = value
            started = True
            result.append(current)
        else:
            current = current + weight * (value - current)
            result.append(current)
    return result


def cumulative(values, operation):
    result, observed = [], []
    invalidated = False
    for value in values:
        if value is None:
            if observed:
                invalidated = True
            result.append(None)
            continue
        observed.append(value)
        if invalidated:
            result.append(None)
        elif operation == "sum":
            result.append(math.fsum(observed))
        elif operation == "min":
            result.append(min(observed))
        else:
            result.append(max(observed))
    return result


def window(values, period, operation):
    return cumulative(values, operation) if period == 0 else rolling(values, period, operation)


def deviation(values, period, ddof=None):
    outputs = []
    for i in range(len(values)):
        part = values[max(0, i + 1 - period):i + 1]
        if len(part) != period or None in part:
            outputs.append(None)
            continue
        mean = math.fsum(part) / period
        if ddof is None:
            outputs.append(math.fsum(abs(x - mean) for x in part) / period)
        else:
            outputs.append(math.sqrt(math.fsum((x - mean) ** 2 for x in part) / (period - ddof)))
    return outputs


def truth(value):
    return None if value is None else bool(value)


def cross(left, right, previous_left=None, previous_right=None):
    a = ref(left, previous=[previous_left])
    b = ref(right, previous=[previous_right])
    return combine(lambda x, y, px, py: px <= py and x > y, left, right, a, b)


def barslast(values):
    result, last = [], None
    for i, value in enumerate(values):
        if value is None:
            last = None
            result.append(None)
        elif truth(value):
            last = i
            result.append(0)
        else:
            result.append(None if last is None else i - last)
    return result


def filtered(values, period):
    """Reset at the explicitly declared observation boundary, preserving unknowns."""
    result, possible_last = [], {None}
    for i, value in enumerate(values):
        outputs, next_last = set(), set()
        for last in possible_last:
            allowed = last is None or (period > 0 and i - last > period)
            if not allowed:
                outputs.add(False)
                next_last.add(last)
            elif value is None:
                outputs.update((False, True))
                next_last.update((last, i))
            elif truth(value):
                outputs.add(True)
                next_last.add(i)
            else:
                outputs.add(False)
                next_last.add(last)
        result.append(outputs.pop() if len(outputs) == 1 else None)
        possible_last = next_last
    return result


_BINDINGS = ("series_id", "frequency", "timezone", "price_unit", "adjustment", "adjustment_basis")


def bound_metadata(metadata):
    keys = list(_BINDINGS) + [key for key in ("volume_unit", "amount_unit", "field_units") if key in metadata]
    return {key: deepcopy(metadata[key]) for key in keys}


def recursive_state(request, metadata, rows, parameters, names, nonnegative=()):
    """Validate explicit research initialization or a bound prior state."""
    params = request["params"]
    if "state" not in request:
        require(params.get("init") == "first_valid", "recursive calculation requires init='first_valid' or explicit state")
        return {name: None for name in names}
    require("init" not in params, "init and state are mutually exclusive")
    state = request["state"]
    exact_keys(state, ("operation", "parameters", "metadata", "previous_timestamp", "is_immediately_prior", "values"), label="state")
    require(state["operation"] == request["operation"], "state operation must match request")
    require(state["parameters"] == parameters, "state parameters must match calculation")
    bindings = bound_metadata(metadata)
    exact_keys(state["metadata"], bindings, label="state.metadata")
    require(state["metadata"] == bindings, "state metadata must match input series, units and adjustment")
    require(state["is_immediately_prior"] is True, "state must attest the immediately prior observation")
    stamp = state["previous_timestamp"]
    require(isinstance(stamp, str), "state.previous_timestamp must be YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(stamp)
    except ValueError as exc:
        raise ValueError("state.previous_timestamp must be YYYY-MM-DD") from exc
    require(parsed.isoformat() == stamp and stamp < rows[0]["timestamp"], "state timestamp must precede the input window")
    exact_keys(state["values"], names, label="state.values")
    return {key: number(state["values"][key], "state.values." + key, nonnegative=key in nonnegative) for key in names}


def next_state(request, metadata, rows, parameters, values):
    if any(value is None for value in values.values()):
        return None
    return {"operation": request["operation"], "parameters": parameters,
            "metadata": bound_metadata(metadata),
            "previous_timestamp": rows[-1]["timestamp"], "is_immediately_prior": True,
            "values": values}


def _column(rows, field, label):
    require(isinstance(field, str) and bool(field), label + " must name a column")
    result = []
    for i, row in enumerate(rows):
        require(field in row, label + " missing at row " + str(i))
        value = row[field]
        if value is None or type(value) is bool:
            result.append(value)
        else:
            result.append(number(value, label + " row " + str(i)))
    return result


def _operand(params, rows, prefix):
    field, value = prefix + "_field", prefix + "_value"
    require((field in params) != (value in params), "supply exactly one of " + field + " or " + value)
    if field in params:
        return _column(rows, params[field], field)
    item = params[value]
    if item is not None and type(item) is not bool:
        item = number(item, value)
    return [item] * len(rows)


def run(request):
    operation, params = request["operation"], request["params"]
    require(operation in OPERATIONS, "unsupported operator")
    require(isinstance(params, dict), "params must be an object")
    metadata, rows = validate_bars(request["data"], required=("close",))
    options = {"field"}
    if operation in ("MIN", "MAX", "CROSS"):
        options.update(("other_field", "other_value"))
    if operation == "IF":
        options.update(("true_field", "true_value", "false_field", "false_value"))
    if operation in ("REF", "MA", "EMA", "SMA", "SUM", "HHV", "LLV", "COUNT", "EVERY", "EXIST", "FILTER", "AVEDEV", "STD"):
        options.add("period")
    if operation in ("EMA", "SMA"):
        options.add("init")
    if operation == "SMA":
        options.add("weight")
    if operation == "STD":
        options.add("ddof")
    if operation == "CROSS":
        options.update(("previous_left", "previous_right"))
    if operation in ("FILTER", "SUM", "HHV", "LLV", "COUNT"):
        options.add("start")
    exact_keys(params, (), options, label="params")
    require("state" not in request or operation in ("EMA", "SMA"), "state is supported only for recursive averages")
    values = _column(rows, params.get("field", "close"), "field")
    logical = operation in ("IF", "COUNT", "EVERY", "EXIST", "BARSLAST", "FILTER")
    if not logical:
        require(all(value is None or type(value) is not bool for value in values), "numeric operator does not accept boolean values")
    period = None
    if "period" in options:
        require("period" in params, "params.period is required")
        period = integer(params["period"], "period", min_value=0 if operation in ("REF", "SUM", "HHV", "LLV", "COUNT", "FILTER") else 1)
    if "start" in params:
        require(params["start"] == "observation_start", "start must be observation_start")
    if operation == "FILTER" or (operation in ("SUM", "HHV", "LLV", "COUNT") and period == 0):
        require(params.get("start") == "observation_start", "cumulative/filter operator requires start='observation_start'")
    diagnostics, output_state = [], None
    if operation == "ABS":
        output = combine(abs, values)
    elif operation in ("MIN", "MAX"):
        other = _operand(params, rows, "other")
        require(all(value is None or type(value) is not bool for value in other), "numeric operator does not accept boolean operands")
        output = combine(min if operation == "MIN" else max, values, other)
    elif operation == "IF":
        yes, no = _operand(params, rows, "true"), _operand(params, rows, "false")
        output = [None if x is None else (a if truth(x) else b) for x, a, b in zip(values, yes, no)]
    elif operation == "REF":
        output = ref(values, period)
    elif operation == "MA":
        output = rolling(values, period, "mean")
    elif operation in ("EMA", "SMA"):
        weight = 2 / (period + 1) if operation == "EMA" else integer(params.get("weight"), "weight", min_value=1)
        if operation == "SMA":
            require(period > weight, "SMA requires period > weight > 0")
            weight /= period
        parameters = {"period": period, "field": params.get("field", "close")}
        if operation == "SMA":
            parameters["weight"] = params["weight"]
        prior = recursive_state(request, metadata, rows, parameters, ("previous",))
        output = smooth(values, period, weight, prior["previous"])
        output_state = next_state(request, metadata, rows, parameters, {"previous": output[-1]})
    elif operation in ("SUM", "HHV", "LLV"):
        output = window(values, period, {"SUM": "sum", "HHV": "max", "LLV": "min"}[operation])
    elif operation in ("COUNT", "EVERY", "EXIST"):
        counts = window([None if x is None else int(truth(x)) for x in values], period, "sum")
        if operation == "COUNT":
            output = counts
        else:
            output = [None if x is None else (x == period if operation == "EVERY" else x > 0) for x in counts]
    elif operation == "CROSS":
        other = _operand(params, rows, "other")
        require(all(value is None or type(value) is not bool for value in other), "CROSS requires numeric operands")
        require(("previous_left" in params) == ("previous_right" in params), "CROSS previous values must be supplied together")
        left = number(params["previous_left"], "previous_left") if "previous_left" in params else None
        right = number(params["previous_right"], "previous_right") if "previous_right" in params else None
        output = cross(values, other, left, right)
    elif operation == "BARSLAST":
        output = barslast(values)
    elif operation == "FILTER":
        output = filtered(values, period)
    else:
        ddof = None
        if operation == "STD":
            require("ddof" in params, "STD requires explicit ddof=0 or ddof=1")
            ddof = integer(params["ddof"], "ddof", min_value=0, max_value=1)
            require(period > ddof, "STD requires period > ddof")
        output = deviation(values, period, ddof)
    for i, value in enumerate(output):
        require(value is None or type(value) is bool or math.isfinite(value), "non-finite operator result")
        if value is None:
            diagnostics.append({"timestamp": rows[i]["timestamp"], "output": operation, "reason": "missing_history_window_or_input"})
    method = {"operation": operation, "field": params.get("field", "close"),
              "window_policy": "full supplied observations; null is never zero",
              "logical_policy": "boolean or numeric nonzero; unknown yields null",
              "recursive_missing_policy": "leading null delays seed; later null invalidates recurrence",
              "incremental_scope": "only EMA/SMA support bound prior state"}
    if operation in ("EMA", "SMA"):
        method["initialization"] = "explicit_state" if "state" in request else "first_valid"
    if operation == "STD":
        method["ddof"] = params["ddof"]
    if "start" in params:
        method["start"] = params["start"]
    result = {"rows": [{"timestamp": row["timestamp"], operation: output[i]} for i, row in enumerate(rows)], "diagnostics": diagnostics, "method": method}
    if output_state is not None:
        result["state"] = output_state
    return result
