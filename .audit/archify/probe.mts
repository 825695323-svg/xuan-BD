import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFullChainFixture, openFullChainHost } from './apps/server/full-chain-test-support.ts';
import { artifactReleaseBlockers } from './modules/collection/artifact-lifecycle.ts';
const output=process.env.AUDIT_OUT!;
const modelText=readFileSync('modules/agent/model-tools.ts','utf8');
const modelBlock=/const MODEL_ACTIONS = new Set\(\[([\s\S]*?)\]\);/.exec(modelText)?.[1] ?? '';
const modelActions=new Set([...modelBlock.matchAll(/'([a-z][a-z0-9._-]+)'/g)].map(x=>x[1]));
const wanted=['artifact.manifest','artifact.archive','artifact.restore','artifact.inspect','artifact.release','artifact.candidates.inspect','artifact.candidates.prune'];
const snippets:any[]=[];
for(const path of ['modules/agent/model-tools.ts','apps/server/capabilities.ts','apps/server/services.ts','platform/plugins/direct-versions.ts','modules/collection/processing-plan.ts','modules/collection/segments/service.ts','platform/resources/files.ts','platform/resources/bindings.ts','modules/collection/artifact-lifecycle.ts','modules/collection/artifact-restore.ts','modules/collection/candidate-reclaim.ts']) {
 const lines=readFileSync(path,'utf8').split('\n');
 for(let i=0;i<lines.length;i++) if(/MODEL_ACTIONS|AUTOMATIC_ACTIONS|optionalDependencies|reference\.resource|kind === 'conversation'|CREATE TABLE processing_plans|CREATE TABLE processing_plan_steps|CREATE TABLE processing_plan_outputs|CREATE TABLE.*segment_requests|artifactLifecycle|artifactManifest|candidateReclaim|artifactRestore|processing_plans.*condition|\.bin'|bd-candidate-storage-maintenance/.test(lines[i]))
  snippets.push({path,line:i+1,lines:lines.slice(Math.max(0,i-3),Math.min(lines.length,i+9)).map((t,n)=>`${Math.max(0,i-3)+n+1}: ${t}`).join('\n')});
}
const report:any={wanted,missingFromModelAllowlist:wanted.filter(a=>!modelActions.has(a)),modelAllowlistEvidence:'modules/agent/model-tools.ts',probes:[]};
const parent=mkdtempSync(join(tmpdir(),'xuan-audit-real-host-'));process.env.XUAN_FULL_CHAIN_ROOT=parent;
let host:any;
try {
 const fixture=createFullChainFixture({name:'wiring-audit'});
 host=await openFullChainHost(fixture);
 const registry=host.services.direct.registry;
 report.registry=registry.list().map((x:any)=>({action:x.action,runtimeId:x.runtimeId,available:x.availability.available,reason:x.availability.reason??null}));
 report.artifactRegistration=wanted.map(action=>{try{const x=registry.get(action);return{action,registered:true,available:x.availability.available,modelAllowed:modelActions.has(action)}}catch(e:any){return{action,registered:false,error:e.message}}});
 for(const action of ['artifact.manifest','artifact.candidates.inspect','data.processing.capabilities','conversion.document']) {
  try {const versions=registry.captureVersions(action,action==='artifact.manifest'?{sourceTaskId:'audit-source'}:{});report.probes.push({name:'captureVersions',action,ok:true,versions});}
  catch(e:any){report.probes.push({name:'captureVersions',action,ok:false,code:e.code,message:e.message});}
 }
 const path=join(host.services.artifactRoot,'audit-generated.txt');writeFileSync(path,'isolated generated evidence\n');
 const ref=host.services.files.register({path,source:'generated',taskId:'audit-source'});
 report.generatedReference={id:ref.id,resource:ref.resource??null,path:ref.invocationPath,relations:ref.relations};
 report.releaseBlockersWithoutConversation=artifactReleaseBlockers(host.database,host.services.files,'audit-source',ref,host.services.artifactRoot);
 host.services.files.link(ref.id,{conversationId:'audit-conversation'});
 report.releaseBlockersWithConversation=artifactReleaseBlockers(host.database,host.services.files,'audit-source',host.services.files.getRef(ref.id),host.services.artifactRoot);
 for(const table of ['processing_plans','processing_plan_steps','processing_plan_outputs','segment_requests','conversion_artifacts','material_objects'])
  (report.actualSchema??={})[table]=host.database.connection.prepare(`PRAGMA table_info(${table})`).all().map((x:any)=>x.name);
} catch(e:any){report.hostError={code:e.code??null,message:e.message,stack:e.stack};}
finally {if(host)await host.close();}
writeFileSync(join(output,'runtime-wiring-probes.json'),JSON.stringify(report,null,2)+'\n');
writeFileSync(join(output,'review-source-snippets.json'),JSON.stringify(snippets,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
