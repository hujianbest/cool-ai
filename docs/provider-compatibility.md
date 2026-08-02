# Provider 兼容性

Cool AI 当前只承诺下列 OpenAI-compatible HTTP 子集，不承诺各厂商原生 API、流式响应、工具调用协议或本地 Agent CLI。

## 必需端点

### `GET <baseUrl>/models`

用于连接验证：

- Header 包含 `Accept: application/json` 与 `Authorization: Bearer <apiKey>`。
- 成功响应必须是 JSON object，含 `data` 数组；每个条目有字符串 `id`。
- owner 配置的 model 必须精确出现在 `data[].id`。
- 最多接受 10,000 个模型条目。
- 10 秒超时，响应 body 最大 1 MiB。
- 不跟随 3xx 重定向。

### `POST <baseUrl>/chat/completions`

用于协作、execution 和独立复核：

- 请求包含 `model`、OpenAI 风格 `messages` 和 `response_format: {"type":"json_object"}`。
- 成功响应需有非空字符串 `choices[0].message.content`；内容本身是产品 schema 要求的 JSON object。
- 响应必须有 `usage.prompt_tokens`、`usage.completion_tokens`、`usage.total_tokens`，均为非负 safe integer，且 total 等于前两者之和。
- 模型调用 90 秒超时，整个响应 body 最大 1 MiB。
- 不跟随重定向。

Provider 返回 HTTP 错误时，若 body 带有合法 usage，系统可能记录该次真实调用用量；无有效 usage 则标记“未报告”，不会猜测数值。成功响应缺少或报告无效 usage 会使当前 turn/attempt 失败，不提交业务动作。

## 结构化输出

“支持 JSON mode”不只意味着返回可解析 JSON。不同阶段还有严格 schema：

- 协作：公开消息、任务提案/领取、交棒、决策请求或完成提议；
- execution：`list`、`read`、`write`、`command`、`staged` 动作；
- 复核：公开摘要、findings、证据引用、记忆候选，以及 `reject`/`escalate`/`pass` 三选一。

未知字段、越界文本、非法组合或证据引用会被拒绝。协作与复核可在首次结构错误后发起一次格式修复调用；修复仍失败就暂停，不把自由文本当成结构化事实。

## Base URL 与网络

- 只接受 `http:` 或 `https:` URL。
- URL 不能嵌入用户名/密码，也不能带 query 或 fragment。
- 尾部 `/` 会规范化；产品在其后附加 `/models` 或 `/chat/completions`。
- 非 HTTPS 必须由 owner 明确确认。它不提供传输保密，通常只适合受信任本机服务。
- 请求会把任务所需上下文发给 Provider，所以本地优先不等于完全离线。

## 兼容性检查

添加 Provider 后先点击验证，再用两个 Agent 完成一轮真实协作。若验证通过但运行失败，重点检查：

1. `/chat/completions` 是否接受 `response_format: json_object`；
2. `choices[0].message.content` 是否为严格 JSON object 字符串；
3. usage 是否完整、为整数且算术一致；
4. 响应能否在 90 秒及 1 MiB 内完成；
5. Provider 是否返回重定向、HTML 错误页或厂商专有 envelope。

相关故障见[故障排查](./troubleshooting.md)，凭据边界见[安全模型](./security.md)。
