"""Execute only saved expression trees over explicit local observation arrays."""
from copy import deepcopy
from datetime import date, datetime
import math
from zoneinfo import ZoneInfo

from _common import exact_keys, require, validate_bars
import series_math as sm
import context_functions
import drawing_values
import turning_points

METHOD_KEYS={'initialization','cumulative_start','ddof','between_boundary','forecast_horizon','moment_estimator',
             'calendar_difference','barscount_definition','extreme_tie','rounding','numeric_text_decimals','backset_span','backset_value','mode',
             'observation_time','report_anchor','report_date_field','line_pairing','color_priority','default_color',
             'membership_aggregation','return_field','return_unit','lead_rule','lead_tie',
             'pivot_initialization','pivot_tie','pivot_threshold','unconfirmed_leg','normalization',
             'calendar','instrument_kind','membership_separator','index_scope','allow_unit_conversion','shares_per_lot','field_semantics',
             'null_comparison','strfind_omitted_start','day_start'}
ALIASES={'C':'close','CLOSE':'close','O':'open','OPEN':'open','H':'high','HIGH':'high','L':'low','LOW':'low',
         'V':'volume','VOL':'volume','VOLUME':'volume','MONEY':'amount','AMOUNT':'amount'}


def series_data(data):
    exact_keys(data,('metadata','rows'),label='data')
    meta,rows=data['metadata'],data['rows']
    require(isinstance(meta,dict),'metadata须为对象')
    for key in ('series_id','frequency','timezone','window_start','window_end'):
        require(isinstance(meta.get(key),str) and bool(meta[key].strip()),'metadata.'+key+'须明确提供')
    require(meta.get('observations_are_consecutive') is True,'须声明所供观测连续；不代表完整交易日历')
    zone=ZoneInfo(meta['timezone'])
    require(isinstance(rows,list) and rows,'rows须为非空记录数组')
    previous=None
    for row in rows:
        require(isinstance(row,dict),'观测记录须为对象')
        stamp=row.get('timestamp');require(isinstance(stamp,str),'timestamp须为日期或带偏移时间')
        if meta['frequency']=='1d':
            parsed=date.fromisoformat(stamp);require(parsed.isoformat()==stamp,'日频日期须严格为YYYY-MM-DD')
        else:
            parsed=datetime.fromisoformat(stamp.replace('Z','+00:00'))
            require(parsed.utcoffset() is not None and parsed.utcoffset()==parsed.astimezone(zone).utcoffset(),'事件须含与时区一致的偏移')
        require(previous is None or parsed>previous,'观测时间须严格递增且唯一');previous=parsed
        for key,value in row.items():
            if key=='timestamp':continue
            require(value is None or type(value) in (int,float,bool,str),'观测列只接受标量或空值')
            if type(value) in (int,float):require(math.isfinite(value),'输入须为有限数值')
    require(meta['window_start']==rows[0]['timestamp'] and meta['window_end']==rows[-1]['timestamp'],'元数据窗口须匹配所供观测')
    if meta['frequency']=='1d' and all('close' in row and row['close'] is not None for row in rows):
        validate_bars(data,required=('close',))
    return deepcopy(meta),rows


def field_unit(metadata,field):
    if field in ('open','high','low','close'):unit=metadata.get('price_unit')
    elif field in ('volume','amount'):unit=metadata.get(field+'_unit')
    else:unit=metadata.get('field_units',{}).get(field)
    require(isinstance(unit,str) and bool(unit.strip()),'输入列 '+field+' 缺少明确单位/类型标签')
    return unit


def bind_inputs(spec,params,metadata,rows):
    fields=params.get('fields',{});constants=params.get('constants',{})
    require(isinstance(fields,dict) and isinstance(constants,dict),'fields/constants须为对象')
    required=set(spec['inputs'])
    require(set(fields)|set(constants)==required,'fields/constants须恰好覆盖输入：'+','.join(sorted(required)))
    require(not(set(fields)&set(constants)),'同一输入不能同时绑定列和常量')
    env={};bindings={}
    for name in required:
        if name in fields:
            field=fields[name];require(isinstance(field,str) and bool(field),'fields值须为列名')
            require(all(field in row for row in rows),'缺少映射列：'+field)
            unit=field_unit(metadata,field)
            env[name]=[row[field] for row in rows];bindings[name]={'field':field,'unit':unit}
        else:
            item=constants[name];exact_keys(item,('value','unit','meaning'),label='constant.'+name)
            value=item['value'];require(value is None or type(value) in (int,float,bool,str),'常量须为标量')
            for key in ('unit','meaning'):require(isinstance(item[key],str) and bool(item[key].strip()),'常量须给单位和含义')
            if type(value) in (int,float):require(math.isfinite(value),'常量须有限')
            env[name]=[value]*len(rows);bindings[name]=deepcopy(item)
    return env,bindings


