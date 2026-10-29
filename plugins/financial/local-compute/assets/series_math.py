"""Finite vector operations with explicit policies, no text execution or I/O."""
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_EVEN, ROUND_HALF_UP
import math
import statistics

from _common import require
from operators import cumulative, deviation, filtered, smooth


def truth(x):
    require(x is None or type(x) in (int,float,bool), '逻辑输入须为数值、布尔值或空值')
    return None if x is None else bool(x)


def numeric(x):
    require(type(x) in (int,float,bool), '算术输入须为数值或布尔条件')
    require(math.isfinite(x), '计算数值须有限')
    return float(x)


def integer(x, label='周期', minimum=0):
    require(type(x) in (int,float) and math.isfinite(x) and x==int(x) and x>=minimum, label+'须为整数且不小于'+str(minimum))
    return int(x)


def binary(op,a,b,policy=None):
    if op in ('AND','&&'):
        a,b=truth(a),truth(b)
        return False if a is False or b is False else None if a is None or b is None else True
    if op in ('OR','||'):
        a,b=truth(a),truth(b)
        return True if a is True or b is True else None if a is None or b is None else False
    if a is None or b is None:return None
    if op in ('=','==','!=','<>','<','>','<=','>='):
        if op in ('=','==','!=','<>'):
            same=(isinstance(a,str) and isinstance(b,str)) or (type(a) in (int,float,bool) and type(b) in (int,float,bool))
            return (same and a==b) if op in ('=','==') else (not same or a!=b)
        require((isinstance(a,str) and isinstance(b,str)) or (type(a) in (int,float,bool) and type(b) in (int,float,bool)), '比较两侧类型不兼容')
        return {'=':lambda:a==b,'==':lambda:a==b,'!=':lambda:a!=b,'<>':lambda:a!=b,
                '<':lambda:a<b,'>':lambda:a>b,'<=':lambda:a<=b,'>=':lambda:a>=b}[op]()
    if op=='+' and (isinstance(a,str) or isinstance(b,str)):
        if not isinstance(a,str) or not isinstance(b,str):
            decimals=integer(need(policy or {},'numeric_text_decimals'))
            if not isinstance(a,str):a=apply('TOSTRING',[[a],[decimals]],policy)[0]
            if not isinstance(b,str):b=apply('TOSTRING',[[b],[decimals]],policy)[0]
        return a+b
    require(not isinstance(a,str) and not isinstance(b,str), '文本不能参与普通算术')
    a,b=numeric(a),numeric(b)
    if op in ('/','%') and b==0:return None
    if op=='^' and a<0 and b!=int(b):return None
    if op=='^' and a==0 and b<0:return None
    return {'+':lambda:a+b,'-':lambda:a-b,'*':lambda:a*b,'/':lambda:a/b,'%':lambda:math.fmod(a,b),'^':lambda:a**b}[op]()


def shift(values,lags,future=False):
    out=[]
    for i,x in enumerate(lags):
        if x is None:out.append(None);continue
        n=integer(x)
        j=i+n if future else i-n
        out.append(values[j] if 0<=j<len(values) else None)
    return out


def finite_window(values,periods,func,allow_zero=False):
    out=[]
    for i,value in enumerate(periods):
        if value is None:out.append(None);continue
        n=integer(value,minimum=0 if allow_zero else 1)
        if n==0:
            first=next((j for j,v in enumerate(values[:i+1]) if v is not None),None)
            part=[] if first is None else values[first:i+1]
        else:
            part=values[max(0,i+1-n):i+1]
        out.append(None if not part or (n>0 and len(part)!=n) or any(v is None for v in part) else func(part))
    return out


def need(policy,key,values=None):
    require(key in policy,'method须明确提供 '+key)
    if values is not None:require(any(type(policy[key]) is type(value) and policy[key]==value for value in values),'method.'+key+'取值或类型无效')
    return policy[key]


