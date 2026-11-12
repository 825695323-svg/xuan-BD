# 从源码重建与启动

## 1. 重建依据与外部前提

固定版本以 `config/local-web-toolchain.json` 为准：Node 24.22.1、npm 11.19.1、Python 3.12.15。Node 与 Python 通过 `config/resource-sources.lock.json` 的精确上游制品获得；Python 依赖使用 `config/local-web-python.lock.txt`，可选计算执行器使用 `config/polars.lock.txt`。根 `package-lock.json` 与 `resources/browser/package-lock.json` 分别锁定应用和现有浏览器守护程序。

仍需外部提供 Git、一个可运行标准库下载器的 Python 3.10+、网络和磁盘空间。这些引导工具不是应用的已采用运行资源。下载器只接受全新绝对目标，校验全部下载字节后才展开；失败保留新目标供核查，不覆盖旧目录、不改系统安装、不扫描私人定位文件。

同版本上游二进制按哈希重取，不意味着从源代码实现位级可复现。macOS 的 whisper.cpp（本地转录程序）还需 Apple Command Line Tools（编译器工具）；本仓库固定源归档、CMake 和编译参数，但不能声称不同编译器生成的字节完全相同。

## 2. macOS arm64 / Linux x64：基础模式

在仓库根执行。把 `/absolute/bd-lab` 换成仓库外已存在的真实目录；其中 tools、venv、runtime、launcher.json 和 local-web.json 均应不存在。

```sh
LAB=/absolute/bd-lab
python3 scripts/bootstrap-resources.py --profile toolchain --output "$LAB/tools"
NODE="$LAB/tools/node/bin/node"
NPM="$LAB/tools/node/lib/node_modules/npm/bin/npm-cli.js"
PYTHON="$LAB/tools/python/bin/python3.12"
export PATH="$LAB/tools/node/bin:$PATH"

"$PYTHON" -m venv "$LAB/venv"
PY="$LAB/venv/bin/python"
"$PY" -m pip install --only-binary=:all: --require-hashes -r config/local-web-python.lock.txt
"$NODE" "$NPM" ci
"$NODE" "$NPM" run repo:check
"$NODE" "$NPM" run build
"$NODE" scripts/create-local-config.mjs --toolchain="$LAB/tools" --python="$PY" --runtime-root="$LAB/runtime" --launcher="$LAB/launcher.json" --output="$LAB/local-web.json"
"$NODE" scripts/local-web.mjs check --config="$LAB/local-web.json"
"$NODE" scripts/local-web.mjs prepare --config="$LAB/local-web.json"
"$NODE" scripts/local-web.mjs start --launcher="$LAB/launcher.json"
```

最后在浏览器访问 `http://127.0.0.1:4317`。端口占用时报错，不停止原实例。第二次启动只执行 start；prepare（新根准备）拒绝覆盖原根。上述流程明确禁用模型、浏览器控制和转录，不登记 WFD。

## 3. Windows x64：基础模式

在仓库根打开 PowerShell，使用仓库外已存在的真实父目录。下载器需要能创建并使用下载包内的文件链接；受限系统须由用户配置权限，程序不会自动提权。

```powershell
$Lab = 'C:\bd-lab'
py -3 scripts/bootstrap-resources.py --profile toolchain --output "$Lab\tools"
$Node = "$Lab\tools\node\node.exe"
$Npm = "$Lab\tools\node\node_modules\npm\bin\npm-cli.js"
$Python = "$Lab\tools\python\python.exe"
$env:PATH = "$Lab\tools\node;" + $env:PATH
& $Python -m venv "$Lab\venv"
$Py = "$Lab\venv\Scripts\python.exe"
& $Py -m pip install --only-binary=:all: --require-hashes -r config/local-web-python.lock.txt
& $Node $Npm ci
& $Node $Npm run repo:check
& $Node $Npm run build
& $Node scripts/create-local-config.mjs "--toolchain=$Lab\tools" "--python=$Py" "--runtime-root=$Lab\runtime" "--launcher=$Lab\launcher.json" "--output=$Lab\local-web.json"
& $Node scripts/local-web.mjs check "--config=$Lab\local-web.json"
& $Node scripts/local-web.mjs prepare "--config=$Lab\local-web.json"
& $Node scripts/local-web.mjs start "--launcher=$Lab\launcher.json"
```

每一步须成功再继续；外部命令非零退出码可通过 `$LASTEXITCODE` 核对。生成配置记录实际 SystemRoot（Windows系统目录），不猜测另一台机器路径。

