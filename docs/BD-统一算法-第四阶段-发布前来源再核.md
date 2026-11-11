# Xuan BD 统一算法第四阶段：发布前 WFD 来源再核与 R1 安全接线

## 本次完成

在已有财务/宏观固定行选集与独立数值核验基础上，新增 `verifyUnifiedPolarsForPublication`（统一 Polars 派生发布前核验）。它不是第二套计算或发布者，只负责在已有来源任务正式发送前**重新**读取原 WFD 固定快照，逐个核对来源和结果。

1. `modules/financial/unified-polars-publication-proof.ts`（独立再核对）：对财务 `financial_linear`（单季和近十二个月）复用 `assertFinancialLinearCandidate`（原财务期间算术和单位核验），再对账原计算行版本及 SHA-256；对宏观 `macro_yoy`（宏观同比）复用 `assertMacroYoYCandidate`（精确算术独立核验），重新读取本期/去年同期两条固定版本，核对所有原行数值、来源回执和受信连接身份。
2. 继续复用 `selectWfdFixedRecords`（WFD 固定记录选择器），不会改读 latest（最新指针）或按业务键猜缺失版本。合法业务键 `current`（“本期”字段身份）仍能读取，**只有可变的快照指针**不能作为固定快照。
3. `modules/collection/polars-fixed-service.ts`（旧 Polars 兼容运行时）增加 `verifySourceForPublication`（首次发送前 WFD 来源核实）；财务与宏观通过新再核函数，旧日线计算继续使用原完整系列门禁，不伪造已获得历史时点资格。
4. `modules/collection/r1-structured-handoff.ts`（R1 正式结构化交接）增加受信宿主的可选异步来源核验回调，识别当前请求的原 `polars-stage:<taskId>`（已保管 Polars 候选任务身份），在首次真实 WFD 提交之前调用；外部状态已经 `pending_unknown`（提交结果不确定）时不重新提交或重查来冒充恢复。
5. `modules/collection/r1-workspace.ts`（R1 受控任务）在 `side_effect_started`（外部写入开始记录）之前调用来源再核；原 `submitAndAssociate`（正式发送/核对）也在 `markSending`（发起发送）之前复核，防止直接调用绕过。
6. `modules/collection/r1-runtime.ts`（R1 宿主装配）与 `apps/server/services.ts`（应用服务组合）把真实 Polars 核验器连到 R1 服务。没有新任务表或第二份 WFD 发布内核。

## 失败封闭与兼容

- 冻结快照/产品/业务键/记录版本/来源字节摘要、财务单位、会计期间、宏观公布时间、可信 WFD 连接或执行回执任何一处不一致，**禁止首次正式发送**。
- 旧 R1 独立实例没有新回调时继续保持原同步来源/用途核验，不声称已获得额外现场 WFD 再核；应用正式宿主绑定该回调时才执行新的远端核验。
- 旧原报五步计算任务及历史结果不更名、不删除。现有 `PolarsFixedService`（旧 Polars 运行时）仍用于旧任务；新 `algorithms.calculate`（统一算法新执行入口）尚未完整迁入财务、宏观和来源观测均线，目录保持 `blocked`（未迁移完成）。
- 不将 `snapshot_contents`（固定快照内容）混称为 `market_known_at`（市场当时可知）或 `system_held_at`（系统当时实际持有）。`historyQualification=not_asserted`（未宣称历史资格）会保留。
- 单次再核只读，不在 WFD 或百度网盘执行新增写入；R1 原有的提交身份、权限、用途治理、未知状态恢复和固定读回继续有效。

## 验收记录

- [专项 GitHub Actions #43049990365](https://github.com/825695323-svg/xuan-BD/actions/runs/43049990365)：26 项专项，**26 通过、0 失败、0 跳过**；Node.js 24.22.1、TypeScript 类型检查及生产构建均通过。覆盖 WFD 再核、真实行篡改、相同记录版本不同内容、变更连接和结果、R1 原材料绑定、未决提交不重试及取消信号。
- [全仓诊断 #43050186541](https://github.com/825695323-svg/xuan-BD/actions/runs/43050186541)：529 项，**434 通过、8 失败、87 跳过**，与上一条主分支既有的 8 项失败相比**没有新增失败**。全仓仍未全部通过。
- 真实生产 WFD 数据与正式账号、金融历史资格和交易后续仍未在云端测试机配置，不能将隔离测试等同于生产上线。

## 后续真正未完成的统一执行

1. 将 `financial_linear`（财务单季/TTM）、`macro_yoy`（宏观同比）、`source_observation_ma`（观测均线）作为 `algorithms.calculate`（统一新任务入口）的受控实现接入，而非只列目录。
2. 在统一 `DerivedWfdPublisher`（WFD 派生发布器）中为财务/宏观提供各自的主体、期间、单位与输出结构适配，直接沿 R1 的无五步派生正式提交，不额外走材料保管；必须复用本次实际 WFD 再核和原独立数值核验。
3. 只有上述实现连通且端到端固定读回、失败恢复、历史任务兼容通过后，才合并旧入口禁用和源码去重。草稿 PR #13 不能提前合并。