def policy(value,required=()):
    require(isinstance(value,dict),'method须为显式对象')
    require(set(value)<=METHOD_KEYS,'method含未知规则')
    require(set(required)<=set(value),'method缺少规则：'+','.join(sorted(set(required)-set(value))))
    require(value.get('mode') in ('causal_batch','retrospective_batch'),'mode须为causal_batch或retrospective_batch')
    return deepcopy(value)


class Executor:
    def __init__(self,env,size,method,data=None):
        self.env=deepcopy(env);self.size=size;self.method=method;self.outputs={};self.output_styles={};self.active=[True]*size
        self.expression_index=0;self.feedback=None;self.zero_divisions=0
        self.expression_ids={};self.current_mask=[True]*size;self.retrospective_overrides=[]
        self.data=data or {};self.metadata=self.data.get('metadata',{});self.rows=self.data.get('rows',[]);self.context_cache={}
        self.annotations=[]
    def expression(self,node):
        tag=node[0]
        if tag=='literal':return [node[1]]*self.size
        if tag=='name':
            name=node[1]
            if name in ('TRUE','FALSE'):return [name=='TRUE']*self.size
            if name=='DRAWNULL':return [None]*self.size
            require(name in self.env,'未绑定或尚未定义的变量：'+name)
            return self.env[name]
        if tag=='unary':
            op=node[1];values=self.expression(node[2])
            require(op!='&','当前操作需要未完成绑定的数据引用函数')
            if op in ('!','NOT'):return [None if x is None else not sm.truth(x) for x in values]
            return [None if x is None else sm.numeric(x)*(1 if op=='+' else -1) for x in values]
        if tag=='lag':
            values=self.expression(node[1]);lags=self.expression(node[2])
            if self.feedback and node[1]==['name',self.feedback[0]]:values=self.feedback[1]
            require(all(n is None or n>=0 for n in lags),'负下标含义未完成确认，禁止当作普通向前引用')
            return sm.shift(values,lags)
        if tag=='binary':
            a,b=self.expression(node[2]),self.expression(node[3])
            if node[1] in ('=','==','!=','<>') and (node[2]==['literal',None] or node[3]==['literal',None]):
                sm.need(self.method,'null_comparison',('identity',))
                values=b if node[2]==['literal',None] else a
                return [v is None if node[1] in ('=','==') else v is not None for v in values]
            if node[1]=='/':self.zero_divisions+=sum(y==0 for y in b if y is not None)
            return [sm.binary(node[1],x,y,self.method) for x,y in zip(a,b)]
        if tag=='call':
            name=node[1]
            if name in context_functions.FUNCTIONS:return context_functions.apply(name,node[2],self)
            if name in drawing_values.FUNCTIONS:return drawing_values.apply(name,[self.expression(arg) for arg in node[2]],self)
            if name in turning_points.FUNCTIONS:return turning_points.apply(name,[self.expression(arg) for arg in node[2]],self)
            if name=='FORMATTIME':
                from builtin_functions import calendar_values
                return calendar_values(name,[self.expression(arg) for arg in node[2]],self)
            if name in ('REFX','BACKSET'):
                require(self.method['mode']=='retrospective_batch','向后引用或回写必须显式选择retrospective_batch')
            args=[self.expression(arg) for arg in node[2]]
            if name=='STRFIND' and len(args)==2:
                start=sm.integer(sm.need(self.method,'strfind_omitted_start'),minimum=1);args.append([start]*self.size)
            if name=='BACKSET':args[0]=[v if active else 0 for v,active in zip(args[0],self.current_mask)]
            if self.feedback and name=='REF' and node[2][0]==['name',self.feedback[0]]:
                args[0]=self.feedback[1]
            return sm.apply(name,args,self.method)
        raise ValueError('不支持的已保存表达式节点：'+tag)
    def store_output(self,key,values,mask,styles=()):
        previous=self.outputs.get(key,[None]*self.size)
        self.outputs[key]=[v if active else old for v,old,active in zip(values,previous,mask)]
        if styles:self.output_styles[key]=styles
    def statement(self,node,mask=None):
        mask=self.active[:] if mask is None else [a and b for a,b in zip(mask,self.active)]
        if not any(mask):return
        self.current_mask=mask
        tag=node[0]
        if tag=='empty':return
        if tag=='block':
            for child in node[1]:self.statement(child,mask)
            return
        if tag=='if':
            cond=[sm.truth(x) for x in self.expression(node[1])]
            unknown=[m and c is None for m,c in zip(mask,cond)]
            # Unknown branch decisions invalidate its assigned values, without picking a branch.
            for name in assigned_names(node):
                previous=self.env.get(name,[None]*self.size)
                self.env[name]=[None if u else x for u,x in zip(unknown,previous)]
            for name in self.output_names(node):
                previous=self.outputs[name];self.outputs[name]=[None if u else x for u,x in zip(unknown,previous)]
            if any(n[0]=='return' for n in walk(node)):
                self.active=[a and not u for a,u in zip(self.active,unknown)]
            self.statement(node[2],[m and c is True for m,c in zip(mask,cond)])
            self.statement(node[3],[m and c is False for m,c in zip(mask,cond)])
            return
        if tag=='assign':
            name,operator,expr,styles=node[1:]
            previous=self.env.get(name,[None]*self.size)
            if has_self_lag(expr,name):
                need='sequential_self_reference'
                # The saved formula itself supplies any first-observation seed; absent seed remains null.
                feedback=[None]*self.size;self.env.setdefault(name,previous)
                for i in range(self.size):
                    self.feedback=(name,feedback)
                    current=self.expression(expr)[i]
                    feedback[i]=current if mask[i] else previous[i]
                self.feedback=None;values=feedback
            else:values=self.expression(expr)
            self.env[name]=[v if active else old for v,old,active in zip(values,previous,mask)]
            if operator in (':',':>'):self.store_output(name,self.env[name],mask,styles)
            return
        if tag in ('return','select'):
            values=self.expression(node[1])
            if tag=='select':values=[sm.truth(x) for x in values]
            self.store_output('RESULT' if tag=='return' else 'SELECT',values,mask)
            if tag=='return' and node[1][0]=='call' and node[1][1]=='BACKSET':
                # A later explicit write may repaint already-observed rows; never mark it as causal.
                args=[self.expression(arg) for arg in node[1][2]]
                for i,(value,period,active) in enumerate(zip(args[0],args[1],mask)):
                    if not active or value is None or not value:continue
                    n=sm.integer(period);start=max(0,i-n+(self.method['backset_span']=='n_observations_including_current'))
                    replacement=value if self.method['backset_value']=='trigger_value' else 1
                    self.retrospective_overrides.append((i,start,'RESULT',replacement))
            if tag=='return':self.active=[a and not m for a,m in zip(self.active,mask)]
            return
        if tag=='expression':
            self.store_output(self.expression_ids[id(node)],self.expression(node[1]),mask,node[2]);return
        if tag=='action':
            self.store_output('ACTION_'+node[1].upper(),[True]*self.size,mask);return
        raise ValueError('不支持的已保存语句节点：'+tag)
    def run(self,statements):
        for node in walk(statements):
            if node[0]=='expression':
                self.expression_index+=1;self.expression_ids[id(node)]='VALUE_'+str(self.expression_index)
        for key in self.output_names(statements):self.outputs[key]=[False if key.startswith('ACTION_') else None]*self.size
        for node in statements:self.statement(node)
        for end,start,key,value in sorted(self.retrospective_overrides):
            for i in range(start,end+1):self.outputs[key][i]=value
        return self.outputs
    def output_names(self,tree):
        result=[]
        for node in walk(tree):
            if node[0]=='assign' and node[2] in (':',':>'):result.append(node[1])
            elif node[0]=='return':result.append('RESULT')
            elif node[0]=='select':result.append('SELECT')
            elif node[0]=='expression':result.append(self.expression_ids[id(node)])
            elif node[0]=='action':result.append('ACTION_'+node[1].upper())
        return list(dict.fromkeys(result))


