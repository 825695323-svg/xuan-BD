#!/usr/bin/env python3
"""Public local process boundary for the WFD product service.

The adapter is deliberately thin: every business decision remains in
``WFDProductService``.  This module only reads one bounded JSON request from
stdin, builds the service from a trusted constructor configuration supplied on
the command line, and writes one JSON response to stdout.

The request may choose an operation and its fixed arguments.  It can never
grant itself a caller role, a trusted actor namespace, a source permission, a
unit definition, a store or a runtime root; those come only from the trusted
configuration file.  The entry is bounded: submit/recovery and batch finalize
call the existing public service, query uses the existing ProductQuery, and
package/export operations remain unsupported until their contracts exist.
"""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

MACHINE_PROTOCOL = "wfd.product-machine/0.1"
MACHINE_CONFIG_PROTOCOL = "wfd.product-machine-config/0.1"
PROFILES = {"legacy", "data_only"}
CONTEXT_QUERY_OPERATIONS = ("read_company_context", "read_relation_graph",
                            "read_applicable_rules", "read_event_timeline")
QUERY_MACHINE_OPERATIONS = ("read_product",) + CONTEXT_QUERY_OPERATIONS
FIXED_PAGE_OPERATIONS = {"fixed_read_page", "fixed_read_product_page"}
DATA_ONLY_OPERATIONS = {"capabilities", "service_capabilities", "schema",
                        "contract_discovery", "snapshot_status", "review_definition", "fixed_read", "fixed_read_page", "fixed_read_product_page", "submit",
                        "request_status", "recovery", "query_capabilities",
                        "resolve_write_target", "register_write_target",
                        "resolve_adjustment_anchor", "register_adjustment_anchor",
                        "read_product", "filter_objects", "batch_begin", "batch_put_chunk",
                        "batch_status", "batch_finalize", "batch_read_page",
                        "usage_status", "usage_audit_read", "usage_suspend",
                        "usage_authorize_repair", "usage_resolve",
                        *CONTEXT_QUERY_OPERATIONS}
# 正式用途治理：只暴露给 data_only；写操作要求 publish 且复用 WFD writer_lock。
USAGE_OPERATIONS = {"usage_status", "usage_audit_read", "usage_suspend",
                    "usage_authorize_repair", "usage_resolve"}
USAGE_WRITE_OPERATIONS = {"usage_suspend", "usage_authorize_repair", "usage_resolve"}
DATA_ONLY_CALLER_ROLES = {"read", "register", "submit", "publish"}
MAX_INPUT_BYTES = 1_048_576
MAX_OUTPUT_BYTES = 33_554_432
REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
CONNECTION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
MACHINE_ROLES = {"read", "read_evidence", "evidence_write", "register", "submit",
                 "compute", "publish"}
BATCH_PHASES = {"collecting", "ready", "finalizing", "finalized",
                "finalized_pending", "finalized_partial", "finalized_sandbox",
                "submit_unknown", "rejected"}
WRITE_OPERATIONS = {"submit", "recovery", "evidence_ingest",
                    "batch_begin", "batch_put_chunk", "batch_finalize",
                    "register_write_target", "register_adjustment_anchor",
                    *USAGE_WRITE_OPERATIONS}
# Operations whose results carry one entry per output and therefore need a
# bounded, pageable view when the configured response budget is smaller than
# the full service result.
PAGED_OPERATIONS = {"submit", "recovery", "request_status", "batch_finalize"}
DEFAULT_OUTPUT_PAGE = 50
MAX_OUTPUT_PAGE = 200
EXPOSED_INNER_QUERY_OPERATIONS = QUERY_MACHINE_OPERATIONS

SUPPORTED = {
    "capabilities": "机器入口、服务、查询与批处理能力；版本字段取自当前运行服务。",
    "service_capabilities": "原样返回当前 WFDProductService.capabilities()，含真实 schema 闭包。",
    "schema": "返回当前 ingest/query schema 身份与摘要，不返回未完成的规则。",
    "contract_discovery": "按固定 snapshot_id 发现实际产品与已绑定合同。",
    "review_definition": "只读受理定义意向；按当前固定快照退回缺少的产品族或字段，正式准入仍由 submit 执行。",
    "snapshot_status": "data_only：只读核对已打开实例的权威活动快照；仅确认合法初始化空库时返回 null。",
    "fixed_read": "按固定 snapshot_id 读取真实产品行；system_held_at 必须带 held_scope/usable_stage/at，不使用 latest/current。",
    "fixed_read_page": "data_only：固定snapshot/product与唯一record_refs的有界SQL页；仅无日历资格scalar_rows，不改变fixed_read。",
    "fixed_read_product_page": "data_only：固定snapshot/product整产品唯一当前非撤销叶的有界SQL页；仅无日历资格scalar_rows。",
    "submit": "经 WFDProductService.submit 做同服务 schema/来源/合同/权限校验，返回逐输出结果；超出响应上限时返回有界状态摘要与续读位置。",
    "resolve_write_target": "只读查询数据集的正式写入目标绑定：bound/never_registered/family_without_target/conflict/query_failed；不从相似度自动选中既有产品。",
    "register_write_target": "显式登记或改绑正式写入目标（产品族+产品+定义版本）；不隐式改绑，写前核登记与发布双权限。",
    "resolve_adjustment_anchor": "只读解析复权锚点引用：存在/撤回、版本与摘要、数据集与主体范围、方法、适用区间、版本适用性；不合规时返回具体码而不改写任何东西。",
    "register_adjustment_anchor": "显式登记一版复权锚点（方法、基准时点、基准价格来源、适用区间、公司行动截止）；只追加，旧版本永不改写，写前核登记与发布双权限。",
    "request_status": "按原 request_identity 读回持久状态与恢复动作；可用 output_offset/output_limit/output_detail 分页读取逐输出结果。",
    "recovery": "按同一 request_identity 和原文档重试；幂等重放不产生第二个快照。",
    "evidence_ingest": "接收被配置允许的内容字节并交给既有 custody 机制，不接受本机路径。",
    "trace": "读取固定定义、合同与已保管证据核验位置。",
    "query_capabilities": "动态返回 ProductQuery.capabilities()；data_only 公开 read_product 与四个有界上下文操作。",
    "read_product": "经 ProductQuery.execute 做固定快照、字段、分页与资源预算读取；inner operation 必须与外层一致。",
    "filter_objects": "固定快照、受信字段绑定的多对象与受限复合Decimal筛选；兼容1.4-candidate；业务库只读。",
    "read_company_context": "data_only：读取公司相关身份、财务/行情/关系/事件上下文；只返回 WFD 数据与记录/版本身份。",
    "read_relation_graph": "data_only：最多三层、有界的固定历史资格关系读取；未知/未来资格不扩展身份集合。",
    "read_applicable_rules": "data_only：有限主体/市场、有效期、历史资格与冲突并列；不提供优先级/例外解释器。",
    "read_event_timeline": "data_only：计划与实际事件按 content_nature/status 分开，不合并。",
    "batch_begin": "data_only：固定 structured-ingest header（rows 为空）与 expected_chunks；台账只写可信 native runtime。",
    "batch_put_chunk": "data_only：结构化行分块；乱序/重传幂等/异内容冲突/行字节预算与旧账本一致。",
    "batch_status": "data_only：只返回阶段、接收/缺失/预算摘要；长块列表有界分页，不重复完整 submit 结果。",
    "batch_finalize": "data_only：按声明顺序组装同原文档并经同一 service.submit 封存；大输出沿 request_status 分页续读。",
    "batch_read_page": "data_only 卷：按固定原报分钟分区及摘要分页读回。",
    "usage_status": "只读列出 WFD catalog 中持久的用途暂停事项、修复票据与解决说明；每次从磁盘重核，不缓存。",
    "usage_audit_read": "显式指定事项编号的审计/技术固定复现：返回带已知问题诊断的旧固定内容，结果明确不可发布、不可计算。",
    "usage_suspend": "正式登记用途暂停事项（错误类型、原因、证据摘要、精确产品/快照/记录版本范围）；与 submit 共用 writer_lock。",
    "usage_authorize_repair": "宿主在真实任务审批通过后签发精确修复票据：绑定不可变文档摘要、原请求身份、精确前驱集合与确认摘要。",
    "usage_resolve": "按已核验的新版本追加解决说明；旧已知错误版本的已知问题与限制永久保留，多事项限制叠加。",
}
UNSUPPORTED = {
    "packages": "P5 包合同尚未完成；不支持导入/导出金融产品包。",
    "export": "导出需要 P3/P5 的独立来源与调用者授权，本入口不开放。",
    "redistribute": "再分发未获授权，本入口不开放。",
    "company_view": "legacy 机器入口不公开上下文查询；data_only 使用显式 read_company_context 等操作。",
    "calendar_read": "日历专用读取尚未纳入本批公开进程边界；可用 fixed_read + product_id 读取，后续按 P3 合同补充。",
    "query_graph": "legacy 机器入口不公开通用 graph；data_only 使用显式 read_relation_graph，不接受 read_product 旁路。",
}

_CODE_PREFIX = re.compile(r"^([A-Z][A-Z0-9_]{2,})(?::|$)")


def _issue(code, message, *, action, request_id=None, operation=None, identity=None,
           service=None, cause=None, details=None):
    return {
        "code": code,
        "message": message,
        "action": action,
        "request_id": request_id,
        "operation": operation,
        "identity": identity,
        "service": service,
        "cause": cause,
        "details": details,
        "retryable": False,
    }


