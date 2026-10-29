"""兼容层：引擎包内 wfd_sdk.state.StateStore 的 head 解析/恢复，映射成旧脚本用的函数名。"""
import os
import sys
from pathlib import Path
_ENGINE = os.environ.get("WFD_ENGINE", "/Users/mashiro/Xuan BD-规划/测试产物/WFD/历史实验/formal_engine_rc1")
sys.path.insert(0, _ENGINE)
from wfd_sdk.gc import GC  # noqa: F401,E402
from wfd_sdk.state import StateStore  # noqa: F401,E402


def _valid(store):
    return GC(store).valid_snapshots()


def read_state(store):
    return StateStore(Path(store)).read()


def resolve_head(store):
    return StateStore(Path(store)).resolve(_valid(store))


def recover_head(store, *, operator: str, note: str = ""):
    res = StateStore(Path(store)).recover(_valid(store), operator, note=note)
    if res.get("ok"):
        return {"status": "recovered", "snapshot_id": res["snapshot_id"]}
    return {"status": "rejected", "code": res.get("code"), "candidates": res.get("candidates")}
