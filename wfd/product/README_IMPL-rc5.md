# WFD 引擎交付包 IMPL-rc5（2026-10-26）

基线 IMPL-rc4。rc5 只修两个**阻止真实 exFAT 使用**的缺陷，不加功能。

## 修复

| 编号 | 缺陷 | 修法 |
|---|---|---|
| F-E | `gc.py` 用 `catalog/snapshots/*.json` 通配，macOS 在 exFAT 上生成的 `._<name>.json` 伴生文件被当快照解析 → `ClosureError(SNAPSHOT_UNREADABLE)`（实测一轮 37 个） | 新增 `_clean_json()` 过滤 `._*`/`.DS_Store`/`.trashes`；`duckdb_sdk` 的 commits/schemas 列举同样过滤 |
| F-F | rc4 的 `@guarded_store_func` 加到 `import_package(pkg_dir, store)` 上，锁的是**包目录**而非目标库：包内多出 `catalog/.writer.lock`，目标库实际未被保护，且后续 `export_package` 的 rmtree 报 `FileNotFoundError` | 新增 `guarded_store_arg(index)`，`import_package` 改为锁第 2 个参数（目标 store） |

## 验收

- 五套回归：P0 7/7、GC 11/11、P0-4 12+1NOT_RUN、H01 7/7、E01—E06 6/6
- 并发 C1—C6：6/6（1/8 成功、其余 `SINGLE_WRITER_BUSY`；强杀后锁释放）
- GC 证据保留 + 恢复注入：7/7（GC11a/11/11b、D1—D4）
- exFAT 现场：含 `._` 影子文件时 `GC.plan` 正常；`import_package` 不再污染包目录且目标库建锁

`production_accepted=false`；真实断电/拔盘仍未执行。
