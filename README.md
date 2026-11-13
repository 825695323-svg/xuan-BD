# Xuan BD · 本地数据应用

Git 仓库保存“配方”：源码、精确依赖锁、资源来源与摘要、构建脚本、模板、协议和必要测试样本。依赖、编译结果、运行数据库、账号和大二进制不入库。

## 从干净源码开始

```sh
git clone https://github.com/825695323-svg/xuan-BD.git
cd xuan-BD
# 需要一个可用的 Python 3.10+ 来执行标准库下载器；它不是应用运行解释器。
# /absolute/tools 的父目录须已存在，tools 自身必须不存在。
python3 scripts/bootstrap-resources.py --profile toolchain --output /absolute/tools
```

下载器使用 [资源锁](config/resource-sources.lock.json) 的固定地址、长度和 SHA-256（字节摘要）取得 Node 24.22.1、npm 11.19.1、Python 3.12.15，不查询最新版、不修改系统 PATH、不接管旧运行根。Windows 使用 `py -3` 启动下载器。后续安装、构建与启动命令见 [完整重建步骤](docs/REBUILD.md)，其中包含 macOS/Linux 和 PowerShell 两套命令。

有精确工具链后，核心检查如下：

```sh
npm ci
npm run repo:check
npm run build
npm test
```

`repo:check`（配方完整性检查）不要求先有 `node_modules`。它核对已跟踪文件、锁、模板、协议引用、文档链接和内置 AGENTS 规则摘要；不能代替安装、运行或真实来源验收。

基础 `native`（原生模式）可在不安装浏览器、转录工具、模型和 WFD 连接的情况下启动数据界面，禁用能力会明确显示不可用。完整 `bundle`（随包资源）由显式命令在 macOS arm64 / Windows x64 重建；不在应用启动时自动下载。

## 本地测试不累积旧通道

`npm test`（BD 本地测试）每轮创建全新隔离运行根，验证结束后仅删除本轮自己的成功测试产物；失败时保留本轮证据供排查。设置 `XUAN_TEST_ROOT`（普通测试父目录）与 `XUAN_FULL_CHAIN_ROOT`（全链测试父目录）也不会重用旧状态库或旧通道绑定。明确使用 `npm test -- --keep-fixtures` 才保留本轮成功测试文件，正式 WFD 数据与生产运行根不受影响。

## 工程入口

[工程维护规则](AGENTS.md) · [来源语义与版本补充](docs/SOURCE-SEMANTIC-ADOPTION.md) · [重建与配置](docs/REBUILD.md) · [仓库文件边界](docs/REPOSITORY-POLICY.md) · [WFD 说明](wfd/product/README.md)

内置代理规则仍由 [运行规则](modules/agent/instructions/AGENTS.md) 和 [摘要加载器](modules/agent/instructions/rules.ts) 绑定。应用身份为 `xuan-bd`，接口前缀为 `/api/bd`。机器资源解析见 [绑定实现](platform/resources/bindings.ts)。

项目尚未声明整体开源授权；[LICENSE](LICENSE) 仅记录授权状态，不授予或改变任何第三方权利。
