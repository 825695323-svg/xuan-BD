"""Explicit, time-bounded related-series, report and membership lookups."""
from datetime import datetime,time,date
from zoneinfo import ZoneInfo
import math

from _common import require,exact_keys
import series_math as sm

AGGREGATE_FUNCTIONS={'BLOCKAVG','BLOCKCOUNT','BLOCKMAX','BLOCKMIN','BLOCKSUM','BLOCKLEAD','INDEXLEAD','RISETREND','FALLTREND'}
FUNCTIONS={'INDEXDATA','SUBSAMEDAY','GETREPTYPE','REP','LASTREP','MIDREP','YEARREP','QUARTERREP','REPDATE','INBLOCK'}|AGGREGATE_FUNCTIONS
REPORT_FUNCTIONS=FUNCTIONS-{'INDEXDATA','INBLOCK','SUBSAMEDAY'}-AGGREGATE_FUNCTIONS


def observed_times(metadata,rows,method):
    zone=ZoneInfo(metadata['timezone']);out=[]
    for row in rows:
        stamp=row['timestamp']
        if 'T' not in stamp:
            marker=method.get('observation_time')
            require(isinstance(marker,str),'日期观测上的时点查询须明确method.observation_time')
            t=time.fromisoformat(marker);require(t.tzinfo is None and t.strftime('%H:%M:%S')==marker,'observation_time须为HH:MM:SS')
            point=datetime.fromisoformat(stamp+'T'+marker).replace(tzinfo=zone)
        else:point=datetime.fromisoformat(stamp.replace('Z','+00:00'))
        out.append(point)
    return out


def aware(value,zone,label):
    require(isinstance(value,str) and 'T' in value,label+'须为带偏移日期时间')
    d=datetime.fromisoformat(value.replace('Z','+00:00'))
    require(d.utcoffset() is not None and d.utcoffset()==d.astimezone(zone).utcoffset(),label+'时区偏移不一致')
    return d


def reference_name(node):
    require(node[0]=='unary' and node[1]=='&' and node[2][0]=='name','数据项引用须为明确的字段标识')
    return node[2][1]


def related(executor,key):
    cache=executor.context_cache.setdefault('related',{})
    if key in cache:return cache[key]
    from formula_runtime import series_data,field_unit
    records=executor.data.get('related_series')
    require(isinstance(records,dict) and key in records,'缺少明确提供的关联序列：'+str(key))
    item=records[key];exact_keys(item,('metadata','rows','fields'),label='related_series.'+key)
    metadata,rows=series_data({'metadata':item['metadata'],'rows':item['rows']})
    require(metadata['series_id']==key,'关联序列键必须匹配其声明身份，不能暗中重绑')
    require(metadata['frequency']==executor.metadata['frequency'],'关联序列频率须相同')
    require(metadata['timezone']==executor.metadata['timezone'],'关联序列时区须相同')
    require(isinstance(item['fields'],dict),'关联字段映射须为对象')
    for name,column in item['fields'].items():
        require(isinstance(column,str) and all(column in row for row in rows),'关联字段缺少映射列：'+str(column))
        field_unit(metadata,column)
    result=(item,{row['timestamp']:i for i,row in enumerate(rows)})
    cache[key]=result;return result


def indexdata(args,executor):
    require(len(args) in (2,3),'INDEXDATA需证券标识、字段引用和可选非负周期')
    keys=executor.expression(args[0]);field=reference_name(args[1]);lags=executor.expression(args[2]) if len(args)==3 else [0]*executor.size
    out=[]
    for row,key,lag in zip(executor.rows,keys,lags):
        require(isinstance(key,str) and key,'关联序列标识须为非空字符串')
        item,indices=related(executor,key)
        require(field in item['fields'],'关联序列没有声明字段：'+field)
        if lag is None or row['timestamp'] not in indices:out.append(None);continue
        k=indices[row['timestamp']]-sm.integer(lag)
        out.append(None if k<0 else item['rows'][k][item['fields'][field]])
    return out


