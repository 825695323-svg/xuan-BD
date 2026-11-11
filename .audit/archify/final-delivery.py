#!/usr/bin/env python3
import base64, gzip, hashlib, html, json, os, pathlib, re, shutil, subprocess, sys
from PIL import Image
repo=pathlib.Path(sys.argv[1]).resolve(); arch=pathlib.Path(sys.argv[2]).resolve(); out=pathlib.Path(sys.argv[3]).resolve()
cli=arch/'archify/bin/archify.mjs'; run=os.environ.get('GITHUB_RUN_ID','final')
env=os.environ.copy(); env['ARCHIFY_UPDATE_CHECK_DISABLED']='1'
chrome=shutil.which('google-chrome') or shutil.which('chromium')
if chrome: env['ARCHIFY_CHROME']=chrome
positions={
 '01-agents':{'input':(0,0),'core':(1,0),'backend':(2,0),'bridge':(2,1),'allow':(2,2),'task':(2,3),'execute':(1,3),'receipt':(0,3),'memory':(0,1)},
 '02-ingestion':{'input':(0,0),'route':(1,0),'source':(2,0),'fileref':(2,1),'material':(1,1),'convert':(0,1),'media':(1,2),'evidence':(0,2),'downstream':(0,3)},
 '06-artifact-lifecycle':{'source':(0,0),'manifest':(1,0),'archive':(2,0),'cloud':(2,1),'receipt':(1,1),'restore':(0,1),'inspect':(1,2),'prune':(2,2),'blocked':(0,2)},
 '07-governance':{'entry':(0,0),'bindings':(1,0),'services':(2,0),'versions':(2,1),'permissions':(2,2),'task':(1,2),'process':(0,2),'retention':(0,3),'state':(1,3)},
}
results=[]
for folder in sorted((out/'diagrams').iterdir()):
 if not folder.is_dir() or not (folder/'candidate.json').exists(): continue
 slug=folder.name; candidate=folder/'candidate.json'; spec=json.loads(candidate.read_text())
 for node in spec['components']:
  if node['id'] in positions.get(slug,{}):
   col,row=positions[slug][node['id']];node['pos']=[40+col*360,40+row*166]
 if slug=='06-artifact-lifecycle':
  # A source result does not invoke database cleanup. Keep the separate maintenance tool unconnected.
  spec['connections']=[e for e in spec['connections'] if e['id']!='source-to-prune']
  for card in spec.get('cards',[]):
   if card['title']=='恢复与清理边界' and not any('独立维护工具' in s for s in card['items']):
    card['items'].append('孤立候选回收是独立维护工具，不由来源任务自动触发。')
 candidate.write_text(json.dumps(spec,ensure_ascii=False,indent=2)+'\n')
 output=folder/(slug+'.html'); review=folder/('review-'+run)
 cmd=['node',str(cli),'finalize','architecture',str(candidate),str(output),'--repo-root',str(repo),'--quality','showcase','--out-dir',str(review),'--json']
 done=subprocess.run(cmd,cwd=folder,env=env,text=True,capture_output=True,timeout=180)
 (folder/'final-delivery.stdout.json').write_text(done.stdout);(folder/'final-delivery.stderr.log').write_text(done.stderr)
 try: receipt=json.loads(done.stdout)
 except Exception: receipt={'unparsed':done.stdout[:1500]}
 result={'slug':slug,'title':spec['meta']['title'],'exitCode':done.returncode,'gates':receipt.get('gates'),
         'artifact':receipt.get('artifact'),'diagnostics':receipt.get('diagnostics',[]),'recommendation':receipt.get('visualReviewRecommendation')}
 if done.returncode==0:
  captureDir=review/'captures'
  capture=subprocess.run(['node',str(cli),'visual-check',str(output),'--summary','--require-provenance','--out-dir',str(captureDir)],cwd=folder,env=env,text=True,capture_output=True,timeout=180)
  (folder/'capture-summary.json').write_text(capture.stdout);(folder/'capture.stderr.log').write_text(capture.stderr)
  result['captureExit']=capture.returncode
  for theme in ('light','dark'):
   images=list(captureDir.glob('*2048x1320.'+theme+'.png'))
   if images:
    png=out/'diagrams'/(slug+'.'+theme+'.png');shutil.copyfile(images[0],png)
    if slug=='00-overview' and theme=='light':
     img=Image.open(png).convert('RGB');img.thumbnail((1200,900))
     jpg=out/'diagrams'/'overview-preview.webp';img.save(jpg,format='WEBP',quality=78,method=6)
     encoded=base64.b64encode(jpg.read_bytes()).decode();chunk=12000
     parts=out/'evidence'/'preview-transfer';parts.mkdir(exist_ok=True)
     for i in range(0,len(encoded),chunk): (parts/f'part-{i//chunk:02d}.txt').write_text(encoded[i:i+chunk])
     (parts/'manifest.json').write_text(json.dumps({'file':'overview-preview.webp','bytes':jpg.stat().st_size,'sha256':hashlib.sha256(jpg.read_bytes()).hexdigest(),'parts':(len(encoded)+chunk-1)//chunk})+'\n')
 results.append(result)
(out/'evidence'/'final-diagram-status.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
review=pathlib.Path('.audit/archify/REVIEW.md').resolve()
if review.exists(): shutil.copyfile(review,out/'REVIEW.md')
report=(out/'REVIEW.md').read_text() if (out/'REVIEW.md').exists() else '审核报告尚未写入'
# Printable report page. The diagram renderer remains the actual Archify program.
body=[];in_table=False
for line in report.splitlines():
 if line.startswith('# '): body.append('<h1>'+html.escape(line[2:])+'</h1>')
 elif line.startswith('## '): body.append('<h2>'+html.escape(line[3:])+'</h2>')
 elif line.startswith('### '): body.append('<h3>'+html.escape(line[4:])+'</h3>')
 elif line.startswith('|'):
  if re.match(r'^\|[\s\-:|]+$',line):continue
  body.append('<p class="row">'+html.escape(line)+'</p>')
 elif line.strip(): body.append('<p>'+html.escape(line)+'</p>')
(out/'REVIEW.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Xuan BD 全仓审核报告</title><style>body{font:16px/1.8 system-ui,sans-serif;margin:40px auto;padding:0 24px;max-width:1080px;color:#172638;background:#f5f7fa}h1{line-height:1.3}h2{margin-top:40px;border-top:1px solid #cbd4df;padding-top:20px}.row{font:13px/1.8 monospace;white-space:pre-wrap}a{color:#1565a8}@media print{body{margin:0;max-width:none}}</style><a href="index.html">返回 Archify 图册</a>'+''.join(body)+'</html>')
index=out/'index.html';s=index.read_text()
s=s.replace('<h2>审核证据</h2>','<h2>审核报告与静态预览</h2><p><a href="REVIEW.html">完整审核报告</a> · <a href="REVIEW.md">Markdown 原文</a> · <a href="diagrams/00-overview.light.png">实际 Archify 总图 PNG</a></p><img src="diagrams/00-overview.light.png" alt="实际 Archify 输出的 Xuan BD 当前架构总图" style="width:100%;height:auto;border-radius:12px"><h2>审核证据</h2>')
index.write_text(s)
# Compact final state useful for connector reads.
print(json.dumps(results,ensure_ascii=False,indent=2))
