# BD 产物归档项目：跨格式来源任务清单与最小证据流程

## 统一的 BD AGENTS 入口

每个已完成的采集源、接口源、网页、文件转换或视频转写任务均通过已有 `TaskResult.artifactIds`（原任务签发的文件编号清单）提供产物。新增加 `artifact.manifest`（来源任务产物清单）直接按 `sourceTaskId`（来源任务编号）汇总该清单，读取已有产物角色及归档/释放账本：

- `source-raw-response`（接口来源原始响应）与 `web-raw-response`（网页响应）按原始证据对待；
- `visible-text`（网页可见正文）、`transcription-evidence`（转写时间位置证据）、`article-html`（文章原生页面）按加工证据对待；
- `source-locator`（来源定位记录）是本地轻量身份，默认无须重新上传；
- `structured-conversion`（结构化转换结果）、`article-table`（文章投影表）等派生对象不自动复制成新的大文件，由 BD AGENTS 根据 WFD（金融数据仓库）正式准入与不可复原性判断后再决定是否存证；
- 未明确识别角色的对象标记 `review-derived-or-unclassified`（待审核衍生或未知对象），不猜成原件，也不自动删除。

同一 `fileRefId`（文件引用编号）只在清单中出现一次。没有通过来源任务身份和文件关系核验的文件标为 `source-reference-mismatch`（源文件关系不可信），不能按普通原件归档。

## 端到端工作流

1. BD AGENTS 明确调用来源工具取得原始内容；来源任务必须实际成功收束。
2. 调用 `artifact.manifest` 列出文件角色、大小、原归档回执与当前文件引用状态。
3. 原始事实和固定金融数据经过现有 BD 加工、R1（结构化交接）和 WFD 固定读回流程；不得将清单显示为 `not_checked`（未核实）的正式入库状态称为已发布。
4. 对不可替代的原始内容/必要证据，逐件调用 `artifact.archive`（网盘存证），按已有百度网盘 Skill（技能）核对远端名称、字节大小与 `fs_id`（远端对象编号），不下载读回、不生成重复上传。
5. 当来源工作结束且所有下游真实引用已核对，调用 `artifact.inspect`（本地回收资格检查）。只有 `eligible=true`（已可回收）才能凭其原 SHA-256 调用 `artifact.release`（受控释放本地生成文件）。
6. 后续需要内容时明确调用 `artifact.restore`（按原冻结网盘对象恢复），远端下载后完整校验 SHA-256 并产生新的本地文件引用。旧编号不静默重绑。
7. 五步加工结束后，另外使用 `artifact.candidates.inspect`（候选对象回收预览）与 `artifact.candidates.prune`（按冻结计划维护对象仓储），仅清理没有任何引用的 SQLite 候选对象；未决 R1 时阻断。

## 数据保留边界

本地保留正式 WFD 数据与 Snapshot/Manifest（固定快照/发布清单），以及恢复、任务、定义、来源、证据关系必需的轻量索引。大文件源证据优先存百度网盘，尚在进行的任务、材料原字节及任何被引用的转换产物继续保留。普通生成文件释放与数据库候选对象回收分别独立授权，互不替代。

`artifact.manifest` 只按已签发的公开 `artifactIds` 汇总，受保护站点的 `privateEvidenceRefs`（私有证据引用）只报数量，不向普通工具泄露其标识或原始响应。现行 `artifact.archive`（跨格式网盘归档）还不能直接选择私有站点文件，不能声称它已被迁移。

## 验收边界

- 自动测试核对源清单角色、重复编号去重、归档/释放回执关联、私有证据标识不可泄漏，且只读清单不会错误地阻止后续安全回收。
- 未运行真实网盘账号登录、API 源提供商与 WFD 正式数据集联合验收。
- 本轮不触发真实用户数据归档、正式数据库迁移或历史删除。
