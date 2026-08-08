# 实现代码评审（第 1 轮）

- 日期: 2026-08-09
- 评审方式: 并行 subagent（Standards / Spec）
- 固定点: `9b3e143242e099d2b1b449963f1551c69a919b10`
- 结论: 需修改

## Standards

- [严重] `src/server/review/review-slice-service.ts:95-129`、`src/server/review/review-material.ts:249-327`: v6 冻结包没有 `source.*`，升级后合法历史复核被拒，违反 `AGENTS.md` 的冻结来源与兼容要求 → 兼容旧版冻结来源并校验回填 tuple。
- [一般] `src/server/migrations-v7.ts:1577-1588`: execution 线程列可空且没有复合外键，未在持久层强制完整 ownership tuple → 重建表并强制完整 tuple。
- [建议] 新线程 routes: 多处重复路径与正文校验，可能存在 `Duplicated Code` → 在不扩大本轮修复范围的前提下考虑复用现有边界模块。
- [一般] 独立全量测试未通过：217/222 文件、1727/1734 测试通过，7 项失败，exit 1。

## Spec

- [严重] `components/collaboration/collaboration-panel.tsx:2005-2007,2484-2499` ↔ `spec.md:62`: 其他线程存在活动运行时同时禁止 owner 发消息；规格只禁止启动 Agent 续接 → owner 消息保持可写，只禁 Agent 启动。
- [一般] `components/project-thread-navigation.tsx:341-353` ↔ `spec.md:73-74`: 无效线程深链静默选择最近线程，没有显示安全错误/可选状态 → 保留不泄漏的显式错误状态。
- [一般] `tests/persistent-threads-browser-smoke.mjs:665-681` ↔ `spec.md:86-89`: 使用错误字段 `message` 得到 400，使凭据拒绝验收形成假阳性 → 使用 `content`，断言 422 且原值不进入响应、DOM 或事实。
- [建议] `.agents/skills/*` 位于固定点差异内但不属于 S-12 → 后续交付边界应与产品切片分离。
- [一般] 独立全量测试未通过：222 文件、1731/1734 测试通过，3 项失败，exit 1（并行评审期间出现超时/EPERM）。

## 汇总

Standards：4 项（最严重：历史冻结来源兼容）；Spec：5 项（最严重：跨线程活动运行错误阻止 owner 消息）。存在严重/一般发现项，返回实现阶段，仅修复上述发现后重新独立评审。

---

# 实现代码评审（第 2 轮）

- 日期: 2026-08-09
- 评审方式: 并行 subagent（Standards / Spec）
- 固定点: `9b3e143242e099d2b1b449963f1551c69a919b10`
- 结论: 需修改

## Standards

- [严重] `src/server/review/review-material.ts:235-247`、`src/server/review/review-slice-service.ts:96-136`: 首轮冻结来源项未关闭；全空 `source.*` 即放行，但没有核验 v6 `sourceCollaborationRunId` 与 execution tuple 的 run 精确匹配 → 补齐身份校验，继续禁止 latest-run fallback。
- [一般] `src/server/migrations-v7.ts:1610-1685`: NOT NULL 与复合外键项已关闭；新增的表重建在关闭外键后把 `BEGIN` 放在 `try` 外，失败可能泄漏连接 PRAGMA 状态 → 在所有失败路径恢复原外键状态。
- [建议] 新线程 routes 的重复边界校验与 `__pycache__` 生成噪声留待提交前清理。
- [通过] 命名 mutex 下全量测试 222/222 文件、1736/1736 测试通过，exit 0；`maxWorkers: 2` 有效避免仓库写入型测试竞争。

## Spec

- [通过] 跨线程活动 run 时 owner 消息可写、Agent dispatch 仍阻止。
- [通过] 无效 thread 深链保留显式安全错误，仅无 thread 参数时恢复最近线程。
- [一般] `tests/persistent-threads-browser-smoke.mjs:683-707` ↔ `spec.md:88`: 凭据拒绝只比较消息联结事实，未严格证明所有事实总数与身份不变 → 比较拒绝前后的完整 fact ID 集合。
- [通过] 全量测试 222/222 文件、1736/1736 测试通过，exit 0。

## 汇总

Standards：2 个未关闭/新增严重或一般项；Spec：1 个未关闭的一般项。第 2 轮仍为需修改，返回实现阶段，仅修复上述三项后复审。

---

# 实现代码评审（第 3 轮）

- 日期: 2026-08-09
- 评审方式: 并行 subagent（Standards / Spec）
- 固定点: `9b3e143242e099d2b1b449963f1551c69a919b10`
- 结论: 通过
- 用户确认: auto-approved 2026-08-09

## Standards

- [通过] legacy `sourceCollaborationRunId` 与 execution tuple 精确匹配；缺失、冲突、部分 tuple 均失败关闭，没有 latest-run fallback。
- [通过] migration 在 BEGIN/DDL/COMMIT/ROLLBACK 异常后恢复原 PRAGMA、原错误及 v6 原子状态。
- [建议] 新线程 routes 的重复边界校验不阻塞本切片；`__pycache__` 在提交前清理。
- [通过] 全量测试 222/222 文件、1745/1745 测试通过，exit 0。

## Spec

- [通过] 凭据 smoke 比较完整 fact 数量、ID 与内容，并验证 422、sanitized、API/DOM/事实无原文。
- [通过] 跨线程活动 run 时 owner 消息行为与无效深链安全错误均无回归。
- [通过] 全量测试 222/222 文件、1745/1745 测试通过，exit 0。

## 汇总

Standards：无严重/一般发现项；Spec：无发现项。双轴均通过并按 auto 模式确认。
