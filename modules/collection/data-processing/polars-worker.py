"""One bounded, explicitly selected Polars calculation. No database or network writes."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import resource
import sys
import time
from decimal import Decimal, ROUND_HALF_EVEN, localcontext

os.environ['POLARS_MAX_THREADS'] = '2'
import polars as pl

VERSION = 'bd.polars-fixed/1'
POLARS_VERSION = '2.0.0'
MAX_ROWS = 5000


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def decimal(value):
    if not isinstance(value, str) or len(value) > 128 or not re.fullmatch(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?', value):
        raise ValueError('DECIMAL_REQUIRED')
    result = Decimal(value)
    if not result.is_finite() or abs(result.as_tuple().exponent) > 18 or len(result.as_tuple().digits) > 38:
        raise ValueError('DECIMAL_PRECISION_UNSUPPORTED')
    if len(format(abs(result), 'f').split('.')[0]) > 20:
        raise ValueError('DECIMAL_SCALE18_INTEGER_RANGE')
    return result


def text(value, scale=None):
    if scale is not None:
        return format(value.quantize(Decimal(1).scaleb(-scale), rounding=ROUND_HALF_EVEN), 'f')
    result = format(value, 'f').rstrip('0').rstrip('.') if '.' in format(value, 'f') else format(value, 'f')
    return '0' if result in {'-0', ''} else result


def execute(request):
    if pl.__version__ != POLARS_VERSION:
        raise ValueError('POLARS_VERSION_MISMATCH:' + pl.__version__)
    if not isinstance(request, dict) or set(request) != {'version', 'method', 'rows', 'parameters'} or request['version'] != VERSION:
        raise ValueError('REQUEST_INVALID')
    rows, parameters = request['rows'], request['parameters']
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_ROWS or not isinstance(parameters, dict):
        raise ValueError('INPUT_BUDGET_INVALID')
    method = request['method']
    if method == 'observation_ma20':
        if parameters != {'period': 20, 'scale': 8, 'rounding': 'half_even'}:
            raise ValueError('MA20_PARAMETERS_INVALID')
        normalized = []
        for i, row in enumerate(rows):
            if set(row) != {'group', 'value', 'key'}:
                raise ValueError('MA20_ROW_INVALID')
            value = None if row['value'] is None else decimal(row['value'])
            normalized.append({'i': i, 'group': row['group'], 'key': row['key'], 'value': value})
        # Conservative exact-integer/Decimal accumulator bound; never let a
        # native overflow or a rolling kernel silently introduce Float64.
        if sum(abs(row['value'] or Decimal(0)) for row in normalized) * Decimal(10) ** 18 >= Decimal(10) ** 38:
            raise ValueError('DECIMAL_ACCUMULATOR_BUDGET')
        frame = pl.DataFrame(normalized, schema={'i': pl.Int64, 'group': pl.String, 'key': pl.String,
                                               'value': pl.Decimal(38, 18)})
        plan = frame.lazy().sort(['group', 'i']).rolling(index_column='i', period='20i', group_by='group').agg(
            pl.col('value').sum().alias('sum'), pl.col('value').count().alias('valid'), pl.len().alias('rows'))
        computed = plan.collect(engine='streaming').sort('i')
        values = []
        for item in computed.to_dicts():
            status = 'warmup' if item['rows'] < 20 else 'window_missing' if item['valid'] < 20 else 'valid'
            values.append({'key': normalized[item['i']]['key'], 'status': status,
                           'value': text(item['sum'] / Decimal(20), 8) if status == 'valid' else None})
        return values, plan.explain(optimized=True)
    if method in {'financial_linear', 'macro_yoy'}:
        if len(rows) != 1:
            raise ValueError('LINEAR_ROW_COUNT_INVALID')
        row = rows[0]
        if method == 'financial_linear':
            values = [decimal(value) for value in row['values']]
            signs = parameters.get('signs')
            if signs not in ([1, -1], [1, 1, -1]) or len(signs) != len(values):
                raise ValueError('FINANCIAL_FORMULA_UNSUPPORTED')
            if sum(abs(value) for value in values) >= Decimal(10) ** 20:
                raise ValueError('DECIMAL_ACCUMULATOR_BUDGET')
            frame = pl.DataFrame({'value': values, 'sign': signs}, schema={'value': pl.Decimal(38, 18), 'sign': pl.Int32})
            plan = frame.lazy().select((pl.col('value') * pl.col('sign').cast(pl.Decimal(38, 0))).sum().alias('value'))
            result = plan.collect(engine='streaming').item()
            return [{'value': text(result), 'state': 'valid_value'}], plan.explain(optimized=True)
        if parameters != {'scale': 8, 'rounding': 'half_even', 'output_unit': 'percent'}:
            raise ValueError('MACRO_PARAMETERS_INVALID')
        current, previous = decimal(row['current']), decimal(row['previous'])
        if previous <= 0:
            return [{'value': None, 'state': 'undefined_zero_denominator' if previous == 0 else 'unsupported_negative_base'}], 'No division: declared denominator policy'
        if abs(current) + abs(previous) >= Decimal(10) ** 20:
            raise ValueError('DECIMAL_ACCUMULATOR_BUDGET')
        frame = pl.DataFrame({'current': [current], 'previous': [previous]},
                             schema={'current': pl.Decimal(38, 18), 'previous': pl.Decimal(38, 18)})
        plan = frame.lazy().select((pl.col('current') - pl.col('previous')).alias('difference'), 'previous')
        result = plan.collect(engine='streaming').to_dicts()[0]
        value = result['difference'] / result['previous'] * Decimal(100)
        return [{'value': text(value, 8), 'state': 'valid_value'}], plan.explain(optimized=True)
    raise ValueError('METHOD_UNSUPPORTED')


def main():
    started = time.monotonic()
    raw = sys.stdin.buffer.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError('INPUT_BYTE_BUDGET')
    request = json.loads(raw)
    with localcontext() as context:
        context.prec = 120
        rows, plan = execute(request)
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    result = {'version': VERSION, 'executor': 'polars', 'polars_version': pl.__version__, 'method': request['method'],
              'input_sha256': hashlib.sha256(canonical(request)).hexdigest(), 'rows': rows,
              'resources': {'elapsed_ms': int((time.monotonic() - started) * 1000),
                            'peak_rss_bytes': rss if sys.platform == 'darwin' else rss * 1024,
                            'peak_rss_hard_limit': False, 'temporary_output_bytes': 0,
                            'temporary_disk_peak_bytes': None,
                            'requested_engine': 'streaming', 'physical_streaming_proven': False,
                            'thread_pool_size': pl.thread_pool_size(),
                            'rows': len(request['rows']), 'platform': platform.platform(), 'python': platform.python_version()},
              'optimized_plan': plan, 'publication': 'candidate_only'}
    sys.stdout.buffer.write(canonical(result) + b'\n')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error).split(':', 1)[0]
        sys.stdout.write(json.dumps({'ok': False, 'code': code if re.fullmatch(r'[A-Z][A-Z0-9_]{1,64}', code) else 'EXECUTION_REJECTED',
                                     'message': str(error)[:4096]}, ensure_ascii=False) + '\n')
