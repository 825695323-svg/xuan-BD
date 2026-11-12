#!/usr/bin/env python3
"""维护命令：把明确版本的上游制品固化为配方。不会安装、执行或采用资源。"""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
NODE = '24.22.1'
PYTHON = '3.12.15'
PBS = '20261013'
CHROME = '157.0.8103.78'
WHISPER = 'v1.9.1'
FFMPEG = 'b6.1.1'
YTDLP = '2026.10.26'
CMAKE = 'v4.1.2'
PLATFORMS = {
    'darwin-arm64': ('darwin-arm64.tar.gz', 'aarch64-apple-darwin'),
    'win32-x64': ('win-x64.zip', 'x86_64-pc-windows-msvc'),
    'linux-x64': ('linux-x64.tar.xz', 'x86_64-unknown-linux-gnu'),
}

def request(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'xuan-bd-build-inputs/1'}), timeout=180)

def read_json(url):
    with request(url) as response:
        return json.load(response)

def release(repo, tag):
    result = read_json('https://api.github.com/repos/' + repo + '/releases/tags/' + tag)
    if result['tag_name'] != tag or result.get('draft') or result.get('prerelease'):
        raise ValueError('不是指定的正式发布：' + repo + ':' + tag)
    return {asset['name']: asset for asset in result['assets']}

def asset_record(key, platform, version, url, filename, digest=None):
    return {'id': key, 'platform': platform, 'version': version, 'url': url,
            'filename': filename, **({'expectedSha256': digest} if digest else {})}

def hashed_download(entry):
    h = hashlib.sha256()
    count = 0
    with request(entry['url']) as response:
        while True:
            data = response.read(1024 * 1024)
            if not data:
                break
            count += len(data)
            if count > 1024 * 1024 * 1024:
                raise ValueError('制品超过1GiB锁定预算：' + entry['id'])
            h.update(data)
    expected = entry.get('expectedSha256')
    digest = h.hexdigest()
    if expected and expected != digest:
        raise ValueError('实际字节与上游摘要不一致：' + entry['id'])
    return {k: v for k, v in entry.items() if k != 'expectedSha256'} | {'sha256': digest, 'bytes': count}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path, help='不存在的输出目录；需人工审核后才替换源码锁')
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError('输出已存在；不覆盖任何旧锁文件。')
    toolchain = json.loads((ROOT / 'config/local-web-toolchain.json').read_text())
    if toolchain['node'] != NODE or toolchain['python'] != PYTHON:
        raise ValueError('生成器固定版本与项目工具链不一致。')
    args.output.mkdir(parents=False)
    entries = []
    with request('https://nodejs.org/dist/v' + NODE + '/SHASUMS256.txt') as response:
        node_sums = {parts[1]: parts[0] for line in response.read().decode().splitlines() if len(parts := line.split()) == 2}
    pbs = release('astral-sh/python-build-standalone', PBS)
    ffmpeg = release('eugeneware/ffmpeg-static', FFMPEG)
    whisper = release('ggml-org/whisper.cpp', WHISPER)
    ytdlp = release('yt-dlp/yt-dlp', YTDLP)
    cmake = release('Kitware/CMake', CMAKE)
    def add_asset(key, platform, version, collection, name):
        asset = collection[name]
        digest = asset.get('digest')
        entries.append(asset_record(key, platform, version, asset['browser_download_url'], name,
                                    digest.removeprefix('sha256:') if digest and digest.startswith('sha256:') else None))
    for platform, (node_suffix, python_suffix) in PLATFORMS.items():
        name = 'node-v' + NODE + '-' + node_suffix
        entries.append(asset_record('node', platform, NODE, 'https://nodejs.org/dist/v' + NODE + '/' + name, name, node_sums[name]))
        name = 'cpython-' + PYTHON + '+' + PBS + '-' + python_suffix + '-install_only_stripped.tar.gz'
        add_asset('python', platform, PYTHON, pbs, name)
    for platform, chrome_platform in [('darwin-arm64', 'mac-arm64'), ('win32-x64', 'win64')]:
        name = 'chrome-' + chrome_platform + '.zip'
        entries.append(asset_record('chrome', platform, CHROME, 'https://storage.googleapis.com/chrome-for-testing-public/' + CHROME + '/' + chrome_platform + '/' + name, name))
        for key in ['ffmpeg', 'ffprobe']:
            add_asset(key, platform, FFMPEG, ffmpeg, key + '-' + platform)
        for suffix in ['LICENSE', 'README']:
            add_asset('ffmpeg-' + suffix.lower(), platform, FFMPEG, ffmpeg, platform + '.' + suffix)
        add_asset('yt-dlp', platform, YTDLP, ytdlp, 'yt-dlp_macos' if platform == 'darwin-arm64' else 'yt-dlp.exe')
    add_asset('whisper', 'win32-x64', WHISPER, whisper, 'whisper-bin-x64.zip')
    entries.append(asset_record('whisper-source', 'darwin-arm64', WHISPER,
        'https://github.com/ggml-org/whisper.cpp/archive/refs/tags/' + WHISPER + '.tar.gz', 'whisper-' + WHISPER + '.tar.gz'))
    add_asset('cmake', 'darwin-arm64', CMAKE, cmake, 'cmake-' + CMAKE[1:] + '-macos-universal.tar.gz')
    entries.append(asset_record('whisper-base', 'shared', '80da2d8bfee42b0e836fc3a9890373e5defc00a6',
        'https://huggingface.co/ggerganov/whisper.cpp/resolve/80da2d8bfee42b0e836fc3a9890373e5defc00a6/ggml-base.bin',
        'ggml-base.bin', '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'))
    entries.append(asset_record('whisper-license', 'shared', WHISPER,
        'https://raw.githubusercontent.com/ggml-org/whisper.cpp/' + WHISPER + '/LICENSE', 'whisper.LICENSE'))
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        artifacts = list(pool.map(hashed_download, entries))
    lock = {'version': 1, 'toolchain': {'node': NODE, 'npm': toolchain['npm'], 'python': PYTHON},
            'artifacts': sorted(artifacts, key=lambda entry: (entry['platform'], entry['id']))}
    (args.output / 'resource-sources.lock.json').write_text(json.dumps(lock, ensure_ascii=False, indent=2) + '\n')
    for source in ['local-web-python', 'polars']:
        lines = ['# Generated from exact requirements and PyPI release hashes; review before adoption.']
        for line in (ROOT / ('config/' + source + '-requirements.txt')).read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            match = re.fullmatch(r'([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)', line)
            if not match:
                raise ValueError('依赖未锁定精确版本：' + line)
            package, version = match.groups()
            data = read_json('https://pypi.org/pypi/' + package + '/' + version + '/json')
            hashes = sorted({file['digests']['sha256'] for file in data['urls'] if not file.get('yanked') and file['packagetype'] == 'bdist_wheel'})
            if not hashes:
                raise ValueError('没有可用固定wheel（预编译依赖）：' + line)
            lines.append(line + ' \\\n    ' + ' \\\n    '.join('--hash=sha256:' + digest for digest in hashes))
        (args.output / (source + '.lock.txt')).write_text('\n'.join(lines) + '\n')
    print(json.dumps({'status': 'locked', 'artifacts': len(artifacts), 'output': str(args.output)}))

if __name__ == '__main__':
    main()
