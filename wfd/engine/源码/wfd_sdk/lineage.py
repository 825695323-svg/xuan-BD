#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WFD 谱系检查点与祖先验证（P0-3 边界补丁 + P0-4 前置）

设计要点（2026-10-26 裁决）：
  · 「退出可读状态」「退出保留集合」「删除历史元数据」是三个独立动作，不得强制同时发生；
  · 即使数据文件被 GC 删除、元数据被退役，也要保留**最小谱系证明**（检查点），
    使对端仍能判断：祖先关系、快进资格、分叉关系；
  · 绝不重写原始 parent_snapshot_id。

检查点内容（catalog/lineage/<snapshot_id>.json）：
  snapshot_id / parent_snapshot_id / snapshot_sha256 / manifest_sha256 /
  files_root（按 rel_path 排序后的 (rel,sha) 默克尔根）/ created_at_utc /
  status（active | revoked_read | retired_data_deleted）/ retired_at_utc / notes
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def files_root(files: list[dict]) -> str:
    """内容寻址的谱系根：与平台路径无关（只用协议相对路径 + 内容哈希）。"""
    items = [[f["file_relpath"], f["file_sha256"].split(":")[-1]] for f in sorted(files, key=lambda x: x["file_relpath"])]
    return hashlib.sha256(json.dumps(items, separators=(",", ":")).encode()).hexdigest()


class Lineage:
    def __init__(self, store: Path):
        self.store = Path(store)
        self.dir = self.store / "catalog" / "lineage"
        self.dir.mkdir(parents=True, exist_ok=True)

    # ---------------------------------------------------------------- 读写检查点
    def path(self, sid: str) -> Path:
        return self.dir / f"{sid}.json"

    def get(self, sid: str) -> dict | None:
        p = self.path(sid)
        if not p.is_file():
            return None
        try:
            return json.loads(p.read_text("utf-8"))
        except ValueError:
            return None

    def ensure(self, snapshot_id: str) -> dict | None:
        """有快照文件就补写检查点；已有则返回。"""
        existing = self.get(snapshot_id)
        if existing:
            return existing
        snap_path = self.store / f"catalog/snapshots/{snapshot_id}.json"
        if not snap_path.is_file():
            return None
        snap = json.loads(snap_path.read_text("utf-8"))
        manifest_path = self.store / snap["manifest_relpath"]
        cp = {
            "format_version": "wfd.lineage/1.0",
            "snapshot_id": snapshot_id,
            "parent_snapshot_id": snap.get("parent_snapshot_id"),
            "snapshot_sha256": sha_file(snap_path),
            "manifest_sha256": sha_file(manifest_path) if manifest_path.is_file() else snap.get("manifest_sha256"),
            "files_root": files_root(snap["files"]),
            "created_at_utc": now(),
            "status": "active",
        }
        self.path(snapshot_id).write_text(json.dumps(cp, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return cp

    def build_all(self) -> dict:
        out = {}
        for p in sorted((self.store / "catalog/snapshots").glob("*.json")):
            sid = p.stem
            cp = self.ensure(sid)
            if cp:
                out[sid] = cp
        return out

    def mark(self, snapshot_id: str, *, status: str, note: str = "") -> dict | None:
        cp = self.get(snapshot_id)
        if cp is None:
            return None
        cp["status"] = status
        cp["retired_at_utc"] = now()
        if note:
            cp["notes"] = note
        self.path(snapshot_id).write_text(json.dumps(cp, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return cp

    # ---------------------------------------------------------------- 祖先验证
    def ancestors(self, snapshot_id: str, *, max_depth: int = 1000) -> dict:
        """沿 parent 链回溯（快照存在就用快照，不存在则用检查点）。返回链与缺口。"""
        chain, missing, seen = [], [], set()
        cur = snapshot_id
        while cur and len(chain) < max_depth:
            if cur in seen:
                return {"ok": False, "reason": "LINEAGE_CYCLE", "chain": chain, "missing": missing}
            seen.add(cur)
            cp = self.get(cur)
            if cp is None:
                snap_path = self.store / f"catalog/snapshots/{cur}.json"
                if snap_path.is_file():
                    cp = self.ensure(cur)
            if cp is None:
                missing.append(cur)
                return {"ok": False, "reason": "LINEAGE_GAP", "chain": chain, "missing": missing}
            chain.append({"snapshot_id": cp["snapshot_id"], "parent": cp.get("parent_snapshot_id"),
                          "status": cp.get("status"), "files_root": cp["files_root"]})
            cur = cp.get("parent_snapshot_id")
        return {"ok": True, "chain": chain, "missing": missing}

    def is_ancestor(self, ancestor_id: str, descendant_id: str) -> dict:
        a = self.ancestors(descendant_id)
        if not a["ok"]:
            return {"ok": False, "reason": a["reason"], "detail": a}
        ids = [c["snapshot_id"] for c in a["chain"]]
        return {"ok": ancestor_id in ids, "position": ids.index(ancestor_id) if ancestor_id in ids else None,
                "chain_length": len(ids)}

    def compare(self, sid_a: str, sid_b: str) -> dict:
        """判断两个快照的关系：同一 / a 是 b 祖先 / b 是 a 祖先 / 分叉。"""
        if sid_a == sid_b:
            return {"relation": "same"}
        if self.is_ancestor(sid_a, sid_b)["ok"]:
            return {"relation": "a_is_ancestor_of_b", "ancestor": sid_a, "descendant": sid_b}
        if self.is_ancestor(sid_b, sid_a)["ok"]:
            return {"relation": "b_is_ancestor_of_a", "ancestor": sid_b, "descendant": sid_a}
        ca = [c["snapshot_id"] for c in self.ancestors(sid_a)["chain"]]
        cb = [c["snapshot_id"] for c in self.ancestors(sid_b)["chain"]]
        common = next((s for s in ca if s in cb), None)
        return {"relation": "divergent", "common_ancestor": common}
