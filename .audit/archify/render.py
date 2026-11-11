#!/usr/bin/env python3
"""Generate real Archify HTML; keep failed validation receipts instead of claiming success."""
import collections, csv, hashlib, html, json, os, pathlib, re, shutil, subprocess, sys, zipfile
repo=pathlib.Path(sys.argv[1]).resolve(); arch=pathlib.Path(sys.argv[2]).resolve(); out=pathlib.Path(sys.argv[3]).resolve()
cli=arch/'archify/bin/archify.mjs'; base=subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()
origin=subprocess.check_output(['git','-C',str(repo),'remote','get-url','origin'],text=True).strip()
texts={}; ev=out/'evidence'; ev.mkdir(exist_ok=True,parents=True)
def text(path):
    if path not in texts: texts[path]=(repo/path).read_text()
    return texts[path]
def src(path,needle=None,span=10):
    lines=text(path).splitlines()
    if needle:
        hits=[i for i,t in enumerate(lines) if needle in t]
        if not hits: raise ValueError('Source marker absent: '+path+' :: '+needle)
        at=hits[0]
    else: at=0
    return {'path':path,'line':max(1,at+1),'end_line':min(len(lines),at+span)}
def n(id,label,sub,col,row,path,needle=None,type='backend',tag=None,size=None):
    x={'id':id,'type':type,'label':label,'sublabel':sub,'pos':[40+col*360,40+row*166],
       'size':size or [230,72],'sources':[src(path,needle)]}
    if tag:x['tag']=tag
    return x
def e(a,b,label=None,variant=None):
    x={'id':a+'-to-'+b,'from':a,'to':b}
    if label:x['label']=label
    if variant:x['variant']=variant
    return x
def card(title,items,dot='slate'):return {'dot':dot,'title':title,'items':items}
def spec(slug,title,nodes,edges,cards):
    return {'slug':slug,'schema_version':1,'diagram_type':'architecture',
      'meta':{'title':title,'locale':'zh-CN','output':slug+'.html','quality_profile':'showcase',
              'repository':{'url':origin,'revision':base,'provider':'github'}},
      'components':nodes,'connections':edges,'cards':cards}
S=[]
S.append(spec('00-overview','Xuan BD 全项目架构 · 当前源码，不是理想方案',[
 n('ui','浏览器与命令入口','Web 前端 / 本机命令',0,0,'scripts/web.ts',type='frontend'),
 n('host','宿主与服务装配','个人会话 / BD 工作区',1,0,'apps/server/services.ts','export function createApplicationServices'),
 n('llm','会话与模型适配','PersonalCore / Pi 适配',2,0,'modules/agent/runtime/core.ts','export class'),
 n('tools','模型工具桥','MODEL_ACTIONS 允许表',2,1,'modules/agent/model-tools.ts','const MODEL_ACTIONS',tag='七个新动作未放行'),
 n('tasks','任务与授权执行','TaskService / PermissionService',1,1,'platform/jobs/tasks.ts','export class TaskService',type='security'),
 n('capture','来源接入与格式转换','接口 / 采集 / 文件 / 媒体',0,1,'apps/server/capabilities.ts','export function createDirectRuntime'),
 n('production','材料语义与五步加工','MaterialService / ProcessingPlan',0,2,'modules/collection/processing-plan.ts','export class'),
 n('r1','结构化交接与固定核对','R1Workspace / R1Handoff',1,2,'modules/collection/r1-workspace.ts','export class'),
 n('wfd','WFD 正式数据仓库','Python 产品接口 / 固定快照',2,2,'adapters/database/wfd-product-machine.ts','export class WfdProductMachineClient',type='database'),
 n('artifacts','产物归档与回收工具','archive / restore / release',0,3,'modules/collection/artifact-lifecycle.ts','export function createArtifactLifecycleActions',tag='注册存在，入口有断点'),
 n('cloud','百度网盘技能','bdpan / 远端元数据回执',1,3,'plugins/storage/baidu-drive.ts','export function createBaiduCustodyBackend',type='cloud'),
 n('output','读取、检索与固定计算','结果查询 / 派生再走 R1',2,3,'modules/collection/structured-retrieval.ts','export class'),
],[e('ui','host','本机请求'),e('host','llm','装配'),e('llm','tools','模型调用'),e('tools','tasks','允许后执行','security'),e('tasks','capture','工具路由'),e('capture','production','保管与转换'),e('production','r1','核验后交接'),e('r1','wfd','正式请求'),e('wfd','output','固定读取'),e('production','artifacts','已签发文件'),e('artifacts','cloud','授权后存证')],
 [card('当前审核结论',['图中连线表示源码调用或数据交接，不等于真实账号已验收。','新增七个 artifact 动作在运行时注册，但不在模型允许表。','主分支未修改；错误和重复项另见审核报告。'],'rose'),
  card('四条业务主线',['会话循环：输入、模型、工具、授权、结果与记忆。','数据生产：来源、保管、转换、五步加工、R1 与 WFD。','数据输出：固定读取、证据检索、前端结果及计算回写。','产物生命周期：清单、归档、恢复、引用核对与孤立回收。']),
  card('范围边界',['这里只画 xuan-BD 仓库，不把 Xuan 自主主体或 Harness 全系统规划冒充本仓实现。','SQLite 保存本地状态和索引；WFD 正式数据、定义及快照另有权威。','实际代码仍有 Pi 模型适配层；图按源码保留此名称。'])]))
