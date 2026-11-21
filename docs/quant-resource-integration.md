# 已接入的量化数据源与算法资源

本次在既有来源配置、TaskService、算法目录和 R1/WFD 固定读取上增加可调用实现。参考项目固定为 [henrylin99/quantitative_analysis@2edbc3eaf799f4d8f42c99fccba3b8fc08554f10](https://github.com/henrylin99/quantitative_analysis/tree/2edbc3eaf799f4d8f42c99fccba3b8fc08554f10)。下表记录已实现内容；批量历史包、研报全文、事件归档、参数寻优和收益归因尚未包含在此增量中。

| 能力 | 实际入口 | 实现与产物 |
| --- | --- | --- |
| TickFlow 无密钥历史日线 | `source.kline.read` / `daily_bars` | 沪深京代码、明确日期窗、不复权；原始响应、日线字段投影、摘要和来源回执 |
| 东方财富研报列表 | `source.api.read` / `research_reports` | 行业、个股、策略、宏观、新股五类；单次显式分页、机构／作者／评级、原始发布时间、详情和附件定位 |
| 东方财富策略／宏观详情 | `source.api.read` / `research_report_detail` | 保留 HTML 原件并定位固定格式 PDF；附件下载和正文处理另用现有文件能力 |
| 扶摇三类财报 | `source.api.read` / `financial_statements` | 利润表、资产负债表、现金流量表，复用已有 `ths` 连接和凭据；保留来源报表值和时间精度 |
| 五个 Alpha191 固定公式 | `algorithms.calculate` | 既有 Python 标准库执行器、独立 TypeScript 数值核对、固定 WFD 输入和原发布通路 |
| 声明式截面筛选 | `algorithms.screen` | 完整有界 WFD 固定读取后执行 `filter + orderBy + topN`；返回候选、排除计数和记录引用 |

本次没有新增运行依赖。已有 Python、TypeScript、HTML 解析器、任务服务和授权接口继续使用。

## 1. 来源配置与调用

在现有来源设置中选择范围 `CN/A_STOCK`，按操作配置主源及备用源。TickFlow 首次升级仅登记禁用连接，明确启用并选入 `daily_bars` 后才会使用；保存后删除该连接会得到保留。东方财富研报使用已有 `eastmoney` 连接，扶摇财报使用已有 `ths` 连接。使用无密钥来源无需本机钥匙串程序。

以下代码块分别是工具 `parameters` 文本框中的 JSON 内容。证券与日期仅用于说明请求格式；条数、页数等上限属于本工具的单次资源预算，不代表供应商公开额度。

### TickFlow 日线

动作 `source.kline.read`，`scopeId=CN/A_STOCK`，`operation=daily_bars`：

```json
{
  "symbol": "600000.SH",
  "start": "2026-11-09",
  "end": "2026-11-13",
  "adjustment": "none",
  "limit": 5
}
```

`limit` 必须显式提供，范围 1–10000。日期接受 `YYYY-MM-DD` 或 `YYYYMMDD`。返回的日线保留原始成交量和成交额，并标记 `native_unverified`；必须在后续语义核对中确认单位。行数达到 `limit` 不证明日期窗完整，也不会自动请求下一批。

### 东方财富研报

动作 `source.api.read`，`scopeId=CN/A_STOCK`，`operation=research_reports`：

```json
{
  "category": "industry",
  "start": "2026-11-09",
  "end": "2026-11-13",
  "page": 1,
  "pageSize": 20
}
```

类别为 `industry`、`stock`、`strategy`、`macro`、`new_stock`。其中 `stock` 还须提供完整证券代码 `symbol`，其他类别不接受该字段。个股请求由适配器构造成已登记端点上的 JSON POST，经过与 GET 相同的公开地址解析、IP 固定和网络授权。

`page` 范围 1–10000，`pageSize` 范围 1–100。每个调用只取一页；返回总数、页号、下一页与分页声明，缺失信息保持未知。发布时间同时保留 `publish_time_raw`、日期投影和来源精度，不把日期提升为精确公开时刻。

列表存在 `infoCode` 时直接给出附件定位。策略／宏观条目只有 `encodeUrl` 时，可显式调用 `operation=research_report_detail`，参数为 `{"category":"strategy","encodeUrl":"从原列表取得的真实值"}`。此动作保留详情原件并定位 PDF，尚不构成全文取得、OCR 或内容清洗。

### 扶摇财报

动作 `source.api.read`，`scopeId=CN/A_STOCK`，`operation=financial_statements`：

```json
{
  "thscode": "600000.SH",
  "statement": "income",
  "period": "quarterly",
  "limit": 4
}
```

`statement` 为 `income`、`balance_sheet` 或 `cash_flow`，`period` 当前必须显式为 `quarterly`，`limit` 范围 1–20。请求使用现有 `https://fuyao.aicubes.cn` 连接；密钥仍取自已配置安全引用。HTTP 成功之后还核对业务 `code`，`4001` 限流停止当前任务。

返回保持 `source_reported_not_single_quarter_or_ttm`：报表原值可能包含累计口径，本适配器不直接声称其为标准单季或 TTM。公告时间和历史可见性继续交由既有证据及 WFD 历史规则核定。本轮没有供应商密钥，财报完成了请求与解码测试，未进行实际账号取数。

### 原件与失败处理

来源调用沿原 TaskService 保管原始字节、文件引用、摘要、尝试记录和回执。原始响应先保留，再检查 HTTP／业务状态及字段。配置变更、停用、取消、限流和不完整响应会阻止相应读取；读取动作不会自行发布 WFD。

主源失败后，明确配置的合格备用源可以完成请求。失败原件继续作为尝试审计保留，成功候选证据和受信回执只接纳可以精确关联到成功来源的原件。

## 2. 固定公式

先调用 `algorithms.contract` 取得实际方法、字段和参数合同，再使用已有 `calculationJson` 请求结构调用 `algorithms.calculate`。本次五个方法均使用空参数对象 `{}`，周期与数学定义随方法版本固定。

| methodId | 公式 | 首个有效结果之前的空行 |
| --- | --- | --- |
| `alpha191_014` | `C[t] - C[t-5]` | 5 |
| `alpha191_031` | `100 * (C[t] - MA12(C)[t]) / MA12(C)[t]` | 11 |
| `alpha191_116` | 最近 20 条收盘观测对序号 `1..20` 的含截距 OLS 斜率 | 19 |
| `alpha191_168` | `-V[t] / MA20(V)[t]` | 19 |
| `alpha191_189` | `MA6(abs(C - MA6(C)))`，每个偏离使用其自身时点均值 | 10 |

输入继续要求固定 WFD 快照、字段映射、已核定价格及成交量单位、日历和历史用途。168 的成交量全窗口为零时返回空值和诊断；缺值不补零。116 的斜率以观测步为横轴，不年化。189 需要十一条收盘观测才产生首个有效结果。

实现见 [算法定义](../modules/financial/algorithm-types.ts)、[Python 执行器](../plugins/financial/local-compute/assets/indicators.py)、[独立数值核对](../modules/financial/algorithm-reference.ts)。计算结果沿原独立核对和 R1 发布能力返回，本次集成没有改写已有 MACD 定义。

## 3. 声明式截面筛选

发现合同：`algorithms.contract`，参数 `methodId=strategy_screen`。执行：`algorithms.screen`，唯一参数 `screenJson` 是以下 JSON 的文本。下列快照、产品、字段和阈值为明确的合成格式示例，须替换为实际已存在且获准读取的固定数据。

```json
{
  "snapshotId": "synthetic-snapshot-1",
  "productId": "synthetic-factor-table",
  "historyMode": "snapshot_contents",
  "selection": {
    "dateField": "trade_date",
    "date": "2026-11-13",
    "dateFormat": "YYYY-MM-DD"
  },
  "keyField": "code",
  "factorNames": ["momentum", "quality"],
  "filter": "quality > 0 and momentum > 0",
  "orderBy": "rank(momentum) + rank(quality)",
  "topN": 10
}
```

规则支持数值、因子、四则运算、比较、`and/or/not`、括号和截面 `rank()`，通过有限语法树执行。排序默认分数降序、标的键升序；并列排名采用平均名次除以有效操作数数量。`rank()` 先在完整选定截面计算，再应用过滤，不能仅对第一页或过滤后样本排名。

日期与标的键必须有效；同日同标的多行须先解决版本或口径冲突。WFD 明确报告的 `reported_zero` 零值正常参加过滤和排名；缺失值、无效值、除零、溢出及单位冲突有明确拒绝或排除结果，`not`、`!=`、`or` 不能把缺值变成有效命中。字段值按 float64 研究计算，结果不是数据库中的精确十进制原值替代品。

默认 `readMode=product` 使用已有 R1 产品固定读取，完整分页后筛选显式日期。明确的索引文本表可用 `readMode=indexed`，只支持 `snapshot_contents`。历史研究使用 `market_known_at` 或 `system_held_at`，须明确秒级 UTC `at`；系统持有视角还需要 `heldScope` 与 `usableStage`。历史资格由原 WFD 读取实现核验，确定排除的未来修订等原诊断随 `fixedRead.historicalExclusions` 返回；不确定资格或未知诊断仍拒绝。

读取最多 100 页、10000 行、16 MiB、60 秒；返回最多 1000 个候选，并受完整结果字节预算约束。预算不足、分页不完整、游标重复或身份变化直接失败。`fixedRead` 保留固定快照、产品、连接、查询摘要、字段单位、输入投影摘要和入选记录引用；完整性仅指所选产品／标的集合，不代表全市场覆盖。

工具沿现有 AGENTS 发现、`perform_action`、TaskService 和会话授权入口执行。它返回研究候选，运行权限继续服从原计算模块启停及规则版本；无需额外 Python 进程。

## 4. 验证记录与复现

使用资源锁内的 Node 24.22.1、npm 11.19.1、Python 3.12.15。新增和受影响测试涵盖来源请求／解码、原件与回执、来源配置迁移、独立公式核对、真实会话工具调用以及 WFD 分页与历史模式；底层网络和 WFD 内容使用明确标注的合成夹具，运行根相互隔离。

2026-11-21 另外进行了两个最小公开端点探针，并用新增解析器核对真实响应：

| 端点探针 | 结果 | 原件 SHA-256 |
| --- | --- | --- |
| TickFlow：`600000.SH`，2026-11-09 至 2026-11-13，5 条 | HTTP 200，361 字节，5 条日线 | `3ccc1c8bb4b31bd2e4ff10fdbe964473c500f6798b256900016e7080c1225bad` |
| 东方财富：行业研报，2026-11-09 至 2026-11-13，第 1 页、每页 2 条 | HTTP 200，2575 字节，2 条；来源声明共 230 条、115 页 | `0f10bfcb8ef3b45ef00fc32887ec1e0c42992387d36efd2592b47ff4cffbe643` |

探针只验证当次网络响应和解析，不等同于所有类别、全历史覆盖、当前账号权限或正式 WFD 发布验收。原件为本轮临时验证材料，未写入生产数据库。扶摇真实财报读取、PDF 正文取得和真实生产 WFD 运行未计作通过。

锁定工具链进入 `PATH`、`WFD_PYTHON` 指向锁定解释器后，可运行以下受影响范围测试：

```sh
node --import tsx --test plugins/api-sources/providers/tickflow/api.test.ts plugins/api-sources/providers/eastmoney-reports/api.test.ts plugins/api-sources/providers/ths/requests.test.ts plugins/api-sources/reused-sources.test.ts
node --import tsx --test modules/financial/reused-quant-factors.test.ts modules/financial/unified-indicators.test.ts modules/financial/derived-wfd-check.test.ts
node --import tsx --test modules/financial/strategy-screen.test.ts modules/financial/strategy-screen-wfd.test.ts
```

另将 `XUAN_FULL_CHAIN_ROOT` 指向本轮新建的隔离测试父目录，运行 `node --import tsx --test apps/server/strategy-screen-model-tool.test.ts apps/server/endpoint-adapter-receipt.test.ts`，可核查真实会话入口和 TaskService 回执消费。测试使用合成底层传输，不调用用户的真实来源或生产 WFD。

完整工程门禁仍按 [AGENTS.md](../AGENTS.md) 执行；最终执行结果以提交说明／PR 中的实际记录为准。Linux 全量回归没有在本次增量中默认启动。

## 5. 参考与采用方式

参考文件为固定提交中的 `fuyao_client.py`、`tickflow_client.py`、`eastmoney_report_client.py`、`research_report_service.py`、`alpha191_formulas.py` 和 `strategy_dsl.py`。来源适配使用端点及字段协议，公式与规则按明确数学／语义要求在本项目既有框架中实现，没有整段迁入上游自动化、缓存、交易或服务代码。

上游 README 声称 MIT，但本次固定提交树未找到 LICENSE/COPYING 文件，Alpha191 文件另称从未提供可核查许可的项目整体迁入。因此本记录不声称已经确认完整许可链；以后提取实际源码或前端组件仍须保存并核对相应许可及版权声明。