def report_records(executor):
    if 'reports' in executor.context_cache:return executor.context_cache['reports']
    rows=executor.data.get('reports');require(isinstance(rows,list),'报告查询须提供data.reports数组')
    zone=ZoneInfo(executor.metadata['timezone']);validated=[];seen=set();units={}
    for row in rows:
        exact_keys(row,('series_id','field','period_end','report_type','available_at','value','unit'),label='report')
        require(row['series_id']==executor.metadata['series_id'],'报告主体须匹配主序列')
        require(isinstance(row['field'],str) and bool(row['field']),'report.field须明确')
        period=datetime.strptime(row['period_end'],'%Y-%m-%d').date();require(period.isoformat()==row['period_end'],'报告期格式无效')
        q=sm.integer(row['report_type'],minimum=1);require(q in (1,2,3,4),'报告类型须为1/2/3/4')
        require(period.month in {1:(3,),2:(6,),3:(9,),4:(12,)}[q],'报告类型与报告期月份不一致')
        at=aware(row['available_at'],zone,'report.available_at');require(at.date()>=period,'报告可得时间不能早于报告期末')
        key=(row['field'],row['period_end'],at)
        require(key not in seen,'同字段同报告期同可得时点存在重复/冲突');seen.add(key)
        value=row['value'];require(value is None or type(value) in (int,float,str),'报告值须为数值、文本或空值')
        if type(value) in (int,float):require(math.isfinite(value),'报告值须有限')
        require(isinstance(row['unit'],str) and row['unit'],'报告须声明单位')
        require(row['field'] not in units or units[row['field']]==row['unit'],'同报告字段的单位须统一')
        units[row['field']]=row['unit'];validated.append(dict(row,_period=period,_available=at))
    executor.context_cache['reports']=validated;return validated


def reports(name,args,executor):
    require(len(args) in ({'GETREPTYPE':(1,), 'REPDATE':(3,), 'QUARTERREP':(2,3)}.get(name,(2,))),name+'参数数量无效')
    field=reference_name(args[0]);raw=[r for r in report_records(executor) if r['field']==field]
    k_values=executor.expression(args[1]) if len(args)>=2 else [1]*executor.size
    l_values=executor.expression(args[2]) if len(args)>=3 else [None]*executor.size
    anchor_rule=sm.need(executor.method,'report_anchor',('latest_period','latest_publication'))
    out=[]
    for at,k,l in zip(observed_times(executor.metadata,executor.rows,executor.method),k_values,l_values):
        # Retain only revisions actually available at this observation, one latest-known version per period.
        known={}
        for r in raw:
            if r['_available']<=at:
                old=known.get(r['period_end'])
                if old is None or r['_available']>old['_available']:known[r['period_end']]=r
        candidates=list(known.values())
        candidates.sort(key=(lambda r:(r['_period'],r['_available'])) if anchor_rule=='latest_period' else (lambda r:(r['_available'],r['_period'])),reverse=True)
        if not candidates:out.append(None);continue
        if k is None:out.append(None);continue
        k=sm.integer(k,minimum=1);selected=None
        if name=='GETREPTYPE':out.append(candidates[0]['report_type']);continue
        if name=='LASTREP':
            ordered=sorted(candidates,key=lambda r:(r['_available'],r['_period']),reverse=True)
            selected=ordered[k-1] if k<=len(ordered) else None
        elif name=='REP':
            anchor=candidates[0];year=anchor['_period'].year-(k-1)
            selected=next((r for r in candidates if r['_period'].year==year and r['report_type']==anchor['report_type']),None)
        else:
            if name=='YEARREP':types={4}
            elif name=='MIDREP':types={2}
            elif name=='REPDATE':types={sm.integer(l,minimum=1)};require(types<={1,2,3,4},'REPDATE类型无效')
            else:
                if k>=1900:
                    require(l in (1,3),'按年份取季报须明确第1或第3季');types={int(l)}
                else:
                    require(l is None,'按顺序取季报不接受额外季度参数');types={1,3}
            filtered=sorted((r for r in candidates if r['report_type'] in types),key=lambda r:(r['_period'],r['_available']),reverse=True)
            if k>=1900 and name!='REPDATE':selected=next((r for r in filtered if r['_period'].year==k),None)
            else:selected=filtered[k-1] if k<=len(filtered) else None
        if selected is None:out.append(None)
        elif name=='REPDATE':
            choice=sm.need(executor.method,'report_date_field',('period_end','available_date'))
            d=selected['_period'] if choice=='period_end' else selected['_available'].date();out.append(int(d.strftime('%Y%m%d')))
        else:out.append(selected['value'])
    return out