S.append(spec('01-agents','线路一 · AGENTS 会话、工具与状态回路',[
 n('input','用户输入与附件','会话 / 分支 / 输入规则',0,0,'modules/agent/input-router.ts','export class',type='frontend'),
 n('core','会话状态机','PersonalCore 运行代次',1,0,'modules/agent/runtime/core.ts','export class'),
 n('backend','模型与上下文','PiBackend / 当前 API',2,0,'adapters/llm/pi.ts'),
 n('bridge','模型工具目录','CoreModelTools',2,1,'modules/agent/model-tools.ts','const MODEL_ACTIONS'),
 n('allow','动作允许与资料范围','允许表 / 分享票据',1,1,'modules/agent/model-tools.ts','const MODEL_ACTIONS',type='security',tag='新增归档动作缺失'),
 n('task','冻结任务与权限','TaskService / 预算 / 审批',0,1,'platform/jobs/tasks.ts','export class TaskService',type='security'),
 n('execute','确定性工具运行','DirectRuntime / 对应桥接',0,2,'apps/server/capabilities.ts','const execute = async'),
 n('receipt','结果与失败证据','回执 / 分页 / 完成事件',1,2,'modules/agent/model-tools.ts','readonly projectToolResult'),
 n('memory','长期记忆与上下文账本','MemoryService / ContextLedger',2,2,'modules/agent/memory.ts','export class'),
],[e('input','core'),e('core','backend'),e('backend','bridge','工具请求'),e('bridge','allow'),e('allow','task','获准动作','security'),e('task','execute'),e('execute','receipt'),e('receipt','memory'),e('memory','core','后续会话')],
 [card('入口断点',['artifact.manifest、archive、restore、inspect、release 和两个 candidates 动作均未进入 MODEL_ACTIONS。','不能把下层工具注册成功等同于模型可以发现和执行。'],'rose'),
  card('状态与权限',['停止、取消、恢复沿原任务身份与代次处理。','模型结果分享需要原会话和资料授权，不是任意文件读取权。','记忆回流表示已有上下文服务，不表示 Xuan 主体自主唤醒。'])]))
