#!/usr/bin/env python3
"""Official engine smoke test; report BLOCKED instead of fake PASS."""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
import platform
import subprocess
import sys
from pathlib import Path
from run_financial_slice import new_output_directory

ROOT = Path(__file__).resolve().parents[1]


def main(output):
    output = new_output_directory(output)
    output.mkdir(mode=0o700)
    report = output / "duckdb_engine_validation.json"

    def write(result):
        report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, indent=2))

    if importlib.util.find_spec("duckdb") is None:
        write({"status": "BLOCKED", "reason": "OFFICIAL_DUCKDB_RUNTIME_UNAVAILABLE",
               "engine": "duckdb", "engine_version": None, "host": platform.platform(),
               "actual_duckdb_tests_executed": 0, "parquet_zstd_write_verified": False,
               "snapshot_readback_verified": False, "mac_windows_exfat_verified": False})
        return 3

    import duckdb
    result = {"status": "RUNNING", "engine": "duckdb", "engine_version": duckdb.__version__,
              "host": platform.platform(), "actual_duckdb_tests_executed": 0}
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1"}
    python = [sys.executable, "-B", "-X", f"pycache_prefix={output / 'isolated-pycache'}"]
    completed = subprocess.run([*python, "-m", "pytest", "-q", "-p", "no:cacheprovider",
                                "--basetemp", str(output / "pytest"), "tests/test_duckdb_engine.py"],
                               cwd=ROOT, env=env, capture_output=True, text=True)
    result["pytest_exit_code"] = completed.returncode
    result["pytest_console"] = (completed.stdout + "\n" + completed.stderr)[-4000:]
    if completed.returncode:
        result["status"] = "FAILED"
        write(result)
        return 1
    completed = subprocess.run([*python, str(ROOT / "run_duckdb_demo.py"), "--output", str(output / "demo")],
                               cwd=ROOT, env=env, capture_output=True, text=True)
    result["demo_exit_code"] = completed.returncode
    result["demo_console"] = (completed.stdout + "\n" + completed.stderr)[-4000:]
    if completed.returncode:
        result["status"] = "FAILED"
        write(result)
        return 1
    summary = json.loads((output / "demo/demo_results.json").read_text())
    result.update({"status": "PASSED_LINUX_OR_HOST_ENGINE_POC", "committed_snapshots": summary["committed_snapshots"],
                   "products_read": summary["products_read"], "rows_read": summary["rows_read"],
                   "snapshot_readback_verified": True, "parquet_zstd_write_verified": True,
                   "mac_windows_exfat_verified": False, "production_accepted": False})
    write(result)
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="全新工程外输出目录；父目录须存在")
    raise SystemExit(main(parser.parse_args().output))
