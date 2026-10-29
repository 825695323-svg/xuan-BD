> 本交付保留方法和字段契约；文中历史样例路径只作格式参考，本包不携带逐股样本。统一命令及当前验证范围见外部说明.txt。

# 基础算子契约

调用入口与日线行情校验见 `indicators.md`。本模块 `kind="operator"`，operation（算子标识）仅支持下表 19 件；不解析公式表达式。`params.field`（输入列）默认 close，也可明确选择行情记录中的其他有限数值列；条件算子接受布尔或有限数值，数值非零为真。附加列可以含 `null`（未知值），但不存在的列直接报错。行情必需 close 本身不可空。

所有算子各有一件正常、一件错误请求，位于 `examples/operators/`；`expected.json` 给出真实运行的关键预期值。该目录数据明确标注为人工合成样例。

| 算子 | 额外参数 | 精确规则 |
|---|---|---|
| ABS | 无 | 输入绝对值 |
| MIN / MAX | `other_field`（另一列）或 `other_value`（常量）恰好一个 | 同行两值的较小/较大值；任一未知则未知 |
| IF | `true_field` 或 `true_value` 恰好一个；`false_field` 或 `false_value` 恰好一个 | 条件真取真分支，假取假分支；未知条件输出未知；未选中分支不影响结果 |
| REF | `period` 非负整数 | 向前引用 period 条所供观测；0 为本条；历史不足输出空值 |
| MA | `period` 正整数 | 完整 N 条观测的简单算术平均 |
| EMA | `period` 正整数；显式 `init="first_valid"` 或绑定 state（递推状态） | `alpha=2/(N+1)`；`Y=alpha*X+(1-alpha)*previousY` |
| SMA | `period,weight` 正整数且 N>weight；显式初始化或绑定状态 | `alpha=weight/N`；同上递推 |
| SUM | `period` 非负整数 | N>0 取完整窗口和；N=0 按下述累计契约 |
| HHV / LLV | `period` 非负整数 | N>0 取完整窗口最大/最小值；N=0 按下述累计契约 |
| COUNT | `period` 非负整数 | N>0 为完整窗口内真值数量；N=0 按下述累计契约 |
| CROSS | `other_field` 或 `other_value` 恰好一个；可选成对 `previous_left,previous_right` 有限数 | 上期 left≤right 且本期 left>right 时真；其他可确定情况为假；任一所需值未知则空值 |
| EVERY | `period` 正整数 | 完整窗口全部真时真，其他可确定完整窗口为假；窗口有未知即未知 |
| EXIST | `period` 正整数 | 完整窗口至少一个真时真，其他可确定完整窗口为假；窗口有未知即未知 |
| BARSLAST | 无 | 当前真输出 0；此后到最近已观察真值的距离；尚未看到真或中间条件未知时为空，后续明确真值可重新确定 |
| FILTER | `period` 非负整数；必须 `start="observation_start"` | 显式在所供观察起点清空抑制状态。保留一次真值后，其后 N 条强制假；被抑制真值不延长区间。N=0 则第一次保留真之后全部抑制 |
| AVEDEV | `period` 正整数 | `sum(abs(X-窗口均值))/N` |
| STD | `period` 正整数；`ddof` 必填，0 或 1，N>ddof | `sqrt(sum((X-窗口均值)^2)/(N-ddof))` |

`other_value`（另一常量）仅接受有限数或空值。IF 的常量分支还可为布尔值。数学算子的输入列及另一操作数禁止布尔值。所有周期和权重禁止布尔值，不能将 true 当成整数 1。

有限窗口未齐或有空值时输出空值；不会填 0，不会缩短分母。CROSS 首条未给成对前值时为空，不能伪造为 false（未上穿）。EVERY/EXIST 即使部分窗口已有真或假，仍按严格的完整且全已知窗口规则处理。

SUM、HHV、LLV、COUNT 的 N=0 必须显式 `start="observation_start"`（所供观测起点累计）。从所供序列第一个有效输入开始，前缀空值不参加累计；开始累计后任何未知输入使后续累计无法确定。累计只是本输入范围，不是全历史。

FILTER 的起点重置是一项显式研究假设，不证明首条之前没有信号。条件未知时保留“可能发生、可能未发生”两种抑制路径，只有所有路径一致才输出确定真假；路径不一致时为空。已处于确定抑制区间的未知条件仍可确定输出假。这样不会把未知信号当成未发生。

EMA/SMA 的首个有效值作种子或使用显式上期状态；递推建立后出现未知输入，会使后续递推无法确定。绑定状态结构与 `indicators.md` 相同，operation 必须匹配；parameters 包含 `period,field`，SMA 还含 weight；values 只有 previous。状态绑定序列、时区、单位、复权与上期日期；其他算子不支持增量状态。FILTER、BARSLAST 仅按当前输入计算，不提供隐式历史续接。

输出包含每条日期与同名算子值、诊断和方法策略。逻辑输出使用 JSON 布尔值；未知使用 null。示例的浮点预期按声明容差比较，错误示例要求拒绝请求并退出码 2。