S.append(spec('02-ingestion','线路二 · 来源接入、材料保管与按格式转换',[
 n('input','链接、文件与来源选择','BD 会话或受控工作区入口',0,0,'modules/collection/conversation-materials.ts','export class',type='frontend'),
 n('route','来源设置与统一路由','供应商 / 端点 / 来源会话',1,0,'plugins/api-sources/runtime.ts','export function'),
 n('source','接口与站点采集','API 插件 / 独立浏览器会话',2,0,'plugins/capture-sources/index.ts','export function'),
 n('fileref','来源定位与文件身份','FileReferenceService',2,1,'platform/resources/files.ts','export class',type='database'),
 n('material','原件保管与预览','MaterialService / 原字节',1,1,'modules/collection/materials/service.ts','export class',type='database'),
 n('convert','通用文档转换','PDF / Office / 结构化文件',0,1,'platform/capabilities/conversion/index.ts','export function createConversionActions'),
 n('media','媒体转写与字幕','视频音轨为临时输入',0,2,'platform/capabilities/transcription/video.ts','export async function transcribeVideo'),
 n('evidence','已签发转换产物','正文 / 坐标 / 时间戳 / 来源',1,2,'modules/collection/segments/artifacts.ts','const SCHEMA_SQL',type='database'),
 n('downstream','加工、检索或归档','消费者按已有引用读取',2,2,'modules/collection/conversation-processing.ts','export class'),
],[e('input','route'),e('route','source'),e('source','fileref'),e('fileref','material'),e('material','convert'),e('material','media','音视频'),e('convert','evidence','文档证据'),e('media','evidence','转写证据'),e('evidence','downstream')],
 [card('条件能力，不是全部已上线',['material.ocr 是未接入的材料适配入口；image.ocr 是另外的模型图像识别工具。','视频需要 yt-dlp、音频工具和转写模型；未装配时明确不可用。','站点脚本按来源配置动态加载，静态无 import 不代表无用代码。'],'amber'),
  card('存储行为',['上传的文件本身是原件，不能仅保留文件名。','链接视频优先字幕；无字幕时下载音轨，但不发布长期音轨文件。','正式数据与原始证据身份分开，不能把来源链接当永久原件。'])]))
S.append(spec('03-production-r1','线路三 · 语义、五步加工、R1 与正式发布',[
 n('material','已保管材料','原值 / 来源 / 版本身份',0,0,'modules/collection/materials/service.ts','readOriginal',type='database'),
 n('semantics','六维语义与用途裁定','证据约束 / 未知项保留',1,0,'modules/collection/materials/semantic.ts','export class'),
 n('plan','冻结加工计划','逐输出路由与适用性',2,0,'modules/collection/processing-plan.ts','export class'),
 n('stages','按适用性执行五步','解析 / 清洗 / 标注 / 标准化 / 组织',2,1,'modules/collection/candidate-pipeline.ts'),
 n('candidate','候选对象与共享行块','CandidateService',1,1,'modules/collection/candidate-service.ts','export class',type='database'),
 n('r1','准备与正式交接','R1Workspace / R1Handoff',0,1,'modules/collection/r1-structured-handoff.ts','export class'),
 n('client','受控 Python 进程边界','WfdProductMachineClient',0,2,'adapters/database/wfd-product-machine.ts','export class'),
 n('wfd','WFD 准入、版本与发布','product_machine / product_service',1,2,'wfd/product/wfd_sdk/product_machine.py',type='database'),
 n('fixed','固定读回与逐行关联','Snapshot / record version',2,2,'modules/collection/r1-paged-readback.ts','export class'),
],[e('material','semantics'),e('semantics','plan'),e('plan','stages'),e('stages','candidate'),e('candidate','r1','结构与用途通过','security'),e('r1','client'),e('client','wfd','结构化请求'),e('wfd','fixed','固定记录'),e('fixed','r1','核对原请求')],
 [card('权威边界',['候选计算成功不等于正式数据准入。','WFD 决定合同、来源权限、版本与正式可见性；BD 保留来源和回执关联。','未知或已发送结果沿原身份查询，不能换号盲目重发。']),
  card('不能从规划补上线',['现有源码支持顺序材料批次与 R1 自动编排，但不据此声称完整历史模拟或训练系统已落地。','清洗与语义不适用时按明确规则处理，不擅自改写原值。'],'amber')]))
