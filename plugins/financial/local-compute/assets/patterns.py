"""Daily bar pattern and reference-level calculations using the standard library."""

import math

from _common import columns, exact_keys, integer, number, require, rolling, validate_bars


PATTERN_IDS = (
    "morning_star", "evening_star", "hammer", "bullish_engulfing",
    "three_rising_bullish", "three_falling_bearish", "gap_up", "gap_down",
    "volume_breakout", "ma_bullish_alignment", "ma_bearish_alignment",
    "macd_cross_up", "macd_cross_down", "long_upper_shadow",
    "return_up_threshold", "return_down_threshold",
)
LEVEL_IDS = (
    "previous_high", "previous_low", "previous_close", "highest_high_20",
    "lowest_low_20", "highest_high_60", "lowest_low_60", "pivot",
    "bollinger_upper", "bollinger_lower", "latest_up_gap_previous_high",
    "latest_down_gap_previous_low", "close_volume_mean",
)

_REQUIRED = {
    "morning_star": ("open", "close"),
    "evening_star": ("open", "close"),
    "hammer": ("open", "high", "low", "close"),
    "bullish_engulfing": ("open", "close"),
    "three_rising_bullish": ("open", "close"),
    "three_falling_bearish": ("open", "close"),
    "gap_up": ("high", "low", "close"),
    "gap_down": ("high", "low", "close"),
    "volume_breakout": ("volume", "close"),
    "ma_bullish_alignment": ("close",),
    "ma_bearish_alignment": ("close",),
    "macd_cross_up": ("close",),
    "macd_cross_down": ("close",),
    "long_upper_shadow": ("open", "high", "low", "close"),
    "return_up_threshold": ("close",),
    "return_down_threshold": ("close",),
    "previous_high": ("high", "close"),
    "previous_low": ("low", "close"),
    "previous_close": ("close",),
    "highest_high_20": ("high", "close"),
    "lowest_low_20": ("low", "close"),
    "highest_high_60": ("high", "close"),
    "lowest_low_60": ("low", "close"),
    "pivot": ("high", "low", "close"),
    "bollinger_upper": ("close",),
    "bollinger_lower": ("close",),
    "latest_up_gap_previous_high": ("high", "low", "close"),
    "latest_down_gap_previous_low": ("high", "low", "close"),
    "close_volume_mean": ("volume", "close"),
}


def _params(operation, params):
    required = {
        "morning_star": ("body_window", "small_body_ratio"),
        "evening_star": ("body_window", "small_body_ratio"),
        "hammer": ("recent_window", "lower_body_ratio", "upper_body_ratio"),
        "volume_breakout": ("volume_window", "volume_multiplier", "price_window"),
        "ma_bullish_alignment": ("windows",),
        "ma_bearish_alignment": ("windows",),
        "macd_cross_up": ("fast_window", "slow_window", "signal_window", "init"),
        "macd_cross_down": ("fast_window", "slow_window", "signal_window", "init"),
        "long_upper_shadow": ("body_multiplier",),
        "return_up_threshold": ("threshold_pct",),
        "return_down_threshold": ("threshold_pct",),
        "bollinger_upper": ("window", "multiplier", "ddof"),
        "bollinger_lower": ("window", "multiplier", "ddof"),
        "close_volume_mean": ("window",),
    }.get(operation, ())
    exact_keys(params, required, label="params." + operation)
    cleaned = dict(params)
    for key in ("body_window", "recent_window", "volume_window", "price_window",
                "fast_window", "slow_window", "signal_window", "window"):
        if key in params:
            cleaned[key] = integer(params[key], "params." + key)
    for key in ("small_body_ratio", "lower_body_ratio", "upper_body_ratio",
                "volume_multiplier", "body_multiplier", "multiplier"):
        if key in params:
            cleaned[key] = number(params[key], "params." + key, positive=True)
    if "threshold_pct" in params:
        cleaned["threshold_pct"] = number(params["threshold_pct"], "params.threshold_pct", nonnegative=True)
    if "windows" in params:
        require(isinstance(params["windows"], list) and len(params["windows"]) == 4,
                "params.windows must contain four strictly increasing positive integers")
        cleaned["windows"] = [integer(value, "params.windows") for value in params["windows"]]
        require(all(a < b for a, b in zip(cleaned["windows"], cleaned["windows"][1:])),
                "params.windows must be strictly increasing")
    if "init" in params:
        require(params["init"] == "first_valid", "params.init must be 'first_valid'")
        require(cleaned["fast_window"] < cleaned["slow_window"],
                "params.fast_window must be smaller than params.slow_window")
    if "ddof" in params:
        cleaned["ddof"] = integer(params["ddof"], "params.ddof", min_value=0, max_value=1)
        require(cleaned["window"] > cleaned["ddof"], "params.window must exceed params.ddof")
    return cleaned


