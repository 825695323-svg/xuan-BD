# BD AGENTS 会话入口与基础算法统一接口

> 实施状态：本轮代码边界调整，基于 `4527c5a`。保留旧计算证据及原版已发布数据，不做数据迁移。本文件不是计算成功或 WFD 发布验收报告。

## 入口与职责

- **唯一会话入口（BD AGENTS conversation）**：以人工消息为任务起点，沿现有受控工具获取数据、原件和回执，不新增主动调度主体。
- **采集源（Collection Sources）**：使用已注册的 `capture.*.read`、`web.read_public` 或 `web.search`，只返回受控采集结果，不自动清洗或发布。
- **接口源（API Sources）**：沿已有 `source.fetch`、`source.api.read`、`source.kline.read` 等工具得到受控原件及来源回执；不自动运行算法。
- **文件（Files）**：通过 `file.read`、`material.read` 和 `data.processing.*` 识别、按六维路由、固定步骤执行解析→清洗→结构化→标注→核对。
- **原报交接（R1 Structured Handoff）**：必须沿现有发布目的、来源授权、不可变材料身份、WFD 审批和固定读回事实；会话工具目录只读不授予发布权。
- **基础算法（Basic Algorithms）**：新请求仅允许 `kind=fixed_snapshot` 的 WFD 正式数据，人工明确选择算法与版本、输入字段、日期范围、周期及用途；结果只保存在算法原任务，不自动提交 WFD。

## 统一只读发现（Agent discovery）

| 工具动作（Action） | 中文用途 | 影响 |
|---|---|---|
| `bd.session.capabilities` | BD AGENTS 会话入口总目录 | 只读展示既有工具组与边界；不唤醒或调用工具 |
| `algorithms.contract` | 基础算法统一接口契约 | 按 `methodId`（算法编号）读取独立参数、字段、方法版本及真实可用状态 |
| `algorithms.capabilities` | 真实算法运行资格 | 判断 WFD 固定快照读端口和受控运行条件是否可用；不会自动采用 |
| `algorithms.calculate` | 人工触发单次基础算法计算 | 新任务强制 WFD 固定快照、请求身份和现有独立审批；不自动入库 |
| `algorithms.status` | 查询本会话算法结果 | 只核本分支原任务的状态、结果摘要和谱系，不重算 |

所有入口复用已有权限服务、会话分支身份和持久任务，不新建 AGENT 自我授权体系。

## 每个基础算法独立接口

`algorithms.contract` 列出方法编号、所需字段、参数、版本、限制和可用状态。已经受控实现的 `ma`（算术移动均线）、`macd`（指数平滑异同均线）、`bullish_engulfing`（看涨吞没形态）仍使用各自原实现。所有其余登记方法保留独立 `methodId`，未完成接入的一律 `blocked`（不可执行）。

`source_observation_ma`（来源观测均线）已作为基础算法目录中独立的预留方法；**本轮尚未完成旧批次实现改为 WFD 固定快照输入的新计算实现，因此明确显示 `blocked`，不冒充已可计算**。

## 与旧流程的兼容

- 新 `r1_auto_batches` 批次不再接收 `calculation`（旧单次均线参数）或 `algorithmRouting`（旧自动算法路由），返回 `R1_BATCH_ALGORITHM_MANUAL_ONLY`（已改为人工计算）。
- 旧批次记录和均线计算证明允许只读核查，不因重启调度旧派生任务；旧周期设置不得继续更新。
- 新 `LocalAlgorithmService`（基础算法服务）计算拒绝受管原件 `managed_table`，只允许 WFD `fixed_snapshot`（固定快照）；旧已完成任务仍可按原号读取，不会清除历史记录。
- **发布后更正影响已发布派生结果时，暂不自动重算或自动结案**，返回 `CORRECTION_MANUAL_DERIVED_REQUIRED`（需独立人工派生更正）并保持 WFD 用途暂停。完整人工更正协议、观测均线 WFD-only 方法仍需单独实施、验证。
- 历史自动派生测试属于旧功能用例；不改旧冻结数据、不篡改原断言。应迁移为原报自动与人工算法两条独立验收路径。

## 最小执行顺序

1. 人工会话明确采集、接口源或文件任务，获取受管原件与来源证据。
2. BD AGENTS 读取处理能力，路由并执行已有五步加工，保留缺口及原件。
3. 经原 R1 授权完成正式发布与 WFD 固定读回。
4. 人工再次发起计算；BD AGENTS 读取 `algorithms.contract`、`algorithms.capabilities`，按独立方法契约指定 WFD 固定快照与参数。
5. 计算后的新数据保留在原计算任务，独立查看；**正式发布只能再以明确的 R1 请求处理**。

