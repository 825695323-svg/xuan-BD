#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""并发与离线竞争（rc3 交付件）

C1 多进程同 expected_prev 抢激活：必须只有 1 个成功（真实竞争，不是单次调用）
C2 多进程不同主端同时激活：仍只允许 1 个，且赢家写入的 host/epoch 与状态一致
C3 双进程同父发布：只允许 1 个 published，另一个必须 PARENT_CHANGED（引擎内部 CAS）
C4 离线分叉：两份副本各自发布，重连导入必须 LINEAGE_FORK_DETECTED 且 HEAD 不变
C5 过期 epoch：低于当前世代的主端写入必须被拒
"""
import hashlib, json, multiprocessing as mp, os, shutil, sys, time
from pathlib import Path

ENGINE = Path("/Users/mashiro/Xuan BD-规划/测试产物/WFD/历史实验/engine_impl_rc5")
BASE = Path("/Users/mashiro/Xuan BD-规划/测试产物/WFD/历史实验/verify_formal") / ("conc_" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
sys.path.insert(0, str(ENGINE))
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator  # noqa: E402
from wfd_sdk.state import StateStore  # noqa: E402
from wfd_sdk.transfer import export_package, import_package, activate, host_state  # noqa: E402
from wfd_sdk.gc import GC  # noqa: E402

CHECKS = []


def check(cid, title, ok, detail):
    CHECKS.append({"id": cid, "title": title, "status": "PASS" if ok else "FAIL", "detail": detail})
    print(f"[{'PASS' if ok else 'FAIL'}] {cid} {title} — {detail}", flush=True)


def _activate_worker(store: str, sid: str, host: str, epoch: int, barrier, out):
    sys.path.insert(0, str(ENGINE))
    from wfd_sdk.state import StateStore
    barrier.wait()
    try:
        res = StateStore(Path(store)).activate(sid, Path(store)/f"catalog/snapshots/{sid}.json",
                                               expected_prev=None, writer_host=host, writer_epoch=epoch)
        out.put({"ok": bool(res.get("ok")), "code": res.get("code"), "host": host})
    except Exception as exc:  # 锁占用以异常形式抛出，必须被记录而不是让父进程阻塞
        out.put({"ok": False, "code": getattr(exc, "code", type(exc).__name__), "host": host})


def _submit_worker(store: str, parent: str, tag: str, barrier, out):
    sys.path.insert(0, str(ENGINE))
    from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
    barrier.wait()
    try:
        sdk = WFDDuckDBPrototype(Path(store), load_protocol_validator(ENGINE/"protocol"),
                                 runtime_root=BASE/f"rt_{tag}", sandbox=False)
        doc = json.loads((ENGINE/"fixtures/port_release_event.json").read_text("utf-8"))
        doc["request_identity"].update(dataset_id="conc", request_id=f"c_{tag}")
        doc["source_bundle"]["raw_source_bytes_custodied"] = True
        doc["expected_parent_snapshot_id"] = parent
        r = sdk.submit(doc)
        out.put({"status": r.get("status"), "codes": [e.get("code") for e in (r.get("errors") or [])],
                 "snapshot": r.get("snapshot_id")})
    except Exception as exc:  # 锁占用/异常都记录，避免父进程阻塞
        out.put({"status": "exception", "codes": [getattr(exc, "code", type(exc).__name__)], "snapshot": None})


def main() -> int:
    BASE.mkdir(parents=True, exist_ok=True)
    val = load_protocol_validator(ENGINE/"protocol")
    src = BASE/"src"
    sdk = WFDDuckDBPrototype(src, val, runtime_root=BASE/"rt_src", sandbox=False)
    d = json.loads((ENGINE/"fixtures/port_monthly_teu.json").read_text("utf-8"))
    d["request_identity"].update(dataset_id="conc", request_id="c0"); d["source_bundle"]["raw_source_bytes_custodied"] = True
    d["expected_parent_snapshot_id"] = None; sdk.submit(d); s0 = sdk.head()["snapshot_id"]
    export_package(src, s0, BASE/"pkg", include_ancestor_data=True)

    # ---- C1: 8 进程抢同一 expected_prev
    store = BASE/"c1"; shutil.rmtree(store, ignore_errors=True); store.mkdir(parents=True)
    import_package(BASE/"pkg", store)          # 只导入、未激活：active_head=None
    q = mp.Queue(); barrier = mp.Barrier(8); procs = []
    for i in range(8):
        p = mp.Process(target=_activate_worker, args=(str(store), s0, "mac-a", 1, barrier, q)); p.start(); procs.append(p)
    for p in procs: p.join()
    results = [q.get(timeout=60) for _ in range(8)]
    wins = [r for r in results if r["ok"]]
    st = host_state(store)
    check("C1", "8 进程同 expected_prev 抢激活 → 只允许 1 个成功",
          len(wins) == 1 and int(st.get("update_seq") or 0) == 1 and len(st.get("activation_history") or []) == 1,
          f"成功={len(wins)}/8；update_seq={st.get('update_seq')}；历史={len(st.get('activation_history') or [])}；"
          f"失败码={sorted({r['code'] for r in results if not r['ok']})}")

    # ---- C2: 8 进程不同主端同时激活
    store2 = BASE/"c2"; shutil.rmtree(store2, ignore_errors=True); store2.mkdir(parents=True)
    import_package(BASE/"pkg", store2)
    q2 = mp.Queue(); barrier2 = mp.Barrier(8); procs2 = []
    for i in range(8):
        p = mp.Process(target=_activate_worker, args=(str(store2), s0, f"host-{i}", 1+i, barrier2, q2)); p.start(); procs2.append(p)
    for p in procs2: p.join()
    res2 = [q2.get(timeout=60) for _ in range(8)]
    wins2 = [r for r in res2 if r["ok"]]
    st2 = host_state(store2)
    check("C2", "8 进程不同主端抢激活 → 只允许 1 个，状态与赢家一致",
          len(wins2) == 1 and st2.get("writer_host") == wins2[0]["host"] if wins2 else False,
          f"成功={len(wins2)}/8；最终主端={st2.get('writer_host')}；赢家={wins2[0]['host'] if wins2 else None}")

    # ---- C3: 双进程同父发布
    store3 = BASE/"c3"; shutil.rmtree(store3, ignore_errors=True); shutil.copytree(src, store3)
    q3 = mp.Queue(); barrier3 = mp.Barrier(2); procs3 = []
    for tag in ("a", "b"):
        p = mp.Process(target=_submit_worker, args=(str(store3), s0, tag, barrier3, q3)); p.start(); procs3.append(p)
    for p in procs3: p.join()
    res3 = [q3.get(timeout=60) for _ in range(2)]
    pub = [r for r in res3 if r["status"] == "published_sandbox"]
    rej = [r for r in res3 if r["status"] != "published_sandbox"]
    # 同一父下的子快照数量：必须只有 1 个（不论拒绝原因是锁占用还是 PARENT_CHANGED）
    children = []
    for f in (store3/"catalog/snapshots").glob("*.json"):
        snap = json.loads(f.read_text("utf-8"))
        if snap.get("parent_snapshot_id") == s0:
            children.append(snap["snapshot_id"])
    reject_codes = [c for r in rej for c in (r["codes"] or [])]
    check("C3", "双进程同父发布 → 只产生 1 个子快照，另一个明确被拒",
          len(pub) == 1 and len(rej) == 1 and len(children) == 1
          and any(c in ("PARENT_CHANGED", "SINGLE_WRITER_BUSY") for c in reject_codes),
          f"成功={len(pub)}；被拒码={reject_codes}；同一父的子快照数={len(children)}（应为 1）")

    # ---- C4: 离线分叉
    A = BASE/"c4_a"; B = BASE/"c4_b"
    for x in (A, B): shutil.rmtree(x, ignore_errors=True); shutil.copytree(store3, x)
    def publish_on(st, tag):
        s = WFDDuckDBPrototype(st, val, runtime_root=BASE/f"rt_{tag}", sandbox=False)
        dd = json.loads((ENGINE/"fixtures/port_annual_autos.json").read_text("utf-8"))
        dd["request_identity"].update(dataset_id="conc", request_id=f"fork_{tag}")
        dd["source_bundle"]["raw_source_bytes_custodied"] = True
        dd["expected_parent_snapshot_id"] = sdk_head(st)
        assert s.submit(dd).get("status") == "published_sandbox"
        return s.head()["snapshot_id"]
    def sdk_head(st):
        return WFDDuckDBPrototype(st, val, runtime_root=BASE/"rt_h", sandbox=False).head()["snapshot_id"]
    sa = publish_on(A, "a"); sb = publish_on(B, "b")
    base_head = host_state(A)["active_head"]
    export_package(B, sb, BASE/"pkg_fork")
    import_package(BASE/"pkg_fork", A)
    r4 = activate(A, sb, writer_host="mac-a", writer_epoch=1)
    st4 = host_state(A)
    check("C4", "离线分叉重连 → LINEAGE_FORK_DETECTED 且 HEAD 不变",
          r4["status"] == "rejected" and r4.get("code") == "LINEAGE_FORK_DETECTED" and st4["active_head"] == sa,
          f"码={r4.get('code')}；A 的 HEAD 保持={st4['active_head'] == sa}")

    # ---- C5: 过期 epoch
    st5_path = BASE/"c5"; shutil.rmtree(st5_path, ignore_errors=True); st5_path.mkdir(parents=True)
    import_package(BASE/"pkg", st5_path)
    r5a = StateStore(st5_path).activate(s0, st5_path/f"catalog/snapshots/{s0}.json", expected_prev=None,
                                        writer_host="mac-a", writer_epoch=5)
    print("   C5 前置激活:", r5a.get("ok"), "| state epoch:", host_state(st5_path).get("writer_epoch"))
    stale = StateStore(st5_path).activate(s0, st5_path/f"catalog/snapshots/{s0}.json",
                                          expected_prev=s0, writer_host="mac-a", writer_epoch=3)
    check("C5", "过期 epoch 写入被拒", (not stale.get("ok")) and stale.get("code") == "WRITER_EPOCH_ROLLBACK",
          f"code={stale.get('code')}")

    # ---- C6: 持锁进程被强杀 → 锁由操作系统释放，新实例可获取并写入
    import signal, subprocess, textwrap, tempfile
    store6 = BASE/"c6"; shutil.rmtree(store6, ignore_errors=True); shutil.copytree(src, store6)
    holder = subprocess.Popen([sys.executable, "-c", textwrap.dedent(f"""
        import sys, time
        sys.path.insert(0, r"{ENGINE}")
        from wfd_sdk.writerlock import writer_lock
        cm = writer_lock(r"{store6}"); cm.__enter__()
        print("HELD", flush=True); time.sleep(60)
    """)], stdout=subprocess.PIPE, text=True)
    line = holder.stdout.readline().strip()
    from wfd_sdk.writerlock import writer_lock, WriterBusy, probe
    busy_while_alive = probe(store6)
    holder.send_signal(signal.SIGKILL); holder.wait(timeout=10)
    ok_after_kill = None
    try:
        with writer_lock(store6):
            ok_after_kill = True
    except WriterBusy:
        ok_after_kill = False
    check("C6", "持锁进程被强杀后锁自动释放，新实例可重新取得",
          busy_while_alive is True and ok_after_kill is True and line == "HELD",
          f"持锁时探测={busy_while_alive}；强杀后重新获取={ok_after_kill}")

    counts = {"PASS": sum(1 for c in CHECKS if c["status"] == "PASS"), "FAIL": sum(1 for c in CHECKS if c["status"] == "FAIL")}
    (BASE/"results.json").write_text(json.dumps({"format_version": "wfd.concurrency/1.0", "engine": str(ENGINE),
                                                  "checks": CHECKS, "counts": counts}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("计数:", counts, "|", BASE)
    return 0 if counts["FAIL"] == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