## 4. 明确测试范围

```sh
npm run test:recipe
python3 scripts/bootstrap-resources.test.py
npm test
npm run test:python -- --python=/absolute/bd-lab/venv/bin/python
```

Windows 的 test:python 额外传 `--system-root=C:\Windows`，并改用所选虚拟环境的实际解释器路径。计算专项安装只在已选虚拟环境中显式执行：

```sh
/absolute/bd-lab/venv/bin/python -m pip install --only-binary=:all: --require-hashes -r config/polars.lock.txt
```

默认 Node 测试会按条件跳过真实 Python / WFD 用例，跳过不等于通过。仓库 CI（持续集成）单独提供固定 Python、独立临时目录和原生启动测试；正式来源账号、用户历史数据和实盘连接不在自动验收范围。

## 5. 可选随包资源

基础模式不依赖 `resources/bundled/`。要制作完整随包资源，先在目标系统按根锁执行 npm ci，再显式运行：

```sh
python3 scripts/bootstrap-resources.py --profile bundle --output /absolute/repository/resources/bundled
```

Windows 换用 `py -3` 和实际绝对路径。只支持 macOS arm64 与 Windows x64；Linux 仅提供基础工具链和验证环境，不假装存在 Linux 整包发布支持。生成目录必须全新。命令下载固定 Chrome、FFmpeg/ffprobe、whisper、yt-dlp、模型，使用浏览器独立锁安装守护程序，生成现有 `BundledResources`（随包资源读取器）可读取的清单。模型和二进制不得提交 Git。

生成后可在目标系统执行 `node --import tsx -e "import {BundledResources} from './platform/resources/bundled.ts'; new BundledResources(process.cwd()).verify();"` 核对全部资源与应用依赖。清单核对不等于界面自动化、登录态或转录质量已验收。采用资源仍使用既有 `scripts/adopt-bundled-resources.ts` / `scripts/prepare-runtime.ts`，不得把新清单静默替换进已运行实例。

更新资源版本是维护操作：先改生成器中的明确版本，再运行 `python3 scripts/lock-build-inputs.py --output /absolute/new-lock-review`，人工审核输出并提交新锁。日常安装只消费提交的锁，不运行锁生成器，不查询 latest（最新版）。

## 6. WFD、模型与来源连接

[WFD机器模板](../config/wfd-machine.example.json)、[WFD接线模板](../config/wfd-wiring.example.json)、[空连接登记模板](../config/connections.example.json)、[模型模板](../config/model.example.json) 只说明格式。尖括号占位符必须替换为实际、已授权的信息，不能把模板直接当生效配置。

WFD 的真实 store（数据目录）、runtime（工作目录）、连接编号、调用者身份与权限由操作者提供。已有正式库不能重建或初始化覆盖；新隔离库也必须明确建立。先按实际资源绑定登记 `connections_registry`（连接登记文件），再调用既有 `scripts/adopt-product-machine-wiring.ts` 的只读预检；核实原身份和意图后才显式 apply（采用）。不能把 user_test（测试连接）伪称 production（生产连接）。详细字段与拒绝条件以该脚本和 WFD 协议为准。

模型配置模板只展示 macOS 已支持的 `keychain`（系统钥匙串）引用：`service` 是已登记服务名称，`account` 必须由操作者替换并在实际钥匙串中存在。该入口依赖受信 `security`（钥匙串查询程序）资源绑定，不会因读取模板自动授权。Windows 目前不支持该钥匙串适配器；在没有额外获授权的凭据接入方案时继续保持模型禁用，不拿示例改写成旧 `dsh-ref`（弃用的 DSH 文件引用）或伪造已连接。模型及供应商账号不得将 token、私钥、登录目录或真实配置提交仓库。基础模式禁用的能力不能仅靠新增模板启用，须沿原有授权、绑定与验收入口办理。

## 7. 拉取与恢复问题

当前仓库没有子模块或 LFS 对象；不能用不存在的子模块解释缺文件。将来出现时，完整拉取也应被完整性检查发现。ZIP 下载没有 `.git`，无法核对索引和历史；正式验收使用 clone。浅克隆可构建当前源码，但不保证标签/历史分析完整。`git status` 干净只代表工作区与索引一致，不能替代对象完整性和重建测试。

本次构建失败时保留错误和全新输出目录；不要对用户运行根执行递归删除，也不要为通过检查而生成空锁、伪造摘要、降低精确版本要求或跳过失败用例。
