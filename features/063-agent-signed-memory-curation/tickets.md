# 任务票 — Agent 署名的记忆提炼与发布

- 状态: done
- 规模: 6 张纵向票（A-442）
- 公共缝: Knowledge `proposeCuration` / `listCurationCandidates` / `decideCuration`；Governance `listPendingApprovals`；记忆视图与审批中心

- [x] T-01 schema 与提出候选 — Blocked by: None
  - RED: 无候选表/提出命令。
  - GREEN: identity 30；项目内 Agent + 已校验来源可提出 pending；无来源/跨项目/非成员失败关闭且零行。
  - 验证: schema + Knowledge 命令聚焦测试。

- [x] T-02 列表与链头 diff — Blocked by: T-01
  - RED: 无法列出候选或对照 supersedes。
  - GREEN: `listCurationCandidates` 含署名、来源、行级 diff；他项隔离。
  - 验证: Knowledge 查询测试。

- [x] T-03 发布与驳回 — Blocked by: T-02
  - RED: 候选不能成为共享记忆，或 Agent 可绕过治理写入。
  - GREEN: publish 插入 agent 署名记忆；reject 不写记忆；来源失效/目标非 active 失败关闭；operation 幂等。
  - 验证: 命令 + HTTP 聚焦测试。

- [x] T-04 审批中心知识域 — Blocked by: T-03
  - RED: 中心看不到 knowledge 发布请求。
  - GREEN: `listPendingApprovals` 经公开缝聚合；domain/kind 扩展；裁决分派本片路由。
  - 验证: governance 中心测试。

- [x] T-05 记忆视图与审批 UI — Blocked by: T-04
  - RED: Owner 看不见署名/diff/批准。
  - GREEN: UCD §9.2.4 提炼候选 region + 中心知识卡；全态；≥44px；令牌。
  - 验证: jsdom；真实渲染核对。

- [x] T-06 收口 — Blocked by: T-05
  - 验证: 聚焦 → tsc → build → 相关 jsdom → 全量。
  - review: schema + 跨 owner 聚合 + 发布写；hf-code-review。
