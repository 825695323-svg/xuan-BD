#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WFD P0 补测：正式发布闭环（T01/T02）+ 故障恢复闭环（T03/T04）

纪律（按本轮要求）：
1) 只在隔离副本上做篡改/重试/恢复，不碰唯一正式数据卷；
2) 每次故障后都真读旧 Snapshot，核对产品/行数/字段值/SHA-256，证明历史未被污染；
3) 不自动修复。所有"恢复"都只报告：损坏记录、恢复依据、恢复前后 HEAD。

运行：~/WFD/runtime/venv/bin/python run_p0_verify.py
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

ENGINE = Path(os.environ.get("WFD_ENGINE", str(Path.home() / "WFD/runtime/engine/WFD_DuckDB_engine_candidate")))
BASE = Path(__file__).resolve().parent / ("p0_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
STORE = BASE / "store"
RUNTIME = BASE / "runtime_index"
INPUTS = BASE / "inputs"

sys.path.insert(0, str(ENGINE))
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator  # noqa: E402

CHECKS: list[dict] = []


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def check(cid: str, title: str, ok: bool, detail: str, evidence=None) -> bool:
    CHECKS.append({"id": cid, "title": title, "status": "PASS" if ok else "FAIL",
                   "detail": detail, "evidence": evidence or {}})
    print(f"[{'PASS' if ok else 'FAIL'}] {cid} {title} — {detail}", flush=True)
    return ok


def sub(cid: str, title: str, status: str, detail: str, evidence=None) -> None:
    """子项记录（T04 的 commit 与 HEAD 必须分开记账）"""
    CHECKS.append({"id": cid, "title": title, "status": status, "detail": detail, "evidence": evidence or {}})
    print(f"[{status:8s}] {cid} {title} — {detail}", flush=True)


# ---------------------------------------------------------------- 指纹与哈希（与规划书附录 A0 同实现）
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


def dg(o) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(canon_obj(o), ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def product_digests(entries: list[dict]) -> dict:
    out = []
    for e in sorted(entries, key=lambda x: x.get("product_id", "")):
        rows = e.get("rows") or []; meta = e.get("metadata") or {}
        out.append({"product_id": e["product_id"], "payload_kind": meta.get("payload_kind"),
                    "row_count": len(rows), "rows_digest": dg(rows)})
    return {"products": out, "row_total": sum(x["row_count"] for x in out), "combined_digest": dg(out)}


def sha_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def head_files_hash_map(store: Path, snapshot: dict) -> dict:
    return {f["file_relpath"]: sha_file(store / f["file_relpath"]) for f in snapshot["files"]}


def snapshot_evidence(store: Path, snapshot: dict) -> dict:
    """快照的可核对证据：文件哈希 + 快照/清单哈希 + 行级摘要。"""
    manifest_path = store / snapshot["manifest_relpath"]
    return {
        "snapshot_id": snapshot["snapshot_id"],
        "parent": snapshot.get("parent_snapshot_id"),
        "files": head_files_hash_map(store, snapshot),
        "manifest_sha256": sha_file(manifest_path),
        "snapshot_file_sha256": None,
    }


FIELD_COMPARE: dict = {}


def rows_of(store: Path, runtime: Path, snapshot_id: str) -> dict:
    sdk = WFDDuckDBPrototype(store, load_protocol_validator(ENGINE / "protocol"), runtime_root=runtime, sandbox=False)
    out = {}
    for ent in sdk.read_product(snapshot_id=snapshot_id):
        out[ent["product_id"]] = ent["rows"]
    return out


def compare_fields(baseline: dict, current: dict) -> dict:
    """逐产品、逐行、逐字段对照，返回差异计数与示例。"""
    diffs, rows, fields = [], 0, 0
    for pid, base_rows in baseline.items():
        cur_rows = current.get(pid)
        if cur_rows is None:
            diffs.append({"product_id": pid, "issue": "PRODUCT_MISSING"}); continue
        if len(cur_rows) != len(base_rows):
            diffs.append({"product_id": pid, "issue": "ROW_COUNT", "baseline": len(base_rows), "current": len(cur_rows)})
        for i, b in enumerate(base_rows):
            c = cur_rows[i] if i < len(cur_rows) else None
            if c is None: continue
            rows += 1
            for f, v in b.items():
                fields += 1
                if f not in c or canon(c[f]) != canon(v):
                    diffs.append({"product_id": pid, "row": i, "field": f, "baseline": canon(v), "current": canon(c.get(f))})
    return {"rows": rows, "fields": fields, "diff_count": len(diffs), "diffs": diffs[:20]}


def read_fixed(store: Path, runtime: Path, snapshot_id: str) -> dict:
    sdk = WFDDuckDBPrototype(store, load_protocol_validator(ENGINE / "protocol"), runtime_root=runtime, sandbox=False)
    return product_digests(sdk.read_product(snapshot_id=snapshot_id))


def main() -> int:
    for d in (STORE, RUNTIME, INPUTS):
        d.mkdir(parents=True, exist_ok=True)
    validator = load_protocol_validator(ENGINE / "protocol")

    # 环境记录
    import importlib.metadata as md
    import duckdb, pyarrow, platform
    env = {"python": sys.version.split()[0], "duckdb": duckdb.__version__, "pyarrow": pyarrow.__version__,
           "jsonschema": md.version("jsonschema"), "referencing": md.version("referencing"),
           "platform": platform.platform(), "engine": str(ENGINE)}
    (BASE / "env.json").write_text(json.dumps(env, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # ============================================================ 准备：先发一个纯合格基线（v0）
    sdk = WFDDuckDBPrototype(STORE, validator, runtime_root=RUNTIME, sandbox=False)
    base_doc = json.loads((ENGINE / "fixtures" / "port_monthly_teu.json").read_text("utf-8"))
    base_doc["request_identity"]["dataset_id"] = "wfd_p0"
    base_doc["request_identity"]["request_id"] = "p0_base_v0"
    base_doc["source_bundle"]["raw_source_bytes_custodied"] = True
    base_doc["expected_parent_snapshot_id"] = None
    (INPUTS / "00_base_v0.json").write_text(json.dumps(base_doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    r0 = sdk.submit(base_doc)
    v0 = sdk.head()
    v0_digest = read_fixed(STORE, RUNTIME, v0["snapshot_id"])
    v0_ev = snapshot_evidence(STORE, v0)
    v0_rows = rows_of(STORE, RUNTIME, v0["snapshot_id"])
    check("T00", "基线快照（纯合格，作为旧版本污染对照）", r0.get("status") == "published_sandbox" and v0 is not None,
          f"v0={v0['snapshot_id']} 产品={v0_digest['products'].__len__()} 行={v0_digest['row_total']} digest={v0_digest['combined_digest'][:23]}…")

    # ============================================================ T01 部分成功发布
    mixed = json.loads((ENGINE / "fixtures" / "port_annual_autos.json").read_text("utf-8"))
    bad_out = json.loads((ENGINE / "fixtures" / "unknown_vehicle_negative.json").read_text("utf-8"))["outputs"][0]
    mixed["outputs"] = [mixed["outputs"][0], bad_out]          # 一条合格 + 一条业务不合格
    mixed["request_identity"]["dataset_id"] = "wfd_p0"
    mixed["request_identity"]["request_id"] = "p0_mixed_t01"
    mixed["source_bundle"]["raw_source_bytes_custodied"] = True
    mixed["expected_parent_snapshot_id"] = v0["snapshot_id"]
    (INPUTS / "01_t01_mixed.json").write_text(json.dumps(mixed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    r1 = sdk.submit(mixed)
    v1 = sdk.head()
    accepted = r1.get("outputs_success") or []
    rejected = r1.get("outputs_rejected") or []
    rej_codes = [e.get("code") for grp in rejected for e in (grp.get("errors") or [])]
    files_v1 = v1["files"] if v1 else []
    head_ok = (v1 is not None and v1["parent_snapshot_id"] == v0["snapshot_id"] and len(files_v1) == 2)
    rej_keys = {row.get("business_key") for row in bad_out["payload"]["rows"]}
    v1_rows = sdk.read_product(snapshot_id=v1["snapshot_id"])
    seen_keys = {row.get("business_key") for ent in v1_rows for row in ent["rows"]}
    check("T01", "部分成功发布（合格输出入快照，拒绝项进 outputs_rejected）",
          r1.get("status") == "partially_published_sandbox" and accepted == ["la_port_auto_handled_2023_2025"]
          and [g["output_key"] for g in rejected] == ["synthetic_ambiguous_vehicle_stock"]
          and "NEEDS_ENTITY_RESOLUTION" in rej_codes and head_ok and not (rej_keys & seen_keys),
          f"status={r1.get('status')} 成功={accepted} 拒绝={[g['output_key'] for g in rejected]} 码={rej_codes}；"
          f"新快照 v1={v1['snapshot_id'] if v1 else None}（父=v0）文件数={len(files_v1)}；拒绝项业务键是否误入快照={bool(rej_keys & seen_keys)}",
          evidence={"receipt": {"status": r1.get("status"), "outputs_success": accepted,
                                "outputs_rejected": rejected, "snapshot_id": r1.get("snapshot_id")}})

    v1_digest = read_fixed(STORE, RUNTIME, v1["snapshot_id"]) if v1 else {}
    v1_rows_map = rows_of(STORE, RUNTIME, v1["snapshot_id"]) if v1 else {}
    (BASE / "fixed_snapshot_rows.json").write_text(json.dumps(
        {"v0": {"snapshot_id": v0["snapshot_id"], "rows": v0_rows},
         "v1": {"snapshot_id": v1["snapshot_id"] if v1 else None, "rows": v1_rows_map}},
        ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    v1_ev = snapshot_evidence(STORE, v1) if v1 else {}
    counts_before_retry = {
        "commits": len(list((STORE / "catalog/commits").glob("*.json"))),
        "snapshots": len(list((STORE / "catalog/snapshots").glob("*.json"))),
        "manifests": len(list((STORE / "catalog/manifests").glob("*.json"))),
    }

    # ============================================================ T02 幂等重试 + 同 ID 不同数据冲突
    replay = sdk.submit(json.loads(json.dumps(mixed)))
    counts_after_retry = {
        "commits": len(list((STORE / "catalog/commits").glob("*.json"))),
        "snapshots": len(list((STORE / "catalog/snapshots").glob("*.json"))),
        "manifests": len(list((STORE / "catalog/manifests").glob("*.json"))),
    }
    v1_after = read_fixed(STORE, RUNTIME, v1["snapshot_id"])
    conflict = json.loads(json.dumps(mixed))
    conflict["outputs"][0]["payload"]["rows"][0]["value_decimal"] = "1.00"    # 同 request_id，不同数据
    (INPUTS / "02_t02_conflict.json").write_text(json.dumps(conflict, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    r_conflict = sdk.submit(conflict)
    conf_codes = [e.get("code") for e in (r_conflict.get("errors") or [])]
    check("T02", "部分成功后幂等重试 + 同 ID 不同数据报冲突",
          replay.get("idempotent_replay") is True and replay.get("snapshot_id") == v1["snapshot_id"]
          and counts_after_retry == counts_before_retry and sdk.head()["snapshot_id"] == v1["snapshot_id"]
          and v1_after["combined_digest"] == v1_digest["combined_digest"]
          and r_conflict.get("status") == "rejected" and "REQUEST_ID_CONFLICT" in conf_codes,
          f"重放 idempotent_replay={replay.get('idempotent_replay')} 同快照={replay.get('snapshot_id') == v1['snapshot_id']}；"
          f"目录计数 {counts_before_retry} → {counts_after_retry}；v1 指纹不变={v1_after['combined_digest'] == v1_digest['combined_digest']}；"
          f"冲突 status={r_conflict.get('status')} 码={conf_codes}")

    # ============================================================ T03 Manifest 内容损坏（改字节不删除）
    t3 = BASE / "store_t03_manifest_corrupt"
    if t3.exists(): shutil.rmtree(t3)
    shutil.copytree(STORE, t3)
    mpath = t3 / v1["manifest_relpath"]
    m_sha_before = sha_file(mpath)
    raw = bytearray(mpath.read_bytes())
    raw[len(raw) // 2] = (raw[len(raw) // 2] + 1) % 256          # 只改一个字节，保留文件存在
    mpath.write_bytes(bytes(raw))
    m_sha_after = sha_file(mpath)
    t3_head = None
    read_by_id_err = None
    try:
        sdk3 = WFDDuckDBPrototype(t3, validator, runtime_root=BASE / "rt_t03", sandbox=False)
        try:
            sdk3.head(); head_code = "NO_ERROR"
        except Exception as exc:  # noqa: BLE001
            head_code = getattr(exc, "code", type(exc).__name__)
        rec3 = sdk3.recover_head(operator="p0-t03")
        t3_head = sdk3.head() if rec3.get("ok") else None                     # 期望回退到 v0
        try:
            sdk3.read_product(snapshot_id=v1["snapshot_id"])   # 单独读受损版本，必须被拒
        except ValueError as exc:
            read_by_id_err = str(exc)
        head_rejected = head_code in ("HEAD_INVALID_DIGEST", "HEAD_INVALID_MISSING")
    except Exception as exc:  # noqa: BLE001
        t3_head, read_by_id_err, head_rejected = None, f"{type(exc).__name__}: {exc}", True
    old_ok_t3 = read_fixed(t3, BASE / "rt_t03_old", v0["snapshot_id"])
    FIELD_COMPARE["T03"] = compare_fields(v0_rows, rows_of(t3, BASE / "rt_t03_fields", v0["snapshot_id"]))
    v0_ev_t3 = snapshot_evidence(t3, json.loads((t3 / f"catalog/snapshots/{v0['snapshot_id']}.json").read_text("utf-8")))
    check("T03", "Manifest 内容损坏（改字节）：哈希校验失败、损坏版本不可读、旧版本不受污染",
          m_sha_before != m_sha_after and head_rejected and rec3.get("ok")
          and read_by_id_err == "SNAPSHOT_UNAVAILABLE_OR_INVALID"
          and old_ok_t3["combined_digest"] == v0_digest["combined_digest"]
          and v0_ev_t3["files"] == v0_ev["files"],
          f"manifest 哈希 {m_sha_before[:12]}… → {m_sha_after[:12]}…；head() 报 {head_code}（不自动回退）；显式恢复后 HEAD={t3_head}；"
          f"按受损 snapshot_id 读取={read_by_id_err}；旧版本 v0 逐字段摘要一致={old_ok_t3['combined_digest'] == v0_digest['combined_digest']}、"
          f"文件哈希逐条一致={v0_ev_t3['files'] == v0_ev['files']}",
          evidence={"corrupted_file": v1["manifest_relpath"], "sha_before": m_sha_before, "sha_after": m_sha_after,
                    "head_after_corruption": t3_head["snapshot_id"] if isinstance(t3_head, dict) else t3_head})

    # ============================================================ T04a Commit Marker 内容损坏
    t4a = BASE / "store_t04a_commit_corrupt"
    if t4a.exists(): shutil.rmtree(t4a)
    shutil.copytree(STORE, t4a)
    cpath = t4a / f"catalog/commits/{v1['snapshot_id']}.json"
    c_sha_before = sha_file(cpath)
    marker = json.loads(cpath.read_text("utf-8"))
    marker["snapshot_sha256"] = "0" * 64                       # 内容篡改，文件仍在
    cpath.write_text(json.dumps(marker, ensure_ascii=False), encoding="utf-8")
    c_sha_after = sha_file(cpath)
    sdk4a = WFDDuckDBPrototype(t4a, validator, runtime_root=BASE / "rt_t04a", sandbox=False)
    try:
        sdk4a.head(); code4a = "NO_ERROR"
    except Exception as exc:  # noqa: BLE001
        code4a = getattr(exc, "code", type(exc).__name__)
    rec4a = sdk4a.recover_head(operator="p0-t04a")
    h4a = sdk4a.head() if rec4a.get("ok") else None
    read4a_err = None
    try:
        sdk4a.read_product(snapshot_id=v1["snapshot_id"])
    except ValueError as exc:
        read4a_err = str(exc)
    old_ok_t4a = read_fixed(t4a, BASE / "rt_t04a_old", v0["snapshot_id"])
    FIELD_COMPARE["T04a"] = compare_fields(v0_rows, rows_of(t4a, BASE / "rt_t04a_fields", v0["snapshot_id"]))
    sub("T04a", "Commit Marker 内容损坏（只改 snapshot_sha256）",
        "PASS" if (c_sha_before != c_sha_after and (code4a in ("HEAD_INVALID_DIGEST","HEAD_INVALID_MISSING") and rec4a.get("ok") and h4a["snapshot_id"] == v0["snapshot_id"])
                   and read4a_err == "SNAPSHOT_UNAVAILABLE_OR_INVALID"
                   and old_ok_t4a["combined_digest"] == v0_digest["combined_digest"]) else "FAIL",
        f"marker 哈希 {c_sha_before[:12]}… → {c_sha_after[:12]}…；head() 报 {code4a}；显式恢复后 HEAD={(h4a or {}).get('snapshot_id')}（依据：commit 校验失败→退回上一已验证快照 v0）；"
        f"按受损 snapshot_id 读={read4a_err}；旧版本摘要一致={old_ok_t4a['combined_digest'] == v0_digest['combined_digest']}",
        evidence={"corrupted_file": f"catalog/commits/{v1['snapshot_id']}.json",
                  "head_before": v1["snapshot_id"], "head_after": (h4a or {}).get("snapshot_id")})

    # ============================================================ T04b HEAD 内容损坏（等价注入：commit 的 snapshot_file 指针被改）
    t4b = BASE / "store_t04b_head_corrupt"
    if t4b.exists(): shutil.rmtree(t4b)
    shutil.copytree(STORE, t4b)
    cpath_b = t4b / f"catalog/commits/{v1['snapshot_id']}.json"
    b_sha_before = sha_file(cpath_b)
    marker_b = json.loads(cpath_b.read_text("utf-8"))
    marker_b["snapshot_file"] = f"catalog/snapshots/{v1['snapshot_id']}_not_exist.json"   # 指向不存在
    cpath_b.write_text(json.dumps(marker_b, ensure_ascii=False), encoding="utf-8")
    b_sha_after = sha_file(cpath_b)
    sdk4b = WFDDuckDBPrototype(t4b, validator, runtime_root=BASE / "rt_t04b", sandbox=False)
    try:
        sdk4b.head(); code4b = "NO_ERROR"
    except Exception as exc:  # noqa: BLE001
        code4b = getattr(exc, "code", type(exc).__name__)
    rec4b = sdk4b.recover_head(operator="p0-t04b")
    h4b = sdk4b.head() if rec4b.get("ok") else None
    read4b_err = None
    try:
        sdk4b.read_product(snapshot_id=v1["snapshot_id"])
    except ValueError as exc:
        read4b_err = str(exc)
    old_ok_t4b = read_fixed(t4b, BASE / "rt_t04b_old", v0["snapshot_id"])
    FIELD_COMPARE["T04b"] = compare_fields(v0_rows, rows_of(t4b, BASE / "rt_t04b_fields", v0["snapshot_id"]))
    sub("T04b", "HEAD 指针内容损坏（候选实现无独立 HEAD 文件，以 commit 的 snapshot_file 指向注入）",
        "PASS" if (b_sha_before != b_sha_after and (code4b in ("HEAD_INVALID_DIGEST","HEAD_INVALID_MISSING") and rec4b.get("ok") and h4b["snapshot_id"] == v0["snapshot_id"])
                   and read4b_err == "SNAPSHOT_UNAVAILABLE_OR_INVALID"
                   and old_ok_t4b["combined_digest"] == v0_digest["combined_digest"]) else "FAIL",
        f"commit 哈希 {b_sha_before[:12]}… → {b_sha_after[:12]}…；head() 报 {code4b}；显式恢复后 HEAD={(h4b or {}).get('snapshot_id')}（依据：snapshot_file 不存在→该 commit 不成立，退回 v0）；"
        f"按原 snapshot_id 读={read4b_err}；旧版本摘要一致={old_ok_t4b['combined_digest'] == v0_digest['combined_digest']}",
        evidence={"note": "候选实现没有独立 CURRENT_HEAD 文件，HEAD 由 commit 集合 + 快照校验推导；"
                          "故以 commit.snapshot_file 指针损坏作为等价注入，结论不可外推到协议要求的独立 HEAD 文件",
                  "corrupted_file": f"catalog/commits/{v1['snapshot_id']}.json",
                  "head_before": v1["snapshot_id"], "head_after": (h4b or {}).get("snapshot_id")})

    # ============================================================ 汇总：旧版本污染总检
    FIELD_COMPARE["MAIN_AFTER"] = compare_fields(v0_rows, rows_of(STORE, BASE / "rt_main_fields", v0["snapshot_id"]))
    (BASE / "field_compare.json").write_text(json.dumps(FIELD_COMPARE, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    final_old = read_fixed(STORE, RUNTIME, v0["snapshot_id"])
    no_field_diff = all(v["diff_count"] == 0 for v in FIELD_COMPARE.values())
    field_summary = ", ".join(f"{k}:{v['diff_count']}处差异/{v['fields']}字段" for k, v in FIELD_COMPARE.items())
    check("T99", "主库与各隔离副本中的旧版本均逐字段未被污染",
          no_field_diff
          and final_old["combined_digest"] == v0_digest["combined_digest"]
          and snapshot_evidence(STORE, sdk.head()) == v1_ev.copy() | {"snapshot_file_sha256": None},
          f"逐字段对照（{field_summary}）；"
          f"主库 v0 摘要不变={final_old['combined_digest'] == v0_digest['combined_digest']}；"
          f"主库 HEAD={sdk.head()['snapshot_id']}；所有篡改只发生在 3 个隔离副本中")
    return finish(v0=v0, v1=v1, v0_digest=v0_digest, v1_digest=v1_digest)


def finish(**kw) -> int:
    counts = {}
    for c in CHECKS:
        counts[c["status"]] = counts.get(c["status"], 0) + 1
    result = {
        "format_version": "wfd.p0-publish-recovery/1.0",
        "generated_at_utc": now(), "work_dir": str(BASE), "store": str(STORE),
        "snapshots": {k: (v.get("snapshot_id") if isinstance(v, dict) else v) for k, v in kw.items() if "digest" not in k},
        "checks": CHECKS, "counts": counts,
        "verdict": {"overall": "PASS" if not counts.get("FAIL") else "FAIL",
                    "production_accepted": False,
                    "note": "只覆盖 T01—T04 所列场景；Compaction/GC、跨端接管、断电与规模仍 NOT_RUN。"},
    }
    (BASE / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# P0 补测报告：正式发布（T01/T02）+ 故障恢复（T03/T04）", "",
             f"- 时间（UTC）：{result['generated_at_utc']}", f"- 工作区：{BASE}",
             f"- 计数：{counts}", "", "| ID | 检查 | 状态 | 说明 |", "| --- | --- | --- | --- |"]
    for c in CHECKS:
        lines.append(f"| {c['id']} | {c['title']} | {c['status']} | {c['detail'].replace('|','/')[:200]} |")
    lines += ["", "## 口径", "",
              "- T04 的 commit 与 HEAD 分别记账（T04a / T04b），不因一项通过而互认。",
              "- 所有篡改只在隔离副本上进行；主库 `store/` 只做过发布与读取。",
              "- 无自动修复：报告只记录损坏文件、哈希前后、恢复依据与恢复前后 HEAD。",
              "- `production_accepted=false`；Compaction/GC、跨端接管、断电、规模未覆盖。", ""]
    (BASE / "REPORT.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"\n结果：{BASE/'results.json'}\n计数：{counts}")
    return 0 if not counts.get("FAIL") else 2


if __name__ == "__main__":
    sys.exit(main())
