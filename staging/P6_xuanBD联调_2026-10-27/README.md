# P6 前置：WFD 产品服务公开本地进程边界 + BD 发现/固定读取适配

状态：**代码与定向验证已在工作区 staging 完成；WFD 开发根落盘由主审用写权限会话执行，本会话不跨根写。**
本批不宣称整个 P6 通过。当前结论分两层：

- **通用 fixed_read 通过**：经公开 `wfd.product-machine/0.1` 薄入口，按固定 snapshot_id
  真实读取 P1b 3 行和 0.2 聚焦产品 60 行；逐行核对定义版本、合同摘要、声明字段。
- **金融算法端口未通过**：固定合同没有结构化 frequency/adjustment/bar_closed/
  availability/currency/时间轴语义，`AlgorithmSnapshotPort` 明确拒绝，不把年度吞吐量
  或 0.2 日线误标成已验证的 MA/日线输入。P4 补合同后再完成 P6 算法联调。

`submit`、`packages`、`export`、`company_view`、`calendar_read` 明确未支持。

## 主审否决的旧 run

`run_0_2/`、`run_p1b/` 是第一次提交，**已被主审否决，仅作历史保留**：

- 旧 `product-machine-snapshot.ts` 把 caller `reference.definitionRevision` 原样写入结果，
  未与服务返回 `definition_ref.version` 比对；P1b 年度吞吐量曾接受
  `intentionally_wrong_revision` 并给出 `verifiedScope`。
- 旧验证脚本对所有产品手填 `1d/CNY/未复权/Asia/Shanghai/15:00`，把 caller 语义当数据库事实。
- 旧 `fields` 只检查首行，实际返回全字段，却写成 `local_selected_fields`。
- 旧 summary 的 `service_source_sha256 = b7f108ac...` 是 P1b 更新前的旧 hash。

**不要引用旧 run 的 `snapshot-port.json` 或 `snapshot_port` 成功字段。**
当前权威证据是 `run_0_2_v2/`、`run_p1b_v2/`。

## 本版修正

### 1. 定义/合同身份必须来自固定返回

`product-machine-snapshot.ts` 先 `contract_discovery` 取固定产品定义/合同，再
`fixed_read` 取值行，并核对：

- 产品 `definition_ref.version/digest` 与每一行 `definition_ref.version/digest` 相同；
- 产品 `contract_ref.digest` 与每一行 `contract_ref.digest` 相同；
- 所有行只能有一个定义版本/一个合同摘要；多版本直接拒绝；
- caller `reference.definitionRevision` 必须等于实际 `definition_ref.version`，否则
  `ALGORITHM_SNAPSHOT_DEFINITION_MISMATCH`；
- caller `expectedDefinitionSha256`/`contractDigest` 只作预期，与实际摘要比对；
- 结果 `resolution.definition`/`resolution.contract_ref` 写实际值，不写 caller 声明。

### 2. 语义只从合同/单位/时间轴产生

`inspectProductMachineSemantics()` 只从固定产品合同、声明字段、行 `observation_time`、
逐字段 `unit_code` 派生：

- `frequency`：先用合同显式 `frequency`；否则由 `time_role + observation_time.precision`
  派生（P1b `statistical_period + year → 1y`；0.2 `trading_day + day → 1d`）。
- `timezone`：取行 `observation_time.source_timezone` 唯一值（P1b
  `America/Los_Angeles`；0.2 `Asia/Shanghai`）。
- `currency`/`price_unit`：从声明字段 `unit_code` 派生（0.2 `cny_per_share → CNY`/
  `currency_per_share`；P1b `vehicle` 无价格币种）。
- `adjustment`/`adjustment_basis`/`bar_closed`/`availability`：只认结构化合同键；
  当前合同没有，明确列入 `missing`，**不用 `semantic_code` 文本或 caller 声明补成事实**。
- caller 的 `frequency/timezone/currency/adjustment/barClosed/priceUnit` 只作预期，
  与实际值比对；不一致写入 `mismatches`，`caller_expectations_used_as_truth` 恒为 false。

### 3. 字段逐行核验并真正裁选值列

- 声明字段来自 `declaration.field_definitions` 或 `contracts.semantic.fields`；
- 每个请求字段必须在固定定义中声明；
- **每一行**都必须有该字段及 `value`，并核对返回 `data_type`/`unit_code` 与声明一致；
- 每格 `cell_metadata` 独立保留 `value/value_state/data_type/unit_code/unit_ref/
  declared_unit_code/safe_value_state`；`unknown/null` 与 `not_applicable/null` 不合并；
