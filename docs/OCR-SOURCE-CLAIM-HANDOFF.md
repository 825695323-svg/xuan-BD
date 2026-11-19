# OCR 识别派生来源主张的受控交接

本切片复用原媒体、加工、事件及 R1 发布合同，不建立签名、事件库或新权限。仅接受已保管原件的一条实际 OCR observation。发布的是“识别产物载有该文字”的 `source_claim`，不是图中陈述已经发生或真实的结论。

## 输入与冻结

- 现有只读 OCR 核对包增加 `packetSha256`、当前本地资料身份/代次（有配置时）及识别任务原有版本信息。旧包不能凭旧回答取得新资格。
- `ocr-review` 表源只接受 `materialId` 及 `ocrClaimSelection`：实际 OCR taskId、固定包摘要、原件摘要、observationIndex、操作者声明的 eventId/eventType。调用者不能传文字、框、识别器、确认布尔量或问答 id。
- 受信宿主读取既有 task/call/link、原件、同任务派生产物与原生 JSON，并复验完整摘要、实际原图位置及识别器信息。仅单原件、单观察、单发布输出；无宿主读取器时失败，不回退客户端输入。
- parse 产物保留固定包选择、原件和派生产物引用、准确原图归一化框与识别器身份。正式事件包含原件摘要和此证据投影摘要；完整 proof 仍在已有加工产物，不另造证据库。

## 准入与发布

只允许 `partial_observation`、`event_records`、`source_claim`、状态 unknown；event/public/definition 公开时间不从文件时间、识别时间或问答推断。六个固定字段包括识别文字、识别依据、原件/证据摘要及 human/fact verification=unknown。`valid_value` 仅表示该字符串值存在，不是事实核实。

完整原始投影的行摘要须一致，不允许清洗、改字或 annotation 覆盖。check、异步 prepare、首次发送的外部副作用标记前再次读取固定包；原件/产物/代次/身份不一致即拒绝。首次发送仍使用原 R1 文档确认摘要、TaskService 权限与审批，未更换授权主体或降低门槛。旧 `ask_user` 原话、模型回答与“已核对”词面均不批准发布。

原请求已受理或结果未知时仍走现有回执恢复，不以新的识别包改写已发生的提交。现有正式读回的合同与原件引用规则保持；这不赋予市场历史可知资格，不意味着事实、独立来源、人工签名或已兑现。

## 验证边界

- 跨平台 reader-port 合同测试明确使用 synthetic 读取端口，执行实际 HTTP 加工/R1/WFD；不伪造成功 OCR 任务，不声称真实识别。包含错误确认、包漂移、首次发送前拒绝且零 effect，以及固定读回 unknown。
- macOS 既有配方编译仓库 Vision helper，对隔离运行中自绘图真实识别，经真实会话材料入口/原生证据→加工→确认→WFD→重开。不联网模型、不读取用户 Mac、不发布真实事件。Linux/Windows 不具备 Vision，live skip 不是实际通过；macOS 零跳过 CI 才是识别链验收。
- 此切片不扩展 UI、不实现转录正式发布或人工事实签认，不改变已有核对问答语义。