def scalar_arg(values,label):
    require(values and all(x==values[0] for x in values),label+'本实现须为不随观测变化的参数')
    return values[0]


NUMERIC_FUNCTIONS=set('ABS REVERSE COS SIN TAN SQRT POW LN LOG EXP INTPART MOD IF ISNULL NOT MIN MAX MIN_N MAX_N BETWEEN RANGE MA EMA SMA EXPMA DMA_ SUM HHV LLV COUNT EVERY EXIST CROSS LONGCROSS REF REFX BARSLAST BARSSINCE BARSSINCEN BARSCOUNT FILTER AVEDEV STD STDP VAR VARP DEVSQ CORREL COVAR SLOPE FORCAST WMA SKEW KURT NDAY UPNDAY DOWNNDAY LAST VALUEWHEN HHVBARS LLVBARS SUMBARS BACKSET'.split())
STRING_FUNCTIONS=set('STR2CON STRCAT VARCAT STRCMP STRFIND STRLEFT STRRIGHT STRMID STRSPACE STRLEN CON2STR VAR2STR TOSTRING'.split())
CALENDAR_FUNCTIONS={'COUNTTIME'}
FUNCTIONS=NUMERIC_FUNCTIONS|STRING_FUNCTIONS|CALENDAR_FUNCTIONS