def _action_for(code):
    if code.startswith("SOURCE_READ_PERMISSION_MISSING"):
        return "请由受控连接配置为实际来源显式授予 may_read/may_read_evidence；请求不能自行授予权限。"
    if code.startswith("CALLER_PERMISSION_DENIED"):
        return "请由受控连接配置为实际调用者授予所需角色；请求不能自行授予权限。"
    if code == "SOURCE_NOT_ADMITTED":
        return "该来源未在受控连接中登记；请核对实际来源身份，不要用请求自述扩权。"
    if code == "FIXED_SNAPSHOT_REQUIRED":
        return "请提供实际固定 snapshot_id；不接受 latest/current，也不扫描私有 catalog。"
    if code == "HISTORICAL_CUTOFF_REQUIRED":
        return "历史视角必须同时提供明确 at=YYYY-MM-DDTHH:MM:SSZ 截止时刻。"
    if code == "UNSUPPORTED_READ_PERSPECTIVE":
        return "视角只能是 snapshot_contents、market_known_at 或 system_held_at。"
    if code in {"PRODUCT_NOT_FOUND", "PRODUCT_METADATA_NOT_AVAILABLE"}:
        return "请先通过 contract_discovery 核对固定快照中的实际产品；不要猜测产品编号。"
    if code == "PRODUCT_SERVICE_VERSION_UNSUPPORTED":
        return "当前运行服务不支持该扩展版本；请以 capabilities 返回的实际版本为准。"
    if code == "OPERATION_UNSUPPORTED":
        return "该操作不在本批公开进程边界内；请使用 capabilities 列出的操作。"
    if code == "QUERY_OPERATION_UNSUPPORTED":
        return ("query 外层与 inner operation 必须一致；data_only 公开 read_product 与四个"
                "上下文操作，不能用 read_product 旁路其它 query，也不公开 trace/BD 追溯。")
    if code in {"REQUEST_INVALID", "REQUEST_JSON_INVALID", "REQUEST_TOO_LARGE"}:
        return "请按 wfd.product-machine/0.1 发送一个 JSON 对象；权限和身份不能放在请求里。"
    if code in {"CONFIG_INVALID", "CONFIG_NOT_FOUND", "CONFIG_UNSAFE"}:
        return "请由受控连接提供绝对、受保护的配置路径；不要手改运行库或把路径写入源码。"
    if code == "SERVICE_IMPORT_FAILED":
        return "请用已安装 duckdb/jsonschema/thrift 等运行依赖的 Python 启动同一 WFD 产品开发目录。"
    if code == "RESPONSE_TOO_LARGE":
        return ("响应超过受控上限且未完整返回；请用 request_status 的 output_offset/output_limit "
                "分页读取逐输出状态（通用读取分页由 P4 后续扩展），或缩小读取范围；不要截断后声称完整读回。")
    if code == "PROCESS_OUTPUT_FAILED":
        return ("操作已经执行或可能已经执行，不能假定未写入；不要用新的 request_identity 重投，"
                "请用同一 identity 调用 request_status 查询真实状态，必要时用 recovery 同 identity 重放。")
    if code in {"SOURCE_ROLE_DENIED", "SOURCE_AUTHORITY_DENIED"}:
        return "请由受控连接为该来源配置实际 allowed_roles/allowed_authorities；请求不能自行声明角色或权威。"
    if code == "BATCH_INCOMPLETE":
        return "请补齐 status.missing 中的分块后再次 finalize；不要重复已收到的分块。"
    if code in {"BATCH_CHUNK_CONFLICT", "BATCH_ID_CONFLICT", "BATCH_REQUEST_CONFLICT"}:
        return "同一 batch/chunk/request identity 的内容不一致；按原内容重试，或使用新的 batch_id。"
    if code in {"BATCH_NOT_FOUND", "BATCH_NOT_COLLECTING"}:
        return "该 batch 不存在或已不在收集阶段；先查 batch_status，不要从零重放已封存内容。"
    if code == "BATCH_LIMIT_EXCEEDED":
        return "分块数量/行数/字节超过受控配置上限；缩小本次 batch 或由操作者调整受信 limits。"
    if code in {"READ_REQUEST_SCHEMA_INVALID", "KNOWLEDGE_CUTOFF_REQUIRED", "KNOWLEDGE_CUTOFF_UNKNOWN"}:
        return "请按 wfd.read/1.3-product1 提供固定 snapshot、字段、分页和预算；未知截止时刻不能冒充已知。"
    if code in {"FIELD_NOT_DEFINED", "FIELD_NOT_DEFINED_IN_ROW_CONTRACT"}:
        return "只能读取固定合同已声明的 value 字段；不要用 caller 字段名扩权。"
    if code in {"SCAN_BUDGET_EXCEEDED", "ROW_BUDGET_EXCEEDED"}:
        return "本次读取超过受控资源预算；缩小字段/产品范围或提高操作者配置的预算。"
    if code.startswith("ADJUSTMENT_ANCHOR_UNREGISTERED"):
        return "该复权锚点未在 catalog/product_service/adjustment_anchors 登记；先显式 register_adjustment_anchor，不要靠提交里出现摘要自动创建。"
    if code.startswith("ADJUSTMENT_ANCHOR_RETIRED"):
        return "该锚点版本已撤回；已发布数据仍按原版本解释，新写入请用当前有效版本并显式改绑目标。"
    if code.startswith("ADJUSTMENT_ANCHOR_DIGEST_MISMATCH"):
        return "引用里的 version/digest 与登记记录不一致；按已登记摘要重发引用，不要猜版本。"
    if code.startswith("ADJUSTMENT_ANCHOR_SCOPE_MISMATCH"):
        return "锚点的 dataset_id/instrument_scope 未覆盖本次主体；为这批证券登记对应锚点，不要放宽范围。"
    if code.startswith("ADJUSTMENT_ANCHOR_METHOD_MISMATCH"):
        return "声明方法与锚点方法不一致（qfq 锚点不得用于 hfq）；核对口径或登记对应方法的锚点。"
    if code.startswith("ADJUSTMENT_ANCHOR_NOT_APPLICABLE"):
        return "本批业务时点落在锚点适用区间之外（或业务时点不可判定）；核对 applicability 与业务日期。"
    if code.startswith("ADJUSTMENT_ANCHOR_VERSION_NOT_APPLICABLE"):
        return "该锚点版本已被更新版本取代；新写入只能用当前版本，改绑是显式操作。"
    if code.startswith("ADJUSTMENT_HISTORY_INELIGIBLE"):
        return "历史回放时点早于锚点的公司行动截止时点，会提前暴露未来公司行动形成的调整结果；缩小锚点截止或改用事后口径的锚点。"
    if code.startswith("WRITE_TARGET_METHOD_MISMATCH"):
        return "该写入目标的复权方法与本次声明不一致；qfq 与 hfq 是不同产品身份，需另建目标而不是复用本目标。"
    if code in {"RECOVERY_NOT_FOUND", "REQUEST_STATUS_NOT_FOUND"}:
        return "该 request_identity 尚无持久请求状态；不能以 recovery 代替首次 submit。"
    return ("请按 error.code/details 核对请求参数和受控连接配置；写操作请用同一 "
            "request_identity/batch_id 查询真实状态，不要假定未写入或换新身份重投。")


def _service_identity(service):
    try:
        caps = service.capabilities()
        structural = caps.get("structural_validation") or {}
        return {
            "format_version": caps.get("format_version"),
            "service_version": caps.get("service_version"),
            "contract_version": caps.get("contract_version"),
            "ingest_protocol": caps.get("ingest_protocol"),
            "schema_id": structural.get("schema_id") if isinstance(structural, dict) else None,
        }
    except Exception as exc:  # pragma: no cover - startup failure is reported by caller
        return {"error": type(exc).__name__ + ": " + str(exc)}


def _caller_identity(config, service):
    return {
        "caller_id": config["caller"]["caller_id"],
        "trusted_actor_namespace": config["caller"]["trusted_actor_namespace"],
        "caller_roles": sorted(service.caller_roles),
        "connection_id": config["connection_id"],
        "source_binding": "trusted constructor configuration; request cannot grant permissions",
    }


def _read_json_bounded(stream, limit):
    raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("REQUEST_TOO_LARGE")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("REQUEST_JSON_INVALID:" + str(exc)) from exc


def _require_absolute_file(path, label):
    value = Path(path)
    if not value.is_absolute():
        raise ValueError("CONFIG_INVALID:" + label + " must be absolute")
    if not value.is_file():
        raise ValueError("CONFIG_NOT_FOUND:" + label)
    real = value.resolve()
    if real != value:
        raise ValueError("CONFIG_UNSAFE:" + label + " contains a symlink or non-canonical path")
    return real


def _load_config(path):
    config_path = _require_absolute_file(path, "config")
    mode = config_path.stat().st_mode
    if mode & 0o022:
        raise ValueError("CONFIG_UNSAFE:config must not be group/world writable")
    raw = config_path.read_text("utf-8")
    if len(raw.encode("utf-8")) > 262_144:
        raise ValueError("CONFIG_INVALID:config exceeds 256 KiB")
    config = json.loads(raw)
    if not isinstance(config, dict):
        raise ValueError("CONFIG_INVALID:config must be an object")
    if config.get("protocol_version") != MACHINE_CONFIG_PROTOCOL:
        raise ValueError("CONFIG_INVALID:expected " + MACHINE_CONFIG_PROTOCOL)
    connection_id = config.get("connection_id")
    if not isinstance(connection_id, str) or not CONNECTION_ID.fullmatch(connection_id):
        raise ValueError("CONFIG_INVALID:connection_id")
    store_value = config.get("store", config.get("database"))
    runtime_value = config.get("runtime")
    project_value = config.get("project_root")
    protocol_value = config.get("protocol_root", config.get("protocol"))
    for label, value in (("store/database", store_value), ("runtime", runtime_value),
                         ("project_root", project_value), ("protocol_root/protocol", protocol_value)):
        if not isinstance(value, str) or not value:
            raise ValueError("CONFIG_INVALID:" + label)
        if not Path(value).is_absolute():
            raise ValueError("CONFIG_INVALID:" + label + " must be absolute")
    store = Path(store_value).resolve()
    runtime = Path(runtime_value).resolve()
    project_root = Path(project_value).resolve()
    protocol_root = Path(protocol_value).resolve()
    if not store.is_dir():
        raise ValueError("CONFIG_NOT_FOUND:store")
    if store == runtime or store in runtime.parents or runtime in store.parents:
        raise ValueError("CONFIG_INVALID:runtime and store must be disjoint")
    if not project_root.is_dir() or not (project_root / "wfd_sdk" / "product_service.py").is_file():
        raise ValueError("CONFIG_NOT_FOUND:project_root/wfd_sdk")
    if not protocol_root.is_dir():
        raise ValueError("CONFIG_NOT_FOUND:protocol_root")
    caller = config.get("caller")
    if not isinstance(caller, dict):
        caller = {
            "caller_id": config.get("principal"),
            "trusted_actor_namespace": config.get("namespace"),
            "roles": config.get("roles"),
        }
    if not isinstance(caller, dict):
        raise ValueError("CONFIG_INVALID:caller")
    if not isinstance(caller.get("caller_id"), str) or not caller["caller_id"]:
        raise ValueError("CONFIG_INVALID:caller_id/principal")
    if not isinstance(caller.get("trusted_actor_namespace"), str) or not caller["trusted_actor_namespace"]:
        raise ValueError("CONFIG_INVALID:trusted_actor_namespace/namespace")
    roles = caller.get("roles")
    if not isinstance(roles, list) or any(not isinstance(role, str) or not role for role in roles):
        raise ValueError("CONFIG_INVALID:caller roles")
    extra_roles = sorted(set(roles) - MACHINE_ROLES)
    if extra_roles:
        raise ValueError("CONFIG_INVALID:machine roles not supported " + ",".join(extra_roles))
    profile = config.get("profile", "legacy")
    if profile not in PROFILES:
        raise ValueError("CONFIG_INVALID:profile")
    sources = config.get("sources", config.get("allowed_sources", {}))
    if not isinstance(sources, dict):
        raise ValueError("CONFIG_INVALID:sources/allowed_sources")
    if profile == "legacy" and not sources:
        raise ValueError("CONFIG_INVALID:sources/allowed_sources")
    if profile == "data_only":
        unsupported_roles = sorted(set(roles) - DATA_ONLY_CALLER_ROLES)
        if unsupported_roles:
            raise ValueError("CONFIG_INVALID:data_only roles not supported " + ",".join(unsupported_roles))
    for source_id, policy in sources.items():
        if not isinstance(source_id, str) or not source_id or not isinstance(policy, dict):
            raise ValueError("CONFIG_INVALID:sources")
        forbidden = sorted(flag for flag in ("may_export", "may_export_evidence", "may_redistribute")
                           if policy.get(flag) is True)
        if forbidden:
            raise ValueError("CONFIG_INVALID:machine entry cannot grant " + source_id + ":" + ",".join(forbidden))
        for key in ("allowed_roles", "allowed_authorities"):
            value = policy.get(key, [])
            if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
                raise ValueError("CONFIG_INVALID:" + source_id + ":" + key)
    units = config.get("units") or {}
    if not isinstance(units, dict):
        raise ValueError("CONFIG_INVALID:units")
    limits = config.get("limits") or {}
    if not isinstance(limits, dict):
        raise ValueError("CONFIG_INVALID:limits")
    max_input = limits.get("max_request_bytes", MAX_INPUT_BYTES)
    max_output = limits.get("max_response_bytes", MAX_OUTPUT_BYTES)
    if not isinstance(max_input, int) or not (1024 <= max_input <= 8_388_608):
        raise ValueError("CONFIG_INVALID:max_request_bytes")
    if not isinstance(max_output, int) or not (65_536 <= max_output <= MAX_OUTPUT_BYTES):
        raise ValueError("CONFIG_INVALID:max_response_bytes")
    max_batch_chunks = limits.get("max_batch_chunks", 64)
    max_batch_rows = limits.get("max_batch_rows", 20_000)
    max_batch_bytes = limits.get("max_batch_bytes", 8_000_000)
    # Absolute script entry (`python .../wfd_sdk/product_machine.py`) starts
    # with wfd_sdk/ on sys.path, not the package parent.  The validated trusted
    # project_root is the only place used for the package lookup.
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
    volume = config.get("volume")
    if volume is not None:
        if not isinstance(volume, dict):
            raise ValueError("CONFIG_INVALID:volume")
        allowed_volume = {"mount_point", "volume_uuid", "filesystem", "writer_host",
                          "writer_epoch", "instance_id"}
        extra_volume = sorted(set(volume) - allowed_volume)
        if extra_volume:
            raise ValueError("CONFIG_INVALID:volume fields " + ",".join(extra_volume))
        try:
            from wfd_sdk.volume_publication import VolumeBinding
            binding = VolumeBinding.from_dict(volume)
        except Exception as exc:
            raise ValueError("CONFIG_INVALID:volume binding " + str(exc)) from exc
        if Path(binding.mount_point).resolve() != store:
            raise ValueError("CONFIG_INVALID:volume mount_point must equal store")
        volume = binding.to_dict()
    max_evidence = limits.get("max_evidence_bytes", 8_388_608)
    for label, value, low, high in (
            ("max_batch_chunks", max_batch_chunks, 1, 512),
            ("max_batch_rows", max_batch_rows, 1, 200_000),
            ("max_batch_bytes", max_batch_bytes, 1024, 67_108_864),
            ("max_evidence_bytes", max_evidence, 1, 67_108_864)):
        if not isinstance(value, int) or not (low <= value <= high):
            raise ValueError("CONFIG_INVALID:" + label)
    return {
        **config,
        "store": str(store),
        "runtime": str(runtime),
        "project_root": str(project_root),
        "protocol_root": str(protocol_root),
        "profile": profile,
        "volume": volume,
        "sources": sources,
        "caller": {"caller_id": caller["caller_id"],
                   "trusted_actor_namespace": caller["trusted_actor_namespace"],
                   "roles": list(roles)},
        "max_request_bytes": max_input,
        "max_response_bytes": max_output,
        "batch_limits": {"max_chunks": max_batch_chunks, "max_rows": max_batch_rows,
                         "max_bytes": max_batch_bytes},
        "max_evidence_bytes": max_evidence,
    }