- `value_state != valid_value` 或 `value is null` 的选中单元格明确拒绝为
  `ALGORITHM_SNAPSHOT_CELL_STATE_UNSUPPORTED`，不静默变成裸 null；
- `rows` 只含 `reference.fields` 的 value 列；`business_key`、`observation_time`、
  `subject`、`record_ref`、`revision`、`definition_ref`、`contract_ref`、`eligibility`
  放在独立 `resolution.envelope`，不冒充值字段；
- `rowsSha256` 保持 `null`（产品服务不暴露 full-resource 行摘要）；
  `valueProjectionSha256` 单独记录，basis 明确为
  `local_selected_declared_value_fields_only`；
- `resolution.fields.projection = selected_declared_value_fields_only`。

## 本轮主审 3 接缝收口

1. **公开投影完整承接**：`staging/wfd_sdk/product_machine.py` 的 `fixed_read` 不再重建
   精简结果；`public_projection`、`source_ids`、完整 `products/contracts/units` 和完整
   行追溯字段全部保留。`compact` 明确拒绝，不做“删字段省字节”。
2. **单元格状态不抹平**：BD 新增 `extractSelectedCells()`，每格保留
   `value/value_state/data_type/unit_code/unit_ref/declared_unit_code/safe_value_state`；
   当前 0.2 聚焦 60 行共 360 格全部 `valid_value`，0 个 unsafe；P1b 3 格也保留。
   `unknown/null` 与 `not_applicable/null` 两个反例分别保留为不同状态，均
   `safe_value_state=false`，不会被算法入口当成同一 null。
3. **range 不静默**：`reference.range` 非空直接
   `ALGORITHM_SNAPSHOT_RANGE_UNSUPPORTED`；没有实现范围过滤就不返回全域。
   本批只做定向 probe，不扩大旧字段/版本范围。

## 当前权威证据

两次都只启动 staging 薄入口，使用真实 store，不扫描 WFD 私有 catalog，不使用旧
`wfd.data-service/v1` generic-transport，不连接 `/v3/data-entry`。

### A. 0.2 金融切片（run_0_2_v2）

- store：`03_测试与验证记录/金融产品建设_2026-10-27/run_20261026T164019Z/store`
- snapshot：`s_9f3edb73a442f1940a54a1d8`
- 全量 fixed_read：12 产品 / 176 行；业务产品行数 **91（日历）/ 60（日线）/ 16（单位）**；
  每个产品的定义/合同身份集合唯一（`mixed_identity_products=[]`）。
- 聚焦产品 `p_d91987a11e99f581da8e71c7`：60 行，声明字段
  `open/high/low/close/volume_lot/amount_cny`，逐行字段与定义/合同摘要核对通过；
  360 格 `cell_metadata` 全部 `valid_value`、0 unsafe，原始行 `value_state` 保留。
- 算法门：正确 definition + caller 伪造 `1d/CNY/未复权/Asia/Shanghai/15:00` →
  `ALGORITHM_SNAPSHOT_SEMANTICS_UNSUPPORTED`；实际派生 `frequency=1d`、
  `timezone=Asia/Shanghai`、`currency=CNY`、`priceUnit=currency_per_share`，但仍缺
  `value_field.timestamp_date`、`adjustment`、`adjustment_basis`、`bar_closed`、
  `availability`，所以未通过。
- 错误 definition → `ALGORITHM_SNAPSHOT_DEFINITION_MISMATCH`；
  未声明字段 `not_a_declared_field` → `ALGORITHM_SNAPSHOT_FIELDS_MISMATCH`。
- 证据：`run_0_2_v2/`（capabilities、discovery、fixed-read-all、
  fixed-read-all-summary、request-status、trace、generic-fixed-read、
  null-state-probe、algorithm-gate、negative-boundary、summary）。
  `fixed-read-all.json` 保留完整 `public_projection/source_ids/products` 与首末行追溯
  字段，不再写 8.6MB 原始行；`generic-fixed-read.json` 保留公开投影、合同/单位、
  首末行和 360 格 cell_metadata。

### B. P1b 更新快照（run_p1b_v2）

- store：`03_测试与验证记录/P1_正式契约与治理_2026-10-27/run_20261026T190546Z/store`
- snapshot：`s_67599763a42340c8f8f15396`
- 结果：1 产品 / 3 行；`request_status` 读回 `state=published_formal`，phases
  `custody=verified / publication=published / received=accepted /
  registration=registered / validation=passed`。
