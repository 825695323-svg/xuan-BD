# BD 内置 WFD 产品引擎

内置 WFD（金融数据库）的机器入口为 [product_machine.py](wfd_sdk/product_machine.py)，由所选连接配置指定程序和实例。启动与绑定见[工程说明](../../README.md)，应用版本见 [BD_RELEASE.json](../../BD_RELEASE.json)。

## 表格批量发布

卷连接的 `data_only` 入口通过 `capabilities.service_capabilities.bulk_tabular` 声明 `wfd.tabular-batch/1`。分钟原报和其他表格走相同的分片、账本和发布流程。历史 `wfd.source-minute-batch/1` 快照继续按原格式读回。

- `batch_begin` 接受 `batch_id`、`header` 和按 `ordinal` 排列的 `expected_chunks`。头部固定请求身份、定义、预期父快照、完整分区、整件行摘要及 `table_contract`。合同声明 1–64 个有序文本字段、业务键字段、可选分区字段及时间映射。分区为非空文字标签；有分区字段时逐行核对，没有时使用显式分区值。时间可以未知，也可以由合同指定来源日期、分钟标签及时区；通道不从字段名推断时间、单位或金融含义。
- `batch_put_chunk` 接受 `batch_id`、`output_key`、`chunk_id`、`rows` 和 `digest`。行是按合同字段顺序排列的文本和空值数组。整件须按键字段值的 UTF-8 字节元组严格递增；行摘要逐行使用规范 JSON 和 LF。请求摘要覆盖移除 `request_identity.submission_digest` 后的头部，分片边界不参与请求身份。
- `batch_finalize` 在分片齐备后校验定义、合同和整件；产品首次绑定后不允许更换表合同。相同分区内容沿用原定位和版本，变化按整件冲突处理。使用原编号通过 `batch_status` 只读核对状态；中断后原编号 finalize 复用候选或完成暂存回收。
- `batch_read_page` 按 `snapshot_id`、`product_id`、`partition`、`result_root` 固定读取。机器入口从快照格式选择读取方式，无需改动调用参数。游标绑定定位，每页至多请求 5,000 行，行数组仍受 768 KiB 限制。回执与页面携带定义、合同和整件行摘要，新协议另含 `table_contract_digest`。验收应核对全部行、顺序及摘要。

新目录通过分区标签摘要分桶，标签不用于文件路径；历史目录保留按年和日的定位。两种目录的叶节点均引用内容寻址的 Parquet 文件组。普通发布继续使用实际 HEAD 和 CAS（比较并交换），继承两个批量目录根；批量发布也继承其他格式的目录根和最近的普通快照。

批量产品使用固定分区读回，普通读写仍可按固定产品访问普通数据。全库读回、全快照上下文查询、GC（垃圾回收）、导出、迁移和索引重建遇到未支持的批量闭包会明确报错。
