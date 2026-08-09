# 实现代码评审（第 1 轮）

- 日期: 2026-08-09
- 评审方式: 并行 subagent（Standards / Spec）
- 固定点: `9ba94003590879b3a8b309429a46d894e4261b78`
- 结论: 需修改

## Standards

- [严重] `src/server/structured-messages/verified-source-projection.ts:49-70`: 原始可变 `diff_text` 直接返回，未冻结、脱敏或限长 → 持久化并读取脱敏快照及其 hash，拒绝敏感或超限内容。
- [严重] `src/server/migrations-v8.ts:394-430`: reopen 只验证 JCS/hash，合法 canonical 但领域形态非法的 block/state 可通过 → 使用 persisted strict decode 验证全部 v8 数据与 outcome/state 关系。
- [一般] `src/server/structured-messages/structured-message-store.ts:18-98`: 文本上限使用 UTF-16 `.max()` 且缺少 20000 grapheme 总量 → 统一用 `Intl.Segmenter` 按 grapheme 计数。
- [通过] 完整测试 235/235 文件、1808/1808 测试通过，TypeScript 通过。

## Spec

- [严重] `verified-source-projection.ts:48-72` ↔ `spec.md:45,77,113,137`: Diff Preview 可把未脱敏、未限长原文送入 DOM → 对公开快照执行凭据/私密内容检查与 20000 grapheme 上限。
- [严重] `structured-message-store.ts:18-98` ↔ `spec.md:108,112`: UTF-16 计数错误且 schema 漏掉 `fileReferences` → 按 grapheme 校验并补全 File Reference 数量约束。
- [一般] `structured-message-store.ts:154-163,270-324` ↔ `spec.md:111,142`: 256 KiB domain envelope 计量未包含 actor/source metadata → 对完整 canonical domain envelope 计量。
- [一般] `structured-message-store.ts:281-323` ↔ `spec.md:61`: Handoff Card 未证明 block actor 等于原 handoff actor → 绑定并冻结原 actor。
- [通过] 完整测试 235/235 文件、1808/1808 测试通过；真实 evidence 已检查。

## 汇总

Standards：3 个严重/一般发现项；Spec：4 个严重/一般发现项。存在重叠但不可合并省略，返回实现阶段，只修复上述发现后复审。

---

# 实现代码评审（第 2 轮）

- 日期: 2026-08-09
- 评审方式: 并行 subagent（Standards / Spec）
- 固定点: `9ba94003590879b3a8b309429a46d894e4261b78`
- 结论: 需修改

## Standards

- [通过] Diff 冻结/敏感拒绝、grapheme、完整 envelope 与 handoff actor 均已关闭。
- [严重] `src/server/migrations-v8.ts:527-565`: receipt/fact 没有与 Decision 的 action、item、from/to version 全量绑定 → validator 联表逐字段证明业务结果一致。
- [一般] `src/server/structured-messages/structured-message-schema.ts:60,126`: `fileReferences` 与 blocks 上限错误收紧为 8 → 按规格恢复为 100 与 10。
- [通过] 完整测试 235/235 文件、1813/1813 测试通过。

## Spec

- [通过] Diff 冻结与敏感/超限拒绝、UnknownSchema/Invalid reopen、完整 domain envelope、Handoff actor 均已关闭。
- [一般] `structured-message-schema.ts:60,126,135` ↔ `spec.md:111-112`: `fileReferences≤8、blocks≤8` 与规格的 `100/10` 不一致。
- [通过] 真实 evidence 12 个断言、3 个 axe 状态通过；完整测试 1813/1813 通过。

## 汇总

Standards：1 个严重、1 个一般未关闭项；Spec：1 个重叠的一般未关闭项。返回实现阶段，只修复 outcome 关系 validator 与正确上限。

> Superseded note（2026-08-09）：本评审引用的 `migrations-v8.ts` 与 v8 reopen 是历史快照；016 Contract 已将其替换为 identity 9 `CURRENT_SCHEMA`、current data invariants、fresh/exact reopen 与 fail-closed 证据。历史 findings 与结论保持原样，仍需按 015 progress 重新执行独立 code review。

---

# 实现代码评审（第 3 轮）

- 日期: 2026-08-09
- 评审方式: 并行 subagent（Standards / Spec）
- 固定点: `9ba94003590879b3a8b309429a46d894e4261b78`
- 结论: 需修改

## Standards

- [严重] `src/server/structured-messages/verified-source-projection.ts:112-132`: File Reference 每次读取都会重新查询可变且未经脱敏校验的 artifact `name`，既未冻结展示快照，也可能把宿主路径或凭据送入 DOM。
- [严重] `src/server/storage/current-data-invariants.ts:236-246,382-420`: outcome validator 未从 operation 全集证明 completed inline decision 与 Decision/Receipt/Fact 的双向完整映射，operation/request hash/schema 等 JSON 字段也未与持久列完整核对。
- [严重] `src/server/storage/current-data-invariants.ts:402-428`: Checklist 状态转换未证明目标 item、动作方向及仅一项变化，非法 current 状态可通过 reopen。
- [一般] `components/collaboration/structured-message-block.tsx:226-241,509-524`: VERSION_CONFLICT 后只显示新版本号而未呈现最新状态，却允许按旧动作重新提交。
- [一般] 全量测试 227 files / 1803 tests 中 7 项失败：review rollback 后 current invariant 非法、5 个旧 Mission create caller 缺新 operation/version 契约，以及 1 个 SQLite busy-timeout。

## Spec

- [严重] File Reference 未冻结并校验公开名称，违反 `spec.md:45-47,77,100,103`。
- [严重] current reopen 未从 operation/block/state/source 全集穷尽验证 Structured Message DAG 与 outcome matrix，违反 `spec.md:68,130-135,149-150,208-210`。
- [一般] `structured-message-block.tsx:385-395`: 已知 block 的 accessible region 名称未明确区分五种正式类型，违反 `spec.md:19,157-159,176,200`。
- [一般] `structured-message-block.tsx:351-382,385-388`: 来源读取期间未把 `sourcePending` 反映到 block 的 `aria-busy`，违反 `spec.md:83,164,201`。

## 验证

- Spec 聚焦测试 15 files / 133 tests 与 `smoke:structured` 12 assertions / 3 axe states 通过。
- Standards `npx tsc --noEmit` 通过；全量测试失败清单已固定，不重复运行全量。
- 同类评审连续两轮仍有严重/一般问题，按 `AGENTS.md` 返回规格/架构拆成后端完整性与 UI 冲突复核两个闭合切片，禁止继续在 S-13 内局部补丁。
