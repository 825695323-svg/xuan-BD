#!/usr/bin/env python3
"""Reproduce WFD candidate sandbox Parquet write -> manifest -> snapshot -> read.

Uses official DuckDB for ZSTD Parquet writing and reading; still a POC, not production.
Source values are curated excerpts from public web pages (original raw bytes not stored).
"""
import argparse,copy,json,sys
from pathlib import Path
from datetime import datetime,timezone
ROOT=Path(__file__).resolve().parent


def main(output):
    from scripts.run_financial_slice import new_output_directory
    output = new_output_directory(output)
    output.mkdir(mode=0o700)
    from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype,load_protocol_validator,verify_test_bundle
    from wfd_sdk.duckdb_storage import parse_footer, DUCKDB_STORAGE_FORMAT, require_duckdb
    STORE=output/'store_demo'
    LOCAL=output/'host_native_cache'
    w=WFDDuckDBPrototype(STORE,load_protocol_validator(ROOT/'protocol'),runtime_root=LOCAL,sandbox=True)
    steps=['port_monthly_teu.json','port_annual_autos.json','port_release_event.json','seismic_quake_event.json','apple_v13_candidate.json','wdi_v13_candidate.json']
    receipts=[]
    for name in steps:
        req=json.loads((ROOT/'fixtures'/name).read_text('utf-8'))
        req['expected_parent_snapshot_id']=w.head()['snapshot_id'] if w.head() else None
        if 'candidate' in name:
            req['request_identity']['dataset_id']='test_wfd_v13_round2'
            req['request_identity']['request_id']='round3_'+name.replace('.json','')
        receipt=w.submit(req)
        assert receipt['status']=='published_sandbox', (name,receipt)
        receipts.append({'name':name,'snapshot_id':receipt['snapshot_id'],'status':receipt['status'],'output_count':len(receipt['outputs_success'])})
    # Ensure unverified source-only candidate never enters published snapshot.
    bad=json.loads((ROOT/'fixtures'/'unknown_vehicle_negative.json').read_text('utf-8'))
    bad['expected_parent_snapshot_id']=w.head()['snapshot_id']
    failed=w.submit(bad)
    assert failed['status']=='rejected'
    head=w.head()
    assert head
    all_entries=w.read_product()
    assert all(e['rows']==w.read_product(snapshot_id=head['snapshot_id'],product_id=e['product_id'])[0]['rows'] for e in all_entries)
    assert len(all_entries)==6
    assert sum(len(e['rows']) for e in all_entries)==32
    for e in head['files']:
        rel=e['file_relpath']
        assert rel.endswith('.parquet')
        assert parse_footer((STORE/rel).read_bytes())['num_rows']==e['row_count']
    # Delete local SQLite cache, recover from immutable manifest/snapshot.
    index=Path(w.rebuild_sqlite_index())
    assert LOCAL in index.parents
    index.unlink()
    assert all_entries==w.read_product()
    w.rebuild_sqlite_index()
    # Standalone export/read without original directory or SQLite.
    port_auto=next(f for f in head['files'] if f['output_key']=='la_port_auto_handled_2023_2025')
    bundle_path=output/'portable_port_autos_parquet_test_bundle'
    w.export_test_bundle(port_auto['product_id'],bundle_path)
    portable=verify_test_bundle(bundle_path)
    assert portable['verified'] and len(portable['rows'])==3
    # Failure injection: orphan snapshot not visible.
    d=json.loads((ROOT/'fixtures'/'port_annual_autos.json').read_text('utf-8'))
    d['expected_parent_snapshot_id']=head['snapshot_id']
    d['request_identity']['request_id']='test_failure_before_commit'
    d['outputs'][0]['payload']['rows'][0]['business_key']='different_test_key'
    d['outputs'][0]['payload']['rows'][1]['business_key']='another_new_key'
    d['outputs'][0]['payload']['rows'][2]['business_key']='third_new_key'
    pre=w.submit(d,fail_before_commit=True)
    assert pre['status']=='injected_failure_before_commit'
    assert w.head()['snapshot_id']==head['snapshot_id']
    result={
      'executed_at_utc':datetime.now(timezone.utc).isoformat(timespec='seconds'),
      'build':'v1.3-duckdb-Parquet-ZSTD-candidate (not stable SDK)',
      'format':DUCKDB_STORAGE_FORMAT,
      'storage_codec':'official-duckdb-PARQUET-ZSTD',
      'duckdb_roundtrip':'PASS','independent_pyarrow_reader':'NOT_RUN',
      'os_tested':'Linux container',
      'real_source_original_bytes_custodied':False,
      'statuses':{'published_sandbox':len(receipts),'rejected_business':1,'orphan_unpublished':1},
      'submissions':receipts,'committed_snapshots':len(list((STORE/'catalog/commits').glob('*.json'))),
      'products_read':len(all_entries),'rows_read':sum(len(e['rows']) for e in all_entries),
      'snapshot_id':head['snapshot_id'],'index_rebuilt_after_deletion':True,
      'portable_bundle_independent_read':portable['verified'],
      'portable_bundle_rows':len(portable['rows']),
      'old_snapshot_not_mutated':len(w._valid_snapshots())>=6,
      'business_rejection_codes':[e['code'] for e in failed['errors']],
      'production_acceptance':False,
      'caveats':[
        'DuckDB engine writes typed primitives with ZSTD; row_json is retained for proof-of-concept lossless reconstruction',
        'No independent PyArrow/other-engine read yet; no large-scale throughput/memory bound',
        'No macOS/Windows/exFAT real device tests',
        'Source samples are curated and not full raw evidence custody',
        'No historical revisions, full PIT release, graph search or formal customer bundle',
        'No write contention safety, fsync durability on exFAT cannot be inferred',
      ]
    }
    (output/'demo_results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(json.dumps({key:result[key] for key in ['committed_snapshots','products_read','rows_read','index_rebuilt_after_deletion','portable_bundle_independent_read','duckdb_roundtrip']},ensure_ascii=False,indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="全新工程外输出目录；父目录须存在")
    main(parser.parse_args().output)
