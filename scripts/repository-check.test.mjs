import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isOutputPath, sameDependencies, checkPythonLock, validateResourceLock } from './repository-check.mjs';

test('产物与配方分类不误杀锁文件、协议、图片和旧回归样本', () => {
  for (const path of ['node_modules/a/index.js','resources/bundled/manifest.json','staging/old.py','var/task.sqlite','config/connections.json','.env','x/__pycache__/a.pyc'])
    assert.equal(isOutputPath(path),true,path);
  for (const path of ['package-lock.json','resources/browser/package-lock.json','codegraph.json','config/connections.example.json','.env.example','wfd/product/legacy_samples/old_codec_example.parquet','wfd/product/protocol/schemas/test.json','apps/web/public/favicon.png'])
    assert.equal(isOutputPath(path),false,path);
});
test('根与浏览器依赖锁完整匹配，缺项或变版拒绝', () => {
  const pkg={name:'test',version:'1',dependencies:{a:'1.2.3'}}, lock={name:'test',version:'1',lockfileVersion:3,packages:{'':{dependencies:{a:'1.2.3'}}}};
  assert.equal(sameDependencies(pkg,lock),true);
  assert.equal(sameDependencies({...pkg,dependencies:{a:'1.2.4'}},lock),false);
  assert.equal(sameDependencies({...pkg,devDependencies:{b:'2'}},lock),false);
});
test('Python哈希锁拒绝浮动版本、遗漏依赖和无摘要输入', () => {
  const hash='a'.repeat(64);
  assert.equal(checkPythonLock('a==1\nb==2\n',`a==1 --hash=sha256:${hash}\nb==2 --hash=sha256:${hash}`),true);
  assert.equal(checkPythonLock('a==1\nb==2\n',`a==1 --hash=sha256:${hash}`),false);
  assert.equal(checkPythonLock('a==1','a==1'),false);
  assert.equal(checkPythonLock('a==1',`a>=1 --hash=sha256:${hash}`),false);
});
test('模型模板采用受信钥匙串引用，不携带旧DSH文件定位或明文密钥', () => {
  const model=JSON.parse(readFileSync(new URL('../config/model.example.json',import.meta.url)));
  assert.equal(model.credential.kind,'keychain');
  assert.equal(typeof model.credential.service,'string');
  assert.equal(typeof model.credential.account,'string');
  assert.equal('path' in model.credential,false);
  assert.equal('ref' in model.credential,false);
});
test('固定资源锁完整，摘要、动态版本和重复资源负例均拒绝', () => {
  const lock=JSON.parse(readFileSync(new URL('../config/resource-sources.lock.json',import.meta.url))), pins=JSON.parse(readFileSync(new URL('../config/local-web-toolchain.json',import.meta.url)));
  assert.deepEqual(validateResourceLock(lock,pins),[]);
  for (const mutate of [x=>x.artifacts.push(x.artifacts[0]), x=>x.artifacts[0].sha256='x', x=>x.artifacts[0].url='https://github.com/a/b/releases/latest/file', x=>x.artifacts[0].filename='../bad', x=>x.toolchain.node='latest']) {
    const broken=structuredClone(lock);mutate(broken);assert.ok(validateResourceLock(broken,pins).length);
  }
});
