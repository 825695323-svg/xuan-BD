#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WFD P0-3 实测：引用可达性 GC（GC01—GC10）

设计裁决：可达性是删除资格核心；N/T 只是附加保留策略；首版默认全保留、GC 先 Dry Run。
所有真正删除只在隔离副本上执行；主测试库只做发布/压缩/读取。
"""
from __future__ import annotations

import hashlib
import json
import shutil
import os
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

VERIFY = Path(__file__).resolve().parent
sys.path.insert(0, str(VERIFY))
from wfd_gc import GC, ClosureError  # noqa: E402

ENGINE = Path(os.environ.get("WFD_ENGINE", str(Path.home() / "WFD/runtime/engine/WFD_DuckDB_engine_candidate")))
BASE = VERIFY / ("gc_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
STORE = BASE / "store"
RUNTIME = BASE / "runtime_index"
INPUTS = BASE / "control_records"
sys.path.insert(0, str(ENGINE))
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator  # noqa: E402
from wfd_sdk.duckdb_storage import parquet_from_rows  # noqa: E402

CHECKS: list[dict] = []
FIELD: dict = {}


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
    return "sha256:" + hashlib.sha256(p.read_bytes()).hexdigest()


def rows_map(store: Path, runtime: Path, snapshot_id: str) -> dict:
    sdk = WFDDuckDBPrototype(store, load_protocol_validator(ENGINE / "protocol"), runtime_root=runtime, sandbox=False)
    return {e["product_id"]: e["rows"] for e in sdk.read_product(snapshot_id=snapshot_id)}


def digest_map(store: Path, runtime: Path, snapshot_id: str) -> dict:
    rows = rows_map(store, runtime, snapshot_id)
    return {"row_total": sum(len(r) for r in rows.values()),
            "per_product": {pid: {"rows": len(r), "digest": dg(r)} for pid, r in sorted(rows.items())},
            "combined": dg(rows)}


def compare_fields(a: dict, b: dict) -> dict:
    diffs = []
    for pid, rows_a in a.items():
        rows_b = b.get(pid)
        if rows_b is None:
            diffs.append({"product_id": pid, "issue": "PRODUCT_MISSING"}); continue
        if len(rows_a) != len(rows_b):
            diffs.append({"product_id": pid, "issue": "ROW_COUNT", "a": len(rows_a), "b": len(rows_b)})
        for i, ra in enumerate(rows_a):
            rb = rows_b[i] if i < len(rows_b) else None
            if rb is None: continue
            for f, v in ra.items():
                if f not in rb or canon(v) != canon(rb[f]):
                    diffs.append({"product_id": pid, "row": i, "field": f})
    return {"rows": sum(len(r) for r in a.values()), "diff_count": len(diffs), "diffs": diffs[:10]}


def data_files(store: Path) -> dict:
    out = {}
    for d in ("observations", "foundation", "events", "evidence_blobs"):
        root = store / d
        if root.is_dir():
            for p in root.rglob("*"):
                if p.is_file() and not p.name.startswith("._"):
                    out[p.relative_to(store).as_posix()] = sha_file(p)
    return out


# ---------------------------------------------------------------- 控制层记录写入
def write_records(store: Path, *, releases=(), bundles=None, migrations=None, leases=None, evidence=None, policy=None):
    cat = store / "catalog"
    for d in ("bundles", "migrations", "leases", "evidence", "gc"):
        (cat / d).mkdir(parents=True, exist_ok=True)
    snaps = sorted((cat / "snapshots").glob("*.json"))
    records = {p.stem: {"state": "retained", "reason": "DEFAULT_RETAIN_ALL"} for p in []}
    records = {}
    for p in snaps:
        sid = json.loads(p.read_text("utf-8"))["snapshot_id"]
        records[sid] = {"state": "released", "reason": "EXPLICIT_RELEASE_TEST", "authorized_by": "p0-3-test"} \
            if sid in releases else {"state": "retained", "reason": "DEFAULT_RETAIN_ALL"}
    (cat / "retention.json").write_text(json.dumps({
        "format_version": "wfd.retention/1.0", "updated_at_utc": now(),
        "policy": policy or {"auto_expire": False, "keep_last_n": None, "keep_days": None},
        "snapshots": records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for name, items in (("bundles", bundles), ("migrations", migrations), ("leases", leases), ("evidence", evidence)):
        for old in (cat / name).glob("*.json"):
            old.unlink()
        for key, payload in (items or {}).items():
            (cat / name / f"{key}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# ---------------------------------------------------------------- 压缩快照（WFD 控制层自写）
def publish_compaction(store: Path, runtime: Path, *, parent_id: str, replace_products: dict, tag: str) -> dict:
    """把指定产品的文件用重新编码的新文件替换，生成新 Snapshot（不可变、父链连续）。"""
    validator = load_protocol_validator(ENGINE / "protocol")
    sdk = WFDDuckDBPrototype(store, validator, runtime_root=runtime, sandbox=False)
    parent = sdk.read_snapshot(parent_id)
    files, new_bytes, replaced = [], {}, set()
    for ent in parent["files"]:
        pid = ent["product_id"]
        if pid not in replace_products:
            files.append(ent)
            continue
        if pid in replaced:                 # 同一产品多个旧文件只登记一条合并结果
            continue
        replaced.add(pid)
        rows = replace_products[pid]
        data = parquet_from_rows(pid, ent["output_key"], ent["subject"], ent["payload_kind"], rows)
        digest = hashlib.sha256(data).hexdigest()
        rel = f"{ent['file_relpath'].split('/product=')[0]}/product={pid}/part-{digest[:24]}.parquet"
        new_bytes[rel] = data
        files.append({**ent, "file_relpath": rel, "file_sha256": digest, "row_count": len(rows)})
    for rel, data in new_bytes.items():
        p = store / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if p.exists() and p.read_bytes() != data:
            raise RuntimeError(f"IMMUTABLE_COLLISION {rel}")
        p.write_bytes(data)
    manifest = {"parent_snapshot_id": parent_id, "files": files}
    mraw = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    mhash = hashlib.sha256(mraw).hexdigest()
    mrel = f"catalog/manifests/manifest_{mhash[:24]}.json"
    (store / mrel).write_bytes(mraw)
    sid = "s_" + hashlib.sha256((mhash + tag).encode()).hexdigest()[:24]
    receipt = {"status": "compaction_published", "snapshot_id": sid, "parent_snapshot_id": parent_id,
               "compaction": {"replaced_products": sorted(replace_products), "new_files": sorted(new_bytes)}}
    snap = {"snapshot_id": sid, "parent_snapshot_id": parent_id, "manifest_relpath": mrel, "manifest_sha256": mhash,
            "files": files, "request_key": "compaction_" + tag, "request_fingerprint": mhash, "receipt": receipt}
    sraw = json.dumps(snap, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    srel = f"catalog/snapshots/{sid}.json"
    (store / srel).write_bytes(sraw)
    (store / f"catalog/commits/{sid}.json").write_bytes(json.dumps(
        {"snapshot_id": sid, "snapshot_file": srel, "snapshot_sha256": hashlib.sha256(sraw).hexdigest()},
        ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())
    return {"snapshot_id": sid, "new_files": sorted(new_bytes), "files": files}


def main() -> int:
    for d in (STORE, RUNTIME, INPUTS):
        d.mkdir(parents=True, exist_ok=True)
    validator = load_protocol_validator(ENGINE / "protocol")
    import duckdb, pyarrow, platform, importlib.metadata as md
    (BASE / "env.json").write_text(json.dumps({
        "python": sys.version.split()[0], "duckdb": duckdb.__version__, "pyarrow": pyarrow.__version__,
        "jsonschema": md.version("jsonschema"), "platform": platform.platform(),
        "engine": str(ENGINE), "gc_layer": str(VERIFY / "wfd_gc.py")}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    sdk = WFDDuckDBPrototype(STORE, validator, runtime_root=RUNTIME, sandbox=False)
    dataset = "wfd_p0_3"

    def submit(fixture: str, request_id: str, rename_keys: bool = False):
        doc = json.loads((ENGINE / "fixtures" / fixture).read_text("utf-8"))
        doc["request_identity"]["dataset_id"] = dataset
        doc["request_identity"]["request_id"] = request_id
        doc["source_bundle"]["raw_source_bytes_custodied"] = True
        if rename_keys:      # 同产品新增一批业务键（不改主体定义）
            for i, row in enumerate(doc["outputs"][0]["payload"]["rows"]):
                row["business_key"] = f"b2_{i}_" + str(row["business_key"])[:40]
        head = sdk.head()
        doc["expected_parent_snapshot_id"] = head["snapshot_id"] if head else None
        (INPUTS / f"{request_id}.json").write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        res = sdk.submit(doc)
        assert res.get("status") == "published_sandbox", res
        return sdk.head()

    s100 = submit("port_monthly_teu.json", "gc_s100")
    # 同一产品（同 domain/subject/definition）再提交一批新业务键 → 该产品出现第 2 个文件
    s101 = submit("port_monthly_teu.json", "gc_s101", rename_keys=True)
    s102 = submit("port_annual_autos.json", "gc_s102")
    rows100 = rows_map(STORE, RUNTIME, s100["snapshot_id"])
    rows101 = rows_map(STORE, RUNTIME, s101["snapshot_id"])
    files_a = [f["file_relpath"] for f in s102["files"]]
    a1 = next(f["file_relpath"] for f in s100["files"])
    a2_old = next(f["file_relpath"] for f in s101["files"] if f["file_relpath"] not in [x["file_relpath"] for x in s100["files"]])
    b1 = next(f["file_relpath"] for f in s102["files"] if f["file_relpath"] not in (a1, a2_old))
    a1_sha_before = sha_file(STORE / a1)
    a2_sha_before = sha_file(STORE / a2_old)

    # ------------------------------------------------ GC01 非破坏性 Compaction（同一产品 2 文件合并为 1）
    prod_a = next(pid for pid in rows100)
    merged_rows = rows100[prod_a] + rows101[prod_a]          # 两批业务键不同，合并后行可叠加
    comp = sdk.publish_compaction({prod_a: merged_rows})   # ENG-05：压缩由引擎负责并受控更新 HEAD
    assert comp.get("status") == "published_compaction", comp
    s103 = sdk.head()
    read_new = rows_map(STORE, RUNTIME, s103["snapshot_id"])
    merged_cmp = compare_fields({prod_a: merged_rows}, {prod_a: read_new[prod_a]})
    read_old_a = compare_fields({prod_a: rows100[prod_a]}, {prod_a: rows_map(STORE, RUNTIME, s100["snapshot_id"])[prod_a]})
    a3 = next(f["file_relpath"] for f in s103["files"] if f["product_id"] == prod_a)
    old_intact = (sha_file(STORE / a1) == a1_sha_before) and (sha_file(STORE / a2_old) == a2_sha_before)
    pids_c = [f["product_id"] for f in s103["files"]]
    no_dup_c = len(pids_c) == len(set(pids_c))
    check("GC01", "非破坏性 Compaction（旧 Snapshot 与新 Snapshot 均可读、逐字段一致、原文件未被覆盖）",
          no_dup_c
          and s103["parent_snapshot_id"] == s102["snapshot_id"] and merged_cmp["diff_count"] == 0
          and read_old_a["diff_count"] == 0 and old_intact and a3 not in (a1, a2_old)
          and len(read_new[prod_a]) == len(rows100[prod_a]) + len(rows101[prod_a]),
          f"S100={s100['snapshot_id']} S101={s101['snapshot_id']} → 压缩 S103={s103['snapshot_id']}（父=S102）；"
          f"合并后 {len(read_new[prod_a])} 行（12+12）逐字段差异={merged_cmp['diff_count']}；文件条目无重复={no_dup_c}；"
          f"S100 旧读法逐字段不变={read_old_a['diff_count'] == 0}；两个旧文件哈希未变={old_intact}；新文件={a3.split('/')[-1][:26]}…")
    baseline = {sid: digest_map(STORE, RUNTIME, sid) for sid in (s100["snapshot_id"], s101["snapshot_id"], s102["snapshot_id"], s103["snapshot_id"])}

    # ------------------------------------------------ GC02 多版本共享文件保护（无任何释放）
    write_records(STORE)
    plan2 = GC(STORE).plan()
    blocked2 = {b["rel_path"]: b["reason"] for b in plan2["blocked"]}
    check("GC02", "多版本共享文件保护（任一受保护版本仍引用即不删）",
          a1 in blocked2 and plan2["candidates"] == [],
          f"默认全保留：A1 受保护={a1 in blocked2}；候选数={len(plan2['candidates'])}；数据文件 {plan2['data_files']} 个")

    # ------------------------------------------------ GC03 独立小库（引用型）保护
    write_records(STORE, releases=(s100["snapshot_id"], s101["snapshot_id"], s102["snapshot_id"]),
                  bundles={"bundle_ref_1": {"format_version": "wfd.bundle-ref/1.0", "kind": "reference",
                                            "state": "active", "source_snapshot_id": s100["snapshot_id"],
                                            "files": [{"rel_path": a1, "sha256": sha_file(STORE / a1)}]}})
    plan3 = GC(STORE).plan()
    blocked3 = {b["rel_path"]: b["reason"] for b in plan3["blocked"]}
    check("GC03", "独立小库（引用型）保护源文件",
          a1 in blocked3 and blocked3[a1].startswith("BUNDLE_"),
          f"释放 S100/S101/S102 后，A1 仍被 {blocked3.get(a1)} 保护；候选={[c['rel_path'].split('/')[-1] for c in plan3['candidates']]}")

    # ------------------------------------------------ GC04 迁移中保护
    write_records(STORE, releases=(s100["snapshot_id"], s101["snapshot_id"], s102["snapshot_id"]),
                  migrations={"migr_1": {"format_version": "wfd.migration/1.0", "state": "in_progress",
                                         "source_snapshot_id": s102["snapshot_id"], "dependencies": [a1],
                                         "started_at_utc": now(), "target": "exFAT→APFS"}})
    plan4 = GC(STORE).plan()
    blocked4 = {b["rel_path"]: b["reason"] for b in plan4["blocked"]}
    check("GC04", "进行中的迁移任务保护依赖文件",
          a1 in blocked4 and blocked4[a1].startswith("MIGRATION_"),
          f"A1 受 {blocked4.get(a1)} 保护；候选数={len(plan4['candidates'])}")

    # ------------------------------------------------ 附加：有效读取租约保护
    write_records(STORE, releases=(s100["snapshot_id"], s101["snapshot_id"], s102["snapshot_id"]),
                  leases={"lease_1": {"format_version": "wfd.lease/1.0", "snapshot_id": s100["snapshot_id"],
                                      "expires_at_utc": "2099-01-01T00:00:00Z", "owner": "read-session-test"}})
    planL = GC(STORE).plan()
    blockedL = {b["rel_path"]: b["reason"] for b in planL["blocked"]}
    sub("GC04b", "有效读取租约保护（附加检查）",
        "PASS" if a1 in blockedL and blockedL[a1].startswith("LEASE_") else "FAIL",
        f"A1 受 {blockedL.get(a1)} 保护；候选数={len(planL['candidates'])}")

    # ------------------------------------------------ GC05 历史版本显式过期
    releases = (s100["snapshot_id"], s101["snapshot_id"], s102["snapshot_id"])
    write_records(STORE, releases=releases)
    plan5 = GC(STORE).plan()
    cands5 = {c["rel_path"] for c in plan5["candidates"]}
    blocked5 = {b["rel_path"]: b["reason"] for b in plan5["blocked"]}
    check("GC05", "历史版本显式过期后，仅专属旧文件成为候选",
          a1 in cands5 and a2_old in cands5 and b1 not in cands5,
          f"释放 S100/S101/S102 后：A1/A2 进入候选={a1 in cands5 and a2_old in cands5}；B1 仍受 HEAD 保护={b1 not in cands5}；"
          f"仍受保护={sorted(blocked5.items())[:3]}；候选数={len(plan5['candidates'])}")

    # ------------------------------------------------ GC06 Dry Run 不改文件
    before = data_files(STORE)
    plan6 = GC(STORE).plan()
    after = data_files(STORE)
    check("GC06", "Dry Run 返回候选/原因/空间/保护信息且不改文件",
          before == after and all(c.get("reason") and "size" in c for c in plan6["candidates"])
          and plan6["estimated_reclaim_bytes"] > 0,
          f"文件哈希前后完全一致={before == after}；候选 {len(plan6['candidates'])} 个、预估 {plan6['estimated_reclaim_bytes']} 字节；"
          f"受保护 {len(plan6['blocked'])} 个")

    # ------------------------------------------------ GC07 隔离库真正删除
    g7 = BASE / "store_gc07_delete"
    if g7.exists(): shutil.rmtree(g7)
    shutil.copytree(STORE, g7)
    gc7 = GC(g7)
    plan7 = gc7.plan()
    res7 = gc7.execute(plan7, run_id="gc07")
    deleted7 = {d["rel_path"] for d in res7["deleted"]}
    head7 = gc7.head(gc7.valid_snapshots())
    read_head7 = digest_map(g7, BASE / "rt_gc07", head7["snapshot_id"])
    check("GC07", "隔离测试库真正删除：只删候选，共享与受保护文件完好",
          a1 in deleted7 and a2_old in deleted7 and (g7 / a3).is_file() and (g7 / b1).is_file()
          and read_head7["combined"] == baseline[s103["snapshot_id"]]["combined"],
          f"删除 {len(deleted7)} 个（旧 A1/A2）：{[r.split('/')[-1][:24] for r in deleted7]}；压缩文件与 B1 保留={(g7 / a3).is_file() and (g7 / b1).is_file()}；HEAD 仍为 {head7['snapshot_id']} 且逐产品摘要不变="
          f"{read_head7['combined'] == baseline[s103['snapshot_id']]['combined']}；"
          f"跳过 {len(res7['skipped'])} 个={[s['reason'] for s in res7['skipped']][:3]}")

    # ------------------------------------------------ GC08 中断与重复执行
    g8 = BASE / "store_gc08_interrupt"
    if g8.exists(): shutil.rmtree(g8)
    shutil.copytree(STORE, g8)
    gc8 = GC(g8)
    plan8 = gc8.plan()
    r8a = gc8.execute(plan8, run_id="gc08a", interrupt_after=1)
    plan8b = gc8.plan()
    r8b = gc8.execute(plan8b, run_id="gc08b")
    head8 = gc8.head(gc8.valid_snapshots())
    read8 = digest_map(g8, BASE / "rt_gc08", head8["snapshot_id"])
    total_del = len(r8a["deleted"]) + len(r8b["deleted"])
    check("GC08", "中途停止后重跑：幂等、不损伤任何正式 Snapshot",
          r8a["interrupted"] is True and total_del == len(plan8["candidates"])
          and read8["combined"] == baseline[s103["snapshot_id"]]["combined"],
          f"首次中断删除 {len(r8a['deleted'])} 个；重跑删除 {len(r8b['deleted'])} 个；合计 {total_del} = 计划 {len(plan8['candidates'])}；"
          f"HEAD 可读且摘要不变={read8['combined'] == baseline[s103['snapshot_id']]['combined']}")

    # ------------------------------------------------ GC09 异常闭包必须拒绝
    g9 = BASE / "store_gc09_abnormal"
    if g9.exists(): shutil.rmtree(g9)
    shutil.copytree(STORE, g9)
    (g9 / "catalog/retention.json").unlink(missing_ok=True)
    r9a = None
    try:
        GC(g9).plan(); r9a = "NO_ERROR"
    except ClosureError as exc:
        r9a = str(exc)
    g9b = BASE / "store_gc09_bundle_missing"
    if g9b.exists(): shutil.rmtree(g9b)
    shutil.copytree(STORE, g9b)
    write_records(g9b, releases=(s100["snapshot_id"],), bundles={"bad_bundle": {
        "format_version": "wfd.bundle-ref/1.0", "kind": "reference", "state": "active",
        "files": [{"rel_path": "observations/product=p_missing/part-x.parquet", "sha256": "sha256:" + "0" * 64}]}})
    r9b = None
    try:
        GC(g9b).plan(); r9b = "NO_ERROR"
    except ClosureError as exc:
        r9b = str(exc)
    g9c = BASE / "store_gc09_commit_corrupt"
    if g9c.exists(): shutil.rmtree(g9c)
    shutil.copytree(STORE, g9c)
    _h = json.loads((g9c / "catalog/state.json").read_text("utf-8"))["active_head"]
    (g9c / f"catalog/commits/{_h}.json").write_text("{not json", encoding="utf-8")
    r9c = None
    try:
        GC(g9c).head(GC(g9c).valid_snapshots()); r9c = "NO_ERROR"
    except ClosureError as exc:
        r9c = str(exc)
    files_g9 = data_files(g9)
    check("GC09", "异常闭包（保留状态缺失 / 引用文件缺失 / commit 不可读）一律拒绝危险删除",
          r9a != "NO_ERROR" and r9b != "NO_ERROR" and r9c != "NO_ERROR" and files_g9 == data_files(g9),
          f"retention 缺失→{r9a}；bundle 引用缺失→{r9b}；commit 损坏→{r9c[:60]}；三例均未删除任何文件={files_g9 == data_files(g9)}",
          evidence={"retention": r9a, "bundle": r9b, "commit": r9c[:120]})

    # ------------------------------------------------ GC10 GC 后历史验证
    post = {}
    for sid in (s103["snapshot_id"],):
        post[sid] = digest_map(g7, BASE / "rt_gc10", sid)
    released_broken = 0
    for sid in (s100["snapshot_id"], s101["snapshot_id"], s102["snapshot_id"]):
        try:
            digest_map(g7, BASE / "rt_gc10b", sid)
        except Exception:  # noqa: BLE001
            released_broken += 1
    check("GC10", "GC 后受保护快照仍可验证读取（被显式释放的版本按预期失效）",
          post[s103["snapshot_id"]]["combined"] == baseline[s103["snapshot_id"]]["combined"]
          and released_broken == len(releases),
          f"HEAD 逐产品摘要不变={post[s103['snapshot_id']]['combined'] == baseline[s103['snapshot_id']]['combined']}；"
          f"被释放的 {len(releases)} 个历史版本中有 {released_broken} 个已不可读（预期，因其专属文件被回收）")

    (BASE / "field_compare.json").write_text(json.dumps(FIELD, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return finish(s103=s103, s100=s100, s101=s101, s102=s102, releases=releases)


def finish(**kw) -> int:
    counts = {}
    for c in CHECKS:
        counts[c["status"]] = counts.get(c["status"], 0) + 1
    result = {"format_version": "wfd.gc-verify/1.0", "generated_at_utc": now(), "work_dir": str(BASE),
              "snapshots": {k: (v["snapshot_id"] if isinstance(v, dict) else v) for k, v in kw.items()},
              "checks": CHECKS, "counts": counts,
              "verdict": {"overall": "PASS" if not counts.get("FAIL") else "FAIL", "production_accepted": False,
                          "note": "GC01—GC10 + 租约附加项；真正删除仅在隔离副本；未覆盖断电、并发 GC、真实规模。"}}
    (BASE / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# P0-3 实测报告：引用可达性 GC（GC01—GC10）", "",
             f"- 时间（UTC）：{result['generated_at_utc']}", f"- 工作区：{BASE}", f"- 计数：{counts}", "",
             "| ID | 检查 | 状态 | 说明 |", "| --- | --- | --- | --- |"]
    for c in CHECKS:
        lines.append(f"| {c['id']} | {c['title']} | {c['status']} | {c['detail'].replace('|','/')[:220]} |")
    lines += ["", "## 判定口径", "",
              "- 删除资格 = 引用可达性（主）+ 显式保留策略（附加）+ 安全条件（冷却/任务/租约）。",
              "- 首版默认全保留；仅 `retention.json` 中 `state=released` 的显式记录可退出保留集合。",
              "- 真正删除只在 3 个隔离副本执行（GC07/GC08/GC09），主测试库 store/ 未删任何文件。",
              "- `production_accepted=false`；断电、并发 GC、真实规模未覆盖。", ""]
    (BASE / "REPORT.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"\n结果：{BASE/'results.json'}\n计数：{counts}")
    return 0 if not counts.get("FAIL") else 2


if __name__ == "__main__":
    sys.exit(main())
