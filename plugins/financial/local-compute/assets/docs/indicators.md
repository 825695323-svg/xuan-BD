> 本交付保留方法和字段契约；文中历史样例路径只作格式参考，本包不携带逐股样本。统一命令及当前验证范围见外部说明.txt。

# 日线指标契约

本模块提供 22 个有限日线计算。调用 `calculate.py --request examples/indicators/MA.normal.json` 可运行示例。请求为 `version=1`、`kind="indicator"`、`operation`、必填对象 `params`，以及 `data` 或相对于请求文件的 `data_file`。正常和错误请求各 22 件，关键预期值见 `examples/indicators/expected.json`。正常例使用随包固定数据库样本；边界例明确使用人工合成数据。

`data={metadata,rows}`。元数据须声明序列、日频、时区、价格单位、复权类别与依据、窗口首尾，以及所供观测连续。日期严格递增且唯一。价格为正有限数；成交量为非负有限数，并声明 `volume_unit`（成交量单位）。本模块不排序、不补日、不复权、不换量单位。`observations_are_consecutive`（所供观测连续）不证明完整交易日历，也不证明历史时点可得性。

所有指标都需要 `timestamp`（观测日期）和 `close`（收盘价）。额外必需列见下表。`high`、`low`、`open`、`volume` 分别为最高价、最低价、开盘价、成交量。CCI 的高低价可缺失或空值，逐个以当期收盘价代替；其余需要高低价的指标禁止这种替代。任何已给出的价格和量仍须通过行情校验。

`MA(X,N)`（简单移动平均）、`SUM(X,N)`（滚动和）、`HHV(X,N)`（滚动最大值）、`LLV(X,N)`（滚动最小值）仅使用完整 N 条所供观测。`REF(X,N)`（向前引用）缺历史时为空。`AVEDEV(X,N)`（平均绝对偏差）为窗口内各值到窗口均值的绝对偏差之平均。价格差保持输入价格单位，乘以 100 的比率使用百分数，OBV 的特殊单位另行声明。

## 参数与输出

表中参数未特别标“必填”时可省略，使用列出的默认值。周期须为正整数且拒绝布尔值；数组长度固定。下列 `init`（初始化规则）均须调用者明确提供，不能省略。