def apply(name,args,policy):
    require(name in FUNCTIONS,'未提供明确实现的函数：'+name)
    require(args and all(len(x)==len(args[0]) for x in args),'函数参数须为对齐序列')
    size=len(args[0]); a=args[0]
    def arity(n):require(len(args)==n,name+'参数数量应为'+str(n))
    def point(function):return [None if any(v is None for v in values) else function(*values) for values in zip(*args)]
    if name=='ISNULL':arity(1);return [v is None for v in a]
    if name=='IF':
        arity(3);return [None if truth(c) is None else y if truth(c) else n for c,y,n in zip(*args)]
    if name=='NOT':arity(1);return [None if v is None else not truth(v) for v in a]
    unary={'ABS':abs,'REVERSE':lambda x:-x,'COS':math.cos,'SIN':math.sin,'TAN':math.tan,
           'SQRT':lambda x:math.sqrt(x) if x>=0 else None,'LN':lambda x:math.log(x) if x>0 else None,
           'LOG':lambda x:math.log10(x) if x>0 else None,'EXP':math.exp,'INTPART':math.trunc}
    if name in unary:arity(1);return point(lambda x:unary[name](numeric(x)))
    if name in ('MIN','MAX','MIN_N','MAX_N'):
        require(len(args)>=2,name+'至少两个输入')
        if name in ('MIN','MAX'):arity(2)
        return point(lambda *v:(min if name.startswith('MIN') else max)(numeric(x) for x in v))
    if name in ('MOD','POW'):arity(2);return point(lambda x,y:binary('%' if name=='MOD' else '^',x,y))
    if name in ('BETWEEN','RANGE'):
        arity(3)
        if name=='BETWEEN':
            include=need(policy,'between_boundary',('inclusive','exclusive'))=='inclusive'
            return point(lambda x,y,z:min(y,z)<=x<=max(y,z) if include else min(y,z)<x<max(y,z))
        return point(lambda x,y,z:y<x<z)
    if name in ('REF','REFX'):arity(2);return shift(a,args[1],name=='REFX')
    if name in ('MA','SUM','HHV','LLV','COUNT','EVERY','EXIST'):
        arity(2);values=[None if x is None else int(truth(x)) for x in a] if name in ('COUNT','EVERY','EXIST') else a
        if any(n==0 for n in args[1]):need(policy,'cumulative_start',('observation_start',))
        function={'MA':lambda xs:math.fsum(xs)/len(xs),'SUM':math.fsum,'HHV':max,'LLV':min,'COUNT':math.fsum,
                  'EVERY':lambda xs:all(xs),'EXIST':lambda xs:any(xs)}[name]
        return finite_window(values,args[1],function,allow_zero=name in ('SUM','HHV','LLV','COUNT'))
    if name in ('EMA','SMA','EXPMA','DMA_'):
        need(policy,'initialization',('first_valid',))
        if name=='SMA':
            arity(3);n=integer(scalar_arg(args[1],'SMA周期'),minimum=1);m=numeric(scalar_arg(args[2],'SMA权重'));require(0<m<n,'SMA须0<M<N');weights=[m/n]*size
        elif name=='DMA_':
            arity(2);weights=args[1]
            for w in weights:require(w is None or 0<=numeric(w)<1,'动态平滑权重须在0至1之间且不能等于1')
        else:
            arity(2);n=integer(scalar_arg(args[1],name+'周期'),minimum=1);weights=[2/(n+1)]*size
        out=[];previous=None;started=False;invalid=False
        for x,w in zip(a,weights):
            if invalid or (started and (x is None or w is None)):invalid=True;out.append(None)
            elif x is None or w is None:out.append(None)
            elif not started:previous=numeric(x);started=True;out.append(previous)
            else:previous=previous+numeric(w)*(numeric(x)-previous);out.append(previous)
        return out
    if name in ('AVEDEV','STD','STDP','VAR','VARP','DEVSQ','SKEW','KURT','SLOPE','FORCAST','WMA'):
        arity(2)
        ddof=need(policy,'ddof',(0,1)) if name=='STD' else 1 if name=='VAR' else 0
        def stat(xs):
            xs=[numeric(x) for x in xs];n=len(xs);mean=math.fsum(xs)/n;deviations=[x-mean for x in xs];ss=math.fsum(x*x for x in deviations)
            if name=='AVEDEV':return math.fsum(abs(x) for x in deviations)/n
            if name in ('STD','STDP','VAR','VARP'):
                require(n>ddof,'统计窗口须大于自由度修正')
                v=ss/(n-ddof);return math.sqrt(v) if name in ('STD','STDP') else v
            if name=='DEVSQ':return ss
            if name=='WMA':return math.fsum((j+1)*v for j,v in enumerate(xs))/(n*(n+1)/2)
            if name in ('SLOPE','FORCAST'):
                require(n>=2,'线性回归至少两点');mx=(n-1)/2
                slope=math.fsum((j-mx)*x for j,x in enumerate(xs))/math.fsum((j-mx)**2 for j in range(n))
                if name=='SLOPE':return slope
                horizon=integer(need(policy,'forecast_horizon'),minimum=0)
                return mean+slope*((n-1+horizon)-mx)
            if name in ('SKEW','KURT'):
                convention=need(policy,'moment_estimator',('population','unbiased_sample'))
                if ss==0:return None
                m2=ss/n
                if name=='SKEW':
                    value=(math.fsum(x**3 for x in deviations)/n)/(m2**1.5)
                    if convention=='unbiased_sample':require(n>=3,'样本偏度至少3点');value*=math.sqrt(n*(n-1))/(n-2)
                    return value
                value=(math.fsum(x**4 for x in deviations)/n)/(m2*m2)-3
                if convention=='unbiased_sample':require(n>=4,'样本超额峰度至少4点');value=(n-1)/((n-2)*(n-3))*((n+1)*value+6)
                return value
        return finite_window(a,args[1],stat)
    if name in ('CORREL','COVAR'):
        arity(3);out=[];ddof=need(policy,'ddof',(0,1)) if name=='COVAR' else 0
        for i,p in enumerate(args[2]):
            if p is None:out.append(None);continue
            n=integer(p,minimum=1);left=a[max(0,i+1-n):i+1];right=args[1][max(0,i+1-n):i+1]
            if len(left)!=n or None in left+right:out.append(None);continue
            require(n>ddof,'协方差窗口须大于自由度修正');lm=math.fsum(left)/n;rm=math.fsum(right)/n
            cross=math.fsum((x-lm)*(y-rm) for x,y in zip(left,right))
            denom=math.sqrt(math.fsum((x-lm)**2 for x in left)*math.fsum((y-rm)**2 for y in right)) if name=='CORREL' else n-ddof
            out.append(None if denom==0 else cross/denom)
        return out
    if name in ('CROSS','LONGCROSS'):
        arity(2 if name=='CROSS' else 3);out=[]
        for i,(x,y) in enumerate(zip(a,args[1])):
            n=1 if name=='CROSS' else integer(args[2][i],minimum=1)
            if i<n or x is None or y is None or any(v is None for v in a[i-n:i]+args[1][i-n:i]):out.append(None);continue
            prior=a[i-1]<=args[1][i-1] if name=='CROSS' else all(v<w for v,w in zip(a[i-n:i],args[1][i-n:i]))
            out.append(prior and x>y)
        return out
    if name in ('NDAY','UPNDAY','DOWNNDAY'):
        arity(3 if name=='NDAY' else 2)
        if name=='NDAY':values=[binary('>',x,y) for x,y in zip(a,args[1])];periods=args[2]
        else:values=[None]+[binary('>' if name=='UPNDAY' else '<',a[i],a[i-1]) for i in range(1,size)];periods=args[1]
        return finite_window(values,periods,lambda xs:all(truth(x) for x in xs))
    if name in ('BARSCOUNT','BARSLAST','BARSSINCE','BARSSINCEN'):
        arity(2 if name=='BARSSINCEN' else 1)
        if name=='BARSCOUNT':
            convention=need(policy,'barscount_definition',('valid_span','true_count'))
            if convention=='true_count':return cumulative([None if x is None else int(truth(x)) for x in a],'sum')
            first=None;out=[]
            for i,x in enumerate(a):
                if x is not None and first is None:first=i
                out.append(None if first is None else i-first+1)
            return out
        out=[];first=None;last=None;unknown=False
        for i,x in enumerate(a):
            t=truth(x)
            if name=='BARSSINCEN':
                n=integer(args[1][i],minimum=1);part=a[max(0,i+1-n):i+1]
                if len(part)<n or any(v is None for v in part):out.append(None)
                else:
                    j=next((j for j,v in enumerate(part) if truth(v)),None);out.append(None if j is None else n-1-j)
                continue
            if t is None:unknown=True
            if t is True:
                last=i
                if first is None and not unknown:first=i
                if name=='BARSLAST':unknown=False
            out.append(None if (unknown or (last if name=='BARSLAST' else first) is None) else i-(last if name=='BARSLAST' else first))
        return out
    if name=='FILTER':
        arity(2);need(policy,'cumulative_start',('observation_start',));return filtered(a,integer(scalar_arg(args[1],'FILTER周期')))
    if name=='LAST':
        arity(3);out=[]
        for i,(start,end) in enumerate(zip(args[1],args[2])):
            s,e=integer(start),integer(end);require(s==0 or s>e,'LAST须A>B，或A=0从所供起点开始')
            left=0 if s==0 else i-s;right=i-e
            part=a[max(0,left):right+1] if right>=0 else []
            out.append(None if left<0 or not part or any(x is None for x in part) else all(truth(x) for x in part))
        return out
    if name=='VALUEWHEN':
        arity(2);current=None;out=[]
        for cond,value in zip(a,args[1]):
            t=truth(cond)
            if t is None or t:current=value if t else None
            out.append(current)
        return out
    if name in ('HHVBARS','LLVBARS'):
        arity(2);tie=need(policy,'extreme_tie',('latest','earliest'));out=[]
        if any(n==0 for n in args[1]):need(policy,'cumulative_start',('observation_start',))
        for i,p in enumerate(args[1]):
            if p is None:out.append(None);continue
            n=integer(p);left=0 if n==0 else i+1-n;part=a[max(0,left):i+1]
            if left<0 or not part or None in part:out.append(None);continue
            extreme=(max if name=='HHVBARS' else min)(part);indices=[j for j,x in enumerate(part) if x==extreme]
            out.append(len(part)-1-(indices[-1] if tie=='latest' else indices[0]))
        return out
    if name=='SUMBARS':
        arity(2);out=[]
        require(all(x is None or numeric(x)>=0 for x in a),'SUMBARS本契约限定非负输入')
        for i,target in enumerate(args[1]):
            if target is None:out.append(None);continue
            require(numeric(target)>0,'SUMBARS目标须为正');total=0;found=None
            for j in range(i,-1,-1):
                if a[j] is None:break
                total+=a[j]
                if total>=target:found=i-j+1;break
            out.append(found)
        return out
    if name=='BACKSET':
        arity(2);span=need(policy,'backset_span',('current_and_n_prior','n_observations_including_current'));value_mode=need(policy,'backset_value',('trigger_value','one'));out=[0]*size
        for i,(value,p) in enumerate(zip(a,args[1])):
            if p is None:out[:i+1]=[None]*(i+1);continue
            n=integer(p,minimum=0 if span=='current_and_n_prior' else 1);first=max(0,i-n+(span=='n_observations_including_current'))
            t=bool(value) if isinstance(value,str) else truth(value)
            if t is None:
                for j in range(first,i+1):out[j]=None
            elif t:
                for j in range(first,i+1):out[j]=value if value_mode=='trigger_value' else 1
        return out
    if name in STRING_FUNCTIONS:
        arities={'STR2CON':1,'STRCAT':2,'VARCAT':2,'STRCMP':2,'STRFIND':3,'STRLEFT':2,'STRRIGHT':2,'STRMID':3,
                 'STRSPACE':1,'STRLEN':1,'CON2STR':2,'VAR2STR':2,'TOSTRING':2}
        arity(arities[name])
        def string_op(*v):
            if name in ('CON2STR','VAR2STR','TOSTRING'):
                rounding=need(policy,'rounding',('half_even','half_up'));n=integer(v[1]);require(n<=15,'小数位数上限15')
                x=Decimal(str(numeric(v[0]))).quantize(Decimal(1).scaleb(-n),rounding=ROUND_HALF_EVEN if rounding=='half_even' else ROUND_HALF_UP)
                return format(x,'.'+str(n)+'f')
            require(isinstance(v[0],str),'字符串函数需要文本输入')
            if name in ('STRCAT','VARCAT','STRCMP','STRFIND'):require(isinstance(v[1],str),'字符串函数第二输入须为文本')
            if name=='STR2CON':
                require(bool(v[0].strip()),'空字符串不是数值');result=float(v[0]);require(math.isfinite(result),'字符串数值须有限');return result
            if name in ('STRCAT','VARCAT'):return v[0]+v[1]
            if name=='STRCMP':return v[0]==v[1]
            if name=='STRFIND':return v[0].find(v[1],integer(v[2],minimum=1)-1)+1
            if name=='STRLEN':return len(v[0])
            if name=='STRSPACE':return v[0]+' '
            if name=='STRLEFT':return v[0][:integer(v[1])]
            if name=='STRRIGHT':n=integer(v[1]);return v[0][-n:] if n else ''
            if name=='STRMID':start=integer(v[1],minimum=1);return v[0][start-1:start-1+integer(v[2])]
        return point(string_op)
    if name=='COUNTTIME':
        arity(3);need(policy,'calendar_difference',('calendar_components',))
        def delta(a,b,k):
            left=datetime.strptime(str(integer(a)), '%Y%m%d').date();right=datetime.strptime(str(integer(b)), '%Y%m%d').date();mode=integer(k,minimum=1)
            require(mode in (1,2,3),'日期差类型只接受1/2/3')
            if mode==1:return right.year-left.year
            if mode==2:return (right.year-left.year)*12+right.month-left.month
            return (right-left).days
        return point(delta)
    raise ValueError('函数未覆盖：'+name)
