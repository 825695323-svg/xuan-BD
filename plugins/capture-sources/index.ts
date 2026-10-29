import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { root } from '@openclaw/fs-safe';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import type { SkillField } from '../../contracts/skill-contracts.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import type { TaskExecutionContext } from '../../platform/jobs/tasks.js';
import { inspectPath, samePathIdentity, type PermissionCapability } from '../../platform/security/permissions.js';
import { acquireAuthority, DirectError, DirectWorkspace, directoryCapability, prepareDestination } from '../../platform/runtime/file-workspace.js';
import { readBrowserBoundFile } from '../../platform/capabilities/browser/sites.js';
import { CAPTURE_SOURCES, CAPTURE_SOURCE_IDS, type CapturePageResult, type CaptureSessions, type CaptureSourceId, type CaptureStatus } from './contracts.js';
import { CAPTURE_SITE_RULES, captureSiteRule, captureSourceURL, normalizeCaptureArgs, readCaptureScript, type CaptureSiteRule } from './sites.js';
import { captureSitePage, type CaptureNetworkOptions } from './owned-capture.js';

export interface CaptureSourcePluginOptions {
  files: FileReferenceService; artifactRoot: string;
  /** 必须是已存在、普通文件动作不可读的独立证据根。每次只获本 task（任务）子目录权限。 */
  privateArtifactRoot: string;
  sessions?: CaptureSessions; unavailableReason?: string;
  /** 仅可信宿主注入隔离测试传输；不属于模型参数或用户安装配置。 */
  captureNetwork?: CaptureNetworkOptions;
}
const MAX=2*1024*1024;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const actionFor=(sourceId:CaptureSourceId)=>`capture.${sourceId}.read`;
export const CAPTURE_SOURCE_ACTIONS=CAPTURE_SOURCE_IDS.map(actionFor);

/** 宿主路径保护的窄例外：只覆盖本次采集生产者、本task（任务）固定命名的证据与暂存。 */
export function isCapturePrivateProducerPath(privateArtifactRoot:string,taskId:string,path:string):boolean {
  if(!/^[a-z0-9_-]{1,128}$/iu.test(taskId)||!isAbsolute(path)||resolve(path)!==path)return false;
  const taskRoot=join(privateArtifactRoot,taskId),tail=relative(taskRoot,path);
  if(tail==='')return true;
  if(isAbsolute(tail)||tail.startsWith('..'+sep)||tail==='..')return false;
  return /^capture-[a-f0-9-]{36}-(?:source\.json|dom\.html)$/u.test(tail)
    || /^\.direct-[a-f0-9-]{36}(?:[\\/](?:source\.json|dom\.html))?$/u.test(tail);
}

export function captureSourceIdForAction(action:string):CaptureSourceId|undefined {
  return CAPTURE_SOURCE_IDS.find(sourceId=>actionFor(sourceId)===action);
}
export function validateCaptureSourceArgs(action:string,args:Record<string,JsonValue>):{rule:CaptureSiteRule;args:Record<string,string>} {
  const sourceId=captureSourceIdForAction(action);if(!sourceId)throw new DirectError('CAPTURE_ACTION_INVALID','没有此站点采集动作。');
  const rule=captureSiteRule(sourceId,args.operation);return{rule,args:normalizeCaptureArgs(rule,args)};
}

