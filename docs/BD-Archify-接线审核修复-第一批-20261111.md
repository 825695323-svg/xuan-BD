# BD Archify 审核：接线与引用守卫修复第一批（2026-11-11）

## 审核基线与范围

- 原主分支：`cc7a4de2f3d8587d16c3d9527b2945ad5712ce4d`
- 审核图：`audit/archify-code-review-20261111`（Archify 来源锁定图和全仓探针）
- 本批只修已由源码/真实宿主复现的入口断点、SQLite（本地数据库）字段不匹配、Linux（操作系统）原生可选包选择、版本指纹覆盖和候选清理未决任务保护。
- 不触碰历史用户数据、百度网盘文件、WFD（金融数据仓库）正式快照，也不取消原有权限审批。

## 代码变更

| 模块 | 真实问题 | 本次修复 |
|---|---|---|
| `modules/agent/model-tools.ts` | 七个已注册的产物动作被 `MODEL_ACTIONS`（模型动作白名单）拦截 | 放行 `artifact.manifest/archive/restore/inspect/release/candidates.inspect/candidates.prune`（产物清单、归档、恢复、检查、释放、候选检查/清理）。只有三个只读动作进入 `AUTOMATIC_ACTIONS`（无需额外业务写入审核的动作集合），归档、恢复、释放和候选清理仍需 review（人工审核） |
| `modules/agent/model-tools.ts` | 旧 `data.r1.submit`（模型直接提交 R1 正式入库）仍在允许表，算法/目录动作重复登记 | 移除旧模型直提交登记及重复声明；不更改受控 R1 工具的实际发布合同 |
| `modules/collection/artifact-lifecycle.ts` | 引用检查误用不存在的 `segment_requests.binding_json` 和 `processing_plans.document_json` | 按真实 `input_json`、`plan_json`、`material_manifest_json` 核对；并检查加工步骤和加工输出表中的真实文件引用。字段缺失或 SQL 错误仍失败封闭，不直接删除 |
| `platform/plugins/direct-versions.ts` | Linux x64 把 GNU/glibc（GNU C 运行库）和 musl（另一 C 运行库）可选包同时当成必需版本 | 根据真实宿主 libc 选择匹配的原生包，其他架构保持平台过滤；已选择包仍逐文件进行版本一致性验证 |
| `platform/plugins/direct-versions.ts` 与 `apps/server/capabilities.ts` | 产物工具复用 `baidu/process`（网盘/执行）指纹，未覆盖新增具体源码 | 新增 `artifactManifest`、`artifactArchive`、`artifactRestore`、`artifactLifecycle`、`candidateReclaim` 五组实现文件指纹，绑定到每个对应动作的运行版本 |
| `modules/collection/candidate-reclaim.ts` | `data.processing.*`（当前正式加工任务）漏出未完成任务保护范围；候选引用表字段有旧名 | 将 `data.processing.*` 纳入全局未决保护，并按现有加工计划、路由决定表字段核对候选 SHA-256（内容摘要） |

## 隔离验收

- [专项 GitHub Actions #42952114787](https://github.com/825695323-svg/xuan-BD/actions/runs/42952114787)：TypeScript（静态类型检查）、生产构建通过；**84 项专项：83 通过、0 失败、1 项外部 Python 条件跳过**。
- 新增真实服务装配用例（`apps/server/artifact-wiring-full-chain.test.ts`）：运行实际 `createApplicationServices`（应用服务装配），证实七个动作已登记、模型允许表放行、版本指纹可生成、实际加工与片段表不再误报“unverifiable”（无法核对）；当会话仍持有文件引用时继续阻断本地释放。
- 新增 `archify-wiring-regression.test.ts`（接线回归），核对 ABI（系统二进制接口）分流、只读与破坏性动作边界、真实列名以及指纹组。
- `candidate-reclaim.test.ts`（候选对象清理测试）增加真实 `data.processing.run` 任务未决阻断测试。

## 全仓对比

同一 GitHub Linux 托管环境、项目锁定的 Node.js 24.22.1：

| 项目 | 原主分支 | 本次修复分支 |
|---|---:|---:|
| 全仓总用例 | 512 | 519（新增 7 项） |
| 通过 | 406 | 420 |
| 失败 | 19 | 12 |
| 跳过 | 87 | 87 |
| 类型检查/构建 | 通过 | 通过 |

本次 [全仓回归 #42952286511](https://github.com/825695323-svg/xuan-BD/actions/runs/42952286511) **仍未通过**：不能因失败数下降就宣称全仓绿灯。原生可选包错判修复后，转换和多项模型桥接测试恢复；其余历史用例仍需分别核查。

剩余 12 项原有失败按范围分为：
- 3 项原生音视频资源测试：GitHub 托管机无 `resources`（正式随包资源目录），不是把一个空目录建出来即可完成资源验收。
- 2 项固定算法路由/来源均线批次合同。
- 2 项金融候选来源资格及正式交接用途声明。
- 5 项 R1 会话、模型加工和检索接口的历史断言/桥接资格差异。

这些失败与真实百度网盘账号、WFD 正式固定读回验收分别记录，不通过修改期望值或跳过失败来伪造通过。

## 安全及后续边界

1. 当前 `FileReferenceService`（文件引用服务）仍以旧本地文件身份供下游使用；`artifact.restore`（恢复）产生新的 `fileRefId`（文件引用编号），不默默修改旧消费者。会话关系存在时 `artifact.release`（释放）继续拒绝删除。需要单独设计安全的引用迁移/按需恢复策略，不可为实现压缩直接删引用。
2. `artifact.manifest`（清单）只汇总已经签发产物；未经过 R1/WFD 固定读回不能声称金融数据已入库。
3. 全仓扫描的 81 个静态不可达候选和 6 组相似代码并未全部证实无用。动态插件、测试夹具、历史 WFD 接口和跨语言调用不能靠静态未引用就删除。真正重复的模型白名单项已清理，不扩大无关重构范围。
4. 百度网盘 Skill（技能）仍需真实账号下上传、元数据检查、明确恢复后 SHA-256 校验；`material.ocr`（材料 OCR 适配器）及未绑定的音视频程序仍不会因本次修复自动可用。

**结论：这批审核中已确认的四组源码接线与版本/引用错误完成修复并通过真实宿主专项测试；正式生产验收和全仓剩余 12 项仍未完成。**