S.append(spec('04-read-retrieval','线路四 · WFD 固定读取、证据检索与输出',[
 n('caller','会话查询或工作区前端','明确查询条件',0,0,'apps/server/workspace-routes.ts',type='frontend'),
 n('api','读取与检索接口','HTTP 路由 / R1 读取桥',1,0,'apps/server/workspace-routes.ts','export function'),
 n('retrieval','结构化条件检索','StructuredRetrievalService',2,0,'modules/collection/structured-retrieval.ts','export class'),
 n('reader','固定快照读取器','R1ProductReader',2,1,'modules/collection/r1-product-reader.ts','export class'),
 n('wfd','WFD 产品与历史资格','快照内容 / 市场已知 / 系统已持有',2,2,'adapters/database/wfd-product-machine.ts','export class',type='database'),
 n('segments','正文分段与证据登记','SegmentService',0,1,'modules/collection/segments/service.ts','export class'),
 n('index','检索索引与来源位置','按证据编号追溯原产物',1,1,'modules/collection/segments/artifacts.ts','const SCHEMA_SQL',type='database'),
 n('response','有界结果与来源追溯','任务回执 / 页游标 / 证据',1,2,'modules/collection/structured-retrieval.ts','export class'),
 n('view','前端结果与后续工具','不重复归档正式 WFD 数据',0,2,'apps/server/workspace-routes.ts',type='frontend'),
],[e('caller','api'),e('api','retrieval'),e('retrieval','reader'),e('reader','wfd','指定快照'),e('segments','index','分段登记'),e('index','retrieval','证据候选'),e('retrieval','response','合并核验'),e('response','view')],
 [card('与上一张示意图的区别',['不画成所有读取必须先经过因子算法。查询与计算是两条不同请求线路。','正文索引和 WFD 记录不是同一存储；通过真实材料和记录关联接合。','对外完整产品导出不能由预留 API 名称推断为已经实现。']),
  card('尚缺现场证据',['读取能力受 Python 连接、快照与索引可用性约束。','全仓测试中检索能力断言仍有失败，详见原始测试日志。'],'amber')]))
S.append(spec('05-calculation','线路五 · 固定算法、Polars 与派生回写',[
 n('request','会话发起计算请求','算法目录与明确参数',1,0,'modules/financial/conversation-algorithms.ts','export class',type='frontend'),
 n('local','本地固定算法线路','LocalAlgorithmService',0,1,'modules/financial/algorithm-service.ts','export class'),
 n('polars','独立固定计算线路','PolarsFixedService',2,1,'modules/collection/polars-fixed-service.ts','export class'),
 n('snapshot','冻结 WFD 输入','快照 / 产品 / 来源记录',1,1,'modules/collection/fixed-calculation-service.ts','export class',type='database'),
 n('check','独立结构与数值核对','checkDerivedForWfd',0,2,'modules/financial/derived-wfd-check.ts','export function'),
 n('polarsresult','候选结果与用途证据','Polars 原请求与固定输入',2,2,'modules/collection/polars-fixed-service.ts','export class',type='database'),
 n('publish','派生发布适配','DerivedWfdPublisher',0,3,'modules/financial/derived-wfd-publisher.ts','export class'),
 n('r1','既有 R1 正式交接','不是独立直接写库',1,3,'modules/collection/r1-structured-handoff.ts','export class'),
 n('wfd','正式派生数据与读回','仍由 WFD 准入与版本控制',2,3,'adapters/database/wfd-product-machine.ts','export class',type='database'),
],[e('request','local','选择算法'),e('request','polars','选择固定计算'),e('snapshot','local','固定输入'),e('snapshot','polars','固定输入'),e('local','check'),e('check','publish','核验通过','security'),e('publish','r1'),e('polars','polarsresult'),e('polarsresult','r1','用途合格','security'),e('r1','wfd')],
 [card('需要分别核对的两条线',['本地金融插件与 Polars 固定计算不是同一入口，也不是两个都必须依次运行。','算法新结果仍经独立核对与 R1 交接，不能在图中画成绕过 WFD 准入。']),
  card('当前缺口',['旧批次均线与人工入口有契约限制；全仓测试仍有断言不一致。','Polars 和 Python 依赖在审查环境未装配，不把跳过测试计为运行通过。'],'amber')]))
