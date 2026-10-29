# WFD 金融产品开发版 0.3（P1 治理候选）

本版在存储引擎 1.0.0 的既有源码之上增加产品服务和独立交付，不改冻结存储源码、BASE 1.1 或 V1.3-impl1 规范包。当前实际范围是平安银行的 2026 年第二季度日线、同期深交所日历、2026H1 财务披露和公告，以及解释这些数据所需的基础身份、单位与证据。

## 实际完成的产品

| 类别 | 数据和语义 |
| --- | --- |
| 身份与关系 | 公司、证券工具、挂牌、市场分别建身份；公司—证券—挂牌—市场关系分别存储 |
| 交易日历 | 深交所接口返回的 91 个自然日及 60 个交易日，保留周末和休市日 |
| 单位定义 | 16 项本批基础单位及语义标记，包含金额倍率、每股/每10股、每手100股和周序约定 |
| 行情 | 东方财富 60 行不复权日线，价格、量额和交易日不丢失 |
| 财务 | 正式半年度报告摘要及董事会公告中的 6 个明确口径字段，原值、单位与转换依据可追溯 |
| 公告 | 官方元数据、董事会决议原件和报告摘要；补充证据形成新版本，旧版本保留 |

固定发布后的产品定义、四合同、读取依赖及逐行版本绑定嵌入 Manifest（文件清单）。稳定产品身份与每次发布的合同版本分开，依赖版本改变不会改写旧快照。

## 产品服务接口

`wfd_sdk.product_service.WFDProductService`（产品服务）继续接收 V1.3 结构化请求；当前服务版本为 `wfd.product-service/0.3`。扩展位于原协议允许扩展的 `source_bundle.product_service` 中：

```json
{
  "version": "wfd.product-service/0.3",
  "outputs": {
    "output_key": {
      "read_dependencies": [
        {
          "dataset_id": "固定数据集",
          "product_id": "固定产品",
          "snapshot_id": "固定快照",
          "role": "读取用途",
          "required": true
        }
      ],
      "revisions": {
        "原逻辑业务键": {
          "previous": {
            "product_id": "原产品",
            "snapshot_id": "原读取快照",
            "logical_key": "原逻辑业务键",
            "revision_id": "原版本"
          },
          "reason": "有证据的更正、修复或撤回原因"
        }
      }
    }
  }
}
```

`previous`（前驱引用）必须来自真实固定读取返回的 `record_ref`（记录版本引用），不能自行猜测。修订使用既有 `source_correction`（来源更正）、`processing_repair`（加工修复）或 `withdrawal`（撤回）模式。底层只追加唯一物理版本，正常读取按原逻辑键选择当时有效版本；撤回作为墓碑保留原值供审计。

主要调用包括：

- `submit(doc)`：显式调用者/来源权限、通用合同校验、动态登记、合同绑定及逐输出回执；保管、登记、校验、正式发布和待激活分别表达。
- `request_status(request_identity)`：按原请求身份读回持久状态；登记成功但提交失败、待激活或正式发布都可查。
- `discover_products(snapshot_id=...)`：按固定快照发现实际产品和合同版本。
- `read(..., snapshot_id=..., perspective=..., at=..., include_history=...)`：固定读取及三种历史视角，按需返回修订链。
- `company_view(company_ref, snapshot_id=...)`：公司到证券、挂牌、市场的限定关联；先判断公开资格和关系有效期间。
- `read_calendar(product_id, snapshot_id=..., start_date=..., end_date=...)`：按明确字段读取交易日历，范围包含起止日。
- `trace(product_id, snapshot_id=...)`：读取固定定义、合同和真实保管的原件摘要。

依赖在提交和读取时核对；复用产品时，若旧读取合同已有依赖，新提交必须显式重述，不能以“无扩展”静默清空。未知公开时间保留不可判定诊断；`system_held_at`（系统持有视角）限定为源数据集真实接收结构化数据的阶段，不倒填历史持有。导入副本保存这段原始持有史，其自身导入时间由导入回执记录；目标实例自身的持有视角尚不单独提供。

## P1 治理边界

