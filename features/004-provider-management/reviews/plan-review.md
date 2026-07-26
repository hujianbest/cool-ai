# plan.md 评审 (第 2 轮 复审)

- 日期: 2026-07-26
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-07-26

## 第 1 轮 findings 闭合情况

### 一般级(2/2 闭合)

- [已闭合] FR-4 null providerConfigId 降级缺失 — plan.md:40 新增 `Given agent 未关联 provider(providerConfigId 为 null)When 渲染卡片 Then 显示"未配置 provider"(降级,不报错)`,边界验收补齐,与 PD-3 可空语义对齐。
- [已闭合] 组件契约默认值漏标 — plan.md:83 已标注 `AgentForm({onCreated, skills = [], providerConfigs = []})` 与 `AgentList({version = 0, skills = [], providerConfigs = []})`,默认 `= []` 对齐 S-2.5 skills 先例;实现者照契约写不致 TS 破坏,根因(契约歧义)已消除。测试策略未补"默认 [] 保既有用例"一句,但契约已无歧义,该强调不再必要。

### 建议级(1 闭合 / 3 接受现状)

- [已闭合] NFR-1 对比度未量化 — plan.md:51 补 `白字对比度 ≈5.6:1 满足 AA,沿用 S-2`,量化阈值落齐。
- [接受现状] model 下拉三态 error 斁言 — plan.md:106 UI 章节已声明 error(查询失败可重选)三态;handler 层 502 上游失败路径在 plan.md:91 有单测覆盖(line 91: GET /:id/models ... 502),error 机制有证据;组件单测未显式补 error 态斖一断言,但属次要交互、复用同一 fetch 路径,MVP 可接受。
- [接受现状] T-3 判据细化 — plan.md:120 已将 createFlow 归入 T-5(减少双任务碰同文件的歧义,核心诉求部分达成);T-3 判据(plan.md:118)仍以"全量 npm test 绿"隐式覆盖 agentsApi.test/agentService.test DTO 适配,测试策略 plan.md:93 已显式列出适配点(移除 PROVIDERS、provider→providerConfigId+model、fetch mock 应答 /api/providers),实现时可参照,不致遗漏。
- [接受现状] page 状态膨胀 — 第 1 轮 itself 标注"MVP 可接受,记为遗留事项";非阻塞。
- [接受现状] 服务端代理错误日志 — plan.md:86-87 限定 502 响应体 `{error:"upstream error"}` 不泄 key、对外响应不含 apiKey;服务端日志禁记 Authorization header 未显式声明,但本项目为本地 MVP(dev.db gitignored、key 为用户自有第三方 key,非应用认证面),纵深一层可留待生产化切片;不阻塞。

## 新增 findings

无。范围与 frame 一致、决策真实、契约具体、任务清单机器可读、apiKey 不泄漏多层断言完整,未见新增严重问题。
