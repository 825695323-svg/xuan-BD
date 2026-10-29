# P6 实际 BD 生产者/消费者闭环（定向）

状态：**真实 WFD public process 闭环已在候选 store 跑通；实际 BD runtime 连接登记被本会话写权限阻塞，登记合同与检查结果已备，待主审安排有写权限 DSH 执行。**

本批只改 BD 工程与 staging 证据；未改 WFD SDK / 共享 service，未写旧 prod、旧任务或 runtime JSON/SQLite。

## 实际配置读回

- 运行根：`/Users/mashiro/xuan BD/运行数据`
- 运行身份：`701e578c-4b16-412b-af20-a1685b5d9738`
- bindings revision：`17`
- `config`：`personal/config`（受管理目录，身份 `9f9aff60-...`）
- `connections_registry`：`/Users/mashiro/.config/credentials/connections.json`
- 当前登记中 **没有** `wfd-product-local-20261027`；本批未写该登记。
- 读回证据：`run_20261027_final/actual-config-readback.json`

## 实际闭环

真实输入：WFD `fixtures/financial_products/inputs.json` 的
`eastmoney_bars_2026q2` 2026Q2 60 个交易日 fqt=0 行；原始 HTTP 响应字节
`002da38b07778f99997a6b385eb45c10955a64c3f2f8a6ff2484371fc1240750`。

经 canonical WFD 入口
`/Users/mashiro/WFD规划与测试/世界金融数据库（World Financial Database）/02_数据库引擎与实施代码/产品开发/wfd_sdk/product_machine.py`
依次调用：

`capabilities → schema → evidence_ingest → submit → request_status → contract_discovery → fixed_read → read_product ×3 → trace`

结果：

| 项目 | 实际值 |
| --- | --- |
| submit status | `published_formal` |
| product_id | `p_69187760dfa849b97b062efd` |
| snapshot_id | `s_244f9515a1189e0e07452b92` |
| request_state | `published_formal` |
| fixed_read | 60 行，definition/contract 逐行核对 |
| read_product | 3 页 / 60 行，`paged_read_complete=true` |
| trace evidence | 1 条 |
| 服务版本 | `wfd.product-service/0.3` |
| service source hash | `c05c68bb1ca4c47e665ab38551470075c287b05c31705d738b3ca9829d7a1ee1`（运行前后一致；运行后 WFD 源码又变为 `decae405...`，正式验收前需重跑） |
| entry hash | `1944360fc789744906d65edc2294824f856e6c9e1166cfbc0df666fd9359745d` |

证据目录：`run_20261027_final/`
（producer-request、evidence-ingest、submit-receipt、request-status、discovery、
fixed-read、read-product-requests/pages/summary、trace、summary、actual-config-readback、
factory-smoke、connection-registration-check/proposed-blocked）。

来源/声明未伪造：`public_time.status=unknown`；来源角色
`definer/first_publisher/deliverer`、权威 `eastmoney.unadjusted_daily_bars` 均来自
实际请求；未把公开时间、时区、单位或复权状态写成未知之外的 known。

## 代码

- `adapters/database/wfd-product-machine.ts`：新增 submit/recovery/evidence_ingest/
  request_status/read_product/batch_*/schema/service_capabilities 方法；仍只经受控
  config 传 root/principal/权限。
- `modules/financial/product-machine-connection.ts`：从 `ResourceBindings` +
  `connections_registry` 解析 `wfd-product-machine` user_test 连接，构造 client +
  算法固定快照端口；校验 harness root/root_id、config_path、store/runtime、调用者。
- `scripts/adopt-product-machine-wiring.ts`：受控登记入口。默认 check，`--apply`
  才原子写 connections_registry；不碰 SQLite、line-selection、旧 prod 默认或任务。
- `scripts/run-wfd-product-p6.ts`：真实生产者/消费者流程；不接受 root/principal/
  权限参数，全部从 `--config` 受控配置读取。

## 连接登记状态

用实际 `ResourceBindings` 检查候选登记合同：
`run_20261027_final/connection-registration-check.json`

```json
{"status":"ready","connectionId":"wfd-product-local-20261027",
 "registryPath":"/Users/mashiro/.config/credentials/connections.json",
 "applied":false,"wouldAdd":true,"entries":12}
```

这说明受控入口已能读取实际运行根/连接登记，并且只差显式 `--apply`。本会话不写该
登记，原因是运行根与 WFD 证据目录均不在会话写范围；**不是**用复制配置冒充已登记。

最终拟用路径（`connection-contract.proposed.json` /
`product_machine_config.proposed.json`）：

- config：`<WFD根>/03_测试与验证记录/P6_xuanBD联调_2026-10-27/actual/product_machine_config.json`
- store：同目录 `store/`
- runtime：同目录 `runtime/`

当前 `run_20261027_final/connection-registration-proposed-blocked.json` 明确报
`ENOENT ... actual/product_machine_config.json`；需要主审/ WFD worker：

1. 创建上述 `actual/store`、`actual/runtime` 目录；
2. 把 `product_machine_config.proposed.json` 复制为 `actual/product_machine_config.json` 并
   `chmod 600`；
3. 运行
   `node --import tsx scripts/adopt-product-machine-wiring.ts <connection-contract.proposed.json> --runtime-root "/Users/mashiro/xuan BD/运行数据" --apply`；
4. 之后 `resolveProductMachineConnection` 可按 `wfd-product-local-20261027` 构造客户端，
   旧 prod 默认/任务固定连接不变。

`run_20261027_final/factory-smoke.json` 已用测试 ResourceBindings 验证工厂可解析 profile、构造 client
和 `snapshotPort=available`；未声称实际登记已生效。

## 未宣称

- 不是整套 P6/P7 验收；未覆盖 Windows、拔盘、包导入导出、正式生产。
- 算法消费未通过：当前合同仍缺结构化 frequency/adjustment/bar_closed/availability/
  currency；未硬过算法端口。
- 本 run 的 store/runtime 是工作区候选验证位置（`store_run3`/`runtime_run3`）；
  实际登记 store/runtime 待上述 WFD 写权限会话创建后重跑。
- 未读 WFD 私有 catalog；仅使用公开 process 响应和 fixture 原始 HTTP 字节。
