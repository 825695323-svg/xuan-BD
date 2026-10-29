#!/usr/bin/env python3
"""Bounded P3 batch run: real 000001 daily 60 rows, 3 chunks, recovery readback."""
from __future__ import annotations

import csv
import gzip
import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

CODE = Path('/Users/mashiro/Xuan BD/项目本体/wfd')
REC = Path('/Users/mashiro/Xuan BD-规划/测试产物/WFD/验证记录')
ENGINE = CODE / 'product'
OUT = REC / 'P3_通用入库与更新_2026-10-27'
BATCHES = OUT / 'batches'
RUN = BATCHES / ('run_' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
sys.path.insert(0, str(ENGINE))

from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype, load_protocol_validator
from wfd_sdk.product_service import SERVICE_VERSION, WFDProductService
from wfd_sdk.product_batches import ProductBatchLedger
from wfd_sdk import product_foundations as f

DATA = REC / '首发数据准备_2026-10-27'
MARKET = DATA / 'prepared_candidates/daily_12companies_2021_2025.csv.gz'
if not MARKET.is_file():
    raise SystemExit('missing market package')
if RUN.exists():
    raise SystemExit('exists ' + str(RUN))
RUN.mkdir(parents=True)

CN = ZoneInfo('Asia/Shanghai')
UTC = timezone.utc
ROLES = {'evidence_write', 'register', 'submit', 'publish', 'read', 'read_evidence'}
READ_ROLES = {'read', 'read_evidence'}
DATASET = 'p3a_batch_real_2026'
NAMESPACE = 'wfd.p3.batch'
SOURCE = 'market_60'
POLICY = {
    SOURCE: {'may_submit': True, 'may_publish_formal': True, 'may_read': True,
             'may_read_evidence': True, 'usage_scope': 'local_use',
             'license': 'local_use_only', 'allowed_roles': ['compiler', 'deliverer']},
    'wfd_p2_local_evidence': {'may_submit': True, 'may_publish_formal': True, 'may_read': True,
                              'may_read_evidence': True, 'usage_scope': 'local_use',
                              'license': 'local_use_only',
                              'allowed_roles': ['compiler', 'deliverer']},
}
UNITS = {'cny_per_share': {'dimension': 'money_per_share', 'currency': 'CNY', 'multiplier': '1'},
         'lot_100_shares': {'dimension': 'quantity', 'currency': 'CNY', 'multiplier': '100'}}


def day(y, m, d):
    local = datetime(y, m, d, tzinfo=CN)
    start = local.astimezone(UTC)
    end = (local + timedelta(days=1)).astimezone(UTC)
    return {'status': 'known', 'precision': 'day',
            'earliest_utc': start.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'latest_exclusive_utc': end.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'source_timezone': 'Asia/Shanghai'}


def service(store, runtime, roles, caller):
    engine = WFDDuckDBPrototype(store, load_protocol_validator(ENGINE / 'protocol'),
                                runtime_root=runtime, sandbox=False, writer_host=caller)
    return WFDProductService(engine, allowed_sources=POLICY, caller_roles=roles,
                             caller_id=caller, unit_registry=UNITS,
                             trusted_actor_namespaces={NAMESPACE})


svc = service(RUN / 'store', RUN / 'runtime_writer', ROLES, 'p3-batch-real')
evidence = svc.register_evidence(MARKET)
unit_pack = {
    'dataset_id': DATASET, 'observed_at': '2026-10-16',
    'regions': [{'id': 'region_cn', 'code': 'CN', 'name': '中国', 'evidence_labels': ['market_60']}],
    'markets': [{'id': 'market_placeholder', 'code': 'X', 'name': 'placeholder',
                 'region_id': 'region_cn', 'evidence_labels': ['market_60']}],
    'entities': [], 'instruments': [], 'listings': [],
    'physical_objects': [], 'name_claims': [], 'relations': [],
    'calendar': {'market_id': 'market_placeholder', 'market_code': 'X',
                 'dates': ['2025-12-31'], 'range': ['2025-12-31', '2025-12-31'],
                 'evidence_labels': ['market_60']},
    'units': [
        {'unit_code': 'cny_per_share', 'dimension': 'money_per_share', 'display_name': '元/股',
         'base_unit': 'cny_per_share', 'scale_factor': '1', 'period_basis': 'point_in_time',
         'null_rule': 'unknown', 'status': 'source_header',
         'definition_scope': '日线价格元/股', 'evidence_basis': '日线表头收盘价（元）',
         'evidence_labels': ['market_60']},
        {'unit_code': 'lot_100_shares', 'dimension': 'quantity', 'display_name': '手（100股）',
         'base_unit': 'share', 'scale_factor': '100', 'period_basis': 'flow',
         'null_rule': 'unknown', 'status': 'source_header',
         'definition_scope': '日线成交量手', 'evidence_basis': '日线表头成交量（手）',
         'evidence_labels': ['market_60']},
    ],
    'metric_bindings': [],
}
f.validate_pack(unit_pack)
unit_outputs = f.build_unit_outputs(unit_pack, {'market_60': evidence})
req = f.make_request(DATASET, 'p3a-batch-unit', unit_outputs, namespace=NAMESPACE)
req['source_bundle']['source_roles'] = {
    out['output_key']: [{'source_id': 'wfd_p2_local_evidence', 'roles': ['compiler', 'deliverer']}]
    for out in unit_outputs}
unit_result = svc.submit(req)
if unit_result.get('status') != 'published_formal':
    (RUN / 'unit_failure.json').write_text(json.dumps(unit_result, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    raise SystemExit('unit foundation failed: ' + str(unit_result.get('status')))
unit_pid = next(o['product_id'] for o in unit_result['output_results']
                if o['output_key'] == 'unit_catalogue')
unit_sid = unit_result['snapshot_id']

rows = []
with gzip.open(MARKET, 'rt', encoding='utf-8-sig') as stream:
    for row in csv.DictReader(stream):
        if row.get('股票代码') != '000001' or not str(row.get('交易日期', '')).startswith('2025'):
            continue
        date_text = row['交易日期']
        rows.append((date_text, row))
rows = rows[-60:]
if len(rows) != 60:
    raise SystemExit('need 60 daily rows')
chunk_rows = []
public_times = {}
for date_text, row in rows:
    y, m, d = int(date_text[:4]), int(date_text[4:6]), int(date_text[6:8])
    key = 'daily_000001_' + date_text
    chunk_rows.append({
        'business_key': key, 'subject': {'kind': 'instrument', 'namespace': 'wfd.cn',
                                         'id': 'instrument_000001_a'},
        'observation_time': day(y, m, d),
        'values': {
            'close_price': {'data_type': 'decimal', 'value_state': 'valid_value',
                            'value': row['收盘价（元）']},
            'volume': {'data_type': 'decimal', 'value_state': 'valid_value',
                       'value': row['成交量（手）']},
            'price_adjustment': {'data_type': 'text', 'value_state': 'valid_value', 'value': 'unknown'},
            'source_basis': {'data_type': 'text', 'value_state': 'valid_value',
                             'value': 'local_compiled_daily'},
        }})
    public_times[key] = day(y, m, d)

field = lambda code, dtype, unit, nature='stock': {
    'field_code': code, 'data_type': dtype, 'unit_code': unit,
    'measurement_nature': nature, 'time_role': 'observation'}
header = {
    'protocol_version': 'wfd.ingest/1.3-candidate',
    'request_identity': {'dataset_id': DATASET, 'trusted_actor_namespace': NAMESPACE,
                         'request_id': 'p3a_batch_real_60',
                         'submission_digest': 'sha256:' + '0' * 64},
    'intent': 'submit', 'producer_namespace': NAMESPACE,
    'expected_parent_snapshot_id': unit_sid,
    'outputs': [{
        'output_key': 'p3a_batch_daily_60', 'logical_domain': 'observations',
        'subject': {'kind': 'instrument', 'namespace': 'wfd.cn', 'id': 'instrument_000001_a'},
        'definition_mode': 'create', 'definition_ref': None,
        'new_definition_declaration': {
            'semantic_code': 'cn.equity.daily.observed', 'measurement_nature': 'mixed_observation',
            'unit_code': 'per_field', 'definition_authority': 'wfd.project.market_semantics',
            'time_role': 'observation',
            'field_definitions': [field('close_price', 'decimal', 'cny_per_share'),
                                  field('volume', 'decimal', 'lot_100_shares', 'flow'),
                                  field('price_adjustment', 'text', 'not_applicable'),
                                  field('source_basis', 'text', 'not_applicable')]},
        'input_mode': 'partial_observation',
        'coverage': {'scope': {'instrument': 'instrument_000001_a', 'rows': 60},
                     'basis': 'observed_partial', 'completeness': 'partial',
                     'coverage_evidence': [evidence], 'absence_means': 'unknown'},
        'payload': {'kind': 'tabular_rows', 'rows': []},
        'evidence_refs': [evidence],
    }],
    'source_bundle': {
        'source_id': SOURCE, 'source_ids': [SOURCE],
        'source_roles': {'p3a_batch_daily_60': [{'source_id': SOURCE,
                                                 'roles': ['compiler', 'deliverer']}]},
        'row_public_times': {'p3a_batch_daily_60': public_times},
        'license': 'local_use_only', 'usage_scope': 'local_use',
        'raw_source_bytes_custodied': True,
        'product_service': {'version': SERVICE_VERSION,
                            'outputs': {'p3a_batch_daily_60': {'read_dependencies': [
                                {'dataset_id': DATASET, 'product_id': unit_pid,
                                 'snapshot_id': unit_sid, 'role': 'unit_definitions',
                                 'required': True}]}},
                            'consistency_groups': {'p3a_batch_real': ['p3a_batch_daily_60']}},
    },
}
ledger = ProductBatchLedger(svc, max_chunks=3, max_rows=60, max_bytes=2_000_000)
chunks = [chunk_rows[0:20], chunk_rows[20:40], chunk_rows[40:60]]
expected = [{'output_key': 'p3a_batch_daily_60', 'chunk_id': 'c1'},
            {'output_key': 'p3a_batch_daily_60', 'chunk_id': 'c2'},
            {'output_key': 'p3a_batch_daily_60', 'chunk_id': 'c3'}]
ledger.begin('p3a_batch_real_60', header=header, expected_chunks=expected)
# Out-of-order arrival, 20 rows each.
for idx in (2, 3, 1):
    ledger.put_chunk('p3a_batch_real_60', output_key='p3a_batch_daily_60',
                     chunk_id='c%d' % idx, rows=chunks[idx - 1])
pre = ledger.status('p3a_batch_real_60')
assert pre['received_chunks'] == 3 and not pre['missing']
result = ledger.finalize('p3a_batch_real_60')
if result.get('status') != 'published_formal':
    (RUN / 'summary.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    raise SystemExit('batch finalize failed: ' + str(result.get('status')))

reader = service(RUN / 'store', RUN / 'runtime_reader', READ_ROLES, 'p3-batch-real')
catalog_status = ProductBatchLedger(reader).status('p3a_batch_real_60')
pid = next(o['product_id'] for o in result['output_results']
           if o['output_key'] == 'p3a_batch_daily_60')
read = reader.read(pid, snapshot_id=result['snapshot_id'])
trace = reader.trace(pid, snapshot_id=result['snapshot_id'])
fields = {f['field_code']: f for f in read['products'][0]['contracts']['semantic']['fields']}
checks = {
    'batch_finalized': catalog_status['phase'] == 'finalized',
    'received_three_chunks': catalog_status['received_chunks'] == 3,
    'missing_none': catalog_status['missing'] == [],
    'snapshot_matches': catalog_status['snapshot_id'] == result['snapshot_id'],
    'read_60_rows': len(read['rows']) == 60,
    'first_value': read['rows'][0]['row']['values']['close_price']['value'] == rows[0][1]['收盘价（元）'],
    'last_value': read['rows'][-1]['row']['values']['close_price']['value'] == rows[-1][1]['收盘价（元）'],
    'known_units': fields['close_price']['unit_code'] == 'cny_per_share'
                    and fields['volume']['unit_code'] == 'lot_100_shares',
    'adjustment_unknown': all(r['row']['values']['price_adjustment']['value'] == 'unknown'
                              for r in read['rows']),
    'source_ids': all(r['source_binding']['source_ids'] == [SOURCE] for r in read['rows']),
    'evidence_verified': bool(trace['evidence']) and all(e['verified'] for e in trace['evidence']),
    'same_snapshot': all(r['record_ref']['snapshot_id'] == result['snapshot_id'] for r in read['rows']),
}
summary = {
    'status': 'p3a_batch_real_verified' if all(checks.values()) else 'p3a_batch_real_incomplete',
    'run': str(RUN.relative_to(REC)), 'snapshot_id': result['snapshot_id'],
    'unit_snapshot': unit_sid, 'unit_product': unit_pid,
    'batch_status': catalog_status, 'checks': checks,
    'checks_passed': sum(1 for v in checks.values() if v), 'checks_total': len(checks),
    'rows': len(read['rows']), 'chunk_order': ['c2', 'c3', 'c1'],
    'limits': {'max_chunks': 3, 'max_rows': 60, 'max_bytes': 2_000_000},
    'source_role': 'compiler/deliverer', 'adjustment': 'unknown',
    'not_claimed': ['not P3b/P7 complete', 'no minute unknown-unit conversion',
                    'only 60 observed daily rows'],
}
(RUN / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', 'utf-8')
(BATCHES / 'LATEST').write_text(RUN.name + '\n', 'utf-8')
print(json.dumps({'status': summary['status'], 'run': summary['run'],
                  'snapshot_id': summary['snapshot_id'], 'checks': checks,
                  'checks_passed': summary['checks_passed'], 'checks_total': summary['checks_total']},
                 ensure_ascii=False, indent=2))
if not all(checks.values()):
    raise SystemExit('BATCH_REAL_CHECKS_FAILED')
