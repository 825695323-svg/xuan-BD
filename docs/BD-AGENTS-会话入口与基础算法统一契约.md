# BD AGENTS 会话入口、基础算法与 WFD 派生写回

> 本文描述目标架构与本次代码实现边界。未通过完整集成验收的部分不能宣称已发布到 WFD。

## 唯一操作入口

BD AGENTS 会话工具负责采集、数据源、文件识别加工、算法调用与派生数据的受控发布。前端只读展示算法目录、运行状态和有限结果。AGENTS 不自我唤醒、不获得 WFD 准入权；现有 TaskService（任务持久服务）与审批回执仍是唯一执行权威。

## WFD → 算法 → WFD

1. `bd.session.capabilities`（会话工具目录）与 `algorithms.contract`（基础算法统一契约）供 AGENTS 只读发现。
2. `algorithms.calculate`（执行某个独立算法），参数从 `algorithms.capabilities` 读取。新计算只能使用 WFD `fixed_snapshot`（固定快照）及明确产品、定义、字段、时间与用途。算法层不提供任何文件直读或 WFD 写入特权。
3. `algorithms.stage`（派生新数据保管）只能从本会话已完成算法的**真实结果行**创建受管材料，按原计算任务、输入快照、算法版本、结果摘要绑定；不能由模型上传任意行替换。该步仅保管，**不构成 WFD 发布**。
4. `data.processing.capabilities`、`data.processing.plan`、`data.processing.run`（五步处理工具）用于生成真实结构化候选、标注 `deterministic_derived`（确定性派生）、明确用途与来源依据。任何不齐全的业务语义或未通过的计算资格仍为缺口。
5. `data.r1.prepare_derived`（派生交接准备）校验本会话原算法及加工输出，核对定义中的 `algorithm_definition`（算法定义）与原 `method_id`（方法编号）、`method_version`（方法版本）、`implementation_version`（实现版本）、`input_digest`（输入摘要）逐项相同。只能沿现有 `R1WorkspaceService.prepareWithRestriction`（受控用途限制预检）准备。
6. `data.r1.submit`（正式交接）要求独立审批，核已冻结请求编号及文档摘要，仍由 WFD 受理、发布和固定读回；结果未知按原请求恢复，不能换号重试。只有 `state=associated`（正式关联完成）且固定读回一致才能报告入库完成。

## 每个算法独立接口

每个受控方法有自身 `methodId`、输入字段、参数、方法版本与实现版本，公用只读契约，互不混合实现。当前注册并可被本地受控执行器支持的首批方法为 `ma`（算术移动均线）、`macd`（指数平滑异同指标）、`bullish_engulfing`（看涨吞没）。`source_observation_ma`（观测均线）是基础算法目录一节，但**其 WFD-only 实现尚未完成**，在能力目录中为 `blocked`（不可执行）；不得退回旧批次自动均线途径。其他已登记但未放行的方法同样只读展示。

## 去除旧路径与数据安全

- 新原报批次禁止提交 `calculation` 与 `algorithmRouting`（旧自动均线设置），无自动派生计算或入库。
- 前端算法面板和 HTTP 计算路由不提供新的人工计算、候选保管或准备提交操作；只读显示真实算法目录和已有任务。
- 原批次历史自动算法兼容展示项从算法目录移除。不得通过本轮修改擦除 WFD 历史已发布快照，也不得破坏未决提交的身份。
- 旧输入的实际计算、旧派生自动恢复与旧批次自动计算路径保持禁用；保留的阻断提示不构成兼容执行。
- 已发布派生的更正若需要重新计算，仍受 `CORRECTION_MANUAL_DERIVED_REQUIRED`（派生结果需另行处理）保护；**该更正闭环尚未接通 AGENTS 派生写回，不能以本轮改动宣称已解决。**

## 当前验收状态

本轮提交了接口和拒绝边界，但尚不能证明完整的 WFD→计算→派生保管→五步加工→R1→WFD 整链已在真实端到端服务中通过。所有新路径必须验证成功、拒绝、权限取消、崩溃恢复、版本冲突及固定读回。
