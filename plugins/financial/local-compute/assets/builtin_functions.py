"""Explicit local implementations of named mathematical and input-data functions."""
from datetime import datetime,time,timedelta
from decimal import Decimal,ROUND_HALF_EVEN,ROUND_HALF_UP
import json
from pathlib import Path
from zoneinfo import ZoneInfo

from _common import exact_keys,require
from formula_runtime import Executor,field_unit,policy,results,series_data
import context_functions
import drawing_values
import series_math as sm
import turning_points

FIELD_READERS=set('AMOUNT_IND BIGBUYCOUNT1 BIGSELLCOUNT1 BUYCOUNT BUYCOUNT1 BUYCOUNT2 BUYCOUNT3 BUYPRICE BUYPRICE1 BUYPRICE2 BUYPRICE3 BUY_MONEY1 BUY_MONEY2 BUY_MONEY3 BUY_MONEY4 BUY_MONEY5 CLOSE DAYINTERST DAYINTERST2 FALLCOUNT FZHJ HIGH HQSYL INVOL JLRNEW JYLX LOW MGGJJ MGSY MGSYX MONEY MONEYFS NEW NEWVOL OI OPEN OPENVOL OUTVOL PRE RANGE_AVG_PRICE RISECOUNT SELLCOUNT SELLCOUNT1 SELLCOUNT2 SELLCOUNT3 SELLPRICE SELLPRICE1 SELLPRICE2 SELLPRICE3 SELL_MONEY1 SELL_MONEY2 SELL_MONEY3 SELL_MONEY4 SELL_MONEY5 SMALLBUYCOUNT4 SMALLSELLCOUNT4 TOTALSTOCK VOL VOLAMOUNT YJLX ZGB ZQMC'.split())
CALENDAR=set('DATETIME DATE_S DAYSTOTODAY FORMATTIME FROMNIGHT FROMOPEN MACHINEDATE MACHINETIME MACHINEWEEK PERIOD PERIODNAME TIME2 TOTALFZNUM TRADETIME TQFLAG WEEKOFYEAR VALIDBEGIN VALIDEND'.split())
SPECIAL={'CAPITAL_UNTS','TOTALCAPITAL_UNTS','CODETYPE','FIVEDAYVOL','VOLCLASS','VOLAMOUNT1','QHJSJ','BLOCK','ZSBLOCK','ZSBLOCKNUM'}
SUPPORTED=FIELD_READERS|CALENDAR|SPECIAL|sm.FUNCTIONS|context_functions.FUNCTIONS|drawing_values.FUNCTIONS|turning_points.FUNCTIONS


def definitions():
    return json.loads((Path(__file__).parent/'definitions/builtins.json').read_text(encoding='utf-8'))['operations']


def arguments(params,metadata,rows):
    entries=params['arguments'];require(isinstance(entries,list),'arguments须为数组')
    nodes=[];env={};bindings=[]
    for index,item in enumerate(entries):
        require(isinstance(item,dict) and len(item)==1,'每个参数须恰好为field/value/reference之一')
        if 'field' in item:
            name=item['field'];require(isinstance(name,str) and name,'field须为明确列名');require(all(name in row for row in rows),'缺少参数输入列：'+name)
            unit=field_unit(metadata,name);key='ARG'+str(index);env[key]=[row[name] for row in rows];nodes.append(['name',key]);bindings.append({'field':name,'unit':unit})
        elif 'value' in item:
            value=item['value'];require(value is None or type(value) in (int,float,bool,str),'常量参数须为标量');nodes.append(['literal',value]);bindings.append({'value':value})
        else:
            require('reference' in item and isinstance(item['reference'],str) and item['reference'],'reference须为明确关联字段名')
            nodes.append(['unary','&',['name',item['reference']]]);bindings.append({'reference':item['reference']})
    return nodes,env,bindings


