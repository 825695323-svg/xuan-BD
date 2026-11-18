# 依赖安全边界

本轮仅修复已核实的 HTTP 解析、HTTP 客户端与开发命令引号依赖，不运行 `npm audit fix --force`，不升级整个代理 SDK 或构建工具链。

## 固定修复

| 依赖 | 原版本 | 固定版本与理由 |
| --- | --- | --- |
| body-parser | 2.3.0 | 2.4.0；Express 的压缩正文尾字节可能造成未捕获异常。使用根 overrides 保证实际间接解析器版本。Express 本身仍为 5.2.1。 |
| qs | 6.16.0 | 6.17.1；body-parser 2.4.0 要求至少 ^6.16.1，锁内共用同一满足范围的修复版。 |
| undici | 8.10.2 | 8.12.2；根直接依赖固定版本，overrides 引用 `$undici`，避免代理 SDK 原精确旧版本留下另一个副本。未升级 SDK。 |
| concurrently / shell-quote | 10.0.5 / 1.9.0 | concurrently 10.0.7 官方固定 shell-quote 1.12.0；均为开发依赖，不把漏洞计数解释为两处生产远程执行。 |

官方依据：[body-parser](https://github.com/advisories/GHSA-27r3-jxmh-p828)、[undici TLS 选项](https://github.com/advisories/GHSA-2m5v-pch6-74hx)、[shell-quote](https://github.com/advisories/GHSA-pqg4-j6r4-53mv)。锁文件与 npm 注册表完整性校验随 `npm ci` 核对。以上版本支持当前 Node 24 工具链。

## 可达性与验证界限

- 实际应用的个人和 BD JSON 入口均使用默认支持解压的 `express.json`，不是仅开发依赖。日常监听回环地址，且有 Host、Origin、客户端标识与资料代次门禁；不能由受影响版本直接推断公网无条件可利用。
- `dependency-security.test.ts` 在新建子进程的临时回环服务使用真实 `createApp` 和解析器，验证正常 gzip、解压后 160kb 上限、分段压缩尾字节后进程及健康入口仍工作。末尾异常可走已有通用错误响应；不新增吞异常或放宽解析策略。该回归不声称复现公告全部竞态，更不测试生产服务。
- undici 的实际生产调用使用 `request` 和 `Agent`，公开获取采用 `connect` DNS 绑定及独立权限核对。TLS 回调丢失公告的 `tls.checkServerIdentity` 触发条件在这两处未发现；不能据此排除其它公告。新增本机真实 HTTP 字节、头及取消兼容回归，既有公开 PDF/来源测试继续执行。未执行真实账号/模型网络调用、全部 TLS 异常或跨源缓存攻击。
- shell-quote 回归仅调用引号函数验证危险换行输入被拒绝，从不把该样本交给 shell。源码未发现运行期调用 concurrently，未把开发依赖风险提升为已证实生产 RCE。

## 剩余项

本次固定安装后的 npm audit 从 9 项降至 4 项：2 中等、2 高，0 严重。剩余为 `@earendil-works/pi-coding-agent`/`minimatch` 同一依赖链的模式复杂度问题，以及 Vite 和 Zod；不是 4 个已证实可利用入口。Vite 属开发依赖，Zod 位于 UI/模型 SDK 生产依赖链。其实际攻击面、升级兼容性和模型调用需单独验证，当前未声称解决。未改 OS、网络安全设置、来源授权或用户运行配置；未执行全量回归。


## Zod 独立补丁复核（2026-11-18）

- 官方 [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) 指定修复版 4.6.6。本增量只将锁内 Zod 4.6.5 更新为 4.6.6（版本、官方 tarball、完整性摘要），根依赖和其它包不变。`@assistant-ui/react` 的 `^4.6.5` 及 OpenAI/Anthropic SDK 的 Zod 4 peer 范围均容纳补丁；未升级 SDK、模型协议或工具权限。
- 仓库业务源码未直接导入 Zod。会话 UI 使用 `@assistant-ui/react` 外部存储运行时；依赖存在不证明这条 UI 或公开 HTTP 路径会触发公告，当前未建立远程可利用性。可选 OpenAI Zod helper 的本机兼容测试也不代表业务已调用它或真实模型联网验收。
- 有界合成反例：对 `.max(4)` 数组输入 20,000 个无效值，旧版实际遍历 20,000 项并产生 20,001 个问题；补丁在元素处理前返回一个大小错误。回归在 V8 old-space 上限 96 MiB、超时 5 秒的独立子进程核同步与异步拒绝、正常小数组、类型错误和 SDK schema 正常解析，不尝试耗尽宿主内存。该补丁针对显式大小约束，不承诺无上限 schema 的输入资源安全；应用输入预算仍必须保留。
- 本次安装前官方 audit 已为 7 项而非上段历史 4 项（新增 picomatch/fdir/tinyglobby 依赖链报告）；补丁后为 6 项：2 中等、4 高、0 严重。剩余 minimatch/代理链与 Vite/picomatch 开发链未在本轮升级，不将传递依赖计数当独立可利用入口。
- `npm ci`、安全回归与既有 UI 定向测试、build/repo/logic 按当前锁执行；94 项历史逻辑 deferred 未清理。未运行完整 Linux 回归、真实模型/供应商请求、虚拟时钟/投放或取消的耐久测试。
