#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WFD P0-4 实测：增量迁移闭包 + 离线分叉阻断 + 受控接管 + GC 谱系联合（M01—M11）

层次声明（不得混算）：
  本轮全部在**同机不同目录**完成 → 只能得出"迁移与分叉协议正确性"；
  Windows/Mac 实机（M12）本会话无 Windows 主机，记 NOT_RUN。
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
import os
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

VERIFY = Path(__file__).resolve().parent
sys.path.insert(0, str(VERIFY))
from wfd_gc import GC, ClosureError  # noqa: E402
from wfd_lineage import Lineage  # noqa: E402
from wfd_xfer import (StorageTierUnavailable, TransferError, activate, check_fast_forward, export_package,  # noqa: E402
                      host_state, import_package, object_manifest, publish_guard, read_guarded, verify_package,
                      write_host_state)

ENGINE = Path(os.environ.get("WFD_ENGINE", str(Path.home() / "WFD/runtime/engine/WFD_DuckDB_engine_candidate")))
BASE = VERIFY / ("p04_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
SRC = BASE / "source_store"

sys.path.insert(0, str(ENGINE))
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator  # noqa: E402
from wfd_sdk.duckdb_storage import parquet_from_rows  # noqa: E402

CHECKS: list[dict] = []


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def check(cid, title, ok, detail, evidence=None):
    CHECKS.append({"id": cid, "title": title, "status": "PASS" if ok else "FAIL", "detail": detail, "evidence": evidence or {}})
    print(f"[{'PASS' if ok else 'FAIL'}] {cid} {title} — {detail}", flush=True)
    return ok


def sub(cid, title, status, detail, evidence=None):
    CHECKS.append({"id": cid, "title": title, "status": status, "detail": detail, "evidence": evidence or {}})
    print(f"[{status:8s}] {cid} {title} — {detail}", flush=True)


def canon(v):
    from datetime import date, time as dtime
    if v is None: return None
    if isinstance(v, bool): return "bool:" + ("1" if v else "0")
    if isinstance(v, Decimal): return "dec:" + format(v, "f")
    if isinstance(v, datetime): return "ts:" + v.isoformat()
    if isinstance(v, date): return "date:" + v.isoformat()
    if isinstance(v, dtime): return "time:" + v.isoformat()
    if isinstance(v, (bytes, bytearray)): return "hex:" + bytes(v).hex()
    if isinstance(v, float): return "float:nan" if v != v else "float:" + repr(v)
    if isinstance(v, int): return "int:" + str(v)
    if isinstance(v, str): return "s:" + v
    return "repr:" + repr(v)


def canon_obj(o):
    if isinstance(o, dict): return {str(k): canon_obj(v) for k, v in sorted(o.items(), key=lambda kv: str(kv[0]))}
    if isinstance(o, (list, tuple)): return [canon_obj(v) for v in o]
    return canon(o)


def dg(o):
    return "sha256:" + hashlib.sha256(json.dumps(canon_obj(o), ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def sha_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def rows_map(store: Path, runtime: Path, sid: str) -> dict:
    sdk = WFDDuckDBPrototype(Path(store), load_protocol_validator(ENGINE / "protocol"), runtime_root=runtime, sandbox=False)
    return {e["product_id"]: e["rows"] for e in sdk.read_product(snapshot_id=sid)}


def summary(store: Path, sid: str) -> dict:
    rows = rows_map(store, store.parent / "rt" / "read", sid)
    return {"rows": sum(len(v) for v in rows.values()), "digest": dg(rows)}


def new_store(path: Path) -> Path:
    if path.exists():          # 每次测试必须是干净库，避免沿用上一轮的快照与谱系
        shutil.rmtree(path)
    for d in ("catalog/manifests", "catalog/snapshots", "catalog/commits", "catalog/lineage", "catalog/forks"):
        (path / d).mkdir(parents=True, exist_ok=True)
    return path


def build_source() -> dict:
    """S100 → S101 → S102 → S103（压缩）线性谱系。"""
    validator = load_protocol_validator(ENGINE / "protocol")
    sdk = WFDDuckDBPrototype(SRC, validator, runtime_root=BASE / "rt_src", sandbox=False,
                             writer_host="mac-a", writer_epoch=1)
    ids = {}

    def submit(fixture, rid, rename_keys=False):
        doc = json.loads((ENGINE / "fixtures" / fixture).read_text("utf-8"))
        doc["request_identity"]["dataset_id"] = "wfd_p04"
        doc["request_identity"]["request_id"] = rid
        doc["source_bundle"]["raw_source_bytes_custodied"] = True
        if rename_keys:
            for i, row in enumerate(doc["outputs"][0]["payload"]["rows"]):
                row["business_key"] = f"p4_{i}_" + str(row["business_key"])[:40]
        h = sdk.head()
        doc["expected_parent_snapshot_id"] = h["snapshot_id"] if h else None
        res = sdk.submit(doc)
        assert res.get("status") == "published_sandbox", res
        return sdk.head()["snapshot_id"]

    ids["S100"] = submit("port_monthly_teu.json", "p4_s100")
    ids["S101"] = submit("port_monthly_teu.json", "p4_s101", rename_keys=True)
    ids["S102"] = submit("port_annual_autos.json", "p4_s102")
    # 压缩：由引擎负责（ENG-05），同一产品多文件合并为一条输出
    rows_a = {}
    for sid_ in (ids["S100"], ids["S101"]):
        for pid, rows in rows_map(SRC, BASE / "rt_src2", sid_).items():
            rows_a.setdefault(pid, []).extend(rows)
    prod_a = max(rows_a, key=lambda p: len(rows_a[p]))
    comp = sdk.publish_compaction({prod_a: rows_a[prod_a]})
    assert comp.get("status") == "published_compaction", comp

    ids["S103"] = comp["snapshot_id"]
    Lineage(SRC).build_all()
    _seq = int((host_state(SRC).get("update_seq") or 0)) + 1
    write_host_state(SRC, writer_host="mac-a", writer_epoch=1, active_head=ids["S103"],
                     note="source", update_seq=_seq)   # 保留单调递增，避免与激活日志冲突
    return ids
def main() -> int:
    BASE.mkdir(parents=True, exist_ok=True)
    new_store(SRC)
    ids = build_source()
    src_head = ids["S103"]
    src_sum = summary(SRC, src_head)
    import duckdb, pyarrow, platform, importlib.metadata as md
    (BASE / "env.json").write_text(json.dumps({
        "python": sys.version.split()[0], "duckdb": duckdb.__version__, "pyarrow": pyarrow.__version__,
        "jsonschema": md.version("jsonschema"), "platform": platform.platform(),
        "engine": str(ENGINE), "layers": [str(VERIFY / f) for f in ("wfd_gc.py", "wfd_lineage.py", "wfd_xfer.py")]},
        ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # ============================================ M01 完整快照首次迁移
    pkg_m01 = BASE / "pkg_m01"
    t01 = export_package(SRC, ids["S100"], pkg_m01, include_ancestor_data=True)
    tgt = new_store(BASE / "target")
    r01 = import_package(pkg_m01, tgt)
    sdk_t = WFDDuckDBPrototype(tgt, load_protocol_validator(ENGINE / "protocol"), runtime_root=BASE / "rt_tgt", sandbox=False)
    got = rows_map(tgt, BASE / "rt_t01", ids["S100"])
    a1_ok = all((tgt / f["file_relpath"]).is_file() and sha_file(tgt / f["file_relpath"]) == f["file_sha256"].split(":")[-1]
                for f in json.loads((tgt / f"catalog/snapshots/{ids['S100']}.json").read_text("utf-8"))["files"])
    act01 = activate(tgt, ids["S100"], writer_host="mac-a", writer_epoch=1)
    check("M01", "完整 Snapshot 首次迁移（数据+元数据+谱系检查点齐全，可激活）",
          r01["status"] == "imported" and a1_ok and got and act01["status"] == "activated"
          and (tgt / f"catalog/lineage/{ids['S100']}.json").is_file(),
          f"对象 {len(r01['copied'])} 个、元数据 {r01['metadata_written']} 条；文件哈希全对={a1_ok}；激活={act01['status']}；"
          f"谱系检查点={ (tgt / ('catalog/lineage/' + ids['S100'] + '.json')).is_file() }")

    # ============================================ M02 增量闭包（只补缺失对象）
    pkg_m02 = BASE / "pkg_m02"
    t02 = export_package(SRC, ids["S102"], pkg_m02)
    r02 = import_package(pkg_m02, tgt)
    r02b = import_package(pkg_m02, tgt)
    act02 = activate(tgt, ids["S102"], writer_host="mac-a", writer_epoch=1)
    check("M02", "Manifest 增量闭包：只补缺失，哈希一致即复用，重跑零拷贝",
          r02["status"] == "imported" and len(r02["reused"]) > 0 and len(r02["copied"]) > 0
          and r02b["status"] == "imported" and len(r02b["copied"]) == 0 and act02["status"] == "activated",
          f"首次：复用 {len(r02['reused'])} 个、新拷 {len(r02['copied'])} 个；重跑新拷 {len(r02b['copied'])} 个；激活={act02['status']}（HEAD=S102）",
          evidence={"reused": [x["rel_path"] for x in r02["reused"]][:3], "copied": [x["rel_path"] for x in r02["copied"]][:3]})

    # ============================================ M03 正常快进（完整祖先链）
    pkg_m03 = BASE / "pkg_m03"
    t03 = export_package(SRC, ids["S103"], pkg_m03)
    r03 = import_package(pkg_m03, tgt)
    ff = check_fast_forward(tgt, ids["S103"])
    act03 = activate(tgt, ids["S103"], writer_host="mac-a", writer_epoch=1)
    got_t = rows_map(tgt, BASE / "rt_m03", ids["S103"])
    s103_rec = json.loads((SRC / f"catalog/snapshots/{src_head}.json").read_text("utf-8"))
    pids = [f["product_id"] for f in s103_rec["files"]]
    no_dup = len(pids) == len(set(pids))
    sub("M00", "压缩快照无重复文件条目（本轮自检）", "PASS" if no_dup else "FAIL",
        f"S103 文件条目 {len(pids)} 个、去重后 {len(set(pids))} 个")
    check("M03", "正常快进：验证完整祖先链后推进 HEAD，数据与源端一致",
          r03["status"] == "imported" and ff["ok"] and ff["mode"] == "fast_forward"
          and ids["S100"] in ff["chain"] and act03["status"] == "activated"
          and dg(got_t) == src_sum["digest"],
          f"祖先链长度={len(ff['chain'])}（含 S100={ids['S100'] in ff['chain']}）；激活结果={act03.get('status')}/{act03.get('code')} HEAD={act03.get('active_head')}；"
          f"逐产品摘要与源端一致={dg(got_t) == src_sum['digest']}")

    # ============================================ M04 离线分叉阻断
    brA = BASE / "branch_a"; brB = BASE / "branch_b"
    for b in (brA, brB):
        if b.exists(): shutil.rmtree(b)
        shutil.copytree(SRC, b)

    def publish_on(store: Path, fixture: str, rid: str) -> str:
        sdk = WFDDuckDBPrototype(store, load_protocol_validator(ENGINE / "protocol"),
                                 runtime_root=BASE / f"rt_{Path(store).name}", sandbox=False)
        doc = json.loads((ENGINE / "fixtures" / fixture).read_text("utf-8"))
        doc["request_identity"]["dataset_id"] = "wfd_p04"
        doc["request_identity"]["request_id"] = rid
        doc["source_bundle"]["raw_source_bytes_custodied"] = True
        doc["expected_parent_snapshot_id"] = ids["S103"]
        res = sdk.submit(doc)
        assert res.get("status") == "published_sandbox", res
        return sdk.head()["snapshot_id"]

    sidA = publish_on(brA, "seismic_quake_event.json", "p4_fork_a")
    sidB = publish_on(brB, "wdi_v13_candidate.json", "p4_fork_b")
    for b in (brA, brB):
        Lineage(b).build_all()      # 不覆写 state：引擎发布时已激活并写入激活日志，手改会造成 HEAD_STALE
    pkgB = BASE / "pkg_fork_b"
    export_package(brB, sidB, pkgB, include_ancestor_data=False)
    import_package(pkgB, brA)
    fork_res = activate(brA, sidB, writer_host="mac-a", writer_epoch=1)
    head_after = host_state(brA)["active_head"]
    quarantine = (brA / f"catalog/forks/{sidB}.json").is_file()
    commit_quarantined = (brA / f"catalog/forks/{sidB}.commit.json").is_file()
    try:
        engine_head = WFDDuckDBPrototype(brA, load_protocol_validator(ENGINE / "protocol"),
                                         runtime_root=BASE / "rt_fork_probe", sandbox=False).head()["snapshot_id"]
    except Exception as exc:  # noqa: BLE001
        engine_head = f"{type(exc).__name__}: {exc}"
    check("M04", "离线分叉阻断：返回 LINEAGE_FORK_DETECTED，不激活、隔离未激活分支",
          fork_res["status"] == "rejected" and fork_res.get("code") == "LINEAGE_FORK_DETECTED"
          and head_after == sidA and quarantine and commit_quarantined and engine_head == sidA,
          f"码={fork_res.get('code')}；本地 HEAD 未被改写={head_after == sidA}；隔离记录={quarantine}；"
          f"commit 已隔离={commit_quarantined}；引擎 head 仍唯一可用={engine_head == sidA}；"
          f"共同祖先={fork_res.get('detail', {}).get('detail', {}).get('common_ancestor')}")

    # ============================================ M05 单主受控接管
    pkg_m05 = BASE / "pkg_m05"
    sidNew = publish_on(SRC, "port_release_event.json", "p4_handover_new")  # tatqa 样本是未解析主体，会被业务拒绝
    Lineage(SRC).build_all()
    export_package(SRC, sidNew, pkg_m05)
    import_package(pkg_m05, tgt)
    bad = activate(tgt, sidNew, writer_host="win-b", writer_epoch=2)
    handover = {"handover_id": "ho_1", "mode": "voluntary", "base_snapshot_id": sidNew,  # base = 旧主端交接时的 head（=被导入目标）
                "old_writer_host": "mac-a", "old_writer_epoch": 1, "new_writer_host": "win-b",
                "new_writer_epoch": 2, "authorized_by": "owner", "effective_at_utc": now()}
    good = activate(tgt, sidNew, writer_host="win-b", writer_epoch=2, handover=handover)
    old_host_guard = publish_guard(tgt, host="mac-a", epoch=1)
    new_host_guard = publish_guard(tgt, host="win-b", epoch=2)
    check("M05", "单主受控接管：无凭证拒绝、有凭证通过、旧主端 afterwards 无法再发布",
          bad["status"] == "rejected" and bad.get("code") == "WRITER_NOT_AUTHORIZED"
          and good["status"] == "activated" and not old_host_guard["ok"] and new_host_guard["ok"],
          f"无凭证：{bad.get('code')}；有凭证：{good['status']}（新 epoch=2）；旧主端 guard={old_host_guard['ok']}；新主端 guard={new_host_guard['ok']}")

    # ============================================ M06 迁移中断与重试
    t06 = new_store(BASE / "target_m06")
    export_package(SRC, ids["S103"], BASE / "pkg_m06")
    h_before = host_state(t06)
    ri = import_package(BASE / "pkg_m06", t06, interrupt_after=1)
    h_mid = host_state(t06)
    rf = import_package(BASE / "pkg_m06", t06)
    act6 = activate(t06, ids["S103"], writer_host="mac-a", writer_epoch=1)
    act6b = activate(t06, ids["S103"], writer_host="mac-a", writer_epoch=1)
    check("M06", "迁移中断不污染 HEAD，重试不重复发布",
          ri["status"] == "interrupted" and h_mid.get("active_head") is None and rf["status"] == "imported"
          and act6.get("status") == "activated" and (act6b.get("mode") == "already_at_target" or act6b.get("status") == "activated"),
          f"中断时拷贝 {len(ri['copied'])} 个、HEAD 未变={h_mid.get('active_head') is None}；重试补完 {len(rf['copied'])} 个；"
          f"激活一次={act6.get('status')}；再激活={act6b.get('mode') or act6b.get('code')}")

    # ============================================ M07 增量包篡改 / 缺件
    pkg7 = BASE / "pkg_m07"
    export_package(SRC, ids["S102"], pkg7)
    victim = sorted((pkg7 / "objects").glob("*"))[0]
    raw = bytearray(victim.read_bytes()); raw[0] ^= 0xFF; victim.write_bytes(bytes(raw))
    v7 = verify_package(pkg7)
    r7 = import_package(pkg7, new_store(BASE / "target_m07"))
    pkg7b = BASE / "pkg_m07_missing"
    if pkg7b.exists(): shutil.rmtree(pkg7b)
    shutil.copytree(BASE / "pkg_m07", pkg7b)
    export_package(SRC, ids["S102"], pkg7b)  # 重建干净包
    sorted((pkg7b / "objects").glob("*"))[0].unlink()
    r7b = import_package(pkg7b, new_store(BASE / "target_m07b"))
    check("M07", "增量包篡改或缺件：拒绝正式激活",
          v7["ok"] is False and r7["status"] == "rejected" and r7["code"] == "TRANSFER_INTEGRITY_FAILED"
          and r7b["status"] == "rejected" and r7b["code"] == "TRANSFER_INTEGRITY_FAILED",
          f"篡改：verify.ok={v7['ok']} import={r7['status']}/{r7['code']}；缺件：{r7b['status']}/{r7b['code']}")

    # ============================================ M08 迁移与 GC 并行
    def write_retention(store: Path, releases=(), migrations=None):
        cat = store / "catalog"
        for d in ("bundles", "migrations", "leases", "evidence", "gc"):
            (cat / d).mkdir(parents=True, exist_ok=True)
        recs = {}
        for p in (cat / "snapshots").glob("*.json"):
            sid = json.loads(p.read_text("utf-8"))["snapshot_id"]
            recs[sid] = {"state": "released", "reason": "P04_GC_TEST"} if sid in releases else {"state": "retained"}
        (cat / "retention.json").write_text(json.dumps({"format_version": "wfd.retention/1.0", "updated_at_utc": now(),
                                                        "policy": {"auto_expire": False}, "snapshots": recs},
                                                       ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        for old in (cat / "migrations").glob("*.json"):
            old.unlink()
        for k, v in (migrations or {}).items():
            (cat / "migrations" / f"{k}.json").write_text(json.dumps(v, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    a1 = next(f["file_relpath"] for f in json.loads((SRC / f"catalog/snapshots/{ids['S100']}.json").read_text("utf-8"))["files"])
    write_retention(SRC, releases=(ids["S100"], ids["S101"], ids["S102"]),
                    migrations={"mig_p04": {"format_version": "wfd.migration/1.0", "state": "in_progress",
                                            "source_snapshot_id": ids["S102"], "dependencies": [a1],
                                            "started_at_utc": now()}})
    plan8 = GC(SRC).plan()
    blocked8 = {b["rel_path"]: b["reason"] for b in plan8["blocked"]}
    write_retention(SRC, releases=(ids["S100"], ids["S101"], ids["S102"]))
    plan8b = GC(SRC).plan()
    cand8b = {c["rel_path"] for c in plan8b["candidates"]}
    check("M08", "迁移与 GC 并行：未完成迁移引用的文件受保护，完成后才可成为候选",
          a1 in blocked8 and blocked8[a1].startswith("MIGRATION_") and a1 in cand8b,
          f"迁移中：A1 受 {blocked8.get(a1)}；迁移完成后 A1 进入候选={a1 in cand8b}")

    # ============================================ M09 GC 后的历史谱系
    g9 = BASE / "source_after_gc"
    if g9.exists(): shutil.rmtree(g9)
    shutil.copytree(SRC, g9)
    gc9 = GC(g9, keep_metadata=True)
    plan9 = gc9.plan()
    res9 = gc9.execute(plan9, run_id="p04_m09")
    anc9 = Lineage(g9).ancestors(src_head)
    anc9_ids = [c["snapshot_id"] for c in anc9["chain"]]
    pkg9 = BASE / "pkg_after_gc"
    export_package(g9, src_head, pkg9, include_ancestor_data=False)
    t9 = new_store(BASE / "target_after_gc")
    r9 = import_package(pkg9, t9)
    act9 = activate(t9, src_head, writer_host="mac-a", writer_epoch=1)
    anc_t = Lineage(t9).ancestors(src_head)
    anc_t_ids = [c["snapshot_id"] for c in anc_t["chain"]]
    rel_t = Lineage(t9).compare(ids["S102"], src_head)
    parent_unchanged = json.loads((t9 / f"catalog/snapshots/{src_head}.json").read_text("utf-8"))["parent_snapshot_id"] == ids["S102"]
    check("M09", "GC 后历史谱系：数据已回收但祖先链仍可验证，可正确判断快进与分叉",
          res9["deleted"] and anc9["ok"] and ids["S100"] in anc9_ids
          and r9["status"] == "imported" and act9["status"] == "activated"
          and anc_t["ok"] and ids["S100"] in anc_t_ids
          and rel_t["relation"] == "a_is_ancestor_of_b" and parent_unchanged,
          f"GC 删 {len(res9['deleted'])} 个数据文件（元数据保留={gc9.keep_metadata}）；源端祖先链 {len(anc9_ids)} 层含 S100；"
          f"新目标端导入后祖先链 {len(anc_t_ids)} 层；S102 是 S103 祖先={rel_t['relation'] == 'a_is_ancestor_of_b'}；parent 未被改写={parent_unchanged}")

    # ============================================ M10 SQLite 重建与固定版本核对
    idx = Path(WFDDuckDBPrototype(t9, load_protocol_validator(ENGINE / "protocol"),
                                  runtime_root=BASE / "rt_m10", sandbox=False).rebuild_sqlite_index())
    db = sqlite3.connect(idx)
    integ = db.execute("PRAGMA integrity_check").fetchone()[0]
    n_entries = db.execute("SELECT count(*) FROM entries WHERE snapshot_id=?", (src_head,)).fetchone()[0]
    n_all = db.execute("SELECT count(*) FROM entries").fetchone()[0]
    db.close()
    expect_entries = len(json.loads((t9 / f"catalog/snapshots/{src_head}.json").read_text("utf-8"))["files"])
    read_t9 = rows_map(t9, BASE / "rt_m10b", src_head)
    check("M10", "SQLite 重建与固定版本核对：产品/行数/字段值零差异",
          integ == "ok" and n_entries == expect_entries and dg(read_t9) == src_sum["digest"],
          f"重建 integrity={integ}、本快照条目={n_entries}（快照文件数 {expect_entries}）、全库条目={n_all}；"
          f"逐字段摘要与源端一致={dg(read_t9) == src_sum['digest']}")

    # ============================================ M11 冷盘离线
    one = json.loads((t9 / f"catalog/snapshots/{src_head}.json").read_text("utf-8"))["files"][0]
    (t9 / "catalog").mkdir(parents=True, exist_ok=True)
    (t9 / "catalog/mount_map.json").write_text(json.dumps({"format_version": "wfd.mount/1.0", "objects": {
        one["file_sha256"].split(":")[-1]: {"tier": "EXTERNAL_COLD", "mounted": False, "mount_root_id": "wfd_exfat"}}},
        ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    err = None
    try:
        read_guarded(t9, src_head, lambda s, sid: rows_map(s, BASE / "rt_m11", sid))
    except StorageTierUnavailable as exc:
        err = str(exc)
    rows_after = None
    (t9 / "catalog/mount_map.json").write_text(json.dumps({"format_version": "wfd.mount/1.0", "objects": {
        one["file_sha256"].split(":")[-1]: {"tier": "EXTERNAL_COLD", "mounted": True, "mount_root_id": "wfd_exfat"}}},
        ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    rows_after = read_guarded(t9, src_head, lambda s, sid: rows_map(s, BASE / "rt_m11b", sid))
    check("M11", "冷盘离线：显式 STORAGE_TIER_UNAVAILABLE，挂载恢复后正常读，不误报空表",
          err is not None and err.startswith("STORAGE_TIER_UNAVAILABLE") and rows_after is not None
          and sum(len(v) for v in rows_after.values()) == src_sum["rows"],
          f"未挂载→{err[:60]}…；挂载后行数={sum(len(v) for v in rows_after.values())}（源端 {src_sum['rows']}）")

    # ============================================ M12 双向实机
    sub("M12", "双向跨端实机（Windows ↔ Mac）", "NOT_RUN",
        "本会话无 Windows 主机；此前单方向 xp_20261026_015421 仅证明 Windows→exFAT→Mac，不构成双向验收")

    return finish(ids, src_sum)


def finish(ids, src_sum) -> int:
    counts = {}
    for c in CHECKS:
        counts[c["status"]] = counts.get(c["status"], 0) + 1
    result = {"format_version": "wfd.p04-verify/1.0", "generated_at_utc": now(), "work_dir": str(BASE),
              "snapshots": ids, "source_summary": src_sum, "checks": CHECKS, "counts": counts,
              "layers": {"same_machine_diff_dirs": "本轮全部测试所在层次",
                         "windows_mac_real": "NOT_RUN", "exfat_transfer_interrupt": "NOT_RUN", "full_M01_M12": "NOT_RUN"},
              "verdict": {"overall": "PASS" if not counts.get("FAIL") else "FAIL",
                          "protocol_correctness": "PASS" if not counts.get("FAIL") else "FAIL",
                          "cross_platform_acceptance": "NOT_RUN",
                          "production_accepted": False,
                          "note": "同机不同目录只证明迁移/分叉/接管协议正确性；跨平台与 exFAT 故障恢复未验证。"}}
    (BASE / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# P0-4 实测报告：增量闭包 + 分叉阻断 + 受控接管 + GC 谱系（M01—M11）", "",
             f"- 时间（UTC）：{result['generated_at_utc']}", f"- 工作区：{BASE}", f"- 计数：{counts}", "",
             "| ID | 检查 | 状态 | 说明 |", "| --- | --- | --- | --- |"]
    for c in CHECKS:
        lines.append(f"| {c['id']} | {c['title']} | {c['status']} | {c['detail'].replace('|','/')[:230]} |")
    lines += ["", "## 层次与边界", "",
              "| 验证层次 | 本轮结论 |", "| --- | --- |",
              "| 同机不同目录 | 迁移与分叉协议正确性通过 |",
              "| Windows 与 Mac 实机 | NOT_RUN（本会话无 Windows 主机） |",
              "| 真实 exFAT 传输中断 | NOT_RUN |",
              "| 完整 M01—M12 | NOT_RUN（M12 未做） |", "",
              "- 离线双写无法实时阻止；只在重连/导入时检测分叉（M04 验证）。",
              "- 受控接管用持久化 `writer_epoch` + 交接凭证；旧主端交接后发布被拒（M05 验证）。",
              "- `production_accepted=false`。", ""]
    (BASE / "REPORT.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"\n结果：{BASE/'results.json'}\n计数：{counts}")
    return 0 if not counts.get("FAIL") else 2


if __name__ == "__main__":
    sys.exit(main())
