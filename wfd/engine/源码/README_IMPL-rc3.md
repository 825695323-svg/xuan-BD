# WFD 引擎交付包 IMPL-rc3（2026-10-26）

**基线：** `IMPL-rc1`（zip `cf34397e…`）。rc2 修真了 F-A/F-B，但 rc2 独立核验发现**跨模块一致性问题**，rc3 修复该问题。

## rc3 相对 rc1 的改动

| 文件 | 改动 |
|---|---|
| `wfd_sdk/transfer.py` | 跨端激活不再用 `write_host_state()` 覆写 HEAD，改为调用 `StateStore.activate()`（原子写 + 权威历史）；F-A 五档授权规则 |
| `wfd_sdk/state.py` | `activation_history` 随 `state.json` **同一次原子写**落盘（HEAD_STALE 的唯一权威依据）；`HEAD_INVALID_RETIRED`；`activation_log.jsonl` 降为审计镜像，写失败在 state 内留 `log_mirror_error` |

## 为什么不能只用 rc2

rc2 存在两条 HEAD 持久化路径：引擎发布走 `StateStore.activate`（写历史），跨端激活走 `write_host_state`（不写历史、非原子写）。
后果：跨端激活后把 HEAD 回退，`resolve()` 仍返回 `OK`，`HEAD_STALE` 检测在该路径上失效。

## 包内测试（可直接复现）

```
tests/run_formal_regression.py     # 统一驱动：源码哈希门禁 + 五组回归
tests/run_p0.py                    # P0-1/P0-2
tests/run_gc.py                    # P0-3
tests/run_p04.py                   # P0-4
tests/run_h01.py                   # H01
tests/run_f_state_consistency.py   # C1—C4 跨模块一致性
tests/wfd_*.py                     # 兼容层（把 wfd_sdk 暴露成旧测试用例名）
```

运行方式（只从本包 `wfd_sdk/` 导入）：

```
WFD_ENGINE=<本包根目录> WFD_EXPECT=tests/expect.json python tests/run_formal_regression.py
python tests/run_f_state_consistency.py
```

## 本轮验收结论

见 `evidence/`：五组回归 + C1—C4 全绿；`production_accepted=false`；不含 M12 双向实机、断电、并发、真实规模、exFAT 物理中断。
