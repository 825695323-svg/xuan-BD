"""Explicit local-operator replacement approvals, isolated from ordinary publishing.

Only host configuration can grant an action and exact instance/product/scope.
The local caller's digest confirmation is not an unforgeable human signature.
"""
import copy
import json
import os
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

from .duckdb_sdk import canonical, sha
from .definition_replacement_candidates import evaluate_replacement_candidates, _second
from .product_holdings import resolve_target_instance
from .product_holdings import _now
from .writerlock import writer_lock

FORMAT = 'wfd.definition-replacement-approvals/1'
FILE = 'catalog/product_service/definition_replacement_approvals.json'
MARKER = FILE + '.initialized'
ACTIONS = {'approve_definition_replacement', 'disable_definition_replacement', 'resolve_definition_replacement'}
SCOPE = ('instance_id', 'product_id', 'business_scope')
MAX_BYTES = 4 * 1024 * 1024


def digest(value):
    return 'sha256:' + sha(canonical(value))


def access(value):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 100:
        raise ValueError('DEFINITION_REPLACEMENT_ACCESS_INVALID')
    for grant in value:
        if not isinstance(grant, dict) or set(grant) != {'operation', *SCOPE} or grant['operation'] not in ACTIONS or any(not isinstance(grant[k], str) or not grant[k] for k in SCOPE):
            raise ValueError('DEFINITION_REPLACEMENT_ACCESS_INVALID')
    return copy.deepcopy(value)


def authorize(service, operation, scope):
    service.require_permission('read')
    if operation != 'resolve_definition_replacement':
        service.require_permission('register')
        service.require_permission('publish')
    if not isinstance(scope, dict) or any(not isinstance(scope.get(k), str) or not scope[k] for k in SCOPE):
        raise ValueError('DEFINITION_REPLACEMENT_SCOPE_INVALID')
    wanted = {'operation': operation, **{k: scope.get(k) for k in SCOPE}}
    if wanted not in service._definition_replacement_access:
        raise PermissionError('DEFINITION_REPLACEMENT_ACTION_DENIED')
    instance = resolve_target_instance(service.root, create=False)
    if instance['source'] != 'target_instance':
        raise ValueError('DEFINITION_REPLACEMENT_LOCAL_ONLY')
    if instance['instance_id'] != scope['instance_id']:
        raise ValueError('DEFINITION_REPLACEMENT_INSTANCE_MISMATCH')


def load(root):
    path = Path(root) / FILE
    if not path.exists():
        if (Path(root) / MARKER).exists():
            raise ValueError('DEFINITION_REPLACEMENT_CATALOG_MISSING')
        return []
    if path.is_symlink() or path.stat().st_size > MAX_BYTES:
        raise ValueError('DEFINITION_REPLACEMENT_CATALOG_INVALID')
    doc = json.loads(path.read_text('utf-8'))
    marker = Path(root) / MARKER
    if marker.is_symlink() or not marker.is_file():
        raise ValueError('DEFINITION_REPLACEMENT_TAIL_MISMATCH')
    with marker.open('rb') as stream:
        tail = stream.read(73)
    if len(tail) != 72 or tail != (digest(doc) + '\n').encode('utf-8'):
        raise ValueError('DEFINITION_REPLACEMENT_TAIL_MISMATCH')
    if not isinstance(doc, dict) or doc.get('format') != FORMAT or not isinstance(doc.get('events'), list) or len(doc['events']) > 1000:
        raise ValueError('DEFINITION_REPLACEMENT_CATALOG_INVALID')
    previous = None
    for event in doc['events']:
        body = {k: v for k, v in event.items() if k != 'digest'}
        if event.get('previous') != previous or event.get('digest') != digest(body):
            raise ValueError('DEFINITION_REPLACEMENT_CATALOG_CONFLICT')
        if event.get('action') not in {'approve_definition_replacement', 'disable_definition_replacement'}:
            raise ValueError('DEFINITION_REPLACEMENT_CATALOG_INVALID')
        previous = event['digest']
    return doc['events']


