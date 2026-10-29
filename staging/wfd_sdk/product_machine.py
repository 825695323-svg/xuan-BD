#!/usr/bin/env python3
"""Public local process boundary for the WFD product service.

The adapter is deliberately thin: every business decision remains in
``WFDProductService``.  This module only reads one bounded JSON request from
stdin, builds the service from a trusted constructor configuration supplied on
the command line, and writes one JSON response to stdout.

The request may choose an operation and its fixed arguments.  It can never
grant itself a caller role, a trusted actor namespace, a source permission, a
unit definition, a store or a runtime root; those come only from the trusted
configuration file.  This process is read-only: submit, package and export are
reported as unsupported until their P3/P5 contracts are implemented.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

MACHINE_PROTOCOL = "wfd.product-machine/0.1"
MACHINE_CONFIG_PROTOCOL = "wfd.product-machine-config/0.1"
MAX_INPUT_BYTES = 1_048_576
MAX_OUTPUT_BYTES = 33_554_432
REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
CONNECTION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

SUPPORTED = {
    "capabilities": "机器入口与服务能力；版本字段直接取自当前运行服务。",
    "contract_discovery": "按固定 snapshot_id 发现实际产品与已绑定合同。",
    "fixed_read": "按固定 snapshot_id 读取真实产品行，不使用 latest/current。",
    "request_status": "按原 request_identity 读回产品服务持久状态。",
    "trace": "读取固定定义、合同与已保管证据核验位置。",
}
UNSUPPORTED = {
    "submit": "P3 提交合同尚未完成；本入口不接受提交，不能把注册或旧 generic-transport 当提交。",
    "packages": "P5 包合同尚未完成；不支持导入/导出金融产品包。",
    "export": "导出需要 P3/P5 的独立来源与调用者授权，本入口不开放。",
    "redistribute": "再分发未获授权，本入口不开放。",
    "company_view": "公司关联视图尚未纳入本批公开进程边界；后续按 P3 合同补充。",
    "calendar_read": "日历专用读取尚未纳入本批公开进程边界；可用 fixed_read + product_id 读取，后续按 P3 合同补充。",
}

_CODE_PREFIX = re.compile(r"^([A-Z][A-Z0-9_]{2,})(?::|$)")


def _issue(code, message, *, action, request_id=None, operation=None, identity=None,
           service=None, cause=None):
    return {
        "code": code,
        "message": message,
        "action": action,
        "request_id": request_id,
        "operation": operation,
        "identity": identity,
        "service": service,
        "cause": cause,
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
    if code in {"REQUEST_INVALID", "REQUEST_JSON_INVALID", "REQUEST_TOO_LARGE"}:
        return "请按 wfd.product-machine/0.1 发送一个 JSON 对象；权限和身份不能放在请求里。"
    if code in {"CONFIG_INVALID", "CONFIG_NOT_FOUND", "CONFIG_UNSAFE"}:
        return "请由受控连接提供绝对、受保护的配置路径；不要手改运行库或把路径写入源码。"
    if code == "SERVICE_IMPORT_FAILED":
        return "请用已安装 duckdb/jsonschema/thrift 等运行依赖的 Python 启动同一 WFD 产品开发目录。"
    if code == "RESPONSE_TOO_LARGE":
        return "请缩小读取范围或使用 row_projection=compact；不要截断后声称完整读回。"
    return "请检查请求参数和受控连接配置；本进程没有写入任何数据。"


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
    for key in ("store", "runtime", "project_root", "protocol_root"):
        value = config.get(key)
        if not isinstance(value, str) or not value:
            raise ValueError("CONFIG_INVALID:" + key)
        if not Path(value).is_absolute():
            raise ValueError("CONFIG_INVALID:" + key + " must be absolute")
    store = Path(config["store"]).resolve()
    runtime = Path(config["runtime"]).resolve()
    project_root = Path(config["project_root"]).resolve()
    protocol_root = Path(config["protocol_root"]).resolve()
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
        raise ValueError("CONFIG_INVALID:caller")
    if not isinstance(caller.get("caller_id"), str) or not caller["caller_id"]:
        raise ValueError("CONFIG_INVALID:caller_id")
    if not isinstance(caller.get("trusted_actor_namespace"), str) or not caller["trusted_actor_namespace"]:
        raise ValueError("CONFIG_INVALID:trusted_actor_namespace")
    roles = caller.get("roles")
    if not isinstance(roles, list) or any(not isinstance(role, str) or not role for role in roles):
        raise ValueError("CONFIG_INVALID:caller roles")
    extra_roles = sorted(set(roles) - {"read", "read_evidence"})
    if extra_roles:
        raise ValueError("CONFIG_INVALID:read-only entry cannot use roles " + ",".join(extra_roles))
    sources = config.get("sources")
    if not isinstance(sources, dict) or not sources:
        raise ValueError("CONFIG_INVALID:sources")
    for source_id, policy in sources.items():
        if not isinstance(source_id, str) or not source_id or not isinstance(policy, dict):
            raise ValueError("CONFIG_INVALID:sources")
        forbidden = sorted(flag for flag in ("may_submit", "may_publish_formal", "may_export",
                                            "may_export_evidence", "may_redistribute")
                           if policy.get(flag) is True)
        if forbidden:
            raise ValueError("CONFIG_INVALID:read-only entry cannot grant " + source_id + ":" + ",".join(forbidden))
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
    return {
        **config,
        "store": str(store),
        "runtime": str(runtime),
        "project_root": str(project_root),
        "protocol_root": str(protocol_root),
        "max_request_bytes": max_input,
        "max_response_bytes": max_output,
    }


def _build_service(config):
    sys.path.insert(0, config["project_root"])
    try:
        from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
        from wfd_sdk.product_service import WFDProductService
    except Exception as exc:
        raise RuntimeError("SERVICE_IMPORT_FAILED:" + type(exc).__name__ + ": " + str(exc)) from exc
    engine = WFDDuckDBPrototype(
        Path(config["store"]), load_protocol_validator(Path(config["protocol_root"])),
        runtime_root=Path(config["runtime"]), sandbox=False,
        writer_host=config["caller"]["caller_id"],
    )
    service = WFDProductService(
        engine,
        allowed_sources=config["sources"],
        can_register=False,
        caller_roles=config["caller"]["roles"],
        caller_id=config["caller"]["caller_id"],
        unit_registry=config["units"],
        trusted_actor_namespaces={config["caller"]["trusted_actor_namespace"]},
    )
    return service


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
        "definition_ref": product.get("definition_ref"),
    }


def _handle(service, config, request):
    request_id, operation, arguments = _request_object(request)
    identity = _caller_identity(config, service)
    service_identity = _service_identity(service)
    started = time.monotonic()
    if operation not in SUPPORTED:
        raise _Unsupported(operation, request_id, identity, service_identity)
    if operation == "capabilities":
        _exact(arguments, set(), set())
        result = _capabilities(service, config, identity, service_identity)
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
    elif operation == "fixed_read":
        _exact(arguments, {"snapshot_id", "product_id", "perspective", "at", "subject",
                           "include_history", "row_projection"}, {"snapshot_id"})
        projection = arguments.pop("row_projection", "full")
        if projection != "full":
            raise ValueError(
                "REQUEST_INVALID:row_projection=compact removed; the public projection, "
                "contract/unit definitions, evidence_refs/source_binding and trace eligibility "
                "must not be dropped to save bytes. Use full and let P4 implement bounded paging."
            )
        read = service.read(
            arguments.get("product_id"),
            snapshot_id=arguments["snapshot_id"],
            perspective=arguments.get("perspective", "snapshot_contents"),
            at=arguments.get("at"),
            subject=arguments.get("subject"),
            include_history=bool(arguments.get("include_history", False)),
        )
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
    elif operation == "request_status":
        _exact(arguments, {"request_identity"}, {"request_identity"})
        request_identity = arguments["request_identity"]
        if not isinstance(request_identity, dict) or request_identity.get("trusted_actor_namespace") != config["caller"]["trusted_actor_namespace"]:
            raise ValueError("REQUEST_INVALID:request_identity namespace must match the trusted connection")
        result = service.request_status(request_identity)
        result = {**result, "service_identity": service_identity}
    else:  # trace
        _exact(arguments, {"product_id", "snapshot_id"}, {"product_id", "snapshot_id"})
        result = service.trace(arguments["product_id"], snapshot_id=arguments["snapshot_id"])
        result = {**result, "service_identity": service_identity}
    return {
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


class _Unsupported(Exception):
    def __init__(self, operation, request_id, identity, service):
        self.operation = operation
        self.request_id = request_id
        self.identity = identity
        self.service = service


def _capabilities(service, config, identity, service_identity):
    service_caps = service.capabilities()
    return {
        "machine_protocol": MACHINE_PROTOCOL,
        "service_identity": service_identity,
        "operations": {
            name: {"supported": True, "description": SUPPORTED[name]}
            for name in sorted(SUPPORTED)
        },
        "unsupported": [
            {"operation": name, "reason": reason}
            for name, reason in sorted(UNSUPPORTED.items())
        ],
        "service_capabilities": service_caps,
        "service_capability_notes": [
            "service_capabilities 原样返回当前 service；其 unsupported 中如仍列 external_machine_process，",
            "描述的是服务包自身（P1b 维护文件），本机器入口已在其上提供能力探测与固定读取，",
            "但不在本批宣称整个 P6 或正式联调通过。",
        ],
        "process": {
            "transport": "stdin/stdout single JSON object",
            "entry": "wfd_sdk.product_machine",
            "request_identity_source": "trusted constructor configuration only",
            "read_only": True,
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
        text = "response exceeds the configured bounded output; use row_projection=compact"
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
    return {
        "protocol_version": MACHINE_PROTOCOL,
        "request_id": request_id if isinstance(request_id, str) else "unparsed",
        "operation": operation if isinstance(operation, str) else "unparsed",
        "ok": False,
        "result": None,
        "error": _issue(
            code, text, action=_action_for(code),
            request_id=request_id if isinstance(request_id, str) else None,
            operation=operation if isinstance(operation, str) else None,
            identity=identity, service=service_identity,
            cause=type(exc).__name__ + (": " + text if text else ""),
        ),
        "identity": identity,
        "service": service_identity,
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
    try:
        config = _load_config(args.config)
        service = _build_service(config)
        request = _read_json_bounded(sys.stdin.buffer, config["max_request_bytes"])
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
        response = _error_response(exc, config, service, request, started)
        try:
            _write_response(response, MAX_OUTPUT_BYTES)
        except Exception:
            sys.stdout.write(json.dumps({
                "protocol_version": MACHINE_PROTOCOL, "request_id": "unparsed",
                "operation": "unparsed", "ok": False,
                "error": {"code": "PROCESS_OUTPUT_FAILED", "message": "process could not serialise a bounded response",
                          "action": "check the WFD process log", "retryable": False},
            }) + "\n")
        return 0 if config is not None and service is not None else 2


if __name__ == "__main__":
    sys.exit(main())
