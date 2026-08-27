# 任务票 — 策略内终端与本地浏览器预览

- 状态: 项目级 review 豁免生效，直接进入 implement；implement 后必须 code review + security review
- 规模: 6 张纵向 RED/GREEN 票；单一“在任务内运行受控命令并打开本地预览”用户结果
- 公共缝: frozen policy command catalog、Policy Process Commands、Execution 卡片 UI
- TDD: 每票先一个公共行为 RED，再最小 GREEN；外部进程用可注入 Adapter，平台树终止另有真实 harmless child 测试

- [x] T-01 UCD + schema 26→27 + preview policy — Blocked by: None
  - RED: 既有 policy API 无 purpose/timeout/preview 边界，非法 port/openPath 无失败语义。
  - GREEN: policy entry append-only 新字段与严格约束；旧输入显式归一为 validation；preview 必须 loopback/port/openPath；DTO/schema/fixture/owner identity 同步。
  - 验证: `npm test -- tests/modules/project-workspace/validation-policy.test.ts tests/modules/project-workspace/validation-policy-api.test.ts tests/adapters/sqlite/current-schema.test.ts`

- [x] T-02 冻结命令目录 + exact/deny/one-shot 授权 — Blocked by: None
  - RED: Owner 无法按 Execution 查询 frozen policy entry；latest 替换与未许可命令未被公共缝阻断。
  - GREEN: 安全目录 DTO；exact entry=`standing_policy`；unknown safe tuple=`one_shot` Approval；shell/publish/remote/path escape=`deny`；完整 tuple/hash 校验。
  - 验证: 聚焦 policy-process module/API 测试；`npx tsc --noEmit`

- [x] T-03 Process Session 生命周期与有界输出 — Blocked by: None
  - RED: 无 Owner process acquire/start/status/output/stop/reconcile。
  - GREEN: 一活动 session；direct spawn/minimal env/no stdin；30–900s deadline；脱敏 1MiB UTF-8 chunks；显式 stop；树退出不可确认失败关闭；重启只标 interrupted。
  - 验证: 聚焦 policy-process runner/service 测试，含真实 harmless child；`npx tsc --noEmit`

- [x] T-04 loopback preview readiness — Blocked by: None
  - RED: preview URL 可由客户端伪造或任意 URL/占用端口无拒绝。
  - GREEN: URL 只从 persisted port/openPath 生成；start 前端口空闲；只探测 loopback；ready/timeout/stop 状态；无服务端 URL fetch/proxy。
  - 验证: 聚焦 loopback server + route DTO 测试；`npx tsc --noEmit`

- [x] T-05 任务内「终端与预览」UI — Blocked by: None
  - RED: Execution 卡片无命令目录、输出与本地预览入口。
  - GREEN: 按需表面；策略选择器；命令/工作目录/授权/网络/端口/超时摘要；只读输出、停止、重试、preview 新窗口；六态、44px、键盘与 focus。
  - 验证: jsdom 聚焦测试 + 真实浏览器亮/暗/窄屏 + axe。

- [x] T-06 收口 — Blocked by: None
  - 验证: 聚焦测试 → `npx tsc --noEmit` → `npm run build` → 相关 smoke/真实浏览器 → 一次全量 `npx vitest run`。
  - review: code review + security review（授权替换、Approval 重放、进程树、SSRF/端口混淆、输出泄密、崩溃重放）。
  - 进展: 回写 feature/product/backlog，ship 后立即按 `product/development-plan.md` 进入下一项。
