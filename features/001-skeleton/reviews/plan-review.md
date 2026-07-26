# plan.md 评审 (第 2 轮 复审)

- 日期: 2026-07-26
- 评审方式: subagent
- 结论: 通过
- 用户确认: 2026-07-26

## 第 1 轮 findings 闭合情况

### 一般级

- [已闭合] 可访问性 NFR 无任务覆盖/无验证方式 — §1 NFR-1(line 42)已写出满足机制(语义 landmark / focus 样式类 / token 推导对比度 16:1)与验证方式;§3(line 72)补"可访问性验证"小节;T-4(line 109)覆盖标注含 NFR-1 并落到 `getByRole('complementary')`/`'main'` 与 focus 样式断言。
- [已闭合] T-1 不是 TDD 循环、未打通最薄端到端 — T-1(line 106)改为"脚手架 + 最薄端到端(硬编码穿透)",明确"一条组件测试先红(无页面)后绿(渲染硬编码 name)",并以硬编码 `/api/agents` + 客户端 fetch 打通 UI→API→(占位)→UI 三层;符合第 1 轮建议的"哪怕一条硬编码记录打通三层"。

### 建议级

- [已闭合] PD-3 缺 ≥2 方案对照 — PD-3(line 52)补方案 A(逻辑直接写在 handler 内)与方案 B(thin handler + service),给出取舍点(独立单测 vs 多一个文件)。
- [已闭合] Tailwind 被当事实 — §4(line 95)标注"Tailwind CSS(假设 A-13,待确认;可逆,不影响数据通路)",对齐假设台账纪律。
- [已闭合] 测试依赖未入任务 — T-1(line 106)判据显式含"装 vitest node+jsdom 环境、@testing-library/react、@testing-library/jest-dom"。
- [已闭合] 既有 DS 复用说明缺失 — §4(line 79-80)"既有 Design System"小节声明绿地项目无既有 DS/品牌规范;§2(line 47)现状说明同步呼应。
- [已闭合] FR-1 "含应用标题"未绑定具体值 — FR-1(line 15)改为"HTML 含标题文本 `COOL AI`(见 §4 标题值)",值与出处双绑定。
- [已闭合] plan 缺范围外章节 — 新增 §0 范围外(line 6-7)引自 frame,列明 LLM/认证/部署/角色模板不做。
- [已闭合] error 态重试按钮无对应 FR — FR-3(line 32)补"UI 进入 error 态并显示 error 文案 + 重试入口(重试为 error 态 UX,见 §4 组件契约)",FR 与 UX 定位双锚定。
- [已闭合] AgentList 组件契约不具体 — §2(line 60)写出契约:无必填 props、自行 fetch、状态机 `{loading,success,empty,error}`、error 态重试行为、测试可注入初始 status。
- [已闭合] 路由 handler 无单测(未说明理由) — §3(line 71)与 T-3(line 108)说明 handler 层 thin、逻辑在 service 已单测,HTTP 格式化与 500 路径由 verify smoke 覆盖、理由回指 PD-3。

## 新增 findings
无
