#!/usr/bin/env python3
"""Read-only source inventory. Static reachability is not runtime coverage."""
import ast, collections, csv, hashlib, json, pathlib, re, subprocess, sys
root = pathlib.Path(sys.argv[1]).resolve()
out = pathlib.Path(sys.argv[2]).resolve(); out.mkdir(parents=True, exist_ok=True)
def git(*args): return subprocess.check_output(['git','-C',str(root),*args], text=True).strip()
tracked = git('ls-files').splitlines()
code_ext = {'.ts','.tsx','.js','.jsx','.mjs','.mts','.cjs','.py'}
texts = {}; inventory=[]
for name in tracked:
    p=root/name
    if not p.is_file(): continue
    b=p.read_bytes(); ext=p.suffix
    text=b.decode('utf-8', errors='replace')
    if ext in code_ext: texts[name]=text
    role=('test' if '.test.' in name or name.startswith('test/') or '/tests/' in name else
          'configuration' if name.startswith(('config/','.github/')) or name in ['package.json','tsconfig.json'] else
          'documentation' if ext in {'.md','.txt','.rst'} else 'code' if ext in code_ext else 'resource')
    module='/'.join(name.split('/')[:2]) if '/' in name else '(root)'
    inventory.append({'path':name,'role':role,'module':module,'bytes':len(b),'lines':len(text.splitlines()),'sha256':hashlib.sha256(b).hexdigest()})
roles={x['path']:x['role'] for x in inventory}; allpaths={x['path'] for x in inventory}
def norm(p):
    import posixpath
    return posixpath.normpath(p)
def resolve_js(src,spec):
    if not spec.startswith('.'): return None
    p=norm(str(pathlib.PurePosixPath(src).parent/spec))
    options=[p]
    if p.endswith('.js'): options += [p[:-3]+'.ts',p[:-3]+'.tsx']
    if p.endswith('.mjs'): options += [p[:-4]+'.mts']
    options += [p+e for e in ['.ts','.tsx','.js','.mjs','.json']]
    options += [p+'/index'+e for e in ['.ts','.tsx','.js','.mjs']]
    return next((x for x in options if x in allpaths),None)
patterns=[('import',re.compile(r'\b(?:import|export)\s+(?:type\s+)?(?:[^;\n]*?\s+from\s*)?[\'\"]([^\'\"]+)[\'\"]')),
          ('dynamic',re.compile(r'\b(?:import|require)\s*\(\s*[\'\"]([^\'\"]+)[\'\"]\s*\)')),
          ('resource',re.compile(r'new\s+URL\(\s*[\'\"]([^\'\"]+)[\'\"]\s*,\s*import\.meta\.url'))]
edges=[]; unresolved=[]; external=collections.Counter(); symbols=[]; markers=[]
for name,text in texts.items():
    if pathlib.Path(name).suffix!='.py':
        # Collapse multiline import clauses while retaining their original match offsets.
        import_re=re.compile(r'\b(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|[\w$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s*[\'\"]([^\'\"]+)[\'\"]', re.S)
        candidates=[('import',m) for m in import_re.finditer(text)]
        for kind,pat in patterns: candidates += [(kind,m) for m in pat.finditer(text)]
        seen=set()
        for kind,m in candidates:
            spec=m.group(1); line=text.count('\n',0,m.start())+1
            key=(spec,line,kind)
            if key in seen: continue
            seen.add(key)
            if spec.startswith('.'):
                target=resolve_js(name,spec)
                rec={'from':name,'to':target,'specifier':spec,'line':line,'kind':kind}
                (edges if target else unresolved).append(rec)
            elif kind!='resource' and not spec.startswith('node:'): external[spec]+=1
        for m in re.finditer(r'\bexport\s+(?:async\s+)?(?:class|function|const|interface|type|enum)\s+([A-Za-z_$][\w$]*)',text):
            symbols.append({'path':name,'name':m.group(1),'line':text.count('\n',0,m.start())+1})
    else:
        try:
            tree=ast.parse(text,filename=name)
            for node in ast.walk(tree):
                if isinstance(node,(ast.Import,ast.ImportFrom)):
                    names=[node.module or ''] if isinstance(node,ast.ImportFrom) else [a.name for a in node.names]
                    for mod in names:
                        bases=[str(pathlib.PurePosixPath(name).parent), 'wfd/product', '.']
                        candidates=[]
                        for base in bases:
                            if isinstance(node,ast.ImportFrom) and node.level:
                                prefix=str(pathlib.PurePosixPath(name).parent)
                                for _ in range(node.level-1): prefix=str(pathlib.PurePosixPath(prefix).parent)
                                candidates += [norm(prefix+'/'+mod.replace('.','/')+e) for e in ['.py','/__init__.py']]
                            else: candidates += [norm(base+'/'+mod.replace('.','/')+e) for e in ['.py','/__init__.py']]
                        target=next((p for p in candidates if p in allpaths),None)
                        if target: edges.append({'from':name,'to':target,'specifier':mod,'line':node.lineno,'kind':'python-import'})
                elif isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)):
                    symbols.append({'path':name,'name':node.name,'line':node.lineno})
        except SyntaxError as e: markers.append({'path':name,'line':e.lineno,'text':'PYTHON_SYNTAX: '+str(e)})
    if roles.get(name)=='code':
        for i,line in enumerate(text.splitlines(),1):
            if re.search(r'TODO|FIXME|NOT_IMPLEMENTED|notImplemented|未实现|预留接口|尚未接入|MANUAL_ONLY|SERVICE_ROUTE_UNAVAILABLE',line):
                markers.append({'path':name,'line':i,'text':line.strip()[:240]})
