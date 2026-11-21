"""Registered indicators over supplied daily observations."""
import math
import sys

from _common import exact_keys, require, validate_bars
from operators import combine, next_state, rolling_windows, smooth, standard_deviation


def macd(request):
    params = request["params"]
    exact_keys(params, ("short_period", "long_period", "signal_period", "init"), label="params")
    require(all(type(params[name]) is int and params[name] == value for name, value in
                (("short_period", 12), ("long_period", 26), ("signal_period", 9)))
            and params["init"] == "first_valid" and "state" not in request,
            "MACD requires fixed 12/26/9 and explicit first_valid initialization")
    metadata, rows = validate_bars(request["data"])
    close = [row["close"] for row in rows]
    count, diagnostics = len(rows), []
    s, l, m = params["short_period"], params["long_period"], params["signal_period"]
    normalized = {"short_period": s, "long_period": l, "signal_period": m}
    short = smooth(close, 2 / (s + 1))
    long = smooth(close, 2 / (l + 1))
    diff = combine(lambda a, b: a - b, short, long)
    dea = smooth(diff, 2 / (m + 1))
    outputs = {"DIFF": diff, "DEA": dea, "MACD": combine(lambda a, b: 2 * (a - b), diff, dea), "ZERO": [0.0] * count}
    state = next_state(request, metadata, rows, normalized, {"ema_short": short[-1], "ema_long": long[-1], "dea": dea[-1]})
    definitions = {"DIFF": "EMA(close,short)-EMA(close,long)", "DEA": "EMA(DIFF,signal)", "MACD": "2*(DIFF-DEA)", "ZERO": "0"}
    for key, values in outputs.items():
        require(len(values) == count, "indicator output length mismatch")
        for i, value in enumerate(values):
            require(value is None or math.isfinite(value), "non-finite indicator result")
            if value is None:
                diagnostics.append({"timestamp": rows[i]["timestamp"], "output": key, "reason": "missing_history_window_or_undefined_input"})
    method = {"parameters": normalized, "definitions": definitions,
              "window_policy": "complete supplied daily observations; no padding, sorting or adjustment",
              "undefined_policy": "null plus diagnostics; zero denominator is never replaced",
              "units": "price units unless percentage or separately declared",
              "initialization": "first_valid",
              "recursive_missing_policy": "leading null delays seed; later null invalidates recurrence"}
    result = {"rows": [{"timestamp": row["timestamp"], **{key: values[i] for key, values in outputs.items()}} for i, row in enumerate(rows)], "diagnostics": diagnostics, "method": method}
    if state is not None:
        result["state"] = state
    return result


WARMUP = "insufficient_warmup"
ZERO_DENOMINATOR = "undefined_zero_denominator"


def ma(close, params, rows):
    period = params["period"]
    return {"MA": [math.fsum(window) / period if window is not None else WARMUP
                   for window in rolling_windows(close, period)]}


def ema(close, params, rows):
    return {"EMA": smooth(close, 2 / (params["period"] + 1))}


def rsi(close, params, rows):
    period = params["period"]
    values = [WARMUP] * min(len(close), period)
    # Keep Wilder's running values on the period-sum scale, as in the TS reference.
    gain, loss = 0.0, 0.0
    decay = 1 - 1 / period
    for index in range(1, len(close)):
        change = float(close[index]) - float(close[index - 1])
        if index > period:
            gain *= decay
            loss *= decay
        gain += max(change, 0)
        loss += max(-change, 0)
        if index >= period:
            total = gain + loss
            values.append(100 * (gain / total) if total != 0 else "undefined_flat_rsi")
    return {"RSI": values}


def boll(close, params, rows):
    period, width = params["period"], params["std_dev"]
    mid, upper, lower = [], [], []
    for window in rolling_windows(close, period):
        if window is None:
            mid.append(WARMUP)
            upper.append(WARMUP)
            lower.append(WARMUP)
            continue
        mean = math.fsum(window) / period
        offset = width * standard_deviation(window, mean, ddof=0)
        mid.append(mean)
        upper.append(mean + offset)
        lower.append(mean - offset)
    return {"BOLL_MID": mid, "BOLL_UPPER": upper, "BOLL_LOWER": lower}


def lagged_returns(close, period, mode):
    values = [WARMUP] * min(len(close), period)
    for previous, current in zip(close, close[period:]):
        if mode == "log":
            value = (math.log(current) - math.log(previous) if current > 0 and previous > 0
                     else "undefined_nonpositive_log_price")
        elif previous == 0:
            value = ZERO_DENOMINATOR
        else:
            change = (current - previous) / previous
            value = 100 * change if mode == "percent" else change
        values.append(value)
    return values


def roc(close, params, rows):
    return {"ROC": lagged_returns(close, params["period"], "percent")}


def obv(close, params, rows):
    values = [0.0]
    for index in range(1, len(close)):
        direction = int(close[index] > close[index - 1]) - int(close[index] < close[index - 1])
        values.append(values[-1] + direction * rows[index]["volume"])
    return {"OBV": values}


def returns(close, params, rows):
    return {"RETURN": lagged_returns(close, params["period"], params["mode"])}