def memberships(executor):
    if 'memberships' in executor.context_cache:return executor.context_cache['memberships']
    records=executor.data.get('memberships');require(isinstance(records,list),'须提供data.memberships')
    zone=ZoneInfo(executor.metadata['timezone']);out=[];seen=set()
    for item in records:
        exact_keys(item,('series_id','group_id','group_name','category','valid_from','valid_to','available_at'),('index_scope',),label='membership')
        for key in ('series_id','group_id','group_name','category'):require(isinstance(item[key],str) and bool(item[key]),'成员关系标识须为非空文本')
        start=datetime.strptime(item['valid_from'],'%Y-%m-%d').date();end=datetime.strptime(item['valid_to'],'%Y-%m-%d').date() if item['valid_to'] else None
        require(end is None or start<=end,'成员有效区间逆序');at=aware(item['available_at'],zone,'membership.available_at')
        key=(item['series_id'],item['group_id'],item['valid_from'],item['valid_to'],at)
        require(key not in seen,'成员关系重复');seen.add(key)
        out.append(dict(item,_start=start,_end=end,_available=at))
    executor.context_cache['memberships']=out;return out


def active_memberships(executor,at,group=None):
    return [r for r in memberships(executor) if r['_start']<=at.date() and (r['_end'] is None or at.date()<=r['_end']) and r['_available']<=at
            and (r['group_id']==group if group is not None else r['series_id']==executor.metadata['series_id'])]


