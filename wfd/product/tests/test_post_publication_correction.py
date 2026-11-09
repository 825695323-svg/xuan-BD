"""已发布错误更正：WFD 正式用途治理的真实引擎集成验收（合成隔离库）。

覆盖：发布后固定读回一致 → 登记错误与正式暂停 → 暂停落盘且磁盘重开仍生效 →
普通固定读/整产品页/机器查询/计算取数不能绕过 → 显式审计复现带已知问题说明 →
未授权修订拒绝 → 精确前驱原因化修订 → 新旧替代核对 → 旧版本限制永久保留 →
多事项限制叠加、并发前驱过时与重复请求冲突。

所有数据均为合成值；不读取日常 WFD、运行配置或真实材料。
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from test_r1_data_only import request, scalar_output, UNITS, NAMESPACE
from test_product_service import ALL_ROLES, HERE
from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator, canonical, sha
from wfd_sdk.product_data_service import WFDDataOnlyService
from wfd_sdk import usage_suspension as gov


def make_service(tmp_path, roles=ALL_ROLES):
    engine = WFDDuckDBPrototype(tmp_path / "store", load_protocol_validator(
        HERE / "protocol", entry="wfd-data-only-write.schema.json"),
        runtime_root=tmp_path / "runtime", sandbox=False, writer_host="correction-test")
    return WFDDataOnlyService(engine, caller_roles=roles, caller_id="correction-test",
                              unit_registry=UNITS, trusted_actor_namespaces={NAMESPACE})


def two_series_doc(request_id, *, parent=None, value_a="10", value_b="20"):
    """两个互不影响的产品族，用于证明更正不扩改未受影响系列。"""
    a = scalar_output("series_a", "correction.series.a", value_a)
    b = scalar_output("series_b", "correction.series.b", value_b)
    return request([a, b], request_id, parent=parent)


def issue(root, case_id, scopes, *, error_type="mapping_error", reason="synthetic mapping error"):
    return gov.suspend(root, {
        "issue_id": case_id, "error_type": error_type, "reason": reason,
        "evidence_digest": "sha256:" + "a" * 64,
        "error_binding_digest": "sha256:" + "b" * 64,
        "impact_digest": "sha256:" + "c" * 64,
        "declared_at_utc": "2026-11-07T00:00:00Z", "scopes": scopes})


def ticket(root, case_id, doc, previous_refs, *, mode="processing_repair", ticket_id=None,
           binding_digest="sha256:" + "b" * 64, impact_digest="sha256:" + "c" * 64):
    digest = sha(canonical(doc))
    return gov.authorize_repair(root, {
        "ticket_id": ticket_id or "ticket:" + case_id, "issue_id": case_id,
        "document_digest": digest, "request_identity": doc["request_identity"],
        "revisions": previous_refs, "confirmation_digest": digest, "repair_mode": mode,
        "error_binding_digest": binding_digest, "impact_digest": impact_digest,
        "budget": {"max_rows": 10, "max_document_bytes": 786432, "series_count": 2}})


def revised_doc(first, product_a, first_sid, old_revision, *, value="10", mode="processing_repair",
                request_id="repair-1"):
    out = copy.deepcopy(scalar_output("series_a", "correction.series.a", value))
    out.update(definition_mode="reuse",
               definition_ref=copy.deepcopy(a_ref(first)["definition_ref"]),
               definition=None, input_mode=mode)
    out["revisions"] = {"row-series_a": {"previous": {
        "product_id": product_a, "snapshot_id": first_sid,
        "logical_key": "row-series_a", "revision_id": old_revision},
        "reason": "synthetic mapping correction: value factor was wrong"}}
    doc = request([out], request_id, parent=first_sid)
    doc["request_identity"]["submission_digest"] = "sha256:" + sha(canonical(doc)).ljust(64, "0")[:64]
    return doc


def revised_named_doc(first, output_key, semantic, product_id, first_sid, old_revision, *,
                      value="10", mode="processing_repair", request_id="repair-named"):
    """按原固定输出身份构造一个原因化精确前驱修订；用于互不影响系列对照。"""
    ref = next(item for item in first["output_results"] if item["output_key"] == output_key)
    out = copy.deepcopy(scalar_output(output_key, semantic, value))
    out.update(definition_mode="reuse", definition_ref=copy.deepcopy(ref["definition_ref"]),
               definition=None, input_mode=mode)
    out["revisions"] = {"row-" + output_key: {"previous": {
        "product_id": product_id, "snapshot_id": first_sid,
        "logical_key": "row-" + output_key, "revision_id": old_revision},
        "reason": "synthetic mapping correction: value factor was wrong"}}
    doc = request([out], request_id, parent=first_sid)
    doc["request_identity"]["submission_digest"] = "sha256:" + sha(canonical(doc)).ljust(64, "0")[:64]
    return doc


def a_ref(first):
    return next(item for item in first["output_results"] if item["output_key"] == "series_a")


def previous_refs(doc):
    return [{"product_id": change["previous"]["product_id"],
             "snapshot_id": change["previous"]["snapshot_id"],
             "logical_key": key, "revision_id": change["previous"]["revision_id"]}
            for output in doc["outputs"] for key, change in output["revisions"].items()]


def publish_two_series(service, tmp_path):
    first = service.submit(two_series_doc("original-1"))
    assert first["state"] == "published_formal", first
    first_sid = first["snapshot_id"]
    a = next(item for item in first["output_results"] if item["output_key"] == "series_a")
    b = next(item for item in first["output_results"] if item["output_key"] == "series_b")
    # 固定读回一致性（两个系列各一行）
    for output in (a, b):
        read = service.read(output["product_id"], snapshot_id=first_sid)
        assert len(read["rows"]) == 1, read
    return first, first_sid, a, b


def test_pause_persists_and_denies_every_business_read_path(tmp_path):
    service = make_service(tmp_path)
    first, first_sid, a, _b = publish_two_series(service, tmp_path)
    old_version = a["records"][0]["record_version"]
    scopes = [{"product_id": a["product_id"], "snapshot_id": first_sid,
               "record_versions": [old_version]}]
    issue(service.root, "case-A", scopes)

    # 磁盘重开：新建 service 实例仍读到同一持久事项
    reopened = make_service(tmp_path)
    assert gov.status(reopened.root)["active_issues"] == 1
    for target in (service, reopened):
        # 普通固定读取
        with pytest.raises(ValueError, match="USAGE_SUSPENDED"):
            target.read(a["product_id"], snapshot_id=first_sid)
        # 整产品固定页（含分页/旧游标）
        with pytest.raises(ValueError, match="USAGE_SUSPENDED"):
            target.read_product_page(a["product_id"], snapshot_id=first_sid)
        # 选定行固定页
        with pytest.raises(ValueError, match="USAGE_SUSPENDED"):
            target.read_page(a["product_id"], snapshot_id=first_sid,
                             record_refs=[{"record_id": "row-series_a", "record_version": old_version}])
    # 普通机器查询的 _iter_query_batches → read_product_page 优化旁路也不能绕过
    with pytest.raises(ValueError, match="USAGE_SUSPENDED"):
        list(reopened._iter_query_batches(a["product_id"], snapshot_id=first_sid))
    # 未受影响系列保持可正式读取，证明不扩改
    other = next(item for item in first["output_results"] if item["output_key"] == "series_b")
    assert len(reopened.read(other["product_id"], snapshot_id=first_sid)["rows"]) == 1
    # 显式审计复现：旧内容 + 已知问题说明，明确不可发布/计算
    reopened._usage_audit_issue_id = "case-A"
    try:
        audit = reopened.read(a["product_id"], snapshot_id=first_sid)
    finally:
        reopened._usage_audit_issue_id = None
    governance = audit["usage_governance"]
    assert governance["audit_reproduction"] is True
    assert governance["publishable"] is False and governance["compute_eligible"] is False
    assert any(item["issue_id"] == "case-A" for item in governance["known_issues"])
    assert any(note.get("code") == "USAGE_KNOWN_ISSUE" for note in audit["diagnostics"])
    assert audit["rows"][0]["row"]["value_decimal"] == "10"
    # 错误事项编号不符的审计不能绕过
    reopened._usage_audit_issue_id = "case-B"
    try:
        with pytest.raises(ValueError, match="AUDIT_ISSUE_MISMATCH"):
            reopened.read(a["product_id"], snapshot_id=first_sid)
    finally:
        reopened._usage_audit_issue_id = None


def test_unauthorized_repair_denied_and_precise_predecessor_revision(tmp_path):
    service = make_service(tmp_path)
    first, first_sid, a, b = publish_two_series(service, tmp_path)
    old_version = a["records"][0]["record_version"]
    scopes = [{"product_id": a["product_id"], "snapshot_id": first_sid,
               "record_versions": [old_version]}]
    issue(service.root, "case-A", scopes)
    doc = revised_doc(first, a["product_id"], first_sid, old_version, value="11")
    # 未批准：WFD submit 边界在 writer_lock 内拒绝，不产生第二个快照
    with pytest.raises(ValueError, match="USAGE_SUSPENDED_REPAIR_NOT_AUTHORIZED"):
        service.submit(doc)
    assert service.snapshot_status()["snapshot_id"] == first_sid
    # 冻结摘要改变（文档变了）也不能借用已授权票据
    ticket(service.root, "case-A", doc, previous_refs(doc))
    changed = copy.deepcopy(doc)
    changed["outputs"][0]["payload"]["rows"][0]["value_decimal"] = "12"
    with pytest.raises(ValueError, match="USAGE_SUSPENDED_REPAIR_NOT_AUTHORIZED"):
        service.submit(changed)
    # 授权后精确前驱修订发布
    result = service.submit(doc)
    assert result["state"] == "published_formal", result
    new_sid = result["snapshot_id"]
    assert new_sid != first_sid
    repaired = next(item for item in result["output_results"] if item["output_key"] == "series_a")
    assert repaired["records"][0]["record_version"] != old_version
    # 新快照固定读回更正值；旧快照审计复现仍是原值且带已知问题
    with pytest.raises(ValueError, match="USAGE_SUSPENDED"):
        service.read(a["product_id"], snapshot_id=first_sid)
    # 业务读取新快照不受限（新版本不在暂停范围内）
    current = service.read(a["product_id"], snapshot_id=new_sid)
    assert current["rows"][0]["row"]["value_decimal"] == "11"
    assert current["rows"][0]["revision"]["supersedes"] == old_version
    # 未受影响系列正式版本保持不变
    still = service.read(b["product_id"], snapshot_id=new_sid)
    assert still["rows"][0]["row"]["value_decimal"] == "20"
    # 旧快照仅显式审计可复现，且说明永久保留
    service._usage_audit_issue_id = "case-A"
    try:
        old = service.read(a["product_id"], snapshot_id=first_sid)
    finally:
        service._usage_audit_issue_id = None
    assert old["rows"][0]["row"]["value_decimal"] == "10"
    # 并发前驱过时：再用同一前驱提交第二份修订，WFD 锁内拒绝
    stale = copy.deepcopy(doc)
    stale["request_identity"]["request_id"] = "repair-stale"
    stale["outputs"][0]["payload"]["rows"][0]["value_decimal"] = "13"
    from wfd_sdk import usage_suspension
    usage_suspension.authorize_repair(service.root, {
        "ticket_id": "ticket-stale", "issue_id": "case-A",
        "document_digest": sha(canonical(stale)), "request_identity": stale["request_identity"],
        "revisions": previous_refs(stale), "confirmation_digest": sha(canonical(stale)),
        "repair_mode": "processing_repair", "error_binding_digest": "sha256:" + "b" * 64,
        "impact_digest": "sha256:" + "c" * 64,
        "budget": {"max_rows": 10, "max_document_bytes": 786432, "series_count": 2}})
    # 旧父快照的并发提交先被 PARENT_CHANGED 拒绝
    stale_result = service.submit(stale)
    assert stale_result["state"] == "rejected"
    assert any(error["code"] == "PARENT_CHANGED" for error in stale_result["errors"]), stale_result
    # 把父快照推进到新 HEAD、但精确前驱仍是旧叶：WFD 锁内拒绝过时前驱
    advanced = copy.deepcopy(doc)
    advanced["request_identity"]["request_id"] = "repair-stale-advanced"
    advanced["expected_parent_snapshot_id"] = new_sid
    advanced["outputs"][0]["payload"]["rows"][0]["value_decimal"] = "14"
    gov.authorize_repair(service.root, {
        "ticket_id": "ticket-stale-advanced", "issue_id": "case-A",
        "document_digest": sha(canonical(advanced)), "request_identity": advanced["request_identity"],
        "revisions": previous_refs(advanced), "confirmation_digest": sha(canonical(advanced)),
        "repair_mode": "processing_repair", "error_binding_digest": "sha256:" + "b" * 64,
        "impact_digest": "sha256:" + "c" * 64,
        "budget": {"max_rows": 10, "max_document_bytes": 786432, "series_count": 2}})
    stale_advanced = service.submit(advanced)
    assert stale_advanced["state"] == "registered_not_published", stale_advanced
    assert any(error["code"] == "REVISION_STALE_PREDECESSOR"
               for output in stale_advanced["output_results"] for error in output.get("errors", [])), stale_advanced
    assert service.snapshot_status()["snapshot_id"] == new_sid, "不得产生第二次正式替代"
    # 重复请求冲突：同一 request_identity 换内容不得改写已发布结果
    conflicting = copy.deepcopy(doc)
    conflicting["outputs"][0]["payload"]["rows"][0]["value_decimal"] = "99"
    replay = service.submit(conflicting)
    assert replay["state"] == "rejected" and any(
        error["code"] == "REQUEST_ID_CONFLICT" for error in replay["errors"]), replay
    # 解决事项不解除旧错误版本的已知问题与限制
    resolution = usage_suspension.resolve(service.root, {
        "issue_id": "case-A", "ticket_id": "ticket:case-A",
        "document_digest": sha(canonical(doc)), "replacement_snapshot_id": new_sid,
        "replacement_record_versions": [repaired["records"][0]["record_version"]],
        "verification_digest": "sha256:" + "e" * 64,
        "verified_at_utc": "2026-11-07T01:00:00Z"})
    assert resolution["legacy_restrictions_retained"] is True
    with pytest.raises(ValueError, match="USAGE_KNOWN_ISSUE_LEGACY"):
        service.read(a["product_id"], snapshot_id=first_sid)


def test_multiple_issues_require_all_tickets_and_close_independently(tmp_path):
    service = make_service(tmp_path)
    first, first_sid, a, b = publish_two_series(service, tmp_path)
    version_a = a["records"][0]["record_version"]
    scope = [{"product_id": a["product_id"], "snapshot_id": first_sid, "record_versions": [version_a]}]
    issue(service.root, "case-A", scope)
    issue(service.root, "case-B", scope)
    doc = revised_doc(first, a["product_id"], first_sid, version_a, value="11")
    ticket(service.root, "case-A", doc, previous_refs(doc), ticket_id="t-A")
    # 只有 case-A 票据：不能越过仍在生效的 case-B
    with pytest.raises(ValueError, match="USAGE_SUSPENDED_REPAIR_NOT_AUTHORIZED:every matched issue"):
        service.submit(doc)
    # 两个事项都授权后，精确前驱修订才能发布
    ticket(service.root, "case-B", doc, previous_refs(doc), ticket_id="t-B")
    result = service.submit(doc)
    assert result["state"] == "published_formal", result
    new_sid = result["snapshot_id"]
    repaired = result["output_results"][0]["records"][0]["record_version"]
    # 事项 A 关闭后事项 B 仍单独限制旧错误版本
    resolved_a = gov.resolve(service.root, {"issue_id": "case-A", "ticket_id": "t-A",
        "document_digest": sha(canonical(doc)), "replacement_snapshot_id": new_sid,
        "replacement_record_versions": [repaired], "verification_digest": "sha256:" + "a" * 64,
        "verified_at_utc": "2026-11-07T01:00:00Z"})
    assert resolved_a["state"] == "resolved"
    with pytest.raises(ValueError, match="USAGE_SUSPENDED:case-B"):
        service.read(a["product_id"], snapshot_id=first_sid)
    assert gov.status(service.root)["active_issues"] == 1
    # 事项 B 用同一真实发布回执关闭；旧错误版本永久保留已知问题
    resolved_b = gov.resolve(service.root, {"issue_id": "case-B", "ticket_id": "t-B",
        "document_digest": sha(canonical(doc)), "replacement_snapshot_id": new_sid,
        "replacement_record_versions": [repaired], "verification_digest": "sha256:" + "b" * 64,
        "verified_at_utc": "2026-11-07T01:00:00Z"})
    assert resolved_b["state"] == "resolved"
    assert gov.status(service.root)["active_issues"] == 0
    with pytest.raises(ValueError, match="USAGE_KNOWN_ISSUE_LEGACY"):
        service.read(a["product_id"], snapshot_id=first_sid)
    # 未受影响系列原版本仍可读
    assert len(service.read(b["product_id"], snapshot_id=first_sid)["rows"]) == 1


def test_restriction_follows_record_version_across_snapshots(tmp_path):
    service = make_service(tmp_path)
    first, first_sid, a, b = publish_two_series(service, tmp_path)
    version_a = a["records"][0]["record_version"]
    issue(service.root, "case-A", [{"product_id": a["product_id"], "snapshot_id": first_sid,
                                   "record_versions": [version_a]}])
    # 无关系列 B 的正式修订推进 HEAD；A 的 revision_id 原样保留。
    b_doc = revised_named_doc(first, "series_b", "correction.series.b", b["product_id"], first_sid,
                              b["records"][0]["record_version"], value="21", request_id="unrelated-B")
    b_result = service.submit(b_doc)
    assert b_result["state"] == "published_formal", b_result
    new_sid = b_result["snapshot_id"]
    # 新快照仍携带同一错误 revision_id；只允许显式审计复现，默认读取被拒绝。
    service._usage_audit_issue_id = "case-A"
    try:
        a_read = service.read(a["product_id"], snapshot_id=new_sid)
    finally:
        service._usage_audit_issue_id = None
    assert a_read["rows"][0]["record_ref"]["revision_id"] == version_a
    assert a_read["usage_governance"]["publishable"] is False
    # 同一错误记录版本跨快照仍被限制；旧快照也仍受限。
    for sid in (first_sid, new_sid):
        with pytest.raises(ValueError, match="USAGE_SUSPENDED:case-A"):
            service.read(a["product_id"], snapshot_id=sid)
    # 无关 B 的新值正常可读
    assert service.read(b["product_id"], snapshot_id=new_sid)["rows"][0]["row"]["value_decimal"] == "21"
    # 正式替代 A 后才允许新版本读取，旧版本继续保留已知问题
    a_doc = revised_doc(first, a["product_id"], first_sid, version_a, value="11", request_id="repair-A")
    a_doc["expected_parent_snapshot_id"] = new_sid
    a_doc["request_identity"]["submission_digest"] = "sha256:" + sha(canonical(a_doc)).ljust(64, "0")[:64]
    ticket(service.root, "case-A", a_doc, previous_refs(a_doc))
    a_result = service.submit(a_doc)
    assert a_result["state"] == "published_formal", a_result
    repaired_sid = a_result["snapshot_id"]
    repaired_version = a_result["output_results"][0]["records"][0]["record_version"]
    current = service.read(a["product_id"], snapshot_id=repaired_sid)
    assert current["rows"][0]["row"]["value_decimal"] == "11"
    assert current["rows"][0]["revision"]["supersedes"] == version_a
    with pytest.raises(ValueError, match="USAGE_SUSPENDED"):
        service.read(a["product_id"], snapshot_id=first_sid)
    gov.resolve(service.root, {"issue_id": "case-A", "ticket_id": "ticket:case-A",
        "document_digest": sha(canonical(a_doc)), "replacement_snapshot_id": repaired_sid,
        "replacement_record_versions": [repaired_version], "verification_digest": "sha256:" + "c" * 64,
        "verified_at_utc": "2026-11-07T01:00:00Z"})
    with pytest.raises(ValueError, match="USAGE_KNOWN_ISSUE_LEGACY"):
        service.read(a["product_id"], snapshot_id=first_sid)


def test_resolution_requires_actual_publication_and_exact_replacement(tmp_path):
    service = make_service(tmp_path)
    first, first_sid, a, b = publish_two_series(service, tmp_path)
    version_a = a["records"][0]["record_version"]
    issue(service.root, "case-A", [{"product_id": a["product_id"], "snapshot_id": first_sid,
                                   "record_versions": [version_a]}])
    doc = revised_doc(first, a["product_id"], first_sid, version_a, value="11")
    ticket(service.root, "case-A", doc, previous_refs(doc))
    # 未发布/伪造快照与版本不能解决，HEAD 不变。
    with pytest.raises(ValueError, match="USAGE_RESOLUTION"):
        gov.resolve(service.root, {"issue_id": "case-A", "ticket_id": "ticket:case-A",
            "document_digest": sha(canonical(doc)),
            "replacement_snapshot_id": "s_never_published",
            "replacement_record_versions": ["r_never_published"],
            "verification_digest": "sha256:" + "d" * 64,
            "verified_at_utc": "2026-11-07T01:00:00Z"})
    assert service.snapshot_status()["snapshot_id"] == first_sid
    assert gov.status(service.root)["active_issues"] == 1
    # 真实发布后，错版本/错声明仍不能解决。
    result = service.submit(doc)
    assert result["state"] == "published_formal", result
    new_sid = result["snapshot_id"]
    repaired = result["output_results"][0]["records"][0]["record_version"]
    with pytest.raises(ValueError, match="USAGE_RESOLUTION"):
        gov.resolve(service.root, {"issue_id": "case-A", "ticket_id": "ticket:case-A",
            "document_digest": sha(canonical(doc)), "replacement_snapshot_id": new_sid,
            "replacement_record_versions": ["r_wrong"],
            "verification_digest": "sha256:" + "e" * 64,
            "verified_at_utc": "2026-11-07T01:00:00Z"})
    assert gov.status(service.root)["active_issues"] == 1
    resolved = gov.resolve(service.root, {"issue_id": "case-A", "ticket_id": "ticket:case-A",
        "document_digest": sha(canonical(doc)), "replacement_snapshot_id": new_sid,
        "replacement_record_versions": [repaired],
        "verification_digest": "sha256:" + "f" * 64,
        "verified_at_utc": "2026-11-07T01:00:00Z"})
    assert resolved["state"] == "resolved"
    assert resolved["legacy_restrictions_retained"] is True


def append_b_doc(first, sid, b):
    """无 revisions 的普通追加：B 产品新行，不动 A 的错误记录版本。"""
    candidate = copy.deepcopy(scalar_output("series_b", "correction.series.b", "22"))
    candidate.update(definition_mode="reuse", definition_ref=copy.deepcopy(b["definition_ref"]),
                     definition=None, input_mode="partial_observation")
    candidate["payload"]["rows"][0]["business_key"] = "row-series_b-2"
    doc = request([candidate], "synthetic-unaffected-B-append", parent=sid)
    doc["request_identity"]["submission_digest"] = "sha256:" + sha(canonical(doc)).ljust(64, "0")[:64]
    return doc


def test_unaffected_ordinary_append_is_not_blocked_by_other_product(tmp_path):
    service = make_service(tmp_path)
    first, sid, a, b = publish_two_series(service, tmp_path)
    issue(service.root, "case-A-append", [{"product_id": a["product_id"], "snapshot_id": sid,
        "record_versions": [a["records"][0]["record_version"]]}])
    doc = append_b_doc(first, sid, b)
    assert not doc["outputs"][0].get("revisions")
    result = service.submit(doc)
    assert result["state"] == "published_formal", result
    new_sid = result["snapshot_id"]
    rows = service.read(b["product_id"], snapshot_id=new_sid)["rows"]
    assert {row["record_ref"]["logical_key"] for row in rows} == {"row-series_b", "row-series_b-2"}
    # A 的错误版本仍被限制，且 B 的普通追加没有解除事项。
    with pytest.raises(ValueError, match="USAGE_SUSPENDED:case-A-append"):
        service.read(a["product_id"], snapshot_id=new_sid)
    assert gov.status(service.root)["active_issues"] == 1


def test_row_version_object_mode_releases_real_verified_replacement(tmp_path):
    from wfd_sdk import row_version_objects
    service = make_service(tmp_path)
    row_version_objects.adopt_writing(service.engine, identity="correction-row-version-test",
        expected_snapshot_id=None, adopted_at_utc="2026-11-07T00:00:00Z")
    assert row_version_objects.writing_enabled(service.root, service.engine.runtime_root)
    first, sid, a, b = publish_two_series(service, tmp_path)
    version = a["records"][0]["record_version"]
    issue(service.root, "case-obj", [{"product_id": a["product_id"], "snapshot_id": sid,
        "record_versions": [version]}])
    doc = revised_doc(first, a["product_id"], sid, version, value="11", request_id="object-mode-repair")
    ticket(service.root, "case-obj", doc, previous_refs(doc), ticket_id="ticket:case-obj")
    result = service.submit(doc)
    assert result["state"] == "published_formal", result
    new_sid = result["snapshot_id"]
    repaired = result["output_results"][0]["records"][0]["record_version"]
    raw = json.loads((service.root / "catalog/snapshots" / (new_sid + ".json")).read_text("utf-8"))
    assert any(isinstance(entry.get("source_bundle", {}).get("_wfd_row_versions"), str)
               for entry in raw["files"])
    resolved = gov.resolve(service.root, {"issue_id": "case-obj", "ticket_id": "ticket:case-obj",
        "document_digest": sha(canonical(doc)), "replacement_snapshot_id": new_sid,
        "replacement_record_versions": [repaired], "verification_digest": "sha256:" + "a" * 64,
        "verified_at_utc": "2026-11-07T01:00:00Z"})
    assert resolved["state"] == "resolved"


def test_missing_governance_file_is_not_silently_empty(tmp_path):
    service = make_service(tmp_path)
    first, sid, a, b = publish_two_series(service, tmp_path)
    issue(service.root, "case-lost", [{"product_id": a["product_id"], "snapshot_id": sid,
        "record_versions": [a["records"][0]["record_version"]]}])
    path = service.root / "catalog/usage_suspensions.json"
    assert path.is_file()
    retained = path.with_suffix(".before-loss")
    path.replace(retained)
    reopened = make_service(tmp_path)
    with pytest.raises(ValueError, match="USAGE_GOVERNANCE_MISSING"):
        gov.status(reopened.root)
    with pytest.raises(ValueError, match="USAGE_GOVERNANCE_MISSING"):
        reopened.read(a["product_id"], snapshot_id=sid)
    assert retained.is_file()


def test_governance_declarations_are_idempotent_and_conflict_aware(tmp_path):
    service = make_service(tmp_path)
    first, sid, a, b = publish_two_series(service, tmp_path)
    version = a["records"][0]["record_version"]
    scope = [{"product_id": a["product_id"], "snapshot_id": sid, "record_versions": [version]}]
    first_issue = issue(service.root, "case-idem", scope)
    second_issue = issue(service.root, "case-idem", scope)
    assert second_issue["idempotent"] is True
    assert second_issue["issue_digest"] == first_issue["issue_digest"]
    assert len(gov.status(service.root)["issues"]) == 1
    with pytest.raises(ValueError, match="USAGE_ISSUE_DUPLICATE"):
        gov.suspend(service.root, {"issue_id": "case-idem", "error_type": "mapping_error",
            "reason": "different declaration", "evidence_digest": "sha256:" + "a" * 64,
            "error_binding_digest": "sha256:" + "b" * 64, "impact_digest": "sha256:" + "c" * 64,
            "declared_at_utc": "2026-11-07T00:00:00Z", "scopes": scope})
    doc = revised_doc(first, a["product_id"], sid, version, value="11")
    first_ticket = ticket(service.root, "case-idem", doc, previous_refs(doc), ticket_id="ticket-idem")
    second_ticket = ticket(service.root, "case-idem", doc, previous_refs(doc), ticket_id="ticket-idem")
    assert second_ticket["idempotent"] is True
    assert second_ticket["ticket_digest"] == first_ticket["ticket_digest"]
    assert len(gov.status(service.root)["tickets"]) == 1
    changed = copy.deepcopy(doc)
    changed["outputs"][0]["payload"]["rows"][0]["value_decimal"] = "12"
    with pytest.raises(ValueError, match="USAGE_TICKET_DUPLICATE"):
        gov.authorize_repair(service.root, {"ticket_id": "ticket-idem", "issue_id": "case-idem",
            "document_digest": sha(canonical(changed)), "request_identity": changed["request_identity"],
            "revisions": previous_refs(changed), "confirmation_digest": sha(canonical(changed)),
            "repair_mode": "processing_repair", "error_binding_digest": "sha256:" + "b" * 64,
            "impact_digest": "sha256:" + "c" * 64,
            "budget": {"max_rows": 10, "max_document_bytes": 786432, "series_count": 2}})


def test_product_identity_uses_subject_not_only_definition_digest(tmp_path):
    service = make_service(tmp_path)
    a = scalar_output("series_a", "correction.identity.shared", "10")
    b = copy.deepcopy(scalar_output("series_b", "correction.identity.shared", "20"))
    b["subject"]["id"] = "object_2"
    assert a["definition"] == b["definition"] and a["subject"] != b["subject"]
    first = service.submit(request([a, b], "identity-original"))
    assert first["state"] == "published_formal", first
    indexed = {item["output_key"]: item for item in first["output_results"]}
    sid = first["snapshot_id"]
    a_product, b_product = indexed["series_a"], indexed["series_b"]
    assert a_product["product_id"] != b_product["product_id"]
    assert a_product["definition_ref"] == b_product["definition_ref"]
    issue(service.root, "identity-case-A", [{"product_id": a_product["product_id"],
        "snapshot_id": sid, "record_versions": [a_product["records"][0]["record_version"]]}])
    # 相同 definition_ref、不同 subject 的 B 普通复用新增：只解析到 B，不能被 A 扩大禁止。
    candidate = copy.deepcopy(b)
    candidate.update(definition_mode="reuse", definition_ref=copy.deepcopy(b_product["definition_ref"]),
                     definition=None, input_mode="partial_observation")
    candidate["payload"]["rows"][0].update(business_key="row-series_b-2", value_decimal="22")
    doc = request([candidate], "identity-B-append", parent=sid)
    assert not doc["outputs"][0].get("revisions")
    assert gov._product_ids_for_submit(service.root, doc["outputs"], []) == {b_product["product_id"]}
    result = service.submit(doc)
    assert result["state"] == "published_formal", result
    assert {x["record_ref"]["logical_key"] for x in
            service.read(b_product["product_id"], snapshot_id=result["snapshot_id"])["rows"]} == {
                "row-series_b", "row-series_b-2"}
    with pytest.raises(ValueError, match="USAGE_SUSPENDED:identity-case-A"):
        service.read(a_product["product_id"], snapshot_id=result["snapshot_id"])
    # 相同 subject/definition 的 create 新增必须解析到权威 A，不得用猜出的新键绕过。
    same = copy.deepcopy(a)
    same["payload"]["rows"][0].update(business_key="row-series_a-2", value_decimal="11")
    same_doc = request([same], "identity-A-create", parent=result["snapshot_id"])
    assert gov._product_ids_for_submit(service.root, same_doc["outputs"], []) == {a_product["product_id"]}
    with pytest.raises(ValueError, match="USAGE_SUSPENDED_REPAIR_NOT_AUTHORIZED"):
        service.submit(same_doc)


def test_multirow_resolve_replay_is_order_insensitive(tmp_path):
    service = make_service(tmp_path)
    first, sid, a, b = publish_two_series(service, tmp_path)
    va, vb = a["records"][0]["record_version"], b["records"][0]["record_version"]
    issue(service.root, "case-multi", [
        {"product_id": a["product_id"], "snapshot_id": sid, "record_versions": [va]},
        {"product_id": b["product_id"], "snapshot_id": sid, "record_versions": [vb]}])
    out_a = copy.deepcopy(scalar_output("series_a", "correction.series.a", "11"))
    out_a.update(definition_mode="reuse", definition_ref=copy.deepcopy(a["definition_ref"]),
                 definition=None, input_mode="processing_repair")
    out_a["revisions"] = {"row-series_a": {"previous": {"product_id": a["product_id"],
        "snapshot_id": sid, "logical_key": "row-series_a", "revision_id": va}, "reason": "synthetic multirow correction"}}
    out_b = copy.deepcopy(scalar_output("series_b", "correction.series.b", "21"))
    out_b.update(definition_mode="reuse", definition_ref=copy.deepcopy(b["definition_ref"]),
                 definition=None, input_mode="processing_repair")
    out_b["revisions"] = {"row-series_b": {"previous": {"product_id": b["product_id"],
        "snapshot_id": sid, "logical_key": "row-series_b", "revision_id": vb}, "reason": "synthetic multirow correction"}}
    doc = request([out_a, out_b], "multirow-repair", parent=sid)
    doc["request_identity"]["submission_digest"] = "sha256:" + sha(canonical(doc)).ljust(64, "0")[:64]
    ticket(service.root, "case-multi", doc, previous_refs(doc), ticket_id="ticket:case-multi")
    result = service.submit(doc)
    assert result["state"] == "published_formal", result
    versions = [item["records"][0]["record_version"] for item in result["output_results"]]
    declaration = {"issue_id": "case-multi", "ticket_id": "ticket:case-multi",
        "document_digest": sha(canonical(doc)), "replacement_snapshot_id": result["snapshot_id"],
        "replacement_record_versions": list(reversed(versions)),
        "verification_digest": "sha256:" + "a" * 64, "verified_at_utc": "2026-11-07T01:00:00Z"}
    first_resolve = gov.resolve(service.root, declaration)
    assert first_resolve["state"] == "resolved"
    replay = gov.resolve(service.root, {**declaration, "replacement_record_versions": list(versions)})
    assert replay["state"] == "resolved" and replay["idempotent"] is True
    assert replay["resolution"]["replacement_record_versions"] == sorted(versions)
