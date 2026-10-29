#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""正式引擎全量回归：四套回归 + E01—E06，全部只用交付引擎 `wfd_sdk/`。

前置门禁（任一不满足 → IMPLEMENTATION_MISMATCH 并停止）：
  1) 实际导入的 wfd_sdk 模块都位于交付引擎目录内；
  2) transfer / state / gc / lineage / duckdb_sdk 的完整 SHA-256 等于交付包登记值；
  3) 不得出现已作废变体 28dfa6bd…；
  4) 四套子进程通过 WFD_ENGINE 指向同一交付引擎，且 PYTHONPATH 只含本目录兼容层。

不做的事：不改交付包；不复用任何旧测试现场；每套在新建隔离目录下运行。
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ENGINE = Path(os.environ.get("WFD_ENGINE", "/Users/mashiro/Xuan BD-规划/测试产物/WFD/历史实验/formal_engine_rc1"))
V = Path(__file__).resolve().parent
BASE = V / ("formal_run_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
EVID = Path("/Users/mashiro/Xuan BD-规划/测试产物/WFD/验证记录/世界金融数据库_引擎集成验收E01-E06_2026-10-26.zip")

_exp_env = os.environ.get("WFD_EXPECT")
if _exp_env and Path(_exp_env).is_file():
    EXPECT = json.loads(Path(_exp_env).read_text("utf-8"))["expect"]
else:
    EXPECT = {
    "wfd_sdk/transfer.py": "11c481bccac8e1a70b24ab1812846e4779da5baffcfb5e859601ad72c2454df2",
    "wfd_sdk/state.py": "d5ec9c113a73fa4c7f8ad2c420132a9aea38aabd14016183f64b9f787c26ebe9",
    "wfd_sdk/gc.py": "db4f7c9cf37c51c863893471595a1b09e27fdb00ae4e8fbb2b61b54f3a0b347f",
    "wfd_sdk/lineage.py": "7d86a72e9f5a02a4cf3e34c659efc34426c77a9a4c6379b7d0cba9a552a65a4e",
    "wfd_sdk/duckdb_sdk.py": "334927504736c9d19a92244a97b1de78e556e2c1a96e29bf8e8f045afcde09af",
    }
VOID = {"28dfa6bdafbfa8fd38fe01c4d21b5872fac8215bdf925c3ec1f55f62a4f02ac3"}
START_TS = datetime.now(timezone.utc).timestamp()


def sha(p: Path) -> str:
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def provenance() -> dict:
    sys.path[:] = [p for p in sys.path if "WFD/verify" not in str(p)]
    sys.path.insert(0, str(ENGINE))
    import wfd_sdk  # noqa: F401
    import wfd_sdk.transfer  # noqa: F401
    import wfd_sdk.state  # noqa: F401
    import wfd_sdk.gc  # noqa: F401
    import wfd_sdk.lineage  # noqa: F401
    import wfd_sdk.duckdb_sdk  # noqa: F401

    mods = {m.__name__: (m.__file__, sha(Path(m.__file__))) for m in
            (wfd_sdk, wfd_sdk.transfer, wfd_sdk.state, wfd_sdk.gc, wfd_sdk.lineage, wfd_sdk.duckdb_sdk)}
    problems = []
    for name, (f, h) in mods.items():
        if not str(f).startswith(str(ENGINE)):
            problems.append(f"{name} 不在交付引擎目录：{f}")
        if h in VOID:
            problems.append(f"{name} 命中所作废变体 {h[:8]}")
    for rel, want in EXPECT.items():
        got = sha(ENGINE / rel)
        if got != want:
            problems.append(f"{rel} 哈希不符：{got} != {want}")
    return {"engine_dir": str(ENGINE), "modules": {k: {"file": v[0], "sha256": v[1]} for k, v in mods.items()},
            "problems": problems, "expected_match": not problems,
            "versions": {"python": sys.version.split()[0], "platform": sys.platform}}


def run(cmd: list, name: str) -> tuple[int, str]:
    log = BASE / f"{name}.log"
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env["PYTHONPATH"] = str(V)
    env["WFD_ENGINE"] = str(ENGINE)
    p = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=str(BASE))
    log.write_text((p.stdout or "") + ("\n[stderr]\n" + p.stderr if p.stderr else ""), encoding="utf-8")
    return p.returncode, p.stdout


def collect() -> dict:
    out = {}
    cands = list(BASE.glob("*")) + list(V.glob("p0_*")) + list(V.glob("gc_*")) + list(V.glob("p04_*")) + list(V.glob("h01_*"))
    for e in (BASE/"_e").glob("e_*"):
        cands.append(e)
    for d in sorted(cands):
        if d.stat().st_mtime < START_TS - 5:      # 只收本轮新产生的证据，避免混入历史
            continue
        r = d / "results.json"
        if r.is_file():
            out[d.name] = json.loads(r.read_text("utf-8"))
    return out


