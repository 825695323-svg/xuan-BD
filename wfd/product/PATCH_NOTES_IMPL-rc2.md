# 引擎交付包 IMPL-rc2 · 补丁说明（2026-10-26）

**基线：** `世界金融数据库_引擎_IMPL-rc1_2026-10-26.zip`（`cf34397ea482b9ba84a8268525ef7185db05d53f521a89c57966eff92c4572d5`），本包在其上只改两个文件。

## F-A：`wfd_sdk/transfer.py::activate` 激活规则

| 场景 | 行为 |
|---|---|
| 合法初始化（`update_seq==0`、无 `catalog/recovery/*`、有效快照全属于本次导入祖先链） | 首次写入，免凭证 `FIRST_WRITER_INITIALIZED` |
| 指针为空但库中存在非本链历史或恢复记录 | 拒绝 `HEAD_REQUIRES_RECOVERY`（不得以"新库"绕过凭证） |
| 导入来源主端 == 本端主端且本端已激活 | 同主端快进，免凭证 `SAME_WRITER_FAST_FORWARD` |
| 他端导入（来源主端 ≠ 本端） | 必须有效交接凭证 |
| 已有 active_head 且换主端 | 必须凭证；base = 被接管旧主端交接时的 `active_head` |
| 共同祖先下分叉 | `LINEAGE_FORK_DETECTED`，隔离 incoming 的 commit，不自动覆盖 |

## F-B：`wfd_sdk/state.py`

1. 新增 `catalog/activation_log.jsonl`：每次激活追加 `snapshot_id / update_seq / prev_head / writer_* / at_utc`，只增不改。
2. `resolve()` 增加 `HEAD_INVALID_RETIRED`：依据 `retention.json` 的 `released` 或 `lineage` 的 `revoked_read` / `retired_data_deleted`。
3. `resolve()` 增加 `HEAD_STALE`：**只依据激活日志**——指针 `update_seq` 低于日志，或同一 seq 下记录的 HEAD 与指针不一致；
   不使用 Commit 时间、Snapshot 编号或图序，因此 `published_commit_pending_head`（发布成功但未激活）不会被误判为过期。
4. 无激活日志时不判过期，避免误报。

## 验收（同一驱动、源码哈希门禁通过）

P0-1/P0-2 7/7；P0-3 11/11；P0-4 12 PASS + 1 NOT_RUN（M12 无 Windows 主机）；H01 7/7；E01—E06 6/6。

**不含：** 双向实机（M12）、断电、并发双写、真实规模、exFAT 物理中断。`production_accepted=false`。
