# Xuan BD · 本地数据应用

启动前核对所选运行根的 `.xuan-runtime.json`、`config/machine.bindings.json`（机器资源绑定）和所选连接。启动定位使用 `XUAN_BD_HOME`（运行根环境变量）或明确选择的系统定位文件 `Xuan BD/launcher.json`；资源解析见 [绑定实现](platform/resources/bindings.ts)。应用身份为 `xuan-bd`，接口前缀为 `/api/bd`。

新设备或隔离运行根使用 [配置模板](config/local-web.example.json)，明确指定程序、运行根和定位文件：

```sh
npm ci
npm run build
npm run local:check -- --config=/absolute/local-web.json
npm run local:prepare -- --config=/absolute/local-web.json
npm run local:web -- --launcher=/absolute/new-locator.json
```

开发与维护先读[工程开发规则](../AGENTS.md)；进度、历史与验收证据见[工程外规划](<../../Xuan BD-规划/README.md>)。

运行代理规则由[受信规则文件](modules/agent/instructions/AGENTS.md)及[加载器](modules/agent/instructions/rules.ts)固定读取。内置 WFD（金融数据库）入口见 [WFD 说明](wfd/product/README.md)。