def calendar_values(name,args,executor):
    require(name in CALENDAR,'日期时间操作无效')
    calendar=executor.method.get('calendar',{})
    require(isinstance(calendar,dict),'method.calendar须为对象')
    dates=[datetime.strptime(row['timestamp'][:10],'%Y-%m-%d').date() for row in executor.rows]
    if name=='FORMATTIME':
        require(len(args)==1 and sm.scalar_arg(args[0],'时间格式')==1,'FORMATTIME只支持格式1')
    else:require(not args,name+'使用观测元数据，不接受数值参数')
    if name=='DATETIME':return [r['timestamp'] for r in executor.rows]
    if name in ('VALIDBEGIN','VALIDEND'):
        if name=='VALIDEND':require(executor.method['mode']=='retrospective_batch','统计区间终点须明确使用整段回看模式')
        return [executor.metadata['window_start' if name=='VALIDBEGIN' else 'window_end']]*executor.size
    if name=='DATE_S':return [(d.year-1900)*10000+d.month*100+d.day for d in dates]
    if name=='DAYSTOTODAY':
        exact_keys(calendar,('reference_date',),label='calendar');reference=datetime.strptime(calendar['reference_date'],'%Y-%m-%d').date()
        return [(reference-d).days for d in dates]
    if name=='WEEKOFYEAR':
        exact_keys(calendar,('week_system',),label='calendar');require(calendar['week_system']=='iso8601','须明确选择ISO周序，未假定其他周序默认值')
        return [d.isocalendar()[1] for d in dates]
    if name in ('PERIOD','PERIODNAME'):
        mapping={'1m':(0,'1分钟'),'5m':(1,'5分钟'),'15m':(2,'15分钟'),'30m':(3,'30分钟'),'60m':(4,'60分钟'),
                 '1d':(5,'日线'),'1w':(6,'周线'),'1mo':(7,'月线'),'1q':(10,'季线'),'1y':(11,'年线')}
        require(executor.metadata['frequency'] in mapping,'该周期尚无明确枚举映射')
        value=mapping[executor.metadata['frequency']][0 if name=='PERIOD' else 1];return [value]*executor.size
    if name=='TQFLAG':return [{'unadjusted':0,'forward_adjusted':1,'backward_adjusted':2,'as_stored':None}.get(executor.metadata.get('adjustment'))]*executor.size
    if name.startswith('MACHINE'):
        exact_keys(calendar,('reference_time',),label='calendar');at=context_functions.aware(calendar['reference_time'],ZoneInfo(executor.metadata['timezone']),'reference_time')
        value=(at.year-1900)*10000+at.month*100+at.day if name=='MACHINEDATE' else at.hour*10000+at.minute*100+at.second if name=='MACHINETIME' else at.isoweekday()
        return [value]*executor.size
    if name in ('FROMNIGHT','TIME2'):
        points=context_functions.observed_times(executor.metadata,executor.rows,executor.method)
        return [p.hour*3600+p.minute*60+p.second if name=='FROMNIGHT' else p.hour*10000+p.minute*100 for p in points]
    exact_keys(calendar,('sessions','minute_counting'),label='calendar')
    require(calendar['minute_counting'] in ('elapsed_minutes','including_open_minute'),'minute_counting无效')
    sessions=calendar['sessions'];require(isinstance(sessions,list) and sessions,'交易时段须非空')
    intervals=[];previous=None
    for segment in sessions:
        require(isinstance(segment,list) and len(segment)==2,'交易时段须为起止时间对')
        pair=[]
        for item in segment:
            parsed=time.fromisoformat(item);require(parsed.tzinfo is None and parsed.strftime('%H:%M:%S')==item,'时段须为HH:MM:SS')
            pair.append(parsed.hour*3600+parsed.minute*60+parsed.second)
        require(pair[0]<pair[1] and (previous is None or pair[0]>previous),'时段须递增、不交叠；跨午夜须先拆成明确观测日')
        require((pair[1]-pair[0])%60==0,'交易时段须为整分钟');previous=pair[1];intervals.append(pair)
    add=1 if calendar['minute_counting']=='including_open_minute' else 0
    total=sum((end-start)//60 for start,end in intervals)+add
    if name in ('TOTALFZNUM','TRADETIME'):return [total]*executor.size
    out=[]
    for point in context_functions.observed_times(executor.metadata,executor.rows,executor.method):
        current=point.hour*3600+point.minute*60+point.second
        elapsed=sum(max(0,min(current,end)-start) for start,end in intervals)
        out.append(elapsed//60+(add if current>=intervals[0][0] else 0))
    return [None]*(executor.size-1)+out[-1:] if name=='FROMOPEN' else out


def special_values(name,args,executor,bindings):
    if name=='QHJSJ':
        require(len(args)==2,'QHJSJ须显式给结算字段和昨收字段')
        require(len(bindings)==2 and all('field' in b for b in bindings) and bindings[0]['unit']==bindings[1]['unit'],'结算/昨收须映射同单位字段')
        require(all(x is None or (type(x) in (int,float) and x>0) for values in args for x in values),'结算和昨收须为正价格或空值')
        return [previous if settlement is None else settlement for settlement,previous in zip(*args)]
    if name=='VOLAMOUNT1':
        require(len(args)==4,'成交笔数须给增量计数、成交计数、市场枚举和品种枚举')
        out=[]
        for i,(current,total,market,kind) in enumerate(zip(*args)):
            for value in (current,total):
                if value is not None:sm.integer(value,'成交计数')
            if market is not None:sm.integer(market,'市场枚举')
            if kind is not None:sm.integer(kind,'品种枚举')
            if current is not None and market in (16,32) and kind is not None and kind!=0:
                value=current;prior=args[0][i-1] if i else None
            else:value=total;prior=args[1][i-1] if i else None
            out.append(0 if value is None else value if prior is None or value<prior else value-prior)
        return out
    if name in ('CAPITAL_UNTS','TOTALCAPITAL_UNTS','ZGB'):
        require(len(args)==1 and 'field' in bindings[0],'股本操作须映射一个明确数量列')
        unit=bindings[0]['unit'];lot=sm.integer(sm.need(executor.method,'shares_per_lot'),minimum=1)
        scales={'股':1,'手':lot,'万股':10000,'万股（可小数）':10000,'亿股':100000000}
        require(unit in scales,'股本单位不在明确可转换范围内')
        target=1 if name=='ZGB' else lot;factor=scales[unit]/target
        if factor!=1:require(executor.method.get('allow_unit_conversion') is True,'单位转换必须显式allow_unit_conversion=true')
        require(all(x is None or sm.numeric(x)>=0 for x in args[0]),'股本不能为负')
        return [None if x is None else x*factor for x in args[0]]
    if name=='CODETYPE':
        require(not args,'证券类别来自明确instrument_kind')
        mapping={'index':0,'stock':1,'b_stock':2,'bond':3,'fund':4};kind=sm.need(executor.method,'instrument_kind',tuple(mapping))
        return [mapping[kind]]*executor.size
    if name=='FIVEDAYVOL':
        require(len(args)==1,'FIVEDAYVOL须给成交量列');calendar=executor.method.get('calendar',{});exact_keys(calendar,('include_current',),label='calendar')
        require(type(calendar['include_current']) is bool,'include_current须明确为布尔值')
        values=args[0] if calendar['include_current'] else sm.shift(args[0],[1]*executor.size)
        return sm.finite_window(values,[5]*executor.size,lambda x:sum(x))
    if name=='VOLCLASS':
        require(len(args)==8,'VOLCLASS须价格、买一至三、卖一至三、前次报价时间共8项')
        out=[];zone=ZoneInfo(executor.metadata['timezone'])
        points=context_functions.observed_times(executor.metadata,executor.rows,executor.method)
        for i,(p,b1,b2,b3,s1,s2,s3,quote_at) in enumerate(zip(*args)):
            if any(v is None for v in (p,b1,b2,b3,s1,s2,s3,quote_at)):out.append(None);continue
            require(0<b3<=b2<=b1<s1<=s2<=s3 and p>0,'盘口须为正值且买卖层级有序；锁盘/交叉盘口不在本规则内')
            require(context_functions.aware(quote_at,zone,'quote_at')<points[i],'分类须使用成交之前的报价')
            out.append(3 if p<=b3 else 2 if p<=b2 else 1 if p<=b1 else 0 if p<s1 else 5 if p<s2 else 6 if p<s3 else 7)
        return out
    if name in ('BLOCK','ZSBLOCK','ZSBLOCKNUM'):
        require(len(args)==(2 if name=='BLOCK' else 0),name+'参数数量无效')
        complete=executor.metadata.get('membership_complete');require(type(complete) is bool,'须声明成员关系是否完整')
        separator=sm.need(executor.method,'membership_separator');require(isinstance(separator,str),'成员分隔符须为字符串')
        out=[]
        for i,at in enumerate(context_functions.observed_times(executor.metadata,executor.rows,executor.method)):
            if not complete:out.append(None);continue
            active=context_functions.active_memberships(executor,at)
            if name=='BLOCK':
                category=sm.integer(args[0][i]);newline=sm.integer(args[1][i]);require(category in (0,1,2,3) and newline in (0,1),'BLOCK分类0..3，换行标记0/1')
                category=('industry_level_2','industry_level_3','region','concept')[category]
                matches=[r for r in active if r['category']==category];sep='\n' if newline else separator
            else:
                scopes=sm.need(executor.method,'index_scope');require(isinstance(scopes,list) and scopes and all(isinstance(x,str) for x in scopes),'index_scope须明确列出范围')
                candidates=[r for r in active if r['category']=='benchmark_index'];require(all('index_scope' in r for r in candidates),'指数成员关系缺少范围标记')
                matches=[r for r in candidates if r['index_scope'] in scopes];sep=separator
            names={r['group_id']:r['group_name'] for r in matches}
            out.append(len(names) if name=='ZSBLOCKNUM' else sep.join(names[k] for k in sorted(names)))
        return out
    raise ValueError('未实现的特殊操作：'+name)


def run(request):
    require('state' not in request,'builtin操作不接受隐式递推状态')
    registry=definitions();name=request['operation'];require(name in registry,'该内置函数仍需补充定义：'+name)
    spec=registry[name];params=request['params'];exact_keys(params,('arguments','method'),label='params')
    exact_keys(request['data'],('metadata','rows'),('related_series','reports','memberships'),label='data')
    metadata,rows=series_data({k:request['data'][k] for k in ('metadata','rows')})
    nodes,env,bindings=arguments(params,metadata,rows)
    method=policy(params['method'],spec.get('required_policies',[]))
    if name in ('REFX','BACKSET'):
        require(method['mode']=='retrospective_batch','向后引用或回写必须显式选择retrospective_batch')
    executor=Executor(env,len(rows),method,request['data'])
    if name in context_functions.FUNCTIONS:values=context_functions.apply(name,nodes,executor)
    else:
        args=[executor.expression(node) for node in nodes]
        if name in drawing_values.FUNCTIONS:values=drawing_values.apply(name,args,executor)
        elif name in turning_points.FUNCTIONS:values=turning_points.apply(name,args,executor)
        elif name in CALENDAR:values=calendar_values(name,args,executor)
        elif name in SPECIAL or name=='ZGB':values=special_values(name,args,executor,bindings)
        elif name in FIELD_READERS:
            require(len(args)==1 and 'field' in bindings[0],'事实读取须映射一个明确本地字段')
            require(isinstance(method.get('field_semantics'),str) and method['field_semantics'].strip(),'须声明field_semantics，读取不证明字段身份')
            values=args[0]
            for v in values:
                require(v is None or isinstance(v,str) if name=='ZQMC' else v is None or type(v) in (int,float),'事实字段类型不符')
            if name=='MGSYX':
                rounding=sm.need(method,'rounding',('half_even','half_up'))
                values=[None if v is None else float(Decimal(str(v)).quantize(Decimal('0.001'),rounding=ROUND_HALF_EVEN if rounding=='half_even' else ROUND_HALF_UP)) for v in values]
        else:values=sm.apply(name,args,method)
    answer=results(spec,metadata,rows,{name:values},method,{'arguments':bindings})
    if executor.annotations:answer['annotations']=executor.annotations
    answer['method']['scope']=spec['scope']
    return answer
