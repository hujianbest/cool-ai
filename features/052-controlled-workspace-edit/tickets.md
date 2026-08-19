# 任务票 — 受控工作区编辑与 Git 合入

- 状态: 项目级 review 豁免生效，直接进入 implement；implement 后必须 hf-code-review（安全/跨 owner 写）
- 规模: 5 张纵向 RED/GREEN 票；单一「从只读预览受控改一个文件并审批合入」用户结果
- 公共缝: Workspace Edit Commands、预览「编辑」UI
- TDD: 每票先一个公共行为 RED，再最小 GREEN；内存库夹具；文件语义用临时目录真实文件

- [x] T-01 schema 25→26 + 创建/读取编辑会话 + 路径安全 — Blocked by: None
  - 公共缝: `createWorkspaceEdit` / `getWorkspaceEdit`。
  - RED: 会话命令不存在；越界/敏感/二进制/未绑定未定义。
  - GREEN: `workspace_edit_sessions` + 一活跃/项目部分唯一索引；verified-handle 拷入隔离草稿；201 返回 sessionId、相对路径、expectedHash、status `editing`，无宿主绝对路径；敏感/越界/目录/二进制 4xx；同 project 再创建 409；operationId 重放同一会话；write-ownership + identity 同波次同步。
  - 验证: 聚焦 `tests/modules/project-workspace/workspace-edit*.test.ts`；`npx tsc --noEmit`
  - 命令: `npm test -- tests/modules/project-workspace/workspace-edit.test.ts tests/modules/project-workspace/workspace-edit.api.test.ts`

- [x] T-02 sandbox PUT 与 diff/stale/冲突 — Blocked by: T-01
  - 公共缝: `putWorkspaceEditDraft` / `getWorkspaceEditDiff`。
  - RED: PUT/diff 未定义。
  - GREEN: PUT 只改草稿；canonical 不变；version/expectedHash 冲突 409；NUL/超限拒绝；GET diff 给出 unified diff + `ready_to_stage` / `stale` / `conflicted`。
  - 命令: 聚焦 workspace-edit 测试；`npx tsc --noEmit`

- [x] T-03 stage / 审批合入 / abandon / 重放 — Blocked by: T-02
  - 公共缝: stage、merge、abandon；平行 MergeJournal 表。
  - RED: 合入未定义；无审批可写盘。
  - GREEN: stage 不写 canonical；无审批 merge 拒绝；审批+stagedHash 后 journal 合入；operationId 重放不双写；abandon 丢草稿。
  - 命令: 聚焦 workspace-edit + 既有 approval 夹具；`npx tsc --noEmit`

- [x] T-04 预览「编辑」UI — Blocked by: T-03
  - 公共缝: S-22 预览入口（jsdom + 真实浏览器）。
  - RED: 文本预览无「编辑」。
  - GREEN: 仅文本非秘密显示「编辑」；textarea 编辑面；diff/stale/冲突/放弃/申请合入 ≥44px；复用审批中心；tokens；全态。
  - 命令: 聚焦 browser 测试；真实浏览器核对；`npx tsc --noEmit`

- [x] T-05 收口 — Blocked by: T-04
  - 验证: `npx tsc --noEmit` + `npm run build` + 一次全量 `npx vitest run` + hf-code-review（路径逃逸、草稿泄漏、journal 双写、审批绕过）。