S.append(spec('06-artifact-lifecycle','线路六 · 产物归档、恢复与回收：含已发现阻断',[
 n('source','成功来源任务','artifactIds 已签发文件',0,0,'modules/collection/artifact-manifest.ts','export function'),
 n('manifest','来源产物清单','artifact.manifest',1,0,'modules/collection/artifact-manifest.ts','export function'),
 n('archive','冻结目标并归档','artifact.archive',2,0,'modules/collection/artifact-archive.ts','export function'),
 n('cloud','百度网盘技能','名称 / 大小 / fs_id 核对',2,1,'plugins/storage/baidu-drive.ts','export function createBaiduCustodyBackend',type='cloud'),
 n('receipt','归档与释放账本','SQLite 冻结身份',1,1,'modules/collection/artifact-archive.ts','CREATE TABLE artifact_archive_receipts',type='database'),
 n('restore','明确恢复新文件','artifact.restore / SHA-256',0,1,'modules/collection/artifact-restore.ts','export function'),
 n('inspect','本地引用与释放检查','artifact.inspect / release',1,2,'modules/collection/artifact-lifecycle.ts','export function artifactReleaseBlockers',type='security',tag='SQL 字段不匹配'),
 n('prune','孤立候选对象清理','candidates.inspect / prune',2,2,'modules/collection/candidate-reclaim.ts','export function',type='database'),
 n('blocked','会话派发断点','七个新动作未入允许表',0,2,'modules/agent/model-tools.ts','const MODEL_ACTIONS',type='security',tag='模型不能直接调用'),
],[e('source','manifest'),e('manifest','archive','明确选件'),e('archive','cloud','授权后上传'),e('cloud','receipt','元数据确认'),e('receipt','restore','明确请求'),e('receipt','inspect','回收检查'),e('source','prune','数据库对象另查')],
 [card('审核发现，不是验收通过',['MODEL_ACTIONS 缺少全部七个新增动作，提示词中有名字不能代替工具接线。','release 守卫使用 segment_requests.binding_json 和 processing_plans.document_json；实际列名不同，真实宿主稳定阻断。','会话文件的 conversation 关系也被视为阻断；目前不能承诺会话产物自动释放。'],'rose'),
  card('恢复与清理边界',['归档不下载读回；只有明确恢复才验证完整 SHA-256。','恢复创建新的 fileRefId；旧引用不会自动迁移。','候选回收有独立维护授权，不能因为对象已经入 WFD 就删除仍被历史计划引用的证据。'])]))
S.append(spec('07-governance','线路七 · 启动装配、版本、权限与持久化',[
 n('entry','本机启动入口','scripts/web.ts / local-web',0,0,'scripts/web.ts',type='frontend'),
 n('bindings','资源与连接绑定','ResourceBindings / 配置',1,0,'platform/resources/bindings.ts','export class'),
 n('services','服务装配与能力注册','createApplicationServices',2,0,'apps/server/services.ts','export function createApplicationServices'),
 n('versions','依赖版本冻结','directDependencyVersions',2,1,'platform/plugins/direct-versions.ts','export function directDependencyVersions',type='security',tag='GNU / musl 选择错误'),
 n('permissions','操作授权与路径保护','PermissionService',1,1,'platform/security/permissions.ts','export class',type='security'),
 n('task','任务代次、预算与停止','TaskService',0,1,'platform/jobs/tasks.ts','export class TaskService'),
 n('process','受控进程与临时空间','ProcessRuntime / DirectWorkspace',0,2,'platform/runtime/file-workspace.ts','export class'),
 n('state','本地状态数据库','CoreDatabase / 事务',1,2,'platform/state/database.ts','export class',type='database'),
 n('retention','已释放暂存的定期回收','TemporaryRetention',2,2,'platform/resources/temporary-retention.ts','export class'),
],[e('entry','bindings'),e('bindings','services'),e('services','versions'),e('versions','permissions','版本有效','security'),e('permissions','task','获授权','security'),e('task','process'),e('task','state','状态回执'),e('process','retention','明确释放暂存'),e('retention','state','保留记录')],
 [card('基础设施不等于业务主动性',['定期暂存清理只处理已释放的临时空间，不替代业务归档或 Xuan 自主认知。','停止/授权/版本约束始终由宿主执行，模型不能自授权限。']),
  card('版本冻结缺口',['原生可选依赖只按 platform-arch 字串选择，Linux 下会同时要求 GNU 与 musl 制品。','新归档实现文件未列入 DirectImplementation 对应源码组，代码指纹覆盖不足。'],'rose')]))
