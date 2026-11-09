# 固定结构化筛选与 BD 联合检索

实现协议为 `wfd.filter-objects/1.4-product1`（有界结构化筛选）。机器请求和结果分别受 [请求模式](schemas/wfd-filter-plan.schema.json)、[结果模式](schemas/wfd-filter-result.schema.json) 校验。实际机器 `capabilities`（能力）返回两份模式身份与摘要；当期应用支持范围由 [BD_RELEASE.json](../../../BD_RELEASE.json) 声明；接口存在不能视为完整 WFD 生产发行或历史资格验收。

## 正常本地入口

接口沿用绑定连接、来源门和资料代次；调用方不能指定数据库路径、角色、命名空间、内部写入绑定或行版本。以下入口均只读业务数据。签名游标的私钥保存于受信运行目录 `query-cursors/filter-hmac.key`，不写业务库；恢复运行目录时须保留该文件，缺失时旧游标明确失效。

| 动作 | 本地路径 |
|---|---|
| 取得当前活动头并固定编号 | `POST /api/bd/r1/products/snapshot` |
| 发现固定产品、主体及字段合同 | `POST /api/bd/r1/products/discover`，参数 `{snapshotId}` |
| 结构化筛选 | `POST /api/bd/r1/query/filter` |
| 已登记文档索引 | `GET /api/bd/retrieval/index-versions` |
| 联合能力 | `GET /api/bd/retrieval/joint/capabilities` |
| 按核对回链联合资料 | `POST /api/bd/retrieval/joint` |

筛选页面从实际发现结果选择产品、对象和十进制字段，不需要填写内部产品编号。它保留原固定快照读取区。当前页面尚无可发现的实例持有范围，因此不让用户猜 `held_scope`（持有范围），相应选项明确禁用；机器原语仍可在确有实例台账时接收该资格。

## 筛选参数

本地筛选接收以下内容；`protocol_version`（协议版本）、`operation`（操作）和预算由受信宿主注入。直接机器调用则按请求模式完整填写。`metric`（本次指标别名）只用于本次计划，不是新的全局指标登记。

```json
{
  "dataset_id": "实际数据集",
  "snapshot_id": "实际固定快照",
  "history_mode": "snapshot_contents",
  "knowledge_cutoff": null,
  "held_scope": null,
  "usable_stage": null,
  "universe": {"kind": "explicit_subjects", "subjects": [
    {"kind": "region", "namespace": "实际命名空间", "id": "实际对象"}
  ]},
  "metrics": [{"metric": "reading", "field": "实际数值字段", "bindings": [
    {"subject": {"kind": "region", "namespace": "实际命名空间", "id": "实际对象"}, "product_id": "实际产品"}
  ]}],
  "business_time_range": {"role": "observation", "start": "2026-01-02", "end": "2026-01-02", "timezone": "UTC"},
  "predicate": {"compare": {"metric": "reading", "op": ">=", "value": {"data_type": "decimal", "value": "10.00", "unit_code": "实际固定单位"}}},
  "order_by": [{"kind": "subject", "direction": "asc"}],
  "page_size": 20,
  "cursor": null
}
```

- 显式集合支持 `entity`（主体）、`instrument`（证券工具）、`listing`（挂牌）和 `region`（地区），机器上限100个对象、16个指标；不推导证券到公司的关系，不展开行业成分。
- 产品与完整对象身份一一核对；同一指标别名跨对象的字段、业务定义及语义口径须一致。字段来自实际固定合同；覆盖矩阵编号不能代替字段。单位由合同决定，不按请求重定义。
- 支持 `compare`（单值比较）、`between`（显式开闭区间）、`in`（最多64个同类型常量）、`compare_metrics`（同产品相容字段比较），以及 `and/or/not`（并且、或者、否定）。树深度最多8、节点最多64。不计算财务比率，不触发计算或登记。
- 只支持十进制点值及精确原值比较；常量为有限十进制字符串，单位必须一致，无隐式汇率、倍率、币种、准则或期间转换。来源精度未知不等于底层真实值精确。
- `reported_zero`（报告为零）可以参与比较；缺数保持未知。否定未知仍为未知，或者中的真分支可成立，数据覆盖缺口仍保留。
- 每个对象/指标/期间须唯一选出一条合格行；范围内多条不同记录返回 `ambiguous`（未消歧），不取首条、平均或隐式最新日期。
- 排序可指定完整主体或指标升降序、空值位置，最终均以完整对象身份打破并列。HMAC（消息认证码）游标绑定查询、快照、固定定义/合同、当前权限和完整末尾排序元组。后续页重新核对权限和产品政策。

