#!/usr/bin/env python3
"""显式下载固定资源到全新目录；只消费仓库锁，不查询最新版，不改机器绑定。"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 1024 ** 3
HOSTS = {'nodejs.org', 'github.com', 'storage.googleapis.com', 'huggingface.co', 'raw.githubusercontent.com'}

def fail(message):
    raise ValueError(message)

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()

def selected_platform():
    machine = platform.machine().lower()
    arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'amd64': 'x64', 'x86_64': 'x64'}.get(machine, machine)
    return {'Darwin': 'darwin', 'Windows': 'win32', 'Linux': 'linux'}.get(platform.system(), 'unsupported') + '-' + arch

def read_lock(path):
    lock = json.loads(path.read_text(encoding='utf-8'))
    if lock.get('version') != 1 or not isinstance(lock.get('artifacts'), list):
        fail('资源来源锁格式不符。')
    seen = set()
    for item in lock['artifacts']:
        key = (item['platform'], item['id'])
        url = urllib.parse.urlparse(item['url'])
        if key in seen or url.scheme != 'https' or url.hostname not in HOSTS or url.username or url.password:
            fail('来源锁有重复身份或未登记的下载来源。')
        seen.add(key)
        if not re.fullmatch(r'[A-Za-z0-9_.+-]+', item.get('filename', '')) or not re.fullmatch(r'[A-Za-z0-9_-]+', item['id']):
            fail('来源锁文件名或资源编号不安全。')
        if len(item['sha256']) != 64 or any(c not in '0123456789abcdef' for c in item['sha256']):
            fail('来源锁缺少完整SHA-256。')
        if type(item['bytes']) is not int or not 0 < item['bytes'] <= MAX_BYTES:
            fail('来源锁字节预算不符。')
    return lock

def download(item, destination):
    request = urllib.request.Request(item['url'], headers={'User-Agent': 'xuan-bd-resource-build/1'})
    count = 0
    with urllib.request.urlopen(request, timeout=180) as response, destination.open('xb') as stream:
        if urllib.parse.urlparse(response.url).scheme != 'https':
            fail('下载不能降级为明文传输。')
        while True:
            data = response.read(1024 * 1024)
            if not data:
                break
            count += len(data)
            if count > item['bytes']:
                fail('下载超过锁定长度：' + item['id'])
            stream.write(data)
    if count != item['bytes'] or digest(destination) != item['sha256']:
        fail('下载字节与已审核锁不一致：' + item['id'])

def member_path(name, strip):
    if not isinstance(name, str) or '\\' in name or ':' in name or '\0' in name:
        fail('压缩包路径不安全。')
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts:
        fail('压缩包路径越界。')
    parts = p.parts[strip:]
    return Path(*parts) if parts else None

def extract(archive, destination, strip=0):
    """先校验全部成员、再写普通文件，最后创建内部链接；不执行归档内容。"""
    destination.mkdir(parents=True, exist_ok=False)
    is_zip = zipfile.is_zipfile(archive)
    bundle = zipfile.ZipFile(archive) if is_zip else tarfile.open(archive, 'r:*')
    with bundle:
        members = bundle.infolist() if is_zip else bundle.getmembers()
        entries, seen, total = [], set(), 0
        for member in members:
            name = member.filename if is_zip else member.name
            relative = member_path(name, strip)
            if relative is None:
                continue
            mode = member.external_attr >> 16 if is_zip else member.mode
            directory = member.is_dir() if is_zip else member.isdir()
            symlink = stat.S_ISLNK(mode) if is_zip else member.issym()
            hardlink = False if is_zip else member.islnk()
            if not is_zip and not (directory or symlink or hardlink or member.isfile()):
                fail('拒绝设备、FIFO等特殊归档成员。')
            key = relative.as_posix()
            if key in seen:
                fail('归档成员重复。')
            seen.add(key)
            size = member.file_size if is_zip else member.size
            total += size
            if len(entries) >= 100000 or total > 4 * MAX_BYTES:
                fail('展开内容超过构建预算。')
            target = None
            if symlink or hardlink:
                target = bundle.read(member).decode('utf-8') if is_zip else member.linkname
                if '\\' in target or ':' in target or '\0' in target or PurePosixPath(target).is_absolute():
                    fail('归档链接不能指向绝对位置。')
                resolved = ((destination / relative).parent / target).resolve() if symlink else (destination / member_path(target, strip)).resolve()
                if not resolved.is_relative_to(destination.resolve()):
                    fail('归档链接越界。')
            entries.append((member, relative, mode, directory, symlink, hardlink, target))
        links = {relative for _, relative, _, _, symlink, hardlink, _ in entries if symlink or hardlink}
        if any(parent in links for _, relative, *_ in entries for parent in relative.parents):
            fail('拒绝把归档文件写到链接目录下面。')
        for member, relative, mode, directory, symlink, hardlink, target in entries:
            path = destination / relative
            if directory:
                path.mkdir(parents=True, exist_ok=True)
            elif not (symlink or hardlink):
                path.parent.mkdir(parents=True, exist_ok=True)
                source = bundle.open(member) if is_zip else bundle.extractfile(member)
                with source, path.open('xb') as out:
                    shutil.copyfileobj(source, out)
                path.chmod(0o755 if mode & 0o111 else 0o644)
        for _, relative, _, _, symlink, hardlink, target in entries:
            if not (symlink or hardlink):
                continue
            path = destination / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            if symlink:
                os.symlink(target, path)
            else:
                original = destination / member_path(target, strip)
                if not original.is_file() or original.is_symlink():
                    fail('硬链接原件必须已展开为普通文件。')
                shutil.copyfile(original, path)
        for path in destination.rglob('*'):
            if path.is_symlink() and not path.resolve().is_relative_to(destination.resolve()):
                fail('展开后链接离开包根。')

def run(command, **kwargs):
    subprocess.run([str(item) for item in command], check=True, **kwargs)

def file_entry(path, root):
    return {'path': path.relative_to(root).as_posix(), 'sha256': digest(path), 'bytes': path.stat().st_size}

def build(args):
    target = selected_platform()
    if target not in ('darwin-arm64', 'win32-x64', 'linux-x64') or args.profile == 'bundle' and target == 'linux-x64':
        fail('未登记此平台/构建组合；Linux只用于原生开发验证。')
    output = args.output.absolute()
    if not args.output.is_absolute() or output.parent.resolve() != output.parent or output.exists() or output.is_symlink():
        fail('输出必须是真实父目录下尚不存在的绝对路径；不会覆盖旧资源。')
    lock_path = ROOT / 'config/resource-sources.lock.json'
    lock = read_lock(lock_path)
    pins = json.loads((ROOT / 'config/local-web-toolchain.json').read_text())
    if any(lock['toolchain'][key] != pins[key] for key in ('node', 'npm', 'python')):
        fail('资源锁与应用工具链不一致。')
    if args.profile == 'bundle' and not (ROOT / 'node_modules/pdfjs-dist/package.json').is_file():
        fail('先用目标平台执行npm ci；不能签发缺少应用依赖的资源清单。')
    wanted = [item for item in lock['artifacts'] if item['platform'] in (target, 'shared')
              and (args.profile == 'bundle' or item['id'] in ('node', 'python'))]
    output.mkdir(mode=0o700)
    prefix = output / target if args.profile == 'bundle' else output
    prefix.mkdir(exist_ok=True)
    executables = {}
    with tempfile.TemporaryDirectory(prefix='bd-resource-build-', dir=output.parent) as temp:
        temporary = Path(temp)
        for item in wanted:
            archive = temporary / (item['id'] + '-' + item['filename'])
            download(item, archive)
            key = item['id']
            if key in ('node', 'python'):
                extract(archive, prefix / key, strip=1)
            elif key == 'chrome':
                extract(archive, prefix / 'chrome', strip=1)
                executables['browser_engine'] = prefix / 'chrome' / ('Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' if target == 'darwin-arm64' else 'chrome.exe')
            elif key == 'whisper':
                extract(archive, prefix / 'whisper')
                matches = list((prefix / 'whisper').rglob('whisper-cli.exe'))
                if len(matches) != 1:
                    fail('固定whisper包缺少唯一CLI（命令行）入口。')
                executables['whisper_cli'] = matches[0]
            elif key in ('whisper-source', 'cmake'):
                extract(archive, temporary / key, strip=1)
            else:
                if key == 'whisper-base':
                    path = output / 'models/ggml-base.bin'
                elif key in ('ffmpeg', 'ffprobe', 'yt-dlp'):
                    path = prefix / 'bin' / (key + ('.exe' if target == 'win32-x64' else ''))
                    executables[{'yt-dlp': 'yt_dlp'}.get(key, key)] = path
                else:
                    path = output / 'licenses' / (item['platform'] + '-' + key + '.txt')
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(archive, path)
                if key in ('ffmpeg', 'ffprobe', 'yt-dlp'):
                    path.chmod(0o755)
        node = prefix / 'node' / ('node.exe' if target == 'win32-x64' else 'bin/node')
        npm = prefix / 'node' / ('node_modules/npm/bin/npm-cli.js' if target == 'win32-x64' else 'lib/node_modules/npm/bin/npm-cli.js')
        python = prefix / 'python' / ('python.exe' if target == 'win32-x64' else 'bin/python3.12')
        for program, version in ((node, pins['node']), (python, pins['python'])):
            text = subprocess.check_output([str(program), '--version'], text=True).strip()
            if version not in text.split() and text != 'v' + version:
                fail('下载程序版本不符。')
        if subprocess.check_output([str(node), str(npm), '--version'], text=True).strip() != pins['npm']:
            fail('下载的npm版本不符。')
        if args.profile == 'bundle':
            if target == 'darwin-arm64':
                cmake = temporary / 'cmake/CMake.app/Contents/bin/cmake'
                source = temporary / 'whisper-source'
                build_dir = temporary / 'whisper-build'
                run([cmake, '-S', source, '-B', build_dir, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF',
                     '-DWHISPER_BUILD_TESTS=OFF', '-DGGML_METAL=OFF', '-DGGML_OPENMP=OFF'])
                run([cmake, '--build', build_dir, '--config', 'Release', '--target', 'whisper-cli', '-j', '2'])
                path = prefix / 'bin/whisper-cli'
                path.parent.mkdir(exist_ok=True)
                shutil.copy2(build_dir / 'bin/whisper-cli', path)
                executables['whisper_cli'] = path
            browser = output / 'browser'
            browser.mkdir()
            for name in ('package.json', 'package-lock.json'):
                shutil.copyfile(ROOT / 'resources/browser' / name, browser / name)
            env = {**os.environ, 'PATH': str(node.parent) + os.pathsep + os.environ.get('PATH', '')}
            run([node, npm, 'ci', '--prefix', browser, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], env=env)
            daemon = browser / 'node_modules/bb-browser/dist/daemon.js'
            if not daemon.is_file():
                fail('固定浏览器依赖缺少daemon.js（守护入口）。')
            executables['node'] = node
            paths = sorted(output.rglob('*'))
            files = [({'path': p.relative_to(output).as_posix(), 'kind': 'symlink', 'target': os.readlink(p)}
                      if p.is_symlink() else file_entry(p, output)) for p in paths if p.is_symlink() or p.is_file()]
            required = ['pdfjs-dist', '@napi-rs/canvas', 'iconv-lite', 'safer-buffer']
            required += ['@napi-rs/canvas-darwin-arm64'] if target == 'darwin-arm64' else [
                '@esbuild/win32-x64', '@openclaw/fs-safe-win32-x64-msvc', '@rolldown/binding-win32-x64-msvc',
                '@typescript/typescript-win32-x64', 'lightningcss-win32-x64-msvc', '@napi-rs/canvas-win32-x64-msvc']
            packages = []
            for name in required:
                package = ROOT / 'node_modules' / name
                if not (package / 'package.json').is_file():
                    fail('当前平台应用依赖缺失：' + name)
                package_files = sorted(p for p in package.rglob('*') if p.is_file())
                if any(p.is_symlink() for p in package_files):
                    fail('应用依赖不能通过外部链接冒充文件。')
                packages.append({'path': 'node_modules/' + name, 'platforms': [target], 'files': [file_entry(p, ROOT) for p in package_files]})
            manifest = {'schemaVersion': 1, 'platforms': {target: {'executables': {key: file_entry(path, output) for key, path in executables.items()}}},
                        'models': {'whisper_base': file_entry(output / 'models/ggml-base.bin', output)}, 'files': files,
                        'applicationDependencies': {'pathBase': 'application', 'packages': packages},
                        'recipe': {'resourceLockSha256': digest(lock_path), 'npmLockSha256': digest(ROOT / 'package-lock.json'),
                                   'browserLockSha256': digest(ROOT / 'resources/browser/package-lock.json'),
                                   'acceptance': 'built_not_production_accepted'}}
            (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        receipt = {'version': 1, 'profile': args.profile, 'platform': target, 'sourceLockSha256': digest(lock_path),
                   'node': str(node), 'npmCli': str(npm), 'python': str(python), 'toolchain': lock['toolchain']}
        (output / 'recipe-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(receipt))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=['toolchain', 'bundle'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    build(parser.parse_args())

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('RESOURCE_BUILD_FAILED: ' + str(error), file=sys.stderr)
        sys.exit(1)