/** 独立站点插件注册与执行；基础 browser.control（浏览器原始读取）不加载本模块或站点账号。 */
export function createCaptureSourcePlugin(options:CaptureSourcePluginOptions) {
  const available=(sourceId:CaptureSourceId)=>options.sessions?(options.sessions.availability?.(sourceId)??{available:true}):{available:false,reason:options.unavailableReason??'本站原采集会话尚未绑定；登录态控制已撤除，等待用户重新设定。'};
  const registrations:SkillRegistration[]=CAPTURE_SOURCE_IDS.map(sourceId=>{
    const rules=CAPTURE_SITE_RULES.filter(rule=>rule.sourceId===sourceId),parameters=new Map(rules.flatMap(rule=>Object.entries(rule.parameters)));
    const fields:SkillField[]=[{key:'operation',label:'站点读取操作',type:'select',required:true,options:rules.map(rule=>({value:rule.operation,label:rule.operation}))},
      ...[...parameters].map(([key,definition]):SkillField=>definition.kind==='integer'?{key,label:key,type:'number',minimum:definition.min,maximum:definition.max}
        :definition.kind==='enum'?{key,label:key,type:'select',options:definition.values!.map(value=>({value,label:value}))}:{key,label:key,type:'text',maxLength:4096})];
    return{action:actionFor(sourceId),runtimeId:'direct',kind:'direct',modelCalls:0,title:`${CAPTURE_SOURCES[sourceId].label}采集`,
      description:sourceId==='bilibili'?'按BV编号采集视频简介或一页评论，保留固定转录可用的视频页面引用；站点网页自用接口只作本站采集内部步骤。视频转录需另行调用固定转录能力。'
        :sourceId==='wechat'?'按明确公众号文章链接提取正文、图片原属性与链接定位；图片链接保留，识字需另行调用固定OCR（文字识别）。'
        :sourceId==='eastmoney'?'按6位代码读取东方财富股吧的帖子列表或单帖正文，保留标题、作者、时间、阅读与评论数；只取社区文本，不取行情与新闻。'
        :sourceId==='xueqiu'?'读取雪球热门讨论列表，或单条讨论正文与回复；本站需要有效登录态，风控或未登录时明确返回提示，不代读或转交任何凭据。'
        :'通过本站独立会话与固定脚本读取选定内容。部分脚本使用站点网页自用接口或页面运行状态；分页、预览截断与登录验证单独记录。',fields,
      permissionSummary:['本站账号目录独立，仅复用原已保存登录态或原公开模式；登录态控制待用户重新设定','不引导打开登录、确认保存、取消登录、改选仅公开或清除账号，也不自动恢复这些动作；遇登录页或验证码只说明受阻，不读取会话凭据','本地保存不证明站点仍认可登录；页面或列表成功不证明完整正文和附件已取得','只执行摘要核对的固定站点脚本及受限参数；逐请求核对网络来源和公网地址','完整原件仅放受保护的本任务证据区；正文结果按原文件权限发布','不执行清洗、自动纠错、入库或定时采集；未知关闭结果沿原任务核对'],
      available:()=>available(sourceId),validate:args=>{validateCaptureSourceArgs(actionFor(sourceId),args);}};
  });
  return{registrations,handles:(action:string)=>captureSourceIdForAction(action)!==undefined,
    async execute(context:TaskExecutionContext,action:string,input:Record<string,JsonValue>):Promise<TaskResult>{
      const {rule,args}=validateCaptureSourceArgs(action,input),source=captureSourceURL(rule,args);
      if(!options.sessions)throw new DirectError('CAPTURE_UNAVAILABLE',available(rule.sourceId).reason!);
      if(!/^[a-z0-9_-]{1,128}$/iu.test(context.task.id))throw new DirectError('CAPTURE_TASK_ID_INVALID','采集任务身份无法用于独立证据目录。');
      // 核脚本先于任何导航；模型不能通过上传代码替换固定执行来源。
      const script=await readCaptureScript(rule),secret:PermissionCapability={action:'secret',target:{kind:'secret',name:`capture-source.${rule.sourceId}.session`}};
      const authority=await acquireAuthority(context,`${action}.session`,{sourceId:rule.sourceId,operation:rule.operation},[secret]);
      const sessionEffectId=randomUUID();
      await context.emit({type:'side_effect_started',effectId:sessionEffectId,description:'取得并收束本站专属采集宿主',operation:{sourceId:rule.sourceId,operation:rule.operation}});
      let produced:TaskResult|undefined,published:TaskResult;
      try{published=await options.sessions.withCaptureSession(rule.sourceId,context,async(configuration,assertSession)=>{
        if(configuration.networkIsolation!=='intercept-only-proxy')throw new DirectError('CAPTURE_NETWORK_ISOLATION_REQUIRED','本站采集必须使用禁止浏览器直接联网的专属宿主，不能复用普通登录窗口。');
        authority.assert();assertSession();const binding=inspectPath(configuration.daemonConfigPath);
        let info:unknown;try{info=JSON.parse((await readBrowserBoundFile(configuration.daemonConfigPath,32_000)).toString('utf8'));}catch{throw new DirectError('CAPTURE_SESSION_UNAVAILABLE','本站原浏览器连接配置无法核对。');}
        if(!object(info)||!['127.0.0.1','::1'].includes(String(info.cdpHost))||!Number.isSafeInteger(info.cdpPort)||Number(info.cdpPort)<1||Number(info.cdpPort)>65535)throw new DirectError('CAPTURE_SESSION_INVALID','本站专用浏览器必须使用原受信本机连接。');
        const origins=new Map<string,Awaited<ReturnType<typeof acquireAuthority>>>();
        const authorizeOrigin=async(origin:string)=>{
          if(!origins.has(origin))origins.set(origin,await acquireAuthority(context,`${action}.request.${createHash('sha256').update(origin).digest('hex').slice(0,16)}`,{sourceId:rule.sourceId,operation:rule.operation,origin},[{action:'network',target:{kind:'network',origin}}]));
          origins.get(origin)!.assert();
        };
        await authorizeOrigin(`http://${info.cdpHost==='::1'?'[::1]':info.cdpHost}:${info.cdpPort}`);await authorizeOrigin(source.origin);
        const assertCurrent=()=>{authority.assert();assertSession();for(const permission of origins.values())permission.assert();if(!samePathIdentity(binding,inspectPath(configuration.daemonConfigPath),true))throw new DirectError('CAPTURE_SESSION_CHANGED','本站原连接身份变化，未切换到其他账号或端点。');};
        const effectId=randomUUID();await context.emit({type:'side_effect_started',effectId,description:'用本站独立会话执行固定只读采集',operation:{sourceId:rule.sourceId,operation:rule.operation,sourceURL:source.href,scriptSha256:rule.sha256,readOnly:true}});
        let capture:CapturePageResult;
        try{capture=await captureSitePage(context,{host:String(info.cdpHost),port:Number(info.cdpPort)},rule,source,args,script,assertCurrent,authorizeOrigin,options.captureNetwork);}
        catch(error){if(error instanceof DirectError&&error.unknown)await context.emit({type:'checkpoint',checkpoint:{sourceId:rule.sourceId,operation:rule.operation,captureState:'unknown',failureCode:error.code,complete:false}});
          else await context.emit({type:'side_effect_result',effectId,outcome:'failed',evidence:'本次采集页和自有网络资源已收束，采集未完整完成；不证明远端未收到读请求。'});throw error;}
        assertCurrent();await context.emit({type:'side_effect_result',effectId,outcome:'succeeded',evidence:'本次固定脚本返回与自有页面、网络和连接关闭均已核对；内容完整性另按结果记录。',data:{sourceId:rule.sourceId,scriptSha256:rule.sha256,sourceResponses:capture.responses.length,...capture.observation}});
        produced=await publishCapture(context,options,rule,args,capture);return produced;
      });}catch(error){
        if(error instanceof DirectError&&error.unknown){
          await context.emit({type:'checkpoint',checkpoint:{sourceId:rule.sourceId,captureState:'session-close-unknown',failureCode:error.code,complete:false}});
          if(produced)return produced;
        }else await context.emit({type:'side_effect_result',effectId:sessionEffectId,outcome:'failed',evidence:'本站会话调用返回明确失败或停止，未报告宿主资源收束未知；此回执不推断浏览器是否曾启动。'});
        throw error;
      }
      await context.emit({type:'side_effect_result',effectId:sessionEffectId,outcome:'succeeded',evidence:'本站专属采集宿主调用已返回，合同要求的启动与关闭收束均已确认。'});
      if(object(published.data)&&published.data.status==='login'&&options.sessions.markExpired){
        const expiryEffectId=randomUUID();await context.emit({type:'side_effect_started',effectId:expiryEffectId,description:'按本站原模式记录明确登录失效状态',operation:{sourceId:rule.sourceId,status:'login'}});
        try{await options.sessions.markExpired(rule.sourceId);}
        catch(error){await context.emit({type:'checkpoint',checkpoint:{sourceId:rule.sourceId,captureState:'session-state-update-unknown',failureCode:error instanceof DirectError?error.code:'CAPTURE_SESSION_STATE_WRITE_UNKNOWN',complete:false}});return published;}
        await context.emit({type:'side_effect_result',effectId:expiryEffectId,outcome:'succeeded',evidence:'站点状态持久调用已返回；仅原已保存模式记录过期，公开模式保持原身份。'});
      }
      return published;
    }};
}

