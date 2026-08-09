# 架构 — 回复引用与来源跳转

- 日期: 2026-08-10
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件

## 架构目标

复用现有 Thread Message 命令/读取深模块，在其接缝上新增"回复快照"冻结事实；复杂性留在 Public Collaboration Module 与 SQLite Adapter 内，UI 只消费只读 projection。不新增第二消息状态机、不新增通用引用框架。

## Module 与 Interface

### Public Collaboration Module（扩展既有）

- Command：`postThreadMessage` 系命令输入增加可选 `replyToMessageId`；实现侧在同一业务事务内验证目标消息存在于同 `(projectId, threadId)` 且为可引用消息行，随后原子写入消息行与冻结回复快照列。失败稳定脱敏（目标缺失/跨 tuple/自引用 → INVALID_INPUT 族），零写入。
- Query：`readThreadMessages` 的 `ThreadMessageDto` 增加 `replyTo` 冻结 projection（`{messageId, sequence, authorDisplayName, excerpt}` 或 null）。读侧只解码持久列，不 join 重算 excerpt。
- 公共错误沿用现有 envelope；不含 SQL、宿主路径、凭据或正文回显。

### Current Schema / Data Integrity（扩展既有）

- `CURRENT_SCHEMA`：`collaboration_messages` 增加 `reply_to_message_id`、`reply_to_sequence`、`reply_to_author_display_name`、`reply_to_excerpt`（全部 nullable；无回复时全 null）；identity 更换，fresh bootstrap/exact reopen 测试同步。
- `current-data-invariants.ts` 新增回复边全集校验：四列同 null 或同非 null；非 null 时目标行存在于同 tuple、非自引用、`reply_to_sequence/author/excerpt` 与目标行当前事实一致、目标 sequence 严格小于本消息 sequence。

### Transcript UI（入站 Adapter，扩展既有）

- 消息壳内引用片：中性引用视觉（tokens）、`#sequence · 作者 · excerpt`、button 语义可键盘激活；点击经 sequence 定位（已加载则 scrollIntoView + 高亮，未加载则先请求包含该 sequence 的页）。
- 来源不可用：稳定占位（"来源不可用"类中性文案），不显示伪造作者/摘要，跳转禁用并带可访问原因。
- loading/error/focus 状态沿用既有消息壳模式；桌面/窄屏抽屉模型不变。

## 核心数据

- 回复快照：目标 messageId/sequence/作者显示名/excerpt（脱敏 + grapheme 限长 fail-closed，上限沿用 017 的 160 先例）。
- 跳转锚点：canonical tuple + sequence；DOM id 沿用消息行既有锚点约定（如 `message-<sequence>`，以现有 transcript 实现为准）。

## 关键流程

1. **提交**：校验输入形状 → 同事务验证目标存在且合法 → 生成脱敏限长快照 → 原子写入消息+快照 → 返回新消息 DTO（含 replyTo）。
2. **读取**：分页查询原样解码冻结列 → UI 渲染引用片 → 点击按 sequence 定位/加载 → 高亮目标。
3. **Reopen**：`openDatabase` 在一致快照全集校验回复边 → 非法即 SCHEMA_DATA_INVALID 失败关闭且零写。

## Seam 与测试点

- Seam 1 — Thread Message Command：提交/拒绝矩阵（tests/modules/public-collaboration/thread-message-api.test.ts 或同族新文件）。
- Seam 2 — Thread Message Public Read + `openDatabase`：分页投影与 corruption 矩阵（tests/modules/public-collaboration/ 与 tests/adapters/sqlite/ 现位置）。
- Seam 3 — fact-only Transcript UI：components 下线程消息组件的 jsdom 测试（tests/browser/collaboration/ 现位置）。

## 横切约定

- 错误稳定脱敏；UI 无硬编码视觉值；键盘/焦点/44px/WCAG AA；axe 验收。
- 内存库夹具（tests/fixtures/sqlite/memory-database.ts）；不复制大型 SQL 图，回复夹具加入结构化消息/线程 fixture 构建器族。
- 消息 append-only 是快照一致性校验的前提；本片不引入消息编辑/删除。

## ADR 链接

- 遵守 [ADR-0003](../../docs/adr/0003-pre-release-canonical-database-schema.md)；无新增难逆转决定，不创建 ADR。
