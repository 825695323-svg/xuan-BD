"""Shared validation, immutable catalogs, and fixed pages for indexed bulk batches."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import re

from .duckdb_sdk import canonical, sha

from . import source_minute_batch as legacy, tabular_batch as tabular

PROTOCOLS = (legacy.PROTOCOL, tabular.PROTOCOL)
SNAPSHOT_FORMATS = (legacy.SNAPSHOT_FORMAT, tabular.SNAPSHOT_FORMAT)
SNAPSHOT_PREFIXES = tuple(version + ":" for version in SNAPSHOT_FORMATS)
ROOT_FIELDS = ("source_minute_root", "tabular_root")


def adapter(protocol):
    if protocol == legacy.PROTOCOL:
        return legacy
    if protocol == tabular.PROTOCOL:
        return tabular
    raise ValueError("BULK_PROTOCOL_INVALID")


def protocol_for_snapshot(snapshot):
    return PROTOCOLS[SNAPSHOT_FORMATS.index(snapshot["format_version"])]


def storage_namespace(protocol):
    return adapter(protocol).STORAGE_NAMESPACE


def root_field(protocol):
    return ROOT_FIELDS[PROTOCOLS.index(protocol)]


def index_roots(snapshot):
    if not snapshot:
        return {}
    roots = {key: snapshot[key] for key in ROOT_FIELDS if snapshot.get(key) is not None}
    if snapshot.get("format_version") in SNAPSHOT_FORMATS:
        roots[root_field(protocol_for_snapshot(snapshot))] = snapshot["root"]
    return roots


def root_nodes(snapshot):
    roots = index_roots(snapshot)
    for protocol, field in zip(PROTOCOLS, ROOT_FIELDS, strict=True):
        if ref := roots.get(field):
            yield protocol, ref


def indexed_products(root, snapshot):
    products = {}
    for protocol, ref in root_nodes(snapshot):
        children = branch(root, ref, "catalog", protocol=protocol)
        if products.keys() & children.keys():
            raise ValueError("BULK_PRODUCT_OVERLAP")
        products.update({pid: (protocol, ref) for pid, ref in children.items()})
    return products


MAX_ROWS = 2_000_000
MAX_CHUNKS = 512
MAX_CHUNK_ROWS = 20_000
MAX_CHUNK_BYTES = 4 * 1024 * 1024
MAX_STAGED_BYTES = 768 * 1024 * 1024
MAX_PART_ROWS = 50_000
MAX_PART_INPUT_BYTES = 16 * 1024 * 1024
MAX_NODE_BYTES = 1024 * 1024
MAX_FANOUT = 4096
MAX_PAGE_ROWS = 5000
MAX_PAGE_BYTES = 768 * 1024
_DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")
_DATE = re.compile(r"[0-9]{8}\Z")
_MINUTE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:00\Z")
_SID = re.compile(r"s_[a-f0-9]{24}\Z")
_PID = re.compile(r"p_[a-f0-9]{24}\Z")
_CODE = re.compile(r"[A-Za-z][A-Za-z0-9_.:-]{0,127}\Z")


def digest(value):
    return "sha256:" + sha(canonical(value))


def _matches(regex, value):
    return isinstance(value, str) and regex.fullmatch(value) is not None


def _exact(value, fields, code):
    if not isinstance(value, dict) or set(value) != set(fields.split()):
        raise ValueError(code)


def header_identity(header):
    identity = dict(header["request_identity"])
    identity.pop("submission_digest", None)
    return digest({**header, "request_identity": identity})


def validate_header(batch_id, header, chunks):
    profile = adapter(header.get("protocol_version"))
    _exact(header, "protocol_version request_identity producer_namespace expected_parent_snapshot_id outputs field_codes partition row_count rows_digest"
           + (" table_contract" if profile is tabular else ""), "BULK_HEADER_INVALID")
    identity = header["request_identity"]
    _exact(identity, "dataset_id trusted_actor_namespace request_id submission_digest", "BULK_IDENTITY_INVALID")
    if (identity["request_id"] != batch_id
            or not all(isinstance(identity[key], str) and 0 < len(identity[key]) <= 256
                       for key in ("dataset_id", "trusted_actor_namespace", "request_id"))
            or identity["submission_digest"] != header_identity(header)
            or not _matches(_DIGEST, header["rows_digest"])):
        raise ValueError("BULK_IDENTITY_INVALID")
    parent = header["expected_parent_snapshot_id"]
    if parent is not None and not _matches(_SID, parent):
        raise ValueError("BULK_PARENT_INVALID")
    profile.validate_contract(header)
    outputs = header["outputs"]
    if not isinstance(outputs, list) or len(outputs) != 1 or not isinstance(outputs[0], dict):
        raise ValueError("BULK_OUTPUT_INVALID")
    output = outputs[0]
    if (output.get("payload") != {"kind": "tabular_rows"} or output.get("logical_domain") != "observations"
            or output.get("input_mode") != "partial_observation" or output.get("revisions")
            or not isinstance(output.get("subject"), dict) or output["subject"].get("kind") != "entity"):
        raise ValueError("BULK_OUTPUT_SCOPE_INVALID")
    if (type(header["row_count"]) is not int or not 1 <= header["row_count"] <= MAX_ROWS
            or not isinstance(chunks, list) or not 1 <= len(chunks) <= MAX_CHUNKS):
        raise ValueError("BULK_LIMIT_EXCEEDED:rows or chunks")
    chunk_ids = set()
    total = 0
    for ordinal, item in enumerate(chunks):
        _exact(item, "chunk_id ordinal row_count digest", "BULK_CHUNK_DECLARATION_INVALID")
        if (type(item["ordinal"]) is not int or item["ordinal"] != ordinal
                or not isinstance(item["chunk_id"], str) or not 0 < len(item["chunk_id"]) <= 128
                or item["chunk_id"] in chunk_ids or not _matches(_DIGEST, item["digest"])
                or type(item["row_count"]) is not int or not 1 <= item["row_count"] <= MAX_CHUNK_ROWS):
            raise ValueError("BULK_CHUNK_DECLARATION_INVALID")
        total += item["row_count"]
        chunk_ids.add(item["chunk_id"])
    if total != header["row_count"]:
        raise ValueError("BULK_ROW_COUNT_MISMATCH")


def cell_matrix(rows, declaration, width):
    if (not isinstance(rows, list) or len(rows) != declaration["row_count"]
            or not all(isinstance(row, list) and len(row) == width
                       and all(cell is None or isinstance(cell, str) for cell in row) for row in rows)):
        raise ValueError("BULK_CHUNK_ROWS_INVALID")
    raw = canonical(rows)
    if len(raw) > MAX_CHUNK_BYTES:
        raise ValueError("BULK_LIMIT_EXCEEDED:chunk bytes")
    if "sha256:" + sha(raw) != declaration["digest"]:
        raise ValueError("BULK_CHUNK_DIGEST_MISMATCH")
    return raw


@lru_cache(maxsize=2048)
def observation_bounds(minute, source_timezone):
    from zoneinfo import ZoneInfo
    try:
        local = datetime.strptime(minute, "%Y-%m-%d %H:%M:%S").replace(tzinfo=ZoneInfo(source_timezone))
        start = local.astimezone(timezone.utc)
        end = start + timedelta(minutes=1)
    except (ValueError, OverflowError) as exc:
        raise ValueError("BULK_ROW_TIME_INVALID") from exc
    if (start.astimezone(local.tzinfo).replace(tzinfo=None) != local.replace(tzinfo=None)
            or local.replace(fold=1).utcoffset() != local.utcoffset()):
        raise ValueError("BULK_ROW_TIME_AMBIGUOUS")
    return start.strftime("%Y-%m-%dT%H:%M:%SZ"), end.strftime("%Y-%m-%dT%H:%M:%SZ")


def semantic_row(header, cells):
    return adapter(header["protocol_version"]).semantic_row(header, cells)


def record_version(header, product_id, row):
    from .product_service import append_revision_id
    output = header["outputs"][0]
    return append_revision_id(product_id, row, output["input_mode"], None,
                              header["request_identity"]["submission_digest"][7:], output["output_key"])


def node_relative(ref, *, protocol=legacy.PROTOCOL):
    if not _matches(_DIGEST, ref):
        raise ValueError("BULK_NODE_REFERENCE_INVALID")
    namespace = storage_namespace(protocol)
    return f"catalog/product_service/{namespace}/nodes/{ref[7:]}.json"


def checked_path(root, rel):
    path = Path(root)
    for part in rel.split("/"):
        if not part or part in {".", ".."} or "\\" in part:
            raise ValueError("BULK_PATH_INVALID")
        path = path / part
        if path.is_symlink():
            raise ValueError("BULK_PATH_SYMLINK")
    if not path.is_file():
        raise ValueError("BULK_OBJECT_MISSING:" + rel)
    return path


def read_node(root, ref, kind, *, protocol=legacy.PROTOCOL):
    path = checked_path(root, node_relative(ref, protocol=protocol))
    with path.open("rb") as stream:
        raw = stream.read(MAX_NODE_BYTES + 1)
    if len(raw) > MAX_NODE_BYTES or "sha256:" + sha(raw) != ref:
        raise ValueError("BULK_NODE_DIGEST_MISMATCH")
    value = json.loads(raw)
    if not isinstance(value, dict) or value.get("kind") != kind or canonical(value) != raw:
        raise ValueError("BULK_NODE_KIND_INVALID")
    if kind not in {"date", "partition"}:
        children = value.get("children")
        if (not isinstance(children, dict) or len(children) > MAX_FANOUT
                or not all(_matches(_DIGEST, child) for child in children.values())):
            raise ValueError("BULK_NODE_FANOUT_INVALID")
    return value


def write_node(value, write, *, protocol=legacy.PROTOCOL):
    raw = canonical(value)
    if len(raw) > MAX_NODE_BYTES or len(value.get("children", ())) > MAX_FANOUT:
        raise ValueError("BULK_NODE_LIMIT")
    ref = "sha256:" + sha(raw)
    write(node_relative(ref, protocol=protocol), raw)
    return ref


def branch(root, ref, kind, *, protocol=legacy.PROTOCOL):
    return read_node(root, ref, kind, protocol=protocol)["children"] if ref else {}


def partition_keys(value, protocol):
    if adapter(protocol) is tabular:
        key = sha(canonical(value))
        return key[:2], key, "bucket", "partition"
    return value[:4], value, "year", "date"


def partition_path(root, ref, product_id, value, *, protocol=legacy.PROTOCOL):
    bucket, _, kind, _ = partition_keys(value, protocol)
    products = branch(root, ref, "catalog", protocol=protocol)
    buckets = branch(root, products.get(product_id), "product", protocol=protocol)
    leaves = branch(root, buckets.get(bucket), kind, protocol=protocol)
    return products, buckets, leaves


def put_partition(write, branches, product, value, leaf_ref, *, protocol=legacy.PROTOCOL, contract_digest=None):
    products, buckets, leaves = branches
    product_id = product["product_id"]
    bucket, key, kind, _ = partition_keys(value, protocol)
    bucket_ref = write_node({"kind": kind, "children": {**leaves, key: leaf_ref}}, write, protocol=protocol)
    product_ref = write_node({"kind": "product", "product": product,
                              "children": {**buckets, bucket: bucket_ref},
                              **({"table_contract_digest": contract_digest} if contract_digest is not None else {})},
                             write, protocol=protocol)
    return write_node({"kind": "catalog", "children": {**products, product_id: product_ref}}, write, protocol=protocol)


def write_part(engine, cells, *, width, protocol):
    import io
    import pyarrow as pa
    import pyarrow.parquet as pq

    fields = [f"cell_{i}" for i in range(width)]
    table = pa.Table.from_arrays([pa.array(column, type=pa.string()) for column in zip(*cells, strict=True)], names=fields)
    dest = io.BytesIO()
    pq.write_table(table, dest, compression="zstd", row_group_size=4096)
    raw = dest.getvalue()
    checksum = sha(raw)
    rel = part_relative(checksum, protocol=protocol)
    engine._write_immutable(rel, raw)
    return {"sha256": checksum, "size": len(raw), "row_count": len(cells)}


def part_relative(checksum, *, protocol=legacy.PROTOCOL):
    if not isinstance(checksum, str) or not _matches(_DIGEST, "sha256:" + checksum):
        raise ValueError("BULK_PART_REFERENCE_INVALID")
    namespace = storage_namespace(protocol)
    return f"observations/{namespace}/part-{checksum}.parquet"


def checked_part(root, part, *, protocol=legacy.PROTOCOL):
    from .volume_publication import sha256_file

    path = checked_path(root, part_relative(part["sha256"], protocol=protocol))
    if path.stat().st_size != part["size"] or sha256_file(path) != part["sha256"]:
        raise ValueError("BULK_PART_DIGEST_MISMATCH")
    return path


def verify_part_bytes(root, leaf):
    for part in leaf["parts"]:
        checked_part(root, part, protocol=leaf["header"]["protocol_version"])


def part_rows(root, part, start=0, *, width, protocol):
    import pyarrow.parquet as pq

    path = checked_part(root, part, protocol=protocol)
    file = pq.ParquetFile(path)
    fields = [f"cell_{i}" for i in range(width)]
    if (file.schema_arrow.names != fields or file.metadata.num_rows != part["row_count"]
            or any(str(field.type) != "string" for field in file.schema_arrow)):
        raise ValueError("BULK_PART_SCHEMA_INVALID")
    offset = 0
    for group in range(file.num_row_groups):
        count = file.metadata.row_group(group).num_rows
        if offset + count <= start:
            offset += count
            continue
        for batch in file.iter_batches(batch_size=4096, row_groups=[group]):
            cols = [batch.column(i).to_pylist() for i in range(width)]
            for cells in zip(*cols, strict=True):
                if offset >= start:
                    yield list(cells)
                offset += 1


def verify_partition(root, leaf):
    count = 0
    content = hashlib.sha256()
    identity = hashlib.sha256()
    last_order = None
    for part in leaf["parts"]:
        for cells in part_rows(root, part, width=len(leaf["header"]["field_codes"]), protocol=leaf["header"]["protocol_version"]):
            order, row = semantic_row(leaf["header"], cells)
            if last_order is not None and order <= last_order:
                raise ValueError("BULK_ROW_ORDER_OR_DUPLICATE")
            last_order = order
            content.update(canonical(cells) + b"\n")
            version = record_version(leaf["header"], leaf["product"]["product_id"], row)
            identity.update(canonical([row["business_key"], version]) + b"\n")
            count += 1
    if (count != leaf["header"]["row_count"] or "sha256:" + content.hexdigest() != leaf["header"]["rows_digest"]
            or "sha256:" + identity.hexdigest() != leaf["identities_digest"]):
        raise ValueError("BULK_FIXED_READBACK_MISMATCH")
    return count


def snapshot_relative(sid):
    if not _matches(_SID, sid):
        raise ValueError("BULK_SNAPSHOT_ID_INVALID")
    return f"catalog/snapshots/{sid}.json"


def has_bulk_marker(root, sid):
    if not _matches(_SID, sid):
        return False
    path = Path(root) / f"catalog/commits/{sid}.json"
    if not path.is_file():
        return False
    if path.is_symlink() or path.stat().st_size > MAX_NODE_BYTES:
        raise ValueError("BULK_COMMIT_INVALID")
    commit = json.loads(path.read_bytes())
    return str(commit.get("snapshot_file", "")).startswith(SNAPSHOT_PREFIXES)


def read_snapshot(root, sid, *, expected_commit=None, expected_sha=None, commit_raw=None, protocol=None):
    rel = snapshot_relative(sid)
    if commit_raw is None:
        commit_path = checked_path(root, f"catalog/commits/{sid}.json")
        with commit_path.open("rb") as stream:
            commit_raw = stream.read(MAX_NODE_BYTES + 1)
    if len(commit_raw) > MAX_NODE_BYTES:
        raise ValueError("BULK_COMMIT_INVALID")
    commit = json.loads(commit_raw)
    version = str(commit.get("snapshot_file", "")).split(":", 1)[0]
    if (version not in SNAPSHOT_FORMATS or commit.get("snapshot_file") != version + ":" + rel
            or commit.get("snapshot_id") != sid
            or protocol is not None and SNAPSHOT_FORMATS[PROTOCOLS.index(protocol)] != version
            or (expected_commit is not None and sha(commit_raw) != expected_commit)):
        raise ValueError("BULK_COMMIT_INVALID")
    path = checked_path(root, rel)
    with path.open("rb") as stream:
        raw = stream.read(MAX_NODE_BYTES + 1)
    if len(raw) > MAX_NODE_BYTES:
        raise ValueError("BULK_SNAPSHOT_TOO_LARGE")
    checksum = sha(raw)
    if checksum != commit.get("snapshot_sha256") or (expected_sha is not None and "sha256:" + checksum != expected_sha):
        raise ValueError("BULK_SNAPSHOT_DIGEST_MISMATCH")
    snapshot = json.loads(raw)
    protocol = PROTOCOLS[SNAPSHOT_FORMATS.index(version)]
    inherited_field = ROOT_FIELDS[1 - PROTOCOLS.index(protocol)]
    _exact(snapshot, "format_version snapshot_id parent_snapshot_id parent_sha256 legacy_anchor root product_id partition result_root request_key partition_fingerprint"
           + (f" {inherited_field}" if inherited_field in snapshot else ""), "BULK_SNAPSHOT_INVALID")
    if inherited_field in snapshot and not _matches(_DIGEST, snapshot[inherited_field]):
        raise ValueError("BULK_SNAPSHOT_INVALID")
    parent = snapshot["parent_snapshot_id"]
    anchor = snapshot["legacy_anchor"]
    if anchor is not None:
        _exact(anchor, "snapshot_id sha256", "BULK_LEGACY_ANCHOR_INVALID")
        if not _matches(_SID, anchor["snapshot_id"]) or not _matches(_DIGEST, anchor["sha256"]) or anchor["snapshot_id"] == sid:
            raise ValueError("BULK_LEGACY_ANCHOR_INVALID")
    if (snapshot.get("format_version") != version or snapshot.get("snapshot_id") != sid
            or (parent is None and snapshot["parent_sha256"] is not None)
            or (parent is not None and (not _matches(_SID, parent) or not _matches(_DIGEST, snapshot["parent_sha256"])))
            or not _matches(_DIGEST, snapshot["partition_fingerprint"])
            or not re.fullmatch(r"[a-f0-9]{64}", str(snapshot["request_key"]))
            or not _matches(_DIGEST, snapshot.get("root")) or not _matches(_DIGEST, snapshot.get("result_root"))
            or not _matches(_PID, snapshot.get("product_id")) or not valid_partition(snapshot.get("partition"), protocol)
            or sid != snapshot_id(snapshot)):
        raise ValueError("BULK_SNAPSHOT_INVALID")
    indexed_products(root, snapshot)
    return snapshot


def validate_ordinary_roots(root, snapshot, manifest):
    roots = index_roots(snapshot)
    if roots != index_roots(manifest):
        raise ValueError("BULK_MANIFEST_ROOT_MISMATCH")
    if roots:
        expected_sid = "s_" + sha(canonical([snapshot["parent_snapshot_id"], snapshot["request_key"],
            snapshot["request_fingerprint"], snapshot["manifest_sha256"]]))[:24]
        if snapshot["snapshot_id"] != expected_sid or snapshot["parent_snapshot_id"] != manifest["parent_snapshot_id"]:
            raise ValueError("BULK_MANIFEST_SNAPSHOT_ID_MISMATCH")
        products = indexed_products(root, snapshot)
        if any(item["product_id"] in products for item in snapshot["files"]):
            raise ValueError("BULK_ORDINARY_PRODUCT_OVERLAP")
    return roots


def valid_partition(value, protocol):
    return tabular.valid_partition(value) if adapter(protocol) is tabular else _matches(_DATE, value)


def partition_value(header):
    return header["partition"]["value" if adapter(header["protocol_version"]) is tabular else "date"]


def partition_ref(root, root_ref, product_id, value, protocol):
    _, _, leaves = partition_path(root, root_ref, product_id, value, protocol=protocol)
    return leaves.get(partition_keys(value, protocol)[1])


def snapshot_id(snapshot):
    return "s_" + sha(canonical({key: value for key, value in snapshot.items() if key != "snapshot_id"}))[:24]


def partition_leaf(root, snapshot, product_id, value, result_root):
    protocol = protocol_for_snapshot(snapshot)
    if not _matches(_PID, product_id) or not valid_partition(value, protocol) or not _matches(_DIGEST, result_root):
        raise ValueError("BULK_LOCATOR_INVALID")
    products, _, leaves = partition_path(root, snapshot["root"], product_id, value, protocol=protocol)
    if leaves.get(partition_keys(value, protocol)[1]) != result_root:
        raise ValueError("BULK_LOCATOR_MISMATCH")
    leaf = read_node(root, result_root, partition_keys(value, protocol)[3], protocol=protocol)
    if (leaf["product"]["product_id"] != product_id or leaf["header"]["protocol_version"] != protocol
            or partition_value(leaf["header"]) != value):
        raise ValueError("BULK_LEAF_BINDING_MISMATCH")
    if protocol == tabular.PROTOCOL:
        header = leaf["header"]
        product = read_node(root, products[product_id], "product", protocol=protocol)
        tabular.validate_contract(header)
        tabular.validate_definition(header, leaf["product"]["declaration"])
        if product.get("table_contract_digest") != header["table_contract"]["digest"]:
            raise ValueError("BULK_TABLE_CONTRACT_MISMATCH")
    if (not isinstance(leaf.get("parts"), list) or not 1 <= len(leaf["parts"]) <= MAX_CHUNKS
            or not _matches(_DIGEST, leaf.get("identities_digest"))
            or any(not isinstance(part, dict) or set(part) != {"sha256", "size", "row_count"}
                   or type(part["row_count"]) is not int or not 1 <= part["row_count"] <= MAX_PART_ROWS
                   or type(part["size"]) is not int or not 1 <= part["size"] <= 2 * MAX_PART_INPUT_BYTES
                   for part in leaf["parts"])
            or sum(part["row_count"] for part in leaf["parts"]) != leaf["header"]["row_count"]):
        raise ValueError("BULK_LEAF_PARTS_INVALID")
    return leaf


def same_partition_request(original, proposed):
    return (all(original.get(key) == proposed.get(key) for key in ("row_count", "rows_digest", "partition", "field_codes", "table_contract", "protocol_version"))
            and all(original["outputs"][0][key] == proposed["outputs"][0][key]
                    for key in ("output_key", "subject", "coverage")))


def partition_metadata(leaf):
    header = leaf["header"]
    product = leaf["product"]
    return {"row_count": header["row_count"], "rows_digest": header["rows_digest"],
            "definition": product["declaration"], "definition_ref": product["definition_ref"],
            "contract_refs": product["contract_refs"], "contract_bundle_ref": product["contract_bundle_ref"],
            "partition_fingerprint": header["request_identity"]["submission_digest"],
            "output_key": header["outputs"][0]["output_key"], "subject": header["outputs"][0]["subject"],
            **({"table_contract_digest": header["table_contract"]["digest"]} if header["protocol_version"] == tabular.PROTOCOL else {})}


def read_page(root, leaf, locator, *, page_size, cursor):
    import base64

    if type(page_size) is not int or not 1 <= page_size <= MAX_PAGE_ROWS:
        raise ValueError("BULK_PAGE_SIZE_INVALID")
    binding = digest(locator)
    start = 0
    if cursor is not None:
        try:
            if not isinstance(cursor, str) or len(cursor) > 512:
                raise ValueError()
            value = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
            start = value["offset"]
            if value != {"binding": binding, "offset": start, "digest": digest([binding, start])}:
                raise ValueError()
            if type(start) is not int or not 0 < start < leaf["header"]["row_count"]:
                raise ValueError()
        except (ValueError, TypeError, KeyError) as exc:
            raise ValueError("BULK_CURSOR_INVALID") from exc
    rows = []
    bytes_used = 0
    part_offset = 0
    for part in leaf["parts"]:
        if part_offset + part["row_count"] <= start:
            part_offset += part["row_count"]
            continue
        for cells in part_rows(root, part, start=max(0, start - part_offset),
                               width=len(leaf["header"]["field_codes"]), protocol=leaf["header"]["protocol_version"]):
            _, row = semantic_row(leaf["header"], cells)
            item = {"cells": cells, "record_id": row["business_key"],
                    "record_version": record_version(leaf["header"], locator["product_id"], row),
                    "row_index": start + len(rows)}
            size = len(canonical(item)) + 1
            if size > MAX_PAGE_BYTES:
                raise ValueError("BULK_ROW_READ_BUDGET")
            if len(rows) == page_size or bytes_used + size > MAX_PAGE_BYTES:
                break
            rows.append(item)
            bytes_used += size
        else:
            part_offset += part["row_count"]
            continue
        break
    after = start + len(rows)
    next_cursor = None
    if after < leaf["header"]["row_count"]:
        next_cursor = base64.urlsafe_b64encode(canonical({"binding": binding, "offset": after,
                                                          "digest": digest([binding, after])})).decode("ascii")
    return {**locator, **partition_metadata(leaf), "rows": rows, "next_cursor": next_cursor}


def structured_document(header, rows):
    from .product_data_service import DATA_ONLY_PROTOCOL
    output = header["outputs"][0]
    return {"protocol_version": DATA_ONLY_PROTOCOL, "intent": "submit",
            "request_identity": header["request_identity"], "producer_namespace": header["producer_namespace"],
            "expected_parent_snapshot_id": header["expected_parent_snapshot_id"],
            "outputs": [{**output, "payload": {"kind": "tabular_rows", "rows": rows}}]}


def stage_partition(engine, header, chunks, product):
    from .product_governance import validate_payload

    width = len(header["field_codes"])
    protocol = header["protocol_version"]
    rows_digest = hashlib.sha256()
    identities = hashlib.sha256()
    pending = []
    pending_bytes = 0
    parts = []
    count = 0
    last_order = None
    def validate(rows):
        issues = validate_payload({"payload": {"kind": "tabular_rows", "rows": rows}}, product["declaration"])
        if issues:
            raise ValueError(issues[0]["code"] + ":" + issues[0]["message"])

    for chunk in chunks:
        semantic = []
        for cells in chunk:
            order, row = semantic_row(header, cells)
            if last_order is not None and order <= last_order:
                raise ValueError("BULK_ROW_ORDER_OR_DUPLICATE")
            raw = canonical(cells)
            if len(raw) > MAX_PAGE_BYTES // 2:
                raise ValueError("BULK_ROW_READ_BUDGET")
            last_order = order
            rows_digest.update(raw + b"\n")
            version = record_version(header, product["product_id"], row)
            identities.update(canonical([row["business_key"], version]) + b"\n")
            semantic.append(row)
            if len(semantic) == 1024:
                validate(semantic)
                semantic.clear()
            if len(pending) == MAX_PART_ROWS or pending_bytes + len(raw) > MAX_PART_INPUT_BYTES:
                parts.append(write_part(engine, pending, width=width, protocol=protocol))
                pending = []
                pending_bytes = 0
            pending.append(cells)
            pending_bytes += len(raw)
        if semantic:
            validate(semantic)
        count += len(chunk)
    if count != header["row_count"] or "sha256:" + rows_digest.hexdigest() != header["rows_digest"]:
        raise ValueError("BULK_ROWS_DIGEST_MISMATCH")
    if pending:
        parts.append(write_part(engine, pending, width=width, protocol=protocol))
    return {"kind": partition_keys(partition_value(header), protocol)[3], "header": header, "product": product, "parts": parts,
            "identities_digest": "sha256:" + identities.hexdigest()}


def write_candidate(engine, snapshot):
    sid = snapshot_id(snapshot)
    snapshot = {**snapshot, "snapshot_id": sid}
    rel = snapshot_relative(sid)
    raw = canonical(snapshot)
    engine._write_immutable(rel, raw)
    engine._write_immutable(f"catalog/commits/{sid}.json", canonical({"snapshot_id": sid,
        "snapshot_file": snapshot["format_version"] + ":" + rel, "snapshot_sha256": sha(raw)}))
    return snapshot


def locator(snapshot):
    return {key: snapshot[key] for key in ("snapshot_id", "product_id", "partition", "result_root")}


def summary_result(leaf, snapshot, *, duplicate):
    count = leaf["header"]["row_count"]
    return {**locator(snapshot), **partition_metadata(leaf), "protocol_version": leaf["header"]["protocol_version"],
            "state": "unchanged" if duplicate else "published_formal",
            "formal_publication_verified": True,
            "row_summary": {"inserted": 0 if duplicate else count, "duplicate_skipped": count if duplicate else 0,
                            "conflict_pending": 0, "pending_publication": 0}}