export function captureResultStatus(rule:CaptureSiteRule,capture:CapturePageResult):{status:CaptureStatus;reasons:string[];scope:string} {
  const result=capture.result,reasons:string[]=[],text=object(result)?[result.error,result.code,result.hint].filter(value=>typeof value==='string'||typeof value==='number').join(' '):'';
  if(/captcha|验证码|安全验证|验证频繁|风控/iu.test(text))return{status:'captcha',reasons:['site-verification-required'],scope:'site-response'};
  if(/not logged in|login.required|登录|WECHAT_LOGIN_REQUIRED/iu.test(String(object(result)?result.error:''))||object(result)&&result.status===401)return{status:'login',reasons:['site-login-required'],scope:'site-response'};
  if(!object(result)||Object.hasOwn(result,'error'))return{status:'failed',reasons:['site-script-reported-failure'],scope:'fixed-site-operation'};
  if(!capture.observation.loaded)reasons.push('page-load-not-confirmed');
  if(!capture.observation.rawResponsesComplete)reasons.push('credential-forms-excluded-from-evidence');
  if(!capture.responses.length)reasons.push('original-source-response-missing');
  let scope='fixed-site-operation';
  if(rule.operation.includes('comments')){scope='selected-comment-page';reasons.push('selected-page-only');if(!Array.isArray(result.comments))reasons.push('comment-result-shape-unverified');}
  else if(rule.sourceId==='bilibili'&&rule.operation==='video-info'){scope='video-description';if(typeof result.description!=='string'||result.bvid!==new URL(capture.sourceURL).pathname.split('/')[2])reasons.push('video-description-shape-unverified');}
  else if(rule.sourceId==='bilibili'&&rule.operation==='trending'){scope='trending-keywords';if(!Array.isArray(result.items)||result.items.length===0)reasons.push('trending-shape-unverified');}
  else if(rule.sourceId==='bilibili'){scope='popular-video-ranking';if(!Array.isArray(result.items)||result.items.length===0)reasons.push('ranking-shape-unverified');}
  else if(rule.sourceId==='wechat'){scope='captured-article-dom';if(typeof result.bodyText!=='string'||!result.bodyText.trim()||!Array.isArray(result.images)||!Array.isArray(result.links))reasons.push('article-result-shape-unverified');}
  else if(rule.sourceId==='google'){scope='selected-search-results';reasons.push('legacy-script-snippet-preview');if(!Array.isArray(result.results))reasons.push('search-result-shape-unverified');}
  else if(rule.sourceId==='zhihu'&&rule.operation==='question'){scope='question-and-answer-previews';reasons.push('legacy-script-answer-preview-800');}
  else if(rule.sourceId==='zhihu'){scope='zhihu-hot-list';if(!Array.isArray(result.items)||result.items.length===0)reasons.push('hot-list-shape-unverified');}
  else if(rule.sourceId==='weibo'&&rule.operation==='hot'){scope='weibo-hot-search';if(!Array.isArray(result.items)||result.items.length===0)reasons.push('hot-search-shape-unverified');}
  else if(rule.sourceId==='xiaohongshu'){scope='selected-note';if(typeof result.note_id!=='string'||typeof result.desc!=='string')reasons.push('note-result-shape-unverified');}
  else if(rule.sourceId==='eastmoney'&&rule.operation==='guba-list'){scope='guba-post-list';if(!Array.isArray(result.posts))reasons.push('post-list-shape-unverified');}
  else if(rule.sourceId==='eastmoney'){scope='selected-post-body';if(typeof result.text!=='string'||!result.text.trim())reasons.push('post-body-shape-unverified');}
  else if(rule.sourceId==='xueqiu'&&rule.operation==='hot'){scope='hot-discussion-list';if(!Array.isArray(result.items))reasons.push('discussion-list-shape-unverified');}
  else if(rule.sourceId==='xueqiu'){scope='selected-discussion';if(typeof result.text!=='string'||!result.text.trim())reasons.push('discussion-shape-unverified');}
  return{status:reasons.length?'partial':'complete',reasons,scope};
}

