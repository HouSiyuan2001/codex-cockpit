# Token 已记录，为什么金额没有？

Token 来自本机 Codex 的用量记录；金额是拿这些记录按参考价格计算的，
不是从订阅账单“读取”出来的，也不代表 OpenAI 会另外收取这笔钱。

旧测试包只带了少量模型的价格，其他模型依赖使用者已有的价格表。
这会导致维护者电脑上金额正常，新安装的电脑却只能看到 Token。
现在 Mac 和 Windows 共用下面的内置参考表，不需要安装 Tokei、加入云空间
或复制别人的配置。升级后重新读取本机记录即可补算，不清空原来的历史缓存。

## 内置参考价

以下是 2026-10-12 核对的 **Standard API 文本价格**，单位为美元 / 百万 Token。
GPT-6.1 Terra 于 2026-10-27 按官方模型页补充核对。
价格表编进 App，可以离线使用；并非每次启动联网更新价格。
以后官方调整价格，需要更新 App 或使用自己的价格表。

| 模型及官方来源 | 非缓存输入 | 缓存读取 | 输出 |
| --- | ---: | ---: | ---: |
| [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) | 2.00 | 0.10 | 10.00 |
| [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra) | 1.00 | 0.05 | 5.00 |
| [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) | 10.00 | 1.00 | 50.00 |
| [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) | 2.00 | 0.20 | 10.00 |
| [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) | 0.10 | 0.01 | 0.50 |
| [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) | 4.00 | 0.40 | 20.00 |
| [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) | 2.00 | 0.20 | 12.00 |
| [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) | 0.20 | 0.02 | 1.20 |

对应完整模型 ID 才计价；兼容同一 ID 的 `openai/` 前缀，不把代际名、
其他服务商或未知变体猜成 Sol、Luna、Astra。自己的有效价格条目和共享空间
的价格优先，内置表只补缺项；不覆盖价格文件，不更改共享配置的 revision。
有效的旧 Tokei 价格及其本地覆盖仍按原兼容规则读取，
但共享空间价格不会被本机 Tokei 覆盖。

## 怎么计算，哪些不能算

短上下文估算为：

`（非缓存输入 × 输入价 + 缓存读取 × 缓存价 + 输出 × 输出价）/ 1,000,000`

输入计数包含缓存部分，先减掉缓存再算非缓存输入，不能重复计费。
输出计数已包含推理 Token，不能把推理 Token 再加一次。
已核对的这些模型，单次输入超过 272,000 Token 时，输入及缓存价乘 2，
输出价乘 1.5；恰好 272,000 使用短上下文价格。

只有可核对的单次用量与累计增量一致，才确认计价档位。
历史事件缺少这些信息时保留 Token，但那部分金额仍是未知：
不能拿整天的汇总猜一次请求有多长，也不能把未知补成 $0。
真实零用量仍显示 0。

默认金额是 **标准价的参考估算**。目前不自动推断 Fast / Ultrafast / Batch /
Flex、区域附加费、独立缓存写入或工具调用费用，不用于对账或结算。
这些档位和费用见[官方定价说明](https://developers.openai.com/api/docs/pricing)。

## 界面和验收

“用量 → 统计说明”显示内置表来源和核对日期；
缺价与缺少单次记录分别解释，Token 正常不等于金额资料完整。
金额资料不完整不会阻止完整 Token 记录更新；真正的扫描失败仍会保留旧缓存。
若只有对方设备的旧快照没有金额，应在那台设备升级、重新采集，
再按使用者已有的同步设置上传；不要要求把对方配置、登录文件或完整会话发来。

两平台同项验收：没有 `.tokei`、没有云配置的新用户，
分别使用上述模型的合成事件验证金额；模型排行、任务排行及日趋势一致。
重启／二次扫描不重复累加；升级不丢旧缓存和成员设置；
自己的价格、共享价格不被替换；缺价和缺上下文不产生虚假零金额。

Mac 安装包目前仍是 ad-hoc 签名测试包，不是 Apple 公证版本。
App 不自动执行 `xattr -cr`、移除下载隔离标记或关闭系统保护。
更顺畅的公开分发需要正式 Developer ID 签名和 Apple 公证，
见 [Apple 分发说明](https://developer.apple.com/developer-id/)；
证书、账号和公证提交需要维护者另行配置和授权。
