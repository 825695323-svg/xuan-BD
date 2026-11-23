"""Local data_only bundle actions. All authority and both roots belong to the host."""
import errno
import os
import re
import tempfile
from pathlib import Path

from . import product_bundle as sdk
from .product_machine import BUNDLE_ROLES, BUNDLE_WRITES, REQUEST_ID, _canonical_bundle_path as _canonical_path, _exact

SNAPSHOT = re.compile(r"s_[0-9a-f]{24}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
MAX_PRODUCTS = 64


def load_access(value, store, runtime, project, protocol):
    required = {"operations", "package_root", "dataset_id", "source_ids"}
    if not isinstance(value, dict) or not required <= value.keys() <= required | {"target_store"}:
        raise ValueError("CONFIG_INVALID:bundle_access")
    for key, allowed in (("operations", BUNDLE_ROLES), ("source_ids", None)):
        items = value[key]
        if (not isinstance(items, list) or not items or
                any(not isinstance(item, str) or not REQUEST_ID.fullmatch(item) for item in items)
                or len(set(items)) != len(items) or (allowed and not set(items) <= allowed.keys())):
            raise ValueError("CONFIG_INVALID:bundle_access." + key)
    if not isinstance(value["dataset_id"], str) or not REQUEST_ID.fullmatch(value["dataset_id"]):
        raise ValueError("CONFIG_INVALID:bundle_access.dataset_id")
    roots = [_canonical_path(os.fspath(root)) for root in (store, runtime, project, protocol)]
    package = _canonical_path(value["package_root"])
    if not package.is_dir() or (os.name == "posix" and package.stat().st_mode & 0o022):
        raise ValueError("CONFIG_UNSAFE:bundle package_root")
    controlled = [package]
    if "target_store" in value:
        target = _canonical_path(value["target_store"])
        if not target.parent.is_dir() or (target.exists() and not target.is_dir()):
            raise ValueError("CONFIG_INVALID:bundle target_store")
        controlled.append(target)
    elif set(value["operations"]) & (BUNDLE_WRITES | {"bundle_export_delta"}):
        raise ValueError("CONFIG_INVALID:bundle target_store required")
    for path in controlled:
        if any(path.is_relative_to(other) or other.is_relative_to(path) for other in roots):
            raise ValueError("CONFIG_UNSAFE:overlapping bundle roots")
        roots.append(path)
    return {**value, "package_root": str(package),
            **({"target_store": str(target)} if "target_store" in value else {})}


def _denial(config, operation):
    access = config.get("bundle_access")
    if not access or operation not in access["operations"]:
        return "WRITE_AUTHORITY_REQUIRED" if operation in BUNDLE_WRITES else "BUNDLE_OPERATION_NOT_CONFIGURED"
    for role in BUNDLE_ROLES[operation]:
        if role not in config["caller"]["roles"]:
            return "CALLER_PERMISSION_DENIED:" + role
    for source_id in access["source_ids"]:
        policy = config["sources"].get(source_id)
        if policy is None:
            return "SOURCE_NOT_ADMITTED:" + source_id
        if policy.get("may_read") is not True:
            return "SOURCE_READ_PERMISSION_MISSING:" + source_id
        if "export" in BUNDLE_ROLES[operation] and policy.get("may_export") is not True:
            return "SOURCE_EXPORT_PERMISSION_MISSING:" + source_id
    return None


def capabilities(config):
    operations = {}
    for name in BUNDLE_ROLES:
        denial = _denial(config, name)
        operations[name] = {"supported": denial is None, "writes_target": name in BUNDLE_WRITES,
                            "reason": denial.split(":")[0] if denial else None}
    return {"format_version": sdk.STRUCTURED_BUNDLE_FORMAT, "profile": sdk.STRUCTURED_PROFILE,
            "operations": operations, "max_products": MAX_PRODUCTS}


def _require_snapshot(value):
    if not isinstance(value, str) or not SNAPSHOT.fullmatch(value):
        raise ValueError("FIXED_SNAPSHOT_REQUIRED")


def _check_tree(root):
    if root.exists() and not root.is_dir():
        raise ValueError("BUNDLE_PATH_INVALID")
    for path in root.rglob("*"):
        if sdk._is_bundle_link(path) or not (path.is_dir() or path.is_file()):
            raise ValueError("BUNDLE_PATH_INVALID:non-regular bundle member")


def _export(service, access, operation, args, package):
    required = {"package_path", "snapshot_id", "products"}
    if operation == "bundle_export_delta":
        required.add("baseline_snapshot_id")
    _exact(args, required, required)
    sid, products = args["snapshot_id"], args["products"]
    _require_snapshot(sid)
    if not isinstance(products, list) or not 1 <= len(products) <= MAX_PRODUCTS:
        raise ValueError("BUNDLE_SELECTION_INVALID")
    selection = {"products": products}
    normalized = sdk._normalize_selection(selection, [])
    ids = [item["product_id"] for item in normalized["products"]]
    for item in normalized["products"]:
        fields = item["fields"] or []
        if (not REQUEST_ID.fullmatch(item["product_id"]) or len(fields) > 256
                or any(not REQUEST_ID.fullmatch(field) for field in fields)
                or any(not isinstance(v, str) or not REQUEST_ID.fullmatch(v)
                       for v in (item["subject"] or {}).values())):
            raise ValueError("BUNDLE_SELECTION_INVALID")
        period = item["business_time_range"]
        if period is not None:
            keys = {"role", "start", "end", "timezone"}
            if not isinstance(period, dict) or set(period) != keys or not all(isinstance(v, str) for v in period.values()):
                raise ValueError("BUNDLE_SELECTION_INVALID:business_time_range")
    # A data_only store carries no external source declarations. The host
    # binds the admitted sources to a dataset; verify the real fixed bindings.
    snapshot = sdk._bundle_snapshot(service.engine, sid)
    selected = set(ids)
    found = set()
    for entry in snapshot["files"]:
        if entry["product_id"] not in selected:
            continue
        binding = sdk._entry_binding(entry)
        if (binding["product"]["dataset_id"] != access["dataset_id"]
                or entry["source_bundle"].get("_wfd_data_only") is not True
                or binding.get("source_role_mode") != "data_only"):
            raise ValueError("SOURCE_NOT_ADMITTED:fixed product binding")
        found.add(entry["product_id"])
    if found != selected:
        raise ValueError("STRUCTURED_PRODUCT_NOT_FOUND")
    options = {"snapshot_id": sid, "selection": selection}
    if operation == "bundle_export_delta":
        _require_snapshot(args["baseline_snapshot_id"])
        baseline = _canonical_path(access["target_store"])
        _check_tree(baseline)
        options.update(baseline_store=baseline, baseline_snapshot_id=args["baseline_snapshot_id"])
    export = {"bundle_export_full": sdk.export_structured_bundle,
              "bundle_export_delta": sdk.export_structured_delta_bundle,
              "bundle_export_reference": sdk.export_structured_reference_bundle}[operation]
    # Publish only a completely verified directory. Recovery never overwrites
    # an existing package, including one created by a concurrent request.
    with tempfile.TemporaryDirectory(dir=package.parent, prefix=".bundle-") as staging:
        staged = Path(staging) / "package"
        descriptor = export(service, ids, staged, **options)
        if descriptor["source_dataset_id"] != access["dataset_id"]:
            raise ValueError("SOURCE_NOT_ADMITTED:dataset")
        digest = "sha256:" + sdk.sha_file(staged / "financial_bundle.json")
        summary = {**_summary(descriptor, digest), "status": "exported"}
        if not package.exists():
            try:
                staged.rename(package)
                return summary
            except OSError as exc:
                if exc.errno not in {errno.EEXIST, errno.ENOTEMPTY}:
                    raise
        # Reconcile a lost acknowledgement only against a freshly generated,
        # identical descriptor and a fully verified existing physical package.
        _check_tree(package)
        verify = {"full": sdk._verify_structured_bundle, "delta": sdk._verify_structured_delta_bundle,
                  "reference": sdk._verify_structured_reference_bundle}[descriptor["mode"]]
        if not (package / "financial_bundle.json").is_file():
            raise ValueError("BUNDLE_DESTINATION_EXISTS")
        verify(package, digest, **({"baseline_store": baseline} if descriptor["mode"] == "delta" else {}))
        return {**summary, "status": "already_exported"}


def _summary(descriptor, digest):
    reads = descriptor.get("included_reads") or descriptor.get("external_objects") or []
    if not 1 <= len(reads) <= MAX_PRODUCTS:
        raise ValueError("BUNDLE_SELECTION_INVALID:product count")
    products = [{"product_id": item.get("target_product_id") or item["product_id"],
                 "source_product_id": item.get("source_product_id") or item["product_id"],
                 "row_count": item["row_count"], "rows_sha256": item["rows_sha256"]} for item in reads]
    for p in products:
        if (not all(isinstance(p[k], str) and REQUEST_ID.fullmatch(p[k]) for k in ("product_id", "source_product_id"))
                or type(p["row_count"]) is not int or p["row_count"] < 0
                or not isinstance(p["rows_sha256"], str) or not DIGEST.fullmatch(p["rows_sha256"])):
            raise ValueError("STRUCTURED_READ_PROOF_INVALID")
    return {"format_version": descriptor["format_version"], "mode": descriptor["mode"],
            "bundle_id": descriptor.get("bundle_id") or descriptor["reference_id"],
            "descriptor_sha256": digest, "source_snapshot_id": descriptor["source_snapshot_id"],
            "source_dataset_id": descriptor["source_dataset_id"],
            "baseline_snapshot_id": (descriptor.get("baseline") or {}).get("target_snapshot_id"),
            "target_snapshot_id": descriptor.get("target_snapshot_id"), "products": products,
            "source_permission_required": descriptor["source_permission_required"],
            "read_self_contained": descriptor["read_self_contained"], "write_authority_granted": False}


def dispatch(service, config, operation, args):
    service.require_permission("read")
    if operation == "bundle_capabilities":
        _exact(args, set(), set())
        return capabilities(config)
    denial = _denial(config, operation)
    if denial:
        raise ValueError(denial)
    for role in BUNDLE_ROLES[operation]:
        service.require_permission(role)
    access = config["bundle_access"]
    root = _canonical_path(access["package_root"])
    package = _canonical_path(args.get("package_path"))
    if package.parent != root or not NAME.fullmatch(package.name):
        raise ValueError("BUNDLE_PATH_INVALID:outside package_root")
    if operation not in BUNDLE_WRITES:
        return _export(service, access, operation, args, package)
    _exact(args, {"package_path", "descriptor_sha256"}, {"package_path", "descriptor_sha256"})
    digest = args["descriptor_sha256"]
    if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
        raise ValueError("REQUEST_INVALID:descriptor_sha256")
    _check_tree(package)
    descriptor = sdk._structured_descriptor(package, digest)
    if descriptor["source_dataset_id"] != access["dataset_id"]:
        raise ValueError("SOURCE_NOT_ADMITTED:dataset")
    mode = {"bundle_import_full": "full", "bundle_apply_delta": "delta", "bundle_register_reference": "reference"}[operation]
    if descriptor.get("mode") != mode:
        raise ValueError("STRUCTURED_BUNDLE_PROFILE_INVALID")
    _require_snapshot(descriptor.get("source_snapshot_id"))
    if mode != "reference":
        _require_snapshot(descriptor.get("target_snapshot_id"))
    if mode == "delta":
        _require_snapshot(descriptor["baseline"]["target_snapshot_id"])
    # Validate the response projection before allowing any target write.
    summary = _summary(descriptor, digest)
    target = _canonical_path(access["target_store"])
    runtime = _canonical_path(str(Path(config["runtime"]) / "structured-bundle-target"))
    _check_tree(target)
    options = {"runtime_root": runtime, "protocol_root": config["protocol_root"],
               "caller_roles": {"read"}, "expected_sha256": digest, "require_detached": True}
    if mode == "full":
        _, report = sdk.import_structured_bundle(package, target, **options)
    elif mode == "delta":
        report = sdk.apply_structured_delta_bundle(package, target, **options)
    else:
        _, report = sdk.register_structured_reference_bundle(
            package, target, resolvers={access["dataset_id"]: service}, **options)
    summary.update({k: report[k] for k in ("status", "instance_id", "active_head", "readable") if k in report})
    if mode == "reference":
        summary["dependency_gaps"] = [{"product_id": gap["product_id"], "reason": gap["gap"]}
                                      for gap in report["dependency_gaps"]]
    return summary