# Build a precise follow-up review of static false positives and genuinely isolated files.
tracked=subprocess.check_output(['git','-C',str(repo),'ls-files'],text=True).splitlines()
alltext={p:(repo/p).read_text(errors='replace') for p in tracked if (repo/p).is_file() and (repo/p).suffix in ['.ts','.tsx','.js','.mjs','.py','.json','.md']}
isolated=json.loads((ev/'unreachable.json').read_text()); reviewed=[]
for p in isolated:
    stem=pathlib.Path(p).stem.replace('.d',''); basename=pathlib.Path(p).name
    mentions=[]
    for other,t in alltext.items():
        if other==p: continue
        for needle in [p,basename,stem]:
            if len(needle)>5 and needle in t:
                mentions.append({'path':other,'line':t[:t.index(needle)].count('\n')+1,'needle':needle});break
    if '/test-support' in p or '-test-support' in p or '/fixture.' in p or '/backends/demo.' in p: disposition='测试辅助，不能误删'
    elif p.endswith('.d.mts'):disposition='类型声明，非运行入口'
    elif p.startswith('plugins/capture-sources/') and p.endswith('.js'):disposition='来源脚本，按注册表动态执行'
    elif p.startswith('plugins/financial/local-compute/assets/'):disposition='金融 Python 子进程资源，非 TS import 图'
    elif p.startswith('wfd/product/'):disposition='WFD Python 进程与独立入口，非 TS import 图'
    elif p.startswith('staging/'):disposition='暂存双入口，配置兼容使其不能直接删除'
    else:disposition='人工复核的孤立候选'
    reviewed.append({'path':p,'classification':disposition,'textReferences':mentions[:12]})
(ev/'unreachable-reviewed.json').write_text(json.dumps(reviewed,ensure_ascii=False,indent=2)+'\n')
# Raw directory URLs are not missing imports; classify scanner output rather than hide it.
unresolved=json.loads((ev/'unresolved.json').read_text())
for u in unresolved:
    u['review']='目录或运行生成资源，不是缺失 import' if u['kind']=='resource' else '测试夹具内字符串，须人工检查上下文'
(ev/'unresolved-reviewed.json').write_text(json.dumps(unresolved,ensure_ascii=False,indent=2)+'\n')
# Preserve full source marker evidence for reproducible map review.
(ev/'diagram-source-ranges.json').write_text(json.dumps({x['slug']:[{'id':n['id'],'label':n['label'],'sources':n['sources']} for n in x['components']] for x in S},ensure_ascii=False,indent=2)+'\n')
results=[]
for item in S:
    slug=item.pop('slug'); folder=out/'diagrams'/slug;folder.mkdir(parents=True,exist_ok=True)
    candidate=folder/'candidate.json'; candidate.write_text(json.dumps(item,ensure_ascii=False,indent=2)+'\n')
    env=os.environ.copy();env['ARCHIFY_UPDATE_CHECK_DISABLED']='1'
    browser=shutil.which('google-chrome') or shutil.which('chromium') or shutil.which('chromium-browser')
    if browser: env['ARCHIFY_CHROME']=browser
    command=['node',str(cli),'finalize','architecture',str(candidate),str(folder/(slug+'.html')),'--repo-root',str(repo),'--quality','showcase','--json']
    try:
        done=subprocess.run(command,cwd=folder,env=env,text=True,capture_output=True,timeout=180)
        (folder/'finalize.stdout.json').write_text(done.stdout);(folder/'finalize.stderr.log').write_text(done.stderr)
        receipt=json.loads(done.stdout) if done.stdout.strip().startswith('{') else {'raw':done.stdout[:4000]}
        result={'slug':slug,'title':item['meta']['title'],'exitCode':done.returncode,'htmlExists':(folder/(slug+'.html')).exists(),'receipt':receipt}
        if done.returncode==0 and slug=='00-overview':
            capture=subprocess.run(['node',str(cli),'visual-check',str(folder/(slug+'.html')),'--summary','--require-provenance','--out-dir',str(folder/'visual')],cwd=folder,env=env,text=True,capture_output=True,timeout=180)
            (folder/'visual.stdout.json').write_text(capture.stdout);(folder/'visual.stderr.log').write_text(capture.stderr)
            result['captureExit']=capture.returncode
        results.append(result)
    except Exception as ex: results.append({'slug':slug,'title':item['meta']['title'],'error':str(ex),'exitCode':999})
