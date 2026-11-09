#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WFD 引用可达性 GC 控制层（P0-3 首版实现）

裁决口径（2026-10-26 用户确认）：
  · 删除资格 = 引用可达性（主判据） + 显式保留策略（附加） + 安全条件（冷却/任务/租约）
  · 首版默认：所有正式 Snapshot 默认保留，不按 N/T 自动过期
  · 只有显式、受权限控制的 release 记录才能让历史 Snapshot 退出保留集合
  · GC 默认 Dry Run；真正删除前后都要复核引用闭包、任务状态与冷却期
  · 引用计数不作为唯一权威；必须从根节点遍历依赖图

根节点（P0 强制保护）：
  CURRENT HEAD / retained Snapshot / 引用型或未完成的独立包 / 进行中的迁移任务 /
  有效读取租约 / 证据保留对象 / 受控接管依赖

P1：最近 N 个 / 最近 T 天 / 指定版本 —— 由 retention.json 的 policy 段声明（首版默认关闭）

状态文件（均在 store/catalog 下，属 WFD 控制层，不改引擎）：
  retention.json   快照保留状态与策略
  bundles/*.json   独立小库/交付包引用
  leases/*.json    读取租约
  migrations/*.json 迁移任务
  evidence/*.json  证据保留
  gc/journal_*.json 删除日志（真正删除时）
"""
from __future__ import annotations

from wfd_sdk.writerlock import guarded_method, guarded_store_func

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from .lineage import Lineage
from .row_version_objects import reject_unsupported, RowVersionObjectError

DATA_DIRS = ("observations", "foundation", "events", "evidence_blobs")
CLOSURE_DIRS = ("catalog",)


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_json(p: Path):
    return json.loads(p.read_text("utf-8"))


class ClosureError(RuntimeError):
    """闭包不完整或保留状态不可读 → 拒绝危险删除（GC09）"""


def _clean_json(paths):
    """过滤 macOS 在 exFAT/NTFS 上生成的伴生文件（._*、.DS_Store 等）。"""
    return [p for p in paths if not (p.name.startswith("._") or p.name in (".DS_Store", ".trashes"))]


class GC:
    def __init__(self, store: Path, *, cooldown_seconds: int = 0, keep_metadata: bool = True):
        # keep_metadata=True 表示：只退出保留集合、删数据文件，但保留 snapshot/commit/manifest 记录，
        # 配合 lineage 检查点，使祖先关系在数据被回收后仍可验证（三分动作独立）。
        self.store = Path(store)
        self.keep_metadata = keep_metadata
        self.cooldown = cooldown_seconds
        self.state = self.store / "catalog"
        self.gc_dir = self.state / "gc"

    # ------------------------------------------------------------------ 读取权威状态
    def snapshots(self) -> dict:
        out = {}
        for p in _clean_json((self.state / "snapshots").glob("*.json")):
            try:
                d = load_json(p)
            except ValueError as exc:
                raise ClosureError(f"SNAPSHOT_UNREADABLE {p.name}: {exc}") from exc
            out[d["snapshot_id"]] = d
        return out

    def commits(self) -> dict:
        out = {}
        for p in _clean_json((self.state / "commits").glob("*.json")):
            try:
                d = load_json(p)
            except ValueError as exc:
                raise ClosureError(f"COMMIT_UNREADABLE {p.name}: {exc}") from exc
            out[d["snapshot_id"]] = d
        return out

    def valid_snapshots(self) -> dict:
        """只认证据自洽的快照：commit→snapshot→manifest→文件 全部 hash 一致。"""
        snaps, commits, valid = self.snapshots(), self.commits(), {}
        # This GC does not yet traverse row-version objects. Never skip an
        # unsupported current snapshot and fall back to an older graph head.
        try:
            for snapshot in snaps.values():
                reject_unsupported(snapshot, "gc")
            if any(str(marker.get("snapshot_file", "")).startswith("wfd.snapshot-file/")
                   for marker in commits.values()):
                raise RowVersionObjectError("ROW_VERSION_OBJECT_OPERATION_UNSUPPORTED:gc")
        except RowVersionObjectError as exc:
            raise ClosureError(str(exc)) from exc
        for sid, marker in commits.items():
            snap = snaps.get(sid)
            if snap is None:
                continue
            snap_path = self.store / marker["snapshot_file"]
            if not snap_path.is_file() or sha_file(snap_path) != marker["snapshot_sha256"].split(":")[-1]:
                continue
            mpath = self.store / snap["manifest_relpath"]
            if not mpath.is_file() or sha_file(mpath) != snap["manifest_sha256"].split(":")[-1]:
                continue
            manifest = load_json(mpath)
            if manifest.get("files") != snap.get("files"):
                continue
            if not all((self.store / f["file_relpath"]).is_file()
                       and sha_file(self.store / f["file_relpath"]) == f["file_sha256"].split(":")[-1]
                       for f in snap["files"]):
                continue
            valid[sid] = snap
        return valid

    def head(self, valid: dict):
        """HEAD 解析：优先用协议要求的 CURRENT_HEAD 激活指针（catalog/state.json）。

        理由：退役祖先数据但保留元数据后，若只靠"有效快照图"推导，孩子快照会因父失效而
        被误判为新根，出现双 HEAD（实测过）。协议本就有 CURRENT_HEAD 指针，候选引擎缺失，
        这里由 WFD 控制层提供；没有指针时才回退到图推导。
        """
        st_path = self.state / "state.json"
        if st_path.is_file():
            try:
                st = json.loads(st_path.read_text("utf-8"))
                sid = st.get("active_head")
                if sid in valid:
                    return valid[sid]
            except ValueError:
                raise ClosureError("CURRENT_HEAD_UNREADABLE")
        parents = {s["parent_snapshot_id"] for s in valid.values() if s.get("parent_snapshot_id")}
        heads = [s for sid, s in valid.items() if sid not in parents]
        if len(heads) != 1:
            raise ClosureError(f"DIVERGENT_OR_MISSING_HEAD heads={[h['snapshot_id'] for h in heads]}")
        return heads[0]

    def retention(self) -> dict:
        p = self.state / "retention.json"
        if not p.is_file():
            raise ClosureError("RETENTION_STATE_MISSING")
        try:
            d = load_json(p)
        except ValueError as exc:
            raise ClosureError(f"RETENTION_STATE_UNREADABLE: {exc}") from exc
        if d.get("format_version") != "wfd.retention/1.0" or "snapshots" not in d:
            raise ClosureError("RETENTION_STATE_INVALID")
        return d

    def _load_dir(self, name: str) -> dict:
        d = {}
        for p in _clean_json((self.state / name).glob("*.json")):
            try:
                d[p.stem] = load_json(p)
            except ValueError as exc:
                raise ClosureError(f"{name.upper()}_RECORD_UNREADABLE {p.name}: {exc}") from exc
        return d

    # ------------------------------------------------------------------ 根集合
    def build_roots(self) -> dict:
        valid = self.valid_snapshots()
        head = self.head(valid)
        retention = self.retention()
        records = retention["snapshots"]
        bundles = self._load_dir("bundles")
        leases = self._load_dir("leases")
        migrations = self._load_dir("migrations")
        evidence = self._load_dir("evidence")

        protected_snapshots: dict[str, list[str]] = {}
        files_of: dict[str, str] = {}          # 文件 → 保护理由（首个根）

        def protect_snap(sid: str, why: str):
            protected_snapshots.setdefault(sid, []).append(why)
            snap = valid.get(sid)
            if snap:
                for f in snap["files"]:
                    files_of.setdefault(f["file_relpath"], why)

        # P0-1 CURRENT HEAD
        protect_snap(head["snapshot_id"], "CURRENT_HEAD")
        # P0-2 显式保留：默认保留，只有 state=released 才退出
        for sid in valid:
            st = (records.get(sid) or {}).get("state", "retained")
            if st != "released":
                protect_snap(sid, "RETAINED_EXPLICIT_OR_DEFAULT")
        # P0-3 引用型/未完成独立包
        for bid, b in bundles.items():
            kind, state = b.get("kind"), b.get("state", "active")
            if kind == "reference" or state != "complete":
                for f in b.get("files", []):
                    files_of.setdefault(f["rel_path"], f"BUNDLE_{bid}")
                if b.get("source_snapshot_id"):
                    protect_snap(b["source_snapshot_id"], f"BUNDLE_{bid}")
        # P0-4 进行中的迁移任务
        for tid, m in migrations.items():
            if m.get("state") == "in_progress":
                for rel in m.get("dependencies", []):
                    files_of.setdefault(rel, f"MIGRATION_{tid}")
                if m.get("source_snapshot_id"):
                    protect_snap(m["source_snapshot_id"], f"MIGRATION_{tid}")
        # P0-5 有效读取租约
        now_s = now()
        for lid, lease in leases.items():
            if lease.get("expires_at_utc", "") > now_s:
                protect_snap(lease["snapshot_id"], f"LEASE_{lid}")
        # P0-6 证据保留
        for eid, ev in evidence.items():
            if ev.get("state", "retained") == "retained":
                for rel in ev.get("files", []):
                    files_of.setdefault(rel, f"EVIDENCE_{eid}")

        # GC09 异常闭包：受保护根引用的文件必须真实存在，否则拒绝任何删除
        missing = [(rel, why) for rel, why in files_of.items() if not (self.store / rel).is_file()]
        if missing:
            rel, why = missing[0]
            raise ClosureError(f"CLOSURE_FILE_MISSING {rel} referenced_by={why}")

        # P1 保留策略（首版默认关闭；此处仅记录已启用项，不自动放宽 P0）
        policy = retention.get("policy", {})
        return {
            "head": head["snapshot_id"],
            "valid_snapshots": sorted(valid),
            "protected_snapshots": protected_snapshots,
            "protected_files": files_of,
            "policy": policy,
            "released": [sid for sid in valid if (records.get(sid) or {}).get("state") == "released"],
        }

    # ------------------------------------------------------------------ 判定
    def scan_data_files(self) -> dict:
        out = {}
        for d in DATA_DIRS:
            root = self.store / d
            if not root.is_dir():
                continue
            for p in root.rglob("*"):
                if p.is_file() and not p.name.startswith("._"):
                    out[p.relative_to(self.store).as_posix()] = p
        return out

    def plan(self) -> dict:
        roots = self.build_roots()
        data = self.scan_data_files()
        protected = roots["protected_files"]
        now_ts = datetime.now(timezone.utc).timestamp()
        candidates, blocked = [], []
        for rel, p in sorted(data.items()):
            if rel in protected:
                blocked.append({"rel_path": rel, "reason": protected[rel]})
                continue
            age = now_ts - p.stat().st_mtime
            if age < self.cooldown:
                blocked.append({"rel_path": rel, "reason": f"COOLDOWN（{int(age)}s < {self.cooldown}s）"})
                continue
            candidates.append({"rel_path": rel, "size": p.stat().st_size,
                               "sha256": "sha256:" + sha_file(p),
                               "reason": "UNREACHABLE_FROM_ALL_ROOTS"})

        # 谱系完整性：被显式释放且其全部文件都成为候选的快照，必须整段退役（记录+文件），
        # 否则其子快照的 parent 指向消失的祖先，会推不出唯一 HEAD（实测曾出现双 HEAD）。
        cand_rels = {c["rel_path"] for c in candidates}
        valid = self.valid_snapshots()
        retire = []
        for sid in roots["released"]:
            snap = valid.get(sid)
            if snap and all(f["file_relpath"] in cand_rels for f in snap["files"]):
                retire.append(sid)
        projected = {sid: v for sid, v in valid.items() if sid not in retire}
        parents = {v["parent_snapshot_id"] for v in projected.values() if v.get("parent_snapshot_id")}
        projected_heads = [sid for sid in projected if sid not in parents]
        lineage_ok = len(projected_heads) == 1
        if not lineage_ok:
            blocked.append({"rel_path": "(catalog)", "reason": f"GC_WOULD_BREAK_LINEAGE projected_heads={projected_heads}"})
            candidates = []
        return {
            "format_version": "wfd.gc.plan/1.0",
            "generated_at_utc": now(),
            "store": str(self.store),
            "roots": {"head": roots["head"], "valid_snapshots": roots["valid_snapshots"],
                      "protected_snapshots": roots["protected_snapshots"],
                      "released": roots["released"], "policy": roots["policy"]},
            "data_files": len(data),
            "candidates": candidates,
            "blocked": blocked,
            "estimated_reclaim_bytes": sum(c["size"] for c in candidates),
            "retire_snapshots": retire,
            "lineage_check": {"projected_heads": projected_heads, "ok": lineage_ok},
            "dry_run": True,
        }

    # ------------------------------------------------------------------ 执行
    @guarded_method
    def execute(self, plan: dict, *, run_id: str, interrupt_after: int | None = None) -> dict:
        """隔离测试库上真正删除。

        顺序（关键）：先退役整段谱系的 catalog 记录，再删数据文件。
        —— 反过来会让孩子快照的 parent 指向消失的祖先，HEAD 推导出现双头（GC08 实测到过）。
        中断只发生在删文件阶段；重跑时未删完的文件仍是候选，可幂等续做。
        """
        if not plan.get("lineage_check", {}).get("ok", False):
            raise ClosureError("GC_WOULD_BREAK_LINEAGE")
        self.gc_dir.mkdir(parents=True, exist_ok=True)
        journal = self.gc_dir / f"journal_{run_id}.json"
        retired = []
        for sid in plan.get("retire_snapshots", []):
            snap = self.valid_snapshots().get(sid)
            if snap is None:
                continue
            lin = Lineage(self.store)
            lin.ensure(sid)                                  # 先固化谱系证明
            lin.mark(sid, status="retired_data_deleted", note="GC 退役：数据文件回收，谱系证明保留")
            removed = []
            if not self.keep_metadata:
                for rel in (f"catalog/commits/{sid}.json", f"catalog/snapshots/{sid}.json", snap["manifest_relpath"]):
                    p = self.store / rel
                    if p.is_file():
                        p.unlink(); removed.append(rel)
            retired.append({"snapshot_id": sid, "removed_records": removed,
                            "kept_metadata": self.keep_metadata,
                            "lineage_checkpoint": f"catalog/lineage/{sid}.json"})
            journal.write_text(json.dumps({"format_version": "wfd.gc.journal/1.0", "run_id": run_id,
                                           "phase": "retire_records", "retired": retired, "deleted": []},
                                          ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        recheck = self.plan()
        cand_now = {c["rel_path"]: c for c in recheck["candidates"]}
        deleted, skipped = [], []
        for cand in plan["candidates"]:
            rel = cand["rel_path"]
            if rel not in cand_now:
                skipped.append({"rel_path": rel, "reason": "RECHECK_PROTECTED"})
                continue
            p = self.store / rel
            if not p.is_file() or "sha256:" + sha_file(p) != cand["sha256"]:
                skipped.append({"rel_path": rel, "reason": "RECHECK_CHANGED_OR_MISSING"})
                continue
            p.unlink()
            deleted.append({"rel_path": rel, "sha256": cand["sha256"], "deleted_at_utc": now()})
            journal.write_text(json.dumps({"format_version": "wfd.gc.journal/1.0", "run_id": run_id,
                                           "phase": "delete_files", "retired": retired,
                                           "deleted": deleted, "skipped": skipped},
                                          ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            if interrupt_after is not None and len(deleted) >= interrupt_after:
                return {"format_version": "wfd.gc.result/1.0", "run_id": run_id, "interrupted": True,
                        "retired": retired, "deleted": deleted, "skipped": skipped, "finished_at_utc": now()}
        return {"format_version": "wfd.gc.result/1.0", "run_id": run_id, "interrupted": False,
                "retired": retired, "deleted": deleted, "skipped": skipped, "finished_at_utc": now()}