def _ema(values, window):
    """Seed each contiguous valid run at its first observation."""
    alpha = 2.0 / (window + 1)
    result = []
    previous = None
    for value in values:
        if value is None:
            previous = None
        elif previous is None:
            previous = value
        else:
            previous = previous + alpha * (value - previous)
        result.append(previous)
    return result


def _pattern(operation, params, rows):
    close, = columns(rows, ("close",))
    size = len(rows)
    values = [None] * size
    method = {"params": params, "output_fields": [operation]}

    if operation in ("morning_star", "evening_star"):
        opening, = columns(rows, ("open",))
        body = [abs(c - o) for c, o in zip(close, opening)]
        average = rolling(body, params["body_window"], "mean")
        upward = operation == "morning_star"
        for i in range(2, size):
            if average[i] is None:
                continue
            if upward:
                first = close[i - 2] < opening[i - 2]
                third = close[i] > opening[i] and close[i] > (opening[i - 2] + close[i - 2]) / 2
            else:
                first = close[i - 2] > opening[i - 2]
                third = close[i] < opening[i] and close[i] < (opening[i - 2] + close[i - 2]) / 2
            values[i] = (first and body[i - 2] > average[i]
                         and body[i - 1] < average[i] * params["small_body_ratio"] and third)
        method.update(body_average_anchor="current_observation", history=2)
    elif operation == "hammer":
        opening, high, low = columns(rows, ("open", "high", "low"))
        recent = rolling(low, params["recent_window"], "min")
        for i in range(size):
            if recent[i] is None:
                continue
            body = abs(close[i] - opening[i])
            values[i] = (high[i] > low[i]
                         and min(opening[i], close[i]) - low[i] > body * params["lower_body_ratio"]
                         and high[i] - max(opening[i], close[i]) < body * params["upper_body_ratio"]
                         and low[i] <= recent[i])
        method["recent_window_includes_current"] = True
    elif operation == "bullish_engulfing":
        opening, = columns(rows, ("open",))
        for i in range(1, size):
            values[i] = (close[i - 1] < opening[i - 1] and close[i] > opening[i]
                         and opening[i] < close[i - 1] and close[i] > opening[i - 1])
        method["history"] = 1
    elif operation in ("three_rising_bullish", "three_falling_bearish"):
        opening, = columns(rows, ("open",))
        upward = operation == "three_rising_bullish"
        for i in range(2, size):
            if upward:
                values[i] = all(close[j] > opening[j] for j in range(i - 2, i + 1)) and close[i] > close[i - 1] > close[i - 2]
            else:
                values[i] = all(close[j] < opening[j] for j in range(i - 2, i + 1)) and close[i] < close[i - 1] < close[i - 2]
        method["history"] = 2
    elif operation in ("gap_up", "gap_down"):
        high, low = columns(rows, ("high", "low"))
        for i in range(1, size):
            values[i] = low[i] > high[i - 1] if operation == "gap_up" else high[i] < low[i - 1]
        method.update(history=1, condition="current_bar_vs_previous_bar", tracks_later_fills=False)
    elif operation == "volume_breakout":
        volume, = columns(rows, ("volume",))
        volume_mean = rolling(volume, params["volume_window"], "mean")
        highest = rolling(close, params["price_window"], "max")
        for i in range(size):
            if volume_mean[i] is not None and highest[i] is not None:
                values[i] = volume[i] > volume_mean[i] * params["volume_multiplier"] and close[i] >= highest[i]
        method["windows_include_current"] = True
    elif operation in ("ma_bullish_alignment", "ma_bearish_alignment"):
        means = [rolling(close, window, "mean") for window in params["windows"]]
        upward = operation == "ma_bullish_alignment"
        for i in range(size):
            levels = [series[i] for series in means]
            if any(value is None for value in levels):
                continue
            values[i] = (all(a > b for a, b in zip(levels, levels[1:])) if upward
                         else all(a < b for a, b in zip(levels, levels[1:])))
        method["windows_include_current"] = True
    elif operation in ("macd_cross_up", "macd_cross_down"):
        fast = _ema(close, params["fast_window"])
        slow = _ema(close, params["slow_window"])
        difference = [a - b if a is not None and b is not None else None for a, b in zip(fast, slow)]
        signal = _ema(difference, params["signal_window"])
        upward = operation == "macd_cross_up"
        for i in range(1, size):
            if any(value is None for value in (difference[i], signal[i], difference[i - 1], signal[i - 1])):
                continue
            if upward:
                values[i] = difference[i] > signal[i] and difference[i - 1] <= signal[i - 1]
            else:
                values[i] = difference[i] < signal[i] and difference[i - 1] >= signal[i - 1]
        method.update(ema_alpha="2 / (window + 1)", ema_seed="first valid value", history=1,
                      scope="supplied_series_only", preceding_state_available=False)
    elif operation == "long_upper_shadow":
        opening, high, low = columns(rows, ("open", "high", "low"))
        values = [h > l and h - max(o, c) > abs(c - o) * params["body_multiplier"]
                  for o, h, l, c in zip(opening, high, low, close)]
    elif operation in ("return_up_threshold", "return_down_threshold"):
        upward = operation == "return_up_threshold"
        for i in range(1, size):
            change = (close[i] - close[i - 1]) / close[i - 1] * 100
            values[i] = change >= params["threshold_pct"] if upward else -change >= params["threshold_pct"]
        method.update(history=1, threshold_unit="percentage_points", exchange_limit_identification=False)
    else:
        raise ValueError("unsupported pattern operation")
    return {operation: values}, method, []


