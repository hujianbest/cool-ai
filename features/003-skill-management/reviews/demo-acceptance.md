# Demo 验收 (S-2.5 / 003-skill-management)

- 日期: 2026-07-26
- 演示物: evidence/demo-home.png(浏览器渲染:创建 Skill 表单 + Skill 列表 + 创建 Agent 表单 + Agent 列表);evidence/smoke-*.log(真实:创建 skill → 创建 agent 关联该 skill → agentCount=1 → 浏览器渲染 skill/agent/被关联数);体验路径 `npm run dev` → http://localhost:3000,创建一个 skill → 创建 agent 时勾选该 skill → 列表显示关联名与被关联数
- 结论: 接受
- 用户确认: auto-approved 2026-07-26(auto 模式;下次与用户交互时主动呈上 demo 证据征求反馈)

## 反馈
- auto 模式下由作者代验收;demo 证据已落盘,待下次用户交互时呈上。
- 演示判据("创建/查看 skill + agent 关联已有 skill + 关联可见")已由 smoke(真实创建+关联+agentCount+浏览器渲染)与 51 测试闭合。
- 借鉴 Hermes:skill 为被管理一等实体(SKILL.md 精简:name/description/content/category)、progressive disclosure(索引轻量,详情按需)、agent 关联引用(非静态勾选)。edit/delete、Skills Hub 联网、bundle 等推迟(A-16 / 后续切片)。
