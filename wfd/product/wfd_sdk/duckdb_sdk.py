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
from .duckdb_storage import parquet_from_rows, rows_from_parquet, parse_footer, require_duckdb, matching_business_keys, DUCKDB_STORAGE_FORMAT
from . import row_version_objects

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


def load_protocol_validator(root: Path, entry: str = 'wfd-ingest.schema.json') -> Draft202012Validator:
    """按受信配置选择内部写入契约；默认仍是旧的 wfd-ingest（旧 Profile 行为不变）。"""
    schemas = {p.name: json.loads(p.read_text('utf-8')) for p in (root/'schemas').glob('*.schema.json') if not p.name.startswith('._')}
    registry = Registry()
    for schema in schemas.values():
        registry = registry.with_resource(schema['$id'], Resource.from_contents(schema))
    v = Draft202012Validator(schemas[entry], registry=registry)
    v.check_schema(schemas[entry])
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


def business_validate(output: dict, *, sandbox: bool=True, derived_lineage: dict|None=None,
                      derived_verifier=None, data_only_write=False) -> list[ValidationIssue]:
    """Minimal generic checks, not a replacement for financial product contracts."""
    errs=[]; p=output['payload']; kind=p['kind']
    if kind=='metadata_revision':
        return errs
    rows=p.get('rows',[]); declaration=output.get('new_definition_declaration')
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
    semantic_context=(declaration or {}).get('semantic_context') or {}
    derivation=semantic_context.get('derivation') or {}
    # The structured data profile persists the business formula and result. The
    # originating BD instance holds the run proof. Full-profile lineage rules
    # still apply to legacy documents and to outputs explicitly requiring it.
    algorithm=(declaration or {}).get('algorithm_definition') or {}
    external_calculation=(data_only_write and semantic_context.get('content_nature')=='deterministic_derived'
                          and isinstance(algorithm,dict) and bool(algorithm.get('mathematical_definition')))
    requires_lineage=(((declaration or {}).get('measurement_nature')=='derived' and not external_calculation)
                      or derivation.get('required') is True)
    if requires_lineage:
        # WFD never computes derived values.  A computed result (including a
        # forecast whose measurement nature remains flow) must carry a fixed
        # external lineage; the verifier re-derives the input content digests,
        # checks method/code/parameter custody and warm-up states.
        if not isinstance(derived_lineage, dict):
            errs.append(ValidationIssue('DERIVED_LINEAGE_REQUIRED','Derived result needs fixed input, method and warm-up lineage'))
        elif derived_verifier is None:
            errs.append(ValidationIssue('DERIVED_LINEAGE_UNVERIFIED','Derived lineage is present but no verifier was supplied'))
        else:
            errs.extend(derived_verifier(output, derived_lineage))
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


def _payload_key_field(payload_kind: str) -> str:
    return 'event_id' if payload_kind == 'event_records' else 'business_key'


def product_content_records(product_id: str, parts) -> list:
    """Resolve one product's *current* logical content from all its files.

    ``parts`` is an iterable of {output_key, payload_kind, rows, source}.  The
    per-batch ``_wfd_row_versions`` maps are combined before leaf selection, so
    a correction in a later file supersedes the earlier physical row.  The
    result is deterministic and contains no storage path or timestamp.  It is
    the exact content identity used for external-derived input pinning.
    """
    grouped = {}
    for part in parts:
        output_key = part.get('output_key')
        payload_kind = part.get('payload_kind') or 'scalar_rows'
        key_field = _payload_key_field(payload_kind)
        source = part.get('source') or {}
        versions = (source.get('_wfd_row_versions') or {}).get(output_key, {})
        for raw_row in part.get('rows') or []:
            row = copy.deepcopy(raw_row)
            physical = row.get(key_field)
            version = versions.get(physical)
            if version is None:
                logical = physical
                revision_id = 'r_legacy_' + sha(canonical([product_id, row]))[:32]
                supersedes = None
                withdrawn = False
                input_mode = part.get('input_mode') or 'legacy'
            else:
                logical = version.get('logical_key')
                revision_id = version.get('revision_id')
                supersedes = version.get('supersedes')
                withdrawn = bool(version.get('withdrawn'))
                input_mode = version.get('input_mode')
            row[key_field] = logical
            grouped.setdefault(logical, []).append({
                'output_key': output_key,
                'logical_key': logical,
                'revision_id': revision_id,
                'supersedes': supersedes,
                'withdrawn': withdrawn,
                'input_mode': input_mode,
                'row': row,
            })
    superseded = {entry['supersedes'] for entries in grouped.values()
                  for entry in entries if entry.get('supersedes')}
    current = []
    for logical in sorted(grouped, key=lambda value: str(value)):
        leaves = [entry for entry in grouped[logical]
                  if entry['revision_id'] not in superseded]
        for entry in leaves:
            if entry['withdrawn']:
                continue
            current.append({
                'output_key': entry['output_key'],
                'logical_key': entry['logical_key'],
                'revision_id': entry['revision_id'],
                'input_mode': entry['input_mode'],
                'row': entry['row'],
            })
    current.sort(key=lambda item: (str(item['output_key']), str(item['logical_key']),
                                   str(item['revision_id'])))
    return current


def product_content_digest(product_id: str, parts) -> str:
    return 'sha256:' + sha(canonical(product_content_records(product_id, parts)))


PROCESSING_RECORD_FORMAT = 'wfd.external-processing/1.0'


def derived_output_digest(output: dict) -> str:
    """Digest binding an external processing record to the exact submitted output."""
    return 'sha256:' + sha(canonical({
        'output_key': output.get('output_key'),
        'logical_domain': output.get('logical_domain'),
        'subject': output.get('subject'),
        'payload_kind': (output.get('payload') or {}).get('kind'),
        'rows': (output.get('payload') or {}).get('rows', []),
    }))


