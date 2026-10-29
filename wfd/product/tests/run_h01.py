#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WFD H01 实测：权威 HEAD（catalog/state.json.active_head）损坏与恢复

子项：a 指向不存在 / b 摘要不符 / c 有效但非最新 / d 指向退役版本 / e 多候选歧义 / f 显式恢复
纪律：每个注入都在独立副本上；任何情况下不得静默改写指针；恢复必须留记录、不改 parent。
"""
from __future__ import annotations

import hashlib
import json
import shutil
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

VERIFY = Path(__file__).resolve().parent
sys.path.insert(0, str(VERIFY))
from wfd_gc import GC  # noqa: E402
from wfd_lineage import Lineage  # noqa: E402
from wfd_state import read_state, recover_head, resolve_head  # noqa: E402

ENGINE = Path(os.environ.get("WFD_ENGINE", str(Path.home() / "WFD/runtime/engine/WFD_DuckDB_engine_candidate")))
BASE = VERIFY / ("h01_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
SRC = BASE / "store"
sys.path.insert(0, str(ENGINE))
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator  # noqa: E402

CHECKS: list[dict] = []


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def check(cid, title, ok, detail, evidence=None):
    CHECKS.append({"id": cid, "title": title, "status": "PASS" if ok else "FAIL", "detail": detail, "evidence": evidence or {}})
    print(f"[{'PASS' if ok else 'FAIL'}] {cid} {title} — {detail}", flush=True)


def sha(p: Path) -> str:
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def data_snapshot(store: Path) -> dict:
    out = {}
    for d in ("observations", "foundation", "events"):
        root = Path(store) / d
        if root.is_dir():
            for p in root.rglob("*"):
                if p.is_file():
                    out[p.relative_to(store).as_posix()] = sha(p)
    return out


def clone(name: str) -> Path:
    dst = BASE / name
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(SRC, dst)
    return dst


def main() -> int:
    BASE.mkdir(parents=True, exist_ok=True)
    (BASE / "env.json").write_text(json.dumps({
        "python": sys.version.split()[0], "platform": sys.platform,
        "engine": str(ENGINE), "layers": [str(VERIFY / f) for f in ("wfd_state.py", "wfd_gc.py", "wfd_lineage.py")],
        "generated_at_utc": now()}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # ---- 基线：S100 → S101，写 active_head 指针
    validator = load_protocol_validator(ENGINE / "protocol")
    sdk = WFDDuckDBPrototype(SRC, validator, runtime_root=BASE / "rt_src", sandbox=False)
    ids = []
    for i, fx in enumerate(("port_monthly_teu.json", "port_annual_autos.json")):
        doc = json.loads((ENGINE / "fixtures" / fx).read_text("utf-8"))
        doc["request_identity"]["dataset_id"] = "wfd_h01"
        doc["request_identity"]["request_id"] = f"h01_s{i}"
        doc["source_bundle"]["raw_source_bytes_custodied"] = True
        h = sdk.head()
        doc["expected_parent_snapshot_id"] = h["snapshot_id"] if h else None
        assert sdk.submit(doc).get("status") == "published_sandbox"
        ids.append(sdk.head()["snapshot_id"])
    Lineage(SRC).build_all()
    s1 = SRC / f"catalog/snapshots/{ids[1]}.json"
    (SRC / "catalog/state.json").write_text(json.dumps({
        "format_version": "wfd.state/1.0", "active_head": ids[1], "head_snapshot_sha256": "sha256:" + sha(s1),
        "writer_host": "mac-a", "writer_epoch": 1, "update_seq": 2, "prev_head": ids[0],
        "updated_at_utc": now()}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ok0 = resolve_head(SRC)
    check("H01-0", "基线：合法指针可解析", ok0["ok"] and ok0["code"] == "OK",
          f"active_head={ok0.get('snapshot_id')} writer={ok0.get('writer_host')}/{ok0.get('writer_epoch')} seq={ok0.get('update_seq')}")

    # ---- H01-a 指向不存在
    a = clone("h01a_missing")
    st = read_state(a); st["active_head"] = "s_does_not_exist"
    (a / "catalog/state.json").write_text(json.dumps(st, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    before = data_snapshot(a)
    ra = resolve_head(a)
    check("H01-a", "active_head 指向不存在的快照 → HEAD_INVALID_MISSING，且不自动改指向",
          ra["code"] == "HEAD_INVALID_MISSING" and read_state(a)["active_head"] == "s_does_not_exist" and data_snapshot(a) == before,
          f"code={ra['code']}；指针未被改写={read_state(a)['active_head'] == 's_does_not_exist'}")

    # ---- H01-b 摘要不符
    b = clone("h01b_digest")
    st = read_state(b); st["head_snapshot_sha256"] = "sha256:" + "0" * 64
    (b / "catalog/state.json").write_text(json.dumps(st, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    rb = resolve_head(b)
    check("H01-b", "head_snapshot_sha256 与快照字节不符 → HEAD_INVALID_DIGEST",
          rb["code"] == "HEAD_INVALID_DIGEST", f"code={rb['code']}；{rb.get('detail', '')[:60]}")

    # ---- H01-c 有效但非最新
    c = clone("h01c_stale")
    st = read_state(c); st["active_head"] = ids[0]; st["head_snapshot_sha256"] = "sha256:" + sha(c / f"catalog/snapshots/{ids[0]}.json")
    (c / "catalog/state.json").write_text(json.dumps(st, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    rc = resolve_head(c)
    check("H01-c", "指针有效但落后于已发布版本 → HEAD_STALE",
          rc["code"] == "HEAD_STALE" and (ids[1] in (rc.get("descendants") or []) or ids[1] in str(rc.get("detail"))),
          f"code={rc['code']}；诊断={rc.get('detail')}；{"后继承快照=" + str(rc.get('descendants')) if rc.get('descendants') else '依据=激活日志记录的 HEAD 不一致'}")

    # ---- H01-d 指向退役版本
    d = clone("h01d_retired")
    (d / "catalog/retention.json").write_text(json.dumps({
        "format_version": "wfd.retention/1.0", "updated_at_utc": now(),
        "policy": {"auto_expire": False},
        "snapshots": {ids[0]: {"state": "retained"}, ids[1]: {"state": "released", "reason": "H01_TEST"}}},
        ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    rd = resolve_head(d)
    check("H01-d", "指针指向已退役版本 → HEAD_INVALID_RETIRED，且不自动跳到旧版本",
          rd["code"] == "HEAD_INVALID_RETIRED" and read_state(d)["active_head"] == ids[1],
          f"code={rd['code']}；指针未被改写={read_state(d)['active_head'] == ids[1]}")

    # ---- H01-e 无 state.json 且多候选
    e = clone("h01e_ambiguous")
    (e / "catalog/state.json").unlink()
    re_ = resolve_head(e)
    check("H01-e", "无指针且存在多个可验证候选 → HEAD_AMBIGUOUS，拒绝自动选择",
          re_["code"] == "HEAD_AMBIGUOUS" and len(re_.get("candidates") or []) >= 2,
          f"code={re_['code']}；候选数={len(re_.get('candidates') or [])}")

    # ---- H01-f 唯一候选时显式恢复
    f = clone("h01f_recover")
    (f / "catalog/state.json").unlink()
    (f / f"catalog/commits/{ids[1]}.json").unlink()      # 只剩一个可验证候选
    rf = resolve_head(f)
    parent_before = json.loads((f / f"catalog/snapshots/{ids[0]}.json").read_text("utf-8")).get("parent_snapshot_id")
    rec = recover_head(f, operator="h01-test", note="唯一候选显式恢复")
    st_after = read_state(f)
    rec_files = list((f / "catalog/recovery").glob("*.json"))
    parent_after = json.loads((f / f"catalog/snapshots/{ids[0]}.json").read_text("utf-8")).get("parent_snapshot_id")
    rf2 = resolve_head(f)
    check("H01-f", "唯一候选时执行显式恢复：写恢复记录、指针可用、parent 未被改写",
          rf["code"] == "HEAD_MISSING" and rec["status"] == "recovered" and st_after["active_head"] == ids[0]
          and len(rec_files) == 1 and parent_after == parent_before and rf2["ok"],
          f"恢复前 code={rf['code']} → 恢复后 active_head={st_after['active_head']}（=S100）；"
          f"恢复记录 {len(rec_files)} 条；parent 不变={parent_after == parent_before}；再解析={rf2['code']}")

    return finish()


def finish() -> int:
    counts = {}
    for c in CHECKS:
        counts[c["status"]] = counts.get(c["status"], 0) + 1
    result = {"format_version": "wfd.h01-verify/1.0", "generated_at_utc": now(), "work_dir": str(BASE),
              "checks": CHECKS, "counts": counts,
              "verdict": {"overall": "PASS" if not counts.get("FAIL") else "FAIL",
                          "production_accepted": False,
                          "note": "仅覆盖 catalog/state.json 的权威 HEAD 四个损坏场景与一次显式恢复；未覆盖真实断电与并发写。"}}
    (BASE / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# H01 实测报告：权威 HEAD 损坏与恢复", "",
             f"- 时间（UTC）：{result['generated_at_utc']}", f"- 工作区：{BASE}", f"- 计数：{counts}", "",
             "| ID | 检查 | 状态 | 说明 |", "| --- | --- | --- | --- |"]
    for c in CHECKS:
        lines.append(f"| {c['id']} | {c['title']} | {c['status']} | {c['detail'].replace('|','/')[:200]} |")
    lines += ["", "- 结论仅限本机；`production_accepted=false`；断电与并发未覆盖。", ""]
    (BASE / "REPORT.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"\n结果：{BASE/'results.json'}\n计数：{counts}")
    return 0 if not counts.get("FAIL") else 2


if __name__ == "__main__":
    sys.exit(main())
