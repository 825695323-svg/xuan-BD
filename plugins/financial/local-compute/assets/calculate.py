"""Run a registered daily indicator against explicit in-memory input."""
import math

from _common import require
from indicators import run


def finite_tree(value):
    if isinstance(value, dict):
        for part in value.values():
            finite_tree(part)
    elif isinstance(value, list):
        for part in value:
            finite_tree(part)
    elif isinstance(value, float):
        require(math.isfinite(value), '输入或计算结果含非有限数值')

def execute(request):
    require(isinstance(request, dict), '请求须为对象')
    require(set(request) == {'version', 'kind', 'operation', 'params', 'data'}, '请求字段与算法契约不符')
    require(type(request['version']) is int and request['version'] == 1, 'version须为1')
    kind = request['kind']
    require(kind == 'indicator', '算法类别未登记')
    require(isinstance(request['data'], dict), 'data须为对象')
    finite_tree(request)
    answer = run(request)
    require(isinstance(answer, dict), '计算模块须返回对象')
    finite_tree(answer)
    result = dict(answer)
    result.update(ok=True, version=1, kind=kind, operation=request['operation'], execution_executed=False)
    if 'metadata' not in result and 'metadata' in request['data']:
        result['metadata'] = request['data']['metadata']
    return result