def _build_service(config, *, operation=None):
    """Open only an existing store, with access fixed by this one request.

    Possessing a write role is not itself a request to write or initialize.
    In particular capability/schema/query requests always use a read-only
    engine. New stores are provisioned explicitly outside this machine API.
    """
    sys.path.insert(0, config["project_root"])
    try:
        from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
        from wfd_sdk.product_service import WFDProductService
        from wfd_sdk.product_data_service import WFDDataOnlyService
    except Exception as exc:
        raise RuntimeError("SERVICE_IMPORT_FAILED:" + type(exc).__name__ + ": " + str(exc)) from exc
    if config.get("volume"):
        from wfd_sdk.product_volume_service import WFDVolumeService
        from wfd_sdk.volume_publication import VolumeBinding
        return WFDVolumeService(
            binding=VolumeBinding.from_dict(config["volume"]),
            runtime_root=Path(config["runtime"]),
            protocol_root=Path(config["protocol_root"]),
            caller_roles=config["caller"]["roles"],
            caller_id=config["caller"]["caller_id"],
            unit_registry=config["units"],
            trusted_actor_namespaces={config["caller"]["trusted_actor_namespace"]},
        )
    role = ("evidence_write" if operation == "evidence_ingest"
            else "register" if operation in {"register_write_target",
                                             "register_adjustment_anchor"} else "submit")
    store_write = operation in WRITE_OPERATIONS
    if config.get("profile") == "data_only":
        # Collecting chunks writes only the native batch ledger.  Even a
        # submit-capable caller must not touch the official store until finalize.
        store_write = operation in {"submit", "recovery", "batch_finalize",
                                    "register_write_target",
                                    "register_adjustment_anchor"}
    writable = store_write and role in config["caller"]["roles"]
    engine = WFDDuckDBPrototype.open_existing(
        Path(config["store"]), load_protocol_validator(
            Path(config["protocol_root"]),
            entry=("wfd-data-only-write.schema.json" if config.get("profile") == "data_only"
                   else "wfd-ingest.schema.json")),
        runtime_root=Path(config["runtime"]), sandbox=False,
        read_only=not writable, writer_host=config["caller"]["caller_id"],
    )
    if config.get("profile") == "data_only":
        return WFDDataOnlyService(
            engine,
            caller_roles=config["caller"]["roles"],
            caller_id=config["caller"]["caller_id"],
            unit_registry=config["units"],
            trusted_actor_namespaces={config["caller"]["trusted_actor_namespace"]},
        )
    return WFDProductService(
        engine,
        allowed_sources=config["sources"],
        can_register=True,
        caller_roles=config["caller"]["roles"],
        caller_id=config["caller"]["caller_id"],
        unit_registry=config["units"],
        trusted_actor_namespaces={config["caller"]["trusted_actor_namespace"]},
    )


def _request_object(value):
    if not isinstance(value, dict):
        raise ValueError("REQUEST_INVALID:request must be an object")
    allowed = {"protocol_version", "request_id", "operation", "arguments"}
    extra = sorted(set(value) - allowed)
    if extra:
        raise ValueError("REQUEST_INVALID:unexpected fields " + ",".join(extra))
    if value.get("protocol_version") != MACHINE_PROTOCOL:
        raise ValueError("REQUEST_INVALID:protocol_version must be " + MACHINE_PROTOCOL)
    request_id = value.get("request_id")
    if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
        raise ValueError("REQUEST_INVALID:request_id")
    operation = value.get("operation")
    if not isinstance(operation, str) or not operation:
        raise ValueError("REQUEST_INVALID:operation")
    arguments = value.get("arguments", {})
    if not isinstance(arguments, dict):
        raise ValueError("REQUEST_INVALID:arguments must be an object")
    return request_id, operation, arguments


def _exact(arguments, allowed, required):
    extra = sorted(set(arguments) - set(allowed))
    if extra:
        raise ValueError("REQUEST_INVALID:unexpected arguments " + ",".join(extra))
    missing = [key for key in required if key not in arguments]
    if missing:
        raise ValueError("REQUEST_INVALID:missing arguments " + ",".join(missing))


def _service_error(exc):
    text = str(exc)
    if isinstance(exc, OverflowError) and "RESPONSE_TOO_LARGE" in text:
        return "RESPONSE_TOO_LARGE", text
    if isinstance(exc, PermissionError):
        code = "CALLER_PERMISSION_DENIED"
        match = _CODE_PREFIX.match(text)
        if match and match.group(1).startswith(("CALLER_", "SOURCE_")):
            code = match.group(1)
    elif isinstance(exc, FileNotFoundError):
        code = "WFD_STORE_UNAVAILABLE"
    else:
        match = _CODE_PREFIX.match(text)
        code = match.group(1) if match else "REQUEST_INVALID"
    return code, text


def _product_summary(product):
    if not isinstance(product, dict):
        return product
    return {
        "product_id": product.get("product_id"),
        "dataset_id": product.get("dataset_id"),
        "subject": product.get("subject"),
        "payload_kind": product.get("payload_kind"),
        "logical_domain": product.get("logical_domain"),
        "service_version": product.get("service_version"),
        "contract_ref": product.get("contract_ref"),
        "contract_refs": product.get("contract_refs"),
        "contract_bundle_ref": product.get("contract_bundle_ref"),
        "definition_ref": product.get("definition_ref"),
    }


def _query(service, config):
    from wfd_sdk.product_query import ProductQuery
    return ProductQuery(service, protocol_root=Path(config["protocol_root"]))


def _batch_ledger_root(config):
    """Trusted native runtime ledger root for data_only; never request-supplied."""
    if config.get("profile") != "data_only":
        return None
    runtime = Path(config["runtime"]).resolve()
    store = Path(config["store"]).resolve()
    volume = config.get("volume") or {}
    instance = volume.get("instance_id")
    if isinstance(instance, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}",
                                                  instance):
        label = "instance-" + instance
    elif isinstance(instance, str) and instance:
        label = "instance-" + hashlib.sha256(instance.encode("utf-8")).hexdigest()[:16]
    else:
        caller = config["caller"]
        seed = (caller["trusted_actor_namespace"] + "\x1f" + caller["caller_id"]).encode("utf-8")
        label = "actor-" + hashlib.sha256(seed).hexdigest()[:16]
    root = (runtime / "batches" / label).resolve()
    if root == store or store in root.parents:
        raise ValueError("CONFIG_INVALID:data_only batch ledger root inside official store")
    return root


def _batches(service, config):
    from wfd_sdk.product_batches import ProductBatchLedger
    kwargs = dict(config["batch_limits"])
    ledger_root = _batch_ledger_root(config)
    if ledger_root is not None:
        kwargs["ledger_root"] = ledger_root
    return ProductBatchLedger(service, **kwargs)