def volatility(close, params, rows):
    period = params["period"]
    scale = math.sqrt(params["annualization_factor"]) if "annualization_factor" in params else 1
    daily_returns = lagged_returns(close, 1, "simple")[1:]
    values = [WARMUP]
    for window in rolling_windows(daily_returns, period):
        if window is None:
            values.append(WARMUP)
        elif ZERO_DENOMINATOR in window:
            values.append(ZERO_DENOMINATOR)
        else:
            mean = math.fsum(value / period for value in window)
            values.append(scale * standard_deviation(window, mean, ddof=1))
    return {"VOLATILITY": values}


def max_drawdown(close, params, rows):
    period = params.get("period")
    drawdowns, peaks = [], []
    for end in range(1, len(close) + 1):
        if period is not None and end < period:
            drawdowns.append(WARMUP)
            peaks.append(WARMUP)
            continue
        window = close[0 if period is None else end - period:end]
        peak, drawdown = window[0], 0.0
        for current in window:
            peak = max(peak, current)
            drawdown = min(drawdown, current / peak - 1)
        drawdowns.append(drawdown)
        peaks.append(peak)
    return {"MAX_DRAWDOWN": drawdowns, "PEAK_CLOSE": peaks}


def alpha191_014(close, params, rows):
    return {"ALPHA191_014": [WARMUP] * min(5, len(close))
            + [current - previous for previous, current in zip(close, close[5:])]}


def nonnegative_mean(values):
    scale = max(values)
    return (math.fsum(value / scale for value in values) / len(values)) * scale if scale else 0.0


def alpha191_031(close, params, rows):
    values = []
    for window in rolling_windows(close, 12):
        if window is None:
            values.append(WARMUP)
            continue
        scale = max(window)
        if not scale:
            values.append(ZERO_DENOMINATOR)
            continue
        scaled_total = math.fsum(price / scale for price in window)
        # (last - mean) / mean on the scaled window, cancelling the common window length.
        values.append(100 * (len(window) * (window[-1] / scale) - scaled_total) / scaled_total)
    return {"ALPHA191_031": values}


def alpha191_116(close, params, rows):
    values = []
    for window in rolling_windows(close, 20):
        if window is None:
            values.append(WARMUP)
            continue
        # Opposite observation weights cancel equal endpoints before combining smaller differences.
        differences = [window[19 - k] - window[k] for k in range(10)]
        # The ten positive weights sum to 50. Scale first only when their numerator can overflow.
        if max(map(abs, differences)) >= sys.float_info.max / 50:
            slope = math.fsum(((9.5 - k) / 665) * delta for k, delta in enumerate(differences))
        else:
            slope = math.fsum((9.5 - k) * delta for k, delta in enumerate(differences)) / 665
        values.append(slope)
    return {"ALPHA191_116": values}


def alpha191_168(close, params, rows):
    values = []
    for window in rolling_windows([row["volume"] for row in rows], 20):
        if window is None:
            values.append(WARMUP)
            continue
        # Scaling cancels in the ratio, preserving tiny positive volume without overflowing its sum.
        scale = max(window)
        values.append(-(window[-1] / scale) / (math.fsum(value / scale for value in window) / 20)
                      if scale else ZERO_DENOMINATOR)
    return {"ALPHA191_168": values}


def alpha191_189(close, params, rows):
    deviations = [None if window is None else abs(window[-1] - nonnegative_mean(window))
                  for window in rolling_windows(close, 6)]
    return {"ALPHA191_189": [WARMUP if window is None or any(value is None for value in window)
                            else nonnegative_mean(window)
                            for window in rolling_windows(deviations, 6)]}


IMPLEMENTATIONS = {"MA": ma, "EMA": ema, "RSI": rsi, "BOLL": boll, "ROC": roc, "OBV": obv,
                   "RETURNS": returns, "VOLATILITY": volatility, "MAX_DRAWDOWN": max_drawdown,
                   "ALPHA191_014": alpha191_014, "ALPHA191_031": alpha191_031,
                   "ALPHA191_116": alpha191_116, "ALPHA191_168": alpha191_168,
                   "ALPHA191_189": alpha191_189}


def run(request):
    operation, params = request["operation"], request["params"]
    if operation == "MACD":
        return macd(request)
    require(operation in IMPLEMENTATIONS, "unsupported indicator")
    required = ("close", "volume") if operation in ("OBV", "ALPHA191_168") else ("close",)
    _, bars = validate_bars(request["data"], required=required,
                            allow_nonpositive_close=operation in ("ROC", "RETURNS", "VOLATILITY"))
    outputs = IMPLEMENTATIONS[operation]([bar["close"] for bar in bars], params, bars)
    rows, diagnostics = [], []
    for index, bar in enumerate(bars):
        timestamp = bar["timestamp"]
        row = {"timestamp": timestamp}
        for field, values in outputs.items():
            value = values[index]
            if isinstance(value, str):
                diagnostics.append({"timestamp": timestamp, "output": field, "reason": value})
                row[field] = None
            else:
                row[field] = value
        rows.append(row)
    return {"rows": rows, "diagnostics": diagnostics, "method": {"parameters": params}}