def external_processing_record_errors(record, *, output_key, input_digests,
                                      method_digest, method_code_digest,
                                      parameter_digest, output_digest):
    """Pure checks for the external execution record binding.

    This checks declared identities and content links, not the mathematical
    correctness of the external result.
    """
    errs = []
    if not isinstance(record, dict):
        return ['PROCESSING_RECORD_NOT_OBJECT']
    if record.get('format_version') != PROCESSING_RECORD_FORMAT:
        errs.append('PROCESSING_RECORD_FORMAT_INVALID')
    if record.get('output_key') != output_key:
        errs.append('PROCESSING_OUTPUT_KEY_MISMATCH')
    if sorted(record.get('input_digests') or []) != sorted(input_digests):
        errs.append('PROCESSING_INPUT_DIGESTS_MISMATCH')
    if record.get('method_digest') != method_digest:
        errs.append('PROCESSING_METHOD_DIGEST_MISMATCH')
    if record.get('method_code_digest') != method_code_digest:
        errs.append('PROCESSING_METHOD_CODE_DIGEST_MISMATCH')
    if record.get('parameter_digest') != parameter_digest:
        errs.append('PROCESSING_PARAMETER_DIGEST_MISMATCH')
    if record.get('output_digest') != output_digest:
        errs.append('PROCESSING_OUTPUT_DIGEST_MISMATCH')
    return errs