def main() -> int:
    BASE.mkdir(parents=True, exist_ok=True)
    prov = provenance()
    (BASE / "provenance.json").write_text(json.dumps(prov, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("[provenance]", "OK" if prov["expected_match"] else "IMPLEMENTATION_MISMATCH", flush=True)
    for m, info in prov["modules"].items():
        print(f"  {m:<24} {info['sha256'][:16]}…")
    if not prov["expected_match"]:
        (BASE / "SUMMARY.md").write_text(
            "# 正式引擎全量回归\n\n**IMPLEMENTATION_MISMATCH —— 停止验收**\n\n" +
            "\n".join(f"- {x}" for x in prov["problems"]) + "\n", encoding="utf-8")
        print("[STOP]", prov["problems"])
        return 3

    suites = [("P0", V / "run_p0.py"), ("GC", V / "run_gc.py"), ("P04", V / "run_p04.py"), ("H01", V / "run_h01.py")]
    codes = {}
    for name, script in suites:
        print(f"[run] {name} …", flush=True)
        codes[name], _ = run([sys.executable, str(script)], name)
        print(f"      exit={codes[name]}", flush=True)

    e_dir = BASE / "_e"
    e_dir.mkdir(exist_ok=True)
    with zipfile.ZipFile(EVID) as zf:
        (e_dir / "run_e01_e06.py").write_text(zf.read("scripts/run_e01_e06.py").decode("utf-8"), encoding="utf-8")
    # E06 会按固定文件名调用四套回归；把本轮适配版（含兼容层）放到该目录，确保它跑的是同一份引擎与同一套脚本
    for src_name, dst_name in (("run_p0.py", "p0_publish_recovery.py"), ("run_gc.py", "run_gc_verify.py"),
                               ("run_p04.py", "run_p04_verify.py"), ("run_h01.py", "run_h01_verify.py"),
                               ("wfd_gc.py", "wfd_gc.py"), ("wfd_lineage.py", "wfd_lineage.py"),
                               ("wfd_xfer.py", "wfd_xfer.py"), ("wfd_state.py", "wfd_state.py")):
        (e_dir / dst_name).write_text((V / src_name).read_text(encoding="utf-8"), encoding="utf-8")
    print("[run] E01—E06 …", flush=True)
    codes["E"], _ = run([sys.executable, str(e_dir / "run_e01_e06.py")], "E")
    print(f"      exit={codes['E']}", flush=True)

    res = collect()
    fails = [(k, c.get("id"), c.get("status")) for k, r in res.items() for c in r.get("checks", []) if c.get("status") == "FAIL"]
    overall = "PASS" if all(v == 0 for v in codes.values()) and not fails else "FAIL"
    out = {"format_version": "wfd.formal-regression/1.0",
           "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "engine": prov, "exit_codes": codes,
           "suites": {k: {"counts": r.get("counts"), "ids": [c.get("id") for c in r.get("checks", [])]} for k, r in res.items()},
           "fails": fails,
           "verdict": {"overall": overall, "production_accepted": False,
                       "note": "全部用例只在交付引擎 wfd_sdk/ 上执行；未覆盖断电、并发、真实规模、exFAT 物理中断"}}
    (BASE / "results.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = ["# 正式引擎全量回归（交付引擎 `wfd_sdk/`）", "",
             f"- 引擎目录：`{ENGINE}`", f"- 时间：{out['generated_at_utc']}",
             f"- 源码一致性：{'PASS（与交付包登记哈希逐文件一致）' if prov['expected_match'] else 'IMPLEMENTATION_MISMATCH'}",
             "", "| 模块 | SHA-256 |", "| --- | --- |"]
    for m, info in prov["modules"].items():
        lines.append(f"| `{m}` | `{info['sha256']}` |")
    lines += ["", "## 各套结果", "", "| 套件 | 退出码 | 计数 |", "| --- | --- | --- |"]
    for k, r in res.items():
        lines.append(f"| {k} | {codes.get(k.split('_')[0], '?')} | {r.get('counts')} |")
    if fails:
        lines += ["", "## 失败项", ""] + [f"- {k} / {i} / {s}" for k, i, s in fails]
    lines += ["", f"**总判定：{overall}**；`production_accepted=false`。", ""]
    (BASE / "SUMMARY.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"\n退出码：{codes}\n套件计数：" + json.dumps({k: r.get('counts') for k, r in res.items()}, ensure_ascii=False))
    print(f"结果：{BASE}")
    return 0 if overall == "PASS" else 2


if __name__ == "__main__":
    sys.exit(main())
