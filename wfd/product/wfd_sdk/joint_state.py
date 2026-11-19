"""Opt-in fresh-volume authority. No legacy migration or group repair entry point."""
from contextlib import contextmanager
from contextvars import ContextVar
import copy
import json
import functools
from pathlib import Path

from .state import StateStore, StateError, FORMAT as LEGACY_STATE_FORMAT, _now, _sha_file
from .writerlock import writer_lock

FORMAT = 'wfd.joint-volume.experimental/1'
MARKER = 'catalog/volume-format.json'
CURRENT = 'catalog/joint-current.json'
_submission = ContextVar('wfd_joint_submission', default=None)
_read_view = ContextVar('wfd_joint_read', default=None)
_governance = ContextVar('wfd_joint_governance', default=None)


def is_joint(root):
    path = Path(root) / MARKER
    if not path.exists():
        if (Path(root) / CURRENT).exists():
            raise StateError('JOINT_FORMAT_MISSING')
        return False
    try:
        marker = json.loads(path.read_text('utf-8'))
    except (OSError, ValueError) as exc:
        raise StateError('JOINT_FORMAT_INVALID', str(exc)) from exc
    if marker != {'format': FORMAT}:
        raise StateError('JOINT_FORMAT_UNSUPPORTED')
    assert_unmixed(root)
    return True


def assert_unmixed(root):
    for name in ('catalog/state.json', 'catalog/usage_suspensions.json', 'catalog/usage_suspensions.initialized'):
        if (Path(root) / name).exists():
            raise StateError('JOINT_LEGACY_MIXED', name)


def reject_unsupported(root, operation):
    if is_joint(root):
        raise StateError('JOINT_OPERATION_UNSUPPORTED', operation)


def read_guard(function):
    """One current governance view per public read; changed authority fails closed."""
    @functools.wraps(function)
    def guarded(service, *args, **kwargs):
        state = service.engine.state
        if not isinstance(state, JointStateStore):
            return function(service, *args, **kwargs)
        view = state.view()
        if "snapshot_id" in kwargs:
            state.require_activated_snapshot(view, kwargs["snapshot_id"])
        token = _read_view.set((str(service.root.resolve()), view))
        try:
            result = function(service, *args, **kwargs)
            if state.view()["commit_id"] != view["commit_id"]:
                raise StateError("JOINT_READ_CHANGED", "retry explicit read")
            return result
        finally:
            _read_view.reset(token)
    return guarded


def current_usage(root):
    context = _read_view.get()
    if context and context[0] == str(Path(root).resolve()):
        return copy.deepcopy(context[1]["usage"])
    return copy.deepcopy(JointStateStore(root).view()["usage"])


def governance_write(function):
    """Host governance methods retain validation; fresh volumes add explicit CAS."""
    @functools.wraps(function)
    def guarded(root, declaration, *, expected_commit_id=None):
        if not is_joint(root):
            if expected_commit_id is not None:
                raise StateError('JOINT_TOKEN_ON_LEGACY_VOLUME')
            return function(root, declaration)
        if not isinstance(expected_commit_id, str) or not expected_commit_id:
            raise StateError('JOINT_PREDECESSOR_REQUIRED')
        from .duckdb_sdk import canonical, sha
        operation = {'kind': function.__name__, 'digest': sha(canonical(declaration)),
                     'predecessor_commit': expected_commit_id}
        state = JointStateStore(root)
        with writer_lock(root):
            view = state.view()
            if view['commit_id'] != expected_commit_id:
                record = view['record']
                operation_commit_id = view['commit_id']
                for _ in range(1024):
                    if record.get('governance_operation') == operation:
                        break
                    predecessor = record.get('predecessor_commit')
                    if predecessor is None:
                        raise StateError('JOINT_CAS_CONFLICT')
                    record = state._object('commit', digest=predecessor)
                    operation_commit_id = predecessor
                else:
                    raise StateError('JOINT_ANCESTRY_BUDGET')
                # Existing domain idempotency revalidates declaration. No new write.
                replay = True
            else:
                replay = False
            token = _governance.set((str(Path(root).resolve()), operation, replay))
            try:
                result = function(root, declaration)
                committed = operation_commit_id if replay else state.view()['commit_id']
                return {**result, 'joint_commit_id': committed}
            finally:
                _governance.reset(token)
    return guarded


