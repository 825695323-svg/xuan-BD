"""A bounded read_product planner over officially published indexed partitions."""
from __future__ import annotations

import base64
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from functools import lru_cache
import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import tempfile

from . import indexed_bulk as bulk, usage_suspension
from .duckdb_sdk import canonical

MAX_PARTITIONS = 366
MAX_MATCH_VALUES = 20_000
MAX_SCAN_ROWS = 50_000_000
MAX_PAGE_BYTES = bulk.MAX_PAGE_BYTES
SORT = ["partition", "row_index"]
_COMPACT_DATE = re.compile(r"[0-9]{8}\Z")
_ISO_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")


def capabilities(supported):
    return {
        "supported": supported,
        "profile": "data_only_volume",
        "request_field": "indexed_tabular",
        "history_modes": ["snapshot_contents"],
        "comparison": "exact_text_OR_within_each_field_AND_across_fields",
        "context_digest_binds_cursor": True,
        "date_range_formats": ["YYYYMMDD", "YYYY-MM-DD"],
        "business_time_role": "observation_for_source_minute_mapping",
        "max_partitions": MAX_PARTITIONS,
        "max_match_values": MAX_MATCH_VALUES,
        "max_nodes": MAX_SCAN_ROWS,
        "sort": SORT,
        "partition_pruning": True,
        "row_group_predicate_pruning": True,
        "exact_total_on_first_page": True,
        "continuation_rechecks_returned_part_digests": True,
    }


def _fail(code, message, **details):
    from .product_query import ProductQueryError
    raise ProductQueryError(code, message, details)


def _day(value):
    try:
        if isinstance(value, str) and _ISO_DATE.fullmatch(value):
            return date.fromisoformat(value)
    except ValueError:
        pass
    _fail("INDEXED_DATE_RANGE_INVALID", "Expected a valid civil date in YYYY-MM-DD format", value=value)