def aggregate(name,args,executor):
    from formula_runtime import field_unit
    expected=0 if name in ('BLOCKCOUNT','INDEXLEAD') else 2 if name in ('BLOCKLEAD','RISETREND','FALLTREND') else 1
    require(len(args)==expected,name+'参数数量无效')
    sm.need(executor.method,'membership_aggregation',('all_declared_members_strict',))
    require(type(executor.metadata.get('membership_complete')) is bool,'须明确成员集合是否完整')
    field=sm.need(executor.method,'return_field') if name=='INDEXLEAD' else reference_name(args[0]) if args else None
    second=reference_name(args[1]) if name in ('BLOCKLEAD','RISETREND','FALLTREND') else None
    out=[]
    for observation,at in zip(executor.rows,observed_times(executor.metadata,executor.rows,executor.method)):
        if executor.metadata['membership_complete'] is False:out.append(None);continue
        members=active_memberships(executor,at,group=executor.metadata['series_id'])
        keys=sorted({r['series_id'] for r in members})
        if name=='BLOCKCOUNT':out.append(len(keys));continue
        if not keys:out.append(None);continue
        values=[];extra=[];units=set();extra_units=set()
        for key in keys:
            item,indices=related(executor,key);require(field in item['fields'],'成分数据缺少字段映射：'+str(field))
            units.add(field_unit(item['metadata'],item['fields'][field]))
            idx=indices.get(observation['timestamp'])
            value=None if idx is None else item['rows'][idx][item['fields'][field]];values.append(value)
            if second:
                require(second in item['fields'],'领先项缺少第二字段映射')
                extra_units.add(field_unit(item['metadata'],item['fields'][second]));extra.append(None if idx is None else item['rows'][idx][item['fields'][second]])
        require(len(units)==1 and len(extra_units)<=1,'聚合数据单位须一致，不自动换算')
        if any(v is None for v in values):out.append(None);continue
        if name in ('RISETREND','FALLTREND'):
            require(units==extra_units,'趋势比率的现价与基准价格单位须一致')
            if any(v is None for v in extra):out.append(None);continue
            require(all(type(x) in (int,float) and x>0 for x in values+extra),'成员现价和基准价格须为正')
            selected=[v for v,p in zip(values,extra) if (v>p if name=='RISETREND' else v<p)]
            out.append(math.fsum(selected)/math.fsum(values))
        elif name=='BLOCKLEAD':
            rule=sm.need(executor.method,'lead_rule',('max_first_field','min_first_field'))
            tie=sm.need(executor.method,'lead_tie',('null','first_series_id'))
            require(all(type(v) in (int,float) for v in values) or all(isinstance(v,str) for v in values),'排序字段类型须一致')
            best=(max if rule=='max_first_field' else min)(values);indices=[i for i,v in enumerate(values) if v==best]
            out.append(None if len(indices)>1 and tie=='null' else extra[indices[0]])
        else:
            values=[sm.numeric(v) for v in values]
            if name=='BLOCKSUM':out.append(math.fsum(values))
            elif name=='BLOCKAVG':out.append(math.fsum(values)/len(values))
            elif name=='BLOCKMAX':out.append(max(values))
            elif name=='BLOCKMIN':out.append(min(values))
            else:
                unit=sm.need(executor.method,'return_unit',('ratio','percent'))
                require(next(iter(units)) in ({'比例','无量纲'} if unit=='ratio' else {'%','%（已×100）'}),'涨幅单位与return_unit不一致')
                out.append(math.fsum(values)/len(values)*(10000 if unit=='ratio' else 100))
    return out


def apply(name,args,executor):
    if name=='SUBSAMEDAY':
        require(len(args)==1,'当天差需要一个明确数据项引用')
        field=reference_name(args[0]);require(field in executor.env,'当天差引用字段尚未绑定：'+field)
        require(executor.metadata['frequency']!='1d','当天差需要交易日内观测，不能以日线代替')
        key=executor.metadata.get('trading_day_field');require(isinstance(key,str) and key,'须声明trading_day_field交易日列')
        start=sm.need(executor.method,'day_start',('unknown','zero_if_complete'))
        if start=='zero_if_complete':require(executor.metadata.get('sessions_start_complete') is True,'首条按零基准相减须明确从交易日起点提供完整观测')
        out=[];prior_day=None;prior_value=None
        for row,value in zip(executor.rows,executor.env[field]):
            raw=row.get(key);require(isinstance(raw,str),'交易日须为明确日期文本');day=date.fromisoformat(raw)
            require(day.isoformat()==raw and (prior_day is None or day>=prior_day),'交易日须标准格式并按序连续分组')
            if value is not None:sm.numeric(value)
            if day!=prior_day:out.append(value if start=='zero_if_complete' else None)
            else:out.append(None if value is None or prior_value is None else value-prior_value)
            prior_day,prior_value=day,value
        return out
    if name in AGGREGATE_FUNCTIONS:return aggregate(name,args,executor)
    if name=='INDEXDATA':return indexdata(args,executor)
    if name in REPORT_FUNCTIONS:return reports(name,args,executor)
    if name=='INBLOCK':
        require(len(args)==1,'INBLOCK需要一个板块名称');names=executor.expression(args[0]);out=[]
        complete=executor.metadata.get('membership_complete')
        require(type(complete) is bool,'须明确membership_complete，未证明完整时不输出假')
        for at,value in zip(observed_times(executor.metadata,executor.rows,executor.method),names):
            require(isinstance(value,str),'板块名称须为文本');active=active_memberships(executor,at)
            matched=any(r['group_name']==value for r in active);out.append(True if matched else False if complete else None)
        return out
    raise ValueError('不支持的时点查询：'+name)
