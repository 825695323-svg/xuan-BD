"""下载/展开防护的标准库测试；不联网、不安装、不修改运行根。"""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec=importlib.util.spec_from_file_location('bootstrap_resources',Path(__file__).with_name('bootstrap-resources.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class ResourceRecipeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
    def tearDown(self):
        self.temp.cleanup()
    def tar(self,entries):
        out=self.root/'input.tar'
        with tarfile.open(out,'w') as bundle:
            for name,kind,data in entries:
                item=tarfile.TarInfo(name)
                if kind=='file':item.size=len(data);item.mode=0o755;bundle.addfile(item,io.BytesIO(data))
                else:
                    item.type={'sym':tarfile.SYMTYPE,'hard':tarfile.LNKTYPE,'fifo':tarfile.FIFOTYPE}[kind]
                    if kind!='fifo':item.linkname=data
                    bundle.addfile(item)
        return out
    def test_locked_manifest_has_exact_recipe(self):
        lock=module.read_lock(module.ROOT/'config/resource-sources.lock.json')
        self.assertEqual(len(lock['artifacts']),23)
        self.assertEqual(lock['toolchain']['python'],'3.12.15')
    def test_normal_tar_and_executable_bit(self):
        archive=self.tar([('root/bin/tool','file',b'hello')]);module.extract(archive,self.root/'out',strip=1)
        self.assertEqual((self.root/'out/bin/tool').read_bytes(),b'hello')
        self.assertTrue((self.root/'out/bin/tool').stat().st_mode & stat.S_IXUSR)
    def test_relative_internal_symlink(self):
        archive=self.tar([('root/bin/tool','file',b'hello'),('root/bin/alias','sym','tool')])
        module.extract(archive,self.root/'out',strip=1)
        self.assertEqual((self.root/'out/bin/alias').read_bytes(),b'hello')
    def test_internal_hardlink_materialized(self):
        archive=self.tar([('root/file','file',b'x'),('root/copy','hard','root/file')])
        module.extract(archive,self.root/'out',strip=1)
        self.assertEqual((self.root/'out/copy').read_bytes(),b'x')
    def test_traversal_refused_before_writes(self):
        archive=self.tar([('root/safe','file',b'x'),('../escape','file',b'bad')])
        with self.assertRaises(ValueError):module.extract(archive,self.root/'out')
        self.assertFalse((self.root/'out/root/safe').exists())
    def test_escape_link_refused(self):
        archive=self.tar([('root/a','sym','../../escape')])
        with self.assertRaises(ValueError):module.extract(archive,self.root/'out',strip=1)
    def test_file_under_link_refused(self):
        archive=self.tar([('root/link','sym','dir'),('root/link/file','file',b'x')])
        with self.assertRaises(ValueError):module.extract(archive,self.root/'out',strip=1)
    def test_duplicate_and_special_refused(self):
        for i,entries in enumerate([[('a','file',b'x'),('a','file',b'y')],[('fifo','fifo',b'')]]):
            with self.assertRaises(ValueError):module.extract(self.tar(entries),self.root/('out'+str(i)))
    def test_zip_and_backslash_path(self):
        archive=self.root/'input.zip'
        with zipfile.ZipFile(archive,'w') as bundle:bundle.writestr('pkg/ok','x')
        module.extract(archive,self.root/'good',strip=1)
        self.assertEqual((self.root/'good/ok').read_text(),'x')
        with zipfile.ZipFile(archive,'w') as bundle:bundle.writestr('..\\bad','x')
        with self.assertRaises(ValueError):module.extract(archive,self.root/'bad')
    def test_existing_output_not_overwritten(self):
        archive=self.tar([('a','file',b'x')]);target=self.root/'old';target.mkdir();(target/'keep').write_text('original')
        with self.assertRaises(FileExistsError):module.extract(archive,target)
        self.assertEqual((target/'keep').read_text(),'original')
    def test_download_digest_length_and_no_clobber(self):
        class Response(io.BytesIO):url='https://nodejs.org/fixed'
        good={'id':'node','url':'https://nodejs.org/fixed','bytes':3,'sha256':hashlib.sha256(b'abc').hexdigest()}
        with patch.object(module.urllib.request,'urlopen',return_value=Response(b'abc')):
            module.download(good,self.root/'good')
        with patch.object(module.urllib.request,'urlopen',return_value=Response(b'abd')):
            with self.assertRaises(ValueError):module.download(good,self.root/'bad')
        with patch.object(module.urllib.request,'urlopen',return_value=Response(b'abcd')):
            with self.assertRaises(ValueError):module.download(good,self.root/'long')
        with patch.object(module.urllib.request,'urlopen',return_value=Response(b'abc')):
            with self.assertRaises(FileExistsError):module.download(good,self.root/'good')
    def test_manifest_rejects_filename_and_duplicate(self):
        original=json.loads((module.ROOT/'config/resource-sources.lock.json').read_text())
        for i,change in enumerate([lambda x:x['artifacts'][0].update(filename='../escape'),lambda x:x['artifacts'].append(x['artifacts'][0])]):
            data=json.loads(json.dumps(original));change(data);path=self.root/(str(i)+'.json');path.write_text(json.dumps(data))
            with self.assertRaises(ValueError):module.read_lock(path)

if __name__=='__main__':unittest.main()
