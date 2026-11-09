# 同花顺金融数据

上游接口域名仍为 `fuyao.aicubes.cn`；本工程内部按供应商「同花顺」命名，来源编号为 `ths`，不再使用 `fuyao` 作为内部供应商标识。

本供应商独立放在 `plugins/api-sources/providers/ths/`。`api.ts` 保存它自己的接口身份和接入约定，用户指定本供应商先作为主源；共用的凭据就绪检查在 `api-sources/manager.ts`。

| 项目 | 位置或约定 |
|---|---|
| 来源编号 | `ths` |
| API（接口）地址 | [fuyao.aicubes.cn](https://fuyao.aicubes.cn) |
| API Key（接口密钥）申请与管理 | [申请地址](https://fuyao.aicubes.cn/admin/) |
| 申请步骤 | [快速开始](https://fuyao.aicubes.cn/docs/quickstart/) |
| 接口目录 | [REST API（网页接口）总览](https://fuyao.aicubes.cn/docs/api-reference/overview/) |
| 完整接口文档 | [llms-full.txt](https://fuyao.aicubes.cn/llms-full.txt) |
| 鉴权 | `X-api-key` 请求头，值由当前来源的本机安全凭据引用解析 |
| 业务结果 | 同时检查网页状态与业务 `code`；`0` 成功，`2001` 未认证，`2003` 权限不足，`4001` 限流。限流不立即连续重试。 |

本机已有密钥时继续使用已有密钥；更换电脑后重新提供并核验本机引用。没有密钥时提醒用户打开申请地址、登录并创建接口密钥。本程序不代为登录、签发或索取账号密码，不把旧机器的可用状态复制为新机器已可用。

当前查阅服务约定使用上表服务文档；需要本地原件时，经当前已授权的来源登记或明确选件入口取得引用并核对对象，不按历史挂载路径自动读取，也不复制外盘素材到工程。

本目录已有接入定义和本机凭据缺失提醒；共用取数入口 `source.api.read`（接口源读取）已装配 `daily_bars`（日线行情）与 `index_constituents`（当前指数成分）两项读取，使用当前来源设置中的连接顺序与安全凭据引用保存原始响应和回执。实际可用性仍以所选账号的读取结果为准，不将文档列出的所有接口声明为已实现或已获准。数据服务域名、数据名称和同花顺官方提供方身份分别核对，不仅凭文档标题推定官方归属。
