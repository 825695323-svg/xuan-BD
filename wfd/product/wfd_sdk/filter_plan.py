"""Bounded R07 plans over the authoritative ProductQuery reader.

All business data and qualification stay in WFD's existing public reader.
The only query state is a private cursor-signing key in the trusted native
runtime, outside the store. No products, definitions or data are produced.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import hmac
import json
import os
import stat
import tempfile
from functools import cmp_to_key, lru_cache
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from .duckdb_sdk import canonical, sha
from .filter_objects import FilterRejected, _compare, _decimal, _reject
from .product_query import ProductQueryError, _declaration_fields

PROTOCOL = "wfd.filter-objects/1.4-product1"
SCHEMA = "wfd-filter-plan.schema.json"
RESULT_SCHEMA = "wfd-filter-result.schema.json"
MAX_DEPTH = 8
MAX_PREDICATES = 64


@lru_cache(maxsize=4)
def _validator(root):
    schema_dir = Path(root) / 'schemas'
    schema = json.loads((schema_dir / SCHEMA).read_text('utf-8'))
    common = json.loads((schema_dir / 'wfd-common.schema.json').read_text('utf-8'))
    registry = Registry().with_resource(common['$id'], Resource.from_contents(common))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, registry=registry)


def capabilities(protocol_root=None):
    root = Path(protocol_root) if protocol_root else Path(__file__).resolve().parents[1] / 'protocol'
    path = root / 'schemas' / SCHEMA
    schema = json.loads(path.read_text('utf-8'))
    result_path = root / 'schemas' / RESULT_SCHEMA
    return {'protocol_version': PROTOCOL, 'schema_id': schema['$id'],
            'schema_sha256': 'sha256:' + sha(path.read_bytes()),
            'schema_canonical_sha256': 'sha256:' + sha(canonical(schema)),
            'result_schema_id': json.loads(result_path.read_text('utf-8'))['$id'],
            'result_schema_sha256': 'sha256:' + sha(result_path.read_bytes()),
            'history_modes': ['snapshot_contents', 'market_known_at', 'system_held_at'],
            'qualification': 'existing product contracts and actual public/instance evidence; never inferred',
            'universe': 'explicit_subjects', 'max_subjects': 100, 'max_metrics': 16,
            'predicate': ['compare', 'between', 'in', 'compare_metrics', 'and', 'or', 'not'],
            'predicate_max_depth': MAX_DEPTH, 'predicate_max_nodes': MAX_PREDICATES,
            'types': ['decimal'], 'compare_metrics': 'same product, compatible fields and identical business time',
            'ordering': 'explicit metric/subject order with full identity as unique tie-breaker',
            'pagination': 'HMAC signed cursor; fixed query, scope, snapshot, contract refs and final sort tuple',
            'cursor_state': 'private signing key in trusted native runtime; business store is read-only',
            'limits': {'page_size': 500, 'max_scan_bytes': 268435456, 'max_nodes': 200000},
            'budget_accounting': 'sum of conservative ProductQuery allowances for every physical page read',
            'limitations': ['no classification expansion or implicit identity relationships',
                            'no field-level permission model; current product/source permission rechecked per page',
                            'one qualified row per subject/metric/time selector; multiple rows are ambiguous',
                            'no cross-dataset snapshot composition or financial calculations',
                            'not a whole WFD production release']}


def validate_result(result, protocol_root):
    schema = json.loads((Path(protocol_root) / 'schemas' / RESULT_SCHEMA).read_text('utf-8'))
    error = next(Draft202012Validator(schema).iter_errors(result), None)
    if error is not None:
        raise ProductQueryError('FILTER_RESULT_SCHEMA_INVALID', error.message[:500], {'path': error.json_path})
    if result['object_count'] != len(result['objects']):
        raise ProductQueryError('FILTER_RESULT_SCHEMA_INVALID', 'Object count does not match the result page')


def _subject_key(subject):
    return (subject['kind'], subject['namespace'], subject['id'])


def _scope(service, config):
    return 'sha256:' + sha(canonical({
        'connection_id': config.get('connection_id'), 'caller': config.get('caller'),
        'sources': config.get('sources'), 'units': config.get('units'),
        'caller_id': service.caller_id, 'roles': sorted(service.caller_roles),
        'trusted_actor_namespaces': sorted(service.trusted_actor_namespaces),
        'allowed_sources': getattr(service, 'allowed_sources', {}),
    }))


def _cursor_key(config, create=False):
    runtime = Path(config['runtime'])
    store = Path(config['store'])
    if runtime != runtime.resolve() or runtime.is_relative_to(store.resolve()):
        _reject('CURSOR_RUNTIME_UNSAFE', '游标签名目录须是实例外的受信运行目录。')
    directory = runtime / 'query-cursors'
    if directory.is_symlink():
        _reject('CURSOR_RUNTIME_UNSAFE', '游标签名目录不能为符号链接。')
    if create:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / 'filter-hmac.key'
    if create and not path.exists():
        fd, temp = tempfile.mkstemp(prefix='.filter-key-', dir=directory)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(os.urandom(32)); stream.flush(); os.fsync(stream.fileno())
            try:
                os.link(temp, path)
            except FileExistsError:
                pass
        finally:
            os.unlink(temp)
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except (OSError, ValueError):
        _reject('CURSOR_INVALID', '原游标签名状态不可用；重新从首个固定页查询。')
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        key = stream.read(33)
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or len(key) != 32:
        _reject('CURSOR_RUNTIME_UNSAFE', '游标签名状态权限或长度不符。')
    return key


def _cursor(config, payload):
    body = canonical(payload)
    signature = hmac.new(_cursor_key(config, create=True), body, hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(canonical({'body': payload, 'signature': signature})).decode('ascii').rstrip('=')


def _decode_cursor(config, token, query_hash, scope, snapshot):
    try:
        raw = base64.b64decode(token + '=' * (-len(token) % 4), altchars=b'-_', validate=True)
        value = json.loads(raw)
        body = value['body']
        if set(value) != {'body', 'signature'} or set(body) != {'v', 'q', 'scope', 'snapshot', 'last'}:
            raise ValueError('fields')
        expected = hmac.new(_cursor_key(config), canonical(body), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(value['signature'], expected):
            raise ValueError('signature')
    except (ValueError, TypeError, KeyError, UnicodeError) as exc:
        _reject('CURSOR_INVALID', '游标格式或签名无效。', {'reason': type(exc).__name__})
    if body['v'] != PROTOCOL or body['q'] != query_hash or body['scope'] != scope or body['snapshot'] != snapshot:
        _reject('CURSOR_QUERY_MISMATCH', '查询、快照、固定合同或当前权限已变化，不能拼接旧页。')
    return body['last']


def _walk(predicate, metrics, definitions, depth=1, count=None):
    count = count if count is not None else [0]
    count[0] += 1
    if depth > MAX_DEPTH or count[0] > MAX_PREDICATES:
        _reject('PREDICATE_BUDGET_EXCEEDED', '复合条件超过深度8或节点64预算。')
    kind, node = next(iter(predicate.items()))
    if kind in {'and', 'or'}:
        for child in node:
            _walk(child, metrics, definitions, depth + 1, count)
        return
    if kind == 'not':
        _walk(node, metrics, definitions, depth + 1, count)
        return
    names = [node['left'], node['right']] if kind == 'compare_metrics' else [node['metric']]
    for name in names:
        if name not in metrics:
            _reject('METRIC_NOT_BOUND', '条件引用未绑定指标。', {'metric': name})
    if kind == 'compare_metrics':
        left, right = definitions[names[0]], definitions[names[1]]
        if any(left[k] != right[k] for k in ('data_type', 'unit_code', 'measurement_nature', 'time_role')):
            _reject('METRICS_INCOMPATIBLE', '指标类型、单位、性质或时间角色不相容。')
        left_bind = { _subject_key(b['subject']): b['product_id'] for b in metrics[names[0]]['bindings'] }
        right_bind = { _subject_key(b['subject']): b['product_id'] for b in metrics[names[1]]['bindings'] }
        if left_bind != right_bind:
            _reject('METRIC_RELATION_UNSUPPORTED', '首版直接指标比较仅支持同一产品的相容字段。')
        return
    name = names[0]
    constants = [node['value']] if kind == 'compare' else node['values'] if kind == 'in' else [node['low'], node['high']]
    for value in constants:
        if value['unit_code'] != definitions[name]['unit_code']:
            _reject('UNIT_INCOMPATIBLE', '常量单位必须与固定字段单位一致，不作隐式转换。', {'metric': name})
        _decimal(value['value'], 'predicate.constant')
    if kind == 'between' and _decimal(node['low']['value'], 'low') > _decimal(node['high']['value'], 'high'):
        _reject('PREDICATE_INVALID', 'between下界大于上界。')


def _evaluate(predicate, values):
    kind, node = next(iter(predicate.items()))
    if kind in {'and', 'or'}:
        children = [_evaluate(child, values) for child in node]
        if kind == 'and':
            return False if False in children else None if None in children else True
        return True if True in children else None if None in children else False
    if kind == 'not':
        child = _evaluate(node, values)
        return None if child is None else not child
    if kind == 'compare_metrics':
        left, right = values.get(node['left']), values.get(node['right'])
        return None if left is None or right is None else _compare(left, node['op'], right)
    value = values.get(node['metric'])
    if value is None:
        return None
    if kind == 'compare':
        return _compare(value, node['op'], _decimal(node['value']['value'], 'constant'))
    if kind == 'in':
        return value in [_decimal(item['value'], 'constant') for item in node['values']]
    return (_compare(value, '>=' if node['include_low'] else '>', _decimal(node['low']['value'], 'low'))
            and _compare(value, '<=' if node['include_high'] else '<', _decimal(node['high']['value'], 'high')))


def _tuple(obj, order):
    result = []
    for sort in order:
        if sort['kind'] == 'metric':
            cell = obj['values'].get(sort['metric'])
            result.append(cell['value'] if cell and cell.get('value_state') in {'valid_value', 'reported_zero'} else None)
        else:
            result.append(list(_subject_key(obj['subject'])))
    return result + list(_subject_key(obj['subject']))


def _sort_comparator(order):
    def compare(left, right):
        for i, sort in enumerate(order):
            a, b = left[i], right[i]
            if a is None or b is None:
                result = 0 if a is b else (-1 if a is None else 1) * (1 if sort.get('nulls', 'last') == 'first' else -1)
                if result:
                    return result
                continue
            if sort['kind'] == 'metric':
                a, b = _decimal(a, 'sort'), _decimal(b, 'sort')
            result = (a > b) - (a < b)
            if result:
                return result if sort['direction'] == 'asc' else -result
        return (left[len(order):] > right[len(order):]) - (left[len(order):] < right[len(order):])
    return compare


def run(service, config, request, query_factory, service_identity):
    service.require_permission('read')
    root = config.get('protocol_root') or str(Path(__file__).resolve().parents[1] / 'protocol')
    # Bound expression depth before the recursive JSON Schema validator.
    def bounded(value, depth=0):
        if depth > 32:
            _reject('PREDICATE_BUDGET_EXCEEDED', '请求结构超过深度预算。')
        if isinstance(value, dict):
            for child in value.values():
                bounded(child, depth + 1)
        elif isinstance(value, list):
            for child in value:
                bounded(child, depth + 1)
    bounded(request)
    def bound_predicate(node, depth=1, count=None):
        count = count if count is not None else [0]
        count[0] += 1
        if depth > MAX_DEPTH or count[0] > MAX_PREDICATES:
            _reject('PREDICATE_BUDGET_EXCEEDED', '复合条件超过深度8或节点64预算。')
        if isinstance(node, dict):
            for key, child in node.items():
                if key in {'and', 'or'} and isinstance(child, list):
                    for nested in child:
                        bound_predicate(nested, depth + 1, count)
                elif key == 'not':
                    bound_predicate(child, depth + 1, count)
    bound_predicate(request.get('predicate'))
    errors = list(_validator(root).iter_errors(request))
    if errors:
        _reject('FILTER_SCHEMA_INVALID', errors[0].message[:500], {'path': errors[0].json_path})
    if request['history_mode'] == 'snapshot_contents' and any(request.get(k) is not None for k in ('knowledge_cutoff', 'held_scope', 'usable_stage')):
        _reject('HISTORY_CONTEXT_INVALID', 'snapshot_contents不使用历史截止或持有资格。')
    if request['history_mode'] != 'snapshot_contents' and not request.get('knowledge_cutoff'):
        _reject('KNOWLEDGE_CUTOFF_REQUIRED', '历史查询必须固定知识截止。')
    if request['history_mode'] == 'system_held_at' and (not request.get('held_scope') or not request.get('usable_stage')):
        _reject('INSTANCE_HOLDING_UNKNOWN', '系统持有历史须显式固定held_scope及usable_stage。')
    subjects = request['universe']['subjects']
    subject_map = {_subject_key(subject): subject for subject in subjects}
    if len(subject_map) != len(subjects):
        _reject('UNIVERSE_INVALID', '显式对象集合不能重复身份。')
    metrics = {metric['metric']: metric for metric in request['metrics']}
    if len(metrics) != len(request['metrics']):
        _reject('METRIC_BINDING_INVALID', '本次指标别名不能重复。')
    # Reuse ProductQuery's authenticated metadata-only preflight. Ordinary
    # service discovery would verify all payloads before the scan budget.
    try:
        discovered = query_factory().fixed_filter_products(
            snapshot_id=request['snapshot_id'],
            product_ids=[binding['product_id'] for metric in metrics.values() for binding in metric['bindings']],
            max_scan_bytes=request['max_scan_bytes'])
    except ProductQueryError as exc:
        if exc.code != 'SCAN_BUDGET_EXCEEDED':
            raise
        return _result(request, service_identity, 'sha256:' + sha(canonical(request)), [], [], [],
                       [{'code': exc.code, 'message': exc.message, 'details': exc.details}],
                       'budget_exceeded', 0, 0, 0, 0, False, [])
    products = {}
    for product in discovered.get('products', []):
        products.setdefault(product['product_id'], []).append(product)
    groups, definitions, refs = {}, {}, []
    for name, metric in metrics.items():
        seen, signatures = set(), set()
        for binding in metric['bindings']:
            subject = _subject_key(binding['subject'])
            if subject not in subject_map or subject in seen:
                _reject('METRIC_BINDING_INVALID', '指标产品须唯一绑定本次集合内的完整对象身份。')
            seen.add(subject)
            candidates = [p for p in products.get(binding['product_id'], []) if p.get('subject') == binding['subject']]
            if not candidates:
                _reject('PRODUCT_NOT_IN_SNAPSHOT', '固定快照内没有绑定该对象的产品。', binding)
            fixed = {canonical([p.get('definition_ref'), p.get('contract_refs')]) for p in candidates}
            if len(fixed) != 1:
                _reject('DEFINITION_AMBIGUOUS', '产品在固定快照内含多个定义/合同，需先明确选择。')
            product = candidates[0]
            if product.get('dataset_id') != request['dataset_id']:
                _reject('DATASET_MISMATCH', '产品不属于本次固定数据集。')
            definition = _declaration_fields(product).get(metric['field'])
            if definition is None:
                _reject('FIELD_NOT_REGISTERED', '字段必须来自本产品固定读取合同。', {'metric': name, 'field': metric['field']})
            if definition.get('data_type') != 'decimal':
                _reject('FIELD_TYPE_UNSUPPORTED', '首版筛选仅支持有固定定义的decimal点值。')
            declaration = product.get('declaration') or {}
            signatures.add(canonical([definition, declaration.get('semantic_code'),
                                      declaration.get('definition_authority'), declaration.get('semantic_context')]))
            definitions[name] = definition
            refs.append({'metric': name, 'subject': binding['subject'], 'product_id': product['product_id'],
                         'field': metric['field'], 'field_definition': definition,
                         'definition_ref': product.get('definition_ref'),
                         'contract_refs': product.get('contract_refs'),
                         'contract_bundle_ref': product.get('contract_bundle_ref')})
            group = groups.setdefault((subject, binding['product_id']), {'subject': binding['subject'], 'fields': {}, 'product': product})
            group['fields'][name] = metric['field']
        if len(signatures) != 1:
            _reject('METRIC_DEFINITION_INCOMPATIBLE', '同一指标别名在对象间的固定定义或语义口径不同。', {'metric': name})
    _walk(request['predicate'], metrics, definitions)
    for order in request['order_by']:
        if order['kind'] == 'metric' and order['metric'] not in metrics:
            _reject('METRIC_NOT_BOUND', '排序引用未绑定指标。')
    scope = _scope(service, config)
    hashed = {k: v for k, v in request.items() if k != 'cursor'}
    query_hash = 'sha256:' + sha(canonical([hashed, refs, scope]))
    last = _decode_cursor(config, request['cursor'], query_hash, scope, request['snapshot_id']) if request.get('cursor') else None
    records = {subject: {} for subject in subject_map}
    cells = {subject: {} for subject in subject_map}
    reasons = {subject: [] for subject in subject_map}
    budget_bytes = discovered['metadata_bytes']
    budget_nodes = scanned = candidate_rows = 0
    gaps, ambiguous = [], False
    coverage = []
    for (subject, product_id), group in groups.items():
        cursor, rows, first = None, [], True
        while True:
            inner = {k: request.get(k) for k in ('dataset_id', 'snapshot_id', 'history_mode', 'knowledge_cutoff', 'held_scope', 'usable_stage', 'business_time_range')}
            inner.update(protocol_version='wfd.read/1.3-product1', operation='read_product',
                         product_id=product_id, subject=group['subject'],
                         fields=sorted(set(group['fields'].values())), page_size=500,
                         max_nodes=request['max_nodes'] - budget_nodes,
                         max_scan_bytes=request['max_scan_bytes'] - budget_bytes)
            if cursor:
                inner['cursor'] = cursor
            try:
                if inner['max_nodes'] <= 0 or inner['max_scan_bytes'] <= 0:
                    raise ProductQueryError('ROW_BUDGET_EXCEEDED' if inner['max_nodes'] <= 0 else 'SCAN_BUDGET_EXCEEDED', 'Aggregate plan budget exhausted')
                read = query_factory().execute(inner)
            except ProductQueryError as exc:
                if exc.code not in {'ROW_BUDGET_EXCEEDED', 'SCAN_BUDGET_EXCEEDED'}:
                    raise
                return _result(request, service_identity, query_hash, refs, [], [],
                               [{'code': exc.code, 'message': exc.message, 'details': exc.details}],
                               'budget_exceeded', candidate_rows, scanned, budget_nodes, budget_bytes, False, coverage)
            budget = read.get('budget') or {}
            budget_bytes += int(budget.get('required_scan_bytes') or 0)
            budget_nodes += int(budget.get('candidate_rows') or 0)
            scanned += len(read.get('rows') or [])
            rows.extend(read.get('rows') or [])
            page = read.get('page') or {}
            if first:
                candidate_rows += int(page.get('total_rows') or 0)
                first = False
                diagnostics = read.get('diagnostics') or []
                coverage.append({'subject': group['subject'], 'product_id': product_id,
                                 'diagnostics': diagnostics, 'product_coverage': group['product'].get('coverage'),
                                 'qualification': {'history_mode': read.get('history_mode'), 'cutoff': read.get('cutoff'),
                                                   'held_scope': read.get('held_scope'), 'usable_stage': read.get('usable_stage')}})
            if not page.get('has_more'):
                break
            cursor = page.get('next_cursor')
            if not cursor:
                _reject('READ_PAGE_INCOMPLETE', '底层扫描未完成且缺继续游标。')
        if len(rows) > 1:
            ambiguous = True
            reasons[subject].append({'code': 'RECORD_SELECTION_AMBIGUOUS', 'product_id': product_id, 'records': len(rows)})
            continue
        for name, field in group['fields'].items():
            if not rows:
                reasons[subject].append({'code': 'NO_QUALIFIED_RECORD_IN_RANGE', 'metric': name,
                                         'product_id': product_id,
                                         'qualification_diagnostics': read.get('diagnostics') or []})
                continue
            row = rows[0]
            cell = (row.get('values') or {}).get(field)
            cells[subject][name] = cell
            records[subject][name] = {k: row.get(k) for k in ('record_ref', 'revision', 'revision_state', 'eligibility', 'business_time', 'business_time_role', 'contract_ref')}
            records[subject][name].update(product_id=product_id, field=field, definition_ref=group['product'].get('definition_ref'))
            if not cell or cell.get('value_state') not in {'valid_value', 'reported_zero'} or cell.get('value') is None:
                reasons[subject].append({'code': 'VALUE_INDETERMINATE', 'metric': name, 'value_state': (cell or {}).get('value_state', 'missing_field')})
    objects, indeterminate = [], []
    for subject, identity in subject_map.items():
        for name in metrics.keys() - cells[subject].keys():
            if not any(r.get('metric') == name for r in reasons[subject]):
                reasons[subject].append({'code': 'PRODUCT_BINDING_MISSING', 'metric': name})
        values = {name: _decimal(cell['value'], 'stored.value') if cell and cell.get('value_state') in {'valid_value', 'reported_zero'} and cell.get('value') is not None else None
                  for name, cell in cells[subject].items()}
        # Point-to-point comparisons never join unequal business periods.
        times = {canonical(record.get('business_time')) for record in records[subject].values()}
        if len(times) > 1:
            _reject('BUSINESS_PERIOD_INCOMPATIBLE', '同一对象指标的实际期间不一致，不能隐式关联。')
        truth = _evaluate(request['predicate'], values)
        if truth is True:
            objects.append({'subject': identity, 'predicate_result': True,
                            'values': cells[subject], 'record_refs': records[subject],
                            'comparison_rule': 'exact_stored_decimal_no_tolerance',
                            'gaps': reasons[subject]})
        if truth is None or reasons[subject]:
            indeterminate.append({'subject': identity, 'predicate_result': truth, 'gaps': reasons[subject]})
    if ambiguous:
        return _result(request, service_identity, query_hash, refs, [], indeterminate,
                       [{'code': 'RECORD_SELECTION_AMBIGUOUS', 'message': '至少一个对象/指标在期间内有多条候选；未取首条或平均。'}],
                       'ambiguous', candidate_rows, scanned, budget_nodes, budget_bytes, True, coverage)
    comparator = _sort_comparator(request['order_by'])
    objects.sort(key=cmp_to_key(lambda a, b: comparator(_tuple(a, request['order_by']), _tuple(b, request['order_by']))))
    all_objects = objects
    if last is not None:
        positions = [i for i, obj in enumerate(objects) if _tuple(obj, request['order_by']) == last]
        if len(positions) != 1:
            _reject('CURSOR_QUERY_MISMATCH', '原末尾排序元组不在本次固定结果中。')
        objects = objects[positions[0] + 1:]
    has_more = len(objects) > request['page_size']
    page = objects[:request['page_size']]
    status = 'matched' if all_objects else 'coverage_insufficient' if indeterminate else 'empty'
    result = _result(request, service_identity, query_hash, refs, page, indeterminate, gaps,
                     status, candidate_rows, scanned, budget_nodes, budget_bytes, True, coverage)
    result['scan_receipt']['matched_objects'] = len(all_objects)
    result['scan_receipt']['matched_records'] = sum(len(obj['record_refs']) for obj in all_objects)
    result['page'].update(total_objects=len(all_objects), has_more=has_more, result_exhausted=not has_more,
                          next_cursor=_cursor(config, {'v': PROTOCOL, 'q': query_hash, 'scope': scope,
                                                       'snapshot': request['snapshot_id'], 'last': _tuple(page[-1], request['order_by'])}) if has_more else None)
    return result


def _result(request, service_identity, query_hash, refs, objects, indeterminate, gaps, status,
            candidate_rows, scanned, budget_nodes, budget_bytes, complete, coverage):
    return {'format_version': 'wfd.filter-objects-result/1', 'protocol_version': PROTOCOL,
            'operation': 'filter_objects', 'dataset_id': request['dataset_id'], 'snapshot_id': request['snapshot_id'],
            'history_mode': request['history_mode'], 'knowledge_cutoff': request.get('knowledge_cutoff'),
            'held_scope': request.get('held_scope'), 'usable_stage': request.get('usable_stage'),
            'business_time_range': request['business_time_range'], 'query_hash': query_hash,
            'status': status, 'objects': objects, 'object_count': len(objects), 'indeterminate': indeterminate,
            'predicate': request['predicate'], 'order_by': request['order_by'], 'bindings': refs,
            'coverage': {'products': coverage, 'data_complete': not indeterminate and not gaps,
                         'basis': 'explicit authorized universe; fixed contracts; no implied world coverage'},
            'scan_receipt': {'candidate_rows': candidate_rows, 'scanned_rows': scanned,
                             'matched_records': sum(len(obj['record_refs']) for obj in objects),
                             'matched_objects': len(objects), 'scan_complete': complete,
                             'budget_nodes': budget_nodes, 'budget_bytes': budget_bytes,
                             'row_budget': request['max_nodes'], 'byte_budget': request['max_scan_bytes']},
            'page': {'page_size': request['page_size'], 'has_more': False, 'next_cursor': None,
                     'total_objects': None, 'result_exhausted': False},
            'gaps': gaps, 'service_identity': service_identity}
