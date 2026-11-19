# 转录原生选段作为未核实来源主张

复用 OCR 已有单观察媒体交接能力，不新建事件库、身份、签认、权限或任务运行时。新增 `transcription-review` 表源及 `transcriptionClaimSelection`：taskId、packetSha256、sourceSha256、segmentIndex、eventId/eventType。调用方不提供转录正文、时间、模型或确认结果。

受信宿主沿现有 task/call/link、原件、同任务产物读取实际转录核对包，重新验证原生文本、JSON、probe 与模型摘要。包绑定当前本地资料身份/代次（配置时）及原执行任务版本，旧包缺执行元数据不从当前模型补齐。proof 保留原件/文字/native/probe 引用、实际识别器/模型与持续时间、原生选段及其毫秒半开区间。沿原有加工产物的 `ocr_claim_evidence` 内部键存储，schema 区分 `bd.transcription-source-claim/1`；不另造产物。

核对包原有末端识别容差不等于发布资格。本切片只接受 `0 <= startMs < endMs <= durationMs`，其中 durationMs 沿既有 probe 秒值向上取整到毫秒，不声称亚毫秒精确终点；不裁剪、猜测或根据字数重建时段。识别的文字保留原生段值，不作为原件原文或事实。

正式字段复用六字段与同一声明门禁：source_claim、状态 unknown、事件/公开/定义时间 unknown、human/fact verification unknown。只支持单原件单段单输出 partial_observation，禁止集合/来源更正/同步 prepare；不增加视频与多段拼接。HTTP 操作者和现有 R1 文档摘要确认/TaskService 审批不变，旧问答及模型回答不批准发布。

parse、check、prepare、首次 effect 前均重验固定包；原件、模型、probe、段位置、执行版本或代次漂移拒绝且首次发送不创建 effect。已受理/未知结果沿既有原 request 身份核对恢复，不换包重新提交。正式记录包含原件/派生证据摘要，完整 proof 仍在本地已有加工产物；不宣称独立事实核验、人工签名或市场历史资格。

验证分层：Linux reader-port 合同测试明确 synthetic，不冒真实识别；macOS 现有配方使用已安装系统 say 生成明确测试语音，再由既有锁定 Whisper 实际识别，经真实材料/加工/R1/WFD 读回和重开。无语音资源时失败，不下载声音或调用外部 TTS/模型。合成源字节与摘要在执行中固定；不发布真实媒体内容，也不触碰用户 Mac。原有 OCR 实际链保持回归。
