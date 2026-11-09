#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""已发布错误更正的 WFD 正式用途治理（catalog 持久、单写入者锁保护）。

不新建业务表、不改协议版本：状态与 StateStore / retention 一样落在
``<root>/catalog/usage_suspensions.json``，所有写入与 submit 共用 writer_lock。
每次读取都从磁盘重核当前事项，不依赖进程启动时的缓存（逐页/逐请求生效）。

不可变约束：
- 暂停范围（scope）登记后不可删除、不可改写、不可因事项完成而解禁；
  ``resolve`` 只能追加经核验的新版本说明。旧已知错误版本因此永久保留
  "已知问题" 与受限资格，不会因关闭一个事项重新变得可计算/可发布。
- 多个事项的限制叠加：任一事项命中即生效，关闭一个不能解除另一个。
- 默认业务读取、普通查询、固定分页、审计以外的技术读取、计算取数与
  新发布都不得绕过；只有显式指定事项编号的审计/技术固定复现可以返回
  带已知问题说明的旧内容，结果明确标记不可发布、不可计算。
"""
from __future__ import annotations

import copy
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from . import row_version_objects
from .duckdb_sdk import canonical, sha
from .writerlock import writer_lock

FORMAT = "wfd.usage-suspension/1"
FILENAME = "catalog/usage_suspensions.json"
INITIALIZED = "catalog/usage_suspensions.initialized"
USAGES = frozenset({"business_read", "compute", "publish"})
REPAIR_MODES = frozenset({"source_correction", "processing_repair"})
SNAPSHOT_ID = re.compile(r"s_[0-9a-f]{24}")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _path(root) -> Path:
    return Path(root) / FILENAME


def load(root) -> dict:
    """每次调用都重读磁盘；从未登记为空，已登记后丢失必须显式报错。"""
    path = _path(root)
    initialized = Path(root) / INITIALIZED
    if not path.is_file():
        if initialized.is_file():
            raise ValueError("USAGE_GOVERNANCE_MISSING:" + str(path))
        return {"format_version": FORMAT, "issues": [], "tickets": []}
    try:
        data = json.loads(path.read_text("utf-8"))
    except ValueError as exc:
        raise ValueError("USAGE_GOVERNANCE_UNREADABLE:" + str(exc)) from exc
    if not isinstance(data, dict) or data.get("format_version") != FORMAT:
        raise ValueError("USAGE_GOVERNANCE_FORMAT")
    if not isinstance(data.get("issues"), list) or not isinstance(data.get("tickets"), list):
        raise ValueError("USAGE_GOVERNANCE_FORMAT")
    return data


def _atomic(root, data) -> None:
    path = _path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    fd, tmp = tempfile.mkstemp(prefix=".usage_", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        marker = Path(root) / INITIALIZED
        if not marker.exists():
            marker.write_text("1\n", encoding="utf-8")
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _text(value, label: str, limit: int = 4096) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit or "\x00" in value:
        raise ValueError("USAGE_DECLARATION_INVALID:" + label)
    return value


def _validate_scope(scope) -> dict:
    if not isinstance(scope, dict):
        raise ValueError("USAGE_SCOPE_INVALID")
    allowed = {"product_id", "snapshot_id", "record_versions", "usages", "series_id"}
    if set(scope) - allowed:
        raise ValueError("USAGE_SCOPE_INVALID:unexpected fields")
    product_id = _text(scope.get("product_id"), "product_id", 256)
    # 冻结影响清单必须给出具体固定快照；不允许"整个产品所有快照"的模糊暂停
    snapshot_id = _text(scope.get("snapshot_id"), "snapshot_id", 256)
    versions = scope.get("record_versions")
    if not isinstance(versions, list) or not versions or len(versions) > 100_000:
        raise ValueError("USAGE_SCOPE_INVALID:record_versions")
    if any(not isinstance(item, str) or not item or len(item) > 256 or "\x00" in item for item in versions):
        raise ValueError("USAGE_SCOPE_INVALID:record_version")
    if len(set(versions)) != len(versions):
        raise ValueError("USAGE_SCOPE_INVALID:duplicate record_version")
    usages = scope.get("usages", sorted(USAGES))
    if not isinstance(usages, list) or not usages or not set(usages) <= USAGES:
        raise ValueError("USAGE_SCOPE_INVALID:usages")
    return {"product_id": product_id, "snapshot_id": snapshot_id,
            "record_versions": list(versions), "usages": sorted(set(usages)),
            **({"series_id": _text(scope["series_id"], "series_id", 256)} if "series_id" in scope else {})}


def _validate_revisions(value) -> list:
    if not isinstance(value, list) or not value or len(value) > 100_000:
        raise ValueError("USAGE_REVISIONS_INVALID")
    out = []
    for entry in value:
        if not isinstance(entry, dict) or set(entry) != {"product_id", "snapshot_id", "logical_key", "revision_id"}:
            raise ValueError("USAGE_REVISIONS_INVALID:four-tuple")
        if any(not isinstance(entry[key], str) or not entry[key] for key in entry):
            raise ValueError("USAGE_REVISIONS_INVALID:four-tuple")
        out.append({key: entry[key] for key in ("product_id", "snapshot_id", "logical_key", "revision_id")})
    keys = [(item["product_id"], item["snapshot_id"], item["logical_key"], item["revision_id"]) for item in out]
    if len(set(keys)) != len(keys):
        raise ValueError("USAGE_REVISIONS_INVALID:duplicate")
    return sorted(out, key=lambda item: canonical(item))


def _read_json(path: Path, code: str) -> dict:
    try:
        raw = path.read_bytes()
        data = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise ValueError(code + ":" + path.name) from exc
    if not isinstance(data, dict):
        raise ValueError(code + ":" + path.name)
    return data


def _request_key(identity: dict) -> str:
    return sha(canonical([identity["dataset_id"], identity["trusted_actor_namespace"], identity["request_id"]]))


def _read_snapshot(root, snapshot_id: str) -> dict:
    """重读并核对真实 commit/snapshot/manifest；不信任调用方给出的编号字符串。"""
    if not isinstance(snapshot_id, str) or not SNAPSHOT_ID.fullmatch(snapshot_id):
        raise ValueError("USAGE_RESOLUTION_SNAPSHOT_INVALID")
    base = Path(root)
    commit_path = base / "catalog/commits" / f"{snapshot_id}.json"
    commit = _read_json(commit_path, "USAGE_RESOLUTION_COMMIT_MISSING")
    if commit.get("snapshot_id") != snapshot_id:
        raise ValueError("USAGE_RESOLUTION_COMMIT_MISMATCH")
    try:
        snapshot_file = row_version_objects.snapshot_relative(commit, snapshot_id)
    except row_version_objects.RowVersionObjectError as exc:
        raise ValueError("USAGE_RESOLUTION_COMMIT_MISMATCH") from exc
    if snapshot_file != f"catalog/snapshots/{snapshot_id}.json":
        raise ValueError("USAGE_RESOLUTION_COMMIT_MISMATCH")
    try:
        snapshot_raw = (base / snapshot_file).read_bytes()
    except OSError as exc:
        raise ValueError("USAGE_RESOLUTION_SNAPSHOT_MISSING") from exc
    if commit.get("snapshot_sha256") != sha(snapshot_raw):
        raise ValueError("USAGE_RESOLUTION_SNAPSHOT_DIGEST")
    try:
        snapshot = json.loads(snapshot_raw.decode("utf-8"))
    except (UnicodeError, ValueError) as exc:
        raise ValueError("USAGE_RESOLUTION_SNAPSHOT_INVALID") from exc
    if not isinstance(snapshot, dict) or snapshot.get("snapshot_id") != snapshot_id:
        raise ValueError("USAGE_RESOLUTION_SNAPSHOT_INVALID")
    manifest_rel, manifest_sha = snapshot.get("manifest_relpath"), snapshot.get("manifest_sha256")
    if (not isinstance(manifest_rel, str) or not manifest_rel.startswith("catalog/manifests/")
            or not isinstance(manifest_sha, str) or len(manifest_sha) != 64):
        raise ValueError("USAGE_RESOLUTION_SNAPSHOT_INVALID")
    try:
        manifest_raw = (base / manifest_rel).read_bytes()
        manifest = json.loads(manifest_raw.decode("utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise ValueError("USAGE_RESOLUTION_MANIFEST_MISSING") from exc
    if not isinstance(manifest, dict) or sha(manifest_raw) != manifest_sha or manifest.get("files") != snapshot.get("files"):
        raise ValueError("USAGE_RESOLUTION_MANIFEST_MISMATCH")
    return snapshot


def _head_chain(root) -> dict:
    """沿持久 parent 关系核对 HEAD 链；拒绝分叉/环/未知快照。"""
    state = _read_json(Path(root) / "catalog/state.json", "USAGE_RESOLUTION_HEAD_UNREADABLE")
    head = state.get("active_head")
    chain: dict[str, dict] = {}
    while isinstance(head, str):
        if head in chain:
            raise ValueError("USAGE_RESOLUTION_HEAD_CYCLE")
        if len(chain) > 100_000:
            raise ValueError("USAGE_RESOLUTION_HEAD_TOO_LONG")
        snapshot = _read_snapshot(root, head)
        chain[head] = snapshot
        head = snapshot.get("parent_snapshot_id")
        if head is not None and not isinstance(head, str):
            raise ValueError("USAGE_RESOLUTION_HEAD_INVALID")
    return chain


def _formal_publication(root, ticket: dict, snapshot_id: str) -> dict:
    """核对票据身份对应的真实提交回执、正式发布记录与冻结文档摘要。"""
    identity = ticket["request_identity"]
    key = _request_key(identity)
    receipt = _read_json(Path(root) / "catalog/governance/receipts" / f"{key}.json",
                         "USAGE_RESOLUTION_RECEIPT_MISSING")
    if receipt.get("request_key") != key or receipt.get("snapshot_id") != snapshot_id:
        raise ValueError("USAGE_RESOLUTION_RECEIPT_MISMATCH")
    if receipt.get("status") not in {"published_sandbox", "published_formal"}:
        raise ValueError("USAGE_RESOLUTION_NOT_PUBLISHED")
    formal = _read_json(Path(root) / "catalog/product_service/data_only_formal_publications" / f"{key}.json",
                        "USAGE_RESOLUTION_FORMAL_MISSING")
    if (formal.get("request_key") != key or formal.get("snapshot_id") != snapshot_id
            or formal.get("formal_publication_state") != "published_formal"):
        raise ValueError("USAGE_RESOLUTION_NOT_FORMAL")
    checks = formal.get("checks") if isinstance(formal.get("checks"), dict) else {}
    for name in ("snapshot_present", "commit_marker_present", "valid_commit", "record_identity_verified",
                 "fixed_readback_verified", "engine_not_sandbox"):
        if checks.get(name) is not True:
            raise ValueError("USAGE_RESOLUTION_FORMAL_CHECK:" + name)
    status = _read_json(Path(root) / "catalog/product_service/data_only_status" / f"{key}.json",
                        "USAGE_RESOLUTION_STATUS_MISSING")
    if status.get("request_key") != key or status.get("snapshot_id") != snapshot_id:
        raise ValueError("USAGE_RESOLUTION_STATUS_MISMATCH")
    if status.get("input_fingerprint") != ticket["document_digest"]:
        raise ValueError("USAGE_RESOLUTION_DOCUMENT_CHANGED")
    intent = _read_json(Path(root) / "catalog/product_service/data_only_intents" / f"{key}.json",
                        "USAGE_RESOLUTION_INTENT_MISSING")
    if (intent.get("request_key") != key
            or canonical(intent.get("request_identity")) != canonical(identity)
            or intent.get("input_fingerprint") != ticket["document_digest"]):
        raise ValueError("USAGE_RESOLUTION_IDENTITY_CHANGED")
    return receipt


def _replacement_versions(root, snapshot: dict, ticket_revisions: list, declared: list) -> list:
    """核对新快照中每个票据前驱恰有一个当前叶替代，且声明集合与真实集合一致。"""
    wanted = {(item["product_id"], item["logical_key"], item["revision_id"]) for item in ticket_revisions}
    found: dict[tuple[str, str, str], str] = {}
    for entry in snapshot.get("files", []):
        product_id = entry.get("product_id")
        by_output = (entry.get("source_bundle") or {}).get("_wfd_row_versions")
        if isinstance(by_output, str):
            try:
                by_output = row_version_objects.load_versions(root, by_output)
            except row_version_objects.RowVersionObjectError as exc:
                raise ValueError("USAGE_RESOLUTION_ROW_VERSION_INVALID") from exc
        if not isinstance(product_id, str) or not isinstance(by_output, dict):
            continue
        for versions in by_output.values():
            if not isinstance(versions, dict):
                continue
            for value in versions.values():
                if not isinstance(value, dict) or value.get("withdrawn") is not False:
                    continue
                logical_key, revision_id, supersedes = (value.get("logical_key"), value.get("revision_id"),
                                                        value.get("supersedes"))
                if not all(isinstance(item, str) and item for item in (logical_key, revision_id, supersedes)):
                    continue
                key = (product_id, logical_key, supersedes)
                if key not in wanted:
                    continue
                if key in found and found[key] != revision_id:
                    raise ValueError("USAGE_RESOLUTION_AMBIGUOUS_REPLACEMENT")
                found[key] = revision_id
    missing = wanted - set(found)
    if missing:
        raise ValueError("USAGE_RESOLUTION_INCOMPLETE_REPLACEMENT")
    actual = {found[key] for key in wanted}
    if len(actual) != len(wanted) or len(set(declared)) != len(declared) or set(declared) != actual:
        raise ValueError("USAGE_RESOLUTION_REPLACEMENT_MISMATCH")
    return sorted(actual)


def _assert_complete_scope(issue: dict, ticket_revisions: list) -> None:
    """票据必须覆盖该事项冻结范围的全部记录版本，避免部分修复后关闭整个事项。"""
    scoped = {(scope["product_id"], scope["snapshot_id"], version)
              for scope in issue["scopes"] for version in scope["record_versions"]}
    proved = {(item["product_id"], item["snapshot_id"], item["revision_id"]) for item in ticket_revisions}
    if scoped != proved:
        raise ValueError("USAGE_RESOLUTION_SCOPE_INCOMPLETE")


def suspend(root, declaration) -> dict:
    """登记一个明确用途暂停事项；与 submit 共用 writer_lock。"""
    if not isinstance(declaration, dict):
        raise ValueError("USAGE_DECLARATION_INVALID")
    allowed = {"issue_id", "error_type", "reason", "evidence_digest", "error_binding_digest",
               "impact_digest", "declared_at_utc", "scopes"}
    if set(declaration) - allowed:
        raise ValueError("USAGE_DECLARATION_INVALID:unexpected fields")
    issue_id = _text(declaration.get("issue_id"), "issue_id", 256)
    error_type = _text(declaration.get("error_type"), "error_type", 128)
    reason = _text(declaration.get("reason"), "reason", 4096)
    evidence_digest = _text(declaration.get("evidence_digest"), "evidence_digest", 256)
    error_binding_digest = _text(declaration.get("error_binding_digest"), "error_binding_digest", 256)
    impact_digest = _text(declaration.get("impact_digest"), "impact_digest", 256)
    declared_at = _text(declaration.get("declared_at_utc"), "declared_at_utc", 64)
    raw_scopes = declaration.get("scopes")
    if not isinstance(raw_scopes, list) or not raw_scopes or len(raw_scopes) > 256:
        raise ValueError("USAGE_SCOPE_INVALID:scopes")
    scopes = [_validate_scope(scope) for scope in raw_scopes]
    seen = set()
    for scope in scopes:
        key = (scope["product_id"], scope["snapshot_id"])
        if key in seen:
            raise ValueError("USAGE_SCOPE_INVALID:duplicate product/snapshot")
        seen.add(key)
    with writer_lock(root):
        data = load(root)
        existing = next((item for item in data["issues"] if item["issue_id"] == issue_id), None)
        if existing is not None:
            same = (existing.get("error_type") == error_type and existing.get("reason") == reason
                    and existing.get("evidence_digest") == evidence_digest
                    and existing.get("error_binding_digest") == error_binding_digest
                    and existing.get("impact_digest") == impact_digest
                    and existing.get("declared_at_utc") == declared_at
                    and canonical(sorted(existing.get("scopes", []), key=canonical))
                    == canonical(sorted(scopes, key=canonical)))
            if not same:
                raise ValueError("USAGE_ISSUE_DUPLICATE:" + issue_id)
            return {"issue_id": issue_id, "issue_digest": existing["issue_digest"],
                    "state": existing["state"], "idempotent": True,
                    "scope_count": len(existing.get("scopes", [])),
                    "record_versions": sum(len(scope.get("record_versions", []))
                                           for scope in existing.get("scopes", []))}
        issue = {"issue_id": issue_id, "error_type": error_type, "reason": reason,
                 "evidence_digest": evidence_digest, "error_binding_digest": error_binding_digest,
                 "impact_digest": impact_digest, "declared_at_utc": declared_at,
                 "scopes": scopes, "state": "active", "resolution": None}
        issue["issue_digest"] = sha(canonical({key: value for key, value in issue.items() if key != "issue_digest"}))
        data["issues"].append(issue)
        _atomic(root, data)
    return {"issue_id": issue_id, "issue_digest": issue["issue_digest"], "state": "active",
            "scope_count": len(scopes), "record_versions": sum(len(scope["record_versions"]) for scope in scopes)}


def status(root) -> dict:
    """只读当前持久治理状态；不缓存。"""
    data = load(root)
    return {"format_version": FORMAT,
            "issues": [{key: copy.deepcopy(value) for key, value in issue.items()} for issue in data["issues"]],
            "tickets": [copy.deepcopy(ticket) for ticket in data["tickets"]],
            "active_issues": sum(1 for issue in data["issues"] if issue.get("state") == "active"),
            "suspended_record_versions": sum(len(scope.get("record_versions", []))
                                             for issue in data["issues"] for scope in issue.get("scopes", []))}


def authorize_repair(root, declaration) -> dict:
    """签发一次精确修复票据：绑定不可变文档摘要、原请求身份、精确前驱集合与确认摘要。

    只由宿主在真实任务审批通过后调用；模型/调用方不能自授权，也不能凭正文
    ``authorized`` 取得票据。票据不因失败而失效，原号恢复由 WFD 既有
    request_identity 幂等状态保证，不会因暂停创建新提交身份。
    """
    if not isinstance(declaration, dict):
        raise ValueError("USAGE_TICKET_INVALID")
    allowed = {"ticket_id", "issue_id", "document_digest", "request_identity", "revisions",
               "confirmation_digest", "repair_mode", "error_binding_digest", "impact_digest", "budget"}
    if set(declaration) - allowed:
        raise ValueError("USAGE_TICKET_INVALID:unexpected fields")
    ticket_id = _text(declaration.get("ticket_id"), "ticket_id", 256)
    issue_id = _text(declaration.get("issue_id"), "issue_id", 256)
    document_digest = _text(declaration.get("document_digest"), "document_digest", 256)
    confirmation_digest = _text(declaration.get("confirmation_digest"), "confirmation_digest", 256)
    error_binding_digest = _text(declaration.get("error_binding_digest"), "error_binding_digest", 256)
    impact_digest = _text(declaration.get("impact_digest"), "impact_digest", 256)
    repair_mode = _text(declaration.get("repair_mode"), "repair_mode", 64)
    if repair_mode not in REPAIR_MODES:
        raise ValueError("USAGE_TICKET_INVALID:repair_mode")
    identity = declaration.get("request_identity")
    if not isinstance(identity, dict) or set(identity) != {"dataset_id", "trusted_actor_namespace",
                                                            "request_id", "submission_digest"}:
        raise ValueError("USAGE_TICKET_INVALID:request_identity")
    if any(not isinstance(value, str) or not value or len(value) > 256 for value in identity.values()):
        raise ValueError("USAGE_TICKET_INVALID:request_identity")
    revisions = _validate_revisions(declaration.get("revisions"))
    budget = declaration.get("budget")
    if not isinstance(budget, dict) or set(budget) != {"max_rows", "max_document_bytes", "series_count"}:
        raise ValueError("USAGE_TICKET_INVALID:budget")
    if any(not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > 10_000_000
           for value in budget.values()):
        raise ValueError("USAGE_TICKET_INVALID:budget")
    with writer_lock(root):
        data = load(root)
        issue = next((item for item in data["issues"] if item["issue_id"] == issue_id), None)
        if issue is None:
            raise ValueError("USAGE_ISSUE_NOT_FOUND:" + issue_id)
        if issue["state"] != "active":
            raise ValueError("USAGE_ISSUE_NOT_ACTIVE:" + issue_id)
        if issue["error_binding_digest"] != error_binding_digest or issue["impact_digest"] != impact_digest:
            raise ValueError("USAGE_TICKET_FROZEN_CHANGED")
        # 精确前驱必须落在已冻结的暂停范围内；跨产品/多义业务键/范围外一律拒绝。
        allowed_refs = {(scope["product_id"], scope["snapshot_id"], version)
                        for scope in issue["scopes"] for version in scope["record_versions"]}
        for revision in revisions:
            if (revision["product_id"], revision["snapshot_id"], revision["revision_id"]) not in allowed_refs:
                raise ValueError("USAGE_TICKET_PREDECESSOR_OUT_OF_SCOPE")
        existing = next((item for item in data["tickets"] if item["ticket_id"] == ticket_id), None)
        if existing is not None:
            same = (existing.get("issue_id") == issue_id
                    and existing.get("document_digest") == document_digest
                    and canonical(existing.get("request_identity")) == canonical(identity)
                    and existing.get("revisions") == revisions
                    and existing.get("confirmation_digest") == confirmation_digest
                    and existing.get("repair_mode") == repair_mode
                    and existing.get("error_binding_digest") == error_binding_digest
                    and existing.get("impact_digest") == impact_digest
                    and canonical(existing.get("budget")) == canonical(budget))
            if not same:
                raise ValueError("USAGE_TICKET_DUPLICATE:" + ticket_id)
            return {"ticket_id": ticket_id, "ticket_digest": existing["ticket_digest"],
                    "issue_id": issue_id, "state": existing["state"], "idempotent": True,
                    "revisions": len(existing.get("revisions", []))}
        ticket = {"ticket_id": ticket_id, "issue_id": issue_id, "document_digest": document_digest,
                  "request_identity": copy.deepcopy(identity), "revisions": revisions,
                  "confirmation_digest": confirmation_digest, "repair_mode": repair_mode,
                  "error_binding_digest": error_binding_digest, "impact_digest": impact_digest,
                  "budget": copy.deepcopy(budget), "authorized_at_utc": _now(),
                  "state": "authorized", "resolution": None}
        ticket["ticket_digest"] = sha(canonical({key: value for key, value in ticket.items() if key != "ticket_digest"}))
        data["tickets"].append(ticket)
        _atomic(root, data)
    return {"ticket_id": ticket_id, "ticket_digest": ticket["ticket_digest"],
            "issue_id": issue_id, "state": "authorized", "revisions": len(revisions)}


def resolve(root, declaration) -> dict:
    """按已核验的新版本追加解决说明；旧错误版本的已知问题与限制永久保留。"""
    if not isinstance(declaration, dict):
        raise ValueError("USAGE_RESOLUTION_INVALID")
    allowed = {"issue_id", "ticket_id", "document_digest", "replacement_snapshot_id",
               "replacement_record_versions", "verification_digest", "verified_at_utc"}
    if set(declaration) - allowed:
        raise ValueError("USAGE_RESOLUTION_INVALID:unexpected fields")
    issue_id = _text(declaration.get("issue_id"), "issue_id", 256)
    ticket_id = _text(declaration.get("ticket_id"), "ticket_id", 256)
    document_digest = _text(declaration.get("document_digest"), "document_digest", 256)
    replacement_snapshot = _text(declaration.get("replacement_snapshot_id"), "replacement_snapshot_id", 256)
    verification_digest = _text(declaration.get("verification_digest"), "verification_digest", 256)
    verified_at = _text(declaration.get("verified_at_utc"), "verified_at_utc", 64)
    versions = declaration.get("replacement_record_versions")
    if not isinstance(versions, list) or not versions or len(versions) > 100_000:
        raise ValueError("USAGE_RESOLUTION_INVALID:replacement_record_versions")
    if any(not isinstance(item, str) or not item or len(item) > 256 for item in versions):
        raise ValueError("USAGE_RESOLUTION_INVALID:replacement_record_versions")
    if len(set(versions)) != len(versions):
        raise ValueError("USAGE_RESOLUTION_INVALID:duplicate replacement_record_version")
    # 首次存储与重放比较统一按排序集合，不把调用方原顺序当作身份差异。
    versions = sorted(versions)
    with writer_lock(root):
        data = load(root)
        issue = next((item for item in data["issues"] if item["issue_id"] == issue_id), None)
        if issue is None:
            raise ValueError("USAGE_ISSUE_NOT_FOUND:" + issue_id)
        ticket = next((item for item in data["tickets"] if item["ticket_id"] == ticket_id), None)
        if ticket is None or ticket["issue_id"] != issue_id or ticket["document_digest"] != document_digest:
            raise ValueError("USAGE_RESOLUTION_TICKET_MISMATCH")
        if issue["state"] == "resolved":
            old = issue.get("resolution") or {}
            if (old.get("verification_digest") != verification_digest
                    or old.get("replacement_snapshot_id") != replacement_snapshot
                    or old.get("replacement_record_versions") != versions):
                raise ValueError("USAGE_RESOLUTION_CONFLICT")
            return {"issue_id": issue_id, "state": "resolved", "idempotent": True,
                    "resolution": copy.deepcopy(issue["resolution"])}
        # 解决不是调用方声明：必须核票据覆盖完整冻结范围、真实 formal 发布回执与
        # 新快照中的精确前驱替代；编号字符串和验证摘要本身不构成证据。
        _assert_complete_scope(issue, ticket["revisions"])
        head_chain = _head_chain(root)
        if replacement_snapshot not in head_chain:
            raise ValueError("USAGE_RESOLUTION_SNAPSHOT_NOT_ACTIVATED")
        snapshot = head_chain[replacement_snapshot]
        scoped_snapshots = {scope["snapshot_id"] for scope in issue["scopes"]}
        if replacement_snapshot in scoped_snapshots:
            raise ValueError("USAGE_RESOLUTION_SNAPSHOT_REUSED")
        if not scoped_snapshots <= set(head_chain):
            raise ValueError("USAGE_RESOLUTION_PREDECESSOR_SNAPSHOT_UNKNOWN")
        # 原错误快照必须是新快照的祖先；否则不是同一正式历史线的替代。
        for original_snapshot in scoped_snapshots:
            cursor = replacement_snapshot
            while cursor is not None and cursor != original_snapshot:
                cursor = head_chain[cursor].get("parent_snapshot_id")
            if cursor is None:
                raise ValueError("USAGE_RESOLUTION_NOT_DESCENDANT")
        # 新快照必须在当前 HEAD 的祖先链上，防止解决一个未激活/分叉快照。
        _formal_publication(root, ticket, replacement_snapshot)
        actual_versions = _replacement_versions(root, snapshot, ticket["revisions"], versions)
        resolution = {"ticket_id": ticket_id, "document_digest": document_digest,
                      "replacement_snapshot_id": replacement_snapshot,
                      "replacement_record_versions": actual_versions,
                      "verification_digest": verification_digest, "verified_at_utc": verified_at}
        issue["state"] = "resolved"
        issue["resolution"] = resolution
        ticket["state"] = "resolved"
        ticket["resolution"] = copy.deepcopy(resolution)
        _atomic(root, data)
    return {"issue_id": issue_id, "state": "resolved", "idempotent": False,
            "resolution": copy.deepcopy(resolution), "legacy_restrictions_retained": True}


def _scope_matches(scope, snapshot_id, product_ids, rows) -> bool:
    """限制跟随产品 + 错误记录版本，跨后续快照持续生效。

    登记快照只作定位/审计依据；后续快照若原样携带同一 revision_id，仍属同一
    错误记录版本，不能因快照推进而绕过。记录被正式替代后 revision_id 改变，
    新版本不再命中；旧快照中的旧版本仍永久命中并保留已知问题。
    """
    if scope["product_id"] not in product_ids:
        return False
    target = set(scope["record_versions"])
    for row in rows:
        ref = row.get("record_ref") or {}
        if ref.get("product_id") == scope["product_id"] and ref.get("revision_id") in target:
            return True
    return False


def _context_subset(expected, actual) -> bool:
    """规范化后的 semantic_context 只能增补 applicability/unknown 轴；原声明键值必须保留。"""
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        return all(key in actual and _context_subset(value, actual[key]) for key, value in expected.items())
    if isinstance(expected, list):
        return canonical(expected) == canonical(actual)
    return expected == actual


def _declaration_matches(declaration, definition) -> bool:
    """比较未规范化产品声明与文档 create 声明，允许 semantic_context 加规范化轴。"""
    if not isinstance(declaration, dict) or not isinstance(definition, dict):
        return False
    for key in ("semantic_code", "measurement_nature", "unit_code", "definition_authority", "time_role"):
        if declaration.get(key) != definition.get(key):
            return False
    for key in ("field_definitions", "field_semantic_context", "algorithm_definition"):
        if definition.get(key) is not None and canonical(declaration.get(key)) != canonical(definition.get(key)):
            return False
    return _context_subset(definition.get("semantic_context"), declaration.get("semantic_context"))


def _catalog_product_ids(root, digest: str, subject=None, definition=None) -> set:
    """按已登记产品的完整身份（定义摘要/声明 + 主体）定位；不聚合不同主体。"""
    found = set()
    folder = Path(root) / "catalog/product_service/products"
    if not folder.is_dir():
        return found
    wanted_subject = canonical(subject) if isinstance(subject, dict) else None
    wanted_digest = digest.replace("sha256:", "") if isinstance(digest, str) and digest else ""
    for path in sorted(folder.glob("*.json"))[:100_000]:
        try:
            data = json.loads(path.read_text("utf-8"))
        except (OSError, UnicodeError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        product_id = data.get("product_id")
        if not isinstance(product_id, str):
            continue
        if wanted_subject is not None and canonical(data.get("subject")) != wanted_subject:
            continue
        ref = data.get("definition_ref") if isinstance(data.get("definition_ref"), dict) else {}
        digest_match = wanted_digest and str(ref.get("digest", "")).replace("sha256:", "") == wanted_digest
        declaration_match = isinstance(definition, dict) and _declaration_matches(data.get("declaration"), definition)
        if digest_match or declaration_match:
            found.add(product_id)
    return found


def _product_ids_for_submit(root, outputs, refs) -> set:
    """普通新增/复用的产品身份以权威注册为准；同定义不同主体不能合并。"""
    products = {item[0] for item in refs if isinstance(item[0], str)}
    if products:
        return products
    for output in outputs:
        if not isinstance(output, dict):
            continue
        product_id = output.get("product_id")
        if isinstance(product_id, str) and product_id.startswith("p_"):
            products.add(product_id)
            continue
        subject = output.get("subject") if isinstance(output.get("subject"), dict) else None
        ref = output.get("definition_ref") if isinstance(output.get("definition_ref"), dict) else {}
        digest = str(ref.get("digest", "")) if output.get("definition_mode") == "reuse" else ""
        if not digest and isinstance(output.get("definition"), dict):
            digest = "sha256:" + sha(canonical(output["definition"]))
        definition = output.get("definition") if isinstance(output.get("definition"), dict) else None
        authoritative = _catalog_product_ids(root, digest, subject, definition)
        if authoritative:
            products |= authoritative
            continue
        if output.get("definition_mode") == "create" and definition and subject:
            products.add("p_" + sha(canonical([output.get("logical_domain"), subject,
                                               output.get("definition")]))[:24])
    return products


def _issue_matches_submit(issue, refs, snapshots, products) -> bool:
    for product_id, snapshot_id, revision_id in refs:
        for scope in issue["scopes"]:
            if scope["product_id"] == product_id and revision_id in scope["record_versions"]:
                return True
    if refs:
        return False
    # 普通新增必须按真实产品身份匹配；不能因 revisions 为空就把全库当作命中。
    return any(scope["product_id"] in products for scope in issue["scopes"])


def enforce_read(root, result, audit_issue_id=None) -> dict | None:
    """共用读取闸口；供 WFDProductService._public_read_result 调用。

    命中任一事项即阻断默认业务读取，不静默过滤行、不改变选择集或游标。
    仅当显式给出匹配的事项编号时，返回带已知问题说明的审计复现结果。
    """
    data = load(root)
    if not data["issues"]:
        return None
    snapshot_id = result.get("snapshot_id")
    rows = result.get("rows") if isinstance(result.get("rows"), list) else []
    # 只按本次实际返回的行判定：result["products"]可能是整快照的产品清单，
    # 用它会把未受影响产品误判为受限，等于静默扩大暂停范围。
    product_ids = set()
    for row in rows:
        ref = row.get("record_ref") if isinstance(row, dict) else None
        if isinstance(ref, dict) and ref.get("product_id"):
            product_ids.add(ref["product_id"])
    if not rows:
        for product in result.get("products") or []:
            if isinstance(product, dict) and product.get("product_id"):
                product_ids.add(product["product_id"])
    matched = []
    for issue in data["issues"]:
        if any(_scope_matches(scope, snapshot_id, product_ids, rows) for scope in issue["scopes"]):
            matched.append(issue)
    if not matched:
        return None
    known = [{"issue_id": issue["issue_id"], "error_type": issue["error_type"],
              "reason": issue["reason"], "state": issue["state"],
              "resolution": copy.deepcopy(issue.get("resolution"))} for issue in matched]
    governance = {"format_version": FORMAT, "known_issues": known,
                  "publishable": False, "compute_eligible": False,
                  "audit_reproduction": bool(audit_issue_id),
                  "legacy_restrictions_retained": True}
    if audit_issue_id:
        if any(issue["issue_id"] == audit_issue_id for issue in matched):
            governance["usage_scope"] = "explicit_audit_reproduction"
            return governance
        raise ValueError("USAGE_SUSPENDED:AUDIT_ISSUE_MISMATCH")
    active = [issue for issue in matched if issue["state"] == "active"]
    code = "USAGE_SUSPENDED" if active else "USAGE_KNOWN_ISSUE_LEGACY"
    detail = ",".join(issue["issue_id"] for issue in active or matched)
    raise ValueError(f"{code}:{detail}:default business/compute reads are denied; "
                     "use an explicit audit fixed read for technical reproduction")


def enforce_submit(root, doc) -> dict | None:
    """新发布 / 计算取数边界；只在 writer_lock 内由 submit 调用。"""
    data = load(root)
    if not data["issues"]:
        return None
    outputs = doc.get("outputs") if isinstance(doc, dict) else None
    if not isinstance(outputs, list):
        return None
    parent = doc.get("expected_parent_snapshot_id")
    refs = []
    for output in outputs:
        if not isinstance(output, dict):
            continue
        for change in (output.get("revisions") or {}).values() if isinstance(output.get("revisions"), dict) else []:
            previous = change.get("previous") if isinstance(change, dict) else None
            if isinstance(previous, dict):
                refs.append((previous.get("product_id"), previous.get("snapshot_id"), previous.get("revision_id")))
    snapshots = {parent} if isinstance(parent, str) else set()
    snapshots |= {item[1] for item in refs if isinstance(item[1], str)}
    products = _product_ids_for_submit(root, outputs, refs)
    if not refs and not products:
        raise ValueError("USAGE_SUBMIT_PRODUCT_UNRESOLVED:cannot identify affected product without revisions")
    # 只把仍处于 active 的事项当作本次提交的放行条件；已解决事项保留历史
    # 版本读取限制，但不应阻止同一产品后续的新观测/普通重复提交。
    matched = [issue for issue in data["issues"]
               if issue.get("state") == "active"
               and _issue_matches_submit(issue, refs, snapshots, products)]
    if not matched:
        return None
    fingerprint = sha(canonical(doc))
    identity = doc.get("request_identity") if isinstance(doc.get("request_identity"), dict) else None
    modes = {output.get("input_mode") for output in outputs if isinstance(output, dict)}
    if not modes <= REPAIR_MODES or not refs:
        raise ValueError("USAGE_SUSPENDED_REPAIR_NOT_AUTHORIZED:reasoned precise-predecessor revisions required")
    document_revisions = []
    for output in outputs:
        if not isinstance(output, dict):
            continue
        declared = output.get("revisions")
        if not isinstance(declared, dict):
            continue
        for logical_key, change in declared.items():
            previous = change.get("previous") if isinstance(change, dict) else None
            if not isinstance(previous, dict):
                continue
            document_revisions.append({"product_id": previous.get("product_id"),
                                       "snapshot_id": previous.get("snapshot_id"),
                                       "logical_key": logical_key,
                                       "revision_id": previous.get("revision_id")})
    document_revisions = _validate_revisions(document_revisions)
    # 多事项叠加：命中的每个事项都必须有本次冻结文档的匹配票据；任一单事项
    # 票据不能越过另一事项限制。票据还须覆盖该事项全部冻结记录版本。
    chosen = []
    for issue in matched:
        ticket = next((item for item in data["tickets"]
                       if item["ticket_id"] and item["issue_id"] == issue["issue_id"]
                       and item["state"] == "authorized"
                       and item["document_digest"] == fingerprint
                       and canonical(item["request_identity"]) == canonical(identity)
                       and item["revisions"] == document_revisions), None)
        if ticket is None:
            raise ValueError("USAGE_SUSPENDED_REPAIR_NOT_AUTHORIZED:every matched issue requires its own "
                             "host-authorized frozen document:" + issue["issue_id"])
        _assert_complete_scope(issue, document_revisions)
        chosen.append(ticket)
    return {"ticket_id": chosen[0]["ticket_id"], "ticket_ids": [item["ticket_id"] for item in chosen],
            "issue_ids": [item["issue_id"] for item in chosen]}
