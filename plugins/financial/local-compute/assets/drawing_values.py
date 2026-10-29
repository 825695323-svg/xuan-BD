"""Declarative drawing primitives and explicit line values; no UI or file access."""
import math
from _common import require
import series_math as sm

FUNCTIONS={'RGB','DRAWBMP','DRAWBAND','DRAWGBK','DRAWGBKLAST','DRAWICON','DRAWKLINE','DRAWLINE','DRAWNUMBER','DRAWTEXT',
           'DRAWTEXT_FIX','FILLRGN','HORLINE','PARTLINE','POLYLINE','STICKLINE','STRIP','TIPTEXT','VERLINE','ZIGLINE'}
RETROSPECTIVE={'DRAWLINE','POLYLINE','ZIGLINE','DRAWGBKLAST'}


def color(value):
    require(isinstance(value,str) and bool(value),'颜色须为显式文本描述或RGB生成值')
    return value


def apply(name,args,executor):
    require(name in FUNCTIONS,'绘图描述操作无效')
    size=executor.size;timestamps=[r['timestamp'] for r in executor.rows];mask=executor.current_mask
    def arity(n):require(len(args)==n,name+'参数数量应为'+str(n))
    def emit(i,kind,**payload):
        executor.annotations.append(dict(kind=kind,timestamp=timestamps[i],available_at=timestamps[i],**payload))
    if name in RETROSPECTIVE:require(executor.method['mode']=='retrospective_batch','连线/末条背景须用retrospective_batch')
    if name=='RGB':
        arity(3);out=[]
        for values in zip(*args):
            if any(x is None for x in values):out.append(None);continue
            rgb=[sm.integer(x) for x in values];require(all(x<=255 for x in rgb),'RGB通道须在0..255内');out.append('#'+''.join(format(x,'02X') for x in rgb))
        return out
    if name=='STRIP':
        arity(3);out=[]
        for a,b,d in zip(*args):
            if any(x is None for x in (a,b,d)):out.append(None);continue
            direction=sm.integer(d,minimum=1);require(direction<=4,'渐变方向须为1..4')
            out.append({'kind':'gradient','from_color':color(a),'to_color':color(b),'direction':direction})
        return out
    if name in ('DRAWLINE','POLYLINE','ZIGLINE'):
        arity(5 if name=='DRAWLINE' else 2)
        if name=='DRAWLINE':sm.need(executor.method,'line_pairing',('latest_start_then_first_end',))
        out=[None]*size;pending=None;segments=[]
        for i in range(size):
            if not mask[i]:continue
            if name=='DRAWLINE':
                c1,p1,c2,p2,expand=(x[i] for x in args)
                if c1 is None or c2 is None:pending=None;continue
                if sm.truth(c1) is True:pending=None if p1 is None else (i,sm.numeric(p1))
                if sm.truth(c2) is True and p2 is not None and pending is not None:
                    e=sm.integer(expand);require(e in (0,1),'直线延长只接受0/1')
                    segments.append((pending[0],pending[1],i,sm.numeric(p2),bool(e)));pending=None
            else:
                cond,price=args[0][i],args[1][i]
                if cond is None or (sm.truth(cond) is True and price is None):pending=None;continue
                if sm.truth(cond) is True and price is not None:
                    price=sm.numeric(price)
                    if pending is not None:segments.append((pending[0],pending[1],i,price,False))
                    pending=(i,price)
        for start,p1,end,p2,expand in segments:
            # The stored anchors are the restored part of ZIGLINE; no undocumented saw geometry is invented.
            emit(end,'saw_anchors' if name=='ZIGLINE' else 'line_segment',start_timestamp=timestamps[start],start_value=p1,end_timestamp=timestamps[end],end_value=p2,extend_right=expand)
            if name=='ZIGLINE':out[start]=p1;out[end]=p2;continue
            stop=size-1 if expand else end
            for j in range(start,stop+1):out[j]=p2 if start==end else p1+(p2-p1)*(j-start)/(end-start)
        return out
    out=[False]*size
    for i,values in enumerate(zip(*args)):
        if not mask[i]:continue
        if name=='DRAWKLINE':
            arity(4)
            if any(x is None for x in values):out[i]=None;continue
            high,opening,low,close=[sm.numeric(v) for v in values]
            require(low<=min(opening,close)<=max(opening,close)<=high,'绘制四价关系矛盾')
            emit(i,'candle',open=opening,high=high,low=low,close=close);out[i]=True;continue
        if name=='DRAWBAND':
            arity(4);a,ca,b,cb=values
            if a is None or b is None:out[i]=None;continue
            if a==b:continue
            emit(i,'band',first=sm.numeric(a),second=sm.numeric(b),color=color(ca if a>b else cb));out[i]=True;continue
        if name in ('PARTLINE','FILLRGN'):
            offset=1 if name=='PARTLINE' else 2
            require(len(values)>=offset and (len(values)-offset)%2==0 and (len(values)-offset)//2<=15,'条件颜色须为最多15组成对参数')
            sm.need(executor.method,'color_priority',('first_true',))
            base=values[:offset]
            if any(x is None for x in base):out[i]=None;continue
            pairs=list(zip(values[offset::2],values[offset+1::2]));chosen=None;unknown=False
            if not pairs:
                chosen=color(sm.need(executor.method,'default_color'))
            for cond,c in pairs:
                t=sm.truth(cond)
                if t is None:unknown=True;break
                if t:chosen=color(c);break
            if unknown:out[i]=None;continue
            if chosen is None:continue
            if name=='PARTLINE':emit(i,'colored_point',value=sm.numeric(base[0]),color=chosen);out[i]=base[0]
            else:emit(i,'conditional_fill',first=sm.numeric(base[0]),second=sm.numeric(base[1]),color=chosen);out[i]=True
            continue
        expected={'DRAWBMP':3,'DRAWGBK':2,'DRAWGBKLAST':2,'DRAWICON':3,'DRAWNUMBER':3,'DRAWTEXT':3,'DRAWTEXT_FIX':5,
                  'HORLINE':4,'STICKLINE':5,'TIPTEXT':3,'VERLINE':2}[name]
        arity(expected)
        cond=sm.truth(values[0])
        if cond is None:out[i]=None;continue
        if not cond or (name=='DRAWGBKLAST' and i!=size-1):continue
        if any(x is None for x in values[1:]):out[i]=None;continue
        if name=='DRAWBMP':
            require(isinstance(values[2],str) and values[2].strip(),'位图须为显式图像引用，不使用默认软件路径')
            emit(i,'image_anchor',value=sm.numeric(values[1]),image_reference=values[2])
        elif name in ('DRAWGBK','DRAWGBKLAST'):
            c=values[1];require(isinstance(c,(str,dict)),'背景须为颜色/渐变描述，不读取图形文件')
            emit(i,'background',color=c,scope='whole_supplied_window' if name=='DRAWGBKLAST' else 'observation')
        elif name=='DRAWICON':
            icon=sm.integer(values[2],minimum=1);require(icon<=30,'图标类型须为1..30')
            emit(i,'icon_anchor',value=sm.numeric(values[1]),icon_id=icon)
        elif name in ('DRAWTEXT','TIPTEXT'):
            require(isinstance(values[2],str),'绘制文字须为文本');emit(i,'text' if name=='DRAWTEXT' else 'tooltip',value=sm.numeric(values[1]),text=values[2])
        elif name=='DRAWNUMBER':emit(i,'number',value=sm.numeric(values[1]),number=sm.numeric(values[2]))
        elif name=='DRAWTEXT_FIX':
            x,y=sm.numeric(values[1]),sm.numeric(values[2]);align=sm.integer(values[3]);require(0<=x<=1 and 0<=y<=1 and align in (0,1),'定点位置须为0..1比例，方向0/1')
            require(isinstance(values[4],str),'定点文字须为文本');emit(i,'fixed_text',x_fraction=x,y_fraction=y,align=align,text=values[4])
        elif name=='STICKLINE':
            width=sm.numeric(values[3]);empty=sm.integer(values[4]);require(width>=0 and empty in (0,1),'柱宽须非负，空心标记为0/1')
            emit(i,'bar_segment',first=sm.numeric(values[1]),second=sm.numeric(values[2]),width_tenths_of_spacing=width,hollow=bool(empty))
        elif name=='HORLINE':
            typ=sm.integer(values[2]);extend=sm.integer(values[3]);require(typ<=4 and extend in (1,2,3),'水平线类型0..4，延长方向1/2/3')
            emit(i,'horizontal_line',value=sm.numeric(values[1]),line_type=typ,extend=extend)
        elif name=='VERLINE':
            typ=sm.integer(values[1]);require(typ<=4,'垂直线类型0..4');emit(i,'vertical_line',line_type=typ)
        out[i]=True
    return out
