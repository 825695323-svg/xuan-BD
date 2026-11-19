"""Conditional replacement contract evaluation, NOT a trusted registry or read API.

All inputs are caller-supplied. A unique candidate is never formal qualification.
No database mutation, registration, transitive traversal or current-definition fallback.
An eventual adapter must obtain the complete edge set and binding evidence from an
independently authorized, fixed source before using this contract in production.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from jsonschema import Draft202012Validator
from datetime import datetime

from .duckdb_sdk import canonical, sha, eligibility_at


_TIME_SCHEMA = json.loads((Path(__file__).resolve().parents[1] / 'protocol/schemas/wfd-common.schema.json').read_text())['$defs']['TimeWithPrecision']
_TIME_VALIDATOR = Draft202012Validator(_TIME_SCHEMA)


def _second(value):
    if not isinstance(value, str) or len(value) != 20:
        raise ValueError('UTC second required')
    parsed = datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ')
    if parsed.strftime('%Y-%m-%dT%H:%M:%SZ') != value:
        raise ValueError('Noncanonical UTC')
    return value


def _ref(value):
    return isinstance(value, dict) and bool(value) and bool(value.get('digest'))


def evaluate_replacement_candidates(request, edges, bindings):
    """Evaluate one hop within an explicitly supplied, bounded candidate set.

    Edge envelope: {digest: sha256(canonical(statement)), statement: {...}}.
    Digest freezes content only, never authenticates the caller or an authority.
    Each endpoint pins a full record_ref, definition_ref and binding_digest to
    supplied #126 evidence. Public time is required for both endpoints and edge.
    Effective business interval is [valid_from, valid_until), independently of
    public cutoff. Unknown evidence anywhere in the set prevents uniqueness.
    """
    result = {'status': 'unknown', 'qualification': 'not_asserted',
              'scope': 'caller_supplied_candidate_set_only'}
    def reject(reason):
        return {**result, 'reason': reason}
    try:
        if not isinstance(request, dict) or not all(isinstance(request.get(k), str) and request[k]
                for k in ('instance_id', 'snapshot_id', 'product_id', 'business_scope')):
            return reject('REQUEST_INVALID')
        if not _ref(request.get('old_definition_ref')):
            return reject('REQUEST_INVALID')
        at, cutoff = _second(request['business_at']), _second(request['public_cutoff'])
        if not isinstance(edges, list) or not isinstance(bindings, list) or not 0 < len(edges) <= 1000 or len(bindings) > 2000:
            return reject('CANDIDATE_SET_MISSING_OR_BUDGET')
        candidates, seen = [], set()
        for envelope in edges:
            statement = envelope['statement']
            digest = 'sha256:' + sha(canonical(statement))
            if envelope['digest'] != digest or digest in seen:
                return reject('EDGE_DIGEST_OR_DUPLICATE')
            seen.add(digest)
            if any(statement.get(k) != request[k] for k in ('instance_id', 'snapshot_id', 'product_id', 'business_scope')):
                return reject('SCOPE_MISMATCH')
            old, new = statement['old'], statement['new']
            if old['definition_ref'] != request['old_definition_ref'] or not _ref(new['definition_ref']) or old['definition_ref'] == new['definition_ref']:
                return reject('REPLACEMENT_IDENTITY_INVALID')
            start, end = _second(statement['valid_from']), _second(statement['valid_until'])
            if start >= end:
                return reject('EFFECTIVE_INTERVAL_INVALID')
            times = [statement['public_time']]
            for endpoint in (old, new):
                ref = endpoint['record_ref']
                if not all(isinstance(ref.get(k), str) and ref[k] for k in ('snapshot_id', 'product_id', 'logical_key', 'revision_id')) or ref['snapshot_id'] != request['snapshot_id'] or ref['product_id'] != request['product_id']:
                    return reject('FIXED_RECORD_MISMATCH')
                matches = [b for b in bindings if b.get('record_ref') == ref]
                if len(matches) != 1:
                    return reject('BINDING_MISSING_OR_AMBIGUOUS')
                binding = matches[0]
                if binding.get('status') != 'bound' or any(binding.get(k) != endpoint[k] for k in ('definition_ref', 'binding_digest')):
                    return reject('BINDING_MISMATCH')
                if not isinstance(endpoint['binding_digest'], str) or not endpoint['binding_digest'].startswith('sha256:'):
                    return reject('BINDING_MISMATCH')
                times.append(binding['public_time'])
            decisions = []
            for time in times:
                if not isinstance(time, dict) or time.get('status') != 'known':
                    return reject('PUBLIC_TIME_UNKNOWN')
                if not _TIME_VALIDATOR.is_valid(time):
                    return reject('PUBLIC_TIME_INVALID')
                if _second(time['earliest_utc']) >= _second(time['latest_exclusive_utc']):
                    return reject('PUBLIC_TIME_INVALID')
                decisions.append(eligibility_at(time, cutoff)['decision'])
            if 'indeterminate' in decisions:
                return reject('PUBLIC_TIME_INDETERMINATE')
            if 'ineligible' not in decisions and start <= at < end:
                candidates.append((digest, new))
        if len(candidates) != 1:
            return reject('NO_ELIGIBLE_CANDIDATE' if not candidates else 'AMBIGUOUS_CANDIDATES')
        digest, new = candidates[0]
        return {**result, 'status': 'unique_candidate', 'reason': 'CONDITIONAL_ONLY_NO_TRUSTED_REGISTRY',
                'edge_digest': digest, 'candidate': {k: copy.deepcopy(new[k]) for k in ('record_ref', 'definition_ref', 'binding_digest')}}
    except (KeyError, TypeError, ValueError, AttributeError):
        return reject('CONTRACT_INVALID')