- 通用 fixed_read：产品 `p_72eeb399a487bbad80981641` 3 行（3 格 cell_metadata，
  原始 `value_state=valid_value` 保留）；实际定义
  `v_0d9f41dd79354796` / `sha256:0d9f41dd...`，合同
  `sha256:9c770051...`；逐行核对通过。行值含 `value_decimal=157066`、
  `observation_time.precision=year`、`source_timezone=America/Los_Angeles`。
- 算法门：caller 伪造 `definitionRevision=intentionally_wrong_revision` →
  `ALGORITHM_SNAPSHOT_DEFINITION_MISMATCH`，并回报实际定义版本/摘要；
  正确 definition + caller 伪造 daily → `ALGORITHM_SNAPSHOT_FIELDS_UNSUPPORTED`
  （该产品 `scalar_rows`，固定合同没有声明值字段），同时语义审计记录
  `derived.frequency=1y`、`timezone=America/Los_Angeles`，并记录
  `frequency: caller=1d actual=1y`、`timezone: caller=Asia/Shanghai
  actual=America/Los_Angeles` 的 mismatch；`missing` 含
  `contract.field_definitions/adjustment/bar_closed/availability` 等。
- 证据：`run_p1b_v2/`（同上；`null-state-probe.json` 两个 null state 分别
  `unknown`/`not_applicable`；`range` 负例为 `ALGORITHM_SNAPSHOT_RANGE_UNSUPPORTED`）。

### 版本/调用证据

- 当前运行服务：`wfd.product-service/0.3`、`wfd.product-contracts/0.3`、
  `wfd.product-capabilities/0.2`、
  `https://wfd.example/spec/v1.3/wfd-ingest.schema.json`。
- 最终 `run_0_2_v2`/`run_p1b_v2` 的实际调用
  `service_source_sha256 = 45251fab256f1562f993d04a0b40033dafd82a29912d85ef0a9700f0c7a1ec2b`；
  `product_governance.py = 846457ea...`。审查期间主 DSH 仍在更新 `product_service.py`：
  主审提到的 `72c0b715...` 是较早的 P1b 更新，随后实际文件还出现过
  `ce21f9be...`/`a6d00ed4...`/`3bef848d...`，最终证据只认测试实际调用并在运行前后
  复核一致的 `45251fab...`；不把 `72c0b715` 或中间 hash 混入本轮结果。
- `summary.json` 记录 `entry_sha256`、`config_sha256`、服务/治理源码 hash，以及每次
  调用的 request_id/耗时/响应字节。
- 旧 run 的 `b7f108ac...`、中间尝试的 `ce21f9be...`/`a6d00ed4...`/`3bef848d...`
  不代表当前服务，只保留为历史。

## 负向边界

- `submit` → `OPERATION_UNSUPPORTED`，含 action、request_id、identity，无 job_id。
- 请求自带 `caller_roles` → `REQUEST_INVALID`。
- 受控配置给来源加 `may_submit=true` → 启动阶段 `CONFIG_INVALID`（只读入口拒绝写授权）。
- 非空 `range` → `ALGORITHM_SNAPSHOT_RANGE_UNSUPPORTED`；没有实现过滤就不返回全域。
- `compact` → `REQUEST_INVALID`；公开投影/证据/追溯字段不再被静默删减。
- 两个 `null` 反例：`unknown`/`not_applicable` 分别保留，`safe_value_state=false`，
  见 `null-state-probe.json`；不会进入算法 verified。
- 读后复查：两个 store 近 15 分钟均 0 个文件变更；未向 WFD 证据 store 写入。

## 待落盘文件

1. `staging/wfd_sdk/product_machine.py`
   → `<WFD产品开发>/wfd_sdk/product_machine.py`
2. `staging/P6_xuanBD联调_2026-10-27/`
   → `<WFD根>/03_测试与验证记录/P6_xuanBD联调_2026-10-27/`
   （复制整个目录后，用 `config_final/` 覆盖目标 `config/`；最终 P1b 配置指向
   `run_20261026T190546Z/store`。）
3. BD 侧已在工作区直接修改，无需再落盘：
   - `adapters/database/wfd-product-machine.ts`
   - `modules/financial/product-machine-snapshot.ts`
   - `scripts/verify-wfd-product-machine.ts`

安装命令（由有 WFD 写权限的会话执行）：

