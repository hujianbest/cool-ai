# Demo 验收 (S-2.7 / 004-provider-management)

- 日期: 2026-07-26
- 演示物: evidence/demo-home.png(Skill/Provider/Agent 三段);evidence/smoke-*.log(真实:创建 provider 配置、apiKey 全链路不泄漏、创建 agent 关联 provider+model、agentCount=1、浏览器渲染 provider+agent+model 且 DOM 无 key);体验路径 `npm run dev` → 创建 provider 配置(填 baseUrl/key)→ 创建 agent 选配置+模型(查询 /models)→ 卡片显示
- 结论: 接受
- 用户确认: auto-approved 2026-07-26(auto 模式;下次与用户交互时主动呈上 demo 证据征求反馈)

## 反馈
- auto 模式下由作者代验收;demo 证据已落盘,待下次用户交互呈上。
- 演示判据("创建 provider 配置 + 查询模型 + agent 关联 + 关联可见")已由 smoke 与 74 测试闭合;apiKey 不泄漏经代码评审全链路核查 + smoke DOM 反查确认。
- 模型查询(/models)happy-path 由单测(mock 上游)覆盖;真实上游查询需用户填入真实 baseUrl/key 后在 demo 中验证(S-3 执行也会用)。
