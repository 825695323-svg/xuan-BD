# 操作与当前能力

## Xuan Harness 受控动作

使用 `baidu.drive`，各动作按登记字段执行。

| operation（操作） | 参数 | 用途 |
|---|---|---|
| `whoami` | 无 | 查询登录状态；不读取凭据正文 |
| `ls` | `path`，可选 `offset`、`limit` | 查询自有目录 |
| `search` | `query`，可选 `page`、`limit` | 搜索文件 |
| `download` | `path` | 下载自有网盘单文件，发布为本机成果 |
| `upload` | `fileRefId`、`path` | 上传当前会话明确选择的单文件到新路径 |
| `transfer-list` | `shareUrl`，可选 `sourceDir`、`passcodeRef`、`page`、`limit` | 枚举分享及其指定子目录 |
| `transfer-select` | `shareUrl`、`path`、`fileIds`，可选 `passcodeRef` | 转存所选条目并核对目标 |

自有路径须在 `/apps/bdpan/` 下。`fileIds` 是逗号分隔的唯一数字字符串，最多100个；`limit` 最大100。上传和下载单文件上限256 MiB（兆字节）。不得把这些上限解释为整批任务授权。

`shareUrl` 只接受官方 HTTPS 域名及单一分享标识，须去掉查询和片段。需要提取码时传宿主已登记的 `passcodeRef`（1–64 个字母、数字、点、下划线或连字符，首位为字母或数字）。获得该引用对应的 secret 权限后，宿主解析凭据并只向分享命令传入 `-p`。缺失或解析失败即停止。

`transfer-list` 的 `sourceDir` 对应 `--source-dir`，必须是以斜杠起始、最长 2048 字符的分享内路径。转存目的地始终来自 `transfer-select` 的自有网盘 `path`。

目录查询与搜索须按分页标记读全本轮需要的范围；列表不完整时不能判定文件不存在。分享目录路径与自有目标路径不可混用。

## 命令行宿主

只在宿主已提供命令执行能力且操作已授权时使用；不通过命令行绕过受控动作的能力边界。参数先核对本机对应子命令帮助。

```sh
bdpan --no-check-update --json ls "/apps/bdpan/资料" --start 0 --limit 100
bdpan --no-check-update --json search "报告" --page 1 --page-size 50
bdpan --no-check-update --json transfer list "$SHARE_URL" --page 1 --page-size 100
bdpan --no-check-update --json transfer select "$SHARE_URL" --fsid "FILE_ID" --dir "/apps/bdpan/本次目标"
bdpan --no-check-update --json download "/apps/bdpan/资料/报告.pdf" "/本地/报告.pdf"
```

示例路径和编号须替换成已核实对象。单文件下载的第二参数使用完整文件路径，不传一个已存在目录。上传、移动、重命名、删除和创建分享只按用户本轮要求及当前帮助处理，不能附加到查询任务中。

私密分享凭据只能通过宿主允许的受保护输入提供；不把含提取码的链接写进日志、报告或复用示例。命令行参数可能被本机进程工具观察，不能承诺其完全不可见。

## 查看和归档

会话与证据托管均使用登记的 bdpan 和 `runBaiduSkillCommand`。只展示官方回执实际提供且通过域名核对的 `return_url` 或 `return_markdown`。归档回执、保管记录与产物清单均可返回 `returnUrl`，缺失时为 null。目录查看链接只属于对应目录。

归档只确认文件名、大小与远端编号。恢复原件时才下载并比对冻结的 SHA-256。成功下载可由同分支 `material.read` 按签发引用和摘要建档。
