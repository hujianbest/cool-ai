# Cool AI 014 新会话续执行计划

## 目标

完成 `D:\cool-ai\features\014-persistent-project-threads`（S-12），通过独立评审与 demo 验收，单独 commit 并 push；随后按更新后的 HarnessFlow 自动继续下一切片。

## 先做：加载更新后的流程

新会话第一步重新读取磁盘上的最新技能，不沿用旧会话里的阶段记忆：

1. `.agents/skills/hf-workflow/SKILL.md`
2. `.agents/skills/hf-implement/SKILL.md`
3. `.agents/skills/hf-tdd/SKILL.md`
4. `.agents/skills/hf-review/SKILL.md`
5. `.agents/skills/hf-code-review/SKILL.md`
6. `.agents/skills/hf-ship/SKILL.md`
7. UI 相关扩展 `ext-*`

最新主链已从旧的 `frame → plan → build → verify → ship` 改为：
`grill-with-docs → to-spec → to-architecture → to-tickets → implement → ship`。

运行：

```powershell
python ".agents/skills/hf-workflow/scripts/hf_gate.py" status
```

注意：当前 status 会把历史特性识别为旧工件，并报告缺少 `CONTEXT.md`、`architecture.md`、`tickets.md`。不要因此从 001 重做，也不要丢弃 014 已完成实现。先针对 014 检查新 gate/技能的兼容要求：

- 已批准规格：`features/014-persistent-project-threads/spec.md`
- 旧流程下已独立批准的完整技术设计：`features/014-persistent-project-threads/design.md`
- 旧任务唯一事实源：该 `design.md` 的 T-1～T-34
- 规格/设计评审：`features/014-persistent-project-threads/reviews/`

若新 gate 强制要求新格式：

- 从已批准 `design.md` 提炼 ≤80 行 `architecture.md`，不改变行为边界，再由独立 subagent 做 `reviews/architecture-review.md`。
- 建立 `tickets.md` 作为旧 T-1～T-34 的迁移索引：T-01～T-33 已完成，T-34 待完成；不得伪造测试证据或重写历史。
- 如果 014 的定向 gate 明确要求 `CONTEXT.md`，按最新 `hf-grill-with-docs` 从现有 `product/` 与已确认决策建立兼容工件；不要重启旧切片。

## 当前代码状态

- 仓库：`D:\cool-ai`
- 分支：`master`
- 最近已推送提交：`9b3e143 Add progressive first-use onboarding`
- 014 全部改动仍未提交。
- `design.md`：T-1～T-33 已勾选，T-34 未勾选（第 547 行）。
- `progress.md`：build 阶段，下一步为修复 T-34 全量回归。
- 自动模式；014 完成提交/push 后继续后续切片。
- 活跃长任务已停止，相关进程树已结束。

完整需求与实现设计只读上述 feature 工件，不在本计划重复。

工作树很大（约 128 个已跟踪文件有 diff，另有 014 新文件/路由/测试）。不要 reset、checkout 或清理用户改动。`git status --short` 中还有：

- `.agents/skills/hf-workflow/scripts/__pycache__/`：生成物，提交前删除。
- 大量 `features/014`、thread API/service/UI/test 新文件：均属于本切片，须评审后提交。

## T-34 精确检查点

上一个实现 subagent 已停止。最后可靠结果：

- 上一次完整 `npm test`：222 files，1733/1734 通过。
- 唯一失败是 `tests/collaboration-controls.test.tsx` 选中了错误的并发 alert；已修复。
- 该文件 focused rerun：12/12 通过。
- 修复后的新一轮完整 `npm test` 被用户切换会话时中止，因此最终全量状态未知。
- `npm run build`：此前通过。
- `npm run smoke:review`：通过。
- `smoke:threads`：此前通过，11 个端到端断言；4 次 axe 扫描无 critical/serious/contrast；生成 3 PNG + JSON。
- `smoke:settings`：此前通过。
- `smoke:collaboration`、`smoke:execution`、`smoke:onboarding`：在最近一轮 fixture 修复后尚未重新验证。
- T-34 仍不得勾选。

最近一轮回归修复涉及：

- `tests/v7-fixture-graph.ts`
- `tests/command-request.test.ts`
- `tests/execution-read-api.test.ts`
- `src/server/mission-service.ts`
- `tests/mission-legacy-entrypoints.test.ts`
- `tests/review-escalation-integration.test.ts`
- `src/server/review/review-read-service.ts`
- `tests/collaboration-slice.test.tsx`
- `tests/review-browser-smoke.mjs`
- `tests/collaboration-controls.test.tsx`

