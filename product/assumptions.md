# 假设台账

agent 替用户做的默认选择。遇到欠定点的标准动作: 提出带默认值的选项 →
记录一条假设 → 继续推进;禁止静默填补。
状态: 生效 | 已确认(迁入 decisions.md)| 已推翻(评估波及,回对应阶段返工)。
格式: `- A-<n> <日期> [状态] <假设内容> — 默认理由: <一句话>`

- A-1 2026-07-26 [已确认] 全栈框架用 Next.js(App Router)+ TypeScript — 迁入 D-4
- A-2 2026-07-26 [已确认] 数据存储用 SQLite + Prisma — 迁入 D-4
- A-3 2026-07-26 [已确认] 模型供应商:Provider 抽象层,第一版接入 zhipuai-coding-plan(GLM,OpenAI 兼容接口) — 迁入 D-6(原"绑定 Anthropic"已由用户推翻)
- A-4 2026-07-26 [已确认] 交接机制:完全自主流转(agent 自主决定下一步),owner 可随时介入但不逐节点审批 — 迁入 D-3/D-5
- A-5 2026-07-26 [已确认] UI 形态:群聊消息流 + 侧栏管理 — 迁入 D-8
- A-6 2026-07-26 [已确认] Agent 配置五要素(名+system prompt+工具+供应商+harness/skill) — 迁入 D-7
- A-7 2026-07-26 [已确认] 内置工具池:文件读写、shell、网络搜索 — 迁入 D-9
- A-8 2026-07-26 [已确认] 产物落盘独立 workspace — 迁入 D-10
- A-9 2026-07-26 [已确认] agent 自进化长期方向、第一版不做 — 迁入 D-11
- A-10 2026-07-26 [生效] harness/skill 形态(第一版):markdown 提示词模块,可注入 agent 上下文;第一版内置若干(如需求整理、TDD、写测试),后续可扩展自定义 — 默认理由: 连接现有 skill 生态,最小可用形态是"可注入的 prompt 模块"
- A-11 2026-07-26 [生效] provider 通信走 OpenAI 兼容 Chat Completions 协议,便于复用同一 client 适配多家 — 默认理由: zhipuai-coding-plan 兼容该协议,后续接 OpenAI/其他成本低
- A-12 2026-07-26 [生效] 修复 hf_gate.py 的 Windows 兼容性(subprocess shell=True on nt + utf-8 编码/输出),否则交付链无法在本机采集证据 — 默认理由: 纯移植性修复,不改变证据语义(仍执行真实命令、捕获真实输出/退出码)
- A-13 2026-07-26 [已确认] 样式工具用 Tailwind CSS(表达 design token) — 迁入决策实践(S-1 demo 验收 UI 渲染确认);用户接受视觉表现
