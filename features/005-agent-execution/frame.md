# 005-agent-execution Frame

- 日期: 2026-07-26
- 意图: 单 agent 单轮执行。用户给一个 agent 发任务;后端用 agent 的 providerConfig(key)+ model 调 OpenAI 兼容 `chat/completions`,system prompt = agent.systemPrompt + 关联 skill 的 content 注入;返回 assistant 回答 + 执行轨迹;UI 可见。
- 切片: S-3
- 范围外: agentic 工具循环(function-calling + file/shell/web 执行,S-3b);流式输出(SSE);多 agent/项目组(S-4/S-5);运行历史持久化;中断/重试 UI;模型高级参数(temperature 等,第一版默认)。
- 模式: 建造
- 风险档位: 2
- 档位理由: 新功能(LLM 调用 + 读取 agent/skill/provider 配置)。不执行 shell/文件副作用(工具循环在 S-3b),故非"不可逆操作/安全面";跨模块为新增(runner + run API + run UI)而非破坏性重构;无对外 API 契约破坏、不碰认证/数据迁移。拿不准项(真实外部 LLM 调用)已按"关键节点可观察 + 上游失败 502"兜底,不达档位 3。
- 用户可感知: 是
- 环境基线: evidence/baseline-20260726T153419Z.log (exit 0)
- 基线说明: 沿用 S-1~S-2.7 测试套件(74 用例)。
- 假设:
  - 运行入口:POST /api/agents/:id/run,body `{task}`;需 agent 已配 providerConfig(否则 400)。
  - runner:加载 agent(systemPrompt/model/providerConfigId/skills)→ 加载 providerConfig(baseUrl/apiKey)→ 加载关联 skill 的 content → 构建 messages(system = systemPrompt + skill 内容拼接;user = task)→ POST `{baseUrl}/chat/completions`(Authorization Bearer key、body {model, messages})→ 返回 choices[0].message.content。
  - 轨迹:`trace: [{role:"system"|"user"|"assistant", content}]`;`output`:assistant 文本。
  - 失败:providerConfig 未配 → 400;上游非 2xx/网络 → 502 `{error:"upstream error"}`;不泄漏 key。
  - UI:AgentRun 面板(选 agent + 输入 task + 运行按钮 + 展示 output/trace 三态)。
  - 真实 LLM 调用需用户已通过 UI 创建真实 provider 配置(baseUrl+key);单测与 smoke 用 mock 上游。
