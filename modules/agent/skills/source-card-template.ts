import type { AgentSkillDefinition } from '../../../contracts/agent-skill-contracts.js';
import type { AgentSkillService } from '../agent-skills.js';

/** 采集源建卡固定流程；路径由宿主资源绑定解析，不写死本机位置。 */
const BODY = `# 采集源卡片模版

发现一个新站点要采集时，按“判重 → 找主站 → 建卡 → 接入 → 验证”走，缺一步就说明缺哪一步。

## 0 先判重：站点和能力是不是已经有了
用 list_actions 逐个看 capture.* 动作，读每个动作字段里 operation 的选项，得到“已登记站点 + 已有能力”清单。
- 同站点、同能力已存在：直接用现成动作，不建卡、不加操作；
- 同站点、缺这个能力：只加操作（第 3 步），不建卡；
- 站点本身不存在：才进入第 1 步建卡。
判重不看卡片标题，看站点编号与 operation 选项。

## 1 找主站点
用户给的是名称、链接或搜索结果时，先定官方主域名：
- 搜索后打开候选首页核对：标题、页脚备案/公司名、证书；只采用能互相印证的那个；
- 拼装域名（多段连字符、夹带品牌词的变体）一律不用，宁可不建也不接钓鱼站；
- 记录：官方首页 URL、站点域名（只写主机名）、登录页（没有就写官网首页）、需要的 Cookie 名（不确定就问用户，不猜）。
查不到的项留空，标待接入，不猜、不填假值。

## 2 建卡
调用受控动作 source.register：编号（小写字母开头、1–32 位，不要用内置站点 id）、显示名称、站点域名，可选登录页、Cookie 名、固定操作名。
- 只写运行根 config/custom-sources.json，不联网、不写凭据；
- 卡片标「待接入」，这一步只完成占位，不叫可用。

## 3 完整接入（改代码，5 处）
1. plugins/capture-sources/contracts.ts：CAPTURE_SOURCE_IDS 增加编号，CAPTURE_SOURCES 写 label 与 loginRequired（公开页 false）。
2. plugins/capture-sources/session.ts：SOURCES 写域名与 Cookie 名（公开源写空数组），LOGIN_URLS 写官网或登录页。
3. plugins/capture-sources/sites.ts：规则（name/path/domain/parameters/method/sha256）、captureSourceURL 的真实落地页、isAllowed 的精确请求白名单（主机+路径+参数，不放通配）。
4. plugins/capture-sources/<sourceId>/<operation>.js：只读固定脚本，头部 @meta 的 name/domain/args 必须与规则完全一致，导出 async function(args)，只 fetch 白名单接口。
5. apps/web/src/ui/DataPage.tsx 的 logos 增加图标文件名，图标放 apps/web/public/logos/。

站点清单变化后，运行根 config/source-settings.json 的 capture 数组必须同步补齐（数量与去重都要匹配），否则启动报 SOURCE_SETTINGS_INVALID。

## 4 官网与 logo
官网以官方首页为准；logo 依次试 favicon.ico、favicon.png，被挡再用第三方图标源；校验下载的确是图标（文件头/file 命令），文件名与 logos 映射一致；取不到用首字占位，不伪造。

## 5 生效与验证
- 必须构建并重启 4317 才生效；没有 build/restart 动作时交用户或主会话执行，代理只能报“待验证”；
- 验证顺序：/api/capture-sources 有该来源 → /api/skills 该动作 available → 真跑一次采集并读回执，成功、待审批、结果未知要分开说，未知不能当成功。

## 6 边界
- 采集只返回原件与来源声明，不承担清洗、标注、入库或定时执行；
- 不代登录、不读密码、不写 Cookie 值，登录由用户在卡片上手动完成；
- 不跑任意命令，站点脚本只走固定脚本通道，不新增 exec 能力。

## 7 完成标准
卡片有名称、官网、logo、操作列表、状态灯、登录入口（或标注公开）；操作能真实返回条目。只完成占位登记的，按待接入报告。
`;






export const SOURCE_CARD_TEMPLATE_SKILL: AgentSkillDefinition = {
  id: 'xuan-harness-source-card-template',
  version: 14,
  title: '来源卡片模版',
  description: '发现新站点时的采集源流程：先判重（站点与能力）、再核主站与官网、建卡、改代码接入、logo 与构建验证；登录始终由用户手动完成。',
  body: BODY,
  source: { kind: 'builtin', identifier: 'xuan-harness:builtin-skill/source-card-template', revision: '14' },
  requiresTools: [],
  enabled: true,
};

/** 幂等登记：同一版本同一正文重复初始化不会改写。 */
export function registerSourceCardTemplateSkill(service: AgentSkillService): void {
  service.register(SOURCE_CARD_TEMPLATE_SKILL);
}
