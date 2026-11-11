# Xuan BD 统一算法：第二阶段，Polars 宏观同比独立核验

## 目标与范围

第一阶段的 `algorithms.contract`（统一算法目录）已在主分支提供 Python（本机公式计算）与 Polars（本机结构化计算）的同一发现入口。本阶段先补齐 **Polars 宏观同比结果的独立数值核验**，以便后续接入统一 `DerivedWfdPublisher`（WFD 派生发布器）时不绕过真实性与财务/宏观语义检查。

本阶段**没有**把 `macro_yoy`（宏观同比）、`financial_linear`（财务单季与近十二个月）或 `source_observation_ma`（来源观测均线）在 `algorithms.calculate`（唯一新计算入口）中错误标为 ready（可执行）。未实施新任务切换，旧 Polars 计算和历史任务兼容性原样保留。

## 改动明细

1. `modules/collection/data-processing/polars-fixed.ts`（Polars 固定计算适配层）增加 `assertMacroYoYCandidate`（独立宏观同比候选核验），在候选产生后立即重核。
2. 以原 WFD（金融数据仓库）冻结来源身份为前提，核实本期与去年同期两条 `snapshotId/productId/businessKey/recordVersion`（快照/产品/业务键/记录版本）、已冻结原行摘要、系列/地区/单位/基期/季调、起止期间、真实公布时间与 `knowledgeCutoff`（本次校验截止），不从 latest（最新版本指针）选输入。
3. 采用独立 BigInt（精确整数）有理数计算复核 `(current-previous)/previous*100`，按八位小数、half-even（五舍六入、正好一半取偶数）的既有 Polars 口径重算；分母零或负数不伪造为可用百分比，候选状态保持 unknown（未知）。
4. 验证原 Polars 任务真实结果回执的 `workerSha256`（执行器内容摘要）、程序版本、方法、冻结输入摘要、候选结果及 `publication=candidate_only`（尚未正式发布）；任一信息不一致时返回 `POLARS_MACRO_CANDIDATE_CHANGED`（宏观候选内容或证据变化）。
5. `modules/collection/polars-fixed-service.ts`（旧 Polars 任务兼容层）的 `verifyCandidate`（候选审核）也调用同一个核验函数，覆盖准备和 R1（正式结构化交接）首次发送前已存在的核验门槛。财务 `assertFinancialLinearCandidate`（财务期间算术独立核验）与日线完整系列核验继续复用原实现，不重写公式。
6. `polars-eligibility-gate.test.ts`（发布用途资格测试）原合成夹具没有两条真实冻结来源和完整工作器回执，已补成可核验的双版本隔离记录，**未删除或放宽**缺用户用途、缺治理限制与错误数据性质等拒绝断言。

## 测试

- `polars-macro-independent.test.ts`（宏观独立数值测试）覆盖正常同比、零/负基数、单位、来源版本、发布时间、期间、错误回执、篡改结果及精确八位数边界。
- `financial-fixed.test.ts`（财务固定算术）和 `polars-eligibility-gate.test.ts`（共用用途资格）保留现有独立约束。
- CI（自动构建与测试）固定 Node.js 24.22.1，运行 TypeScript 类型检查、前端生产构建与专项测试。

## 重要剩余事项

**这不是统一算法完整上线。**

- Polars 三个方法仍需要按统一算法新任务合同接入 WFD 多来源固定快照读取、任务冻结、执行器授权和 WFD 发布核验。
- 当前的独立宏观候选核验检查持久的来源行与原计算回执的一致性，**尚未在正式发布时额外重新从 WFD 查询所有源行**。不能把原回执里的 `selectedSha256`（原所选行摘要）直接当成现场再次读取的证明。
- `DerivedWfdPublisher`（派生发布器）当前主要覆盖行情算法，宏观与财务的业务主体、单位、期间与输出格式适配还需要开发和真实固定读回验收。
- 正式 WFD、历史 SQLite（本地数据库）和用户文件未被本批代码修改；旧宏观结果仍可只读，缺完整冻结证据的旧候选不能在新核验边界下冒充可发布。
