# 架构 — 陈旧 Inline Decision 对账 UI

- 日期: 2026-08-09
- 对应规格: [`spec.md`](./spec.md)
- 状态: 待 spec-review；架构草案，未送独立 architecture-review
- 用户确认: auto-approved 2026-08-09（不等于独立评审通过）

## 架构目标

让 fact-only Structured Block Public UI 成为唯一交互 seam：它只消费服务端正式 read model/error envelope，把 stale 收敛为先读最新事实、后显式新 operation。客户端不建立第二状态机，不自动重放。

## Module 与 Interface

### Structured Block Public UI Module

- Interface 输入：canonical target identity、五种 block read model、source load state、decision command result；输出：语义化渲染与 owner 显式 intent。
- 同一消息壳渲染 type/title、完整服务端 state、source status、冲突说明与动作；只使用现有 Cool tokens/components。
- 每种 block region name 包含正式类型；source pending 映射 `aria-busy` 与 live status。

### Reconciliation Module

- 内部状态最小为 `idle | loading-latest | latest-ready | latest-error | retry-pending | success`，并绑定 canonical target + request epoch。
- `VERSION_CONFLICT` 原子进入 `loading-latest`、禁用旧动作并安排冲突说明获得焦点；GET 最新 block，完整替换 Proposal/Checklist read model。
- 只有 `latest-ready` 且 owner 激活当前合法动作时才生成新 operation ID，并用最新 expected state version 提交；旧 operation 永不作为 retry identity。
- target switch/unmount/新 epoch 中止旧读取、提交回写和焦点移动。

### Existing Read/Decision Adapters

- 复用现有 tuple-scoped Structured Message GET 与 decision POST Interface；不新增数据库或领域 Interface。
- GET 必须返回完整 Proposal/Checklist state 与动作可用性；UI 不通过本地 patch 猜测服务端 head。
- 稳定 error envelope 决定 reconciliation 分支；未知错误保留旧动作 disabled。

### Browser Acceptance Adapter

- 真实 route + deterministic fixture 驱动双页面 stale；记录 GET/POST 与 operation identity，验证 conflict 后零自动 POST、显式 retry 恰一次新 operation。
- axe、keyboard、desktop/narrow、light/dark 与 focus 由受影响 smoke 一次覆盖。

## 核心数据

- Reconciliation identity: project/thread/run/message/block + block revision + latest state version + request epoch。
- Latest Proposal/Checklist read model：完整正式内容、当前状态、允许动作与 source identity；禁止旧/新字段混合。
- Retry intent：新 operation ID、最新 expected state version、owner 当前显式 action/item。

## 关键流程

1. **Conflict**：decision POST 返回 `VERSION_CONFLICT` → 禁用旧动作 → 渲染/聚焦冲突说明 → GET canonical latest block。
2. **Reconcile**：loading/status → 完整 latest state 或稳定 error/empty；只有 ready 展示按最新事实计算的合法动作。
3. **Explicit retry**：owner 激活动作 → 生成新 operation → 一次 POST；success 显示 Receipt，二次 conflict 回到步骤 1，绝不自动循环。
4. **Source accessibility**：source fetch pending 设置 region busy + status；完成/失败清除 busy，target epoch 防止陈旧播报。

## Seam 与测试点

- **唯一 seam — fact-only Structured Block Public UI**：以公共 props/read adapter/decision adapter 观察 DOM、焦点、键盘与网络副作用。
- Proposal/Checklist：完整 latest state、旧动作 disabled、零自动 POST、新 operation/version、error/empty 与二次 conflict。
- 五种 block：正式类型 region name；source pending/success/error 的 busy/status。
- 浏览器：双页面制造 stale，desktop/narrow/light/dark/keyboard/axe；不测试私有 hook 或 CSS 实现。

## UI 参考与令牌

- 参考路径：`D:\clowder-ai`。
- 只转译稳定消息壳、服务端事实收敛、文本型类型/状态标签、窄屏既有模型四项信息架构/交互原则。
- 继续使用 `app/tokens.css` 与 Cool 既有消息、按钮、状态、抽屉元素；禁止复制 Clowder 品牌、资产、文案、源码、DOM/CSS 结构和调色盘。
- 无新视觉系统、硬编码 token、装饰动画、渐变/发光/玻璃、emoji 图标或泛化提示卡。

## 横切约定

- loading/empty/error/disabled/success/focus 全覆盖；focus 可见、控件至少 44×44px、文本 WCAG AA。
- 服务端事实优先；客户端 cache 只作显示暂存，不能授权动作。
- 所有异步读取、提交与 focus 使用 target identity + abort/epoch；陈旧结果不可污染新目标。
- 公共错误保持脱敏；不把 operation hash、宿主路径或 raw response 放入 DOM。

## ADR 链接

- 无新增 ADR；本片沿用既有 fact-only、operation/version 与 Cool UI 决策。
