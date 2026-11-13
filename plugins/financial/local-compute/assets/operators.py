"""Recursive series helpers used by MACD."""
from copy import deepcopy


def combine(function, *sequences):
    return [None if any(x is None for x in values) else function(*values)
            for values in zip(*sequences)]


def smooth(values, weight):
    """Seed first finite input; missing observations emit null.

    A missing observation after initialization invalidates recurrence thereafter.
    Leading nulls do not constitute observations of the recurrence.
    """
    result = []
    started = False
    invalidated = False
    current = None
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


_BINDINGS = ("series_id", "frequency", "timezone", "price_unit", "adjustment", "adjustment_basis")


def bound_metadata(metadata):
    keys = list(_BINDINGS) + [key for key in ("volume_unit", "amount_unit", "field_units") if key in metadata]
    return {key: deepcopy(metadata[key]) for key in keys}


def next_state(request, metadata, rows, parameters, values):
    if any(value is None for value in values.values()):
        return None
    return {"operation": request["operation"], "parameters": parameters,
            "metadata": bound_metadata(metadata),
            "previous_timestamp": rows[-1]["timestamp"], "is_immediately_prior": True,
            "values": values}
