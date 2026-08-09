# 018 — 陈旧决定对账 UI

- 模式: 建造
- 用户可感知: 是
- 执行模式: auto
- 对应补救: S-13 第 3 轮 code review 的 stale decision 与可访问性发现
- 主架构单元: fact-only Structured Block 入站 UI Adapter
- 主领域 Capability: 不适用（不新增领域事实）
- 公共行为接缝: fact-only Structured Block Public UI
- 依赖: S-13 已有 Structured Message read/decision Interface
- 阻塞: 015/S-13 第 4 轮 code review 与 ship

## 目标

让 owner 遇到 stale inline decision 时先看到服务端最新 block 状态，再明确决定是否以新 operation 重试；五种 block 类型与 source loading 对辅助技术清晰。

## 范围

- `VERSION_CONFLICT` 后禁用旧动作，不自动重放；读取并呈现服务端最新完整 Proposal/Checklist state。
- 焦点移到冲突说明；只有 owner 显式确认后，按最新 state/version 生成全新 operation 重试。
- 五种正式 block 的 accessible region 名称包含正式类型；source pending 进入 `aria-busy` 与可感知 status。
- 覆盖 desktop/narrow、light/dark、keyboard、focus、44px 与 axe。
- 参考 `D:\clowder-ai` 的稳定消息壳、服务端事实收敛、文本类型/状态标签和窄屏既有模型；只转译原则，继续使用 Cool tokens/components。

## 非目标

- 不修改 decision 领域状态机、operation replay 契约、schema 或 File Reference 冻结规则。
- 不自动重放 stale 动作，不复用旧 operation ID，不根据客户端旧 state 猜测新动作。
- 不复制 Clowder 品牌、资产、文案、源码、角色、图标或调色盘；不建立新视觉系统。

## 用户确认

- auto-approved 2026-08-09：按推荐结果拆为 4 张票；UI 参考与重试默认记录于 `product/assumptions.md` A-96～A-97。
