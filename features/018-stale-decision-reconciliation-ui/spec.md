# 陈旧 Inline Decision 对账 UI 需求规格

- 日期: 2026-08-09
- 特性: 018-stale-decision-reconciliation-ui
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto
- 公共行为接缝: fact-only Structured Block Public UI
- 已加载扩展: ext-ui-design

## 问题陈述

当前 Proposal/Checklist 在 `VERSION_CONFLICT` 后只显示新版本号，未呈现服务端最新完整状态，却允许按旧动作继续提交。owner 无法判断动作在新事实下是否仍合适，辅助技术也不能从 region 名称稳定区分五种正式 block，source loading 没有通过 `aria-busy/status` 被感知。

## 解决方案

把 stale 处理收敛为“冲突 → 禁用旧动作 → 读取并呈现服务端最新完整事实 → 聚焦说明 → owner 显式选择是否以新 operation 重试”。fact-only UI 永不自动重放或沿用旧 operation。五种 block 使用包含正式类型的 accessible region 名称，来源加载通过 block busy 状态和可感知 status 表达。交互复用 Cool 现有消息壳、tokens、组件与窄屏抽屉模型。

## 用户故事

1. **作为 owner，我想冲突后先看到服务端最新 Proposal，从而基于真实事实决定是否重试。**
   - `VERSION_CONFLICT` 立即禁用旧 accept/reject 控件，并把焦点移到可访问冲突说明。
   - UI 读取同一 canonical project/thread/run/message/block 的最新完整 Proposal state，显示最新版本、正式内容、当前决定状态和可用动作；不能只显示版本号。
   - 读取 loading/error/empty/target changed 时不恢复旧动作；error 提供明确重试读取，不把 stale 状态伪装成最新。

2. **作为 owner，我想冲突后先看到服务端最新 Checklist，从而确认目标 item 与方向仍有效。**
   - UI 呈现最新完整 item 顺序、文本、checked 状态、state version 与可用动作。
   - 旧 item 已删除、已处于目标状态或动作不再允许时，旧动作保持禁用且不提供误导性“再次提交”。
   - owner 对最新状态作出显式新选择后，客户端生成新 operation ID、使用最新 expected state version 与当前动作意图提交。

3. **作为 owner，我想重试是明确的新业务尝试，从而不会发生隐藏重放。**
   - conflict response、最新 state fetch 或组件 rerender 均不得自动 POST。
   - 新 operation 只在 owner 激活明确标注的 retry action 后创建；旧 operation ID/hash 不复用。
   - retry 再次 conflict 时重复相同对账流程；成功显示既有 Receipt success，重复点击与 pending 状态被禁用。

4. **作为辅助技术用户，我想听到 block 正式类型与来源加载状态，从而理解当前消息。**
   - Proposal、Checklist、Diff Preview、File Reference、Handoff Card 的 region accessible name 分别包含该正式类型和既有可见标题/身份；不得只读成泛化“结构化消息”。
   - 有 source fetch 的 block 在 pending 期间设置 `aria-busy=true`，并提供简短 `role=status`/等价 live status；完成或失败后 busy 清除，状态文本准确更新。
   - loading、empty、error、disabled、success、focus 均可通过键盘与辅助技术区分；焦点可见，控件至少 44×44px，正文对比 WCAG AA。

5. **作为桌面和窄屏 owner，我想对账保持现有界面层级，从而无需学习新视觉系统。**
   - desktop 保持稳定消息壳与流内状态收敛；narrow 沿用现有内容/上下文抽屉模型，不新增独立路由或遮挡决定说明。
   - light/dark 全部使用 Cool tokens；不硬编码颜色、间距、圆角、排版、阴影或断点。
   - 不使用无理由渐变、发光、玻璃、装饰动画、emoji 图标、左彩条泛化提示卡或无需求徽标。

## 实现决策

- 公共 UI Interface 输入是服务端 fact-only Structured Message read model 与稳定 decision error envelope；UI 不读取 SQLite、不构造第二状态机。
- conflict 进入显式 reconciliation 状态，保存旧 operation 只用于展示/审计关联，不作为 retry 命令来源；先以 canonical tuple GET 最新 block，再从最新 read model 派生可用动作。
- target identity 变化或较新请求 epoch 到达时 abort/忽略旧 fetch、focus 与 submit；不能把前一 thread/block 的最新状态写到当前目标。
- 最新 Proposal/Checklist 必须完整替换 stale 展示；禁止把旧 state 与新 version 混合合并。
- 参考路径记录为 `D:\clowder-ai`。只转译四项原则：稳定消息壳、服务端事实收敛、文本型类型/状态标签、既有窄屏模型；禁止复制品牌、资产、文案、源码、DOM/CSS 结构或调色盘。
- 正式类型文本优先复用产品既有本地化名称；类型/状态标签是语义文本，不引入装饰徽标体系。

## UI 状态与信息架构

- 正常消息壳内依次组织：正式类型/标题 → 当前服务端事实 → 来源状态 → 允许动作/Receipt；冲突说明插在事实与动作之间并成为焦点目标。
- reconciliation loading：旧动作 disabled，显示“正在读取最新状态”的可感知 status。
- reconciliation error/empty：保持旧动作 disabled，提供只读错误与“重新读取最新状态”；不提供业务 retry。
- reconciliation ready：展示完整最新 state；仅当前仍合法的动作可由 owner 显式发起新 operation。
- retry pending/success/error：pending 禁用重复提交；success 走现有 Receipt；error 保持稳定 envelope，conflict 再次回 reconciliation。

## 测试决策

- 唯一验收 seam 是 fact-only Structured Block Public UI；使用公共 read/decision fake 或真实 route adapter 驱动，不测试 hook/private state/组件内部方法。
- TDD 每轮一个缺失行为 RED，再做最小 GREEN；不靠 snapshot-only、编译失败、skip、弱断言或 mock 被测 UI。
- Proposal 与 Checklist 分别覆盖 conflict 后零自动 POST、旧动作禁用、完整最新 state、focus、显式新 operation/version、二次 conflict 与 success。
- 五种 block 逐一断言 accessible region 正式类型；所有 source-backed block 覆盖 pending `aria-busy/status`、success/error 清除与 target switch abort/epoch。
- 真实浏览器验收覆盖 desktop/narrow、light/dark、keyboard-only、focus visible、44px 与 axe；网络记录证明 conflict/fetch 不自动 POST，显式 retry 恰一次新 operation。

## 范围外事项

- 修改 domain decision transition、operation replay、current schema/data invariants 或 File Reference 冻结（由 017 负责）。
- 新 block 类型、通用通知、动画、全局消息 redesign 或新窄屏导航模型。
- 复制 Clowder 具体实现或调整 Cool 调色盘/品牌。

## 补充说明

- 本片只改变入站 UI Adapter，不新增领域事实；消费 S-13 的 Public Collaboration read/decision Interface。
- 4 张票均服务同一 stale reconciliation 用户结果，未触发拆片阈值。
- 独立 spec-review 尚未执行；`architecture.md` 与 `tickets.md` 仅为待审草案。
- 用户确认: auto-approved 2026-08-09