本地每页最多100个对象，单次预扫至多5,000个候选行和16 MiB，完整返回至多2 MiB，等待30秒。机器边界上限为每页500个对象、200,000个候选行和256 MiB；响应保护仍32 MiB。元数据链和每次真实底层页读的保守额度合计入预算，不是任意 SQL、常量内存或硬执行时间保证。后续对象页重新扫描同一个有界固定计划，不能据此宣称多年容量闭包。

## 时态、状态与证据

`snapshot_contents`（快照内容）只复现固定内容，三个历史资格参数须为空。`market_known_at`（市场当时已知）复用原公开时间资格；`system_held_at`（系统当时持有）另须实际实例、持有范围与阶段台账。知识截止使用既有 `TimeWithPrecision`（带精度时间）规则：秒精度用起点，粗精度保守采用区间下界。缺证明返回真实底层缺口，不补造公开时间或实例持有。仅当前业务值产品仍要求当前活动头并拒绝历史模式，技术固定读不产生业务历史承诺。

扫描完成、数据覆盖和分页穷尽分别返回。`budget_exceeded`（预算不足）不返回部分命中冒充完整；只有末页才设置 `result_exhausted=true`（结果已穷尽）。有未知对象的零命中返回 `coverage_insufficient`（覆盖不足），完整无命中才为 `empty`（完整空集）。每个实际比较值带记录/版本、固定产品/字段、定义/合同、业务时间、单位、状态和精确比较规则；WFD 不返回 BD 原件与加工定位。

联合请求是 `{structured: 筛选参数, documents: {method, query, limit, indexVersion, mode, asOf}}`。文档索引必须显式固定，每对象最多50条引用。历史查询要求文档资格模式与结构化模式完全相同，`asOf`（知识截止）严格等于结构化知识截止的保守起点。快照内容联合须显式 `mode=null,asOf=null`，只作内容关联，并保留“不具历史资格”说明；绝不映射成文档历史模式。

关联只沿已完成真实固定读回的 `dataset/product/record/version`（数据集、产品、行、版本）回链，再沿冻结加工计划/输出绑定到具体材料。既有原件取得身份与相同字节的其他来源不会被合并。SQL（结构化查询语言）在限制结果条数前限定这些材料，再调用既有 `SegmentService`（文档片段服务）的公开时间、取得时间、解析时间、索引与版本门。文档检索返回的原 `bd.doc-retrieval/2`（文档检索协议）保持原义。缺行关联、材料链、索引或合格历史证据均单列。文档索引和检索参数摘要一并进入 WFD 签名游标，不能在续页时换资料范围。

当前本地材料没有逐文档权限模型；字段级权限和分类体系扩展也未被宣称实现。新联合端点接通不等于这些边界已经验收。

## 提交信封与恢复

原机器 `ok=true`（请求信封已处理）继续兼容，不表示业务发布。`submit/recovery/batch_finalize`（提交、恢复、批次封存）新增 `business_outcome`（业务结果），明确状态、快照及是否正式发布；调用方仍须核对逐输出发布状态和固定读回。结构化前置拒绝在可识别且受信的原请求身份下持久入账，重开可查询，同身份同内容可幂等读回，改内容拒绝冲突，未受信身份不会写拒绝台账，已发布身份不会被后来的畸形请求覆盖。
