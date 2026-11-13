"""Fixed MACD for supplied daily observations."""
import math

from _common import exact_keys, require, validate_bars
from operators import combine, next_state, smooth


def run(request):
    params = request["params"]
    require(request["operation"] == "MACD", "unsupported indicator")
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