def _level(operation, params, rows):
    close, = columns(rows, ("close",))
    size = len(rows)
    values = [None] * size
    method = {"params": params, "output_fields": [operation]}
    diagnostics = []

    if operation in ("previous_high", "previous_low", "previous_close"):
        field = operation.removeprefix("previous_")
        source, = columns(rows, (field,))
        values = [None] + source[:-1] if size else []
        method["lag"] = 1
    elif operation in ("highest_high_20", "lowest_low_20", "highest_high_60", "lowest_low_60"):
        high = operation.startswith("highest")
        field = "high" if high else "low"
        window = 20 if operation.endswith("20") else 60
        source, = columns(rows, (field,))
        values = rolling(source, window, "max" if high else "min")
        method.update(window=window, window_includes_current=True)
    elif operation == "pivot":
        high, low = columns(rows, ("high", "low"))
        fields = {key: [None] * size for key in ("pivot", "pivot_r1", "pivot_s1", "pivot_r2", "pivot_s2")}
        for i in range(1, size):
            p = (high[i - 1] + low[i - 1] + close[i - 1]) / 3
            fields["pivot"][i] = p
            fields["pivot_r1"][i] = 2 * p - low[i - 1]
            fields["pivot_s1"][i] = 2 * p - high[i - 1]
            fields["pivot_r2"][i] = p + high[i - 1] - low[i - 1]
            fields["pivot_s2"][i] = p - high[i - 1] + low[i - 1]
        method.update(lag=1, output_fields=list(fields))
        return fields, method, diagnostics
    elif operation in ("bollinger_upper", "bollinger_lower"):
        window = params["window"]
        means = rolling(close, window, "mean")
        for i in range(window - 1, size):
            sample = close[i - window + 1:i + 1]
            variance = math.fsum((value - means[i]) ** 2 for value in sample) / (window - params["ddof"])
            distance = params["multiplier"] * math.sqrt(variance)
            values[i] = means[i] + distance if operation == "bollinger_upper" else means[i] - distance
        method.update(window_includes_current=True, variance_denominator="window - ddof")
    elif operation in ("latest_up_gap_previous_high", "latest_down_gap_previous_low"):
        high, low = columns(rows, ("high", "low"))
        upward = operation == "latest_up_gap_previous_high"
        latest = None
        for i in range(1, size):
            if (low[i] > high[i - 1]) if upward else (high[i] < low[i - 1]):
                latest = high[i - 1] if upward else low[i - 1]
            values[i] = latest
        method.update(event_lookback="entire_supplied_series", event_occurrence="latest",
                      value_field="previous_high" if upward else "previous_low",
                      tracks_later_fills=False, preceding_event_available=False)
    elif operation == "close_volume_mean":
        volume, = columns(rows, ("volume",))
        weighted = [c * v for c, v in zip(close, volume)]
        numerator = rolling(weighted, params["window"], "sum")
        denominator = rolling(volume, params["window"], "sum")
        zeros = []
        for i in range(size):
            if denominator[i] is None:
                continue
            if denominator[i] == 0:
                zeros.append(rows[i]["timestamp"])
            else:
                values[i] = numerator[i] / denominator[i]
        if zeros:
            diagnostics.append({"code": "zero_volume_window", "field": operation,
                                "count": len(zeros), "timestamps": zeros})
        method.update(formula="SUM(close * volume, window) / SUM(volume, window)",
                      window_includes_current=True, uses_amount=False, price_unit="input_price_unit")
    else:
        raise ValueError("unsupported level operation")
    return {operation: values}, method, diagnostics


