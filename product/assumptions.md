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
- A-10 2026-07-26 [已推翻] harness/skill 形态原设为"可注入 markdown 模块、内置若干占位"。已由用户推翻:skills 升级为被管理的一等实体(参考 Hermes Skills System / agentskills.io 标准),agent 关联已有 skill,平台具备 skill 管理能力。波及:S-2 的静态勾选池在 S-2.5 被关联模型替换。新模型见 D-14/A-14/A-15。
- A-11 2026-07-26 [生效] provider 通信走 OpenAI 兼容 Chat Completions 协议,便于复用同一 client 适配多家 — 默认理由: zhipuai-coding-plan 兼容该协议,后续接 OpenAI/其他成本低
- A-12 2026-07-26 [生效] 修复 hf_gate.py 的 Windows 兼容性(subprocess shell=True on nt + utf-8 编码/输出),否则交付链无法在本机采集证据 — 默认理由: 纯移植性修复,不改变证据语义(仍执行真实命令、捕获真实输出/退出码)
- A-13 2026-07-26 [已确认] 样式工具用 Tailwind CSS(表达 design token) — 迁入决策实践(S-1 demo 验收 UI 渲染确认);用户接受视觉表现
- A-14 2026-07-26 [生效] Skill 实体最小形态(第一版):name + description + content(markdown 正文)+ 可选 category;对标 Hermes SKILL.md 的精简版。frontmatter 的 version/platforms/conditional-activation 等高级字段推迟。 — 默认理由: 覆盖"被管理+可关联+可加载"的最小集;progressive disclosure(索引只取 name+description)留 S-3 执行时落地
- A-15 2026-07-26 [生效] agent 与 skill 的关联用"skill id 数组"存于 Agent.skills(JSON 列,沿用 S-2 PD-2 取舍),不引入关系表 — 默认理由: 与现有 tools/skills 存储一致,迁移成本最低;未来需按 skill 反查 agent 再升关系表
- A-16 2026-07-26 [生效] skill CRUD 第一版只做 create + list + view;edit/delete 推迟至后续切片 — 默认理由: YAGNI,S-2.5 演示判据只需"创建/查看 skill + 关联";edit/delete 在真正需要在线编辑时再加
- A-17 2026-07-26 [生效] ProviderConfig 实体最小形态:name + baseUrl + apiKey(+ createdAt);apiKey 存本地 SQLite dev.db(gitignored),单用户本地 MVP 可接受 — 默认理由: 覆盖"用户自填接入 + 复用";未来引入加密/外部密钥管理(生产化时)
- A-18 2026-07-26 [生效] 模型选择:服务端用 ProviderConfig 的 key 查询 `{baseUrl}/models`(OpenAI 兼容),返回模型 id 列表供前端选;agent 存 providerConfigId + model(字符串) — 默认理由: key 不下发浏览器(服务端代理查询),复用 OpenAI 兼容 /models 约定
- A-19 2026-07-26 [生效] ProviderConfig CRUD 第一版只做 create + list(+ 删除可选);edit 推迟,同 A-16 取舍 — 默认理由: YAGNI;先支持"建配置 + 复用选已有"
- A-20 2026-07-26 [生效] AgentForm 的 provider 字段由静态下拉(PROVIDERS)改为"选已有 ProviderConfig";model 字段为"选定 provider 后查询其模型列表再选" — 默认理由: 对齐 D-15;移除 PROVIDERS 常量(FR 级迁移,适配既有测试)