def _utc(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _dates(left, right, form):
    count = (right - left).days + 1
    if not 1 <= count <= MAX_PARTITIONS:
        _fail("INDEXED_PARTITION_LIMIT", "Date selection must address a bounded number of partitions",
              partitions=count, max_partitions=MAX_PARTITIONS)
    return {_date_label(left + timedelta(days=index), form) for index in range(count)}


def _date_label(day, form):
    iso = day.isoformat()
    return iso.replace("-", "") if form == "YYYYMMDD" else iso


def _contract(leaf):
    header = leaf["header"]
    if header["protocol_version"] == bulk.tabular.PROTOCOL:
        return header["table_contract"]
    bulk.legacy.validate_contract(header)
    bulk.legacy.validate_definition(header, leaf["product"]["declaration"])
    partition = header["partition"]
    contract = {
        "version": bulk.legacy.KEY_ALGORITHM,
        "fields": header["field_codes"],
        "key_fields": [partition["identity_field"], partition["minute_field"]],
        "partition_field": partition["date_field"],
        "time": {"kind": "source_minute", **{key: partition[key] for key in ("date_field", "minute_field", "timezone")}},
    }
    return {**contract, "digest": bulk.digest(contract)}


class Budget:
    def __init__(self, request, metadata_bytes):
        self.max_bytes = request["max_scan_bytes"]
        self.max_rows = request["max_nodes"]
        self.metadata_bytes = metadata_bytes
        self.payload_bytes = 0
        self.verified_parts = 0
        self.candidate_rows = 0
        self.pruned_row_groups = 0
        self.check_bytes()

    def add_metadata(self, path):
        self.metadata_bytes += path.stat().st_size
        self.check_bytes()

    def check_bytes(self, more=0):
        total = self.metadata_bytes + self.payload_bytes + more
        if total > self.max_bytes:
            _fail("SCAN_BUDGET_EXCEEDED", "Selected indexed read exceeds its byte allowance",
                  required_scan_bytes=total, max_scan_bytes=self.max_bytes)

    def add_part(self, part):
        # The decoder receives the checked bytes in memory, capped per part.
        size = part["size"]
        self.check_bytes(size)
        self.payload_bytes += size
        self.verified_parts += 1

    def add_rows(self, count):
        required = self.candidate_rows + count
        if required > self.max_rows:
            _fail("SCAN_NODE_BUDGET_EXCEEDED", "Selected indexed read exceeds its candidate-row allowance",
                  candidate_rows=required, max_nodes=self.max_rows)
        self.candidate_rows = required

    def result(self):
        return {"required_scan_bytes": self.metadata_bytes + self.payload_bytes,
                "metadata_bytes": self.metadata_bytes, "payload_bytes": self.payload_bytes,
                "verified_parts": self.verified_parts, "candidate_rows": self.candidate_rows,
                "pruned_row_groups": self.pruned_row_groups, "max_scan_bytes": self.max_bytes,
                "max_nodes": self.max_rows}


class Catalog:
    def __init__(self, service, protocol, product_ref, budget):
        self.service = service
        self.root = service.root
        self.protocol = protocol
        self.budget = budget
        self.node = self.read_node(product_ref, "product")
        self.buckets = {}
        self.leaves = {}

    def read_node(self, ref, kind):
        self.budget.add_metadata(bulk.checked_path(self.root, bulk.node_relative(ref, protocol=self.protocol)))
        return bulk.read_node(self.root, ref, kind, protocol=self.protocol)

    def children(self, bucket, kind):
        if bucket not in self.buckets:
            ref = self.node["children"].get(bucket)
            self.buckets[bucket] = self.read_node(ref, kind)["children"] if ref else {}
        return self.buckets[bucket]

    def leaf(self, partition, ref):
        key = (partition, ref)
        if key not in self.leaves:
            self.budget.add_metadata(bulk.checked_path(self.root, bulk.node_relative(ref, protocol=self.protocol)))
            self.leaves[key] = bulk.bound_partition_leaf(self.root, self.node, self.protocol, partition, ref)
        return self.leaves[key]

    def sample(self):
        children = self.node["children"]
        if not children:
            _fail("BULK_CATALOG_INVALID", "Indexed product has no catalog partitions")
        bucket = min(children)
        entries = self.children(bucket, "bucket" if self.protocol == bulk.tabular.PROTOCOL else "year")
        if not entries:
            _fail("BULK_CATALOG_INVALID", "Indexed product has an empty partition branch")
        key, ref = min(entries.items())
        kind = "partition" if self.protocol == bulk.tabular.PROTOCOL else "date"
        candidate = self.read_node(ref, kind)
        partition = bulk.partition_value(candidate["header"])
        if bulk.partition_keys(partition, self.protocol)[:2] != (bucket, key):
            _fail("BULK_LEAF_BINDING_MISMATCH", "Indexed leaf does not resolve to its declared partition")
        return partition, ref, self.leaf(partition, ref)

    def resolve(self, partition):
        if not bulk.valid_partition(partition, self.protocol):
            _fail("BULK_PARTITION_INVALID", "Invalid explicit partition label", partition=partition)
        bucket, key, kind, _ = bulk.partition_keys(partition, self.protocol)
        return self.children(bucket, kind).get(key)


class Filters:
    def __init__(self, request, contract, business_range):
        options = request["indexed_tabular"]
        self.contract = contract
        self.matches = {field: sorted(values) for field, values in sorted(options.get("match", {}).items())}
        self.date_range = options.get("date_range")
        self.business_range = business_range
        self.time = contract["time"]
        self.date_bounds = None
        self.minute_bounds = None
        self.partition_filters = None
        self.column_of = {field: f"cell_{index}" for index, field in enumerate(contract["fields"])}
        requested_fields = set(request["fields"]) | set(self.matches)
        if self.date_range:
            requested_fields.add(self.date_range["field"])
        unknown = requested_fields - self.column_of.keys()
        if unknown:
            _fail("FIELD_NOT_DEFINED", "Selection requires declared indexed table fields",
                  missing_fields=sorted(unknown), available_fields=contract["fields"])
        if sum(map(len, self.matches.values())) > MAX_MATCH_VALUES:
            _fail("INDEXED_MATCH_LIMIT", "Too many text-equality values", max_match_values=MAX_MATCH_VALUES)
        selected = options.get("partitions")
        partition_field = contract["partition_field"]
        date_labels = None
        if self.date_range:
            left, right = (_day(self.date_range[key]) for key in ("start", "end"))
            if right < left:
                _fail("INDEXED_DATE_RANGE_INVALID", "Date range end precedes its start")
            fmt = self.date_range["format"]
            self.date_bounds = (_date_label(left, fmt), _date_label(right, fmt))
            if self.date_range["field"] == partition_field and selected is None:
                date_labels = _dates(left, right, fmt)
        if business_range:
            if business_range["role"] != "observation" or self.time["kind"] != "source_minute":
                _fail("BUSINESS_TIME_ROLE_NOT_DECLARED", "Indexed table has no requested observation time mapping")
            if business_range["timezone"] == self.time["timezone"]:
                # All admitted source minutes and requested endpoints are unambiguous.
                self.minute_bounds = tuple(business_range[key].replace("T", " ")
                                           if len(business_range[key]) > 10 else business_range[key] + " 00:00:00"
                                           for key in ("start", "end"))
                if len(business_range["end"]) == 10:
                    self.minute_bounds = (self.minute_bounds[0], business_range["end"] + " 23:59:59")
                if partition_field == self.time["date_field"] and selected is None and date_labels is None:
                    date_labels = _dates(_day(business_range["start"][:10]), _day(business_range["end"][:10]), "YYYYMMDD")
            elif partition_field == self.time["date_field"] and selected is None and date_labels is None:
                # Every ZoneInfo offset is strictly inside +/-24 hours. Using
                # the UTC date envelope remains safe across historical shifts.
                left = _utc(business_range["start_utc"]).date()
                right = (_utc(business_range["end_utc"]) - timedelta(seconds=1)).date()
                date_labels = _dates(left - timedelta(days=1), right + timedelta(days=1), "YYYYMMDD")
        if selected is None and date_labels is None:
            _fail("BULK_PARTITION_LOCATOR_REQUIRED", "Select explicit partitions or a date range mapped to the partition field")
        self.labels = sorted(selected if selected is not None else date_labels, key=lambda value: value.encode("utf-8"))

    def for_partition(self, partition):
        partition_field = self.contract["partition_field"]
        if any(not values or field == partition_field and partition not in values
               for field, values in self.matches.items()):
            return None
        if self.date_range and self.date_range["field"] == partition_field:
            if not self.valid_date(partition):
                return None
        if self.minute_bounds and partition_field == self.time["date_field"]:
            lower, upper = (bound[:10].replace("-", "") for bound in self.minute_bounds)
            if not lower <= partition <= upper:
                return None
        if self.partition_filters is None:
            self.partition_filters = PartitionFilters(self, partition_field)
        return self.partition_filters

    def valid_date(self, value):
        if value is None or not self.date_bounds[0] <= value <= self.date_bounds[1]:
            return False
        return _valid_date(value, self.date_range["format"])

    def valid_minute(self, value):
        start, end = bulk.observation_bounds(value, self.time["timezone"])
        return self.business_range["start_utc"] <= start and end <= self.business_range["end_utc"]


@lru_cache(maxsize=4096)
def _valid_date(value, date_format):
    pattern = _COMPACT_DATE if date_format == "YYYYMMDD" else _ISO_DATE
    if not pattern.fullmatch(value):
        return False
    try:
        if pattern is _COMPACT_DATE:
            value = value[:4] + "-" + value[4:6] + "-" + value[6:]
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


class PartitionFilters:
    def __init__(self, filters, partition_field):
        import pyarrow as pa

        self.filters = filters
        column_of = filters.column_of
        self.matches = {column_of[field]: pa.array(values, type=pa.string())
                        for field, values in filters.matches.items() if field != partition_field}
        self.date_column = (column_of[filters.date_range["field"]]
                            if filters.date_range and filters.date_range["field"] != partition_field else None)
        self.minute_column = column_of[filters.time["minute_field"]] if filters.business_range else None
        self.columns = sorted(set(self.matches) | {column for column in (self.date_column, self.minute_column) if column})
        self.column_indices = {column: int(column.removeprefix("cell_")) for column in self.columns}
        self.match_values = {column: sorted(values.to_pylist()) for column, values in self.matches.items()}

    def group_possible(self, group):
        from bisect import bisect_left

        for column in self.columns:
            info = group.column(self.column_indices[column]).statistics
            if info is None:
                continue
            if info.null_count == group.num_rows:
                return False
            if not info.has_min_max or not isinstance(info.min, str) or not isinstance(info.max, str):
                continue
            if column in self.match_values:
                values = self.match_values[column]
                offset = bisect_left(values, info.min)
                if offset == len(values) or values[offset] > info.max:
                    return False
            for bound_column, bounds in ((self.date_column, self.filters.date_bounds),
                                         (self.minute_column, self.filters.minute_bounds)):
                if column == bound_column and bounds and (info.max < bounds[0] or info.min > bounds[1]):
                    return False
        return True

    def indexes(self, file, index, start, count):
        import pyarrow.compute as pc

        if not self.columns:
            return range(start, count)
        table = file.read_row_group(index, columns=self.columns).slice(start)
        mask = None
        for column, values in self.matches.items():
            accepted = pc.is_in(table[column], value_set=values)
            mask = accepted if mask is None else pc.and_(mask, accepted)
        for column, bounds in ((self.date_column, self.filters.date_bounds),
                               (self.minute_column, self.filters.minute_bounds)):
            if column and bounds:
                accepted = pc.and_(pc.greater_equal(table[column], bounds[0]), pc.less_equal(table[column], bounds[1]))
                accepted = pc.fill_null(accepted, False)
                mask = accepted if mask is None else pc.and_(mask, accepted)
        candidates = range(count - start) if mask is None else pc.indices_nonzero(mask).to_pylist()
        dates = table[self.date_column].to_pylist() if self.date_column else None
        minutes = table[self.minute_column].to_pylist() if self.minute_column else None
        return [start + offset for offset in candidates
                if (dates is None or self.filters.valid_date(dates[offset]))
                and (minutes is None or minutes[offset] is not None and self.filters.valid_minute(minutes[offset]))]


def _stat_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


@contextmanager
def _verified_parquet(root, protocol, part, width):
    import pyarrow as pa
    import pyarrow.parquet as pq

    path = bulk.checked_path(root, bulk.part_relative(part["sha256"], protocol=protocol))
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size != part["size"]:
            _fail("BULK_PART_DIGEST_MISMATCH", "Indexed Parquet does not match its committed byte length")
        raw = stream.read(part["size"] + 1)
        if len(raw) != part["size"] or hashlib.sha256(raw).hexdigest() != part["sha256"]:
            _fail("BULK_PART_DIGEST_MISMATCH", "Indexed Parquet does not match its committed digest")
        file = pq.ParquetFile(pa.BufferReader(raw))
        if (file.schema_arrow.names != [f"cell_{index}" for index in range(width)]
                or any(str(field.type) != "string" for field in file.schema_arrow)
                or file.metadata.num_rows != part["row_count"]
                or any(not 1 <= file.metadata.row_group(index).num_rows <= 4096 for index in range(file.num_row_groups))):
            _fail("BULK_PART_SCHEMA_INVALID", "Indexed Parquet does not match its committed tabular format")
        yield file
        if (_stat_identity(before) != _stat_identity(os.fstat(stream.fileno()))
                or _stat_identity(before) != _stat_identity(path.stat(follow_symlinks=False))):
            _fail("BULK_PART_DIGEST_MISMATCH", "Indexed Parquet changed during its verified read")


def _cursor_key(runtime_root):
    path = runtime_root / "indexed-query-cursor.key"
    if not path.exists() and not path.is_symlink():
        runtime_root.mkdir(parents=True, exist_ok=True)
        fd, temp = tempfile.mkstemp(prefix=".indexed-query-key-", dir=runtime_root)
        try:
            with os.fdopen(fd, "wb") as file:
                file.write(secrets.token_bytes(32))
                file.flush()
                os.fsync(file.fileno())
            try:
                os.link(temp, path)
            except FileExistsError:
                pass
        finally:
            os.unlink(temp)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            _fail("INDEXED_CURSOR_KEY_INVALID", "Indexed query cursor key must be restricted to the service user")
        key = file.read(33)
    if len(key) != 32:
        _fail("INDEXED_CURSOR_KEY_INVALID", "Indexed query cursor signing key is invalid")
    return key


def _encode_cursor(service, query_hash, position, delivered, total):
    data = canonical(["wfd.indexed-query-cursor/1", query_hash, position, delivered, total])
    signature = hmac.digest(_cursor_key(service.runtime_root), data, "sha256")
    return base64.urlsafe_b64encode(signature + data).decode("ascii")


def _decode_cursor(service, query_hash, token):
    if token is None:
        return None
    try:
        payload = base64.b64decode(token, altchars=b"-_", validate=True)
        signature, data = payload[:32], payload[32:]
        if not hmac.compare_digest(signature, hmac.digest(_cursor_key(service.runtime_root), data, "sha256")):
            raise ValueError()
        version, binding, position, delivered, total = json.loads(data)
        if (version != "wfd.indexed-query-cursor/1" or not isinstance(position, list) or len(position) != 2
                or any(type(value) is not int or value < 0 for value in position)
                or type(delivered) is not int or type(total) is not int or not 0 < delivered < total):
            raise ValueError()
    except (ValueError, TypeError) as exc:
        from .product_query import ProductQueryError
        if isinstance(exc, ProductQueryError):
            raise
        _fail("CURSOR_INVALID", "Indexed tabular cursor is invalid or has been altered")
    if binding != query_hash:
        _fail("CURSOR_QUERY_MISMATCH", "Indexed tabular cursor is bound to another fixed selection")
    return position, delivered, total


def _project(query, request, leaf, cells, partition, index, field_definitions, units):
    product_id = request["product_id"]
    header, product = leaf["header"], leaf["product"]
    _, row = bulk.semantic_row(header, cells)
    record_id = row["business_key"]
    version = bulk.record_version(header, product_id, row)
    values = {}
    for field in sorted(request["fields"]):
        cell, code, message = query._project_cell(row, field, field_definitions[field], product)
        if code:
            _fail(code, message, field=field)
        values[field] = cell
        units[cell["unit"]["unit_code"]] = cell["unit"]
    return {"product_id": product_id, "partition": partition, "row_index": index,
            "record_id": record_id, "record_version": version,
            "record_ref": {"product_id": product_id, "snapshot_id": request["snapshot_id"],
                           "logical_key": record_id, "revision_id": version},
            "subject": row["subject"], "business_time": row["observation_time"],
            "business_time_role": "observation", "times": {"observation_time": row["observation_time"]},
            "values": values, "contract_ref": product["contract_ref"]}


def _scan(query, request, protocol, planned, budget, cursor, width, field_maps, governed_versions):
    start_part, start_row = cursor[0] if cursor else (0, 0)
    delivered, total = cursor[1:] if cursor else (0, 0)
    if not cursor:
        budget.check_bytes(sum(part["size"] for _, _, part, _, _ in planned))
    rows, units = [], {}
    after, next_position, bytes_used, full = None, None, 0, False
    for part_index in range(start_part, len(planned)):
        partition, file_offset, part, leaf, predicate = planned[part_index]
        if full and cursor:
            break
        skip = start_row if part_index == start_part else 0
        if skip == part["row_count"]:
            continue
        budget.add_part(part)
        ref = leaf["product"]["contract_ref"]["digest"]
        with _verified_parquet(query.root, protocol, part, width) as file:
            offset = 0
            for group_index in range(file.num_row_groups):
                group = file.metadata.row_group(group_index)
                count = group.num_rows
                group_offset = offset
                offset += count
                if offset <= skip:
                    continue
                if not predicate.group_possible(group):
                    budget.pruned_row_groups += 1
                    continue
                group_start = max(0, skip - group_offset)
                budget.add_rows(count - group_start)
                indexes = predicate.indexes(file, group_index, group_start, count)
                if not indexes:
                    continue
                if not cursor:
                    total += len(indexes)
                    if full and next_position is None:
                        next_position = [part_index, group_offset + indexes[0]]
                if full and not governed_versions:
                    continue
                # Record version IDs hash the entire original row. Decode all
                # columns for returned rows and governed totals.
                table = file.read_row_group(group_index)
                if governed_versions:
                    _check_governed_matches(query, request, leaf, table, indexes, governed_versions)
                if full:
                    continue
                for position, index in enumerate(indexes):
                    cells = [column[index].as_py() for column in table.columns]
                    row = _project(query, request, leaf, cells, partition,
                                   file_offset + group_offset + index, field_maps[ref], units)
                    size = len(canonical(row)) + 1
                    if size > MAX_PAGE_BYTES:
                        _fail("PAGE_ITEM_TOO_LARGE", "Projected indexed row exceeds the page byte limit")
                    if bytes_used + size > MAX_PAGE_BYTES:
                        full = True
                        next_position = [part_index, group_offset + index]
                        break
                    rows.append(row)
                    bytes_used += size
                    after = [part_index, group_offset + index + 1]
                    full = len(rows) == request["page_size"]
                    if full or cursor and delivered + len(rows) == total:
                        if full and position + 1 < len(indexes):
                            next_position = [part_index, group_offset + indexes[position + 1]]
                        break
                if cursor and (full or delivered + len(rows) == total):
                    break
        if cursor and delivered + len(rows) == total:
            break
    if cursor and not rows:
        _fail("INDEXED_CURSOR_READ_MISMATCH", "No continuation rows remain for this authenticated query")
    return rows, units, next_position if next_position is not None else after, delivered, total


def _check_governed_matches(query, request, leaf, table, indexes, governed_versions):
    product_id = request["product_id"]
    header = leaf["header"]
    for index in indexes:
        _, row = bulk.semantic_row(header, [column[index].as_py() for column in table.columns])
        version = bulk.record_version(header, product_id, row)
        if version in governed_versions:
            # A total must not reveal the existence of a restricted match on a later page.
            usage_suspension.enforce_read(query.root, {"snapshot_id": request["snapshot_id"], "rows": [
                {"record_ref": {"product_id": product_id, "revision_id": version}}]})


def _usage_policy(root, product_id, budget):
    path = root / usage_suspension.FILENAME
    if path.exists() or path.is_symlink():
        budget.add_metadata(bulk.checked_path(root, usage_suspension.FILENAME))
    data = usage_suspension.load(root)
    policy = []
    versions = set()
    for issue in data["issues"]:
        for scope in issue["scopes"]:
            if scope["product_id"] == product_id:
                policy.append([issue["issue_id"], issue["state"], scope])
                versions.update(scope["record_versions"])
    return bulk.digest(policy), versions


def _verify_requested_snapshot(service, snapshot, catalogs):
    if snapshot.get("format_version") not in bulk.SNAPSHOT_FORMATS:
        return None
    protocol = bulk.protocol_for_snapshot(snapshot)
    catalog = catalogs(snapshot["product_id"])
    partition, ref = snapshot["partition"], snapshot["result_root"]
    if catalog.resolve(partition) != ref:
        _fail("BULK_LOCATOR_MISMATCH", "Snapshot publication cannot be reconciled to its fixed catalog")
    leaf = catalog.leaf(partition, ref)
    return ref, service.verify_indexed_partition_publication(leaf, protocol=protocol, partition=partition,
                                                             result_root=ref, snapshot=snapshot,
                                                             observe=catalog.budget.add_metadata)


def _is_active_head(root, snapshot, budget):
    from .state import StateStore

    state_path = bulk.checked_path(root, "catalog/state.json")
    state = StateStore(root)
    budget.add_metadata(state_path)
    sid = snapshot["snapshot_id"]
    if (state.read() or {}).get("active_head") != sid:
        return False
    budget.add_metadata(state_path)
    budget.add_metadata(bulk.checked_path(root, bulk.snapshot_relative(sid)))
    resolution = state.resolve({sid: snapshot})
    return resolution["ok"] and resolution["snapshot_id"] == sid


def execute(query, request, business_range):
    from .product_query import PROTOCOL_VERSION, RESULT_FORMAT, _declaration_fields, _product_key

    service = query.service
    target_factory = getattr(service, "indexed_query_product_service", None)
    if not callable(target_factory):
        _fail("INDEXED_QUERY_UNSUPPORTED", "Indexed tabular selection requires the data_only volume service")
    if request["history_mode"] != "snapshot_contents" or request.get("include_history"):
        _fail("INDEXED_HISTORY_MODE_UNSUPPORTED", "Indexed tabular selection requires snapshot_contents")
    target_factory()
    budget = Budget(request, 0)
    snapshot, manifest, *_ = query._snapshot_metadata(request["snapshot_id"], indexed_budget=budget)
    product_id = request["product_id"]
    indexed = manifest.get("_indexed_products", {})
    if product_id not in indexed:
        code = "INDEXED_PRODUCT_REQUIRED" if any(row.get("product_id") == product_id for row in manifest["files"]) else "PRODUCT_NOT_FOUND"
        _fail(code, "The selected fixed snapshot does not contain the requested indexed product", product_id=product_id)

    @lru_cache(maxsize=2)
    def catalog_for(pid):
        protocol, product_ref = indexed[pid]
        return Catalog(service, protocol, product_ref, budget)

    catalog = catalog_for(product_id)
    protocol = catalog.protocol
    product = catalog.node["product"]
    if product.get("product_id") != product_id:
        _fail("BULK_PRODUCT_BINDING_MISMATCH", "Catalog product identity does not match the fixed product")
    if product.get("dataset_id") != request["dataset_id"]:
        _fail("DATASET_MISMATCH", "Requested dataset does not match the fixed product dataset", product_id=product_id)
    product_bindings = {_product_key(product): product}
    service.verify_indexed_query_binding(product, observe=budget.add_metadata)
    publication = _verify_requested_snapshot(service, snapshot, catalog_for)
    sample_partition, sample_ref, sample_leaf = catalog.sample()
    contract = _contract(sample_leaf)
    filters = Filters(request, contract, business_range)
    subject_matches = request.get("subject") is None or request["subject"] == product["subject"]
    proofs, missing, planned, field_maps = [], [], [], {}
    origins = dict([publication]) if publication else {}

    def origin(partition, ref, leaf):
        if ref not in origins:
            origins[ref] = service.verify_indexed_partition_publication(leaf, protocol=protocol,
                                                                       partition=partition, result_root=ref,
                                                                       observe=budget.add_metadata)
        return origins[ref]

    for partition in filters.labels:
        ref = catalog.resolve(partition)
        if ref is None:
            missing.append(partition)
            continue
        leaf = catalog.leaf(partition, ref)
        if _contract(leaf) != contract:
            _fail("BULK_TABLE_CONTRACT_MISMATCH", "Selected partitions do not share the fixed table contract")
        leaf_product = leaf["product"]
        key = _product_key(leaf_product)
        binding = product_bindings.get(key)
        frozen_keys = ("definition_ref", "declaration", "contracts", "contract_refs",
                       "contract_bundle_ref", "payload_kind")
        if (leaf_product["dataset_id"] != request["dataset_id"] or leaf_product["subject"] != product["subject"]
                or binding and any(leaf_product.get(name) != binding.get(name) for name in frozen_keys)):
            _fail("BULK_PRODUCT_BINDING_MISMATCH", "Selected partition product is inconsistent with the fixed binding")
        if key not in product_bindings:
            service.verify_indexed_query_binding(leaf_product, observe=budget.add_metadata)
            product_bindings[key] = leaf_product
        header = leaf["header"]
        proofs.append({"partition": partition, "result_root": ref, "rows_digest": header["rows_digest"],
                       "row_count": header["row_count"], "publication_snapshot_id": origin(partition, ref, leaf)})
        predicate = filters.for_partition(partition) if subject_matches else None
        if predicate is not None:
            field_maps[key[1]] = _declaration_fields(leaf_product)
            offset = 0
            for part in leaf["parts"]:
                planned.append((partition, offset, part, leaf, predicate))
                offset += part["row_count"]
    if not proofs:
        origin(sample_partition, sample_ref, sample_leaf)
    query._current_business_policy(request, product_bindings,
                                   fixed_head_check=lambda: _is_active_head(query.root, snapshot, budget))
    fields = sorted(request["fields"])
    selection = {"partitions": filters.labels, "match": filters.matches, "date_range": filters.date_range,
                 "context_digest": request["indexed_tabular"].get("context_digest")}
    usage_digest, governed_versions = _usage_policy(query.root, product_id, budget)
    query_hash = bulk.digest(["wfd.indexed-query/1", service.binding.instance_id, service.binding.volume_uuid,
                              service.caller_id, request["protocol_version"], query.schema_sha256, request["dataset_id"],
                              request["snapshot_id"], product_id, catalog.protocol, contract["digest"],
                              request.get("subject"), fields, selection, business_range, proofs, missing, SORT,
                              usage_digest])
    cursor = _decode_cursor(service, query_hash, request.get("cursor"))
    rows, units, after, delivered, total = _scan(query, request, protocol, planned, budget, cursor,
                                                  len(contract["fields"]), field_maps,
                                                  governed_versions if cursor is None else set())
    if _usage_policy(query.root, product_id, budget)[0] != usage_digest:
        _fail("INDEXED_USAGE_POLICY_CHANGED", "Usage restrictions changed during the fixed query. Retry the selection.")
    usage_suspension.enforce_read(query.root, {"snapshot_id": request["snapshot_id"], "rows": rows})
    has_more = delivered + len(rows) < total
    next_cursor = _encode_cursor(service, query_hash, after, delivered + len(rows), total) if has_more else None
    return {"format_version": RESULT_FORMAT, "protocol_version": PROTOCOL_VERSION, "operation": "read_product",
            "dataset_id": request["dataset_id"], "snapshot_id": request["snapshot_id"], "product_id": product_id,
            "history_mode": "snapshot_contents", "knowledge_cutoff": None, "held_scope": None, "usable_stage": None,
            "subject": request.get("subject"), "fields": fields,
            "business_time_range": business_range, "query_hash": query_hash, "sort": SORT,
            "product": query._product_envelope(product_id, product_bindings, fields),
            "indexed_tabular": {"protocol_version": protocol, "table_contract": contract,
                                "table_contract_digest": contract["digest"], "partitions": proofs,
                                "missing_partitions": missing, "selection": selection},
            "source_ids": [], "units": units, "rows": rows, "diagnostics": [], "diagnostics_total": 0,
            "budget": budget.result(), "page": {"page_size": request["page_size"], "returned_rows": len(rows),
                                                "total_rows": total, "remaining_rows": total - delivered,
                                                "has_more": has_more, "next_cursor": next_cursor,
                                                "cursor_applied": cursor is not None, "page_complete": not has_more},
            "result_status": "rows" if rows else "no_rows", "complete": not has_more}
