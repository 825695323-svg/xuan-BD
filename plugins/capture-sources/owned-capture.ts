import { request as httpRequest } from 'node:http';
import { Agent, request } from 'undici';
import type { TaskExecutionContext } from '../../platform/jobs/tasks.js';
import { DirectError } from '../../platform/runtime/file-workspace.js';
import { assertPublicWebAddress, createPublicWebLookup, resolvePublic, type PublicWebAddress } from '../../platform/capabilities/browser/public-web.js';
import { captureRequestAllowed, captureResponseIsSource, type CaptureSiteRule } from './sites.js';
import type { CapturePageResult, CaptureSourceResponse } from './contracts.js';

interface Connection { host: string; port: number }
interface TransportInput { url: URL; method: 'GET' | 'POST' | 'OPTIONS'; body?: string; headers: Record<string,string>; address: PublicWebAddress; signal: AbortSignal; assertAuthorized(): void; maxBytes?: number }
interface TransportResult { status: number; headers: { name: string; value: string }[]; bytes: Uint8Array }
export interface CaptureNetworkOptions {
  resolve?: typeof resolvePublic;
  transport?: (input: TransportInput) => Promise<TransportResult>;
}
const LIMIT = 2*1024*1024, TOTAL_LIMIT = 16*1024*1024;
// 微信长文常带内联图片，单页 HTML 会超过 2 MiB；只对文章读取放宽到 6 MiB。
const ruleLimit = (rule:CaptureSiteRule):number => rule.sourceId==='wechat'&&rule.operation==='article'?8*1024*1024:LIMIT;
const ruleTotalLimit = (rule:CaptureSiteRule):number => rule.sourceId==='wechat'&&rule.operation==='article'?32*1024*1024:TOTAL_LIMIT;
const object = (value: unknown): value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hasCredentialForm = (html: string) => /<input\b[^>]*(?:type\s*=\s*["']?password|name\s*=\s*["']?(?:password|passwd|pwd|otp|verification_code))\b/iu.test(html);

/** 复用成熟 HTTPS（加密网页）客户端与基础公网地址钉住规则。只调用已经通过站点合同的读型请求。 */
async function siteTransport(input: TransportInput): Promise<TransportResult> {
  const dispatcher = new Agent({ connect: { lookup: createPublicWebLookup(input.url.hostname,input.address,input.assertAuthorized), timeout: 10_000 }, connections: 1, pipelining: 1, maxHeaderSize: 32_768, allowH2: false });
  let failure: unknown, result: TransportResult | undefined;
  try {
    input.assertAuthorized(); input.signal.throwIfAborted();
    const response = await request(input.url,{ dispatcher,method:input.method,body:input.body,signal:input.signal,headersTimeout:10_000,bodyTimeout:10_000,
      headers:{...input.headers,'accept-encoding':'identity'} });
    response.body.on('error',()=>{});
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of response.body) {
      input.assertAuthorized(); bytes += chunk.length;
      const maxBytes = input.maxBytes ?? LIMIT;
      if (bytes > maxBytes) throw new DirectError('CAPTURE_RESPONSE_LIMIT',`站点单次响应超出 ${Math.round(maxBytes/1048576)} MiB（兆字节）上限，未保留截断原件。`);
      chunks.push(Buffer.from(chunk));
    }
    const headers = Object.entries(response.headers).flatMap(([name,value])=>value===undefined?[]:(Array.isArray(value)?value:[value]).map(value=>({name,value})));
    if (headers.some(header=>header.name==='content-encoding' && header.value!=='identity')) throw new DirectError('CAPTURE_ENCODING_UNSUPPORTED','站点忽略了不压缩请求，当前无法保留可核对的原始表示。');
    const data = Buffer.concat(chunks), length = response.headers['content-length'];
    if (typeof length === 'string' && (!/^\d+$/u.test(length) || Number(length)!==data.length)) throw new DirectError('CAPTURE_RESPONSE_INCOMPLETE','站点响应长度不一致，未作为完整原件保存。');
    result={status:response.statusCode,headers,bytes:data};
  } catch(error) { failure=error; }
  finally { try { await dispatcher.destroy(); } catch { failure=new DirectError('CAPTURE_NETWORK_CLOSE_UNKNOWN','本次站点网络资源关闭尚未确认，沿原任务核对。',true); } }
  if (failure) throw failure;
  return result!;
}

function browserSocket(connection: Connection, signal: AbortSignal, assertCurrent:()=>void): Promise<string> {
  return new Promise((resolve,reject)=>{
    const chunks:Buffer[]=[]; let bytes=0;
    const req=httpRequest({hostname:connection.host,port:connection.port,path:'/json/version',method:'GET',signal},response=>{
      response.on('data',chunk=>{ if((bytes+=chunk.length)>32_000) req.destroy(); else chunks.push(Buffer.from(chunk)); });
      response.once('error',reject); response.once('aborted',()=>reject(new DirectError('CAPTURE_CDP_UNAVAILABLE','站点专用浏览器连接中断。')));
      response.once('end',()=>{try {
        assertCurrent(); const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const prefix=`ws://${connection.host==='::1'?'[::1]':connection.host}:${connection.port}/devtools/browser/`;
        if(response.statusCode!==200 || !object(value) || typeof value.webSocketDebuggerUrl!=='string' || !value.webSocketDebuggerUrl.startsWith(prefix) || !/^[a-z0-9-]+$/iu.test(value.webSocketDebuggerUrl.slice(prefix.length))) throw new Error();
        resolve(value.webSocketDebuggerUrl);
      } catch {reject(new DirectError('CAPTURE_CDP_UNVERIFIABLE','站点专用浏览器端点身份无法核对，未尝试其他连接。'));}});
    });
    req.setTimeout(2000,()=>req.destroy()); req.once('error',()=>reject(new DirectError('CAPTURE_CDP_UNAVAILABLE','站点专用浏览器未响应。')));
    try {assertCurrent(); req.end();} catch(error){req.destroy();reject(error);}
  });
}

/** 新建独占页目标，只执行经摘要核对的固定脚本。没有任意脚本、目标、命令或端点的模型参数。 */
export async function captureSitePage(context:TaskExecutionContext, connection:Connection, rule:CaptureSiteRule, source:URL, args:Record<string,string>, script:string,
  assertCurrent:()=>void, authorizeOrigin:(origin:string)=>Promise<void>, options:CaptureNetworkOptions={}):Promise<CapturePageResult> {
  const controller=new AbortController(),signal=AbortSignal.any([context.signal,controller.signal]);
  const deadline=setTimeout(()=>controller.abort(),rule.sourceId==='wechat'&&rule.operation==='article'?120_000:60_000);
  let socket:WebSocket|undefined,targetId:string|undefined,sessionId:string|undefined,sequence=0,closing=false,blocked=0,totalBytes=0,rawComplete=true,requestCount=0,sourceBytes=0;
  const requestArgs={...args};
  let failure:unknown,result:CapturePageResult|undefined,loaded=false,lastNetworkError='';
  const responses:CaptureSourceResponse[]=[],requests=new Set<Promise<void>>();
  const pending=new Map<number,{method:string;resolve(value:Record<string,unknown>):void;reject(error:unknown):void;timer:ReturnType<typeof setTimeout>}>();
  let load!:()=>void; const loadedEvent=new Promise<void>(done=>{load=()=>{loaded=true;done();};});
  const send=(method:string,params:Record<string,unknown>={},session?:string,cleanup=false):Promise<Record<string,unknown>>=>new Promise((resolve,reject)=>{
    try {if(!cleanup){signal.throwIfAborted();assertCurrent();} if(!socket || socket.readyState!==WebSocket.OPEN) throw new DirectError('CAPTURE_CDP_UNKNOWN','原站点连接已中断，自有目标状态待核。',true);
      const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new DirectError('CAPTURE_CDP_UNKNOWN','站点浏览器命令未确认完成，不自动重放。',true));},cleanup?2000:30_000);
      pending.set(id,{method,resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(session?{sessionId:session}:{})}));
    } catch(error){reject(error);}
  });
  const stopped=()=>{for(const [id,item] of pending){clearTimeout(item.timer);item.reject(new DirectError('CAPTURE_STOPPED','本站采集已停止，沿原任务保留网络与关闭结果。'));pending.delete(id);}};
  signal.addEventListener('abort',stopped,{once:true});
  const paused=async(params:Record<string,unknown>)=>{
    if(typeof params.requestId!=='string'||!object(params.request))throw new DirectError('CAPTURE_CDP_UNKNOWN','浏览器请求身份无法核对。',true);
    const id=params.requestId,req=params.request,method=String(req.method),url=String(req.url),type=String(params.resourceType);
    if(++requestCount>256)throw new DirectError('CAPTURE_REQUEST_LIMIT','本站采集请求数量超过256项预算。');
    if(!captureRequestAllowed(rule,source,requestArgs,method,url,type,typeof req.postData==='string'?req.postData:undefined)){
      blocked++;await send('Fetch.failRequest',{requestId:id,errorReason:'BlockedByClient'},sessionId);return;
    }
    await authorizeOrigin(new URL(url).origin); assertCurrent(); signal.throwIfAborted();
    const answers=await(options.resolve??resolvePublic)(new URL(url).hostname,signal);
    if(!answers.length||answers.length>32)throw new DirectError('CAPTURE_DNS_FAILED','站点请求没有可核对的公网地址。');
    answers.forEach(assertPublicWebAddress);
    const headers:Record<string,string>={};
    if(object(req.headers)) for(const [key,value] of Object.entries(req.headers)) if(typeof value==='string'&&!/^(?:host|cookie|connection|content-length|accept-encoding|proxy-.+|sec-.+)$/iu.test(key))headers[key]=value;
    // 原生 Cookie（会话凭据）仅在当前专属 profile（账号目录）与固定目标之间使用，不写入结果或日志。
    const cookies=await send('Network.getCookies',{urls:[url]},sessionId);
    if(Array.isArray(cookies.cookies)){
      const values=cookies.cookies.filter(object).filter(cookie=>typeof cookie.name==='string'&&typeof cookie.value==='string');
      if(values.length) headers.cookie=values.map(cookie=>`${cookie.name}=${cookie.value}`).join('; ');
    }
    const response=await(options.transport??siteTransport)({maxBytes:ruleLimit(rule),url:new URL(url),method:method as 'GET'|'POST'|'OPTIONS',...(typeof req.postData==='string'?{body:req.postData}:{}),headers,address:answers.find(answer=>answer.family===4)??answers[0]!,signal,assertAuthorized:()=>{signal.throwIfAborted();assertCurrent();}});
    signal.throwIfAborted();assertCurrent();totalBytes+=response.bytes.byteLength;if(totalBytes>ruleTotalLimit(rule))throw new DirectError('CAPTURE_TOTAL_LIMIT',`本站采集响应累计超过${Math.round(ruleTotalLimit(rule)/1048576)} MiB（兆字节）预算。`);
    const contentType=response.headers.find(header=>header.name.toLowerCase()==='content-type')?.value??'';
    if(rule.sourceId==='bilibili' && new URL(url).hostname==='api.bilibili.com' && new URL(url).pathname==='/x/web-interface/view'){
      try{const view:unknown=JSON.parse(Buffer.from(response.bytes).toString('utf8'));if(object(view)&&view.code===0&&object(view.data)&&view.data.bvid===args.bvid&&Number.isSafeInteger(view.data.aid)&&Number(view.data.aid)>0)requestArgs.__verifiedAid=String(view.data.aid);}catch{/* 格式失败交原脚本明确报告，不能据此放行其他视频评论。 */}
    }
    if(captureResponseIsSource(rule,url,type)){
      sourceBytes+=response.bytes.byteLength;if(sourceBytes>8*1024*1024||responses.length>=64)throw new DirectError('CAPTURE_SOURCE_LIMIT','本站原始来源超过8 MiB（兆字节）或64条预算，未把截断来源发布为完整。');
      const html=/html/iu.test(contentType),body=Buffer.from(response.bytes).toString('utf8');
      if(html&&hasCredentialForm(body))rawComplete=false;
      else responses.push({url,status:response.status,contentType,body:Buffer.from(response.bytes).toString('base64'),base64Encoded:true});
    }
    const responseHeaders=response.headers.filter(header=>!/^(?:connection|transfer-encoding|content-length|content-encoding|keep-alive|proxy-.+|upgrade)$/iu.test(header.name));
    const relaxed=rule.sourceId==='sogouwechat';
    const connectOrigins=[...(relaxed?['https:']:[source.origin]),...(rule.sourceId==='bilibili'?['https://api.bilibili.com']:rule.sourceId==='xiaohongshu'?['https://edith.xiaohongshu.com']:[])];
    responseHeaders.push({name:'Content-Security-Policy',value:`default-src 'none'; script-src https: 'unsafe-inline' 'unsafe-eval'; style-src https: 'unsafe-inline'; connect-src ${connectOrigins.join(' ')}; img-src 'none'; media-src 'none'; font-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'`},
      {name:'X-DNS-Prefetch-Control',value:'off'},{name:'Referrer-Policy',value:'no-referrer'});
    await send('Fetch.fulfillRequest',{requestId:id,responseCode:response.status,responseHeaders,body:Buffer.from(response.bytes).toString('base64')},sessionId);
  };
  try {
    const endpoint=await browserSocket(connection,signal,assertCurrent);
    socket=new WebSocket(endpoint);
    socket.addEventListener('message',event=>{
      if(typeof event.data!=='string'||event.data.length>8*1024*1024){failure??=new DirectError('CAPTURE_OUTPUT_LIMIT','站点浏览器消息超过预算。',true);controller.abort();return;}
      let message:unknown;try{message=JSON.parse(event.data);}catch{failure??=new DirectError('CAPTURE_CDP_UNKNOWN','站点浏览器消息无法核对。',true);controller.abort();return;}
      if(!object(message))return;
      if(typeof message.id==='number'){
        const item=pending.get(message.id);if(!item)return;pending.delete(message.id);clearTimeout(item.timer);
        if(message.error){
          const detail=object(message.error)&&typeof message.error.message==='string'?message.error.message.slice(0,160):'';
          item.reject(new DirectError('CAPTURE_CDP_COMMAND_FAILED',`本次站点浏览器命令失败（${item.method}${detail?`：${detail}`:''}）。`));
        }else item.resolve(object(message.result)?message.result:{});return;
      }
      if(message.sessionId!==sessionId)return;
      if(message.method==='Page.loadEventFired')load();
      if(message.method==='Fetch.requestPaused'&&object(message.params)){
        const work=paused(message.params).catch(error=>{if(!closing){lastNetworkError=error instanceof Error?error.message:String((error as {message?:unknown})?.message??error);failure??=error;controller.abort();}});requests.add(work);void work.finally(()=>requests.delete(work));
      }
      if(message.method==='Target.attachedToTarget'&&object(message.params)&&object(message.params.targetInfo)&&typeof message.params.targetInfo.targetId==='string'&&message.params.targetInfo.targetId!==targetId){
        // Worker（后台脚本）与子目标保持暂停并关闭，不能恢复后绕过本页网络拦截。
        const childId=message.params.targetInfo.targetId;
        const work=send('Target.closeTarget',{targetId:childId}).then(closed=>{if(closed.success!==true)throw new DirectError('CAPTURE_CHILD_CLOSE_UNKNOWN','本站自有子目标关闭未确认。',true);}).catch(error=>{failure??=error;controller.abort();});requests.add(work);void work.finally(()=>requests.delete(work));
      }
    });
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new DirectError('CAPTURE_CDP_UNAVAILABLE','站点浏览器连接超时。')),2000);socket!.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket!.addEventListener('error',()=>{clearTimeout(timer);reject(new DirectError('CAPTURE_CDP_UNAVAILABLE','站点浏览器连接失败。'));},{once:true});});
    const created=await send('Target.createTarget',{url:'about:blank',background:true});if(typeof created.targetId!=='string')throw new DirectError('CAPTURE_CDP_UNKNOWN','本次采集页身份未确认。',true);targetId=created.targetId;
    const attached=await send('Target.attachToTarget',{targetId,flatten:true});if(typeof attached.sessionId!=='string')throw new DirectError('CAPTURE_CDP_UNKNOWN','本次采集页连接未确认。',true);sessionId=attached.sessionId;
    await send('Page.enable',{},sessionId);await send('Runtime.enable',{},sessionId);await send('Network.enable',{},sessionId);
    await send('Network.setBypassServiceWorker',{bypass:true},sessionId);await send('Network.setCacheDisabled',{cacheDisabled:true},sessionId);
    await send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]},sessionId);
    // 不让新 Worker（后台脚本）越过本页请求拦截。
    await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true},sessionId);
    const navigation=await send('Page.navigate',{url:source.href},sessionId);if(navigation.errorText)throw new DirectError('CAPTURE_NAVIGATION_FAILED',`本站原始页面导航未完成（${String(navigation.errorText).slice(0,120)}）。`);
    await new Promise<void>((done,fail)=>{
      const finish=(error?:unknown)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);error?fail(error):done();};
      const abort=()=>finish(new DirectError('CAPTURE_STOPPED','本站页面等待已停止，自有资源继续按原身份收束。'));
      const timer=setTimeout(()=>finish(),8000);
      void loadedEvent.then(()=>finish());
      if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
    });
    signal.throwIfAborted();assertCurrent();
    const evaluation=await send('Runtime.evaluate',{expression:`(${script}\n)(${JSON.stringify(args)})`,awaitPromise:true,returnByValue:true},sessionId);
    if(evaluation.exceptionDetails||!object(evaluation.result)||!Object.hasOwn(evaluation.result,'value')){const detail=object(evaluation.exceptionDetails)&&object(evaluation.exceptionDetails.exception)&&typeof evaluation.exceptionDetails.exception.description==='string'?evaluation.exceptionDetails.exception.description.split('\n')[0].slice(0,180):'';throw new DirectError('CAPTURE_SCRIPT_FAILED',`固定站点脚本未返回可核对结果${detail?`（${detail}）`:''}${lastNetworkError?`；网络：${lastNetworkError.slice(0,160)}`:''}。`);}
    const page=await send('Runtime.evaluate',{expression:'({url:location.href,html:document.documentElement.outerHTML})',returnByValue:true},sessionId);
    if(page.exceptionDetails||!object(page.result)||!object(page.result.value)||typeof page.result.value.url!=='string'||typeof page.result.value.html!=='string')throw new DirectError('CAPTURE_DOM_INCOMPLETE','本站页面原件和最终来源无法完整核对。');
    if(Buffer.byteLength(page.result.value.html,'utf8')>ruleLimit(rule)||Buffer.byteLength(JSON.stringify(evaluation.result.value),'utf8')>ruleLimit(rule))throw new DirectError('CAPTURE_OUTPUT_LIMIT',`站点页面或结果超过${Math.round(ruleLimit(rule)/1048576)} MiB（兆字节）预算，未作为完整结果发布。`);
    const credentialForm=hasCredentialForm(page.result.value.html);if(credentialForm)rawComplete=false;
    result={sourceURL:source.href,finalURL:page.result.value.url,domHTML:credentialForm?'':page.result.value.html,result:evaluation.result.value,responses,
      observation:{ownedTargetClosed:true,connectionClosed:true,blockedRequests:blocked,loaded,scriptsExecuted:true,credentials:'site-profile',rawResponsesComplete:rawComplete}};
  } catch(error){failure??=error;}
  finally {
    closing=true;controller.abort();signal.removeEventListener('abort',stopped);clearTimeout(deadline);
    if(targetId&&socket?.readyState===WebSocket.OPEN){
      try{
        const closed=await send('Target.closeTarget',{targetId},undefined,true);
        // Chrome 在目标已不存在时可能返回 false 或空结果；目标确实消失即视为关闭完成。
        if(closed&&closed.success===false){
          const probe=await send('Target.getTargets',{},undefined,true);
          const stillThere=Array.isArray(probe?.targetInfos)&&probe.targetInfos.some(info=>object(info)&&info.targetId===targetId);
          if(stillThere)failure??=new DirectError('CAPTURE_TARGET_CLOSE_UNKNOWN','本次专属采集页关闭尚未确认，沿原任务核对，不自动重放。',true);
        }
      }catch(error){
        const message=error instanceof Error?error.message:String((error as {message?:unknown})?.message??'');
        if(!/no target|not found|already/i.test(message))failure??=new DirectError('CAPTURE_TARGET_CLOSE_UNKNOWN','本次专属采集页关闭尚未确认，沿原任务核对，不自动重放。',true);
      }
    }
    else if(targetId)failure??=new DirectError('CAPTURE_TARGET_CLOSE_UNKNOWN','原连接中断，本次采集页关闭尚未确认。',true);
    await Promise.allSettled([...requests]);
    for(const item of pending.values()){clearTimeout(item.timer);item.reject(new DirectError('CAPTURE_CDP_UNKNOWN','站点连接正在收束。',true));}pending.clear();
    if(socket&&socket.readyState!==WebSocket.CLOSED){const active=socket;const closed=await new Promise<boolean>(done=>{const timer=setTimeout(()=>done(false),2000);active.addEventListener('close',()=>{clearTimeout(timer);done(true);},{once:true});active.close();});if(!closed)failure=new DirectError('CAPTURE_CONNECTION_CLOSE_UNKNOWN','本站采集连接关闭尚未确认。',true);}
  }
  if(failure)throw failure;
  return result!;
}