(ev/'archify-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
# An honest navigation page, not a replacement renderer. Each linked diagram is actual Archify output.
links=''.join('<a class="tile" href="diagrams/'+r['slug']+'/'+r['slug']+'.html"><strong>'+html.escape(r['title'])+'</strong><span>'+('Archify 自动检查通过' if r.get('exitCode')==0 else '待修复：查看生成回执')+'</span></a>' for r in results)
modules=json.loads((ev/'modules.json').read_text());rows=''.join('<tr><td>'+html.escape(k)+'</td><td>'+str(v.get('files',0))+'</td><td>'+str(v.get('code',0))+'</td><td>'+str(v.get('test',0))+'</td></tr>' for k,v in modules.items())
index='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Xuan BD · Archify 源码审核图册</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:1180px;margin:36px auto;padding:0 22px;background:#0c1422;color:#dce6f5}h1{font-size:34px;line-height:1.2}h2{margin-top:40px}a{color:#9ed3ff}.note{padding:18px 22px;border:1px solid #e0a153;background:#33271c;border-radius:12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin:24px 0}.tile{display:block;text-decoration:none;border:1px solid #334963;padding:18px;border-radius:12px;background:#131f31}.tile strong{display:block}.tile span{font-size:13px;color:#a5b7cc}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid #334963;text-align:left;padding:8px}code{color:#aed7ff}footer{margin-top:44px;color:#a8bad0}</style><h1>Xuan BD 当前源码<br>Archify 架构图与接线审核</h1><p>基线 <code>'''+base+'''</code> · 四条业务主线，七条内部线路 · 真正使用 Archify 渲染</p><div class="note"><strong>审核尚不能判定“全部接通、没有冗余”。</strong><br>已经确认模型允许表遗漏、释放守卫字段不匹配及原生依赖选择问题。图中按当前实现保留断点；未修改主分支业务代码。</div><div class="grid">'''+links+'''</div><h2>审核证据</h2><p><a href="evidence/summary.json">全仓扫描统计</a> · <a href="evidence/runtime-wiring-probes.json">真实宿主探针</a> · <a href="evidence/test-summary.txt">全仓测试结果</a> · <a href="evidence/inventory.csv">逐文件清单</a> · <a href="evidence/archify-results.json">Archify 生成回执</a></p><p>静态扫描覆盖全部跟踪代码。人工复核覆盖入口、关键运行链和被标记模块；未做生产账号与正式数据集全量联调。静态不可达不自动等于死代码。</p><h2>全部目录模块清点</h2><table><tr><th>目录模块</th><th>文件</th><th>实现文件</th><th>测试文件</th></tr>'''+rows+'''</table><footer>本页是图册导航。每张交互图由下载的 Archify 项目生成，源码引用固定到同一提交。图中箭头表示已观察到的调用或数据交接，不代表所有路径都经过真实环境验收。</footer></html>'''
(out/'index.html').write_text(index)
print(json.dumps([{'slug':r['slug'],'exitCode':r.get('exitCode'),'htmlExists':r.get('htmlExists'),'error':r.get('error')} for r in results],ensure_ascii=False))
