export {};

const [command = 'status', ...args] = process.argv.slice(2);
const endpoint = 'http://127.0.0.1:4317/api/bd';
let path: string, body: unknown;
if (command === 'status' && !args.length) path = '/runtime/status';
else if (command === 'stop' && args.length === 1) { path = '/runtime/stop'; body = { reason: args[0] }; }
else if (command === 'resume' && args.length === 2 && /^\d+$/.test(args[0]!)) { path = '/runtime/resume'; body = { generation: Number(args[0]), reason: args[1] }; }
else if (command === 'job' && args.length === 1) path = `/jobs/${encodeURIComponent(args[0]!)}/evidence`;
else if (command === 'chat' && args.length === 2) { path = '/jobs'; body = { operation: 'agent.chat', requestId: args[0], args: { prompt: args[1] } }; }
else throw new Error('用法：status | stop 原因 | resume 当前控制代次 原因 | job 任务编号 | chat 请求编号 简短请求；启动请使用 npm run web 或平台启动脚本。');
const qualificationResponse = await fetch(endpoint + '/local-data/current', { signal: AbortSignal.timeout(10_000) });
const current = await qualificationResponse.json() as { dataId?: string; available?: boolean; detail?: string; error?: string;
  record?: { dataId?: string; status?: string; adopted?: boolean; generation?: number; reloadPending?: unknown } | null };
if (!qualificationResponse.ok) throw new Error(`本地资料资格核对失败（${qualificationResponse.status}）：${current?.error ?? '未取得当前资格。'}`);
const record = current?.record;
if (current?.available !== true || record?.status !== 'active' || record.adopted !== true || record.reloadPending) {
  throw new Error(current?.detail || `当前本地资料未启用或资格不明（${record?.status ?? '无控制记录'}）；未发送工作台动作。`);
}
if (typeof current.dataId !== 'string' || record.dataId !== current.dataId || !Number.isSafeInteger(record.generation) || Number(record.generation) < 1) {
  throw new Error('当前本地资料身份或代次不完整；未发送工作台动作。');
}
const response = await fetch(endpoint + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-mashiro-client': 'web', 'x-local-data-generation': String(record.generation) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
console.log(JSON.stringify(await response.json(), null, 2)); if (!response.ok) process.exitCode = 1;