def run(request):
    """Return local values for one operation or all operations of a kind."""
    require("state" not in request, "pattern and level operations do not accept state")
    kind = request.get("kind")
    require(kind in ("pattern", "level"), "kind must be 'pattern' or 'level'")
    operations = PATTERN_IDS if kind == "pattern" else LEVEL_IDS
    operation = request.get("operation")
    require(operation == "all" or operation in operations, "unsupported " + kind + " operation")
    selected = operations if operation == "all" else (operation,)
    if operation == "all":
        exact_keys(request.get("params"), selected, label="params")
        parameters = {key: _params(key, request["params"][key]) for key in selected}
    else:
        parameters = {operation: _params(operation, request.get("params"))}
    required = tuple(dict.fromkeys(field for key in selected for field in _REQUIRED[key]))
    _, rows = validate_bars(request.get("data"), required=required)
    result_rows = [{"timestamp": row["timestamp"]} for row in rows]
    methods = {}
    diagnostics = []
    calculate = _pattern if kind == "pattern" else _level
    for key in selected:
        try:
            fields, method, notices = calculate(key, parameters[key], rows)
        except (OverflowError, ZeroDivisionError) as exc:
            raise ValueError("calculation exceeds finite numeric range in " + key) from exc
        methods[key] = method
        diagnostics.extend(notices)
        for name, series in fields.items():
            missing = sum(value is None for value in series)
            if missing:
                diagnostics.append({"code": "unavailable_values", "field": name, "count": missing,
                                    "meaning": "required history, full window, prior event, or nonzero denominator is unavailable"})
            for row, value in zip(result_rows, series):
                require(value is None or isinstance(value, bool) or math.isfinite(value),
                        "calculation produced a non-finite value in " + name)
                row[name] = value
    return {"rows": result_rows, "diagnostics": diagnostics,
            "method": {"operations": methods, "frequency": "1d",
                       "rolling_initialization": "full_window", "window_includes_current": True,
                       "missing_value": None, "missing_is_false": False,
                       "sorting_or_imputation": False}}