| operation（计算标识） | params（参数） | 额外必需列 | 输出与定义 |
|---|---|---|---|
| MA | `period` 必填 | 无 | `MA=MA(close,period)` |
| BBI | `periods=[3,6,12,24]`，恰好 4 项 | 无 | `BBI` 为四条均线的算术平均；`CLOSE` 为输入收盘价 |
| BIAS | `periods=[6,12,24]`，恰好 3 项；`lower=-3,upper=3` 为有限数 | 无 | `BIAS,BIAS2,BIAS3=100*(close-MA(close,N))/MA(close,N)`；`LOWER,UPPER` 为参数常量线 |
| MTM | `period=12,average_period=6` | 无 | `MTM=close-REF(close,period)`；`MAMTM=MA(MTM,average_period)` |
| ROC | `period=12,average_period=6` | 无 | `ROC=100*(close-REF(close,period))/REF(close,period)`；`ROCMA=MA(ROC,average_period)` |
| MACD | `short_period=12,long_period=26,signal_period=9`；显式 `init="first_valid"` 或绑定状态 | 无 | `DIFF=EMA(close,short)-EMA(close,long)`；`DEA=EMA(DIFF,signal)`；`MACD=2*(DIFF-DEA)`；`ZERO=0` |
| RSI | `periods=[6,12,24]`，恰好 3 项且各≥2；显式初始化或绑定状态；可选 `previous_close>0` | 无 | 三条 `RSI1,RSI2,RSI3=100*SMA(max(delta,0),N,1)/SMA(abs(delta),N,1)`；`delta=close-previousClose`；`LOWER=20,UPPER=80` |
| EMA | `period` 必填；显式初始化或绑定状态 | 无 | `EMA` 使用 `alpha=2/(period+1)` 递推 |
| SMA | `period,weight` 必填且 `period>weight>0`；显式初始化或绑定状态 | 无 | `SMA` 使用 `alpha=weight/period` 递推；这不是简单移动平均 |
| TRIX | `period=12,average_period=20`；显式初始化或绑定状态 | 无 | `TR=EMA(EMA(EMA(close,N),N),N)`；`TRIX=100*(TR-REF(TR,1))/REF(TR,1)`；`TRMA=MA(TRIX,average_period)` |
| KDJ | `period=9,k_period=3,d_period=3`，各≥2；必须 `init="first_valid"` | high、low | `RSV=100*(close-LLV(low,N))/(HHV(high,N)-LLV(low,N))`；`K=SMA(RSV,k_period,1)`；`D=SMA(K,d_period,1)`；`J=3*K-2*D` |
| BOLL | `period=20,width=2`，width>0；`ddof` 必填且为 0 或 1，period>ddof | 无 | `MID=MA(close,N)`；`UPPER/LOWER=MID±width*STD(close,N,ddof)` |
| ATR | `period=14`；可选 `previous_close>0` | high、low | `TR=max(high-low,abs(high-previousClose),abs(low-previousClose))`；`ATR=MA(TR,N)`，是简单移动平均 |
| OBV | `average_period=30`；`start,initial_obv` 必填；按起点要求可给 `previous_close>0` | volume | `OBV=initial_obv+累计(sign(close-previousClose)*volume)/10000`；`MAOBV=MA(OBV,average_period)` |
| CCI | `period=14` 且≥2 | 无；高低价可缺失 | `TYP=(coalesce(high,close)+coalesce(low,close)+close)/3`；`CCI=(TYP-MA(TYP,N))/(0.015*AVEDEV(TYP,N))`；`UPPER=100,LOWER=-100` |
| PSY | `period=12` 且≥2；可选 `previous_close>0` | 无 | `PSY=100*COUNT(close>previousClose,N)/N`；仅输出这一条线 |
| ARBR | `period=26,lower=70,upper=150`；可选 `previous_close>0` | open、high、low | `AR=100*SUM(high-open,N)/SUM(open-low,N)`；`BR=100*SUM(max(high-previousClose,0),N)/SUM(max(previousClose-low,0),N)`；`LOWER,UPPER` 为常量线 |
| MFI | `period=14`；可选 `previous_typical_price>0` | high、low、volume | `TYP=(high+low+close)/3`；正资金流取 TYP 上涨时 TYP×volume，负资金流取下跌时 TYP×volume，持平取 0；`V1=SUM(正资金流,N)/SUM(负资金流,N)`；`MFI=100-100/(1+V1)` |
| DMI | `period=14,average_period=6`；可选前收盘、前高、前低须三者同时给出 | high、low | 见下文完整定义；输出 `DI1,DI2,ADX,ADXR` |
| EMV | `period=14,average_period=9`；可选 `previous_high_low_sum>0` | high、low、volume | 见下文完整定义；输出 `EMV,MAEMV` |
| EXPMA | `periods=[5,10,20,60]`，恰好 4 项；显式初始化或绑定状态 | 无 | `MA1,MA2,MA3,MA4=EMA(close,对应周期)`，四条线均为指数平滑 |
| CDP | 可选 `previous_high,previous_low>0` 须成对，前高≥前低 | high、low | `CDP=(当期high+当期low+2*当期close)/4`；`PT=前high-前low`；`AH=CDP+PT,AL=CDP-PT,NH=2*CDP-当期low,NL=2*CDP-当期high` |

DMI 的完整定义为：`TRSUM=SUM(max(high-low,abs(high-previousClose),abs(low-previousClose)),N)`；`HD=high-previousHigh`；`LD=previousLow-low`；`DMP=SUM(HD>0且HD>LD时HD，否则0,N)`；`DMM=SUM(LD>0且LD>HD时LD，否则0,N)`；`DI1=100*DMP/TRSUM`；`DI2=100*DMM/TRSUM`；`ADX=MA(100*abs(DI2-DI1)/(DI1+DI2),average_period)`；`ADXR=(ADX+REF(ADX,average_period))/2`。HD 与 LD 相等时两边贡献都为 0。前值三件对应参数名为 `previous_close,previous_high,previous_low`，并须满足前低≤前收盘≤前高。

EMV 的完整定义为：`VOLUME=MA(volume,N)/volume`；`MID=100*(high+low-previousHighLowSum)/(high+low)`；`TEMP=MID*VOLUME*(high-low)`；当期 high=low 时 TEMP 明确覆写为 0；`EMV=MA(TEMP/MA(high-low,N),N)`；`MAEMV=MA(EMV,average_period)`。日成交量为 0 且当期振幅非零时该项不能定义；整个振幅窗口为零也不能定义。这里的 `previous_high_low_sum`（前高低价之和）仅补首条历史上下文，不改变后续观测。

## 起点、递推与空值

递推定义为 `Y=alpha*X+(1-alpha)*previousY`，实现采用等价的 `previousY+alpha*(X-previousY)`，使常量序列保持不漂移。`init="first_valid"`（首个有效输入作种子）把首个可计算 X 直接用作 Y；它是一项显式研究规则，不构成任何外部程序默认值的等价证明。KDJ 的 K、D 从第一个完整且非零区间的 RSV 开始；不会填入 50。RSI 缺首条前收盘时先输出空值，下一条变化才可建立首个种子；不把首条涨跌填 0。TRIX 首条变化率仍缺前一个三重 EMA，输出空值。

