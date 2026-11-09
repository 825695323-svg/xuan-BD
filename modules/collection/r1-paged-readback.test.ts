import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { WfdProductMachineClient, WfdProductMachineReply, WfdProductMachineReadPageOptions } from '../../adapters/database/wfd-product-machine.js';
import { WfdStructuredIngestClient } from './r1-structured-handoff.js';
import { R1PagedReadback, type R1ReadbackClient, type R1ReadbackInput } from './r1-paged-readback.js';

// Explicit page-contract doubles only; real Python/HTTP coverage is in r1-routes.test.ts.
const sha = (value: unknown) => 'sha256:' + wfdSha256(canonicalWfdJson(value));
const refs = Array.from({ length: 300 }, (_, i) => ({ record_id: `row-${String(i).padStart(4, '0')}`, record_version: `rev-${i}` }));
const input = (): R1ReadbackInput => {
  const document = { request_identity: { request_id: 'request-one' }, outputs: [{ output_key: 'scalar',
    payload: { rows: refs.map(ref => ({ business_key: ref.record_id, value_decimal: '12.30', value_state: 'valid_value' })) } }] };
  return { requestId: 'request-one', documentSha256: wfdSha256(canonicalWfdJson(document)), document,
    receipt: { dataset_id: 'isolated', output_key: 'scalar', product_id: 'product-one', definition_digest: 'definition-one',
      snapshot_id: 'snapshot-one', request_identity: { request_id: 'request-one' },
      rows: refs.map(ref => ({ business_key: ref.record_id, ...ref })) } };
};
function row(ref: typeof refs[number]): WfdRecord {
  return { ...ref, product_id: 'product-one', definition_ref: { digest: 'definition-one' },
    record_ref: { snapshot_id: 'snapshot-one', logical_key: ref.record_id, revision_id: ref.record_version },
    row: { business_key: ref.record_id, value_decimal: '12.30', value_state: 'valid_value' } };
}
function reply(result: WfdRecord): WfdProductMachineReply {
  return { result, response: { result }, transport: { requestId: 'wire-request', operation: 'fixed_read_page', elapsedMs: 1,
    responseBytes: Buffer.byteLength(JSON.stringify(result)), serviceVersion: 'fixture', contractVersion: null,
    schemaId: null, connectionId: 'fixture', callerId: 'fixture', trustedActorNamespace: 'fixture' } };
}
function page(options: WfdProductMachineReadPageOptions): WfdProductMachineReply {
  const offset = options.cursor ? Number(options.cursor) : 0, size = options.pageSize ?? 256;
  const chosen = refs.slice(offset, offset + size), next = offset + chosen.length < refs.length ? String(offset + chosen.length) : null;
  const selection = sha(refs), query = sha({ format_version: 'wfd.fixed-read-page/1', profile: 'data_only',
    snapshot_id: options.snapshotId, product_id: options.productId, selection_digest: selection,
    page_size: size, max_page_bytes: options.maxPageBytes ?? 1048576, perspective: 'snapshot_contents', include_history: false });
  return reply({ profile: 'data_only', snapshot_id: 'snapshot-one', product_id: 'product-one', dataset_id: 'isolated',
    perspective: 'snapshot_contents', include_history: false, rows: chosen.map(row),
    pagination: { format_version: 'wfd.fixed-read-page/1', page_size: size, max_page_bytes: options.maxPageBytes ?? 1048576,
      returned_rows: chosen.length, selection_count: refs.length, has_more: next !== null, next_cursor: next },
    integrity: { manifest_digest: 'sha256:' + 'a'.repeat(64), selection_digest: selection, query_digest: query, page_digest: sha(chosen) } });
}
function double(overrides: Partial<R1ReadbackClient> = {}): R1ReadbackClient {
  return { pageReadSupport: async () => true, fixedReadPage: async options => page(options),
    fixedRead: async () => { throw new Error('No full-read fallback permitted'); }, ...overrides };
}