- 调用者角色显式区分 `evidence_write`、`register`、`submit`、`publish`、`read`、`read_evidence`、`export`、`redistribute`；未传入角色默认无权限。`caller_id` 只作审计标签，不是授权来源；允许的 `trusted_actor_namespace` 由本机构造配置显式绑定，并从请求身份校验。
- 来源策略必须显式给出 `may_submit`、`may_publish_formal`、`may_export`、`may_export_evidence`、`may_redistribute`（默认全部为否）；`usage_scope` 和导出范围也必须明确。0.2 的 `may_publish` 只作为 `may_submit` 的兼容别名，不授予正式发布、读取或导出。包导出会检查参与输出的全部 `source_ids`，不会只检查主来源；再分发还需调用者 `redistribute` 角色和全部来源显式授权。
- 正式发布不是把 `published_sandbox` 改名：服务检查调用者正式发布角色、来源正式授权、合同/定义摘要、读取依赖、证据保管、Commit Marker、固定快照，并按本次发布的固定 revision id / 行内容摘要核对（追加、修订、撤回不按整产品行数粗判），通过后另写不可变 `formal_publications` 收据。底层引擎原始回执仍保留 `published_sandbox`，`production_publishable` 仍为 false；P1 的“正式”是产品服务治理层的本机限定发布，不等于 P7 生产部署验收。
- 已完成的正式/沙箱请求按原事实幂等回放，不因当前权限或政策变化自动升/降级；未完成 prep 的重试重新检查当前调用者、来源域和依赖。
- 产品注册记录带 `product_family_id`、`definition_sequence`、`definition_parent_ref`、`definition_compatibility`；单位/口径等实质变化形成新的定义版本并保留旧定义/旧快照读取，不静默改写。定义使用的单位必须出现在本机构造的可信单位注册表中；未知单位最多登记，不会正式发布。单位注册表是可注入的 P2 接缝，不是固定白名单。
- 四合同分别计算版本摘要并嵌入合同集合：语义、读取与布局、算法与依赖、更新与发布。字段合同检查类型、空值状态、单位兼容性、十进制精度/尺度、业务时间、主键和显式依赖。
- 单位目录的完整量纲目录、身份历史解析和精确依赖推断仍留 P2/P3；本版仅对已知单位做兼容性检查，未知但格式合法的单位不冒充已解析。

## 完整金融产品包

`wfd_sdk.product_bundle`（金融产品包模块）提供：

```python
descriptor = export_financial_bundle(service, product_ids, destination, snapshot_id=snapshot_id)
read_service, receipt = import_financial_bundle(bundle, target, runtime_root=runtime)
```

包保留原始快照身份和物理字节，闭合固定读取依赖、产品登记、各版合同、定义、来源原件及保管记录。当前按整快照携带，额外产品和仅为谱系携带的历史元数据在清单中列明；不冒称精确裁剪的最小包。

导入在新目标按同一快照真实读回，不依赖源数据路径或源 SQLite（可重建索引），不自动激活写入主端。运行仍需要本版本的软件与依赖；数据包完整性不等于免安装的独立应用。

导出许可由可信本地策略明确授予，本次范围为 `user_local_validation_only`（用户本机验证副本）；来源许可未知保持原样，不转成对外再分发许可。

## 复现这批数据

在本目录使用已有依赖运行：

```sh
python scripts/acquire_financial_products.py
python scripts/run_financial_products.py
```

获取脚本复用已有原响应缓存，生成 `fixtures/financial_products/inputs.json`（结构化输入），不依赖临时脚本。运行脚本在项目测试记录中创建新的专用库和独立读回目标，并保存请求、回执、产品目录、历史读取、证据追溯和比较结果。

本轮最终结果见项目 [第三阶段建设记录](../../第三阶段建设记录.md)。首次集成发现的日历整数字段编码问题及后续补齐单位依赖的运行各自保留，没有覆写旧证据。

## 当前明确边界

本版本完成单证券范围的真实业务闭环。历史公司名称、关系期间及行情/日历的原始公开时间仍有未知，严格历史关联保留诊断；拟分红不记为已支付。完整包支持本机独立读取，增量包、严格历史资格裁剪、跨数据集依赖和可选依赖暂不支持，会返回具体原因。

产品层尚未提供能保留逐行版本绑定的压缩流程，不能直接调用底层压缩后假定产品修订链仍有效。整体生产验收标志保留未通过，存储 1.0.0 的已有发布范围不因本版业务增加而扩大。