class JointStateStore(StateStore):
    def __init__(self, root):
        super().__init__(Path(root))
        self.path = self.root / CURRENT

    def _object(self, kind, value=None, digest=None):
        from .duckdb_sdk import canonical, sha, WFDDuckDBPrototype
        if value is not None:
            raw = canonical(value); digest = sha(raw)
            WFDDuckDBPrototype._write_immutable(self, f'catalog/joint_objects/{kind}-{digest}.json', raw)
            return digest
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise StateError('JOINT_OBJECT_REF_INVALID')
        try:
            raw = (self.root / f'catalog/joint_objects/{kind}-{digest}.json').read_bytes()
            if sha(raw) != digest:
                raise StateError('JOINT_OBJECT_DIGEST')
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError('not an object')
            return value
        except (OSError, ValueError) as exc:
            raise StateError('JOINT_OBJECT_UNREADABLE', str(exc)) from exc

    def view(self):
        if not is_joint(self.root):
            raise StateError("JOINT_FORMAT_MISSING")
        pointer = StateStore.read(self)
        if not isinstance(pointer, dict) or set(pointer) != {'format', 'commit'} or pointer['format'] != FORMAT:
            raise StateError('JOINT_CURRENT_INVALID')
        record = self._object('commit', digest=pointer['commit'])
        if record.get('format') != FORMAT or not isinstance(record.get('state'), dict):
            raise StateError('JOINT_COMMIT_INVALID')
        usage = self._object('usage', digest=record.get('usage_ref'))
        if (usage.get('format_version') != 'wfd.usage-suspension/1'
                or not isinstance(usage.get('issues'), list)
                or not isinstance(usage.get('tickets'), list)):
            raise StateError('JOINT_GOVERNANCE_INVALID')
        return {'commit_id': pointer['commit'], 'record': record, 'usage': usage}

    def require_activated_snapshot(self, view, snapshot_id):
        """Only the captured authority ancestry makes a fixed snapshot visible.

        Immutable candidate files and engine receipts are not activation proof.
        Candidate verification deliberately uses the engine's private fixed read.
        """
        record = view["record"]
        for _ in range(1024):
            if record["state"].get("active_head") == snapshot_id and snapshot_id is not None:
                return
            predecessor = record.get("predecessor_commit")
            if predecessor is None:
                raise StateError("JOINT_SNAPSHOT_NOT_ACTIVATED")
            record = self._object("commit", digest=predecessor)
        raise StateError("JOINT_ANCESTRY_BUDGET")

    def find_request(self, identity, document_digest):
        view = self.view()
        record = view["record"]
        for _ in range(1024):
            if record.get("request_identity") == identity:
                if record.get("document_digest") != document_digest:
                    raise StateError("REQUEST_ID_CONFLICT")
                return record
            predecessor = record.get("predecessor_commit")
            if predecessor is None:
                return None
            record = self._object("commit", digest=predecessor)
        raise StateError("JOINT_ANCESTRY_BUDGET")

    def read(self):
        view = self.view()
        return {**copy.deepcopy(view['record']['state']), 'joint_commit_id': view['commit_id']}

    def ensure_initialized(self, *, writer_host=None):
        if self.path.exists():
            return self.read()
        # Called only by explicit empty-volume initializer.
        assert_unmixed(self.root)
        state = {'format_version': LEGACY_STATE_FORMAT, 'active_head': None, 'head_snapshot_sha256': None,
                 'writer_host': writer_host, 'writer_epoch': 0, 'update_seq': 0,
                 'prev_head': None, 'activation_history': [], 'updated_at_utc': _now()}
        usage = self._object('usage', {'format_version': 'wfd.usage-suspension/1', 'issues': [], 'tickets': []})
        record = {'format': FORMAT, 'predecessor_commit': None, 'state': state, 'usage_ref': usage,
                  'request_identity': None, 'document_digest': None}
        digest = self._object('commit', record)
        StateStore._write_atomic(self, {'format': FORMAT, 'commit': digest})
        return self.read()

    def commit_governance(self, usage):
        context = _governance.get()
        if not context or context[0] != str(self.root.resolve()) or context[2]:
            raise StateError('JOINT_GOVERNANCE_CONTEXT_REQUIRED')
        with writer_lock(self.root):
            view = self.view()
            if view['commit_id'] != context[1]['predecessor_commit']:
                raise StateError('JOINT_CAS_CONFLICT')
            state = copy.deepcopy(view['record']['state'])
            state['update_seq'] += 1
            state['updated_at_utc'] = _now()
            record = {'format': FORMAT, 'predecessor_commit': view['commit_id'],
                      'state': state, 'usage_ref': self._object('usage', usage),
                      'request_identity': None, 'document_digest': None,
                      'governance_operation': copy.deepcopy(context[1])}
            digest = self._object('commit', record)
            StateStore._write_atomic(self, {'format': FORMAT, 'commit': digest})

    @contextmanager
    def submission(self, expected_commit_id, identity, document_digest, *, candidate_verifier=None):
        token = _submission.set((str(self.root.resolve()), expected_commit_id, copy.deepcopy(identity), document_digest, candidate_verifier))
        try:
            yield
        finally:
            _submission.reset(token)

    def activate(self, snapshot_id, snapshot_path, *, expected_prev, writer_host=None,
                 writer_epoch=None, allow_writer_change=False, authorized_by=None):
        with writer_lock(self.root):
            context = _submission.get()
            if not context or context[0] != str(self.root.resolve()):
                return {'ok': False, 'code': 'JOINT_SUBMISSION_CONTEXT_REQUIRED'}
            if allow_writer_change or authorized_by is not None:
                return {'ok': False, 'code': 'JOINT_OPERATION_UNSUPPORTED'}
            view = self.view(); st = view['record']['state']
            if view['commit_id'] != context[1] or st['active_head'] != expected_prev:
                return {'ok': False, 'code': 'JOINT_CAS_CONFLICT'}
            if writer_host is not None and st['writer_host'] not in (None, writer_host):
                return {'ok': False, 'code': 'WRITER_NOT_AUTHORIZED'}
            if writer_epoch is not None and writer_epoch != st['writer_epoch']:
                return {'ok': False, 'code': 'WRITER_EPOCH_MISMATCH'}
            usage_ref = view['record']['usage_ref']
            verification = None
            if context[4] is not None:
                usage, verification = context[4](snapshot_id, copy.deepcopy(view))
                if self.view()['commit_id'] != context[1]:
                    return {'ok': False, 'code': 'JOINT_CAS_CONFLICT'}
                usage_ref = self._object('usage', usage)
            sequence = st['update_seq'] + 1
            state = {**st, 'active_head': snapshot_id, 'head_snapshot_sha256': 'sha256:' + _sha_file(Path(snapshot_path)),
                     'prev_head': expected_prev, 'update_seq': sequence, 'updated_at_utc': _now(),
                     'writer_host': writer_host if writer_host is not None else st['writer_host'],
                     'activation_history': (st['activation_history'] + [{'snapshot_id': snapshot_id,
                        'prev_head': expected_prev, 'update_seq': sequence, 'at_utc': _now()}])[-200:]}
            record = {'format': FORMAT, 'predecessor_commit': view['commit_id'], 'state': state,
                      'usage_ref': usage_ref, 'request_identity': context[2], 'document_digest': context[3],
                      'verification': verification}
            digest = self._object('commit', record)
            self._object('commit', digest=digest)
            StateStore._write_atomic(self, {'format': FORMAT, 'commit': digest})
            return {'ok': True, 'code': 'OK', 'state': self.read()}

    def recover(self, *args, **kwargs):
        raise StateError('JOINT_OPERATION_UNSUPPORTED', 'legacy head recovery')