# De-duplicate edge tuples and classify graph scope.
unique={(e['from'],e['to'],e['kind'],e['line']):e for e in edges}; edges=list(unique.values())
incoming=collections.defaultdict(set); graph=collections.defaultdict(set)
for e in edges:
    graph[e['from']].add(e['to']); incoming[e['to']].add(e['from'])
entrypoints=[p for p in texts if roles.get(p)=='code' and
             (p.startswith('scripts/') or p in ['apps/web/src/main.tsx','apps/server/app.ts','vite.config.ts'] or
              p.endswith('/__main__.py'))]
reachable=set(); stack=list(entrypoints)
while stack:
    p=stack.pop()
    if p in reachable: continue
    reachable.add(p); stack.extend(graph.get(p,()))
orphans=[p for p in texts if roles.get(p)=='code' and p not in reachable]
exact=collections.defaultdict(list)
for x in inventory:
    if x['role']=='code' and x['bytes']>100: exact[x['sha256']].append(x['path'])
exact=[v for v in exact.values() if len(v)>1]
# 12 substantive-line clone windows; imports, braces and comments excluded.
windows=collections.defaultdict(list)
for name,text in texts.items():
    if roles.get(name)!='code': continue
    significant=[]
    for line_no,line in enumerate(text.splitlines(),1):
        s=re.sub(r'\s+',' ',line.strip())
        if len(s)<12 or s.startswith(('import ','from ','//','/*','*','export type','export interface','#')): continue
        significant.append((line_no,s))
    for k in range(len(significant)-11):
        piece=significant[k:k+12]; h=hashlib.sha256('\n'.join(x[1] for x in piece).encode()).hexdigest()
        windows[h].append({'path':name,'start':piece[0][0],'end':piece[-1][0]})
clones=[]; covered=set()
for vals in windows.values():
    if len({v['path'] for v in vals})<2: continue
    key=tuple(sorted({v['path'] for v in vals}))
    if key in covered: continue
    covered.add(key); clones.append(vals[:8])
# Route/skill descriptors and static call declarations are evidence, not proof of availability.
routes=[]; actions=[]; wiring=[]
for name,text in texts.items():
    if roles.get(name)!='code': continue
    for i,line in enumerate(text.splitlines(),1):
        m=re.search(r'\b(?:router|app)\.(get|post|put|patch|delete|use)\s*\(\s*([\'\"])(.*?)\2',line)
        if m: routes.append({'path':name,'line':i,'method':m.group(1),'route':m.group(3)})
        for m in re.finditer(r'\baction\s*:\s*[\'\"]([a-z][a-z0-9._-]+)[\'\"]',line):
            actions.append({'path':name,'line':i,'action':m.group(1)})
        if re.search(r'\.register\(|bindVersions\(|\.handles\(|create\w+Actions\(|runtimes\.register\(',line):
            wiring.append({'path':name,'line':i,'text':line.strip()[:240]})
module_stats=collections.defaultdict(lambda:collections.Counter())
for x in inventory:
    s=module_stats[x['module']]; s['files']+=1; s[x['role']]+=1; s['lines']+=x['lines']
for x in inventory:
    x['incoming_static_files']=len(incoming[x['path']]); x['entrypoint_reachable']=x['path'] in reachable
    x['static_review']='included' if x['path'] in texts else 'inventory-only'
summary={'revision':git('rev-parse','HEAD'),'origin':git('remote','get-url','origin'),'tracked_files':len(inventory),
 'code_and_test_files':len(texts),'production_code_files':sum(x['role']=='code' for x in inventory),
 'test_files':sum(x['role']=='test' for x in inventory),'production_code_lines':sum(x['lines'] for x in inventory if x['role']=='code'),
 'static_edges':len(edges),'unresolved_relative_references':len(unresolved),'entrypoint_count':len(entrypoints),
 'static_unreachable_count':len(orphans),'exact_duplicate_groups':len(exact),'clone_window_groups':len(clones),
 'http_route_declarations':len(routes),'literal_action_declarations':len(actions),
 'limitations':['Static graph omits computed imports and cross-language process invocation; unreachable is a review candidate, not proof of dead code.',
 '12-line clone windows show exact repetition after whitespace normalization, not necessarily unnecessary duplication.',
 'All tracked code files scanned; manual behavior review focuses on runtime entrypoints, critical paths and flagged modules.']}
outputs={'summary.json':summary,'inventory.json':inventory,'dependencies.json':edges,'unresolved.json':unresolved,
 'unreachable.json':orphans,'exact-duplicates.json':exact,'clone-candidates.json':clones,
 'entrypoints.json':entrypoints,'modules.json':{k:dict(v) for k,v in sorted(module_stats.items())},
 'routes.json':routes,'actions.json':actions,'wiring.json':wiring,'markers.json':markers,'symbols.json':symbols}
for name,data in outputs.items(): (out/name).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
with (out/'inventory.csv').open('w',newline='',encoding='utf-8-sig') as f:
    writer=csv.DictWriter(f,fieldnames=list(inventory[0])); writer.writeheader(); writer.writerows(inventory)
print(json.dumps(summary,ensure_ascii=False,indent=2))
