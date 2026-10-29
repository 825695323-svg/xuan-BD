#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""权威 HEAD 状态存储（02 补丁 R-ST-01 的引擎内实现）

`catalog/state.json` 是唯一活跃版本指针。任何正常读取都必须经过本模块；
从 Commit 集合推导的"头"只作为诊断信息（`diagnostic_heads`），不构成正式版本判定。
"""
from __future__ import annotations

from wfd_sdk.writerlock import guarded_method, guarded_store_func

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

FORMAT = "wfd.state/1.0"
COMPAT_FORMATS = ("wfd.state/1.0", "wfd.host/1.0")


class StateError(RuntimeError):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _sha_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _sha_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class StateStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.path = self.root / "catalog/state.json"
        self.recovery_dir = self.root / "catalog/recovery"
        # 激活历史：HEAD_STALE 的唯一可信依据（不使用 Commit 时间、编号或图序）
        self.activation_log = self.root / "catalog/activation_log.jsonl"

    # ------------------------------------------------------------------ 基础读写
    def read(self) -> dict | None:
        if not self.path.is_file():
            return None
        try:
            return json.loads(self.path.read_text("utf-8"))
        except ValueError as exc:
            raise StateError("CURRENT_HEAD_UNREADABLE", str(exc)) from exc

    def ensure_initialized(self, *, writer_host: str | None = None) -> dict:
        """首次初始化：只建空指针，绝不从提交图自动推导。"""
        st = self.read()
        if st is not None:
            if st.get("format_version") not in COMPAT_FORMATS:
                raise StateError("HEAD_INVALID_FORMAT", str(st.get("format_version")))
            st.setdefault("update_seq", 0); st.setdefault("prev_head", None)
            return st
        st = {"format_version": FORMAT, "active_head": None, "head_snapshot_sha256": None,
              "writer_host": writer_host, "writer_epoch": 0, "update_seq": 0,
              "prev_head": None, "activation_history": [], "updated_at_utc": _now()}
        self._write_atomic(st)
        return st

    def _write_atomic(self, st: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        raw = (json.dumps(st, ensure_ascii=False, indent=2) + "\n").encode()
        fd, tmp = tempfile.mkstemp(prefix=".state_", dir=str(self.path.parent))
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(raw)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        # 目录刷盘（POSIX 有效；Windows 由平台适配器另行处理）
        try:
            dirfd = os.open(str(self.path.parent), os.O_RDONLY)
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)
        except OSError:
            pass

    # ------------------------------------------------------------------ 校验
    @staticmethod
    def _as_map(valid_snapshots) -> dict:
        """兼容引擎内部的 list[snapshot] 与 dict[sid→snapshot] 两种传入形态。"""
        if isinstance(valid_snapshots, dict):
            return valid_snapshots
        return {s["snapshot_id"]: s for s in (valid_snapshots or [])}

    def resolve(self, valid_snapshots) -> dict:
        valid_snapshots = self._as_map(valid_snapshots)
        st = self.read()
        if st is None:
            if not valid_snapshots:
                return {"ok": True, "code": "OK", "snapshot_id": None,
                        "detail": "空库且无指针（首次初始化前）"}
            if len(valid_snapshots) == 1:
                return {"ok": False, "code": "HEAD_MISSING", "snapshot_id": None,
                        "detail": "无 state.json，存在唯一可验证候选", "recoverable": True,
                        "candidate": next(iter(valid_snapshots))}
            return {"ok": False, "code": "HEAD_AMBIGUOUS", "snapshot_id": None,
                    "detail": "无 state.json 且多个可验证候选", "candidates": sorted(valid_snapshots)}

        sid = st.get("active_head")
        if not sid:
            if not valid_snapshots:
                return {"ok": True, "code": "OK", "snapshot_id": None, "detail": "空库，指针为空"}
            return {"ok": False, "code": "HEAD_INVALID_MISSING", "snapshot_id": None,
                    "detail": "active_head 为空但库中已有提交", "candidates": sorted(valid_snapshots)}

        snap_path = self.root / f"catalog/snapshots/{sid}.json"
        if not snap_path.is_file():
            return {"ok": False, "code": "HEAD_INVALID_MISSING", "snapshot_id": sid,
                    "detail": f"active_head 指向不存在的快照 {sid}"}
        want = str(st.get("head_snapshot_sha256") or "").split(":")[-1]
        got = _sha_file(snap_path)
        if want and got != want:
            return {"ok": False, "code": "HEAD_INVALID_DIGEST", "snapshot_id": sid,
                    "detail": f"快照摘要不符：指针 {want[:12]}… 实际 {got[:12]}…"}
        if sid not in valid_snapshots:
            return {"ok": False, "code": "HEAD_INVALID_DIGEST", "snapshot_id": sid,
                    "detail": "active_head 不在可验证快照集合内"}
        retired = self._retired(sid)
        if retired:
            return {"ok": False, "code": "HEAD_INVALID_RETIRED", "snapshot_id": sid,
                    "detail": f"active_head 指向已退役版本（{retired}）"}
        stale = self._stale_reason(sid, st)
        if stale:
            return {"ok": False, "code": "HEAD_STALE", "snapshot_id": sid,
                    "detail": f"指针落后或有可信激活历史与之冲突（{stale}）"}
        return {"ok": True, "code": "OK", "snapshot_id": sid,
                "writer_host": st.get("writer_host"), "writer_epoch": st.get("writer_epoch"),
                "update_seq": st.get("update_seq")}

    # ------------------------------------------------------------------ 激活（发布/快进/接管）
    @guarded_method
    def activate(self, snapshot_id: str, snapshot_path: Path, *, expected_prev: str | None,
                 writer_host: str | None = None, writer_epoch: int | None = None,
                 allow_writer_change: bool = False, authorized_by: str | None = None) -> dict:
        st = self.read() or self.ensure_initialized()
        cur = st.get("active_head")
        if cur != expected_prev:
            return {"ok": False, "code": "HEAD_CAS_CONFLICT",
                    "detail": f"期望前驱 {expected_prev} 实际 {cur}"}
        # 主端变更的**授权**归调用方（transfer 校验交接凭证）；本函数只负责持久化。
        # 未经授权的换主端仍拒绝；allow_writer_change=True 表示调用方已完成授权校验。
        if (not allow_writer_change) and writer_host is not None and st.get("writer_host") not in (None, writer_host):
            return {"ok": False, "code": "WRITER_NOT_AUTHORIZED",
                    "detail": f"当前写入主端 {st.get('writer_host')}，请求 {writer_host}"}
        if (writer_epoch is not None and int(writer_epoch) < int(st.get("writer_epoch") or 0)):
            return {"ok": False, "code": "WRITER_EPOCH_ROLLBACK",
                    "detail": f"epoch 不能回退：请求 {writer_epoch}，当前 {st.get('writer_epoch')}"}
        hist = list(st.get("activation_history") or [])
        hist.append({"snapshot_id": snapshot_id, "update_seq": int(st.get("update_seq") or 0) + 1,
                     "prev_head": cur, "at_utc": _now()})
        new = {
            "format_version": FORMAT,
            "activation_history": hist[-200:],      # 与 HEAD 同文件、同一次原子写：HEAD_STALE 的唯一权威依据
            "active_head": snapshot_id,
            "head_snapshot_sha256": "sha256:" + _sha_file(Path(snapshot_path)),
            "writer_host": writer_host if writer_host is not None else st.get("writer_host"),
            "writer_epoch": writer_epoch if writer_epoch is not None else int(st.get("writer_epoch") or 0),
            "update_seq": int(st.get("update_seq") or 0) + 1,
            "prev_head": cur,
            "writer_change_authorized_by": authorized_by if allow_writer_change else None,
            "updated_at_utc": _now(),
        }
        try:
            self._write_atomic(new)
        except OSError as exc:
            return {"ok": False, "code": "HEAD_WRITE_FAILED", "detail": str(exc)}
        # 追加激活历史（只增不改；写失败不阻断激活，但会让后续 HEAD_STALE 判定失去依据）
        try:
            self.activation_log.parent.mkdir(parents=True, exist_ok=True)
            with open(self.activation_log, "a", encoding="utf-8") as f:
                f.write(json.dumps({"snapshot_id": snapshot_id, "update_seq": new["update_seq"],
                                    "prev_head": cur, "writer_host": new.get("writer_host"),
                                    "writer_epoch": new.get("writer_epoch"), "at_utc": _now()},
                                   ensure_ascii=False) + "\n")
                f.flush(); os.fsync(f.fileno())
        except OSError as exc:
            try:
                new["log_mirror_error"] = str(exc)[:200]
                self._write_atomic(new)
            except OSError:
                pass
        return {"ok": True, "code": "OK", "state": new}

    # ------------------------------------------------------------------ 退役/过期辅助
    def _retired(self, sid: str) -> str | None:
        """返回退役原因（若该版本已退出可读/保留集合）。"""
        rp = self.root / "catalog/retention.json"
        if rp.is_file():
            try:
                rec = (json.loads(rp.read_text("utf-8")).get("snapshots") or {}).get(sid) or {}
                if rec.get("state") == "released":
                    return "RETENTION_RELEASED"
            except ValueError:
                return "RETENTION_UNREADABLE"
        lp = self.root / f"catalog/lineage/{sid}.json"
        if lp.is_file():
            try:
                st = (json.loads(lp.read_text("utf-8")) or {}).get("status")
                if st in ("revoked_read", "retired_data_deleted"):
                    return f"LINEAGE_{st.upper()}"
            except ValueError:
                return "LINEAGE_UNREADABLE"
        return None

    def _stale_reason(self, sid: str, st: dict) -> str | None:
        """HEAD_STALE 只依据可信激活历史判定。

        权威来源：state.json 内的 `activation_history`（与 HEAD 同一次原子写）；
        旧库无该字段时回退 `catalog/activation_log.jsonl`；两者都没有则不判过期。
        不使用 Commit 时间、Snapshot 编号或图序，避免把"已提交未激活"误判为过期。
        """
        hist = st.get("activation_history") or []
        if hist:
            last = hist[-1]
            cur_seq = int(st.get("update_seq") or 0)
            log_seq = int(last.get("update_seq") or 0)
            if log_seq > cur_seq:
                return f"POINTER_ROLLBACK({cur_seq} < {log_seq})"
            if log_seq == cur_seq and last.get("snapshot_id") != sid:
                return f"RECORDED_HEAD_DIFFERS({last.get('snapshot_id')} != {sid})"
            return None
        if not self.activation_log.is_file():
            return None
        last = None
        try:
            for line in self.activation_log.read_text("utf-8").splitlines():
                if line.strip():
                    last = json.loads(line)
        except ValueError:
            return "ACTIVATION_LOG_UNREADABLE"
        if not last:
            return None
        cur_seq = int(st.get("update_seq") or 0)
        log_seq = int(last.get("update_seq") or 0)
        if log_seq > cur_seq:
            return f"POINTER_ROLLBACK({cur_seq} < {log_seq})"
        if log_seq == cur_seq and last.get("snapshot_id") != sid:
            return f"RECORDED_HEAD_DIFFERS({last.get('snapshot_id')} != {sid})"
        return None

    def recover(self, valid_snapshots, operator: str, *, note: str = "") -> dict:
        """唯一候选才恢复；写诊断与恢复记录；不改任何 parent。"""
        valid_snapshots = self._as_map(valid_snapshots)
        cands = sorted(valid_snapshots)
        if len(cands) != 1:
            diag = self.resolve(valid_snapshots)
            return {"ok": False, "code": "HEAD_AMBIGUOUS" if cands else "HEAD_MISSING",
                    "candidates": cands, "diagnosis": diag}
        sid = cands[0]
        before = (self.read() or {}).get("active_head")
        snap_path = self.root / f"catalog/snapshots/{sid}.json"
        res = self.activate(sid, snap_path, expected_prev=before,
                            writer_host=(self.read() or {}).get("writer_host"), writer_epoch=None)
        if not res["ok"]:
            return res
        self.recovery_dir.mkdir(parents=True, exist_ok=True)
        rec = {"format_version": "wfd.recovery/1.0", "at_utc": _now(), "operator": operator, "note": note,
               "diagnosis": self.resolve(valid_snapshots), "candidates": cands, "chosen": sid,
               "state_before": before, "state_after": sid,
               "snapshot_sha256": "sha256:" + _sha_file(snap_path),
               "parent_snapshot_id_unchanged": json.loads(snap_path.read_text("utf-8")).get("parent_snapshot_id")}
        (self.recovery_dir / f"{_now().replace(':', '')}.json").write_text(
            json.dumps(rec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return {"ok": True, "code": "OK", "snapshot_id": sid, "state": res["state"]}
