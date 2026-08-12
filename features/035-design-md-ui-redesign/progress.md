# 进度

- 特性: 035-design-md-ui-redesign（对应切片: S-51）
- 当前阶段: ship
- 执行模式: auto
- 已加载扩展: ext-ui-design、ext-design-md
- 完成时间: 2026-08-12

## 状态记录

- 2026-08-12 用户指示「切片追加到既有切片之后」，S-51 在 backlog 追加为排队项（A-238），未进入 implement。
- 2026-08-12 用户指示「自动完成这个特性的开发」，解除排队（A-240），按 auto 模式推进主链；本特性使用项目级 review 豁免（AGENTS.md 当前开发阶段条款，2026-08-09），不伪造评审工件；TDD、全量测试、typecheck、build、浏览器冒烟、axe、真实 UI 验收、任务票勾选、commit 与 push 仍为完成条件。
- 2026-08-12 grill 收尾：Q1=视觉+IA+交互分层推进、Q2=按根目录 DESIGN.md（Apple 语言）实施、Q3=壳层+公共组件首批、Q5=保留三栏+窄屏抽屉，均以 A-240～A-244 落盘（auto 默认，演示验收可驳回）。
- 2026-08-12 用户确认采用 DESIGN.md 作为设计令牌单一事实源方向（grill Q4 倾向确认，正式确认待 Q1/Q2/Q3/Q5 收尾后一并落盘）。
- 2026-08-12 按用户要求将 awesome-design-md 的 Apple DESIGN.md 原文件逐字落盘至仓库根目录 `DESIGN.md`（562 行 / 37,096 字节，与上游一致）；DESIGN.md 为产品级单一事实源（A-239），不随特性目录存放，未改动内容。
- 2026-08-12 产出「暖陶工作台」全页 mockup 案例；按用户指示归档至 `product/ui/cool-ai-design-md-case.html`，作为后续 UI 设计的约束与参考。
- 2026-08-12 implement 完成：T-01～T-05 全部勾选，DESIGN.md 核心 token（色板/字阶/圆角/间距/阴影）完全映射至 tokens.css，亮暗两套 token 投影完成，视觉契约测试全部通过（29 tests），设计目录页创建并通过验收（4 tests），tsc typecheck 与 npm build 成功，smoke contract 测试通过，ship 结果证据落盘 `evidence/ship-result.json`。