test('F09 page negotiation keeps calendar-dependent and unresolved reuse targets on their explicit legacy read mode', async () => {
  const client = new WfdStructuredIngestClient({ capabilities: async () => reply({ profile: 'data_only',
    service_capabilities: { structured_ingest: 'wfd.structured-ingest/1.0', operations: {
      submit: { protocol: 'wfd.structured-ingest/1.0' }, fixed_read_page: { supported: true, format_version: 'wfd.fixed-read-page/1' },
    } } }) } as unknown as WfdProductMachineClient);
  const natural = { outputs: [{ payload: { kind: 'scalar_rows' }, definition: { semantic_context: { time: { period_type: 'natural' } } } }] };
  assert.equal(await client.pageReadSupport(natural), true);
  const calendar = structuredClone(natural) as WfdRecord;
  const definition = (calendar.outputs as WfdRecord[])[0].definition as WfdRecord;
  (definition.semantic_context as WfdRecord).time = { period_type: 'trading', calendar_ref: { fixed: true } };
  assert.equal(await client.pageReadSupport(calendar), false);
  const field = structuredClone(natural) as WfdRecord;
  ((field.outputs as WfdRecord[])[0].definition as WfdRecord).field_semantic_context = { value: { time: { accounting_calendar_ref: { fixed: true } } } };
  assert.equal(await client.pageReadSupport(field), false);
  const reuse = structuredClone(natural) as WfdRecord; (reuse.outputs as WfdRecord[])[0].definition_mode = 'reuse';
  assert.equal(await client.pageReadSupport(reuse), false);
});

test('F09 page contract persists a verified page; a new reader resumes its exact cursor without full read or submit', async () => {
  const database = new CoreDatabase();
  try {
    const reader = new R1PagedReadback(database), firstCalls: Array<string | null> = [];
    await assert.rejects(reader.read(input(), double({ fixedReadPage: async options => {
      firstCalls.push(options.cursor ?? null); if (options.cursor) throw new Error('injected disconnect after first verified page');
      const value = page(options);
      for (const row of value.result.rows as WfdRecord[]) row.source_binding = { full_raw_metadata: 'x'.repeat(1000) };
      return value;
    } })), /injected disconnect/);
    assert.deepEqual(firstCalls, [null, '256']);
    assert.equal(reader.progress('request-one')?.verifiedRows, 256);
    assert.equal(reader.progress('request-one')?.complete, false);
    const saved = JSON.parse(String(database.connection.prepare('SELECT state_json FROM r1_readback_checkpoints').get()!.state_json));
    assert.equal(typeof saved.query, 'string'); assert.equal(saved.selection, sha(refs)); assert.equal(saved.pageDigests.length, 1);
    assert.equal(saved.rows[0].source_binding, undefined, 'Cache stores actual verification fields, not repeated full WFD metadata');
    const resumed: Array<string | null> = [];
    const rows = await new R1PagedReadback(database).read(input(), double({ fixedReadPage: async options => { resumed.push(options.cursor ?? null); return page(options); } }));
    assert.deepEqual(resumed, ['256']); assert.equal(rows.length, 300);
    assert.equal(new Set(rows.map(value => value.record_id)).size, 300);
    assert.equal(reader.progress('request-one')?.complete, true);
  } finally { database.close(); }
});

