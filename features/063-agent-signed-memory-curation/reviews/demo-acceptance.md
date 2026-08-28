# 演示验收 — 063 Agent 署名的记忆提炼与发布

- 日期: 2026-08-27
- 结论: 接受
- 确认: auto-approved 2026-08-27（下次交互呈上）

## 对照

- 项目成员 Agent 可提出带来源的提炼候选；无来源、跨项目、非成员失败关闭。
- Owner 在记忆视图「提炼候选」看到冻结署名、来源身份与链头 diff，可批准发布或驳回。
- 批准写入 `proposer_actor_type=agent` 的共享记忆；驳回不写记忆；陈旧 supersedes 为 `replaced`。
- 统一审批中心出现 `knowledge` / `memory_publish` 项，与记忆视图同一裁决。
- 已发布卡片文案：`Agent {name} 提议 · Owner 经审批发布 · 平台持久化`。

## 证据

- 聚焦 10 文件 / 94 用例
- `npx tsc --noEmit` 通过
- `npm run build` 通过（含 GET/POST candidates 与 publish/reject 三条路由）
- 全量 Vitest 334 文件：2921 passed / 1 failed（仅 A-387 `review-browser-full-chain`，UCD §9.5 未挂载「运行详情」）
- 独立 hf-code-review 第 6 轮 Standards + Spec 通过
- jsdom 覆盖 loading 骨架、空态刷新、发布/驳回 busy 文案；T-05 已做真实 Chrome 主路径核对
