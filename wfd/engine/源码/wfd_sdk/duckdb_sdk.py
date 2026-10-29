"""DuckDB-backed Parquet/ZSTD candidate using the original POC control flow.
Requires DuckDB; does not fall back silently. NOT production SDK.
"""
from __future__ import annotations

from wfd_sdk.writerlock import guarded_method, guarded_store_func

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from .state import StateStore, StateError
from .duckdb_storage import parquet_from_rows, rows_from_parquet, parse_footer, require_duckdb, DUCKDB_STORAGE_FORMAT

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

HERE = Path(__file__).resolve().parent
SUPPORTED_PROTOCOL = 'wfd.ingest/1.3-candidate'


def canonical(data: Any) -> bytes:
    # Only a local, deterministic POC encoding, NOT the normative state_digest/JCS.
    return json.dumps(data, ensure_ascii=False, allow_nan=False,
                      sort_keys=True, separators=(',', ':')).encode('utf-8')


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_id(v: str) -> str:
    return re.sub(r'[^a-z0-9_-]', '_', v.lower())[:64] or 'unknown'


def load_protocol_validator(root: Path) -> Draft202012Validator:
    schemas = {p.name: json.loads(p.read_text('utf-8')) for p in (root/'schemas').glob('*.schema.json') if not p.name.startswith('._')}
    registry = Registry()
    for schema in schemas.values():
        registry = registry.with_resource(schema['$id'], Resource.from_contents(schema))
    v = Draft202012Validator(schemas['wfd-ingest.schema.json'], registry=registry)
    v.check_schema(schemas['wfd-ingest.schema.json'])
    return v


class ValidationIssue(dict):
    def __init__(self, code, message, *, field_path=None, business_key=None):
        super().__init__(code=code, message=message)
        if field_path is not None:
            self['field_path']=field_path
        if business_key is not None:
            self['business_key']=business_key


def ident(obj: dict) -> tuple[str,str,str]:
    return obj['kind'], obj['namespace'], obj['id']


