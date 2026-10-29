#!/usr/bin/env python3
"""Official engine smoke test; report BLOCKED instead of fake PASS."""
from __future__ import annotations
import importlib.util,json,subprocess,sys,platform,hashlib
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
REPORT=ROOT/'results'/'duckdb_engine_validation.json'
REPORT.parent.mkdir(exist_ok=True,parents=True)

def write(r):
    REPORT.write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(r,ensure_ascii=False,indent=2))

if importlib.util.find_spec('duckdb') is None:
    write({'status':'BLOCKED','reason':'OFFICIAL_DUCKDB_RUNTIME_UNAVAILABLE',
           'engine':'duckdb','engine_version':None,'host':platform.platform(),
           'actual_duckdb_tests_executed':0,'parquet_zstd_write_verified':False,
           'snapshot_readback_verified':False,'mac_windows_exfat_verified':False})
    sys.exit(3)

import duckdb
r={'status':'RUNNING','engine':'duckdb','engine_version':duckdb.__version__,
   'host':platform.platform(),'actual_duckdb_tests_executed':0}
res=subprocess.run([sys.executable,'-m','pytest','-q','tests/test_duckdb_engine.py'],
                   cwd=ROOT,capture_output=True,text=True)
r['pytest_exit_code']=res.returncode
r['pytest_console']=(res.stdout+'\n'+res.stderr)[-4000:]
if res.returncode:
    r['status']='FAILED';write(r);sys.exit(1)
res=subprocess.run([sys.executable,'run_duckdb_demo.py'],cwd=ROOT,capture_output=True,text=True)
r['demo_exit_code']=res.returncode
r['demo_console']=(res.stdout+'\n'+res.stderr)[-4000:]
if res.returncode:
    r['status']='FAILED';write(r);sys.exit(1)
summary=json.loads((ROOT/'results'/'demo_results.json').read_text())
r.update({'status':'PASSED_LINUX_OR_HOST_ENGINE_POC','committed_snapshots':summary['committed_snapshots'],
          'products_read':summary['products_read'],'rows_read':summary['rows_read'],
          'snapshot_readback_verified':True,'parquet_zstd_write_verified':True,
          'mac_windows_exfat_verified':False,'production_accepted':False})
write(r)