递推输入的前缀空值延迟初始化；建立递推后出现未知输入，会使该递推及依赖输出从该处起无法确定，不会跳过、重置或冻结成伪有效结果。输出不给有效末状态时，不能据此继续递推。非递推的有限滚动窗口在未知值离开窗口后可以重新有效。

ATR、PSY、ARBR、MFI、DMI、EMV 没有首条所需历史上下文时，首项依赖量为空，并继续按完整窗口传播；如 ATR 周期为 14 且没给前收盘，首个 ATR 在第 15 条观测才出现。CDP 的中轴、NH、NL 在首条仍可计算，只有 AH、AL 缺前期振幅。提供的前值须与当前数据有相同单位、复权依据并代表紧邻上一条观测；本模块无法独立证实这种声明。

OBV 的 `start="first_close_baseline"`（第一条收盘作累计基准）不接受前收盘，第一条 volume 不参加累计，第一条 OBV 就是明确给定的 initial_obv。`start="before_first_observation"`（第一条之前已有基准）必须给 previous_close，第一条 volume 正常参加涨跌方向累计。`initial_obv` 直接使用输出单位 `volume_unit/10000`，不是未缩放量。样本量单位若为“手”，输出即“手/10000”，不会自动转换成股。价格持平时有符号量严格为 0。不同起点产生不同绝对值；不得把窗口累计当成全历史累计。

零分母输出 JSON 的 `null`（空值）并记录诊断。RSI 的连续平盘不填 50；MFI 负资金流为零时不以极限值 100 替代；CCI 的平均绝对偏差为零、KDJ 区间为零、DMI 分母为零均遵循同一规则。所有可交付数值必须有限；数值溢出会拒绝请求。

STD（标准差）明确定义为 `sqrt(sum((X-窗口均值)^2)/(N-ddof))`。`ddof=0`（总体自由度修正为零）和 `ddof=1`（样本自由度修正为一）都可选，BOLL 必须明确给出。结果不宣称任何外部程序的默认自由度。

## 有限递推状态

EMA、SMA、MACD、RSI、TRIX、EXPMA 可接收顶层 `state`（上期递推状态），此时不得再给 init。KDJ 仅支持完整批计算初始化，拒绝只给 K、D 的续算状态。其他指标不接收 state。

状态严格包含 `operation,parameters,metadata,previous_timestamp,is_immediately_prior,values`。parameters 必须等于输出 method.parameters 中归一化后的计算参数；metadata 必须逐项等于当前 `series_id,frequency,timezone,price_unit,adjustment,adjustment_basis`，以及当前已声明的 `volume_unit,amount_unit,field_units`（数量、金额和附加列单位）。previous_timestamp 须早于首条输入；`is_immediately_prior=true`（调用者声明紧邻前项）必须如实保持，日期比较本身不能证明交易日连续。

values 的字段为：EMA/SMA 的 `previous`；MACD 的 `ema_short,ema_long,dea`；RSI 的 `gain1,absolute1,gain2,absolute2,gain3,absolute3,previous_close`；TRIX 的 `ema1,ema2,ema3`；EXPMA 的 `ema1,ema2,ema3,ema4`。值均须为有限数；价格均值状态须大于0，DEA可为正、零或负；RSI 的 gain、absolute 非负且 gain≤absolute，previous_close>0。RSI 使用状态时前收盘已经在状态中，禁止在参数中重复给出。

返回 state 只保存递推层。TRIX 的 TRMA 使用当前请求内的完整滚动窗口；状态不携带前段 TRIX 窗口，因此续算开头 TRMA 可以为空。EMA/SMA/MACD/RSI/EXPMA 的递推输出可按匹配的上期状态续接。不能把所有输出一概称为分段等价。状态不包括账户、订单、执行记录或服务绑定。

## 输出与验证边界

`rows`（结果逐条记录）保留输入日期，`diagnostics`（诊断）列出空值及零分母，`method`（方法说明）包含归一化参数、精确定义、初始化规则和窗口策略。常量线只是数值参考，不自动产生买卖信号。主入口追加执行标志为 false。

随包三份数据库样本各 300 条，覆盖 22×3 次运行。独立复算和手算边界可运行 `python3 -B verification/indicators_math.py`；该检查使用十进制高精度闭式权重、标准统计函数和手工预期，验证数学定义及关键前缀，不证明市场效果、历史时点可得性或任何未声明的外部默认行为。
