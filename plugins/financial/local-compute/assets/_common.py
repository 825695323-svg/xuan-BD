"""Shared validation and complete-window arithmetic for explicit local inputs."""
from datetime import date
import math

class ContractError(ValueError):
    pass

def require(condition, message):
    if not condition:
        raise ContractError(message)

def number(value, label, positive=False, nonnegative=False):
    require(type(value) in (int, float), label + '须为数值，不能是布尔值或字符串')
    try:
        value = float(value)
    except (ValueError, OverflowError) as exc:
        raise ContractError(label + '超出有限数值范围') from exc
    require(math.isfinite(value), label + '须为有限数值')
    require(not positive or value > 0, label + '须大于0')
    require(not nonnegative or value >= 0, label + '不能为负数')
    return value

def integer(value, label, min_value=1, max_value=None):
    require(type(value) is int, label + '须为整数，不能是布尔值')
    require(value >= min_value and (max_value is None or value <= max_value), label + '超出整数范围')
    return value

def exact_keys(obj, required, optional=(), label='object'):
    require(isinstance(obj, dict), label + '须为对象')
    missing = set(required) - set(obj)
    extra = set(obj) - set(required) - set(optional)
    require(not missing, label + '缺少字段：' + ','.join(sorted(missing)))
    require(not extra, label + '包含未支持字段：' + ','.join(sorted(extra)))

def validate_bars(data, required=('close',), frequency='1d'):
    exact_keys(data, ('metadata', 'rows'), label='data')
    metadata, rows = data['metadata'], data['rows']
    require(isinstance(metadata, dict), 'metadata须为对象')
    for key in ('series_id', 'frequency', 'timezone', 'price_unit', 'adjustment',
                'adjustment_basis', 'window_start', 'window_end'):
        require(isinstance(metadata.get(key), str) and bool(metadata[key].strip()), 'metadata.' + key + '须明确提供')
    require(metadata['frequency'] == frequency, '本操作仅接受声明为' + frequency + '的数据')
    require(metadata['adjustment'] in ('unadjusted', 'forward_adjusted', 'backward_adjusted', 'as_stored'), 'adjustment取值不受支持')
    require(metadata.get('observations_are_consecutive') is True, '须声明observations_are_consecutive=true，仅指所供序列观测')
    require(isinstance(rows, list) and bool(rows), 'rows须为非空记录数组')
    previous = None
    for i, row in enumerate(rows):
        require(isinstance(row, dict), '第%d条记录须为对象' % (i + 1))
        text = row.get('timestamp')
        require(isinstance(text, str), 'timestamp须为YYYY-MM-DD')
        try:
            day = date.fromisoformat(text)
        except ValueError as exc:
            raise ContractError('timestamp须为有效YYYY-MM-DD日期') from exc
        require(day.isoformat() == text, 'timestamp须严格为YYYY-MM-DD')
        require(previous is None or day > previous, 'timestamp须严格递增且不能重复')
        previous = day
        for key in required:
            require(key in row and row[key] is not None, '第%d条缺少所需字段%s' % (i + 1, key))
        for key in ('open', 'high', 'low', 'close'):
            if row.get(key) is not None:
                number(row[key], '第%d条%s' % (i + 1, key), positive=True)
        for key in ('volume', 'amount'):
            if row.get(key) is not None:
                number(row[key], '第%d条%s' % (i + 1, key), nonnegative=True)
                require(isinstance(metadata.get(key + '_unit'), str) and bool(metadata[key + '_unit'].strip()), '必须声明' + key + '_unit')
        prices = [row.get(k) for k in ('open', 'high', 'low', 'close')]
        if all(x is not None for x in prices):
            op, hi, lo, cl = prices
            require(lo <= min(op, cl) <= max(op, cl) <= hi, '第%d条四价关系无效' % (i + 1))
        elif row.get('low') is not None and row.get('high') is not None:
            require(row['low'] <= row['high'], '最低价不能高于最高价')
        for key in ('open', 'close'):
            if row.get(key) is not None:
                if row.get('low') is not None:
                    require(row['low'] <= row[key], key + '不能低于已提供的最低价')
                if row.get('high') is not None:
                    require(row[key] <= row['high'], key + '不能高于已提供的最高价')
    require(metadata['window_start'] == rows[0]['timestamp'] and metadata['window_end'] == rows[-1]['timestamp'], '窗口声明须与所供记录首尾一致')
    return metadata, rows

def rolling(values, n, operation='mean'):
    integer(n, 'window')
    require(operation in ('mean', 'sum', 'min', 'max'), '不支持该滚动操作')
    result = []
    for i in range(len(values)):
        part = values[max(0, i + 1 - n):i + 1]
        if len(part) < n or any(x is None for x in part):
            result.append(None)
        elif operation == 'min':
            result.append(min(part))
        elif operation == 'max':
            result.append(max(part))
        else:
            result.append(math.fsum(part) / (n if operation == 'mean' else 1))
    return result

def columns(rows, names):
    return tuple([row[name] for row in rows] for name in names)
