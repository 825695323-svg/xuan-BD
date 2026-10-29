"""Finite, explicitly initialized daily technical calculations."""
import math

from _common import exact_keys, integer, number, require, rolling, validate_bars
from operators import combine, deviation, next_state, recursive_state, ref, smooth


OPERATIONS = ("MA", "BBI", "BIAS", "MTM", "ROC", "MACD", "RSI", "EMA", "SMA",
              "TRIX", "KDJ", "BOLL", "ATR", "OBV", "CCI", "PSY", "ARBR", "MFI",
              "DMI", "EMV", "EXPMA", "CDP")


def _period(params, key, default=None, minimum=1):
    require(key in params or default is not None, "params." + key + " is required")
    return integer(params.get(key, default), key, min_value=minimum)


def _periods(params, default, length, minimum=1):
    values = params.get("periods", default)
    require(isinstance(values, list) and len(values) == length, "periods must contain exactly " + str(length) + " integers")
    return [integer(x, "periods", min_value=minimum) for x in values]


def _prior(params, key):
    return number(params[key], key, positive=True) if key in params else None


def _tr(high, low, close, previous_close):
    return combine(lambda h, l, p: max(h - l, abs(h - p), abs(l - p)),
                   high, low, ref(close, previous=[previous_close]))


def run(request):
    operation, params = request["operation"], request["params"]
    require(operation in OPERATIONS, "unsupported indicator")
    require(isinstance(params, dict), "params must be an object")
    allowed = {
        "MA": ("period",), "BBI": ("periods",), "BIAS": ("periods", "lower", "upper"),
        "MTM": ("period", "average_period"), "ROC": ("period", "average_period"),
        "MACD": ("short_period", "long_period", "signal_period", "init"),
        "RSI": ("periods", "init", "previous_close"), "EMA": ("period", "init"),
        "SMA": ("period", "weight", "init"), "TRIX": ("period", "average_period", "init"),
        "KDJ": ("period", "k_period", "d_period", "init"), "BOLL": ("period", "width", "ddof"),
        "ATR": ("period", "previous_close"),
        "OBV": ("average_period", "start", "initial_obv", "previous_close"),
        "CCI": ("period",), "PSY": ("period", "previous_close"),
        "ARBR": ("period", "lower", "upper", "previous_close"),
        "MFI": ("period", "previous_typical_price"),
        "DMI": ("period", "average_period", "previous_close", "previous_high", "previous_low"),
        "EMV": ("period", "average_period", "previous_high_low_sum"),
        "EXPMA": ("periods", "init"), "CDP": ("previous_high", "previous_low"),
    }
    exact_keys(params, (), allowed[operation], label="params")
    recursive = operation in ("EMA", "SMA", "MACD", "RSI", "TRIX", "KDJ", "EXPMA")
    require(recursive or "state" not in request, "this indicator does not accept incremental state")
    required = ("close",)
    if operation in ("KDJ", "ATR", "MFI", "DMI", "EMV", "CDP", "ARBR"):
        required += ("high", "low")
    if operation == "ARBR":
        required += ("open",)
    if operation in ("OBV", "MFI", "EMV"):
        required += ("volume",)
    metadata, rows = validate_bars(request["data"], required=required)
    close = [row["close"] for row in rows]
    high = [row.get("high") for row in rows]
    low = [row.get("low") for row in rows]
    volume = [row.get("volume") for row in rows]
    count, diagnostics, state = len(rows), [], None
    definitions = {}
    normalized = {}

    def ratio(numerator, denominator, output, factor=1):
        values = []
        for i, (top, bottom) in enumerate(zip(numerator, denominator)):
            if top is None or bottom is None:
                values.append(None)
            elif bottom == 0:
                values.append(None)
                diagnostics.append({"timestamp": rows[i]["timestamp"], "output": output, "reason": "undefined_zero_denominator"})
            else:
                values.append(top / bottom * factor)
        return values

    def seed(parameters, names, nonnegative=()):
        prior = recursive_state(request, metadata, rows, parameters, names, nonnegative)
        if operation in ("EMA", "SMA", "MACD", "TRIX", "EXPMA"):
            for name, value in prior.items():
                if name != "dea":
                    require(value is None or value > 0, "price-average state must be positive: " + name)
        return prior

    def finish_state(parameters, values):
        return next_state(request, metadata, rows, parameters, values)

    if operation == "MA":
        n = _period(params, "period")
        normalized = {"period": n}
        outputs = {"MA": rolling(close, n, "mean")}
        definitions = {"MA": "sum(close over N observations)/N"}
    elif operation == "BBI":
        periods = _periods(params, [3, 6, 12, 24], 4)
        normalized = {"periods": periods}
        averages = [rolling(close, n, "mean") for n in periods]
        outputs = {"BBI": combine(lambda *xs: math.fsum(xs) / 4, *averages), "CLOSE": close}
        definitions = {"BBI": "mean of four complete-window close averages", "CLOSE": "supplied close"}
    elif operation == "BIAS":
        periods = _periods(params, [6, 12, 24], 3)
        lower = number(params.get("lower", -3), "lower")
        upper = number(params.get("upper", 3), "upper")
        normalized = {"periods": periods, "lower": lower, "upper": upper}
        outputs = {}
        for i, n in enumerate(periods):
            mean = rolling(close, n, "mean")
            key = "BIAS" if i == 0 else "BIAS" + str(i + 1)
            outputs[key] = ratio(combine(lambda c, a: c - a, close, mean), mean, key, 100)
        outputs.update(LOWER=[lower] * count, UPPER=[upper] * count)
        definitions = {"BIAS/BIAS2/BIAS3": "100*(close-MA(close,N))/MA(close,N)", "LOWER/UPPER": "reference constants; no trading signal"}
    elif operation in ("MTM", "ROC"):
        n, m = _period(params, "period", 12), _period(params, "average_period", 6)
        normalized = {"period": n, "average_period": m}
        previous = ref(close, n)
        change = combine(lambda c, p: c - p, close, previous)
        values = change if operation == "MTM" else ratio(change, previous, "ROC", 100)
        average = "MAMTM" if operation == "MTM" else "ROCMA"
        outputs = {operation: values, average: rolling(values, m, "mean")}
        definitions = {operation: "close-REF(close,N)" if operation == "MTM" else "100*(close-REF(close,N))/REF(close,N)", average: "complete-window simple average"}
    elif operation in ("EMA", "SMA"):
        n = _period(params, "period")
        normalized = {"period": n}
        if operation == "EMA":
            weight = 2 / (n + 1)
        else:
            m = _period(params, "weight")
            require(n > m, "SMA requires period > weight > 0")
            normalized["weight"] = m
            weight = m / n
        prior = seed(normalized, ("previous",))
        values = smooth(close, n, weight, prior["previous"])
        outputs = {operation: values}
        state = finish_state(normalized, {"previous": values[-1]})
        definitions = {operation: "Y=alpha*close+(1-alpha)*previousY", "alpha": weight}
    elif operation == "MACD":
        s, l, m = _period(params, "short_period", 12), _period(params, "long_period", 26), _period(params, "signal_period", 9)
        normalized = {"short_period": s, "long_period": l, "signal_period": m}
        prior = seed(normalized, ("ema_short", "ema_long", "dea"))
        short = smooth(close, s, 2 / (s + 1), prior["ema_short"])
        long = smooth(close, l, 2 / (l + 1), prior["ema_long"])
        diff = combine(lambda a, b: a - b, short, long)
        dea = smooth(diff, m, 2 / (m + 1), prior["dea"])
        outputs = {"DIFF": diff, "DEA": dea, "MACD": combine(lambda a, b: 2 * (a - b), diff, dea), "ZERO": [0.0] * count}
        state = finish_state(normalized, {"ema_short": short[-1], "ema_long": long[-1], "dea": dea[-1]})
        definitions = {"DIFF": "EMA(close,short)-EMA(close,long)", "DEA": "EMA(DIFF,signal)", "MACD": "2*(DIFF-DEA)", "ZERO": "0"}
    elif operation == "RSI":
        periods = _periods(params, [6, 12, 24], 3, 2)
        normalized = {"periods": periods}
        names = tuple(name + str(i) for i in range(1, 4) for name in ("gain", "absolute")) + ("previous_close",)
        prior = seed(normalized, names, names)
        require("state" not in request or "previous_close" not in params, "previous_close belongs to state when state is supplied")
        previous_close = prior["previous_close"] if "state" in request else _prior(params, "previous_close")
        if previous_close is not None:
            require(previous_close > 0, "previous_close must be positive")
        delta = combine(lambda c, p: c - p, close, ref(close, previous=[previous_close]))
        gain, absolute = combine(lambda x: max(x, 0), delta), combine(abs, delta)
        outputs, final = {}, {"previous_close": close[-1]}
        for i, n in enumerate(periods, 1):
            g, a = prior["gain" + str(i)], prior["absolute" + str(i)]
            require(g is None or g <= a, "RSI state gain cannot exceed absolute change")
            gs, ats = smooth(gain, n, 1 / n, g), smooth(absolute, n, 1 / n, a)
            outputs["RSI" + str(i)] = ratio(gs, ats, "RSI" + str(i), 100)
            final.update({"gain" + str(i): gs[-1], "absolute" + str(i): ats[-1]})
        outputs.update(LOWER=[20.0] * count, UPPER=[80.0] * count)
        state = finish_state(normalized, final)
        definitions = {"RSI1/RSI2/RSI3": "100*SMA(max(delta,0),N,1)/SMA(abs(delta),N,1)", "LOWER/UPPER": "20/80 reference constants"}
    elif operation == "TRIX":
        n, m = _period(params, "period", 12), _period(params, "average_period", 20)
        normalized = {"period": n, "average_period": m}
        prior = seed(normalized, ("ema1", "ema2", "ema3"))
        e1 = smooth(close, n, 2 / (n + 1), prior["ema1"])
        e2 = smooth(e1, n, 2 / (n + 1), prior["ema2"])
        e3 = smooth(e2, n, 2 / (n + 1), prior["ema3"])
        previous = ref(e3, previous=[prior["ema3"]])
        values = ratio(combine(lambda a, b: a - b, e3, previous), previous, "TRIX", 100)
        outputs = {"TRIX": values, "TRMA": rolling(values, m, "mean")}
        state = finish_state(normalized, {"ema1": e1[-1], "ema2": e2[-1], "ema3": e3[-1]})
        definitions = {"TRIX": "100*(tripleEMA(close,N)-REF(tripleEMA(close,N),1))/REF(tripleEMA(close,N),1)", "TRMA": "MA(TRIX,average_period)"}
    elif operation == "KDJ":
        require("state" not in request, "KDJ requires init='first_valid'; rolling history continuation is not supported")
        n, k_n, d_n = _period(params, "period", 9, 2), _period(params, "k_period", 3, 2), _period(params, "d_period", 3, 2)
        normalized = {"period": n, "k_period": k_n, "d_period": d_n}
        prior = seed(normalized, ("k", "d"))
        lowest, highest = rolling(low, n, "min"), rolling(high, n, "max")
        rsv = ratio(combine(lambda c, l: c - l, close, lowest), combine(lambda h, l: h - l, highest, lowest), "RSV", 100)
        k, d = smooth(rsv, k_n, 1 / k_n, prior["k"]), None
        d = smooth(k, d_n, 1 / d_n, prior["d"])
        outputs = {"K": k, "D": d, "J": combine(lambda a, b: 3 * a - 2 * b, k, d)}
        definitions = {"RSV": "100*(close-LLV(low,N))/(HHV(high,N)-LLV(low,N))", "K": "SMA(RSV,k_period,1)", "D": "SMA(K,d_period,1)", "J": "3*K-2*D"}
    elif operation == "BOLL":
        n = _period(params, "period", 20)
        width = number(params.get("width", 2), "width", positive=True)
        require("ddof" in params, "BOLL requires explicit ddof=0 or ddof=1")
        ddof = integer(params["ddof"], "ddof", min_value=0, max_value=1)
        require(n > ddof, "BOLL requires period > ddof")
        normalized = {"period": n, "width": width, "ddof": ddof}
        mid, std = rolling(close, n, "mean"), deviation(close, n, ddof)
        outputs = {"MID": mid, "UPPER": combine(lambda a, b: a + width * b, mid, std), "LOWER": combine(lambda a, b: a - width * b, mid, std)}
        definitions = {"MID": "MA(close,N)", "UPPER/LOWER": "MID +/- width*sqrt(sum((close-MID)^2)/(N-ddof))"}
    elif operation == "ATR":
        n = _period(params, "period", 14)
        normalized = {"period": n}
        tr = _tr(high, low, close, _prior(params, "previous_close"))
        outputs = {"TR": tr, "ATR": rolling(tr, n, "mean")}
        definitions = {"TR": "max(high-low,abs(high-previousClose),abs(low-previousClose))", "ATR": "simple MA(TR,N)"}
    elif operation == "OBV":
        m = _period(params, "average_period", 30)
        require(params.get("start") in ("first_close_baseline", "before_first_observation"), "OBV requires explicit start")
        require("initial_obv" in params, "OBV requires initial_obv in scaled output units")
        initial = number(params["initial_obv"], "initial_obv")
        prior = _prior(params, "previous_close")
        if params["start"] == "before_first_observation":
            require(prior is not None, "before_first_observation requires previous_close")
        else:
            require(prior is None, "first_close_baseline excludes previous_close")
        previous = ref(close, previous=[prior])
        signed = [0.0 if i == 0 and prior is None else (v if c > p else -v if c < p else 0.0) for i, (c, p, v) in enumerate(zip(close, previous, volume))]
        values = [initial + math.fsum(signed[:i + 1]) / 10000 for i in range(count)]
        normalized = {"average_period": m, "start": params["start"], "initial_obv": initial}
        outputs = {"OBV": values, "MAOBV": rolling(values, m, "mean")}
        definitions = {"OBV": "initial_obv+SUM(sign(close-previousClose)*volume)/10000", "MAOBV": "MA(OBV,average_period)", "output_unit": metadata["volume_unit"] + "/10000", "first_close_baseline": "first volume excluded; initial_obv anchors the first close"}
    elif operation == "CCI":
        n = _period(params, "period", 14, 2)
        normalized = {"period": n}
        typical = [(c + (c if h is None else h) + (c if l is None else l)) / 3 for c, h, l in zip(close, high, low)]
        mean, avedev = rolling(typical, n, "mean"), deviation(typical, n)
        values = ratio(combine(lambda a, b: a - b, typical, mean), combine(lambda x: 0.015 * x, avedev), "CCI")
        outputs = {"CCI": values, "UPPER": [100.0] * count, "LOWER": [-100.0] * count}
        definitions = {"TYP": "(coalesce(high,close)+coalesce(low,close)+close)/3", "CCI": "(TYP-MA(TYP,N))/(0.015*AVEDEV(TYP,N))", "UPPER/LOWER": "100/-100 reference constants"}
    elif operation == "PSY":
        n = _period(params, "period", 12, 2)
        normalized = {"period": n}
        up = combine(lambda c, p: 1.0 if c > p else 0.0, close, ref(close, previous=[_prior(params, "previous_close")]))
        outputs = {"PSY": combine(lambda x: x / n * 100, rolling(up, n, "sum"))}
        definitions = {"PSY": "100*COUNT(close>previousClose,N)/N", "outputs": "PSY only; no second smoothing line"}
    elif operation == "ARBR":
        n = _period(params, "period", 26)
        lower, upper = number(params.get("lower", 70), "lower"), number(params.get("upper", 150), "upper")
        normalized = {"period": n, "lower": lower, "upper": upper}
        opened = [row["open"] for row in rows]
        previous = ref(close, previous=[_prior(params, "previous_close")])
        ar_top, ar_bottom = combine(lambda h, o: h - o, high, opened), combine(lambda o, l: o - l, opened, low)
        br_top, br_bottom = combine(lambda h, p: max(0, h - p), high, previous), combine(lambda p, l: max(0, p - l), previous, low)
        outputs = {"AR": ratio(rolling(ar_top, n, "sum"), rolling(ar_bottom, n, "sum"), "AR", 100), "BR": ratio(rolling(br_top, n, "sum"), rolling(br_bottom, n, "sum"), "BR", 100), "LOWER": [lower] * count, "UPPER": [upper] * count}
        definitions = {"AR": "100*SUM(high-open,N)/SUM(open-low,N)", "BR": "100*SUM(max(high-previousClose,0),N)/SUM(max(previousClose-low,0),N)", "LOWER/UPPER": "reference constants"}
    elif operation == "MFI":
        n = _period(params, "period", 14)
        normalized = {"period": n}
        typical = combine(lambda h, l, c: (h + l + c) / 3, high, low, close)
        previous = ref(typical, previous=[_prior(params, "previous_typical_price")])
        positive = combine(lambda t, p, v: t * v if t > p else 0.0, typical, previous, volume)
        negative = combine(lambda t, p, v: t * v if t < p else 0.0, typical, previous, volume)
        flow = ratio(rolling(positive, n, "sum"), rolling(negative, n, "sum"), "MFI")
        outputs = {"MFI": combine(lambda x: 100 - 100 / (1 + x), flow)}
        definitions = {"TYP": "(high+low+close)/3", "MFI": "100-100/(1+SUM(upTypical*volume,N)/SUM(downTypical*volume,N))", "zero_negative_flow": "null even if positive flow is nonzero; no limit substitution"}
    elif operation == "DMI":
        n, m = _period(params, "period", 14), _period(params, "average_period", 6)
        normalized = {"period": n, "average_period": m}
        keys = ("previous_close", "previous_high", "previous_low")
        require(all(key in params for key in keys) or all(key not in params for key in keys), "DMI prior OHLC context must be supplied together")
        pc, ph, pl = (_prior(params, key) for key in keys)
        if pc is not None:
            require(pl <= pc <= ph, "previous_low <= previous_close <= previous_high is required")
        tr = rolling(_tr(high, low, close, pc), n, "sum")
        hd = combine(lambda a, b: a - b, high, ref(high, previous=[ph]))
        ld = combine(lambda a, b: a - b, ref(low, previous=[pl]), low)
        plus = rolling(combine(lambda h, l: h if h > 0 and h > l else 0.0, hd, ld), n, "sum")
        minus = rolling(combine(lambda h, l: l if l > 0 and l > h else 0.0, hd, ld), n, "sum")
        di1, di2 = ratio(plus, tr, "DI1", 100), ratio(minus, tr, "DI2", 100)
        dx = ratio(combine(lambda a, b: abs(a - b), di1, di2), combine(lambda a, b: a + b, di1, di2), "ADX", 100)
        adx = rolling(dx, m, "mean")
        outputs = {"DI1": di1, "DI2": di2, "ADX": adx, "ADXR": combine(lambda a, b: (a + b) / 2, adx, ref(adx, m))}
        definitions = {"DI1/DI2": "100*SUM(exclusive positive upward/downward movement,N)/SUM(TR,N)", "ADX": "MA(100*abs(DI2-DI1)/(DI1+DI2),average_period)", "ADXR": "(ADX+REF(ADX,average_period))/2", "tie_policy": "equal upward/downward movement contributes zero to both"}
    elif operation == "EMV":
        n, m = _period(params, "period", 14), _period(params, "average_period", 9)
        normalized = {"period": n, "average_period": m}
        total = combine(lambda h, l: h + l, high, low)
        previous = ref(total, previous=[_prior(params, "previous_high_low_sum")])
        mid = ratio(combine(lambda a, b: a - b, total, previous), total, "MID", 100)
        volume_ratio = ratio(rolling(volume, n, "mean"), volume, "VOLUME")
        span = combine(lambda h, l: h - l, high, low)
        temp = [0.0 if s == 0 else (None if a is None or b is None else a * b * s) for a, b, s in zip(mid, volume_ratio, span)]
        normalized_temp = ratio(temp, rolling(span, n, "mean"), "EMV")
        emv = rolling(normalized_temp, n, "mean")
        outputs = {"EMV": emv, "MAEMV": rolling(emv, m, "mean")}
        definitions = {"TEMP": "100*(high+low-previousHighLowSum)/(high+low)*MA(volume,N)/volume*(high-low); high==low overrides TEMP to zero", "EMV": "MA(TEMP/MA(high-low,N),N)", "MAEMV": "MA(EMV,average_period)"}
    elif operation == "EXPMA":
        periods = _periods(params, [5, 10, 20, 60], 4)
        normalized = {"periods": periods}
        names = tuple("ema" + str(i) for i in range(1, 5))
        prior = seed(normalized, names)
        outputs = {"MA" + str(i): smooth(close, n, 2 / (n + 1), prior["ema" + str(i)]) for i, n in enumerate(periods, 1)}
        state = finish_state(normalized, {"ema" + str(i): outputs["MA" + str(i)][-1] for i in range(1, 5)})
        definitions = {"MA1/MA2/MA3/MA4": "EMA(close,corresponding period); these four lines are exponential averages"}
    else:  # CDP
        require(("previous_high" in params) == ("previous_low" in params), "CDP prior high and low must be supplied together")
        ph, pl = _prior(params, "previous_high"), _prior(params, "previous_low")
        if ph is not None:
            require(ph >= pl, "previous_high must be >= previous_low")
        previous_range = combine(lambda h, l: h - l, ref(high, previous=[ph]), ref(low, previous=[pl]))
        cdp = combine(lambda h, l, c: (h + l + 2 * c) / 4, high, low, close)
        outputs = {"CDP": cdp, "AH": combine(lambda c, p: c + p, cdp, previous_range), "AL": combine(lambda c, p: c - p, cdp, previous_range), "NH": combine(lambda c, l: 2 * c - l, cdp, low), "NL": combine(lambda c, h: 2 * c - h, cdp, high)}
        definitions = {"CDP": "(currentHigh+currentLow+2*currentClose)/4", "AH/AL": "currentCDP +/- (previousHigh-previousLow)", "NH/NL": "2*currentCDP-currentLow/currentHigh", "timing": "current-observation values; available only after the current bar is known"}
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
              "incremental_scope": "state carries only recursive values; rolling outputs require their supplied full windows"}
    if recursive:
        method["initialization"] = "explicit_state" if "state" in request else "first_valid"
        method["recursive_missing_policy"] = "leading null delays seed; later null invalidates recurrence"
    if operation in ("ATR", "PSY", "ARBR", "MFI", "DMI", "EMV", "CDP", "RSI"):
        method["prior_context"] = {key: params[key] for key in params if key.startswith("previous_")}
    result = {"rows": [{"timestamp": row["timestamp"], **{key: values[i] for key, values in outputs.items()}} for i, row in enumerate(rows)], "diagnostics": diagnostics, "method": method}
    if state is not None:
        result["state"] = state
    return result