class WFDDuckDBPrototype:
    """Minimal schema+business validation -> Parquet -> manifest -> snapshot -> read.

    NOT production WFD. Written files are under disposable test root.
    """
    @classmethod
    def open_existing(cls, root: Path, validator: Draft202012Validator, *,
                      runtime_root: Path, read_only: bool = True, sandbox=True,
                      writer_host: str | None = None, writer_epoch: int | None = None):
        """Open an initialized store without repairing or initializing its files.

        Read-only opens also leave the local runtime untouched.  A writable open
        is a separate choice; it never creates a missing store/state/retention.
        """
        return cls(root, validator, runtime_root=runtime_root, sandbox=sandbox,
                   writer_host=writer_host, writer_epoch=writer_epoch,
                   initialize=False, read_only=read_only)

    @classmethod
    def initialize_new(cls, root: Path, validator: Draft202012Validator, *,
                       runtime_root: Path, sandbox=True,
                       writer_host: str | None = None, writer_epoch: int | None = None):
        """Explicit provisioning only, after the owner authorizes a new store.

        This storage API does not grant caller roles and is not a machine
        operation.  Never interpret a nonempty selected directory as a new WFD.
        """
        root = Path(root)
        if root.exists() and (not root.is_dir() or any(root.iterdir())):
            raise ValueError("STORE_INITIALIZATION_REQUIRES_EMPTY_DIRECTORY")
        return cls(root, validator, runtime_root=runtime_root, sandbox=sandbox,
                   writer_host=writer_host, writer_epoch=writer_epoch,
                   initialize=True, read_only=False)

    def __init__(self,root: Path,validator: Draft202012Validator, *, runtime_root:Path, sandbox=True,
                 writer_host:str|None=None, writer_epoch:int|None=None,
                 initialize:bool=True, read_only:bool=False):
        # The legacy constructor still supports explicit test/provisioning
        # callers. Machine connections must use open_existing, not its defaults.
        require_duckdb()  # fail-fast instead of silently using the legacy writer
        if read_only:
            initialize = False
        self.root=Path(root);self.validator=validator;self.sandbox=sandbox
        try:
            self.expected_protocol = validator.schema['properties']['protocol_version']['const']
        except Exception:
            self.expected_protocol = SUPPORTED_PROTOCOL
        self.runtime_root=Path(runtime_root)
        self.read_only=bool(read_only)
        self.writer_host=writer_host
        self.writer_epoch=writer_epoch
        self.state=StateStore(self.root)
        if not initialize:
            if not self.root.is_dir() or not self.state.path.is_file():
                raise FileNotFoundError("FORMAL_VOLUME_NOT_INITIALIZED:" + str(self.root))
        if self.read_only:
            return
        if self.runtime_root.resolve()==self.root.resolve() or self.root.resolve() in self.runtime_root.resolve().parents:
            raise ValueError("LOCAL_INDEX_MUST_BE_OUTSIDE_DATA_VOLUME")
        self.runtime_root.mkdir(parents=True,exist_ok=True)
        if initialize:
            for sub in ['catalog/manifests','catalog/snapshots','catalog/commits','catalog/governance/receipts',
                        'catalog/lineage','catalog/recovery','catalog/forks',
                        'observations','foundation','events','_staging']:
                (self.root/sub).mkdir(parents=True,exist_ok=True)
            # ENG-01：初始化并校验权威 HEAD 状态（空指针，不从提交图推导）
            self.state.ensure_initialized(writer_host=writer_host)
        # R-ST-03：保留状态默认"全部保留"；初始化时显式落盘，缺失即视为被篡改（GC09）
        ret=self.root/'catalog/retention.json'
        if initialize and not ret.exists():
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
        from .indexed_bulk import SNAPSHOT_PREFIXES
        result=[]
        for p in [x for x in (self.root/'catalog/commits').glob('*.json') if not x.name.startswith('._')]:
            try:
                marker=json.loads(p.read_text('utf-8'))
                if str(marker.get('snapshot_file', '')).startswith(SNAPSHOT_PREFIXES):
                    raise RuntimeError('SOURCE_MINUTE_SNAPSHOT_OPERATION_UNSUPPORTED')
                snap=self.root/row_version_objects.snapshot_relative(marker,marker['snapshot_id'])
                sb=snap.read_bytes()
                if sha(sb)!=marker['snapshot_sha256']:continue
                d=json.loads(sb)
                if d.get('source_minute_root') is not None or d.get('tabular_root') is not None:
                    raise RuntimeError('SOURCE_MINUTE_SNAPSHOT_OPERATION_UNSUPPORTED')
                manifest_bytes=(self.root/d['manifest_relpath']).read_bytes()
                if sha(manifest_bytes)!=d['manifest_sha256']:continue
                manifest=json.loads(manifest_bytes)
                if manifest['files']!=d['files']:continue
                if d['snapshot_id'] != marker['snapshot_id']:continue
                row_version_objects.project_snapshot(self.root,d)
                good=True
                for ent in d['files']:
                    payload=(self.root/ent['file_relpath']).read_bytes()
                    if sha(payload)!=ent['file_sha256']:good=False;break
                if good:result.append(d)
            except (OSError,ValueError,KeyError):continue
        return result

    def _resolved_head(self):
        """Validate the authoritative head, without hydrating unrelated history."""
        state = self.state.read()
        sid = (state or {}).get('active_head')
        snaps = None
        if isinstance(sid, str) and re.fullmatch(r's_[0-9a-f]{24}', sid):
            try:
                snaps = [self._valid_snapshot_exact(sid)]
            except ValueError:
                pass  # Preserve the existing missing/corrupt/ambiguous diagnostics.
        if snaps is None:
            snaps = self._valid_snapshots()
        resolved = self.state.resolve(snaps)
        current = next((item for item in snaps if item['snapshot_id'] == resolved.get('snapshot_id')), None)
        return resolved, current

    def head(self):
        """正式 HEAD：只认 catalog/state.json.active_head（02 补丁 R-ST-01）。"""
        st, current = self._resolved_head()
        if not st['ok']:
            raise StateError(st['code'], st.get('detail',''))
        return current

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

    def _resolved_product_id(self,doc,out):
        value=(doc.get('source_bundle',{}).get('_wfd_resolved_product_ids') or {}).get(out.get('output_key'))
        if value is not None:
            if not isinstance(value,str) or not value.startswith('p_') or len(value)!=26:
                raise ValueError('RESOLVED_PRODUCT_ID_INVALID')
            return value
        declaration=out.get('new_definition_declaration') or {'fixed_definition_ref':out.get('definition_ref')}
        return 'p_'+sha(canonical([out['logical_domain'],out['subject'],declaration]))[:24]

    def _request_fingerprint(self,d):
        q=copy.deepcopy(d);q['request_identity'].pop('submission_digest',None)
        return sha(canonical(q))

    def _known_request(self,rid):
        fn=self.root/'catalog/governance/receipts'/f'{rid}.json'
        if fn.exists():return json.loads(fn.read_text('utf-8'))
        # The cache contains only identities from metadata already verified in
        # this engine instance. Every negative reuse re-reads and hashes all
        # three authoritative files; filesystem timestamps are never trusted.
        cache = getattr(self, '_negative_request_metadata', None)
        if cache is None:
            cache = self._negative_request_metadata = {}
        # Recover if process died after the marker was written but before receipt
        for path in (self.root/'catalog/commits').glob('*.json'):
            if path.name.startswith('._'):
                continue
            try:
                marker_bytes = path.read_bytes()
                prior = cache.get(path.name)
                if (prior and prior['request_key'] != rid
                        and sha(marker_bytes) == prior['marker_sha256']
                        and sha((self.root/prior['snapshot_file']).read_bytes()) == prior['snapshot_sha256']
                        and sha((self.root/prior['manifest_relpath']).read_bytes()) == prior['manifest_sha256']):
                    continue
                marker = json.loads(marker_bytes)
                lookup = marker.get('request_lookup')
                if (isinstance(lookup, dict) and set(lookup) == {
                        'parent_snapshot_id', 'request_key', 'request_fingerprint', 'manifest_sha256'}
                        and marker.get('request_lookup_sha256') == sha(canonical(lookup))
                        and marker.get('snapshot_id') == path.stem
                        and row_version_objects.snapshot_relative(marker,path.stem) == f'catalog/snapshots/{path.stem}.json'
                        and marker['snapshot_id'] == 's_' + sha(canonical([
                            lookup['parent_snapshot_id'], lookup['request_key'],
                            lookup['request_fingerprint'], lookup['manifest_sha256']]))[:24]):
                    if lookup['request_key'] != rid:
                        continue
                # Old or inconsistent lookups use the original commit-bound
                # snapshot and manifest as the identity index. An unrelated
                # request cannot become a match through payload contents.
                from .indexed_bulk import SNAPSHOT_PREFIXES
                if str(marker.get('snapshot_file', '')).startswith(SNAPSHOT_PREFIXES):
                    continue  # The separate bulk intent/ledger owns this request identity.
                d = self._valid_snapshot_exact(marker['snapshot_id'], verify_payloads=False)
                if d.get('request_key') != rid:
                    cache[path.name] = {
                        'request_key':d.get('request_key'),'marker_sha256':sha(marker_bytes),
                        'snapshot_file':row_version_objects.snapshot_relative(marker,path.stem),'snapshot_sha256':marker['snapshot_sha256'],
                        'manifest_relpath':d['manifest_relpath'],'manifest_sha256':d['manifest_sha256']}
                    continue
                # A matching identity always retains the original full file
                # verification, including lost-receipt recovery of old commits.
                return self._valid_snapshot_exact(marker['snapshot_id'])['receipt']
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return None

    def _snapshot_product_parts(self, snapshot, product_id):
        """Read one product's files from an already validated fixed snapshot."""
        parts=[]
        for entry in snapshot['files']:
            if entry.get('product_id')!=product_id:
                continue
            raw=(self.root/entry['file_relpath']).read_bytes()
            if sha(raw)!=entry['file_sha256']:
                raise ValueError('CHECKSUM_MISMATCH')
            parts.append({'output_key':entry['output_key'],'payload_kind':entry['payload_kind'],
                          'input_mode':entry.get('input_mode'),'rows':rows_from_parquet(raw),
                          'source':entry['source_bundle']})
        return parts

    @staticmethod
    def _lineage_digest(body):
        return 'sha256:'+sha(canonical(body))

    def _custodied_lineage_record(self, relative, digest, required_fields):
        hex_digest=(digest or '').removeprefix('sha256:')
        if len(hex_digest)!=64:
            raise ValueError('LINEAGE_DIGEST_INVALID')
        path=self.root/relative/f'{hex_digest}.json'
        if not path.is_file():
            raise ValueError('LINEAGE_RECORD_MISSING')
        raw=path.read_bytes()
        if sha(raw)!=hex_digest:
            raise ValueError('LINEAGE_RECORD_DIGEST_MISMATCH')
        body=json.loads(raw)
        if self._lineage_digest(body)!=digest:
            raise ValueError('LINEAGE_BODY_DIGEST_MISMATCH')
        if not isinstance(body,dict) or any(field not in body for field in required_fields):
            raise ValueError('LINEAGE_RECORD_INCOMPLETE')
        return body

    def _active_ancestry(self):
        head=self.head()
        chain=set()
        cursor=head.get('snapshot_id') if head else None
        while cursor and cursor not in chain:
            chain.add(cursor)
            try:
                snap=self._valid_snapshot_exact(cursor,verify_payloads=False)
            except ValueError:
                break
            cursor=snap.get('parent_snapshot_id')
        return chain

    def _derived_warmup_errors(self, output, lineage):
        errs=[]
        warmup=lineage.get('warmup') if isinstance(lineage.get('warmup'),dict) else {}
        validity=lineage.get('validity') if isinstance(lineage.get('validity'),dict) else {}
        status=warmup.get('status'); state=validity.get('state')
        required=warmup.get('required_observations'); available=warmup.get('available_observations')
        if status not in {'sufficient','partial','insufficient'}:
            errs.append(ValidationIssue('DERIVED_WARMUP_STATUS_INVALID','Warm-up status must be sufficient, partial or insufficient'))
            return errs
        if type(required) is not int or type(available) is not int or required<0 or available<0:
            errs.append(ValidationIssue('DERIVED_WARMUP_COUNT_INVALID','Warm-up counts must be non-negative integers'))
            return errs
        expected={'sufficient':'valid','partial':'partial','insufficient':'insufficient_warmup'}[status]
        if state!=expected:
            errs.append(ValidationIssue('DERIVED_VALIDITY_STATE_MISMATCH','Validity state does not match warm-up status'))
        if status in {'sufficient','partial'} and available<required:
            errs.append(ValidationIssue('DERIVED_WARMUP_COUNT_INVALID','Sufficient/partial warm-up needs available >= required'))
        if status=='insufficient' and available>=required:
            errs.append(ValidationIssue('DERIVED_WARMUP_COUNT_INVALID','Insufficient warm-up needs available < required'))
        states=[]
        for row in output.get('payload',{}).get('rows',[]):
            if 'value_state' in row:
                states.append(row.get('value_state'))
            values=row.get('values')
            if isinstance(values,dict):
                for cell in values.values():
                    if isinstance(cell,dict):
                        states.append(cell.get('value_state'))
        insufficient=sum(1 for value in states if value=='insufficient_warmup')
        non_null=sum(1 for value in states if value in {'valid_value','reported_zero'})
        if status=='sufficient' and insufficient:
            errs.append(ValidationIssue('DERIVED_WARMUP_STATE_MISMATCH','Sufficient warm-up cannot contain insufficient_warmup values'))
        if status=='insufficient' and (non_null or not insufficient):
            errs.append(ValidationIssue('DERIVED_WARMUP_STATE_MISMATCH','Insufficient warm-up must be represented by null insufficient_warmup values'))
        if status=='partial' and (not insufficient or not non_null):
            errs.append(ValidationIssue('DERIVED_WARMUP_STATE_MISMATCH','Partial warm-up needs both insufficient_warmup and valid values'))
        return errs

    def _derived_lineage_errors(self, output, lineage, doc):
        """Full external-derived verification, not a naming check.

        The engine never executes the method.  It re-derives each pinned input
        product's content digest from the fixed snapshot, checks the method and
        parameter bodies in local custody, checks processing evidence bytes and
        checks the declared warm-up against actual value states.
        """
        errs=[]; root=self.root
        dataset_id=doc['request_identity']['dataset_id']
        pid=self._resolved_product_id(doc,output)
        declaration=output.get('new_definition_declaration') or {}
        semantic_context=declaration.get('semantic_context') or {}
        derivation=semantic_context.get('derivation') or {}
        requires_lineage=(declaration.get('measurement_nature')=='derived'
                          or derivation.get('required') is True)
        if not requires_lineage:
            errs.append(ValidationIssue('DERIVED_LINEAGE_NOT_APPLICABLE','Lineage is only valid for a computed/derived declaration'))
            return errs
        if lineage.get('format_version')!='wfd.derived-lineage/1.0':
            errs.append(ValidationIssue('DERIVED_LINEAGE_FORMAT_INVALID','Unsupported derived lineage format'))
        if lineage.get('output_key')!=output.get('output_key'):
            errs.append(ValidationIssue('DERIVED_LINEAGE_OUTPUT_MISMATCH','Lineage is bound to a different output_key'))
        if lineage.get('product_id')!=pid:
            errs.append(ValidationIssue('DERIVED_PRODUCT_MISMATCH','Lineage product_id differs from the resolved product'))
        if lineage.get('dataset_id')!=dataset_id:
            errs.append(ValidationIssue('DERIVED_DATASET_MISMATCH','Lineage dataset differs from the request dataset'))
        if lineage.get('computation')!='external':
            errs.append(ValidationIssue('DERIVED_WFD_EXECUTION_NOT_SUPPORTED','WFD does not compute derived values; computation must be external'))
        if lineage.get('definition_authority')!=declaration.get('definition_authority'):
            errs.append(ValidationIssue('DERIVED_AUTHORITY_MISMATCH','Lineage authority differs from the declaration authority'))
        if lineage.get('declaration_digest')!=self._lineage_digest(declaration):
            errs.append(ValidationIssue('DERIVED_DECLARATION_DIGEST_MISMATCH','Lineage declaration digest is not the submitted declaration'))
        body=copy.deepcopy(lineage); claimed=body.pop('lineage_digest',None)
        if claimed!=self._lineage_digest(body):
            errs.append(ValidationIssue('DERIVED_LINEAGE_DIGEST_MISMATCH','Normalized lineage digest does not verify'))
        else:
            try:
                stored=self._custodied_lineage_record('catalog/product_service/derived_lineage',claimed,
                                                      {'format_version','output_key','product_id','inputs','method'})
                if canonical(stored)!=canonical(body):
                    errs.append(ValidationIssue('DERIVED_LINEAGE_CUSTODY_MISMATCH','Custodied lineage body differs from the submitted lineage'))
            except (ValueError,OSError) as exc:
                errs.append(ValidationIssue('DERIVED_LINEAGE_CUSTODY_MISMATCH',str(exc)))
        method=lineage.get('method') if isinstance(lineage.get('method'),dict) else {}
        if not method:
            errs.append(ValidationIssue('DERIVED_METHOD_REQUIRED','A custodied method declaration is required'))
        else:
            try:
                body_method=self._custodied_lineage_record('catalog/product_service/derived_methods',method.get('digest'),
                                                           {'method_id','version','declaration'})
                if (body_method.get('method_id')!=method.get('method_id')
                        or body_method.get('version')!=method.get('version')):
                    errs.append(ValidationIssue('DERIVED_METHOD_CUSTODY_MISMATCH','Custodied method identity differs from lineage'))
            except (ValueError,OSError) as exc:
                errs.append(ValidationIssue('DERIVED_METHOD_NOT_VERIFIABLE',str(exc)))
        if not method.get('parameter_version') or not method.get('parameter_digest'):
            errs.append(ValidationIssue('DERIVED_PARAMETERS_REQUIRED','Method parameters need a custodied version and digest'))
        else:
            try:
                body_params=self._custodied_lineage_record('catalog/product_service/derived_parameters',method.get('parameter_digest'),
                                                           {'method_id','version','parameter_version','parameters'})
                if (body_params.get('method_id')!=method.get('method_id')
                        or body_params.get('version')!=method.get('version')
                        or body_params.get('parameter_version')!=method.get('parameter_version')):
                    errs.append(ValidationIssue('DERIVED_PARAMETER_CUSTODY_MISMATCH','Custodied parameter identity differs from lineage'))
            except (ValueError,OSError) as exc:
                errs.append(ValidationIssue('DERIVED_PARAMETERS_REQUIRED',str(exc)))
        if not method.get('code_digest') or not method.get('code_format'):
            errs.append(ValidationIssue('DERIVED_METHOD_CODE_REQUIRED','A custodied code/formula implementation digest is required'))
        else:
            try:
                code_body=self._custodied_lineage_record('catalog/product_service/derived_method_code',
                                                         method.get('code_digest'),{'code_format'})
                if code_body.get('code_format')!=method.get('code_format'):
                    errs.append(ValidationIssue('DERIVED_METHOD_CODE_CUSTODY_MISMATCH','Custodied code format differs from lineage'))
                if 'code' in code_body:
                    if not isinstance(code_body.get('code'),str) or not code_body['code'].strip():
                        errs.append(ValidationIssue('DERIVED_METHOD_CODE_REQUIRED','Inline method code is empty'))
                elif 'content_sha256' in code_body:
                    code_digest=(code_body.get('content_sha256') or '').removeprefix('sha256:')
                    code_path=root/'evidence/sha256'/code_digest
                    if len(code_digest)!=64 or not code_path.is_file() or sha(code_path.read_bytes())!=code_digest:
                        errs.append(ValidationIssue('DERIVED_METHOD_CODE_CUSTODY_MISMATCH','Code content is not in verified custody'))
                else:
                    errs.append(ValidationIssue('DERIVED_METHOD_CODE_REQUIRED','Custodied method code record has no code body'))
            except (ValueError,OSError) as exc:
                errs.append(ValidationIssue('DERIVED_METHOD_CODE_REQUIRED',str(exc)))
        inputs=lineage.get('inputs')
        if not isinstance(inputs,list) or not inputs:
            errs.append(ValidationIssue('DERIVED_INPUT_REQUIRED','At least one fixed input dataset/product/snapshot/content digest is required'))
        else:
            ancestry=None
            checked=set()
            for pinned in inputs:
                if not isinstance(pinned,dict) or not all(isinstance(pinned.get(k),str) and pinned.get(k)
                        for k in ('dataset_id','product_id','snapshot_id','content_digest')):
                    errs.append(ValidationIssue('DERIVED_INPUT_INVALID','Each input needs dataset_id, product_id, snapshot_id and content_digest'))
                    continue
                identity=(pinned['dataset_id'],pinned['product_id'],pinned['snapshot_id'])
                if identity in checked:
                    errs.append(ValidationIssue('DERIVED_INPUT_DUPLICATE','Duplicate derived input'))
                    continue
                checked.add(identity)
                if pinned['dataset_id']!=dataset_id:
                    # Never resolve a foreign dataset's product against this store.
                    errs.append(ValidationIssue('DERIVED_INPUT_DATASET_UNSUPPORTED',pinned['dataset_id']))
                    continue
                try:
                    snapshot=self._valid_snapshot_exact(pinned['snapshot_id'],verify_payloads=True)
                except ValueError:
                    errs.append(ValidationIssue('DERIVED_INPUT_SNAPSHOT_UNAVAILABLE',pinned['snapshot_id']))
                    continue
                if ancestry is None:
                    ancestry=self._active_ancestry()
                if pinned['snapshot_id'] not in ancestry:
                    errs.append(ValidationIssue('DERIVED_INPUT_NOT_PUBLISHED',pinned['snapshot_id']))
                    continue
                parts=self._snapshot_product_parts(snapshot,pinned['product_id'])
                if not parts:
                    errs.append(ValidationIssue('DERIVED_INPUT_PRODUCT_UNAVAILABLE',pinned['product_id']))
                    continue
                actual=product_content_digest(pinned['product_id'],parts)
                if actual!=pinned['content_digest']:
                    errs.append(ValidationIssue('DERIVED_INPUT_DIGEST_MISMATCH',pinned['product_id']))
        if isinstance(inputs,list):
            expected_input_sources=sorted({sid for pinned in inputs if isinstance(pinned,dict)
                                           for sid in pinned.get('source_ids',[])})
            if lineage.get('input_source_ids')!=expected_input_sources:
                errs.append(ValidationIssue('DERIVED_INPUT_SOURCE_BINDING_MISMATCH','Input source obligations do not match the pinned inputs'))
        output_digest=derived_output_digest(output)
        if lineage.get('output_digest')!=output_digest:
            errs.append(ValidationIssue('DERIVED_OUTPUT_DIGEST_MISMATCH','Lineage output digest does not match the submitted output'))
        evidence=lineage.get('processing_evidence')
        if not isinstance(evidence,list) or not evidence:
            errs.append(ValidationIssue('DERIVED_PROCESSING_EVIDENCE_REQUIRED','External processing evidence is required'))
        else:
            expected={
                'output_key':output.get('output_key'),
                'input_digests':sorted(item.get('content_digest') for item in inputs or [] if isinstance(item,dict)),
                'method_digest':method.get('digest'),
                'method_code_digest':method.get('code_digest'),
                'parameter_digest':method.get('parameter_digest'),
                'output_digest':output_digest,
            }
            valid_record=False; saw_json=False; custody_ok=True
            for ref in evidence:
                digest=(ref.get('content_sha256') or '').removeprefix('sha256:') if isinstance(ref,dict) else ''
                path=root/'evidence/sha256'/digest
                if len(digest)!=64 or not path.is_file() or sha(path.read_bytes())!=digest:
                    custody_ok=False
                    continue
                try:
                    record=json.loads(path.read_bytes())
                except (ValueError,UnicodeDecodeError):
                    record=None
                if isinstance(record,dict) and isinstance(record.get('processing_record'),dict):
                    record=record['processing_record']
                if isinstance(record,dict):
                    saw_json=True
                    if not external_processing_record_errors(record,**expected):
                        valid_record=True
            if not custody_ok:
                errs.append(ValidationIssue('DERIVED_PROCESSING_EVIDENCE_UNVERIFIED','Processing evidence bytes are not in verified custody'))
            if not valid_record:
                code='DERIVED_PROCESSING_BINDING_MISMATCH' if saw_json else 'DERIVED_PROCESSING_RECORD_REQUIRED'
                errs.append(ValidationIssue(code,'No processing record binds the input digests, method/code/parameters and output digest'))
        errs.extend(self._derived_warmup_errors(output,lineage))
        return errs


    @guarded_method

    def submit(self,doc:dict, *, fail_before_commit:bool=False, writer_epoch:int|None=None)->dict:
        if getattr(self, "read_only", False):
            return {'status':'rejected','errors':[ValidationIssue('READ_ONLY_STORE','Formal volume is read-only')]}
        schema_issues=sorted(self.validator.iter_errors(doc),key=lambda x:list(map(str,x.path)))
        if schema_issues:
            return {'status':'rejected_schema','errors':[ValidationIssue('SCHEMA_INVALID',x.message[:250],field_path='.'.join(map(str,x.path))) for x in schema_issues[:20]]}
        # data_only 内部契约用 wfd_publish_context 承载发布元数据；引擎内部沿用既有键，只在校验通过后适配。
        if isinstance(doc, dict) and 'wfd_publish_context' in doc and 'source_bundle' not in doc:
            doc = dict(doc); doc['source_bundle'] = doc['wfd_publish_context']
        if doc['protocol_version']!=self.expected_protocol:
            return {'status':'rejected_schema','errors':[ValidationIssue('UNSUPPORTED_PROTOCOL','Unsupported protocol version')]}
        # ENG-03：发布前必须解析出唯一权威 HEAD；HEAD 不可用则拒绝，不得回退到图推导
        head_state = self._resolved_head()[0]
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
        if (not self.sandbox and doc['source_bundle'].get('raw_source_bytes_custodied') is not True
                and doc['source_bundle'].get('_wfd_data_only') is not True):
            return {'status':'rejected','errors':[ValidationIssue('EVIDENCE_CUSTODY_UNVERIFIED','Cannot formally publish an uncustodied original')]}
        h=self.head();parent=h['snapshot_id'] if h else None
        if doc['expected_parent_snapshot_id']!=parent:
            return {'status':'rejected','errors':[ValidationIssue('PARENT_CHANGED','Expected parent Snapshot differs from current head')], 'actual_parent_snapshot_id':parent}
        accepted=[];rejected=[]
        from .indexed_bulk import index_roots, indexed_products as load_bulk_products
        indexed_roots=index_roots(h)
        indexed_products=load_bulk_products(self.root,h)
        base_metadata=copy.deepcopy(h.get('metadata_versions',[])) if h else []
        metadata_versions=[]
        derived_lineages=(doc.get('source_bundle',{}) or {}).get('_wfd_derived_lineage') or {}
        for out in doc['outputs']:
            errors=business_validate(out,sandbox=self.sandbox,
                data_only_write=self.expected_protocol=='wfd.data-only-write/0.1-candidate',
                derived_lineage=derived_lineages.get(out['output_key']) if isinstance(derived_lineages,dict) else None,
                derived_verifier=lambda output,lineage: self._derived_lineage_errors(output,lineage,doc))
            pid=self._resolved_product_id(doc,out)
            if pid in indexed_products:
                errors.append(ValidationIssue('BULK_PARTITION_WRITE_REQUIRED','Use the whole-date batch protocol for this product'))
            if out['payload']['kind']=='metadata_revision':
                if errors: rejected.append({'output_key':out['output_key'],'errors':errors})
                else: accepted.append(out)
                continue
            new_keys={row.get('business_key',row.get('event_id')) for row in out['payload']['rows']}
            prior_parts=[old for old in (h['files'] if h else []) if old['product_id']==pid]
            versions=(doc['source_bundle'].get('_wfd_row_versions') or {}).get(out['output_key'])
            bounded_keys=(doc['source_bundle'].get('_wfd_data_only') is True
                          and out['payload']['kind'] in {'scalar_rows','tabular_rows'}
                          and isinstance(versions,dict) and set(versions)==new_keys
                          and all(isinstance(v,dict) and v.get('input_mode') in {'partial_observation','explicit_increment'} for v in versions.values())
                          and all(isinstance(key,str) for key in new_keys)
                          and all(old.get('payload_kind') in {'scalar_rows','tabular_rows'}
                                  and old.get('source_bundle',{}).get('_wfd_data_only') is True for old in prior_parts))
            if bounded_keys:
                # HEAD has verified every declared file. Read real protocol
                # keys from those Parquet files, never trust the version map
                # as proof of what physical rows actually contain.
                existing_keys=matching_business_keys([self.root/old['file_relpath'] for old in prior_parts],new_keys)
            else:
                existing_keys=set()
                for old in prior_parts:
                    for old_row in rows_from_parquet((self.root/old['file_relpath']).read_bytes()):
                        existing_keys.add(old_row.get('business_key',old_row.get('event_id')))
            if new_keys & existing_keys:
                errors.append(ValidationIssue('DUPLICATE_EXISTING_BUSINESS_KEY','Existing product contains keys; corrections require versioned revision handling'))
            if out['input_mode'] in {'source_correction','processing_repair','withdrawal','coverage_revision'}:
                errors.append(ValidationIssue('INPUT_MODE_NOT_IMPLEMENTED','Prototype does not implement immutable revision/withdrawal semantics'))
            if errors:rejected.append({'output_key':out['output_key'],'errors':errors});continue
            accepted.append(out)
        groups=(doc.get('source_bundle',{}).get('product_service',{}).get('consistency_groups',{}))
        if groups:
            failed={entry['output_key'] for entry in rejected}
            changed=True
            while changed:
                changed=False
                for members in groups.values():
                    if any(member in failed for member in members):
                        for entry in list(accepted):
                            if entry['output_key'] in members:
                                accepted.remove(entry)
                                rejected.append({'output_key':entry['output_key'],
                                    'errors':[ValidationIssue('CONSISTENCY_GROUP_FAILED',
                                        'Consistency group has a failed member; no member is published')]})
                                failed.add(entry['output_key'])
                                changed=True
        if not accepted:
            return {'status':'rejected','errors':[e for entry in rejected for e in entry['errors']],'output_results':rejected}
        base_files=[] if h is None else list(h['files'])
        # Important: retain earlier product entries and immutable files, no in-place updates.
        new_files=[]
        for out in accepted:
            definition=out.get('new_definition_declaration') or {'fixed_definition_ref':out.get('definition_ref')}
            pid=self._resolved_product_id(doc,out)
            if out['payload']['kind']=='metadata_revision':
                meta=copy.deepcopy((doc.get('source_bundle',{}).get('_wfd_metadata_versions') or {}).get(out['output_key']) or {})
                prior_sequences=[x.get('metadata_sequence',0) for x in base_metadata+metadata_versions
                                 if x.get('product_id')==pid]
                meta.update({'product_id':pid,'output_key':out['output_key'],
                             'metadata_sequence':max(prior_sequences,default=0)+1})
                meta.setdefault('definition_ref', out.get('definition_ref'))
                metadata_versions.append(meta)
                continue
            data=parquet_from_rows(pid,out['output_key'],out['subject'],out['payload']['kind'],out['payload']['rows'])
            parse_footer(data) # validate the footer before durable publish
            file_digest=sha(data)
            rel=f"{out['logical_domain']}/product={pid}/part-{file_digest[:24]}.parquet"
            self._write_immutable(rel,data)
            new_files.append({'product_id':pid,'output_key':out['output_key'],'file_relpath':rel,'file_sha256':file_digest,
                'row_count':len(out['payload']['rows']),'definition':definition,'subject':out['subject'],
                'source_bundle':doc['source_bundle'],'evidence_refs':out.get('evidence_refs') or [],
                'input_mode':out['input_mode'],'payload_kind':out['payload']['kind']})
        files=base_files+new_files
        if row_version_objects.writing_enabled(self.root,self.runtime_root):
            files=row_version_objects.externalize_files(self.root,files,self._write_immutable)
        dup=self._duplicate_entries(files)
        if dup:
            return {'status':'rejected','errors':[ValidationIssue('DUPLICATE_ARTIFACT',f'duplicate manifest entries: {dup[:3]}')],'output_results':dup}
        manifest={'parent_snapshot_id':parent,'files':files}
        manifest.update(indexed_roots)
        mraw=canonical(manifest);mhash=sha(mraw)
        mrel=f'catalog/manifests/manifest_{mhash[:24]}.json'
        self._write_immutable(mrel,mraw)
        sid='s_'+sha(canonical([parent,key,fingerprint,mhash]))[:24]
        receipt={'status':'published_sandbox' if not rejected else 'partially_published_sandbox',
                 'snapshot_id':sid,'parent_snapshot_id':parent,'request_key':key,'request_fingerprint':fingerprint,
                 'outputs_success':[x['output_key'] for x in accepted], 'outputs_rejected':rejected,
                 'storage_format':DUCKDB_STORAGE_FORMAT,'duckdb_roundtrip_verified':True,'independent_other_engine_verified':False,'production_publishable':False}
        snap={'snapshot_id':sid,'parent_snapshot_id':parent,'manifest_relpath':mrel,'manifest_sha256':mhash,
              'files':files,'metadata_versions':base_metadata+metadata_versions,
              'request_key':key,'request_fingerprint':fingerprint,'receipt':receipt}
        snap.update(indexed_roots)
        sraw=canonical(snap);srel=f'catalog/snapshots/{sid}.json'
        self._write_immutable(srel,sraw)
        if fail_before_commit:
            return {'status':'injected_failure_before_commit','orphan_snapshot_file':srel}
        lookup = {'parent_snapshot_id':parent,'request_key':key,
                  'request_fingerprint':fingerprint,'manifest_sha256':mhash}
        craw=canonical({'snapshot_id':sid,'snapshot_file':row_version_objects.marker_snapshot_file(files,sid),'snapshot_sha256':sha(sraw),
                        'request_lookup':lookup,'request_lookup_sha256':sha(canonical(lookup))})
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
        if row_version_objects.writing_enabled(self.root,self.runtime_root):
            files=row_version_objects.externalize_files(self.root,files,self._write_immutable)
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
        craw=canonical({'snapshot_id':sid,'snapshot_file':row_version_objects.marker_snapshot_file(files,sid),'snapshot_sha256':sha(sraw)})
        self._write_immutable(f'catalog/commits/{sid}.json',craw)
        act=self.state.activate(sid,self.root/srel,expected_prev=head['snapshot_id'],
                                writer_host=self.writer_host,
                                writer_epoch=writer_epoch if writer_epoch is not None else self.writer_epoch)
        if not act.get('ok'):
            return {**receipt,'status':'published_commit_pending_head','head_state':act}
        return receipt

    def _valid_snapshot_exact(self,snapshot_id,*,verify_payloads=True,product_ids=None,_expected_sha=None):
        """Validate one fixed commit chain without enumerating unrelated snapshots.

        The commit marker, snapshot digest, manifest digest and manifest file
        list are checked exactly as in ``_valid_snapshots``.  Payload checks are
        scoped to this snapshot (and optionally a product subset) so a fixed
        product read does not re-hash unrelated newer snapshots or products.
        """
        from . import indexed_bulk
        try:
            marker_path=self.root/'catalog/commits'/f'{snapshot_id}.json'
            marker_raw=marker_path.read_bytes()
            marker=json.loads(marker_raw)
            if str(marker.get('snapshot_file','')).startswith(indexed_bulk.SNAPSHOT_PREFIXES):
                if marker_path.is_symlink() or _expected_sha is not None:
                    raise ValueError('BULK_COMMIT_INVALID')
                snapshot=indexed_bulk.read_snapshot(self.root,snapshot_id,commit_raw=marker_raw)
                anchor=snapshot['legacy_anchor']
                ordinary={'files': [], 'metadata_versions': []}
                if anchor is not None:
                    anchor_id=anchor['snapshot_id']
                    indexed_bulk.snapshot_relative(anchor_id)
                    ordinary=self._valid_snapshot_exact(anchor_id,verify_payloads=verify_payloads,
                        product_ids=product_ids,_expected_sha=anchor['sha256'])
                return {**snapshot, 'files': ordinary['files'], 'metadata_versions': ordinary.get('metadata_versions', []),
                        **indexed_bulk.index_roots(snapshot), 'manifest_sha256': sha(canonical(snapshot))}
            if marker.get('snapshot_id')!=snapshot_id:raise ValueError('SNAPSHOT_ID_MISMATCH')
            sb=(self.root/row_version_objects.snapshot_relative(marker,snapshot_id)).read_bytes()
            checksum=sha(sb)
            if checksum!=marker['snapshot_sha256'] or (_expected_sha is not None and 'sha256:'+checksum!=_expected_sha):
                raise ValueError('SNAPSHOT_DIGEST_MISMATCH')
            d=json.loads(sb)
            if d['snapshot_id']!=snapshot_id:raise ValueError('SNAPSHOT_ID_MISMATCH')
            mb=(self.root/d['manifest_relpath']).read_bytes()
            if sha(mb)!=d['manifest_sha256']:raise ValueError('MANIFEST_DIGEST_MISMATCH')
            manifest=json.loads(mb)
            if manifest['files']!=d['files']:raise ValueError('MANIFEST_FILE_LIST_MISMATCH')
            indexed_bulk.validate_ordinary_roots(self.root,d,manifest)
            row_version_objects.project_snapshot(self.root,d)
            if verify_payloads:
                for ent in d['files']:
                    if product_ids is not None and ent['product_id'] not in product_ids:continue
                    raw=(self.root/ent['file_relpath']).read_bytes()
                    if sha(raw)!=ent['file_sha256']:raise ValueError('CHECKSUM_MISMATCH')
            return d
        except (OSError,KeyError,TypeError,ValueError,AttributeError,json.JSONDecodeError) as exc:
            raise ValueError('SNAPSHOT_UNAVAILABLE_OR_INVALID') from exc

    def read_snapshot(self,snapshot_id=None):
        """Fixed snapshot read: unrelated newer snapshots are never scanned."""
        if snapshot_id is None:return self.head()
        return self._valid_snapshot_exact(snapshot_id,verify_payloads=True)

    def read_product(self,product_id=None, *,snapshot_id=None,domain=None):
        # Metadata is validated here; each selected payload is verified while
        # it is actually read below.  Other products in the snapshot are not
        # touched by this product read.
        snap=self.head() if snapshot_id is None else self._valid_snapshot_exact(snapshot_id,verify_payloads=False)
        from .indexed_bulk import indexed_products
        indexed=indexed_products(self.root,snap)
        if indexed and (not product_id or product_id in indexed):
            raise ValueError('BULK_PARTITION_LOCATOR_REQUIRED')
        result=[]
        for entry in snap['files']:
            if product_id and entry['product_id']!=product_id:continue
            if domain and not entry['file_relpath'].startswith(domain+'/'):continue
            raw=(self.root/entry['file_relpath']).read_bytes()
            if sha(raw)!=entry['file_sha256']:raise ValueError('CHECKSUM_MISMATCH')
            rows=rows_from_parquet(raw)
            result.append({'product_id':entry['product_id'],'metadata':{'definition':entry['definition'],'subject':entry['subject'],'payload_kind':entry['payload_kind']},'rows':rows,'evidence':entry.get('evidence_refs') or [],'source':entry['source_bundle']})
        return result

    def rebuild_sqlite_index(self):
        """Disposable index, never used as authoritative snapshot source."""
        snapshots=self._valid_snapshots()
        p=self.runtime_root/'local_index.sqlite'
        if p.exists():p.unlink()
        db=sqlite3.connect(p)
        db.executescript('CREATE TABLE entries (snapshot_id TEXT,product_id TEXT,object_kind TEXT,object_id TEXT,relative_path TEXT, row_count INTEGER);CREATE INDEX pidx ON entries(product_id);')
        for s in snapshots:
            for f in s['files']:
                db.execute('INSERT INTO entries VALUES (?,?,?,?,?,?)',(s['snapshot_id'],f['product_id'],f['subject']['kind'],f['subject']['id'],f['file_relpath'],f['row_count']))
        db.commit();db.close()
        return str(p)

    def export_test_bundle(self,product_id:str,destination:Path, *,snapshot_id=None):
        """Limited one-product, read-only *sandbox* export (not formal WFD full/delta bundle)."""
        snap=self.read_snapshot(snapshot_id)
        row_version_objects.reject_unsupported(snap,'export_test_bundle')
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
                        'evidence_refs':ent.get('evidence_refs') or []})
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
