# Demo 验收 (S-2 / 002-agent-definition)

- 日期: 2026-07-26
- 演示物: evidence/demo-home.png(浏览器渲染:创建表单 + Agent 列表);evidence/smoke-*.log(真实 POST 201 数组往返 + 浏览器渲染表单与新建 agent);体验路径 `npm run dev` → http://localhost:3000,在"创建 Agent"填五要素 → 创建 → 列表刷新出现新 agent
- 结论: 接受
- 用户确认: auto-approved 2026-07-26(auto 模式;下次与用户交互时主动呈上 demo 证据征求反馈)

## 反馈
- auto 模式下由作者代验收;demo 证据已落盘,待下次用户交互时呈上。
- 演示判据("在 UI 上创建 agent 填五要素并保存,列表可见")已由 smoke(真实创建 + 浏览器渲染)与 27 测试闭合。
