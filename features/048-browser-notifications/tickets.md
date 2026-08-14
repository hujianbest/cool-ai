# 任务票 — 浏览器通知

- 状态: spec/architecture 豁免；implement 后 hf-code-review（通知权限）
- 规模: 3 张纵向票
- TDD: 每票 RED → GREEN；禁止全量直到 T-03

- [x] T-01 通知 Adapter（permission/dedupe/copy） — Blocked by: None
  - jsdom 或纯函数：默认关闭不 show；granted+新 id 才 show；重复 id 不 show；denied 返回 degraded；body 无项目正文/密钥
  - 命令: `npm test -- tests/adapters/notification-media/browser-notification-adapter.test.ts`；`npx tsc --noEmit`

- [x] T-02 设置 UI + 驾驶舱轮询挂钩 — Blocked by: T-01
  - 设置「通知」开关 ≥44px；PWA manifest link；项目页可见时轮询审计（stub fetch）；不 POST 审批
  - 命令: 对应 jsdom 测试

- [x] T-03 smoke + 门禁 — Blocked by: T-02
  - stub Notification；断言开关、降级、manifest；`npx tsc --noEmit`、`npm run build`、一次 `npx vitest run`、受影响 smoke（`smoke:settings` 优先，否则 `smoke:context`）
  - 不为通知新开 Agent。然后停，交父会话 hf-code-review + ship
