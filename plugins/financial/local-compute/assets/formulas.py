"""Named, saved formula definitions; requests cannot provide executable text."""
from copy import deepcopy
import json
from pathlib import Path

from _common import exact_keys, number, require
from formula_runtime import Executor, bind_inputs, policy, results, series_data


def definitions():
    return json.loads((Path(__file__).parent/'definitions/formulas.json').read_text(encoding='utf-8'))['operations']


def run(request):
    require('state' not in request,'formula操作当前仅接受完整批输入，不接受递推状态')
    registry=definitions();operation=request['operation'];require(operation in registry,'没有已通过契约检查的公式：'+operation)
    spec=registry[operation];params=request['params']
    exact_keys(params,('parameters','fields','constants','method'),('variant',),label='params')
    variants=spec.get('variants')
    if variants:
        require(params.get('variant') in variants,'必须明确选择variant：'+','.join(variants))
        spec=dict(spec,**variants[params['variant']])
    else:require('variant' not in params,'此公式没有variant')
    parameters=params['parameters'];exact_keys(parameters,tuple(spec['parameters']),label='parameters')
    for key,value in parameters.items():
        number(value,'parameters.'+key)
        if key in spec.get('parameter_ranges',{}):
            low,high=spec['parameter_ranges'][key];require(low<=value<=high,'参数'+key+'超出声明范围')
    exact_keys(request['data'],('metadata','rows'),('related_series','reports','memberships'),label='data')
    metadata,rows=series_data({k:request['data'][k] for k in ('metadata','rows')})
    for key,value in spec.get('required_metadata',{}).items():
        require(type(metadata.get(key)) is type(value) and metadata.get(key)==value,'此公式需要明确metadata.'+key+'='+str(value)+'；不能用截断历史推断上市时长')
    env,bindings=bind_inputs(spec,params,metadata,rows)
    for key,unit in spec.get('unit_requirements',{}).items():
        require(bindings[key]['unit']==unit,'此公式输入'+key+'须使用'+unit+'；请显式换算并声明单位')
    env.update({key:[value]*len(rows) for key,value in parameters.items()})
    method=policy(params['method'],spec.get('required_policies',[]))
    executor=Executor(env,len(rows),method,request['data']);outputs=executor.run(spec['statements'])
    for name in spec.get('implicit_outputs',[]):
        require(name in executor.env,'隐式结果变量尚未定义：'+name)
        outputs[name]=executor.env[name]
    require(outputs,'定义没有结果输出')
    answer=results(spec,metadata,rows,outputs,method,bindings,executor.output_styles)
    if executor.annotations:answer['annotations']=executor.annotations
    return answer
