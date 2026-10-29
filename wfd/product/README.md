# WFD V1.3｜正式 DuckDB / Parquet 引擎替换候选

**状态：候选代码已完成；本云端环境的官方 DuckDB 引擎执行被依赖安装阻断；没有通过正式存储闭环验收。**

## 本次替换范围

从上轮实验性 `parquet_lite.py` 复制出独立候选分支，不覆盖或修改 BASE 1.0、V1.3 机器协议与原 POC：

- `wfd_sdk/duckdb_sdk.py`：沿用现有入库业务校验、动态产品身份、不可变 Manifest/Snapshot/Commit Marker、幂等与读回控制层，但将写读函数指向 DuckDB 后端；不自动退回实验编码器。
- `wfd_sdk/duckdb_storage.py`：借助官方 DuckDB 的 `COPY ... FORMAT PARQUET, COMPRESSION ZSTD` 写文件；使用 `read_parquet`、`parquet_metadata` 和 `DESCRIBE` 验证格式与读取。包含原生 DECIMAL、TIMESTAMP、文本和关系/事件字段，并同时保留 `row_json` 供样本无损回传。
- `tests/test_duckdb_engine.py`：9 组依赖官方引擎的测试（四种载荷的真实 ZSTD Parquet、缺失值、固定快照、独立小库、十进制精度、发布前故障）。
- `tests/test_duckdb_adapter_static.py`：13 组不依赖 DuckDB 的类型、精度、列名、时间和 SQL 路径转义测试。
- `.github/workflows/duckdb-poc-validation.yml`：需要将此目录放进 GitHub 仓库后由 Actions 运行；Linux、Windows、macOS 三个平台执行引擎测试和 Demo。**尚未触发 Actions。**
- 原来的 `parquet_sdk.py`、`parquet_lite.py` 及回归测试只用于对照；正式候选 Demo 不会加载实验编码器。

## 在有网络/已安装 DuckDB 的运行环境验证

要求 Python 3.13（示例环境），使用固定的官方 DuckDB 2.0.0：

```bash
python -m pip install -r requirements-duckdb.txt
python scripts/verify_engine.py
```

若不想运行 Demo，可独立运行：

```bash
python -m pytest -q tests/test_duckdb_engine.py
```

验证结果在 `results/duckdb_engine_validation.json`，只有实际写入/读回/文件校验成功后才标为 `PASSED_LINUX_OR_HOST_ENGINE_POC`。缺库时输出 `BLOCKED`，退出码 3，不以旧编码器假冒通过。

**Mac/Windows 机内测试与 exFAT 外置盘实际移动、拔盘、异常断写是不同的验收维度。GitHub Actions 不能替代 exFAT 实机验证。**

## 与 BASE 1.0 的边界

1. 首版仍然接收已结构化候选，不增加 CSV/PDF/图片原件机器载荷。
2. 年、月、日等时间以明确范围保留；精确时间最高到秒。
3. DuckDB 只是文件写入和读取引擎，WFD 语义与历史可得规则仍由原合同约束。
4. SQLite 继续只作为可重建索引；正式快照由 Manifest/Snapshot/Commit Marker 证明。
5. 这只是 **32 行样本规模的引擎替换候选**。`row_json` 冗余列、通过 `bytes` 做临时文件读写、固定单文件批次都是 POC 机制，**不是数十亿行分钟数据的生产方案**。后续需要正式分区写入、批次流式接口、Schema 演进与性能评估。
6. 本项目未引入自动金融计算，不运行模型预测或非结构化内容识别。
7. 样本是先前整理的公开数据摘录，原始上游字节并未全部托管，不可把沙箱发布回执当成正式金融事实认证。

## 本轮实际执行

- 当前容器：Linux / Python 3.13，未安装 DuckDB、PyArrow。
- `python -m pip install duckdb` 因 DNS 解析失败而未成功。官方发行包下载也未成功。
- 原 POC 回归及替换后端不依赖引擎的测试：**68 PASSED**。
- 需要官方 DuckDB 的集成测试：**9 SKIPPED（阻断，不是通过）**。
- DuckDB 写入/读取、ZSTD codec、跨操作系统一致性、exFAT 实机：**NOT_RUN / BLOCKED**。

详情见 `测试报告_云端引擎替换候选.md`。若后续有新测试日志，以实际日志为准，不继承本次的静态测试通过数作为引擎通过证明。