// 模型与普通分享产物均只使用明确允许字段；原站点返回、原始链接和HTML（网页源码）在私有证据中保留。
const PUBLIC_KEYS=new Set(['sourceURL','finalURL','sourceUrl','apiSourceUrl','bvid','aid','title','description','author','name','author_id','author_headline','note_id','desc','type','url','images','links','attributes','src','data-src','data-original','data-backsrc','srcset','href','data-type','data-w','data-h','alt','locator','index','text','resolvedHref','resolvedSrc','bodyText','bodyLocator','publishedText','completenessScope','lazyImagesDownloaded','imageTextRecognized','page','total','count','sort','top_comments','comments','rpid','user','user_mid','user_level','content','like','reply_count','time','sub_replies','post_id','max_id','has_more','id','created_at','likes_count','screen_name','verified','reply_to','uid','likes','collects','shares','tags','created_time','last_update_time','ip_location','cursor','sub_comment_count','detail','excerpt','answer_count','follower_count','visit_count','comment_count','topics','answers_total','answers','rank','voteup_count','updated_time','query','results','snippet','error','code','status','hint',
  'items','posts','postId','abstract','read','reply','publishedAt','external','bar','authorId','createdAt','reposts','replies','commentsError',
  'view','danmaku','coin','favorite','share','category','duration','pubDate','keyword','showName','isHot','word','hotValue','rawHot','label','isNew','top','heat','trend','answerCount','followerCount']);