test('F09 duplicate, altered identity/content/header and nonprogress pages fail before checkpoint advancement', async t => {
  const mutations: Array<[string, (result: WfdRecord) => void]> = [
    ['duplicate record', result => { const rows = result.rows as WfdRecord[]; rows[1] = structuredClone(rows[0]); }],
    ['wrong value', result => { ((result.rows as WfdRecord[])[0].row as WfdRecord).value_decimal = '99.00'; }],
    ['wrong snapshot', result => { result.snapshot_id = 'another-snapshot'; }],
    ['wrong version', result => { (result.rows as WfdRecord[])[0].record_version = 'wrong-version'; }],
    ['wrong definition', result => { ((result.rows as WfdRecord[])[0].definition_ref as WfdRecord).digest = 'wrong-definition'; }],
    ['wrong dataset', result => { result.dataset_id = 'another-dataset'; }],
    ['wrong selection', result => { (result.integrity as WfdRecord).selection_digest = 'sha256:' + 'b'.repeat(64); }],
    ['oversized metadata', result => { result.extra_metadata = 'x'.repeat(1048576); }],
    ['early terminal', result => { Object.assign(result.pagination as WfdRecord, { has_more: false, next_cursor: null }); }],
    ['wrong page digest', result => { (result.integrity as WfdRecord).page_digest = 'sha256:' + 'b'.repeat(64); }],
    ['empty advancing page', result => { result.rows = []; (result.pagination as WfdRecord).returned_rows = 0; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const database = new CoreDatabase();
    try {
      const reader = new R1PagedReadback(database);
      await assert.rejects(reader.read(input(), double({ fixedReadPage: async options => {
        const value = page(options); mutate(value.result); return value;
      } })), (error: unknown) => String((error as { code?: string }).code).startsWith('R1_READBACK_'));
      assert.equal(reader.progress('request-one')?.verifiedRows, 0);
    } finally { database.close(); }
  });
});

test('F09 manifest drift and tampered persisted progress cannot be adopted on resume', async () => {
  const database = new CoreDatabase();
  try {
    const reader = new R1PagedReadback(database);
    await assert.rejects(reader.read(input(), double({ fixedReadPage: async options => { if (options.cursor) throw new Error('stop'); return page(options); } })), /stop/);
    await assert.rejects(reader.read(input(), double({ fixedReadPage: async options => {
      const value = page(options); (value.result.integrity as WfdRecord).manifest_digest = 'sha256:' + 'b'.repeat(64); return value;
    } })), (error: unknown) => (error as { code?: string }).code === 'R1_READBACK_MANIFEST_CHANGED');
    database.connection.prepare("UPDATE r1_readback_checkpoints SET state_json='{}' WHERE request_id=?").run('request-one');
    await assert.rejects(reader.read(input(), double()), (error: unknown) => (error as { code?: string }).code === 'R1_READBACK_CHECKPOINT_CHANGED');
  } finally { database.close(); }
});

test('F09 frozen document/receipt, terminal count and mode are not silently rebound', async () => {
  const database = new CoreDatabase();
  try {
    const reader = new R1PagedReadback(database);
    await assert.rejects(reader.read(input(), double({ fixedReadPage: async options => { if (options.cursor) throw new Error('stop'); return page(options); } })), /stop/);
    const changed = input(); changed.documentSha256 = wfdSha256('different-document');
    await assert.rejects(reader.read(changed, double()), (error: unknown) => (error as { code?: string }).code === 'R1_READBACK_BINDING_CHANGED');
    await assert.rejects(reader.read(input(), double({ fixedReadPage: async options => {
      const value = page(options);
      value.result.rows = []; Object.assign(value.result.pagination as WfdRecord, { returned_rows: 0, has_more: false, next_cursor: null });
      (value.result.integrity as WfdRecord).page_digest = sha([]); return value;
    } })), (error: unknown) => String((error as { code?: string }).code).startsWith('R1_READBACK_'));
  } finally { database.close(); }
});

test('F09 concurrent readers cannot overwrite a newer durable checkpoint', async () => {
  const database = new CoreDatabase(); let release!: () => void, arrived = 0;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  try {
    const client = double({ fixedReadPage: async options => {
      if (!options.cursor) { arrived++; if (arrived === 2) release(); await barrier; }
      return page(options);
    } });
    const results = await Promise.allSettled([new R1PagedReadback(database).read(input(), client), new R1PagedReadback(database).read(input(), client)]);
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    const rejected = results.find(value => value.status === 'rejected'); assert.ok(rejected?.status === 'rejected');
    assert.equal(rejected.reason.code, 'R1_READBACK_CONCURRENT_CHANGE');
    assert.equal(new R1PagedReadback(database).progress('request-one')?.verifiedRows, 300);
  } finally { database.close(); }
});

test('F09 legacy support is selected once before read; a failed page never triggers full-read fallback', async () => {
  const database = new CoreDatabase();
  try {
    const reader = new R1PagedReadback(database); let supportCalls = 0, legacyCalls = 0;
    const client = double({ pageReadSupport: async () => { supportCalls++; return false; }, fixedRead: async () => {
      legacyCalls++; if (legacyCalls === 1) throw new Error('legacy response budget'); return reply({ rows: refs.map(row) });
    } });
    await assert.rejects(reader.read(input(), client), /legacy response budget/);
    const rows = await reader.read(input(), { ...client, pageReadSupport: async () => { throw new Error('Do not renegotiate original mode'); } });
    assert.equal(supportCalls, 1); assert.equal(legacyCalls, 2); assert.equal(rows.length, 300);
    assert.equal(reader.progress('request-one')?.mode, 'legacy');
  } finally { database.close(); }
});

test('explicit tabular continuation preserves the failed legacy checkpoint and resumes a separate bound page phase', async () => {
  const database=new CoreDatabase();
  try {
    const request=input(),outputs=request.document.outputs as WfdRecord[];
    (outputs[0]!.payload as WfdRecord).kind='tabular_rows';
    request.documentSha256=wfdSha256(canonicalWfdJson(request.document));
    const reader=new R1PagedReadback(database);
    const roles=['algorithm_dependency','read_layout','semantic','update_release'];
    const contracts=Object.fromEntries(roles.map(role=>[role,{id:'contract-'+role,version:'v1',kind:'contract',role,dataset_id:'isolated',resolution:'pinned',digest:sha(role)}]));
    const bundleBody={format_version:'wfd.contract-bundle/1.0',product_id:'product-one',dataset_id:'isolated',roles,contracts};
    const binding={contract_refs:contracts,contract_bundle_ref:{id:'bundle-one',version:'v1',kind:'contract_bundle',dataset_id:'isolated',resolution:'pinned',roles,digest:sha(bundleBody)}};
    Object.assign(request.receipt,binding);
    await assert.rejects(reader.read(request,double({pageReadSupport:async()=>false,fixedRead:async()=>{throw new Error('bounded legacy response too large');}})),/too large/);
    const old=database.connection.prepare('SELECT * FROM r1_readback_checkpoints WHERE request_id=?').get(request.requestId);
    const failure={code:'RESPONSE_TOO_LARGE',message:'preserved failed full read',snapshot_id:request.receipt.snapshot_id};
    await reader.beginPageContinuation(request,double(),failure);
    assert.deepEqual(database.connection.prepare('SELECT * FROM r1_readback_checkpoints WHERE request_id=?').get(request.requestId),old);
    const result=await reader.read(request,double({fixedReadPage:async options=>{
      const reply=page(options);reply.result.products=[{product_id:'product-one',definition_ref:{digest:'definition-one'},...binding}];return reply;
    }}));assert.equal(result.length,300);
    const progress=reader.progress(request.requestId)!;
    assert.equal(progress.mode,'page');assert.equal(progress.complete,true);assert.equal(progress.pages,2);
    assert.deepEqual(progress.continuation!.failure,failure);
    assert.deepEqual(database.connection.prepare('SELECT * FROM r1_readback_checkpoints WHERE request_id=?').get(request.requestId),old);
    assert.equal(database.connection.prepare('SELECT count(*) AS n FROM r1_readback_checkpoints').get()!.n,2);
  }finally{database.close();}
});

test('explicit accepted resume rejects unknown, mismatched intent and changed HEAD before any write',async()=>{
  const document:WfdRecord={request_identity:{dataset_id:'fixture',request_id:'same-original'},expected_parent_snapshot_id:'head-original',outputs:[]};
  let writes=0;let status:WfdRecord={state:'accepted_not_published',request_identity:document.request_identity,input_fingerprint:wfdSha256(canonicalWfdJson(document))};
  let head='head-original';
  const client=new WfdStructuredIngestClient({requestStatusPage:async()=>reply(status),snapshotStatus:async()=>reply({snapshot_id:head}),
    recovery:async()=>{writes++;return reply({state:'published_formal'});}} as unknown as WfdProductMachineClient);
  status={...status,state:'unknown'};await assert.rejects(client.resumeAccepted(document),{code:'R1_ORIGINAL_NOT_ACCEPTED'});
  status={...status,state:'accepted_not_published',input_fingerprint:'0'.repeat(64)};await assert.rejects(client.resumeAccepted(document),{code:'R1_ORIGINAL_NOT_ACCEPTED'});
  status={...status,input_fingerprint:wfdSha256(canonicalWfdJson(document))};head='changed-head';await assert.rejects(client.resumeAccepted(document),{code:'R1_RESUME_PARENT_CHANGED'});
  assert.equal(writes,0);head='head-original';await client.resumeAccepted(document);assert.equal(writes,1);
});

test('new negotiated checkpoints freeze 1000 rows under the unchanged one MiB byte budget',async()=>{
  const database=new CoreDatabase();try{
    const sizes:number[]=[];
    const rows=await new R1PagedReadback(database).read(input(),double({pageReadSize:()=>1000,fixedReadPage:async options=>{
      sizes.push(options.pageSize!);assert.equal(options.maxPageBytes,1_048_576);return page(options);
    }}));
    assert.equal(rows.length,300);assert.deepEqual(sizes,[1000]);
    const saved=JSON.parse(String(database.connection.prepare('SELECT state_json FROM r1_readback_checkpoints').get()!.state_json));
    assert.equal(saved.version,2);assert.equal(saved.pageSize,1000);
  }finally{database.close();}
});

test('original version one checkpoints keep their exact 256 query after new 1000 capability negotiation',async()=>{
  const database=new CoreDatabase();try{
    const reader=new R1PagedReadback(database);
    await assert.rejects(reader.read(input(),double({fixedReadPage:async options=>{
      if(options.cursor)throw Error('original interrupted read');return page(options);
    }})),/original interrupted/);
    const old=JSON.parse(String(database.connection.prepare('SELECT state_json FROM r1_readback_checkpoints').get()!.state_json));
    old.version=1;delete old.pageSize;const text=canonicalWfdJson(old);
    database.connection.prepare('UPDATE r1_readback_checkpoints SET state_json=?,state_sha256=?').run(text,wfdSha256(text));
    const seen:number[]=[];
    const rows=await new R1PagedReadback(database).read(input(),double({pageReadSize:()=>1000,fixedReadPage:async options=>{
      seen.push(options.pageSize!);assert.equal(options.cursor,'256');return page(options);
    }}));
    assert.equal(rows.length,300);assert.deepEqual(seen,[256]);
  }finally{database.close();}
});
