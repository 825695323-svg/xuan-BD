"""Explicit confirmed turning points; provisional last legs are never committed."""
from _common import require
import series_math as sm

FUNCTIONS={'ZIG','FLATZIG','PEAK','PEAKBARS','TROUGH','TROUGHBARS'}


def pivots(prices,threshold,absolute=False):
    require(all(x is not None and sm.numeric(x)>0 for x in prices),'转折计算需要完整正价格序列')
    require(threshold>0,'转折阈值须为正')
    points=[];direction=0;low=high=prices[0];low_i=high_i=0
    def exceeds(value,base):return value>threshold if absolute else value/base*100>threshold
    for i,price in enumerate(prices[1:],1):
        if direction==0:
            if price<=low:low,low_i=price,i
            if price>=high:high,high_i=price,i
            if exceeds(price-low,low):
                points.append(dict(index=low_i,value=low,kind='low',confirmed_index=i));direction=1;high,high_i=price,i
            elif exceeds(high-price,high):
                points.append(dict(index=high_i,value=high,kind='high',confirmed_index=i));direction=-1;low,low_i=price,i
        elif direction==1:
            if price>=high:high,high_i=price,i
            elif exceeds(high-price,high):
                points.append(dict(index=high_i,value=high,kind='high',confirmed_index=i));direction=-1;low,low_i=price,i
        else:
            if price<=low:low,low_i=price,i
            elif exceeds(price-low,low):
                points.append(dict(index=low_i,value=low,kind='low',confirmed_index=i));direction=1;high,high_i=price,i
    return points


def apply(name,args,executor):
    require(name in FUNCTIONS,'转折函数无效')
    require(len(args) in ((2,3) if name in ('ZIG','FLATZIG') else (3,4)),'转折参数数量无效')
    sm.need(executor.method,'pivot_initialization',('first_confirmed_direction',))
    sm.need(executor.method,'pivot_tie',('latest_extreme',))
    sm.need(executor.method,'pivot_threshold',('strict_greater',))
    sm.need(executor.method,'unconfirmed_leg',('omit',))
    selector=sm.integer(sm.scalar_arg(args[0],'价格字段选择'));require(selector in (0,1,2,3),'当前转折只支持单一开/高/低/收序列；高低混合需要明确盘内顺序')
    field=('open','high','low','close')[selector]
    require(all(field in row for row in executor.rows),'转折输入缺少'+field)
    threshold=sm.numeric(sm.scalar_arg(args[1],'转折阈值'))
    abs_index=2 if name in ('ZIG','FLATZIG') else 3
    absolute=False if len(args)<=abs_index else sm.integer(sm.scalar_arg(args[abs_index],'绝对阈值标记'))
    require(absolute in (0,1),'绝对阈值标记须为0/1')
    points=pivots([row[field] for row in executor.rows],threshold,bool(absolute))
    for point in points:
        executor.annotations.append({'kind':'confirmed_pivot','pivot_kind':point['kind'],'timestamp':executor.rows[point['index']]['timestamp'],
            'available_at':executor.rows[point['confirmed_index']]['timestamp'],'value':point['value']})
    out=[None]*executor.size
    if name in ('ZIG','FLATZIG'):
        require(executor.method['mode']=='retrospective_batch','回画转折线必须使用retrospective_batch')
        if name=='FLATZIG':sm.need(executor.method,'normalization',('per_confirmed_leg',))
        for first,last in zip(points,points[1:]):
            a,b=first['index'],last['index'];require(a<b,'转折锚点必须递增')
            low=first['value'] if name=='ZIG' else 0 if first['kind']=='low' else 1
            high=last['value'] if name=='ZIG' else 0 if last['kind']=='low' else 1
            for i in range(a,b+1):out[i]=low+(high-low)*(i-a)/(b-a)
        return out
    nth=sm.integer(sm.scalar_arg(args[2],'转折次序'),minimum=1)
    kind='high' if name.startswith('PEAK') else 'low'
    for i in range(executor.size):
        known=[p for p in points if p['kind']==kind and p['confirmed_index']<=i]
        if len(known)>=nth:
            selected=known[-nth];out[i]=i-selected['index'] if name.endswith('BARS') else selected['value']
    return out
