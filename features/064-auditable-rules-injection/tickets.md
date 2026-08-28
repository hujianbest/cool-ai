# 任务票 — 可审计系统规则与提示注入检查

- 状态: done
- 规模: 4 张纵向票（A-452）
- 公共缝: Identity `buildRuleInsight`；GET `/api/projects/:projectId/rule-insight`；`/team` region

- [x] T-01 检查纯函数 — Blocked by: None
  - RED: `buildRuleInsight` 不存在。
  - GREEN: 越权写/执行/绕过复核 → block；忽略先前指令 → warn；无命中 → 空 findings；摘录不含全文。
  - 验证: Identity 模块测试。

- [x] T-02 GET 路由 — Blocked by: T-01
  - RED: 无 `/rule-insight`。
  - GREEN: 项目成员配置可检查；未知项目 404；额外查询键 400；`no-store`；DTO 无 prompt 全文/密钥。
  - 验证: API 测试。

- [x] T-03 `/team` UI — Blocked by: T-02
  - RED: 无「规则与注入检查」region。
  - GREEN: loading/empty/error；block `role=alert`；重新检查；≥44px；令牌。
  - 验证: team-settings jsdom。

- [x] T-04 收口 — Blocked by: T-03
  - 验证: 聚焦 → tsc → build → jsdom → 全量。
  - review: 安全边界；hf-code-review。