def persist(root, events):
    path = Path(root) / FILE
    raw = canonical({'format': FORMAT, 'events': events})
    if len(raw) > MAX_BYTES or len(events) > 1000:
        raise ValueError('DEFINITION_REPLACEMENT_BUDGET')
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.definition-replacement-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        # Marker first: an interrupted initial write fails closed, never resets.
        marker = Path(root) / MARKER
        if not marker.exists():
            marker.write_text('pending\n', encoding='utf-8')
        os.replace(tmp, path)
        # A separately pinned tail rejects restoring only an older valid prefix.
        # Interrupted file/marker update fails closed; there is no auto repair.
        fd, tmp = tempfile.mkstemp(prefix='.definition-replacement-tail-', dir=path.parent)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(digest({'format': FORMAT, 'events': events}) + '\n')
            stream.flush(); os.fsync(stream.fileno())
        os.replace(tmp, marker)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def scoped(events, scope):
    return [e for e in events if all(e['scope'].get(k) == scope[k] for k in SCOPE)]


def bindings(service, statement):
    """Bounded complete fixed product page; never accept request-supplied evidence."""
    page = service.read_product_page(statement['product_id'], snapshot_id=statement['snapshot_id'],
                                     page_size=1000, include_definition_publication=True)
    if page['pagination']['has_more']:
        raise ValueError('DEFINITION_REPLACEMENT_BINDING_BUDGET')
    selected = [[row for row in page['rows'] if row['record_ref'] == statement[side]['record_ref']] for side in ('old', 'new')]
    if any(len(rows) != 1 for rows in selected) or selected[0][0].get('subject') != selected[1][0].get('subject'):
        raise ValueError('DEFINITION_REPLACEMENT_SUBJECT_OR_BINDING_MISMATCH')
    return [row['source_binding']['definition_publication'] for row in page['rows']]


def request_for(statement, *, at, cutoff):
    return {**{k: statement[k] for k in (*SCOPE, 'snapshot_id')},
            'old_definition_ref': statement['old']['definition_ref'],
            'business_at': at, 'public_cutoff': cutoff}


def mutate(service, operation, command):
    scope = command.get('scope', {})
    authorize(service, operation, scope)  # Before writer lock or catalog creation.
    if getattr(service.engine, 'read_only', False):
        raise ValueError('DEFINITION_REPLACEMENT_READ_ONLY')
    allowed = {'scope', 'approver', 'expected_catalog_digest', 'confirmation_digest',
               'statement' if operation == 'approve_definition_replacement' else 'approval_digest'}
    if set(command) != allowed or set(scope) != set(SCOPE) or command['approver'] != service.caller_id:
        raise ValueError('DEFINITION_REPLACEMENT_CONFIRMATION_REQUIRED')
    body = {k: v for k, v in command.items() if k != 'confirmation_digest'}
    if command['confirmation_digest'] != digest({'operation': operation, **body}):
        raise ValueError('DEFINITION_REPLACEMENT_CONFIRMATION_MISMATCH')
    with writer_lock(service.root):
        events = load(service.root)
        current = scoped(events, scope)
        if command['expected_catalog_digest'] != digest(current):
            raise ValueError('DEFINITION_REPLACEMENT_PREDECESSOR_CONFLICT')
        if operation == 'approve_definition_replacement':
            statement = command['statement']
            if set(statement) != {*SCOPE, 'snapshot_id', 'old', 'new', 'public_time', 'valid_from', 'valid_until'} or any(set(statement[side]) != {'record_ref', 'definition_ref', 'binding_digest'} for side in ('old', 'new')):
                raise ValueError('DEFINITION_REPLACEMENT_STATEMENT_INVALID')
            if any(statement.get(k) != scope[k] for k in SCOPE):
                raise ValueError('DEFINITION_REPLACEMENT_SCOPE_MISMATCH')
            edge = {'statement': statement, 'digest': digest(statement)}
            check = evaluate_replacement_candidates(request_for(statement, at=statement['valid_from'], cutoff='9999-12-31T23:59:59Z'), [edge], bindings(service, statement))
            if check['status'] != 'unique_candidate':
                raise ValueError('DEFINITION_REPLACEMENT_EVIDENCE_INVALID:' + check['reason'])
            # No implicit compound predecessor, reactivation or overwrite, even
            # when a prior edge was disabled. A later explicit policy is needed.
            endpoints = [statement[k]['definition_ref'] for k in ('old', 'new')]
            for prior in current:
                if prior['action'] == operation and any(ref == prior['statement'][k]['definition_ref'] for ref in endpoints for k in ('old', 'new')):
                    raise ValueError('DEFINITION_REPLACEMENT_COMPOUND_OR_DISABLED_CONFLICT')
            extra = {'statement': copy.deepcopy(statement)}
        else:
            target = command['approval_digest']
            approvals = [e for e in current if e['action'] == 'approve_definition_replacement' and e['digest'] == target]
            if len(approvals) != 1 or any(e.get('approval_digest') == target for e in current):
                raise ValueError('DEFINITION_REPLACEMENT_DISABLE_CONFLICT')
            extra = {'approval_digest': target}
        now = _now()
        if events and now < events[-1]['approved_at']:
            raise ValueError('DEFINITION_REPLACEMENT_CLOCK_REGRESSION')
        event = {'action': operation, 'scope': copy.deepcopy(scope), 'approver': service.caller_id,
                 'approved_at': now, 'previous': events[-1]['digest'] if events else None,
                 'confirmation_digest': command['confirmation_digest'],
                 'expected_catalog_digest': command['expected_catalog_digest'], **extra}
        event['digest'] = digest(event)
        authorize(service, operation, scope)
        persist(service.root, [*events, event])
        return {'state': 'approved' if operation == 'approve_definition_replacement' else 'disabled',
                'approval_digest': event['digest'], 'approved_at': event['approved_at'],
                'catalog_digest': digest([*current, event]), 'approver': service.caller_id}


