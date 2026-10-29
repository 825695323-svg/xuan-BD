import os
import sys
_ENGINE = os.environ.get("WFD_ENGINE", "/Users/mashiro/WFD规划与测试/formal_engine_rc1")
sys.path.insert(0, _ENGINE)
from wfd_sdk.gc import ClosureError, GC  # noqa: F401,E402
