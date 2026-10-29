#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GC11 证据保留 + D1—D4 掉电等价恢复（rc4 交付件）"""
import hashlib, json, shutil, sys, time
from pathlib import Path

ENGINE = Path("/Users/mashiro/Xuan BD-规划/测试产物/WFD/历史实验/engine_impl_rc5")
BASE = Path("/Users/mashiro/Xuan BD-规划/测试产物/WFD/历史实验/verify_formal") / ("gcev_" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
sys.path.insert(0, str(ENGINE))
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator  # noqa: E402
from wfd_sdk.gc import GC  # noqa: E402
from wfd_sdk.state import StateStore  # noqa: E402

CHECKS = []


def check(cid, title, ok, detail):
    CHECKS.append({"id": cid, "title": title, "status": "PASS" if ok else "FAIL", "detail": detail})
    print(f"[{'PASS' if ok else 'FAIL'}] {cid} {title} — {detail}", flush=True)


def build(store: Path):
    val = load_protocol_validator(ENGINE/"protocol")
    sdk = WFDDuckDBPrototype(store, val, runtime_root=BASE/"rt", sandbox=False)
    ids = []
    for i, fx in enumerate(("port_monthly_teu.json", "port_annual_autos.json")):
        d = json.loads((ENGINE/"fixtures"/fx).read_text("utf-8"))
        d["request_identity"].update(dataset_id="gcev", request_id=f"g{i}")
        d["source_bundle"]["raw_source_bytes_custodied"] = True
        h = sdk.head(); d["expected_parent_snapshot_id"] = h["snapshot_id"] if h else None
        assert sdk.submit(d).get("status") == "published_sandbox"
        ids.append(sdk.head()["snapshot_id"])
    return ids


def build_single(store: Path):
    val = load_protocol_validator(ENGINE/"protocol")
    sdk = WFDDuckDBPrototype(store, val, runtime_root=BASE/"rt_single", sandbox=False)
    d = json.loads((ENGINE/"fixtures/port_monthly_teu.json").read_text("utf-8"))
    d["request_identity"].update(dataset_id="gcev1", request_id="one")
    d["source_bundle"]["raw_source_bytes_custodied"] = True
    d["expected_parent_snapshot_id"] = None
    assert sdk.submit(d).get("status") == "published_sandbox"
    return sdk.head()["snapshot_id"]


def main() -> int:
    BASE.mkdir(parents=True, exist_ok=True)

    # ---------- GC11：证据保留阻断回收（目标是"不可达孤儿文件"，否则测不到保护）
    store = BASE/"gc11"; shutil.rmtree(store, ignore_errors=True); store.mkdir(parents=True)
    build(store)
    orphan_dir = store/"observations/product=p_orphan999"
    orphan_dir.mkdir(parents=True, exist_ok=True)
    orphan = orphan_dir/"part-orphan0001.parquet"
    orphan.write_bytes(b"PAR1-dummy-orphan-bytes")
    rel_orphan = orphan.relative_to(store).as_posix()
    plan0 = GC(store, cooldown_seconds=0).plan()
    check("GC11a", "无证据时孤儿文件属于可回收候选",
          rel_orphan in [c["rel_path"] for c in plan0["candidates"]],
          f"候选含目标={rel_orphan in [c['rel_path'] for c in plan0['candidates']]}")

    (store/"catalog/evidence").mkdir(parents=True, exist_ok=True)
    (store/"catalog/evidence/ev_002.json").write_text(json.dumps({
        "format_version": "wfd.evidence/1.0", "evidence_id": "ev_002",
        "files": [rel_orphan]}, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    plan1 = GC(store, cooldown_seconds=0).plan()
    blocked1 = [b for b in plan1["blocked"] if b.get("rel_path") == rel_orphan]
    check("GC11", "证据引用的文件在 GC 中受保护（不得回收）",
          rel_orphan not in [c["rel_path"] for c in plan1["candidates"]] and bool(blocked1),
          f"候选是否含目标={rel_orphan in [c['rel_path'] for c in plan1['candidates']]}；阻断原因={(blocked1 or [{}])[0].get('reason')}")

    (store/"catalog/evidence/ev_002.json").unlink()
    plan2 = GC(store, cooldown_seconds=0).plan()
    check("GC11b", "解除证据保留后该文件才进入回收候选",
          rel_orphan in [c["rel_path"] for c in plan2["candidates"]],
          f"候选数={len(plan2['candidates'])}；含目标={rel_orphan in [c['rel_path'] for c in plan2['candidates']]}")

    # ---------- D1：commit 已写、HEAD 未更新（掉电等价）
    st = BASE/"d1"; shutil.rmtree(st, ignore_errors=True); st.mkdir(parents=True)
    a, b = build(st)
    before = json.loads((st/"catalog/state.json").read_text("utf-8"))
    # 回滚 state 到"只有 a"的状态，模拟 HEAD 未落盘
    prev = {"format_version": "wfd.state/1.0", "active_head": a,
            "head_snapshot_sha256": "sha256:"+hashlib.sha256((st/f"catalog/snapshots/{a}.json").read_bytes()).hexdigest(),
            "writer_host": before.get("writer_host"), "writer_epoch": before.get("writer_epoch"),
            "update_seq": 1, "prev_head": None,
            "activation_history": [{"snapshot_id": a, "update_seq": 1, "prev_head": None, "at_utc": "2026-10-26T00:00:00Z"}],
            "updated_at_utc": "2026-10-26T00:00:00Z"}
    (st/"catalog/state.json").write_text(json.dumps(prev, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    r1 = StateStore(st).resolve(GC(st).valid_snapshots())
    check("D1", "commit 已写但 HEAD 未更新 → 解析成功且停在旧版本（不自动前滚）",
          r1.get("code") == "OK" and r1.get("snapshot_id") == a,
          f"code={r1.get('code')} head={r1.get('snapshot_id')}（期望 {a}）")

    # ---------- D2：state 缺失 + 唯一候选 → HEAD_MISSING，显式恢复可写回
    st2 = BASE/"d2"; shutil.rmtree(st2, ignore_errors=True); st2.mkdir(parents=True)
    build_single(st2)
    (st2/"catalog/state.json").unlink()
    r2 = StateStore(st2).resolve(GC(st2).valid_snapshots())
    rec = StateStore(st2).recover(GC(st2).valid_snapshots(), "operator-test", note="power-loss sim")
    check("D2", "state 缺失 + 唯一候选 → HEAD_MISSING；显式 recover 后可用",
          r2.get("code") == "HEAD_MISSING" and rec.get("ok") and StateStore(st2).resolve(GC(st2).valid_snapshots())["code"] == "OK",
          f"resolve={r2.get('code')} → recover ok={rec.get('ok')} → 再解析=OK")

    # ---------- D3：残留 state 临时文件 + 合法 state → 正常解析、不误清理
    st3 = BASE/"d3"; shutil.rmtree(st3, ignore_errors=True); shutil.copytree(st, st3)
    leftover = st3/"catalog/.state_abc123"
    leftover.write_text("{\"partial\": ", encoding="utf-8")
    r3 = StateStore(st3).resolve(GC(st3).valid_snapshots())
    check("D3", "残留 .state_* 半成品不影响解析",
          r3.get("code") == "OK" and leftover.exists(),
          f"code={r3.get('code')}；残留文件仍在={leftover.exists()}")

    # ---------- D4：state 缺失 + 多候选 → HEAD_AMBIGUOUS，recover 拒绝
    st4 = BASE/"d4"; shutil.rmtree(st4, ignore_errors=True); shutil.copytree(st, st4)
    (st4/"catalog/state.json").unlink()
    # 制造第二个可验证分支：把 a 的 commit 复制成另一 id 太脏，改用 lineage 之外的复制品
    gc4 = GC(st4); valid4 = gc4.valid_snapshots()
    if len(valid4) < 2:
        # 复制一份快照/提交作为独立候选（仅测试用，隔离目录）
        import copy
        sid2 = "s_" + "0"*24; snap = json.loads((st4/f"catalog/snapshots/{a}.json").read_text("utf-8"))
        snap["snapshot_id"] = sid2; snap["parent_snapshot_id"] = None
        snap["files"] = copy.deepcopy(snap["files"])
        (st4/f"catalog/snapshots/{sid2}.json").write_text(json.dumps(snap, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
        (st4/f"catalog/commits/{sid2}.json").write_text(json.dumps({"snapshot_id": sid2, "snapshot_file": f"catalog/snapshots/{sid2}.json",
            "snapshot_sha256": hashlib.sha256((st4/f"catalog/snapshots/{sid2}.json").read_bytes()).hexdigest()}, ensure_ascii=False)+"\n", encoding="utf-8")
        valid4 = GC(st4).valid_snapshots()
    r4 = StateStore(st4).resolve(valid4)
    rec4 = StateStore(st4).recover(valid4, "operator-test")
    check("D4", "多候选且无指针 → HEAD_AMBIGUOUS，recover 拒绝自动选择",
          r4.get("code") == "HEAD_AMBIGUOUS" and not rec4.get("ok"),
          f"resolve={r4.get('code')}（候选 {len(valid4)}）；recover ok={rec4.get('ok')}")

    counts = {"PASS": sum(1 for c in CHECKS if c["status"] == "PASS"), "FAIL": sum(1 for c in CHECKS if c["status"] == "FAIL")}
    (BASE/"results.json").write_text(json.dumps({"format_version": "wfd.gc-evidence-recovery/1.0",
                                                 "engine": str(ENGINE), "checks": CHECKS, "counts": counts},
                                                ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print("计数:", counts, "|", BASE)
    return 0 if counts["FAIL"] == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