def walk(node):
    if isinstance(node,list):
        if node and isinstance(node[0],str):yield node
        for part in node:yield from walk(part)


def assigned_names(node):return {n[1] for n in walk(node) if n[0]=='assign'}


def has_self_lag(node,name):
    return any((n[0]=='lag' and n[1]==['name',name]) or
               (n[0]=='call' and n[1]=='REF' and n[2] and n[2][0]==['name',name]) for n in walk(node))


def results(spec,metadata,rows,outputs,method,bindings,styles=None):
    result_rows=[]
    for i,row in enumerate(rows):
        output={'timestamp':row['timestamp']}
        for key,values in outputs.items():
            value=values[i]
            require(value is None or type(value) in (int,float,bool,str,dict),'输出值须为标量、结构化描述或空值')
            if type(value) in (int,float):require(math.isfinite(value),'公式结果超出有限数值范围')
            output[key]=value
        if method['mode']=='retrospective_batch':output['available_at']=rows[-1]['timestamp']
        result_rows.append(output)
    diagnostics=[{'code':'unavailable_values','field':key,'count':sum(x is None for x in values)} for key,values in outputs.items() if any(x is None for x in values)]
    return {'metadata':metadata,'rows':result_rows,'diagnostics':diagnostics,
            'method':{'operation':spec['id'],'name_zh':spec['name_zh'],'policies':method,'inputs':bindings,
                      'output_fields':list(outputs),'styles':styles or {},'runtime':'saved_finite_expression_tree',
                      'data_qualification':spec.get('data_qualification','provided_inputs_only'),
                      'null_is_zero':False,'position_or_execution_effects':False,
                      'availability':'whole_batch_end_conservative' if method['mode']=='retrospective_batch' else 'per_supplied_observation'},
            'execution_executed':False}