def _canonical_digest(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _document_identity(document):
    if not isinstance(document, dict):
        raise ValueError("REQUEST_INVALID:document must be an object")
    identity = document.get("request_identity")
    if not isinstance(identity, dict):
        raise ValueError("REQUEST_INVALID:document.request_identity")
    return identity


def _recovery_action(state):
    return {
        "publication_unknown": "retry_same_identity_verify_actual_commit",
        "publication_pending_activation": "retry_after_head_activation",
        "published_commit_pending_head": "activate_committed_snapshot_do_not_republish",
        "partially_committed_pending_head": "activate_committed_snapshot_inspect_rejected_outputs",
        "published_formal": "none_already_formal",
        "published_sandbox": "none_sandbox_not_formal",
        "unchanged": "none_identical_records_skipped",
        "conflicts_pending": "confirm_conflicts_then_explicit_revision_new_request",
        "partially_published_formal": "confirm_unpublished_conflicts_do_not_republish_accepted_rows",
        "rejected": "fix_request_or_policy_then_new_submission",
    }.get(state, "inspect_request_status")


def _json_bytes(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _bounded_int(value, label, default, low, high):
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not (low <= value <= high):
        raise ValueError("REQUEST_INVALID:" + label)
    return value


def _compact_errors(errors, limit=5):
    compact = []
    for item in (errors or [])[:limit]:
        if isinstance(item, dict):
            compact.append({key: item.get(key) for key in ("code", "message", "action")
                            if item.get(key) is not None})
        else:
            compact.append(str(item))
    return compact


_METADATA_OUTPUT_FIELDS = (
    "metadata_ref", "coverage_ref", "predecessor_ref", "metadata_sequence",
    "definition_ref", "contract_refs", "contract_bundle_ref", "bundle_ref",
    "parent_snapshot_id", "predecessor_snapshot_id", "predecessor_snapshot",
    "parent_snapshot", "metadata_parent_snapshot_id",
    "expected_parent_snapshot_id",
)


def _compact_metadata_output(item):
    """Pass through only fields already present on a trusted metadata output.

    Callers must decide this from the service-produced ``metadata_only`` flag,
    never from an empty ``records`` list or a client-supplied marker.
    """
    compact = {"metadata_only": True}
    for key in _METADATA_OUTPUT_FIELDS:
        if key in item:
            compact[key] = copy.deepcopy(item[key])
    if "records" in item:
        compact["records"] = copy.deepcopy(item["records"])
    return compact


def _duplicate_output_page(item, offset, limit):
    value = copy.deepcopy(item)
    rows = item["row_results"]
    offset = min(offset, len(rows))
    selected = rows[offset:offset + limit]
    identities = {(row.get("record_id"), row.get("record_version")) for row in selected}
    value["row_results"] = copy.deepcopy(selected)
    for name in ("records", "inserted_records"):
        if name in value:
            value[name] = [row for row in value[name]
                           if (row.get("record_id"), row.get("record_version")) in identities]
    value.update(row_results_total=len(rows), row_results_offset=offset,
                 row_results_included=len(selected),
                 row_results_complete=offset == 0 and len(selected) == len(rows),
                 next_row_offset=offset + len(selected) if offset + len(selected) < len(rows) else None)
    return value


def _compact_output(item, detail="summary", row_offset=0, row_limit=256):
    if not isinstance(item, dict):
        return item
    if detail == "full":
        if isinstance(item.get("row_results"), list):
            return _duplicate_output_page(item, row_offset, row_limit)
        return copy.deepcopy(item)
    contract = item.get("contract_ref") if isinstance(item.get("contract_ref"), dict) else {}
    compact = {
        "output_key": item.get("output_key"),
        "product_id": item.get("product_id"),
        "snapshot_id": item.get("snapshot_id"),
        "registration_state": item.get("registration_state"),
        "publication_state": item.get("publication_state"),
        "engine_publication_state": item.get("engine_publication_state"),
        "contract_ref": ({"id": contract.get("id"), "digest": contract.get("digest")}
                         if contract else None),
        "error_codes": [error.get("code") for error in item.get("errors", [])
                        if isinstance(error, dict)][:5],
    }
    if item.get("metadata_only") is True:
        compact.update(_compact_metadata_output(item))
    if isinstance(item.get("row_results"), list):
        compact.update(row_summary=copy.deepcopy(item.get("row_summary")),
                       row_results_total=len(item["row_results"]), row_results_complete=False)
    return compact


def _compact_receipt(receipt):
    if not isinstance(receipt, dict):
        return receipt
    keep = ("status", "snapshot_id", "request_key", "request_fingerprint",
            "parent_snapshot_id", "storage_format", "duckdb_roundtrip_verified",
            "independent_other_engine_verified", "production_publishable",
            "idempotent_replay")
    compact = {key: receipt.get(key) for key in keep if key in receipt}
    compact["outputs_success"] = list(receipt.get("outputs_success") or [])
    compact["outputs_rejected"] = [
        {"output_key": item.get("output_key"),
         "error_codes": [error.get("code") for error in item.get("errors", [])
                         if isinstance(error, dict)][:5]}
        for item in (receipt.get("outputs_rejected") or []) if isinstance(item, dict)]
    return compact


def _persistent_receipt(request_key, identity, formal_path=None, formal_record=None):
    return {
        "request_key": request_key,
        "status_ref": (f"catalog/product_service/request_status/{request_key}.json"
                       if request_key else None),
        "formal_publication_ref": formal_path,
        "formal_publication_record_sha256": (_canonical_digest(formal_record)
                                             if isinstance(formal_record, dict) else None),
        "store_relative": True,
        "query": {"operation": "request_status",
                  "arguments": {"request_identity": identity}},
    }


def _page_meta(offset, included, total, *, operation, identity, detail, requested_limit):
    has_more = offset + included < total
    next_offset = offset + included if has_more else None
    continuation = None
    if has_more:
        continuation = {
            "operation": "request_status",
            "arguments": {"request_identity": identity,
                          "output_offset": next_offset,
                          "output_limit": max(1, min(requested_limit, MAX_OUTPUT_PAGE)),
                          "output_detail": detail},
            "note": "same request_identity; continue at output_offset",
        }
    return {
        "outputs_total": total,
        "outputs_included": included,
        "outputs_offset": offset,
        "outputs_complete": offset == 0 and included == total,
        "outputs_remaining": max(0, total - offset - included),
        "has_more": has_more,
        "next_output_offset": next_offset,
        "pagination": {
            "source_operation": operation,
            "requested_limit": requested_limit,
            "page_size": included,
            "offset": offset,
            "has_more": has_more,
            "next_offset": next_offset,
            "detail": detail,
        },
        "continuation": continuation,
    }


def _status_view(status, identity, offset, limit, detail="summary", include_record=False,
                 row_offset=0, row_limit=256):
    outputs = status.get("output_results")
    if not isinstance(outputs, list):
        outputs = []
    total = len(outputs)
    offset = max(0, min(offset, total))
    included = min(limit, max(0, total - offset))
    formal = status.get("formal_publication")
    formal = formal if isinstance(formal, dict) else None
    formal_ref = status.get("formal_publication_ref")
    if formal is None and formal_ref:
        formal = {"path": formal_ref}
    record = formal.get("record") if formal else None
    result = {
        "format_version": status.get("format_version"),
        "service_version": status.get("service_version"),
        "request_key": status.get("request_key"),
        "request_identity": status.get("request_identity") or identity,
        "input_fingerprint": status.get("input_fingerprint"),
        "state": status.get("state"),
        "service_status": status.get("service_status"),
        "phases": status.get("phases"),
        "publication_intent": status.get("publication_intent"),
        "snapshot_id": status.get("snapshot_id"),
        "errors": _compact_errors(status.get("errors")),
        "caller_id": status.get("caller_id"),
        "formal_publication": ({
            "path": formal.get("path"),
            "record_included": bool(include_record and isinstance(record, dict)),
            "record_sha256": (_canonical_digest(record)
                              if isinstance(record, dict) else None),
        } if formal else None),
        "formal_publication_verified": bool(
            status.get("formal_publication_verified")
            or (formal and formal.get("path"))),
        "output_results": [_compact_output(item, detail, row_offset, row_limit)
                           for item in outputs[offset:offset + included]],
        "view": "bounded_page",
        "bounded": True,
        "bounded_note": ("output_results is a bounded page and does not contain "
                         "every full contract body; continue with request_status + output_offset."),
        "persistent_receipt": _persistent_receipt(
            status.get("request_key"), status.get("request_identity") or identity,
            formal.get("path") if formal else None, record),
        "recovery_action": _recovery_action(status.get("state")),
    }
    if include_record and isinstance(record, dict):
        result["formal_publication"]["record"] = copy.deepcopy(record)
    if status.get("service_identity") is not None:
        result["service_identity"] = status["service_identity"]
    for key in ("duplicate_policy", "row_summary", "new_snapshot_created"):
        if key in status:
            result[key] = copy.deepcopy(status[key])
    result["identity"] = identity
    result.update(_page_meta(offset, included, total, operation="request_status",
                             identity=result["request_identity"], detail=detail,
                             requested_limit=limit))
    return result


def _batch_finalize_view(result, offset, limit, detail="summary"):
    identity = result.get("request_identity")
    formal_ref = result.get("formal_publication_ref")
    status = {
        "format_version": result.get("format_version"),
        "service_version": result.get("service_version"),
        "request_key": result.get("request_key"),
        "request_identity": identity,
        "state": result.get("state") or result.get("status"),
        "snapshot_id": result.get("snapshot_id"),
        "output_results": result.get("output_results") or [],
        "errors": result.get("errors") or [],
        "formal_publication": ({"path": formal_ref} if formal_ref else None),
    }
    view = _status_view(status, identity, offset, limit, detail)
    view.update({
        "batch_id": result.get("batch_id"),
        "phase": result.get("phase"),
        "status": result.get("status"),
        "state": result.get("state") or result.get("status"),
        "formal_publication_ref": formal_ref,
        "formal_publication_verified": bool(result.get("formal_publication_verified")),
        "status_detail": copy.deepcopy(result.get("status_detail")),
        "batch": {
            "phase": result.get("phase"),
            "status": result.get("status"),
            "snapshot_id": result.get("snapshot_id"),
            "recovered_from_request_status": result.get(
                "recovered_from_request_status", False),
        },
        "batch_finalize_paging": True,
    })
    return view


def _compact_request_state(state):
    if not isinstance(state, dict):
        return state
    formal = state.get("formal_publication")
    formal = formal if isinstance(formal, dict) else {}
    record = formal.get("record")
    compact = {
        "format_version": state.get("format_version"),
        "service_version": state.get("service_version"),
        "request_key": state.get("request_key"),
        "request_identity": state.get("request_identity"),
        "input_fingerprint": state.get("input_fingerprint"),
        "state": state.get("state"),
        "service_status": state.get("service_status"),
        "phases": state.get("phases"),
        "publication_intent": state.get("publication_intent"),
        "snapshot_id": state.get("snapshot_id"),
        "outputs_total": len(state.get("output_results") or []),
        "errors": _compact_errors(state.get("errors")),
        "formal_publication_path": formal.get("path"),
        "formal_publication_record_sha256": (_canonical_digest(record)
                                             if isinstance(record, dict) else None),
    }
    return compact


def _compact_publication_checks(value):
    if not isinstance(value, dict):
        return value
    outputs = value.get("outputs")
    compact = {
        "format_version": value.get("format_version"),
        "service_version": value.get("service_version"),
        "request_key": value.get("request_key"),
        "input_fingerprint": value.get("input_fingerprint"),
        "snapshot_id": value.get("snapshot_id"),
        "snapshot_file_sha256": value.get("snapshot_file_sha256"),
        "commit_marker_sha256": value.get("commit_marker_sha256"),
        "raw_engine_status": value.get("raw_engine_status"),
        "source_ids": value.get("source_ids"),
        "source_formal_grants": value.get("source_formal_grants"),
        "checks": value.get("checks"),
        "formal_publication_state": value.get("formal_publication_state"),
        "outputs_total": len(outputs) if isinstance(outputs, list) else None,
        "outputs_omitted": True,
        "record_sha256": _canonical_digest(value),
    }
    return compact


def _submit_view(result, included, offset=0, detail="summary"):
    outputs = result.get("output_results")
    if not isinstance(outputs, list):
        outputs = []
    total = len(outputs)
    offset = max(0, min(offset, total))
    included = min(included, max(0, total - offset))
    keep = ("status", "state", "request_key", "snapshot_id", "duplicate_policy", "row_summary", "new_snapshot_created",
            "publication_summary", "formal_publication_receipt",
            "formal_publication_checks", "formal_publication_verified",
            "idempotent_replay", "service_version", "production_publishable",
            "request_identity", "document_sha256", "recovery", "errors",
            "service_identity")
    view = {key: copy.deepcopy(result[key]) for key in keep if key in result}
    if "request_state" in result:
        view["request_state"] = _compact_request_state(result["request_state"])
    if "formal_publication_checks" in result:
        view["formal_publication_checks"] = _compact_publication_checks(
            result["formal_publication_checks"])
    view["output_results"] = [_compact_output(item, detail)
                              for item in outputs[offset:offset + included]]
    view["engine_receipt"] = _compact_receipt(result.get("engine_receipt"))
    view["commit_receipt"] = _compact_receipt(result.get("commit_receipt"))
    view["receipts_compacted"] = True
    view["receipts_note"] = ("full engine/commit receipts remain in the trusted store; "
                             "this response carries their bounded public projection")
    view["view"] = "bounded_page"
    view["bounded"] = True
    view["bounded_note"] = ("output_results is a compact page; pinned contract bodies are not "
                            "all included. Continue with request_status + output_offset.")
    publication = result.get("formal_publication_checks")
    receipt = _persistent_receipt(
        result.get("request_key"), result.get("request_identity"),
        result.get("formal_publication_receipt"))
    if isinstance(publication, dict):
        receipt["formal_publication_record_sha256"] = _canonical_digest(publication)
    view["persistent_receipt"] = receipt
    view.update(_page_meta(offset, included, total, operation="submit",
                           identity=result.get("request_identity") or {},
                           detail=detail, requested_limit=DEFAULT_OUTPUT_PAGE))
    return view


def _bounded_envelope(response, result, limit, reason="configured_max_response_bytes"):
    total = result.get("outputs_total", len(result.get("output_results") or []))
    included = result.get("outputs_included", len(result.get("output_results") or []))
    offset = result.get("outputs_offset", 0)
    bounded = copy.copy(response)
    bounded["result"] = result
    bounded["bounded_response"] = {
        "complete": False,
        "reason": reason,
        "configured_limit_bytes": limit,
        "outputs_total": total,
        "outputs_included": included,
        "outputs_offset": offset,
        "outputs_remaining": max(0, total - offset - included),
        "has_more": offset + included < total,
        "output_detail": result.get("pagination", {}).get("detail"),
        "continuation": result.get("continuation"),
        "note": ("bounded projection of a real persisted result; it is not a complete "
                 "copy. Use request_status with the same request_identity and output_offset."),
    }
    return bounded


def _trim_bounded_page(response, limit):
    result = response.get("result") or {}
    outputs = result.get("output_results") or []
    total = result.get("outputs_total", len(outputs))
    offset = result.get("outputs_offset", 0)
    detail = result.get("pagination", {}).get("detail", "summary")
    identity = result.get("request_identity")
    if len(outputs) == 1 and isinstance(outputs[0].get("row_results"), list):
        original = outputs[0]
        rows = original["row_results"]
        count = len(rows)
        while count > 0:
            page = _duplicate_output_page(original, 0, count)
            row_offset = original.get("row_results_offset", 0)
            total_rows = original.get("row_results_total", len(rows))
            page.update(row_results_total=total_rows, row_results_offset=row_offset,
                        row_results_complete=row_offset == 0 and count == total_rows,
                        next_row_offset=row_offset + count if row_offset + count < total_rows else None)
            candidate_result = {**result, "output_results": [page]}
            candidate = _bounded_envelope(response, candidate_result, limit)
            if _json_bytes(candidate) <= max(4096, limit - 1024):
                return candidate
            count //= 2
        page = _compact_output(original, "summary")
        page.update(row_results=[], records=[], inserted_records=[], row_results_included=0,
                    row_results_total=original.get("row_results_total", len(rows)),
                    row_results_offset=original.get("row_results_offset", 0),
                    next_row_offset=None,
                    row_result_error={"code": "ROW_RESULT_TOO_LARGE",
                                      "row_index": rows[0].get("row_index") if rows else None,
                                      "message": "One fixed row result exceeds the configured response budget"})
        return _bounded_envelope(response, {**result, "output_results": [page]}, limit)
    for count in range(len(outputs), -1, -1):
        candidate_result = copy.deepcopy(result)
        candidate_result["output_results"] = copy.deepcopy(outputs[:count])
        candidate_result.update(_page_meta(
            offset, count, total, operation="request_status", identity=identity,
            detail=detail,
            requested_limit=result.get("pagination", {}).get("requested_limit",
                                                             DEFAULT_OUTPUT_PAGE)))
        candidate = _bounded_envelope(response, candidate_result, limit)
        if _json_bytes(candidate) <= max(4096, limit - 1024):
            return candidate
    return response


def _fit_response(response, limit):
    """Project a large paged result into a truthful bounded view.

    The full service result remains persisted.  The returned view never claims
    to be complete: it carries the original request_identity, the persisted
    request/receipt references and an explicit continuation.  Small results are
    returned unchanged.
    """
    if _json_bytes(response) <= limit:
        return response
    budget = max(4096, limit - 1024)
    operation = response.get("operation")
    result = response.get("result")
    if operation not in PAGED_OPERATIONS or not isinstance(result, dict):
        return response
    if operation == "request_status" and result.get("view") == "bounded_page":
        return _trim_bounded_page(response, limit)
    if operation == "request_status":
        outputs = result.get("output_results") or []
        total = len(outputs)
        cap = min(total, DEFAULT_OUTPUT_PAGE)
        for count in range(cap, -1, -1):
            view = _status_view(result, result.get("request_identity"), 0, count, "summary")
            candidate = _bounded_envelope(response, view, limit)
            if _json_bytes(candidate) <= budget:
                return candidate
        return response
    if operation == "batch_finalize":
        if result.get("batch_finalize_paging"):
            reduced = copy.deepcopy(result)
            reduced.pop("status_detail", None)
            candidate = _bounded_envelope(response, reduced, limit)
            return candidate if _json_bytes(candidate) <= limit else response
        if not result.get("request_identity"):
            return response
        outputs = result.get("output_results") or []
        total = len(outputs)
        cap = min(total, DEFAULT_OUTPUT_PAGE)
        for count in range(cap, -1, -1):
            view = _batch_finalize_view(result, 0, count, "summary")
            candidate = _bounded_envelope(response, view, limit)
            if _json_bytes(candidate) <= budget:
                return candidate
        view = _batch_finalize_view(result, 0, 0, "summary")
        view.pop("status_detail", None)
        candidate = _bounded_envelope(response, view, limit)
        return candidate if _json_bytes(candidate) <= limit else response
    outputs = result.get("output_results") or []
    total = len(outputs)
    cap = min(total, DEFAULT_OUTPUT_PAGE)
    for count in range(cap, -1, -1):
        view = _submit_view(result, count, 0, "summary")
        candidate = _bounded_envelope(response, view, limit)
        if _json_bytes(candidate) <= budget:
            return candidate
    view = _submit_view(result, 0, 0, "summary")
    for key in ("formal_publication_checks", "recovery", "errors",
                "document_sha256", "production_publishable", "service_version",
                "engine_receipt", "commit_receipt"):
        view.pop(key, None)
        candidate = _bounded_envelope(response, view, limit)
        if _json_bytes(candidate) <= budget:
            return candidate
    return response


def _batches_status_brief(service, config, batch_id):
    try:
        status = _batches(service, config).status(batch_id)
    except Exception as exc:
        return {"known_phase": "unknown",
                "state_query_error": type(exc).__name__ + ": " + str(exc)}
    brief = {key: status.get(key) for key in
             ("batch_id", "phase", "snapshot_id", "expected_chunks", "received_chunks",
              "missing", "finalized_snapshot_id", "request_key", "state")
             if key in status}
    return brief


def _write_context(service, config, request, response=None):
    operation = request.get("operation") if isinstance(request, dict) else None
    arguments = request.get("arguments") if isinstance(request, dict) else None
    if not isinstance(arguments, dict):
        arguments = {}
    context = {
        "operation": operation,
        "may_have_written": operation in WRITE_OPERATIONS,
        "do_not_resubmit_with_new_identity": operation in {"submit", "recovery"},
    }
    if operation in {"submit", "recovery"}:
        document = arguments.get("document")
        identity = document.get("request_identity") if isinstance(document, dict) else None
        context["request_identity"] = identity
        if isinstance(identity, dict):
            context["status_query"] = {
                "operation": "request_status",
                "arguments": {"request_identity": identity},
            }
        if service is not None and isinstance(identity, dict):
            try:
                status = service.request_status(identity)
                formal = status.get("formal_publication") or {}
                context.update({
                    "known_state": status.get("state"),
                    "snapshot_id": status.get("snapshot_id"),
                    "request_key": status.get("request_key"),
                    "outputs_total": len(status.get("output_results") or []),
                    "formal_publication_ref": formal.get("path"),
                    "persistent_receipt": _persistent_receipt(
                        status.get("request_key"), status.get("request_identity") or identity,
                        formal.get("path"), formal.get("record")),
                    "recovery_action": _recovery_action(status.get("state")),
                })
            except Exception as exc:
                context["known_state"] = "unknown"
                context["state_query_error"] = type(exc).__name__ + ": " + str(exc)
    elif operation and operation.startswith("batch_"):
        batch_id = arguments.get("batch_id")
        context["batch_id"] = batch_id
        if batch_id:
            context["status_query"] = {"operation": "batch_status",
                                       "arguments": {"batch_id": batch_id}}
            if service is not None and config is not None:
                context["known_batch_state"] = _batches_status_brief(
                    service, config, batch_id)
    elif operation == "evidence_ingest":
        context["note"] = ("custody bytes may already be written before a receipt "
                           "is returned; there is no request_identity replay")
        if isinstance(response, dict) and isinstance(response.get("result"), dict):
            context["evidence_ref"] = response["result"].get("ref_id")
    if isinstance(response, dict) and isinstance(response.get("result"), dict):
        result = response["result"]
        context["result_summary"] = {
            key: result.get(key) for key in
            ("status", "request_key", "request_state", "snapshot_id",
             "publication_summary", "outputs_total", "outputs_included")
            if result.get(key) is not None
        }
    return context


def _output_failure_response(exc, config, service, request, response, started):
    request_id = request.get("request_id") if isinstance(request, dict) else None
    operation = request.get("operation") if isinstance(request, dict) else None
    identity = None
    service_identity = None
    if service is not None and config is not None:
        try:
            identity = _caller_identity(config, service)
            service_identity = _service_identity(service)
        except Exception:
            pass
    try:
        context = _write_context(service, config, request, response)
    except Exception as context_error:  # reporting must not fail the fallback
        context = {"operation": operation, "may_have_written": operation in WRITE_OPERATIONS,
                   "state_query_error": type(context_error).__name__ + ": " + str(context_error)}
    details = {
        "response_written": False,
        "operation_completed": bool(isinstance(response, dict) and response.get("ok")),
        "operation_result_known": isinstance(response, dict) and response.get("ok") is True,
        "write_context": context,
        "cause": type(exc).__name__ + ": " + str(exc),
        "response_limit_bytes": config.get("max_response_bytes") if config else None,
    }
    return {
        "protocol_version": MACHINE_PROTOCOL,
        "request_id": request_id if isinstance(request_id, str) else "unparsed",
        "operation": operation if isinstance(operation, str) else "unparsed",
        "ok": False,
        "result": None,
        "error": _issue(
            "PROCESS_OUTPUT_FAILED",
            ("the operation completed or may have completed, but its response could not be "
             "written within the configured limit; the result must not be treated as absent"),
            action=_action_for("PROCESS_OUTPUT_FAILED"),
            request_id=request_id if isinstance(request_id, str) else None,
            operation=operation if isinstance(operation, str) else None,
            identity=identity, service=service_identity,
            cause=type(exc).__name__ + ": " + str(exc),
            details=details,
        ),
        "identity": identity,
        "service": service_identity,
        "request_identity": details["write_context"].get("request_identity"),
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }


def _evidence_ingest(service, config, arguments):
    _exact(arguments, {"content_base64", "original_name"}, {"content_base64"})
    encoded = arguments["content_base64"]
    if not isinstance(encoded, str):
        raise ValueError("REQUEST_INVALID:content_base64 must be a string")
    try:
        raw = base64.b64decode(encoded.encode("ascii"), validate=True)
    except (ValueError, UnicodeEncodeError) as exc:
        raise ValueError("REQUEST_INVALID:content_base64 is not canonical base64") from exc
    if not raw:
        raise ValueError("REQUEST_INVALID:content bytes must be nonempty")
    if len(raw) > config["max_evidence_bytes"]:
        raise ValueError("REQUEST_TOO_LARGE:content exceeds configured max_evidence_bytes")
    name = Path(str(arguments.get("original_name") or "content.bin")).name
    if not name or name in {".", ".."} or len(name) > 160:
        raise ValueError("REQUEST_INVALID:original_name")
    runtime = Path(config["runtime"])
    runtime.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix="wfd-evidence-", suffix="-" + name[:80], dir=runtime)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        ref = service.register_evidence(temp_path)
    finally:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
    return {**ref, "size": len(raw), "original_name": name,
            "input_mode": "trusted_content_bytes_not_local_path"}


def _review_definition(service, namespace, args):
    """Answer a BD admission enquiry. No registration, submission or lock acquisition."""
    subject, fields = args["subject"], args["field_codes"]
    if not isinstance(subject, dict) or set(subject) != {"kind", "id", "namespace"}:
        raise ValueError("REQUEST_INVALID:subject")
    identifiers = [args["dataset_id"], args["semantic_code"], *subject.values()]
    if not isinstance(fields, list) or not 1 <= len(fields) <= 256:
        raise ValueError("REQUEST_INVALID:field_codes")
    if not all(isinstance(x, str) and REQUEST_ID.fullmatch(x) for x in identifiers + fields):
        raise ValueError("REQUEST_INVALID:definition_review_identifiers")
    if len(set(fields)) != len(fields):
        raise ValueError("REQUEST_INVALID:duplicate_field")
    head = service.snapshot_status()["snapshot_id"]
    if args["snapshot_id"] != head:
        raise ValueError("PARENT_CHANGED:definition_review")
    products = service.discover_products(snapshot_id=head, subject=subject)["products"] if head else []
    family = [p for p in products if p["dataset_id"] == args["dataset_id"]
              and p["logical_domain"] == "observations"
              and p["declaration"]["semantic_code"] == args["semantic_code"]
              and p["declaration"]["definition_authority"] == namespace]
    missing = list(fields)
    code = "FAMILY_DEFINITION_REQUIRED"
    if family:
        latest = max(family, key=lambda p: p.get("definition_sequence", 0))
        if latest["payload_kind"] != "tabular_rows":
            raise ValueError("PRODUCT_LAYOUT_REVIEW_REQUIRED:existing family uses a different payload kind")
        existing = {f["field_code"] for f in latest["declaration"].get("field_definitions", [])}
        missing = [field for field in fields if field not in existing]
        code = "FIELD_DEFINITION_REQUIRED" if missing else "CANDIDATE_FIELDS_PRESENT"
    return {"protocol": "wfd.definition-review/1", "snapshot_id": head, "dataset_id": args["dataset_id"],
            "subject": subject, "semantic_code": args["semantic_code"], "field_codes": fields,
            "disposition": "return_to_bd" if missing else "candidate_found", "code": code,
            "product_ids": sorted({p["product_id"] for p in family}), "missing_fields": missing}


def _handle(service, config, request):
    request_id, operation, arguments = _request_object(request)
    identity = _caller_identity(config, service)
    service_identity = _service_identity(service)
    started = time.monotonic()
    if operation not in SUPPORTED:
        raise _Unsupported(operation, request_id, identity, service_identity)
    if config.get("profile") == "data_only" and operation not in DATA_ONLY_OPERATIONS:
        raise ValueError("EXTERNAL_METADATA_OPERATION_UNSUPPORTED:" + operation)
    if config.get("profile") != "data_only" and operation in (*CONTEXT_QUERY_OPERATIONS, *FIXED_PAGE_OPERATIONS, "snapshot_status", "review_definition"):
        raise _Unsupported(operation, request_id, identity, service_identity)
    # Permission precedes any submit/evidence writer lock (creating a lock
    # file is already a store write), as well as argument/header inspection.
    if operation in {"submit", "recovery", "batch_begin", "batch_put_chunk", "batch_finalize"}:
        service.require_permission("submit")
    elif operation == "evidence_ingest":
        service.require_permission("evidence_write")
    elif operation in {"register_write_target", "register_adjustment_anchor"}:
        # 正式写入目标登记与复权锚点登记都改变后续正式写入的语义，按登记+发布双权限核对。
        service.require_permission("register")
        service.require_permission("publish")
    elif operation in USAGE_WRITE_OPERATIONS:
        # 用途治理写操作是正式发布级动作；不因只读 caller 或正文自称授权放行。
        service.require_permission("publish")
    elif operation in {"usage_status", "usage_audit_read"}:
        service.require_permission("read")
    elif operation in {"batch_status", "batch_read_page", "snapshot_status", "review_definition"}:
        service.require_permission("read")
    if operation in USAGE_OPERATIONS and config.get("profile") != "data_only":
        raise ValueError("USAGE_GOVERNANCE_PROFILE_REQUIRED")
    if operation == "capabilities":
        _exact(arguments, set(), set())
        result = _capabilities(service, config, identity, service_identity)
    elif operation == "service_capabilities":
        _exact(arguments, set(), set())
        result = service.capabilities()
    elif operation == "schema":
        _exact(arguments, set(), set())
        if config.get("profile") == "data_only":
            result = service.structured_schema_info()
        else:
            service_caps = service.capabilities()
            query_caps = _query(service, config).capabilities()
            result = {
                "ingest": service_caps.get("structural_validation"),
                "query": {key: query_caps.get(key) for key in
                          ("protocol_version", "schema_id", "schema_sha256", "schema_canonical_sha256")},
                "service_version": service_caps.get("service_version"),
                "contract_version": service_caps.get("contract_version"),
            }
    elif operation == "snapshot_status":
        _exact(arguments, set(), set())
        result = {**service.snapshot_status(), "connection_id": config["connection_id"],
                  "trusted_actor_namespace": config["caller"]["trusted_actor_namespace"]}
    elif operation == "review_definition":
        keys = {"snapshot_id", "dataset_id", "subject", "semantic_code", "field_codes"}
        _exact(arguments, keys, keys)
        result = _review_definition(service, config["caller"]["trusted_actor_namespace"], arguments)
    elif operation == "contract_discovery":
        _exact(arguments, {"snapshot_id", "subject"}, {"snapshot_id"})
        discovered = service.discover_products(
            snapshot_id=arguments["snapshot_id"], subject=arguments.get("subject"))
        result = {
            "snapshot_id": discovered.get("snapshot_id"),
            "products": discovered.get("products", []),
            "product_summaries": [_product_summary(p) for p in discovered.get("products", [])],
            "product_count": len(discovered.get("products", [])),
            "source_count": len(discovered.get("source_ids", [])),
            "source_ids": discovered.get("source_ids", []),
            "service_identity": service_identity,
        }
    elif operation in FIXED_PAGE_OPERATIONS:
        service.require_permission("read")
        page_cap = service.capabilities().get("operations", {}).get(operation, {})
        if page_cap.get("supported") is not True:
            raise _Unsupported(operation, request_id, identity, service_identity)
        selected = operation == "fixed_read_page"
        required = {"snapshot_id", "product_id"} | ({"record_refs"} if selected else set())
        _exact(arguments, required | {"page_size", "max_page_bytes", "cursor"}, required)
        # Include all machine-added result fields in the service's page budget.
        # The outer envelope still has the unchanged configured 32MiB ceiling.
        extras = {"service_identity": service_identity, "row_projection": "full",
                  "row_projection_note": ("no row or product fields dropped; selected fixed identity page"
                                          if selected else "no row or product fields dropped; fixed full-product view page")}
        envelope = {"protocol_version": MACHINE_PROTOCOL, "request_id": request_id,
                    "operation": operation, "ok": True, "result": None, "error": None,
                    "identity": identity, "service": service_identity, "elapsed_ms": 999999999999}
        budget = config["max_response_bytes"] - _json_bytes(envelope) - 16
        reader = service.read_page if selected else service.read_product_page
        result = reader(arguments["product_id"],
                        **{key: value for key, value in arguments.items() if key != "product_id"},
                        _machine_result_fields=extras, _result_budget=budget)
        if _json_bytes(result) > arguments.get("max_page_bytes", 1_048_576):
            raise ValueError("PAGE_RESULT_TOO_LARGE")
    elif operation == "filter_objects":
        from wfd_sdk.filter_objects import FilterRejected, run as _run_filter_objects
        try:
            result = _run_filter_objects(service, config, arguments,
                                         lambda: _query(service, config), service_identity)
            if result.get("protocol_version") == "wfd.filter-objects/1.4-product1":
                from wfd_sdk.filter_plan import validate_result
                validate_result(result, config["protocol_root"])
        except FilterRejected as rejected:
            from wfd_sdk.product_query import ProductQueryError
            raise ProductQueryError(rejected.code, rejected.message, rejected.details) from None
    elif operation == "fixed_read":
        _exact(arguments, {"snapshot_id", "product_id", "perspective", "at", "subject",
                           "include_history", "row_projection", "held_scope",
                           "usable_stage"}, {"snapshot_id"})
        projection = arguments.pop("row_projection", "full")
        if projection != "full":
            raise ValueError(
                "REQUEST_INVALID:row_projection=compact removed; the public projection, "
                "contract/unit definitions, evidence_refs/source_binding and trace eligibility "
                "must not be dropped to save bytes. Use full and let P4 implement bounded paging."
            )
        read_kwargs = {"snapshot_id": arguments["snapshot_id"],
                       "perspective": arguments.get("perspective", "snapshot_contents"),
                       "at": arguments.get("at"), "subject": arguments.get("subject"),
                       "include_history": bool(arguments.get("include_history", False))}
        if read_kwargs["perspective"] == "system_held_at":
            read_kwargs["held_scope"] = arguments.get("held_scope")
            read_kwargs["usable_stage"] = arguments.get("usable_stage")
        read = service.read(arguments.get("product_id"), **read_kwargs)
        # Pass the service's actual public projection through unchanged.  Do not rebuild it:
        # public_projection (partial contract bodies, projection_digest, original contract_ref),
        # source_ids, full public products/contracts/units and full row evidence/eligibility
        # are all part of the contract with BD.
        result = dict(read)
        result["product_count"] = len(read.get("products", []))
        result["row_count"] = len(read.get("rows", []))
        result["row_projection"] = "full"
        result["row_projection_note"] = "no row or product fields dropped; service public projection passed through"
        result["service_identity"] = service_identity
    elif operation == "resolve_write_target":
        _exact(arguments, {"dataset_id", "snapshot_id"}, {"dataset_id"})
        service.require_permission("read")
        result = service.resolve_write_target(
            arguments["dataset_id"], arguments.get("snapshot_id"))
        result["service_identity"] = service_identity
    elif operation == "register_write_target":
        _exact(arguments, {"dataset_id", "product_id", "definition_ref", "reason",
                           "snapshot_id"}, {"dataset_id", "product_id"})
        result = service.register_write_target(
            arguments["dataset_id"], arguments["product_id"],
            definition_ref=arguments.get("definition_ref"),
            reason=arguments.get("reason") or "explicit registration",
            snapshot_id=arguments.get("snapshot_id"))
        result["service_identity"] = service_identity
    elif operation == "resolve_adjustment_anchor":
        _exact(arguments, {"dataset_id", "anchor_ref", "anchor_id", "version"},
               {"dataset_id"})
        service.require_permission("read")
        if arguments.get("anchor_ref") is None and arguments.get("anchor_id") is None:
            raise ValueError("REQUEST_INVALID:anchor_ref or anchor_id is required")
        result = service.resolve_adjustment_anchor(
            arguments["dataset_id"], anchor_ref=arguments.get("anchor_ref"),
            anchor_id=arguments.get("anchor_id"), version=arguments.get("version"))
        result["service_identity"] = service_identity
    elif operation == "register_adjustment_anchor":
        _exact(arguments, {"dataset_id", "anchor_id", "method", "basis_at",
                           "basis_price_ref", "applicability", "corporate_action_cutoff",
                           "instrument_scope", "status", "supersedes", "reason"},
               {"dataset_id", "anchor_id", "method", "basis_at", "basis_price_ref",
                "applicability", "corporate_action_cutoff"})
        result = service.register_adjustment_anchor(
            arguments["dataset_id"], arguments["anchor_id"],
            method=arguments["method"], basis_at=arguments["basis_at"],
            basis_price_ref=arguments["basis_price_ref"],
            applicability=arguments["applicability"],
            corporate_action_cutoff=arguments["corporate_action_cutoff"],
            instrument_scope=arguments.get("instrument_scope"),
            status=arguments.get("status") or "active",
            supersedes=arguments.get("supersedes"),
            reason=arguments.get("reason") or "explicit registration")
        result["service_identity"] = service_identity
    elif operation == "submit":
        _exact(arguments, {"document"}, {"document"})
        document = arguments["document"]
        request_identity = _document_identity(document)
        result = service.submit(document)
        result = {**result, "request_identity": request_identity,
                  "document_sha256": _canonical_digest(document),
                  "service_identity": service_identity}
    elif operation == "request_status":
        _exact(arguments, {"request_identity", "output_offset", "output_limit",
                           "output_detail", "row_offset", "row_limit"}, {"request_identity"})
        request_identity = arguments["request_identity"]
        if not isinstance(request_identity, dict) or request_identity.get("trusted_actor_namespace") != config["caller"]["trusted_actor_namespace"]:
            raise ValueError("REQUEST_INVALID:request_identity namespace must match the trusted connection")
        offset = _bounded_int(arguments.get("output_offset"), "output_offset", 0,
                              0, 10_000_000)
        page_limit = _bounded_int(arguments.get("output_limit"), "output_limit",
                                  DEFAULT_OUTPUT_PAGE, 1, MAX_OUTPUT_PAGE)
        detail = arguments.get("output_detail", "summary")
        row_offset = _bounded_int(arguments.get("row_offset"), "row_offset", 0, 0, 10_000_000)
        row_limit = _bounded_int(arguments.get("row_limit"), "row_limit", 256, 1, 1000)
        if detail not in {"summary", "full"}:
            raise ValueError("REQUEST_INVALID:output_detail must be summary or full")
        status = service.request_status(request_identity)
        if any(key in arguments for key in ("output_offset", "output_limit", "output_detail", "row_offset", "row_limit")):
            result = _status_view(status, request_identity, offset, page_limit, detail,
                                  row_offset=row_offset, row_limit=row_limit)
            result["service_identity"] = service_identity
        else:
            result = {**status, "service_identity": service_identity,
                      "recovery_action": _recovery_action(status.get("state"))}
    elif operation == "recovery":
        _exact(arguments, {"document"}, {"document"})
        document = arguments["document"]
        request_identity = _document_identity(document)
        prior = service.request_status(request_identity)
        if prior.get("state") == "unknown":
            raise ValueError("RECOVERY_NOT_FOUND:no persisted state for this request_identity")
        result = service.submit(document)
        result = {**result, "request_identity": request_identity,
                  "document_sha256": _canonical_digest(document),
                  "recovery": {"prior_state": prior.get("state"),
                               "prior_snapshot_id": prior.get("snapshot_id"),
                               "idempotent_replay": bool(result.get("idempotent_replay")),
                               "action": _recovery_action(prior.get("state"))},
                  "service_identity": service_identity}
    elif operation == "evidence_ingest":
        result = _evidence_ingest(service, config, arguments)
    elif operation in USAGE_OPERATIONS:
        from wfd_sdk import usage_suspension
        if operation == "usage_status":
            _exact(arguments, set(), set())
            result = usage_suspension.status(service.root)
        elif operation == "usage_audit_read":
            # 只允许固定 snapshot_contents 技术复现；不接受历史游标、知识截止或
            # 调用方自造的 audit 标记，且必须显式指定已登记事项编号。
            _exact(arguments, {"snapshot_id", "product_id", "issue_id"}, {"snapshot_id", "issue_id"})
            for forbidden in ("at", "include_history", "perspective", "row_projection"):
                if forbidden in arguments:
                    raise ValueError("USAGE_AUDIT_READ_SCOPE_INVALID")
            issue_id = arguments["issue_id"]
            if not isinstance(issue_id, str) or not issue_id:
                raise ValueError("USAGE_AUDIT_ISSUE_INVALID")
            known = usage_suspension.status(service.root)
            if not any(item["issue_id"] == issue_id for item in known["issues"]):
                raise ValueError("USAGE_AUDIT_ISSUE_NOT_FOUND")
            service._usage_audit_issue_id = issue_id
            try:
                read = service.read(arguments.get("product_id"),
                                    snapshot_id=arguments["snapshot_id"])
            finally:
                service._usage_audit_issue_id = None
            result = dict(read)
            governance = result.get("usage_governance")
            if not isinstance(governance, dict) or governance.get("audit_reproduction") is not True:
                raise ValueError("USAGE_AUDIT_READ_NOT_GOVERNED")
            result["usage_scope"] = "explicit_audit_reproduction"
            result["publishable"] = False
            result["compute_eligible"] = False
            result["service_identity"] = service_identity
        elif operation == "usage_suspend":
            result = usage_suspension.suspend(service.root, arguments.get("declaration"))
        elif operation == "usage_authorize_repair":
            result = usage_suspension.authorize_repair(service.root, arguments.get("declaration"))
        else:
            result = usage_suspension.resolve(service.root, arguments.get("declaration"))
        result = {**result, "service_identity": service_identity}
    elif operation == "query_capabilities":
        _exact(arguments, set(), set())
        result = _query(service, config).capabilities()
    elif operation in QUERY_MACHINE_OPERATIONS:
        # Caller read permission is checked before the inner request is parsed
        # or any field/product detail diagnostic can be returned.
        service.require_permission("read")
        inner = _validated_query_request(arguments, operation)
        result = _query(service, config).execute(inner)
    elif operation == "batch_begin":
        _exact(arguments, {"batch_id", "header", "expected_chunks"},
               {"batch_id", "header", "expected_chunks"})
        result = _batches(service, config).begin(
            arguments["batch_id"], header=arguments["header"],
            expected_chunks=arguments["expected_chunks"])
    elif operation == "batch_put_chunk":
        _exact(arguments, {"batch_id", "output_key", "chunk_id", "rows", "digest"},
               {"batch_id", "output_key", "chunk_id", "rows"})
        result = _batches(service, config).put_chunk(
            arguments["batch_id"], output_key=arguments["output_key"],
            chunk_id=arguments["chunk_id"], rows=arguments["rows"],
            digest=arguments.get("digest"))
    elif operation == "batch_status":
        _exact(arguments, {"batch_id", "chunk_offset", "chunk_limit"},
               {"batch_id"})
        offset = _bounded_int(arguments.get("chunk_offset"), "chunk_offset",
                              0, 0, 10_000_000)
        limit = _bounded_int(arguments.get("chunk_limit"), "chunk_limit",
                             DEFAULT_OUTPUT_PAGE, 1, MAX_OUTPUT_PAGE)
        result = _batches(service, config).status(
            arguments["batch_id"], chunk_offset=offset, chunk_limit=limit)
    elif operation == "batch_finalize":
        _exact(arguments, {"batch_id", "output_offset", "output_limit",
                           "output_detail"}, {"batch_id"})
        offset = _bounded_int(arguments.get("output_offset"), "output_offset",
                              0, 0, 10_000_000)
        limit = _bounded_int(arguments.get("output_limit"), "output_limit",
                             DEFAULT_OUTPUT_PAGE, 1, MAX_OUTPUT_PAGE)
        detail = arguments.get("output_detail", "summary")
        if detail not in {"summary", "full"}:
            raise ValueError("REQUEST_INVALID:output_detail must be summary or full")
        result = _batches(service, config).finalize(arguments["batch_id"])
        if (any(key in arguments for key in ("output_offset", "output_limit",
                                             "output_detail"))
                and result.get("request_identity") and result.get("protocol_version") != "wfd.source-minute-batch/1"):
            result = _batch_finalize_view(result, offset, limit, detail)
    elif operation == "batch_read_page":
        locator = {"snapshot_id", "product_id", "partition", "result_root"}
        _exact(arguments, locator | {"page_size", "cursor"}, locator)
        result = _batches(service, config).read_source_minute_page(**arguments)
    else:  # trace
        _exact(arguments, {"product_id", "snapshot_id"}, {"product_id", "snapshot_id"})
        result = service.trace(arguments["product_id"], snapshot_id=arguments["snapshot_id"])
        result = {**result, "service_identity": service_identity}
    response = {
        "protocol_version": MACHINE_PROTOCOL,
        "request_id": request_id,
        "operation": operation,
        "ok": True,
        "result": result,
        "error": None,
        "identity": identity,
        "service": service_identity,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }
    if operation in {"submit", "recovery", "batch_finalize"}:
        state = result.get("state") or result.get("status") or result.get("request_state")
        response["business_outcome"] = {
            "state": state, "snapshot_id": result.get("snapshot_id"),
            "published_formal": state == "published_formal",
            "request_handled": True,
            "note": "ok describes the request envelope; only business state and verified publication prove a publish",
        }
    return _fit_response(response, config["max_response_bytes"])


def _validated_query_request(arguments, outer_operation="read_product"):
    """Require one inner query whose operation exactly matches the outer one."""
    _exact(arguments, {"request"}, {"request"})
    inner = arguments["request"]
    if not isinstance(inner, dict):
        raise ValueError("REQUEST_INVALID:request must be an object")
    inner_operation = inner.get("operation")
    if (inner_operation not in EXPOSED_INNER_QUERY_OPERATIONS
            or inner_operation != outer_operation):
        raise _QueryOperationDenied(inner_operation, outer_operation)
    return inner


class _QueryOperationDenied(Exception):
    def __init__(self, operation, outer_operation="read_product"):
        super().__init__("QUERY_OPERATION_UNSUPPORTED:inner query operation " +
                         str(operation) + " must equal outer operation " +
                         str(outer_operation) + "; read_product cannot carry arbitrary queries")
        self.details = {
            "outer_operation": outer_operation,
            "inner_operation": operation,
            "exposed_inner_operations": [outer_operation],
            "all_exposed_query_operations": list(QUERY_MACHINE_OPERATIONS),
        }


class _Unsupported(Exception):
    def __init__(self, operation, request_id, identity, service):
        self.operation = operation
        self.request_id = request_id
        self.identity = identity
        self.service = service


def _capabilities(service, config, identity, service_identity):
    service_caps = service.capabilities()
    data_only = config.get("profile") == "data_only"
    exposed = list(QUERY_MACHINE_OPERATIONS) if data_only else ["read_product"]
    try:
        query_caps = _query(service, config).capabilities()
        query_scope = {
            "protocol_version": query_caps.get("protocol_version"),
            "schema_id": query_caps.get("schema_id"),
            "schema_sha256": query_caps.get("schema_sha256"),
            "schema_canonical_sha256": query_caps.get("schema_canonical_sha256"),
            "service_version": query_caps.get("service_version"),
            "supported_operations": exposed,
            "exposed_inner_operations": exposed,
            "inner_operation_enforced": True,
            "outer_inner_must_match": True,
            "read_product_cannot_bypass_other_queries": True,
            "scope": query_caps.get("scope"),
            "projection": query_caps.get("projection"),
            "pagination": query_caps.get("read_product", {}).get("pagination"),
            "budget": query_caps.get("read_product", {}).get("budget"),
            "context_operations": (
                "read_company_context/read_relation_graph/read_applicable_rules/"
                "read_event_timeline are explicitly exposed for data_only"
                if data_only else "not exposed by the legacy machine profile"),
            "trace_evidence": (
                {"supported": False,
                 "reason": "source/evidence provenance belongs to BD; data_only returns "
                           "only WFD structured data and record/version identity"}
                if data_only else
                {"supported": True, "scope": "legacy read_evidence path"}),
            "graph_operations": (
                "read_relation_graph exposed with max_depth<=3 and explicit resource bounds"
                if data_only else "not exposed by the legacy machine entry"),
        }
    except Exception as exc:
        query_scope = {"error": type(exc).__name__ + ": " + str(exc)}
    from wfd_sdk.filter_plan import capabilities as filter_capabilities
    page_caps = {name: service_caps.get("operations", {}).get(name, {}) for name in FIXED_PAGE_OPERATIONS}
    page_available = {name for name, caps in page_caps.items() if data_only and caps.get("supported") is True}
    if data_only:
        operations = {
            name: {"supported": True, "description": SUPPORTED[name]}
            for name in sorted(DATA_ONLY_OPERATIONS)
            if (name not in FIXED_PAGE_OPERATIONS or name in page_available)
            and (name != "batch_read_page" or callable(getattr(type(service), "read_source_minute_page", None)))
        }
        for name in page_available:
            operations[name].update(page_caps[name])
        unsupported = (
            [{"operation": name, "reason": "not exposed by data_only profile"}
             for name in sorted(set(SUPPORTED) - DATA_ONLY_OPERATIONS)]
            + [{"operation": name, "reason": reason}
               for name, reason in sorted(UNSUPPORTED.items())
               if name not in {"company_view", "query_graph"}]
        )
    else:
        operations = {
            name: {"supported": True, "description": SUPPORTED[name]}
            for name in sorted(set(SUPPORTED) - set(CONTEXT_QUERY_OPERATIONS) - FIXED_PAGE_OPERATIONS - {"batch_read_page"})
        }
        unsupported = (
            [{"operation": name,
              "reason": "context query is exposed only by the data_only profile"}
             for name in CONTEXT_QUERY_OPERATIONS]
            + [{"operation": name, "reason": reason}
               for name, reason in sorted(UNSUPPORTED.items())]
        )
    for name in sorted(FIXED_PAGE_OPERATIONS - page_available):
        unsupported.append({"operation": name,
                            "reason": "requires a data_only service with " + name + " capability"})
    operations["filter_objects"].update(filter_capabilities(config["protocol_root"]))
    return {
        "machine_protocol": MACHINE_PROTOCOL,
        "service_identity": service_identity,
        "profile": config.get("profile", "legacy"),
        "operations": operations,
        "unsupported": unsupported,
        "service_capabilities": service_caps,
        "query_capabilities": query_scope,
        "batch": {
            **({"source_minute": {"protocol_version": "wfd.source-minute-batch/1",
                                 "read_operation": "batch_read_page", "write_scope": "one_complete_date",
                                 "mixed_ordinary_snapshot": True,
                                 "whole_snapshot_operations": "unsupported"}}
               if callable(getattr(type(service), "read_source_minute_page", None)) else {}),
            "ledger": ("data_only: ProductBatchLedger in trusted native runtime, isolated by "
                       "instance/actor; official store is untouched until finalize"
                       if data_only else
                       "legacy: ProductBatchLedger under the official catalog path"),
            "ledger_root": ("trusted native runtime; not request-supplied and not inside the "
                            "official store" if data_only else "official store catalog path"),
            "limits": dict(config["batch_limits"]),
            "chunk_page_max": MAX_OUTPUT_PAGE,
            "chunk_content_identity": "sha256 over canonical rows; caller digest is optional and checked",
            "finalize": ("data_only: rebuilds the exact same document and always calls the same "
                         "service.submit; public status is not commit proof"
                         if data_only else
                         "legacy: reconstructs one ordinary submit document and calls WFDProductService.submit"),
            "output_pagination": "batch_finalize supports output_offset/output_limit/output_detail; "
                                 "continuation uses request_status with the original request_identity",
        },
        "service_capability_notes": [
            "service_capabilities 原样返回当前 service；其 operations 是服务包基线（read_product），",
            "data_only 的四个上下文操作由本机器入口与 query_capabilities 显式增加，实际执行仍经 ProductQuery。",
            "其 unsupported 中如仍列 external_machine_process，描述的是服务包自身（P1b 维护文件）；",
            "本机器入口已在其上提供能力探测、提交、查询与批处理，但不在本批宣称整个 P6、真实 BD 生产者/消费者闭环或 P5 包完成。",
        ],
        "process": {
            "transport": "stdin/stdout single JSON object",
            "entry": "wfd_sdk.product_machine",
            "request_identity_source": "trusted constructor configuration only",
            "role_source": ("trusted constructor configuration only; compute is an explicit "
                            "existing service role and is never granted by the request or by default"),
            "read_only": True if config.get("volume") else service.engine.read_only,
            "mode": "bounded_read_write_machine_boundary",
            "store_open": ("open_existing_read_only" if config.get("volume") or service.engine.read_only
                           else "open_existing_writable"),
            "store_initialization": "not exposed; explicit owner-authorized provisioning only",
            "write_operations": sorted(WRITE_OPERATIONS),
            "job_id": None,
            "note": "request_status 读回产品服务持久请求状态；本入口不创建异步 job，也不返回虚构 jobid。",
        },
        "connection": {
            "connection_id": config["connection_id"],
            "store": config["store"],
            "runtime": config["runtime"],
            "caller_id": identity["caller_id"],
            "trusted_actor_namespace": identity["trusted_actor_namespace"],
            "caller_roles": identity["caller_roles"],
            "source_count": len(config["sources"]),
        },
        "limits": {
            "max_request_bytes": config["max_request_bytes"],
            "max_response_bytes": config["max_response_bytes"],
            "max_evidence_bytes": config["max_evidence_bytes"],
            **{"batch_" + key: value for key, value in config["batch_limits"].items()},
        },
    }


def _write_response(response, limit):
    raw = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > limit:
        raise OverflowError("RESPONSE_TOO_LARGE")
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


def _error_response(exc, config, service, request, started):
    code, text = _service_error(exc)
    if code == "RESPONSE_TOO_LARGE":
        text = ("response exceeds the configured bounded output and was not returned "
                "as a complete result; use request_status paging or narrow the read")
    details = getattr(exc, "details", None)
    if hasattr(exc, "status") and details is None:
        details = {"batch_status": getattr(exc, "status")}
    request_id = request.get("request_id") if isinstance(request, dict) else None
    operation = request.get("operation") if isinstance(request, dict) else None
    identity = None
    service_identity = None
    if service is not None and config is not None:
        try:
            identity = _caller_identity(config, service)
            service_identity = _service_identity(service)
        except Exception:
            pass
    action = _action_for(code)
    write_context = None
    if operation in WRITE_OPERATIONS:
        try:
            write_context = _write_context(service, config, request, None)
        except Exception as context_error:
            write_context = {"operation": operation,
                             "may_have_written": True,
                             "state_query_error": type(context_error).__name__ + ": " + str(context_error)}
        action = (action + " 本操作属于写操作：不要假定未写入，也不要换新身份重投；"
                  "请用同一 request_identity/batch_id 查询真实状态后按 recovery 处理。")
    if write_context is not None:
        details = {"write_context": write_context,
                   "cause_details": details} if details else {"write_context": write_context}
    return {
        "protocol_version": MACHINE_PROTOCOL,
        "request_id": request_id if isinstance(request_id, str) else "unparsed",
        "operation": operation if isinstance(operation, str) else "unparsed",
        "ok": False,
        "result": None,
        "error": _issue(
            code, text, action=action,
            request_id=request_id if isinstance(request_id, str) else None,
            operation=operation if isinstance(operation, str) else None,
            identity=identity, service=service_identity,
            cause=type(exc).__name__ + (": " + text if text else ""),
            details=details,
        ),
        "identity": identity,
        "service": service_identity,
        "request_identity": (write_context or {}).get("request_identity"),
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="WFD product-service local process boundary")
    parser.add_argument("--config", required=True, help="absolute path to trusted machine configuration")
    args = parser.parse_args(argv)
    started = time.monotonic()
    config = None
    service = None
    request = None
    response = None
    try:
        config = _load_config(args.config)
        request = _read_json_bounded(sys.stdin.buffer, config["max_request_bytes"])
        _, operation, _ = _request_object(request)
        service = _build_service(config, operation=operation)
        response = _handle(service, config, request)
        _write_response(response, config["max_response_bytes"])
        return 0
    except _Unsupported as exc:
        _write_response({
            "protocol_version": MACHINE_PROTOCOL, "request_id": exc.request_id,
            "operation": exc.operation, "ok": False, "result": None,
            "error": _issue(
                "OPERATION_UNSUPPORTED",
                "operation " + exc.operation + " is not in this bounded process boundary",
                action=_action_for("OPERATION_UNSUPPORTED"),
                request_id=exc.request_id, operation=exc.operation,
                identity=exc.identity, service=exc.service,
                cause="supported: " + ",".join(sorted(SUPPORTED)),
            ),
            "identity": exc.identity, "service": exc.service,
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }, MAX_OUTPUT_BYTES)
        return 0
    except Exception as exc:
        limit = config["max_response_bytes"] if isinstance(config, dict) else MAX_OUTPUT_BYTES
        operation = request.get("operation") if isinstance(request, dict) else None
        response_too_large = (response is not None and _json_bytes(response) > limit)
        try:
            if response is not None and (operation in WRITE_OPERATIONS or not response_too_large):
                fallback = _output_failure_response(exc, config, service, request,
                                                    response, started)
            else:
                fallback = _error_response(exc, config, service, request, started)
        except Exception:
            fallback = {
                "protocol_version": MACHINE_PROTOCOL,
                "request_id": request.get("request_id") if isinstance(request, dict) else "unparsed",
                "operation": operation or "unparsed",
                "ok": False,
                "result": None,
                "error": {
                    "code": "PROCESS_OUTPUT_FAILED",
                    "message": ("the operation may have completed but the failure response "
                                "could not be constructed fully"),
                    "action": _action_for("PROCESS_OUTPUT_FAILED"),
                    "details": {"write_may_have_happened": operation in WRITE_OPERATIONS},
                    "retryable": False,
                },
                "request_identity": None,
            }
        if _json_bytes(fallback) > limit:
            fallback = {
                "protocol_version": MACHINE_PROTOCOL,
                "request_id": fallback.get("request_id", "unparsed"),
                "operation": fallback.get("operation", "unparsed"),
                "ok": False,
                "result": None,
                "error": {
                    "code": "PROCESS_OUTPUT_FAILED",
                    "message": "operation result could not be written; state must be queried",
                    "action": _action_for("PROCESS_OUTPUT_FAILED"),
                    "details": {"write_may_have_happened": operation in WRITE_OPERATIONS,
                                "request_identity": fallback.get("request_identity")},
                    "retryable": False,
                },
                "request_identity": fallback.get("request_identity"),
            }
        try:
            _write_response(fallback, limit)
        except Exception:
            try:
                sys.stdout.buffer.write(json.dumps({
                    "protocol_version": MACHINE_PROTOCOL, "request_id": "unparsed",
                    "operation": operation or "unparsed", "ok": False,
                    "error": {"code": "PROCESS_OUTPUT_FAILED",
                              "message": "process could not write a bounded response",
                              "action": _action_for("PROCESS_OUTPUT_FAILED"),
                              "details": {"write_may_have_happened": operation in WRITE_OPERATIONS},
                              "retryable": False},
                    "request_identity": fallback.get("request_identity"),
                }, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
                sys.stdout.buffer.flush()
            except Exception:
                pass
        return 0 if config is not None and service is not None else 2


if __name__ == "__main__":
    sys.exit(main())