## 下一步执行顺序

### 1. 恢复全量验证

先运行：

```powershell
npm test
```

如果失败：

- 逐个 focused RED/GREEN 修复；
- 旧 fixture 必须迁移到 v7 project/thread/policy/run tuple；
- 旧 project-only/run-only API 必须迁移到 tuple route；
- 不恢复已移除的兼容入口，不弱化断言。

全量测试通过后依次运行：

```powershell
npm run build
npm run smoke:threads
npm run smoke:collaboration
npm run smoke:execution
npm run smoke:review
npm run smoke:settings
npm run smoke:onboarding
```

再检查：

```powershell
git diff --check
```

对编辑文件读取 lints。构建若只改写 `next-env.d.ts`，恢复其原跟踪内容；不要留下生成噪声。

用户已明确豁免不存在的 `hf_gate.py run` 子命令。直接命令输出可作本地验收结果；不得手写/编辑 evidence log。浏览器 smoke 自己生成的 JSON/PNG 可以保留。

### 2. 完成 T-34

仅当以上全部命令 exit 0：

- 将 `design.md` 的 T-34 勾为 `[x]`。
- 更新 `progress.md` 到更新后工作流对应的 code-review/ship 前状态。
- 运行 014 定向 gate；若因新技能格式失败，按“先做”一节迁移 architecture/tickets 工件后再检查，禁止绕门禁。

### 3. 独立代码评审

固定点为当前 HEAD `9b3e143`，评审对象是未提交工作树 `git diff HEAD` 加所有 untracked 014 文件。

按最新 `hf-review` + `hf-code-review` 做两轴独立评审：

- Standards
- Spec（来源：`features/014-persistent-project-threads/spec.md` 与批准架构/设计）

评审者必须自己运行全量测试、读完整 diff，不采信本计划的结果。记录到：

`features/014-persistent-project-threads/reviews/code-review.md`

发现严重/一般问题：只修 findings，重跑相关验证，再独立复审。通过后 auto-approved。

### 4. Demo 与 ship

检查机器生成证据：

- `features/014-persistent-project-threads/evidence/persistent-threads-results.json`
- `persistent-threads-desktop.png`
- `persistent-threads-narrow.png`
- `persistent-threads-policy-repair.png`

按最新 ship 规则写/更新：

`features/014-persistent-project-threads/reviews/demo-acceptance.md`

auto 模式可 `auto-approved`，但要引用真实 smoke 结果。随后：

- 运行 `check --to ship`（更新后的 stage 名）。
- 回写产品层：勾选 backlog S-12；确认 A-68～A-73 并迁移必要决策；更新架构/CONTEXT 的线程模型、v7 和显式 source tuple。
- `progress.md` 标为 done，写简短交付摘要。

### 5. Commit 与 push

提交前：

- 删除 `__pycache__` 生成物。
- 确认无敏感 fixture/evidence 内容。
- 并行检查 `git status --short`、完整 `git diff`、最近 commit 风格。
- 只提交 014 及其必要产品层回写，不提交生成噪声。

建议 commit 主题：

`Add persistent project threads`

提交成功后确认状态，再：

```powershell
git push
```

### 6. 继续下一切片

014 push 成功后不要暂停。重新运行最新：

```powershell
python ".agents/skills/hf-workflow/scripts/hf_gate.py" status
python ".agents/skills/hf-workflow/scripts/hf_gate.py" next
```

按更新后的 HarnessFlow 主链启动 backlog 中下一个未完成切片；不要沿用旧会话里的旧技能说明。

## 建议技能

- 必须：`hf-workflow`
- 当前收口：`hf-implement`、`hf-tdd`
- 独立评审：`hf-review`、`hf-code-review`
- UI 验证：匹配的 `ext-ui-design`
- 发布：`hf-ship`
- 如果 gate 要求迁移旧工件：`hf-to-architecture`、`hf-to-tickets`
- 若测试出现难以定位的非 fixture 故障：`hf-diagnosing-bugs`

## 禁止事项

- 不 reset/checkout 丢弃当前大规模未提交改动。
- 不把 T-34 在全量命令未绿时勾选。
- 不恢复旧 run-only/project-only API 以“让测试通过”。
- 不弱化 tuple 隔离、凭据拒绝、冻结来源或严格 parser。
- 不让同一个实现 agent 自评通过。
- 不在独立评审和 ship gate 前 commit/push。
