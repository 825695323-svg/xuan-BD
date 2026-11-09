# 本地数据接入与转换

本文件说明现存计算资产的实现契约；[代码资产目录](../能力目录.json)不代表应用已放行全部操作，实际可调用范围以[受控登记](../../../../../modules/financial/algorithm-registry.ts)及当前采用状态为准。

`kind="data"`（本地数据操作）提供七个操作，均拒绝状态字段。只读取请求指定的本地文件或记录，返回规范结果；不会查询账户、更新数据库或启动后台服务。统一文件与错误规则见[统一计算入口](../calculate.py)。

## 日线、快照与回放

`normalize_bars`（日线字段规范化）要求参数 `fields`（字段映射）、`date_format`（日期格式）及 `price_transform`（价格变换）。映射必须包括 `timestamp,open,high,low,close`（日期、开高低收），可选 `volume,amount,price_factor`（成交量、成交额、逐行价格因子）；映射列不能重复。日期格式仅为 `%Y-%m-%d`（横杠年月日）或 `%Y%m%d`（紧凑年月日）。

输入数据为 `{metadata,columns,records}`（元数据、显式列名数组、记录数组）；每条记录的列须与声明列完全一致。也可用 `{metadata,csv_file}`（元数据、本地CSV文件路径）交给统一入口读取表头。仅此操作支持CSV文件。数字字符串可以转换；非有限数、布尔数、重复日期、乱序、矛盾四价会被拒绝。可选量额缺失保留空值；映射了量额列就必须声明对应单位，即使该列全空。

`price_transform="none"`（不变换）直接保留映射的完整四价，适用于已明确口径的原始或预计算价格。`price_transform="factor"`（按因子变换）要求输入声明未复权，必须映射正数 `price_factor`，并给出 `output_adjustment`（输出前复权或后复权）与 `output_adjustment_basis`（输出口径依据）。同一条的四价统一乘同一个因子，成交量和成交额不变换。该操作不计算除权事件、不核实因子经济含义；输入已经复权时禁止重复应用因子。

`daily_snapshot`（日线末条快照）的参数为空对象，输入为标准日线数据。返回最后一条收盘及已有开高低、量额；`previous_observed_close`（前条所供收盘）来自倒数第二条，一条数据时为空。它不是已独立核实的交易所昨收。`is_realtime=false`（不是实时行情）始终明确返回。

`replay_daily`（逐条日线回放）需要 `at_time`（严格的本地时分秒）、`start_seq`（正整数起始序号）、`quantity_unit`（后续动作数量单位）。每条日收盘生成一个带时区的价格事件。15:00之类时间是调用者指定的观察标记，不证明历史中在该时刻已收到完整日线。返回结果保留 `metadata`（事件元数据）和 `rows`（事件数组）。纯迭代接口 `iter_daily_observations`（逐条观测迭代器）也只消费已提供数据。

## 报价、持仓与委托记录

三种记录规范化操作共用 `params.fields`（显式映射）及布尔参数 `key_is_id`（记录键是否就是标识）。假时输入 `records`（记录）为数组并映射标识字段；真时输入为按标识键控的对象，不再另行映射标识。额外未映射列可存在，但不会自动推断它们的含义。输出标识不得重复。

元数据必须提供 `snapshot_at`（含偏移的快照日期时间）、`timezone`（有效IANA时区）、`price_unit`（价格单位）；持仓及委托另需 `quantity_unit`（数量单位）。报价涉及量额时给 `volume_unit/amount_unit`（量额单位）。这些操作只规范快照字段，不证明其时效或价格调整口径。

| 操作 | 必需映射 | 可选映射与约束 |
|---|---|---|
| `normalize_quotes`（报价记录规范化） | `symbol,price`（证券标识、价格） | `previous_close,open,high,low,volume,amount`（昨收、开高低、量额）；未提供保留空值。部分高低价也检查与当前价及开盘价的关系。输出明确为所供记录快照，实时标志为假。 |
| `normalize_positions`（持仓记录规范化） | `symbol,quantity,available_quantity,average_cost`（标识、持有量、可用量、成本） | 非负整数数量，可用量不超过持有量；有仓有正成本，零仓成本为空。整数文本直接解析，不先转浮点数。 |
| `normalize_orders`（委托记录规范化） | `order_id,symbol,side,quantity,filled_quantity,status`（委托标识、证券、方向、委托量、成交量、状态） | `limit_price`（可选限价）；方向为 `buy/sell`（买/卖）；成交量不能超过正委托量。 |

委托状态为 `pending`（待成交）、`partially_filled`（部分成交）、`filled`（已全成）、`cancelled`（已取消）、`rejected`（已拒绝）、`unknown`（未知）。其他输入状态必须通过 `status_map`（显式状态映射）转换。全成须数量相等，部分成交须介于零和委托量之间，待成交或已拒绝不得带已成交数量；已取消可保留其先前部分成交量。规范化不把“委托已受理”推断为成交，也不独立验证外部状态。

## 显式字段筛选

`filter_rows`（条件筛选）输入 `{metadata:{dataset_id},records}`（数据集标识和记录数组）；参数为 `combine`（`all`全满足或`any`任一满足）以及非空 `conditions`（条件数组）。每个条件严格包含 `field`（字段）、`operator`（比较符）和 `value`（比较值）。

数值支持 `eq/ne/gt/ge/lt/le`（等于、不等于、大于、不小于、小于、不大于）；文本只支持等于和不等于。空值、缺字段和类型不匹配使该条件未知；数值字符串不会自动当成数值。全满足模式中明确假可决定整行不匹配，其余有未知则未知；任一满足模式中明确真可决定整行匹配，其余有未知则未知。

匹配行在 `rows`（选中行），未知行在 `unknown_rows`（未定行），逐行判断在 `evaluations`（判断明细）。这里不执行文本公式，也不计算财务比率。低市净率、净资产收益率等筛选须先有经过语义、单位、报告期和披露时点核实的字段。
