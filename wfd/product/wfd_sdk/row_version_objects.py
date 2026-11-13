"""Versioned, immutable row-version metadata for explicitly adopted stores.

The physical source keeps a string in the original row-version slot. Older
readers therefore cannot mistake this format for absent legacy metadata.
Every snapshot load validates all unique objects; the virtual getter reads
and validates a fresh map, without a cross-request or mutable map cache.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat

KEY = "_wfd_row_versions"
PREFIX = "wfd.row-versions/ref/1:"
SNAPSHOT_PREFIX = "wfd.snapshot-file/2:"
FORMAT = "wfd.row-version-objects/1"
MAX_OBJECT_BYTES = 8 * 1024 * 1024
MAX_UNIQUE_BYTES = 512 * 1024 * 1024
MAX_REFERENCES = 4096
ADOPTION_REL = "catalog/product_service/row_version_objects_adoption.json"


class RowVersionObjectError(ValueError):
    code = "ROW_VERSION_OBJECT_INVALID"


def canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False,
                      sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise RowVersionObjectError("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def _bad_constant(value):
    raise RowVersionObjectError("NONFINITE_JSON_VALUE:" + value)


def parse_capsule(value):
    if not isinstance(value, str):
        raise RowVersionObjectError("CAPSULE_TYPE")
    match = re.fullmatch(re.escape(PREFIX) + r"([0-9a-f]{64}):([1-9][0-9]*)", value)
    if not match:
        raise RowVersionObjectError("CAPSULE_FORMAT_OR_VERSION")
    # Avoid unbounded integer conversion on hostile outer metadata.
    if len(match[2]) > 8:
        raise RowVersionObjectError("OBJECT_BYTES_LIMIT")
    size = int(match[2])
    if size > MAX_OBJECT_BYTES:
        raise RowVersionObjectError("OBJECT_BYTES_LIMIT")
    return match[1], size


def object_relative(sha256):
    if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise RowVersionObjectError("OBJECT_DIGEST_FORMAT")
    return f"catalog/product_service/row_versions/{sha256}.json"


def snapshot_relative(marker, snapshot_id):
    if not isinstance(snapshot_id, str) or not re.fullmatch(r"s_[0-9a-f]{24}", snapshot_id):
        raise RowVersionObjectError("SNAPSHOT_ID_FORMAT")
    plain = f"catalog/snapshots/{snapshot_id}.json"
    value = marker.get("snapshot_file")
    if value == plain or value == SNAPSHOT_PREFIX + plain:
        return plain
    raise RowVersionObjectError("SNAPSHOT_FILE_FORMAT_OR_VERSION")


def _object_path(root, sha256):
    root = Path(root).resolve()
    relative = object_relative(sha256)
    current = root
    for part in Path(relative).parts:
        current = current / part
        if current.is_symlink():
            raise RowVersionObjectError("OBJECT_SYMLINK")
    target = root / relative
    if root not in target.resolve().parents:
        raise RowVersionObjectError("OBJECT_PATH_ESCAPES_ROOT")
    return target


def load_versions(root, capsule):
    sha256, size = parse_capsule(capsule)
    path = _object_path(root, sha256)
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                     | getattr(os, "O_NONBLOCK", 0))
        with os.fdopen(fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_size != size:
                raise RowVersionObjectError("OBJECT_SIZE_OR_TYPE")
            raw = stream.read(size + 1)
            after = os.fstat(stream.fileno())
        linked = path.stat(follow_symlinks=False)
        if (not stat.S_ISREG(linked.st_mode)
                or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
                or (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
                != (linked.st_dev, linked.st_ino, linked.st_size, linked.st_mtime_ns)
                or _object_path(root, sha256) != path):
            raise RowVersionObjectError("OBJECT_CHANGED_DURING_READ")
    except OSError as exc:
        raise RowVersionObjectError("OBJECT_UNAVAILABLE") from exc
    if len(raw) != size or digest(raw) != sha256:
        raise RowVersionObjectError("OBJECT_BYTES_OR_DIGEST")
    try:
        # A duplicate key necessarily disappears on this exact canonical-byte
        # round trip, so it is rejected without Python hooks for every inner
        # record map. This also rejects whitespace, noncanonical escapes/order
        # and alternate numeric spellings; no noncanonical object is accepted.
        body = json.loads(raw.decode("utf-8"), parse_constant=_bad_constant)
        if (not isinstance(body, dict)
                or any(not isinstance(rows, dict)
                       or any(not isinstance(version, dict) for version in rows.values())
                       for rows in body.values())):
            raise RowVersionObjectError("OBJECT_MAP_SHAPE")
        if canonical(body) != raw:
            raise RowVersionObjectError("OBJECT_NONCANONICAL")
    except (UnicodeError, ValueError, TypeError, RecursionError) as exc:
        if isinstance(exc, RowVersionObjectError):
            raise
        raise RowVersionObjectError("OBJECT_JSON_INVALID") from exc
    return body


class ProjectedSource(dict):
    """Physical dict iteration/JSON stays a capsule; lookup returns a new map."""
    def __init__(self, value, root):
        super().__init__(value)
        self._root = Path(root)

    def get(self, key, default=None):
        value = dict.get(self, key, default)
        if key == KEY and isinstance(value, str):
            return load_versions(self._root, value)
        return value

    def __getitem__(self, key):
        value = dict.__getitem__(self, key)
        return load_versions(self._root, value) if key == KEY and isinstance(value, str) else value

    def copy(self):
        return ProjectedSource(self, self._root)

    def __copy__(self):
        return self.copy()

    def __deepcopy__(self, memo):
        result = ProjectedSource({}, self._root)
        memo[id(self)] = result
        for key, value in dict.items(self):
            dict.__setitem__(result, copy.deepcopy(key, memo), copy.deepcopy(value, memo))
        return result


def reference_inventory(snapshot):
    refs = []
    unique = {}
    by_digest = {}
    total = 0
    occurrence_bytes = 0
    for entry in snapshot.get("files", []):
        source = entry.get("source_bundle") or {}
        value = dict.get(source, KEY)
        if value is None or isinstance(value, dict):
            continue
        if source.get("_wfd_data_only") is not True:
            raise RowVersionObjectError("OBJECT_SOURCE_SCOPE")
        sha256, size = parse_capsule(value)
        refs.append((value, sha256, size))
        occurrence_bytes += size
        if len(refs) > MAX_REFERENCES:
            raise RowVersionObjectError("REFERENCE_COUNT_LIMIT")
        if occurrence_bytes > MAX_UNIQUE_BYTES:
            raise RowVersionObjectError("TOTAL_OBJECT_READ_BYTES_LIMIT")
        if sha256 in by_digest and by_digest[sha256] != size:
            raise RowVersionObjectError("OBJECT_LENGTH_CONFLICT")
        by_digest[sha256] = size
        pair = (sha256, size)
        if pair not in unique:
            unique[pair] = value
            total += size
            if total > MAX_UNIQUE_BYTES:
                raise RowVersionObjectError("UNIQUE_OBJECT_BYTES_LIMIT")
    return {"references": refs, "unique": unique, "unique_bytes": total,
            "occurrence_bytes": occurrence_bytes}


def project_snapshot(root, snapshot):
    inventory = reference_inventory(snapshot)
    # Validate every distinct object, including every unselected product. Only
    # the small capsules remain alive after validation; getters recheck bytes.
    for value in inventory["unique"].values():
        load_versions(root, value)
    for entry in snapshot.get("files", []):
        source = entry.get("source_bundle") or {}
        if isinstance(dict.get(source, KEY), str):
            entry["source_bundle"] = ProjectedSource(source, root)
    return inventory


def externalize_files(root, files, write_immutable):
    result = []
    for entry in files:
        source = entry.get("source_bundle") or {}
        versions = dict.get(source, KEY)
        if isinstance(versions, str):
            parse_capsule(versions)
            result.append(entry)
            continue
        if source.get("_wfd_data_only") is not True or not isinstance(versions, dict):
            result.append(entry)
            continue
        raw = canonical(versions)
        if not raw or len(raw) > MAX_OBJECT_BYTES:
            raise RowVersionObjectError("OBJECT_BYTES_LIMIT")
        sha256 = digest(raw)
        value = f"{PREFIX}{sha256}:{len(raw)}"
        _object_path(root, sha256)
        write_immutable(object_relative(sha256), raw)
        replacement = dict(source)
        replacement[KEY] = value
        result.append({**entry, "source_bundle": replacement})
    # Apply aggregate guards before the enclosing manifest can be published.
    reference_inventory({"files": result})
    return result


def marker_snapshot_file(files, snapshot_id):
    plain = f"catalog/snapshots/{snapshot_id}.json"
    return SNAPSHOT_PREFIX + plain if reference_inventory({"files": files})["references"] else plain


def adoption_record(root, runtime_root, *, for_write=False):
    path = Path(root) / ADOPTION_REL
    if (path.is_symlink()
            or ((for_write or path.exists())
                and (path.parent.is_symlink() or path.parent.parent.is_symlink()))):
        raise RowVersionObjectError("ADOPTION_MARKER_INVALID")
    if not path.exists():
        return None
    if not path.is_file() or path.stat().st_size > 4096:
        raise RowVersionObjectError("ADOPTION_MARKER_INVALID")
    try:
        record = json.loads(path.read_text("utf-8"), object_pairs_hook=_pairs)
    except (OSError, ValueError) as exc:
        raise RowVersionObjectError("ADOPTION_MARKER_INVALID") from exc
    if (not isinstance(record, dict)
            or set(record) != {"format_version", "store_root", "runtime_root", "store_filesystem_identity", "runtime_filesystem_identity", "identity", "adopted_at_utc"}
            or record["format_version"] != FORMAT
            or record["store_root"] != str(Path(root).resolve())
            or record["runtime_root"] != str(Path(runtime_root).resolve())
            or record["store_filesystem_identity"] != filesystem_identity(root)
            or record["runtime_filesystem_identity"] != filesystem_identity(runtime_root)
            or not isinstance(record["identity"], str) or not record["identity"].strip()
            or not isinstance(record["adopted_at_utc"], str) or not record["adopted_at_utc"]):
        raise RowVersionObjectError("ADOPTION_BINDING_INVALID")
    return record


def writing_enabled(root, runtime_root):
    return adoption_record(root, runtime_root) is not None


def filesystem_identity(root):
    info = Path(root).stat()
    if not stat.S_ISDIR(info.st_mode) or Path(root).is_symlink():
        raise RowVersionObjectError("ADOPTION_ROOT_INVALID")
    return {"device": info.st_dev, "inode": info.st_ino}


def adopt_writing(engine, *, identity, expected_snapshot_id, adopted_at_utc):
    """Explicit operator adoption; never called during ordinary store opening.

    A restore into a different directory identity requires its own adoption.
    Reads do not depend on this local write authorization marker.
    """
    from .writerlock import writer_lock
    if engine.read_only:
        raise RowVersionObjectError("ADOPTION_REQUIRES_WRITABLE_ENGINE")
    if (not isinstance(identity, str) or not identity.strip()
            or not isinstance(adopted_at_utc, str) or not adopted_at_utc):
        raise RowVersionObjectError("ADOPTION_IDENTITY_REQUIRED")
    with writer_lock(engine.root):
        head = engine.head()
        observed = head.get("snapshot_id") if head else None
        if observed != expected_snapshot_id:
            raise RowVersionObjectError("ADOPTION_HEAD_CHANGED")
        marker = {"format_version": FORMAT,
                  "store_root": str(Path(engine.root).resolve()),
                  "runtime_root": str(Path(engine.runtime_root).resolve()),
                  "store_filesystem_identity": filesystem_identity(engine.root),
                  "runtime_filesystem_identity": filesystem_identity(engine.runtime_root),
                  "identity": identity, "adopted_at_utc": adopted_at_utc}
        prior = adoption_record(engine.root, engine.runtime_root, for_write=True)
        if prior is not None:
            if prior["identity"] != identity:
                raise RowVersionObjectError("ADOPTION_IDENTITY_CONFLICT")
            marker = prior
        else:
            engine._write_immutable(ADOPTION_REL, canonical(marker))
        return {"marker": marker, "adoption_snapshot_id": observed,
                "adoption_snapshot_sha256": (digest((Path(engine.root) / f"catalog/snapshots/{observed}.json").read_bytes())
                                             if observed else None)}


def reject_unsupported(snapshot, operation):
    if (snapshot.get("format_version") in {"wfd.source-minute-snapshot/1", "wfd.tabular-snapshot/1"}
            or snapshot.get("source_minute_root") is not None
            or snapshot.get("tabular_root") is not None):
        raise RowVersionObjectError("SOURCE_MINUTE_SNAPSHOT_OPERATION_UNSUPPORTED:" + operation)
    if reference_inventory(snapshot)["references"]:
        raise RowVersionObjectError("ROW_VERSION_OBJECT_OPERATION_UNSUPPORTED:" + operation)