```sh
WFD_DEV="/Users/mashiro/WFD规划与测试/世界金融数据库（World Financial Database）/02_数据库引擎与实施代码/产品开发"
WFD_REC="/Users/mashiro/WFD规划与测试/世界金融数据库（World Financial Database）/03_测试与验证记录"
test ! -e "$WFD_DEV/wfd_sdk/product_machine.py"
test ! -e "$WFD_REC/P6_xuanBD联调_2026-10-27"
cp "/Users/mashiro/xuan BD/xuan BD/staging/wfd_sdk/product_machine.py" "$WFD_DEV/wfd_sdk/product_machine.py"
cp -R "/Users/mashiro/xuan BD/xuan BD/staging/P6_xuanBD联调_2026-10-27" "$WFD_REC/P6_xuanBD联调_2026-10-27"
cp "/Users/mashiro/xuan BD/xuan BD/staging/P6_xuanBD联调_2026-10-27/config_final/"*.json "$WFD_REC/P6_xuanBD联调_2026-10-27/config/"
```

## 复现命令（staging，已实际执行）

```sh
cd "/Users/mashiro/xuan BD/xuan BD"
npm run typecheck

node --import tsx scripts/verify-wfd-product-machine.ts \
  --python "/Users/mashiro/WFD规划与测试/runtime/venv/bin/python" \
  --entry "$PWD/staging/wfd_sdk/product_machine.py" \
  --config "$PWD/staging/P6_xuanBD联调_2026-10-27/config/product_machine_0_2.json" \
  --project "/Users/mashiro/WFD规划与测试/世界金融数据库（World Financial Database）/02_数据库引擎与实施代码/产品开发" \
  --evidence "$PWD/staging/P6_xuanBD联调_2026-10-27/run_0_2_v2" \
  --snapshot s_9f3edb73a442f1940a54a1d8 \
  --instance wfd-product-local-20261027 \
  --expect 0.2 \
  --trace-product p_26be7d18c2302505ea79da68 \
  --port-product p_d91987a11e99f581da8e71c7 \
  --identity "$PWD/staging/P6_xuanBD联调_2026-10-27/config/identity_0_2.json"

node --import tsx scripts/verify-wfd-product-machine.ts \
  --python "/Users/mashiro/WFD规划与测试/runtime/venv/bin/python" \
  --entry "$PWD/staging/wfd_sdk/product_machine.py" \
  --config "$PWD/staging/P6_xuanBD联调_2026-10-27/config/product_machine_p1b_v2.json" \
  --project "/Users/mashiro/WFD规划与测试/世界金融数据库（World Financial Database）/02_数据库引擎与实施代码/产品开发" \
  --evidence "$PWD/staging/P6_xuanBD联调_2026-10-27/run_p1b_v2" \
  --snapshot s_67599763a42340c8f8f15396 \
  --instance wfd-product-local-20261027 \
  --expect p1b \
  --trace-product p_72eeb399a487bbad80981641 \
  --port-product p_72eeb399a487bbad80981641 \
  --identity "$PWD/staging/P6_xuanBD联调_2026-10-27/config/identity_p1b_v2.json"
```

## 实际失败与剩余项

1. **金融算法端口未通过（本批修正后的真实结论）**：P1/P3 合同缺结构化
   frequency/adjustment/bar_closed/availability/currency/时间轴；通用 fixed_read
   可用，但算法入口必须等 P4 合同补齐。不得用 caller 声明、`semantic_code` 文本或
   手改配置把它变成 verified。
2. 整个 P6 未通过：本批只做公开本地进程边界 + 发现/固定读取 + 算法门拒绝；
   正式多输出提交、算法回提、包导入导出、公司关联视图、日历专用读取仍待 P3/P5。
3. Windows x64 与拔盘轮未覆盖。
4. `requirements-duckdb.txt` 没有列 `thrift`；本次使用既有
   `/Users/mashiro/WFD规划与测试/runtime/venv`（Python 3.12、duckdb 2.0.0、
   jsonschema 4.26.0、thrift 0.25.0），未改 WFD 共享依赖文件。
5. 0.2 的 `request_status` 返回 `unknown`：该 0.2 运行没有持久化 `market` 身份；
   P1b 已验证 `published_formal` 读回。
6. 没有创建 BD 运行时专用数据库连接：本批只读、无提交，现有 `/Volumes`
   user_test/prod 不挪不改；`wfd-product-local-20261027` 只作为受控机器配置的
   `connection_id` 与测试身份。后续 P3 正式联调需要独立线路时，再沿
   `scripts/database-wiring.ts` 的 adopt/verify/preview/select 流程采用同名测试连接。
7. 当前 service 的 `capabilities.unsupported` 仍列 `external_machine_process`；
   这是 P1b 维护文件现状，本批不编辑该共享文件。机器层在 `operations` 明确列出
   已支持五个操作，并在 `service_capability_notes` 说明，不冒充整个 P6 通过。
