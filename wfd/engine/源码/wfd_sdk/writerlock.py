#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""单写入者排他保护（rc4 / F-D 修复）

定位：**只阻止意外的第二个写入者**，不提供并发写入能力、不做排队、不做多写者协调。
- 锁是操作系统级文件锁（POSIX flock / Windows msvcrt.locking），不是"看 .lock 文件是否存在"。
- 非阻塞：拿不到立即返回 `SINGLE_WRITER_BUSY`，不排队。
- 可重入：同一进程内嵌套获取只增加引用计数（引擎内部 activate 会嵌套调用）。
- 覆盖所有会改权威状态的入口：submit / publish_compaction / StateStore.activate /
  gc.execute / transfer.activate；只读路径不加锁。
- 本机锁与 writer_epoch 不能互相替代：锁管同机同目录的进程互斥，
  epoch/交接凭证管跨机主端资格；两台离线主机各自写入仍靠重连时的谱系分叉检测。
"""
from __future__ import annotations

import contextlib
import os
from pathlib import Path

try:                      # POSIX
    import fcntl

    def _try_lock(fd: int) -> bool:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except (BlockingIOError, OSError):
            return False

    def _unlock(fd: int) -> None:
        with contextlib.suppress(OSError):
            fcntl.flock(fd, fcntl.LOCK_UN)
except ImportError:       # Windows
    import msvcrt

    def _try_lock(fd: int) -> bool:
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False

    def _unlock(fd: int) -> None:
        with contextlib.suppress(OSError):
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)


class WriterBusy(RuntimeError):
    code = "SINGLE_WRITER_BUSY"

    def __init__(self, detail: str = ""):
        super().__init__(self.code + (f": {detail}" if detail else ""))
        self.detail = detail


_HELD: dict[str, list] = {}          # key → [fd, depth]


def lock_path(root: Path) -> Path:
    return Path(root) / "catalog" / ".writer.lock"


@contextlib.contextmanager
def writer_lock(root: Path):
    """实例级排他写锁（可重入、非阻塞）。"""
    key = str(Path(root).resolve())
    if key in _HELD:                 # 同进程重入
        _HELD[key][1] += 1
        try:
            yield
        finally:
            _HELD[key][1] -= 1
        return
    p = lock_path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(p), os.O_CREAT | os.O_RDWR, 0o644)
    if not _try_lock(fd):
        os.close(fd)
        raise WriterBusy(f"另一个写入实例正在使用 {p}")
    _HELD[key] = [fd, 1]
    try:
        yield
    finally:
        _HELD.pop(key, None)
        _unlock(fd)
        os.close(fd)


def probe(root: Path) -> bool:
    """是否已有写入者在占用（只读探测，不持有锁）。"""
    try:
        with writer_lock(root):
            return False
    except WriterBusy:
        return True


# ------------------------------------------------------------------ 入口装饰器
def _root_of(obj) -> Path | None:
    for attr in ("root", "store"):
        v = getattr(obj, attr, None)
        if v is not None:
            return Path(v)
    return None


def guarded_method(fn):
    """给"改权威状态的方法"加实例级排他锁（可重入）。"""
    import functools

    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        root = _root_of(self)
        if root is None:
            return fn(self, *args, **kwargs)
        with writer_lock(root):
            return fn(self, *args, **kwargs)

    return wrapper


def guarded_store_func(fn):
    """给 transfer.activate / import_package 这类"首参是 store 路径"的函数加锁。"""
    import functools

    @functools.wraps(fn)
    def wrapper(store, *args, **kwargs):
        with writer_lock(Path(store)):
            return fn(store, *args, **kwargs)

    return wrapper


def guarded_store_arg(index: int = 0):
    """按位置参数取 store 路径加锁（用于 import_package(pkg_dir, store) 这类签名）。"""
    import functools

    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            store = args[index] if len(args) > index else kwargs.get("store")
            if store is None:
                return fn(*args, **kwargs)
            with writer_lock(Path(store)):
                return fn(*args, **kwargs)

        return wrapper

    return deco