function redactText(value:string):string {
  return value.replace(/https?:\/\/[^\s"'<>\])]+/giu,raw=>{try{const url=new URL(raw);url.username='';url.password='';for(const key of [...url.searchParams.keys()])if(/token|password|secret|auth|cookie|api.?key|signature/iu.test(key))url.searchParams.delete(key);return url.href;}catch{return'[链接无法安全展示]';}})
    .replace(/\bBearer\s+\S+/giu,'Bearer [已隐藏]').replace(/((?:access[_-]?token|refresh[_-]?token|xsec[_-]?token|api[_-]?key|password|secret|cookie|authorization)\s*[:=]\s*)[^\s"'&,;]+/giu,'$1[已隐藏]');
}
function containsCredentialForm(value:unknown,depth=0):boolean {
  if(depth>24)return true;
  if(typeof value==='string')return /<input\b[^>]*(?:type\s*=\s*["']?password|name\s*=\s*["']?(?:password|passwd|pwd|otp|verification_code))\b/iu.test(value);
  return Array.isArray(value)?value.some(child=>containsCredentialForm(child,depth+1)):object(value)&&Object.values(value).some(child=>containsCredentialForm(child,depth+1));
}
export function projectCaptureResult(value:unknown,depth=0):JsonValue {
  if(depth>24)throw new DirectError('CAPTURE_RESULT_DEPTH','站点结果层级超过分享预算。');
  if(Array.isArray(value))return value.map(child=>projectCaptureResult(child,depth+1));
  if(object(value))return Object.fromEntries(Object.entries(value).filter(([key])=>PUBLIC_KEYS.has(key)).map(([key,child])=>[key,projectCaptureResult(child,depth+1)]));
  if(typeof value==='string')return redactText(value);
  return typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean'||value===null?value as JsonValue:null;
}

async function ensurePrivateTaskRoot(context:TaskExecutionContext,base:string):Promise<string> {
  const path=join(base,context.task.id),identity=inspectPath(base);
  if(identity.links.length||identity.object?.kind!=='directory')throw new DirectError('CAPTURE_PRIVATE_ROOT_INVALID','受保护的站点证据根未绑定普通目录。');
  const authority=await acquireAuthority(context,'capture.private-task-directory',{taskId:context.task.id},[directoryCapability('write',path)]);
  authority.assert();const existing=inspectPath(path,{allowMissing:true});
  if(existing.links.length||existing.exists&&existing.object?.kind!=='directory')throw new DirectError('CAPTURE_PRIVATE_ROOT_INVALID','本站证据的原任务子目录身份无效。');
  if(!existing.exists){const effectId=randomUUID();await context.emit({type:'side_effect_started',effectId,description:'建立本任务独立受保护证据目录',operation:{taskId:context.task.id}});
    const owner=await root(base,{mkdir:false,symlinks:'reject',mutationSymlinks:'reject',assertBeforeMutation:()=>{authority.assert();if(!samePathIdentity(identity,inspectPath(base)))throw new DirectError('CAPTURE_PRIVATE_ROOT_CHANGED','本站证据根身份变化。');}});await owner.mkdir(context.task.id,{private:true});
    await context.emit({type:'side_effect_result',effectId,outcome:'succeeded',evidence:'仅本任务子目录以独立新目录建立，未读取其他任务证据。'});}
  return path;
}

async function publishCapture(context:TaskExecutionContext,options:CaptureSourcePluginOptions,rule:CaptureSiteRule,args:Record<string,string>,capture:CapturePageResult):Promise<TaskResult> {
  const classification=captureResultStatus(rule,capture),publicResult=projectCaptureResult(capture.result),privateRoot=await ensurePrivateTaskRoot(context,options.privateArtifactRoot);
  const makeWorkspace=async(path:string)=>{const authority=await acquireAuthority(context,'capture.stage',{sourceId:rule.sourceId,operation:rule.operation,taskId:context.task.id},(['read','write','delete']as const).map(action=>directoryCapability(action,path)));const workspace=new DirectWorkspace(context,options.files,path,authority);await workspace.create();return workspace;};
  const privateWorkspace=await makeWorkspace(privateRoot),publicWorkspace=await makeWorkspace(options.artifactRoot),prefix=`capture-${randomUUID()}`;
  const publish=async(workspace:DirectWorkspace,name:string,value:string|Uint8Array,max=MAX)=>{if((typeof value==='string'?Buffer.byteLength(value,'utf8'):value.byteLength)>max)throw new DirectError('CAPTURE_EVIDENCE_LIMIT','完整采集原件超出预算，未发布截断结果。');const staged=typeof value==='string'?await workspace.createText(name,value):await workspace.createBytes(name,value);return workspace.publishFile(staged,prepareDestination(join(workspace.artifactRoot,`${prefix}-${name}`)),`capture.${rule.sourceId}.read`,{sourceId:rule.sourceId,operation:rule.operation,taskId:context.task.id},max);};
  try{
    // 原始响应按原字节编码保存，不存请求头、Cookie（会话凭据）或密码表单。
    const privateEvidence={schemaVersion:1,sourceId:rule.sourceId,operation:rule.operation,sourceURL:capture.sourceURL,finalURL:capture.finalURL,script:{name:rule.name,sha256:rule.sha256,readOnly:true,method:rule.method},
      responses:capture.responses.map(response=>({...response,bytes:Buffer.from(response.body,'base64').length,sha256:createHash('sha256').update(Buffer.from(response.body,'base64')).digest('hex')})),
      ...(containsCredentialForm(capture.result)?{originalScriptResultOmitted:'credential-form'}:{originalScriptResult:capture.result}),
      observation:capture.observation,classification,untrustedReference:true};
    const raw=await publish(privateWorkspace,'source.json',JSON.stringify(privateEvidence,null,2)+'\n',16*1024*1024),dom=capture.domHTML?await publish(privateWorkspace,'dom.html',capture.domHTML):undefined;
    const text=object(publicResult)&&typeof publicResult.bodyText==='string'?publicResult.bodyText:JSON.stringify(publicResult,null,2)+'\n';
    const resultFile=await publish(publicWorkspace,'result.json',JSON.stringify(publicResult,null,2)+'\n'),body=await publish(publicWorkspace,'body.txt',text);
    const mediaReference=rule.sourceId==='bilibili'?{kind:'public-video-page',url:`https://www.bilibili.com/video/${args.bvid}/`,bvid:args.bvid,transcriptionAction:'video.transcribe_url',transcribed:false}:undefined;
    const provenance={schemaVersion:1,sourceId:rule.sourceId,operation:rule.operation,sourceURL:redactText(capture.sourceURL),finalURL:redactText(capture.finalURL),scriptSha256:rule.sha256,method:rule.method,status:classification.status,complete:classification.status==='complete',completenessScope:classification.scope,reasons:classification.reasons,
      resultRef:resultFile.id,textRef:body.id,sourceEvidence:'protected-task-evidence',...(mediaReference?{mediaReference}:{}),transformation:rule.sourceId==='wechat'?'structural-extraction-only':'legacy-site-projection',modelCalls:0,readOnly:true,contentIsUntrustedReference:true};
    const locator=await publish(publicWorkspace,'source.json',JSON.stringify(provenance,null,2)+'\n');
    await privateWorkspace.cleanup();await publicWorkspace.cleanup();
    let preview:JsonValue=publicResult,previewTruncated=false;
    if(Buffer.byteLength(JSON.stringify(preview),'utf8')>24_000){previewTruncated=true;preview=object(publicResult)&&typeof publicResult.bodyText==='string'?{title:typeof publicResult.title==='string'?publicResult.title:'',bodyText:publicResult.bodyText.slice(0,6000)}:{text:JSON.stringify(publicResult).slice(0,6000)};}
    const modelPreview={...provenance,result:preview,previewTruncated};
    return{summary:classification.status==='complete'?'已按声明范围保存本站正文及来源定位。':classification.status==='login'?'本站返回登录提示，尚未取得目标内容。':classification.status==='captcha'?'本站要求验证码，尚未取得目标内容。':classification.status==='failed'?'已保存本站采集失败证据，未取得可用目标内容。':'已保存本站选定内容与来源定位，完整性限制已列明。',artifactIds:[resultFile.id,body.id,locator.id],data:{...provenance,privateEvidenceRefs:[raw.id,...(dom?[dom.id]:[])],modelPreview}};
  }catch(error){
    if(!(error instanceof DirectError&&error.unknown)){try{await privateWorkspace.cleanup();await publicWorkspace.cleanup();}catch{await privateWorkspace.recordRetained();await publicWorkspace.recordRetained();throw new DirectError('CAPTURE_STAGE_CLEANUP_UNKNOWN','本站证据暂存清理尚未确认。',true);}}
    await privateWorkspace.recordRetained();await publicWorkspace.recordRetained();throw error;
  }
}
