# BD 百度网盘 Skill 归档接口改造

## 归档执行链

1. BD 的 `CloudCustodyService`（网盘归档服务）读取当前已保管材料和归档目录。
2. 归档服务复用 `plugins/capture-sources/baidu-drive/index.ts` 中 `runBaiduSkillCommand`（百度网盘技能公共命令执行器），调用已登记的 `bdpan`（百度网盘命令行工具）；不在归档插件重复实现命令解析。
3. `ls`（远端文件目录查询）读取文件名、文件类型、大小、`fs_id`（网盘对象编号）和路径。匹配现有归档时直接复用远端对象。
4. 如果文件尚未归档且本次允许写入，就调用 Skill 的 `upload`（单文件上传）或 `cp`（盘内复制）。随后再用 `ls` 查询目标的文件名、大小、`fs_id` 和路径；与上传/复制回执一致即完成归档。
5. 归档状态保存为 `uploaded_metadata_checked`（上传元数据已核对）、`copied_metadata_checked`（复制元数据已核对）或 `reused_metadata_checked`（已有归档元数据已核对）。`verifiedSha256=null` 表示本次未下载进行远端全文比较，本地原件的 SHA-256 仍为本地保管身份。
6. `recover`（明确恢复原件）是另外一个操作，允许调用 `download`（下载）取得实际字节；它不应被归档确认自动触发。

## 代码位置

- `plugins/capture-sources/baidu-drive/index.ts`：原 Skill 动作、公共 bdpan 命令执行器及上传后查询
- `plugins/storage/baidu-drive.ts`：归档 Session（网盘会话）中的 `ls`、`upload`、`cp` 适配
- `modules/collection/cloud-custody.ts`：归档状态、幂等引用、元数据确认、明确恢复原件
- `apps/web/src/ui/CloudCustodyPanel.tsx`：归档前端显示文件名、大小和 `fs_id`

## 官方安装来源

官方百度网盘 Skill 项目：<https://github.com/baidu-netdisk/bdpan-storage>。

仓库包含 Skill 和 bdpan 命令行安装脚本。缺少程序、账号或宿主绑定时，BD 报告不可用，并给出官方地址；不会默默下载、登录、替换配置或者把另一来源的 CLI 冒充为已安装版本。

## 范围

不增加定时任务、不增加后台主动上传、不清除既有本地原件。此轮只改变归档工具复用方式和归档成功判定；后续要释放本地原件，应当在产物生命周期任务中独立实现。
