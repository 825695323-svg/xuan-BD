#!/usr/bin/env python3
"""Run one explicitly requested local calculation; never execute an external action."""
import argparse
import csv
import importlib
import json
import math
from pathlib import Path
import sys
sys.dont_write_bytecode = True
from _common import require

MODULES = {'indicator': 'indicators', 'operator': 'operators', 'pattern': 'patterns',
           'level': 'patterns', 'data': 'local_data', 'formula': 'formulas', 'builtin': 'builtin_functions'}

def load_json(path):
    def pairs(items):
        out = {}
        for k, v in items:
            require(k not in out, 'JSON包含重复字段：' + k)
            out[k] = v
        return out
    def invalid(value):
        raise ValueError('JSON不接受非有限字面值：' + value)
    return json.loads(path.read_text(encoding='utf-8-sig'), object_pairs_hook=pairs, parse_constant=invalid)

def finite_tree(value):
    if isinstance(value, dict):
        for part in value.values():
            finite_tree(part)
    elif isinstance(value, list):
        for part in value:
            finite_tree(part)
    elif isinstance(value, float):
        require(math.isfinite(value), '输入或计算结果含非有限数值')

def execute(request, base):
    require(isinstance(request, dict), '请求须为对象')
    require(set(request) <= {'version', 'kind', 'operation', 'params', 'data', 'data_file', 'state'}, '请求包含未支持的顶层字段')
    require(type(request.get('version')) is int and request['version'] == 1, 'version须为1')
    kind = request.get('kind')
    require(kind in MODULES, 'kind不受支持')
    require(isinstance(request.get('operation'), str) and bool(request['operation']), 'operation须明确提供')
    require(isinstance(request.get('params'), dict), 'params须为对象，可为空对象')
    require('state' not in request or isinstance(request['state'], dict), 'state须为对象；首次运行请省略')
    require(('data' in request) != ('data_file' in request), 'data与data_file必须且只能提供一项')
    request = dict(request)
    data_base = base
    if 'data_file' in request:
        location = request.pop('data_file')
        require(isinstance(location, str) and bool(location.strip()) and '://' not in location, 'data_file须是显式本地JSON文件')
        data_path = base / location
        request['data'] = load_json(data_path)
        data_base = data_path.resolve().parent
    require(isinstance(request['data'], dict), 'data须为对象')
    if 'csv_file' in request['data']:
        require(kind == 'data' and request['operation'] == 'normalize_bars', 'csv_file仅供normalize_bars操作')
        require(set(request['data']) == {'metadata', 'csv_file'}, 'CSV输入只接受metadata与csv_file')
        location = request['data']['csv_file']
        require(isinstance(location, str) and bool(location.strip()) and '://' not in location, 'csv_file须是显式本地文件')
        with (data_base / location).open(encoding='utf-8-sig', newline='') as handle:
            reader = csv.DictReader(handle)
            fields = reader.fieldnames or []
            require(fields and all(fields) and len(set(fields)) == len(fields), 'CSV表头不能为空或重复')
            records = list(reader)
            require(all(None not in row and all(value is not None for value in row.values()) for row in records), 'CSV列数不一致')
        request['data'] = {'metadata': request['data']['metadata'], 'columns': fields, 'records': records}
    finite_tree(request)
    module = importlib.import_module(MODULES[kind])
    answer = module.run(request)
    require(isinstance(answer, dict), '计算模块须返回对象')
    finite_tree(answer)
    result = dict(answer)
    result.update(ok=True, version=1, kind=kind, operation=request['operation'], execution_executed=False)
    if 'metadata' not in result and 'metadata' in request['data']:
        result['metadata'] = request['data']['metadata']
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True, type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        if args.output:
            require(not args.output.exists(), '输出已存在，拒绝覆盖')
        result = execute(load_json(args.request), args.request.resolve().parent)
        rendered = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
        if args.output:
            with args.output.open('x', encoding='utf-8') as handle:
                handle.write(rendered)
        else:
            sys.stdout.write(rendered)
        return 0
    except (OSError, ValueError, TypeError, KeyError, OverflowError, ImportError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc), 'execution_executed': False}, ensure_ascii=False))
        return 2

if __name__ == '__main__':
    sys.exit(main())