def check_time(t: dict, prefix: str) -> list[ValidationIssue]:
    errs=[]
    if t['status']!='known': return errs
    try:
        left=datetime.strptime(t['earliest_utc'],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
        right=datetime.strptime(t['latest_exclusive_utc'],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
        if not left < right:
            errs.append(ValidationIssue('TIME_INTERVAL_INVALID', 'Time interval must be nonempty and half-open',field_path=prefix))
    except (TypeError,ValueError):
        errs.append(ValidationIssue('TIME_ENCODING_INVALID','Invalid UTC time interval',field_path=prefix))
    return errs


def decimal_value(cell:dict) -> Decimal|None:
    v=cell.get('value')
    if v is None: return None
    try: return Decimal(v)
    except (InvalidOperation,TypeError,ValueError): return None


def field_issue(row, field_code, code, msg):
    return ValidationIssue(code,msg,field_path=f'values.{field_code}',business_key=row.get('business_key'))


def business_validate(output: dict, *, sandbox: bool=True) -> list[ValidationIssue]:
    """Minimal generic checks, not a replacement for financial product contracts."""
    errs=[]; p=output['payload']; kind=p['kind']; rows=p['rows']; declaration=output.get('new_definition_declaration')
    # During tests, a source-only unresolved identity may be staged but never released.
    refs=[output['subject']]
    for row in rows:
        for k in ['subject','object']:
            if k in row: refs.append(row[k])
        for key in ['observation_time','public_time','event_time','expected_time','effective_period']:
            if key in row: errs += check_time(row[key],f'rows.{key}')
    for ref in refs:
        if 'unresolved' in ref['namespace'].lower() or ref['id'].lower() in {'unknown','issuer_unknown','unknown_issuer'}:
            errs.append(ValidationIssue('NEEDS_ENTITY_RESOLUTION','Source-only unresolved identity is not a formal financial object',field_path='subject'))
            break
    if (declaration or {}).get('measurement_nature')=='derived':
        # The prototype has no engine to execute derived algorithms; enforce declared fixed lineage.
        # Caller may provide metadata on the output in a future versioned contract; current V1.3 has
        # no standardized lineage field in this output shape. Reject rather than invent lineage.
        errs.append(ValidationIssue('DERIVED_LINEAGE_NOT_IMPLEMENTED','Derived result needs fixed input snapshot and method identity; prototype cannot verify it'))
    if output['coverage']['basis']=='observed_partial' and output['coverage']['absence_means']=='explicitly_absent':
        errs.append(ValidationIssue('COVERAGE_ABSENCE_INCONSISTENT','Partial observation does not prove absent objects',field_path='coverage.absence_means'))
    if output['coverage']['basis']=='declared_full' and output['coverage']['completeness'] != 'complete':
        errs.append(ValidationIssue('COVERAGE_INCONSISTENT','Declared full coverage must be complete',field_path='coverage'))
    keys=set()
    for row in rows:
        bk=row.get('business_key',row.get('event_id'))
        if bk in keys:
            errs.append(ValidationIssue('DUPLICATE_BUSINESS_KEY','Repeated business/event key within candidate',business_key=bk))
        keys.add(bk)
    if kind=='tabular_rows':
        registered={f['field_code']:f for f in (declaration or {}).get('field_definitions',[])}
        for row in rows:
            vals=row['values']
            if registered:
                unknown=set(vals)-set(registered)
                if unknown:
                    errs.append(ValidationIssue('UNDECLARED_FIELD','Row contains fields absent from product declaration',field_path='values.'+sorted(unknown)[0],business_key=row['business_key']))
                for f,cell in vals.items():
                    if f in registered and registered[f]['data_type']!=cell['data_type']:
                        errs.append(field_issue(row,f,'FIELD_TYPE_MISMATCH','Cell data type does not match declared field'))
            if {'open','high','low','close'}.issubset(vals):
                d={key:decimal_value(vals[key]) for key in ['open','high','low','close']}
                if all(v is not None for v in d.values()):
                    if not(d['low']<=d['open']<=d['high'] and d['low']<=d['close']<=d['high']):
                        errs.append(ValidationIssue('OHLC_BOUNDS','OHLC violates low <= open/close <= high',business_key=row['business_key']))
                    if d['low']<=0:
                        errs.append(ValidationIssue('NONPOSITIVE_PRICE','Prices must be positive for this ordinary equity sample',business_key=row['business_key']))
            for f,cell in vals.items():
                if cell['value_state'] in {'valid_value','reported_zero'}:
                    x=decimal_value(cell)
                    # Unit check, not a general ban on negative financial values
                    if x is not None and f.lower() in {'volume','container_teu','autos_handled','vehicles_on_site','vehicle_count'} and x<0:
                        errs.append(field_issue(row,f,'NEGATIVE_QUANTITY','Physical quantity cannot be negative'))
                    if cell['value_state']=='reported_zero' and x is not None and x!=0:
                        errs.append(field_issue(row,f,'INVALID_REPORTED_ZERO','reported_zero must equal numeric zero'))
    if kind=='scalar_rows':
        unit=(declaration or {}).get('unit_code','').lower()
        sem=(declaration or {}).get('semantic_code','').lower()
        for row in rows:
            x=Decimal(row['value_decimal']) if row['value_decimal'] is not None else None
            if x is not None and row['value_state']=='reported_zero' and x!=0:
                errs.append(ValidationIssue('INVALID_REPORTED_ZERO','reported_zero must equal zero',business_key=row['business_key']))
            if x is not None and unit in {'vehicle','teu','share','unit_count','container'} and any(w in sem for w in ['production','throughput','inventory','count','handled']) and x<0:
                errs.append(ValidationIssue('NEGATIVE_QUANTITY','Negative physical stock/flow',business_key=row['business_key']))
    if kind=='relation_edges':
        for row in rows:
            if row.get('relation_type') in {'ownership','parent_organization','controls'}:
                # A training annotation is not validated actual ownership.
                if ('annotat' in (declaration or {}).get('semantic_code','').lower() or
                    row['effective_period']['status']!='known' or row['public_time']['status']!='known'):
                    errs.append(ValidationIssue('UNVERIFIED_RELATION','Financial ownership relation missing verification and historical periods',business_key=row['business_key']))
    if kind=='event_records':
        for row in rows:
            if row['content_nature'] in {'plan','forecast'} and row.get('expected_time') is None:
                errs.append(ValidationIssue('EXPECTED_TIME_MISSING','Future claim needs explicit expected time or an explicit unknown interval',business_key=row['event_id']))
            if row['event_time']['status']=='known' and row['content_nature'] in {'plan','forecast'} and row['status'] in {'completed','realized'}:
                errs.append(ValidationIssue('CLAIM_OUTCOME_CONFLATED','Plan is not an observed realized fact',business_key=row['event_id']))
    return errs


def eligibility_at(t:dict|None, cutoff: str, *, mode:str='market_known_at') -> dict:
    """Three-way determination: do NOT treat unknown as false/verified true."""
    if mode=='snapshot_contents':return {'decision':'eligible','reason':'snapshot_only_not_PIT'}
    if t is None or t.get('status')!='known':return {'decision':'indeterminate','reason':'PUBLICATION_OR_HELD_TIME_UNKNOWN'}
    end=t['latest_exclusive_utc'];start=t['earliest_utc']
    if end<=cutoff:return {'decision':'eligible','reason':'evidence_interval_ended_before_cutoff'}
    if start>=cutoff:return {'decision':'ineligible','reason':'time_interval_starts_after_cutoff'}
    return {'decision':'indeterminate','reason':'TIME_PRECISION_INSUFFICIENT'}


class WFDDuckDBPrototype:
    """Minimal schema+business validation -> Parquet -> manifest -> snapshot -> read.

    NOT production WFD. Written files are under disposable test root.
    """
    def __init__(self,root: Path,validator: Draft202012Validator, *, runtime_root:Path, sandbox=True,
                 writer_host:str|None=None, writer_epoch:int|None=None):
        require_duckdb()  # fail-fast instead of silently using the legacy writer
        self.root=Path(root);self.validator=validator;self.sandbox=sandbox
        self.runtime_root=Path(runtime_root)
        self.runtime_root.mkdir(parents=True,exist_ok=True)
        if self.runtime_root.resolve()==self.root.resolve() or self.root.resolve() in self.runtime_root.resolve().parents:
            raise ValueError("LOCAL_INDEX_MUST_BE_OUTSIDE_DATA_VOLUME")
        for sub in ['catalog/manifests','catalog/snapshots','catalog/commits','catalog/governance/receipts',
                    'catalog/lineage','catalog/recovery','catalog/forks',
                    'observations','foundation','events','_staging']:
            (self.root/sub).mkdir(parents=True,exist_ok=True)
        # ENG-01：初始化并校验权威 HEAD 状态（空指针，不从提交图推导）
        self.state=StateStore(self.root)
        self.writer_host=writer_host
        self.writer_epoch=writer_epoch
        self.state.ensure_initialized(writer_host=writer_host)
        # R-ST-03：保留状态默认"全部保留"；初始化时显式落盘，缺失即视为被篡改（GC09）
        ret=self.root/'catalog/retention.json'
        if not ret.exists():
            ret.write_text(json.dumps({'format_version':'wfd.retention/1.0',
                'updated_at_utc':datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                'policy':{'auto_expire':False,'keep_last_n':None,'keep_days':None},
                'snapshots':{}},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

    def _write_immutable(self,rel:str,raw:bytes)->None:
        target=self.root/rel;target.parent.mkdir(parents=True,exist_ok=True)
        if target.exists():
            if target.read_bytes()!=raw:raise RuntimeError('IMMUTABLE_FILE_COLLISION')
            return
        fd,tmp=tempfile.mkstemp(prefix='.wfd_tmp_',dir=target.parent)
        try:
            with os.fdopen(fd,'wb') as f:
                f.write(raw);f.flush();os.fsync(f.fileno())
            os.replace(tmp,target)
        finally:
            if os.path.exists(tmp):os.unlink(tmp)

    def _valid_snapshots(self):
        result=[]
        for p in [x for x in (self.root/'catalog/commits').glob('*.json') if not x.name.startswith('._')]:
            try:
                marker=json.loads(p.read_text('utf-8'))
                snap=self.root/marker['snapshot_file']
                sb=snap.read_bytes()
                if sha(sb)!=marker['snapshot_sha256']:continue
                d=json.loads(sb)
                manifest_bytes=(self.root/d['manifest_relpath']).read_bytes()
                if sha(manifest_bytes)!=d['manifest_sha256']:continue
                manifest=json.loads(manifest_bytes)
                if manifest['files']!=d['files']:continue
                if d['snapshot_id'] != marker['snapshot_id']:continue
                good=True
                for ent in d['files']:
                    payload=(self.root/ent['file_relpath']).read_bytes()
                    if sha(payload)!=ent['file_sha256']:good=False;break
                if good:result.append(d)
            except (OSError,ValueError,KeyError):continue
        return result

    def head(self):
        """正式 HEAD：只认 catalog/state.json.active_head（02 补丁 R-ST-01）。"""
        snaps=self._valid_snapshots()
        st=self.state.resolve(snaps)
        if not st['ok']:
            raise StateError(st['code'], st.get('detail',''))
        sid=st.get('snapshot_id')
        if sid is None:return None
        return next((d for d in snaps if d['snapshot_id']==sid),None)

    def diagnostic_heads(self):
        """诊断用：从 Commit 集合推导的头，不构成正式版本判定。"""
        snaps=self._valid_snapshots()
        ids={d['snapshot_id']:d for d in snaps}
        parents={d['parent_snapshot_id'] for d in snaps if d['parent_snapshot_id']}
        return sorted(sid for sid in ids if sid not in parents)

    def diagnose_head(self):
        return self.state.resolve(self._valid_snapshots())

    def recover_head(self, operator='engine-recovery', note=''):
        return self.state.recover(self._valid_snapshots(), operator, note=note)

    def _duplicate_entries(self, files):
        """ENG-06：同一产物同一路径不得重复登记；返回重复项。"""
        seen_aid, seen_rel, dup = set(), set(), []
        for f in files:
            aid=f['file_sha256'].split(':')[-1]
            rel=f['file_relpath']
            if aid in seen_aid or rel in seen_rel:
                dup.append({'artifact_id':aid[:12],'file_relpath':rel})
            seen_aid.add(aid); seen_rel.add(rel)
        return dup

    def _request_key(self,d):
        req=d['request_identity'];raw=canonical([req['dataset_id'],req['trusted_actor_namespace'],req['request_id']])
        return sha(raw)

    def _request_fingerprint(self,d):
        q=copy.deepcopy(d);q['request_identity'].pop('submission_digest',None)
        return sha(canonical(q))

    def _known_request(self,rid):
        fn=self.root/'catalog/governance/receipts'/f'{rid}.json'
        if fn.exists():return json.loads(fn.read_text('utf-8'))
        # Recover if process died after the marker was written but before receipt
        for d in self._valid_snapshots():
            if d.get('request_key')==rid:return d['receipt']
        return None

    @guarded_method

    def submit(self,doc:dict, *, fail_before_commit:bool=False, writer_epoch:int|None=None)->dict:
        schema_issues=sorted(self.validator.iter_errors(doc),key=lambda x:list(map(str,x.path)))
        if schema_issues:
            return {'status':'rejected_schema','errors':[ValidationIssue('SCHEMA_INVALID',x.message[:250],field_path='.'.join(map(str,x.path))) for x in schema_issues[:20]]}
        if doc['protocol_version']!=SUPPORTED_PROTOCOL:
            return {'status':'rejected_schema','errors':[ValidationIssue('UNSUPPORTED_PROTOCOL','Unsupported protocol version')]}
        # ENG-03：发布前必须解析出唯一权威 HEAD；HEAD 不可用则拒绝，不得回退到图推导
        head_state=self.state.resolve(self._valid_snapshots())
        if not head_state['ok']:
            return {'status':'rejected','errors':[ValidationIssue(head_state['code'],head_state.get('detail',''))]}
        if writer_epoch is not None and int((self.state.read() or {}).get('writer_epoch') or 0)!=writer_epoch:
            return {'status':'rejected','errors':[ValidationIssue('WRITER_EPOCH_MISMATCH','writer_epoch mismatch')]}
        key=self._request_key(doc);fingerprint=self._request_fingerprint(doc)
        prior=self._known_request(key)
        if prior:
            if prior.get('request_fingerprint')==fingerprint:
                return {**prior,'idempotent_replay':True}
            return {'status':'rejected','errors':[ValidationIssue('REQUEST_ID_CONFLICT','Same ID but different request contents')]}
        if not self.sandbox and doc['source_bundle'].get('raw_source_bytes_custodied') is not True:
            return {'status':'rejected','errors':[ValidationIssue('EVIDENCE_CUSTODY_UNVERIFIED','Cannot formally publish an uncustodied original')]}
        h=self.head();parent=h['snapshot_id'] if h else None
        if doc['expected_parent_snapshot_id']!=parent:
            return {'status':'rejected','errors':[ValidationIssue('PARENT_CHANGED','Expected parent Snapshot differs from current head')], 'actual_parent_snapshot_id':parent}
        accepted=[];rejected=[]
        for out in doc['outputs']:
            errors=business_validate(out,sandbox=self.sandbox)
            declaration=out.get('new_definition_declaration') or {'fixed_definition_ref':out.get('definition_ref')}
            pid='p_'+sha(canonical([out['logical_domain'],out['subject'],declaration]))[:24]
            existing_keys=set()
            for old in (h['files'] if h else []):
                if old['product_id']==pid:
                    for old_row in rows_from_parquet((self.root/old['file_relpath']).read_bytes()):
                        existing_keys.add(old_row.get('business_key',old_row.get('event_id')))
            new_keys={row.get('business_key',row.get('event_id')) for row in out['payload']['rows']}
            if new_keys & existing_keys:
                errors.append(ValidationIssue('DUPLICATE_EXISTING_BUSINESS_KEY','Existing product contains keys; corrections require versioned revision handling'))
            if out['input_mode'] in {'source_correction','processing_repair','withdrawal','coverage_revision'}:
                errors.append(ValidationIssue('INPUT_MODE_NOT_IMPLEMENTED','Prototype does not implement immutable revision/withdrawal semantics'))
            if errors:rejected.append({'output_key':out['output_key'],'errors':errors});continue
            accepted.append(out)
        if not accepted:
            return {'status':'rejected','errors':[e for entry in rejected for e in entry['errors']],'output_results':rejected}
        base_files=[] if h is None else copy.deepcopy(h['files'])
        # Important: retain earlier product entries and immutable files, no in-place updates.
        new_files=[]
        for out in accepted:
            definition=out.get('new_definition_declaration') or {'fixed_definition_ref':out.get('definition_ref')}
            pid='p_'+sha(canonical([out['logical_domain'],out['subject'],definition]))[:24]
            data=parquet_from_rows(pid,out['output_key'],out['subject'],out['payload']['kind'],out['payload']['rows'])
            parse_footer(data) # validate the footer before durable publish
            file_digest=sha(data)
            rel=f"{out['logical_domain']}/product={pid}/part-{file_digest[:24]}.parquet"
            self._write_immutable(rel,data)
            new_files.append({'product_id':pid,'output_key':out['output_key'],'file_relpath':rel,'file_sha256':file_digest,
                'row_count':len(out['payload']['rows']),'definition':definition,'subject':out['subject'],
                'source_bundle':doc['source_bundle'],'evidence_refs':out['evidence_refs'],
                'input_mode':out['input_mode'],'payload_kind':out['payload']['kind']})
        files=base_files+new_files
        dup=self._duplicate_entries(files)
        if dup:
            return {'status':'rejected','errors':[ValidationIssue('DUPLICATE_ARTIFACT',f'duplicate manifest entries: {dup[:3]}')],'output_results':dup}
        manifest={'parent_snapshot_id':parent,'files':files}
        mraw=canonical(manifest);mhash=sha(mraw)
        mrel=f'catalog/manifests/manifest_{mhash[:24]}.json'
        self._write_immutable(mrel,mraw)
        sid='s_'+sha(canonical([parent,key,fingerprint,mhash]))[:24]
        receipt={'status':'published_sandbox' if not rejected else 'partially_published_sandbox',
                 'snapshot_id':sid,'parent_snapshot_id':parent,'request_key':key,'request_fingerprint':fingerprint,
                 'outputs_success':[x['output_key'] for x in accepted], 'outputs_rejected':rejected,
                 'storage_format':DUCKDB_STORAGE_FORMAT,'duckdb_roundtrip_verified':True,'independent_other_engine_verified':False,'production_publishable':False}
        snap={'snapshot_id':sid,'parent_snapshot_id':parent,'manifest_relpath':mrel,'manifest_sha256':mhash,
              'files':files,'request_key':key,'request_fingerprint':fingerprint,'receipt':receipt}
        sraw=canonical(snap);srel=f'catalog/snapshots/{sid}.json'
        self._write_immutable(srel,sraw)
        if fail_before_commit:
            return {'status':'injected_failure_before_commit','orphan_snapshot_file':srel}
        craw=canonical({'snapshot_id':sid,'snapshot_file':srel,'snapshot_sha256':sha(sraw)})
        self._write_immutable(f'catalog/commits/{sid}.json',craw)
        self._write_immutable(f'catalog/governance/receipts/{key}.json',canonical(receipt))
        # ENG-03：受控更新 HEAD；失败时保留 commit，但不得冒充已激活
        act=self.state.activate(sid,self.root/srel,expected_prev=parent,
                                writer_host=self.writer_host,
                                writer_epoch=writer_epoch if writer_epoch is not None else self.writer_epoch)
        if not act.get('ok'):
            return {**receipt,'status':'published_commit_pending_head','head_state':act,
                    'errors':[ValidationIssue('HEAD_UPDATE_FAILED',act.get('detail',''))]}
        return receipt

    @guarded_method

    def publish_compaction(self,products:dict, *, writer_epoch:int|None=None)->dict:
        """ENG-05：对指定产品做合并压缩。

        写不可变新文件 → 新 Manifest/Snapshot/Commit → 受控更新 HEAD；
        原文件不覆盖、旧快照引用不变；同一产品只登记一条输出（ENG-06）。
        products: {product_id: rows[]}
        """
        snaps=self._valid_snapshots()
        st=self.state.resolve(snaps)
        if not st['ok']:
            return {'status':'rejected','errors':[ValidationIssue(st['code'],st.get('detail',''))]}
        head=self.head()
        if head is None:
            return {'status':'rejected','errors':[ValidationIssue('NO_ACTIVE_HEAD','cannot compact without an active head')]}
        files=[];new_files=[];seen=set()
        for ent in head['files']:
            pid=ent['product_id']
            if pid not in products:
                files.append(ent);continue
            if pid in seen:continue
            seen.add(pid)
            rows=products[pid]
            data=parquet_from_rows(pid,ent['output_key'],ent['subject'],ent['payload_kind'],rows)
            parse_footer(data)
            digest=sha(data)
            rel=f"{ent['file_relpath'].split('/product=')[0]}/product={pid}/part-{digest[:24]}.parquet"
            self._write_immutable(rel,data)
            files.append({**ent,'file_relpath':rel,'file_sha256':digest,'row_count':len(rows)})
            new_files.append(rel)
        dup=self._duplicate_entries(files)
        if dup:
            return {'status':'rejected','errors':[ValidationIssue('DUPLICATE_ARTIFACT',f'duplicate manifest entries: {dup[:3]}')],'output_results':dup}
        manifest={'parent_snapshot_id':head['snapshot_id'],'files':files}
        mraw=canonical(manifest);mhash=sha(mraw)
        mrel=f'catalog/manifests/manifest_{mhash[:24]}.json'
        self._write_immutable(mrel,mraw)
        sid='s_'+sha(canonical([head['snapshot_id'],mhash,'compaction']))[:24]
        receipt={'status':'published_compaction','snapshot_id':sid,'parent_snapshot_id':head['snapshot_id'],
                 'outputs_success':sorted(products),'new_files':new_files,'production_publishable':False}
        snap={'snapshot_id':sid,'parent_snapshot_id':head['snapshot_id'],'manifest_relpath':mrel,
              'manifest_sha256':mhash,'files':files,'request_key':'compaction_'+mhash[:16],
              'request_fingerprint':mhash,'receipt':receipt}
        sraw=canonical(snap);srel=f'catalog/snapshots/{sid}.json'
        self._write_immutable(srel,sraw)
        craw=canonical({'snapshot_id':sid,'snapshot_file':srel,'snapshot_sha256':sha(sraw)})
        self._write_immutable(f'catalog/commits/{sid}.json',craw)
        act=self.state.activate(sid,self.root/srel,expected_prev=head['snapshot_id'],
                                writer_host=self.writer_host,
                                writer_epoch=writer_epoch if writer_epoch is not None else self.writer_epoch)
        if not act.get('ok'):
            return {**receipt,'status':'published_commit_pending_head','head_state':act}
        return receipt

    def read_snapshot(self,snapshot_id=None):
        snap=self.head() if snapshot_id is None else next((s for s in self._valid_snapshots() if s['snapshot_id']==snapshot_id),None)
        if snap is None: raise ValueError('SNAPSHOT_UNAVAILABLE_OR_INVALID')
        return snap

    def read_product(self,product_id=None, *,snapshot_id=None,domain=None):
        snap=self.read_snapshot(snapshot_id);result=[]
        for entry in snap['files']:
            if product_id and entry['product_id']!=product_id:continue
            if domain and not entry['file_relpath'].startswith(domain+'/'):continue
            raw=(self.root/entry['file_relpath']).read_bytes()
            if sha(raw)!=entry['file_sha256']:raise ValueError('CHECKSUM_MISMATCH')
            rows=rows_from_parquet(raw)
            result.append({'product_id':entry['product_id'],'metadata':{'definition':entry['definition'],'subject':entry['subject'],'payload_kind':entry['payload_kind']},'rows':rows,'evidence':entry['evidence_refs'],'source':entry['source_bundle']})
        return result

    def rebuild_sqlite_index(self):
        """Disposable index, never used as authoritative snapshot source."""
        p=self.runtime_root/'local_index.sqlite'
        if p.exists():p.unlink()
        db=sqlite3.connect(p)
        db.executescript('CREATE TABLE entries (snapshot_id TEXT,product_id TEXT,object_kind TEXT,object_id TEXT,relative_path TEXT, row_count INTEGER);CREATE INDEX pidx ON entries(product_id);')
        for s in self._valid_snapshots():
            for f in s['files']:
                db.execute('INSERT INTO entries VALUES (?,?,?,?,?,?)',(s['snapshot_id'],f['product_id'],f['subject']['kind'],f['subject']['id'],f['file_relpath'],f['row_count']))
        db.commit();db.close()
        return str(p)

    def export_test_bundle(self,product_id:str,destination:Path, *,snapshot_id=None):
        """Limited one-product, read-only *sandbox* export (not formal WFD full/delta bundle)."""
        snap=self.read_snapshot(snapshot_id)
        entries=[f for f in snap['files'] if f['product_id']==product_id]
        if not entries:raise ValueError('PRODUCT_NOT_FOUND')
        destination=Path(destination);destination.mkdir(parents=True,exist_ok=True)
        from shutil import copyfile
        out=[]
        for ent in entries:
            raw=(self.root/ent['file_relpath']).read_bytes()
            if sha(raw)!=ent['file_sha256']:raise ValueError('CHECKSUM_MISMATCH')
            rel=Path('data')/Path(ent['file_relpath']).name
            (destination/rel).parent.mkdir(parents=True,exist_ok=True)
            (destination/rel).write_bytes(raw)
            out.append({'rel_path':rel.as_posix(),'sha256':sha(raw),'row_count':ent['row_count'],
                        'definition':ent['definition'],'subject':ent['subject'],'source':ent['source_bundle'],
                        'evidence_refs':ent['evidence_refs']})
        bundle={'kind':'wfd_poc_test_bundle','source_snapshot_id':snap['snapshot_id'],'product_id':product_id,
                'read_self_contained':True,'audit_self_contained':False,'recomputable':False,
                'formal_wfd_bundle':False,'files':out}
        (destination/'bundle.json').write_bytes(canonical(bundle))
        return bundle


def verify_test_bundle(destination:Path)->dict:
    destination=Path(destination); bundle=json.loads((destination/'bundle.json').read_text('utf-8'))
    if bundle.get('kind')!='wfd_poc_test_bundle':raise ValueError('INVALID_BUNDLE')
    rows=[]
    for ent in bundle['files']:
        rel=Path(ent['rel_path'])
        if rel.is_absolute() or '..' in rel.parts:raise ValueError('PATH_TRAVERSAL')
        b=(destination/rel).read_bytes()
        if sha(b)!=ent['sha256']:raise ValueError('CHECKSUM_MISMATCH')
        rows.extend(rows_from_parquet(b))
    return {'verified':True,'source_snapshot_id':bundle['source_snapshot_id'],'rows':rows,
            'read_self_contained':bundle['read_self_contained'],'audit_self_contained':bundle['audit_self_contained']}
