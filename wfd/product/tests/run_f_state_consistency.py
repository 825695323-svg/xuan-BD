#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""F-A/F-B 跨模块一致性回归：三条激活路径必须写同一份权威历史。

案例：
  C1 跨端激活（transfer.activate）写入 activation_history
  C2 引擎发布（duckdb_sdk.submit）追加 activation_history
  C3 指针回退（旧备份覆盖 HEAD）→ HEAD_STALE
  C4 CAS 失败（expected_prev 不符）不写历史、不改 HEAD
"""
import hashlib, json, shutil, sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator  # noqa: E402
from wfd_sdk.transfer import export_package, import_package, activate, host_state  # noqa: E402
from wfd_sdk.state import StateStore  # noqa: E402
from wfd_sdk.gc import GC  # noqa: E402

BASE = Path(__file__).resolve().parent / ("consistency_" + __import__("datetime").datetime.now(
    __import__("datetime").timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
CHECKS = []


def check(cid, title, ok, detail):
    CHECKS.append({"id": cid, "title": title, "status": "PASS" if ok else "FAIL", "detail": detail})
    print(f"[{'PASS' if ok else 'FAIL'}] {cid} {title} — {detail}", flush=True)


def main() -> int:
    shutil.rmtree(BASE, ignore_errors=True)
    src, tgt = BASE/"src", BASE/"tgt"
    val = load_protocol_validator(ENGINE/"protocol")
    sdk = WFDDuckDBPrototype(src, val, runtime_root=BASE/"rt_src", sandbox=False)
    d = json.loads((ENGINE/"fixtures/port_monthly_teu.json").read_text("utf-8"))
    d["request_identity"].update(dataset_id="cons", request_id="c0")
    d["source_bundle"]["raw_source_bytes_custodied"] = True
    d["expected_parent_snapshot_id"] = None
    sdk.submit(d)
    s0 = sdk.head()["snapshot_id"]
    export_package(src, s0, BASE/"pkg0", include_ancestor_data=True)
    import_package(BASE/"pkg0", tgt)

    r1 = activate(tgt, s0, writer_host="mac-a", writer_epoch=1)
    st1 = host_state(tgt)
    hist1 = st1.get("activation_history") or []
    check("C1", "跨端激活写入权威历史",
          r1["status"] == "activated" and len(hist1) == 1 and hist1[0]["snapshot_id"] == s0
          and int(st1.get("update_seq")) == 1,
          f"status={r1['status']} seq={st1.get('update_seq')} 历史={[(h['snapshot_id'][:8], h['update_seq']) for h in hist1]}")

    tsdk = WFDDuckDBPrototype(tgt, val, runtime_root=BASE/"rt_tgt", sandbox=False)
    d2 = json.loads((ENGINE/"fixtures/port_annual_autos.json").read_text("utf-8"))
    d2["request_identity"].update(dataset_id="cons", request_id="c1")
    d2["source_bundle"]["raw_source_bytes_custodied"] = True
    d2["expected_parent_snapshot_id"] = s0
    r2 = tsdk.submit(d2)
    s1 = tsdk.head()["snapshot_id"]
    st2 = host_state(tgt)
    hist2 = st2.get("activation_history") or []
    check("C2", "引擎发布追加同一份权威历史",
          r2.get("status") == "published_sandbox" and len(hist2) == 2
          and hist2[-1]["snapshot_id"] == s1 and int(st2.get("update_seq")) == 2,
          f"status={r2.get('status')} seq={st2.get('update_seq')} 历史={[(h['snapshot_id'][:8], h['update_seq']) for h in hist2]}")

    bad = json.loads((tgt/"catalog/state.json").read_text("utf-8"))
    bad["active_head"] = s0
    bad["head_snapshot_sha256"] = "sha256:" + hashlib.sha256((tgt/f"catalog/snapshots/{s0}.json").read_bytes()).hexdigest()
    (tgt/"catalog/state.json").write_text(json.dumps(bad, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    res = StateStore(tgt).resolve(GC(tgt).valid_snapshots())
    check("C3", "指针回退被识别为 HEAD_STALE",
          res["code"] == "HEAD_STALE",
          f"code={res['code']}；{res.get('detail','')[:80]}")

    seq_before = int(host_state(tgt).get("update_seq") or 0)
    cas = StateStore(tgt).activate(s0, tgt/f"catalog/snapshots/{s0}.json", expected_prev=s1,
                                   writer_host="mac-a", writer_epoch=3)
    st4 = host_state(tgt)
    check("C4", "CAS 失败不改 HEAD、不写历史",
          (not cas.get("ok")) and cas.get("code") == "HEAD_CAS_CONFLICT"
          and int(st4.get("update_seq") or 0) == seq_before
          and len(st4.get("activation_history") or []) == 2,
          f"code={cas.get('code')} seq={st4.get('update_seq')} 历史条数={len(st4.get('activation_history') or [])}")

    counts = {"PASS": sum(1 for c in CHECKS if c["status"] == "PASS"), "FAIL": sum(1 for c in CHECKS if c["status"] == "FAIL")}
    BASE.mkdir(parents=True, exist_ok=True)
    (BASE/"results.json").write_text(json.dumps({"format_version": "wfd.f-consistency/1.0", "checks": CHECKS,
                                                  "counts": counts, "work_dir": str(BASE)},
                                                 ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("计数:", counts)
    return 0 if counts["FAIL"] == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