def resolve(service, request):
    authorize(service, 'resolve_definition_replacement', request)
    if set(request) != {*SCOPE, 'snapshot_id', 'old_definition_ref', 'business_at', 'public_cutoff'}:
        raise ValueError('DEFINITION_REPLACEMENT_REQUEST_INVALID')
    cutoff = _second(request['public_cutoff']); _second(request['business_at'])
    before = digest(load(service.root))
    result = _resolve(service, request, cutoff)
    authorize(service, 'resolve_definition_replacement', request)
    if digest(load(service.root)) != before:
        raise ValueError('DEFINITION_REPLACEMENT_CONCURRENT_CHANGE')
    return result


def _resolve(service, request, cutoff):
    current = scoped(load(service.root), request)
    result = {'status': 'unknown', 'qualification': 'not_asserted',
              'catalog_digest': digest(current), 'scope': 'explicit_definition_replacement_only'}
    disabled = {e['approval_digest'] for e in current if e['action'] == 'disable_definition_replacement'}
    edges = []
    for event in current:
        if event['action'] != 'approve_definition_replacement': continue
        statement = event['statement']
        if statement['snapshot_id'] != request['snapshot_id'] or statement['old']['definition_ref'] != request['old_definition_ref']: continue
        if event['digest'] in disabled:
            return {**result, 'reason': 'APPROVAL_DISABLED'}
        approved = datetime.strptime(_second(event['approved_at']), '%Y-%m-%dT%H:%M:%SZ')
        # Approval has second precision; the whole observed second must end.
        if (approved + timedelta(seconds=1)).strftime('%Y-%m-%dT%H:%M:%SZ') > cutoff:
            continue
        edges.append({'statement': statement, 'digest': digest(statement)})
    if not edges:
        return {**result, 'reason': 'NO_APPROVED_REPLACEMENT'}
    # One shared fixed page is sufficient for all edges in this fixed product.
    evidence = bindings(service, edges[0]['statement'])
    decision = evaluate_replacement_candidates(request, edges, evidence)
    if decision['status'] != 'unique_candidate':
        return {**result, 'reason': decision['reason']}
    return {**result, 'status': 'selected', 'qualification': 'explicit_local_operator_approved',
            'candidate': decision['candidate'], 'edge_digest': decision['edge_digest']}
