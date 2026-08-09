# 需求规格评审（第 1 轮）

- 日期: 2026-08-09
- 评审方式: 独立会话
- 结论: 通过
- 用户确认: auto-approved 2026-08-09

## 发现项

- 无。

## 检查结论

- 单一可演示结果成立：4 张票共同闭合“stale decision 后先收敛到服务端最新完整事实，再由 owner 显式发起新 operation”的一个用户结果；主要架构单元仅为 fact-only Structured Block 入站 UI Adapter，未触发拆片阈值。
- Proposal 与 Checklist 的冲突流程可判定：`VERSION_CONFLICT` 后旧动作立即禁用且不自动 POST；canonical project/thread/run/message/block tuple 的最新完整 state 替换旧展示；只有 owner 基于最新 state/version 激活明确 retry action 时才创建全新 operation，旧 operation ID/hash 不复用，二次冲突重新进入同一对账流程。
- loading、empty、error、disabled、success 与 focus 均有明确外部行为：读取失败或空结果保持旧动作禁用并只允许重新读取；pending 阻止重复提交；成功复用既有 Receipt；冲突说明获得可见键盘焦点；target change 通过 abort/epoch 防止旧 fetch、submit 或 focus 污染新目标。
- 可访问性与真实渲染边界完整：五种正式 block 的 region 名称包含正式类型；source pending 使用 `aria-busy` 与可感知 status；规格要求键盘操作、可见焦点、44×44px、WCAG AA，并以 desktop/narrow、light/dark 与 axe 浏览器验收覆盖。
- 信息架构与视觉约束符合 `ext-ui-design`：复用 Cool 现有消息壳、tokens、组件和窄屏抽屉，不硬编码视觉值，不新增装饰徽标体系，不使用无理由渐变、发光、玻璃、动画、emoji 图标或左彩条泛化提示卡。
- 对 `D:\clowder-ai` 的核对仅支持四项参考原则：共享稳定消息壳、以服务端 authoritative read 收敛 stale 客户端状态、使用可读类型/状态文本、桌面侧栏在窄屏收进既有 sheet/drawer；规格明确禁止复制其品牌、角色、资产、文案、源码、DOM/CSS 结构与调色盘。
- 测试决策以 fact-only Structured Block Public UI 为唯一公共 seam，分别覆盖 Proposal/Checklist 零自动重放与新 operation、五种 block accessible name、source loading、target-switch 竞态及真实网络次数；不测试 hook、私有状态或组件内部方法。
- 范围没有 backend invariant 扩张：decision transition、operation replay、current schema/data invariants 与 File Reference 冻结均明确在范围外；本片只消费 S-13 已有 Public Collaboration read/decision Interface，不新增领域事实、第二状态机或新后端事实 owner。
