# WFD 引擎交付包 IMPL-rc4（2026-10-26）

**基线：** IMPL-rc3。rc4 只做一件事：**单写入者排他保护（F-D）**，不提供并发写入能力。

## 修复（F-D：单写入者排他保护缺失）

- 新增 `wfd_sdk/writerlock.py`：实例级跨进程排他锁（POSIX `fcntl.flock` / Windows `msvcrt.locking`），**非阻塞**，拿不到立即抛 `SINGLE_WRITER_BUSY`；同进程可重入。
- 加锁入口（只读路径不加锁）：
  `StateStore.activate`、`WFDDuckDBPrototype.submit`、`publish_compaction`、`GC.execute`、`transfer.activate`、`transfer.import_package`。
- 语义边界：本机锁管"同机同目录多进程互斥"；`writer_epoch`/交接凭证管"跨机主端资格"。两台离线主机各自写入仍靠重连时的 `LINEAGE_FORK_DETECTED`。

## 验收（rc4）

| 项 | 结果 |
|---|---|
| C1 8 进程同 `expected_prev` 抢激活 | 1/8 成功，7 个 `SINGLE_WRITER_BUSY`；`update_seq=1`、历史 1 条 |
| C2 8 进程不同主端抢激活 | 1/8 成功，落盘主端与赢家一致 |
| C3 双进程同父发布 | 同父仅 1 个子快照，另一个明确被拒 |
| C4 离线分叉重连 | `LINEAGE_FORK_DETECTED`，HEAD 不变 |
| C5 过期 epoch | `WRITER_EPOCH_ROLLBACK` |
| C6 持锁进程被强杀 | 锁由操作系统释放，新实例可重新取得 |
| 五套正式回归 | P0 7/7、GC 11/11、P0-4 12+1NOT_RUN、H01 7/7、E01—E06 6/6 |

`production_accepted=false`；断电、物理拔插、规模、长稳仍未覆盖。
