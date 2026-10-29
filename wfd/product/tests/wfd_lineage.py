"""兼容层：把引擎包内 wfd_sdk 的实现暴露成旧测试脚本使用的模块名。"""
import os
import sys
_ENGINE = os.environ.get("WFD_ENGINE", "/Users/mashiro/Xuan BD-规划/测试产物/WFD/历史实验/formal_engine_rc1")
sys.path.insert(0, _ENGINE)
from wfd_sdk.lineage import Lineage, files_root, sha_file  # noqa: F401,E402
