# 架构 — 线程标签与批量整理

- 日期: 2026-08-11
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件

## 架构目标

在 Public Collaboration 线程目录上加项目作用域标签事实与版本化批量整理；复杂性（折叠唯一、清边、重放）留在 SQLite Adapter；UI 只消费列表投影扩展与整理缝。零既有表改动、零投影协议改动。

## Module 与 Interface

- Commands（`src/modules/public-collaboration/public/commands.ts` 扩展）：
  - `createThreadTag(databasePath, projectId, rawInput)` → `{tag, created}`；name trim 后 1..40 grapheme（Intl.Segmenter zh-CN，`graphemeLength` 先例）、`name_key`=NFC+大小写折叠；name_key 冲突幂等返回既有标签（`created:false`）。
  - `deleteThreadTag(databasePath, projectId, tagId)` → `{tagId, removedEdgeCount}`；同事务显式 DELETE edges → DELETE tag；跨项目 404。
  - `setThreadTagAssignment(databasePath, projectId, threadId, rawInput{tagId, assigned})` → `{projectId, threadId, tagId, assigned}`；幂等 upsert/delete（025 receipt-less 偏好类先例）；跨 tuple 404。
  - `applyThreadTagBatch(databasePath, projectId, rawInput{operationId, threadIds, addTagIds, removeTagIds})` → `{operationId, applied, replayed}`；单事务：receipt 查重/冲突 → 全量 tuple 校验（任一失配整体 404）→ 幂等边 upsert/delete → 写 receipt。
- Queries（`queries.ts` 扩展）：
  - `listProjectTags(databasePath, projectId, rawInput{query?, limit?})` → tags + threadCount；query 为 `instr(lower(name), lower(?))>0` 字面 contains（031 A-169 语义，零通配符）；排序 name 码元序 + id 决胜；limit 默认 50、上限 100。
  - `listThreads` rawInput 增 `tagId`：与 `favoritesOnly` 互斥（400 fields）；排序不变（last_activity_sequence DESC）故与 cursor 兼容；ThreadListItemDto 恒在 `tags: ThreadTagRefDto[]`（页面线程 id 批量第二查询，无 N+1）。
- schema identity 17→18（纯增，零既有表改动）：
  - `thread_tags(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL CHECK(length(name)>=1 AND name=trim(name)), name_key TEXT NOT NULL CHECK(length(name_key)>=1), created_at ISO GLOB CHECK, UNIQUE(project_id,id), UNIQUE(project_id,name_key), FK(project_id)→projects ON DELETE CASCADE)`。
  - `thread_tag_edges(project_id, thread_id, tag_id, created_at ISO GLOB CHECK, PRIMARY KEY(project_id,thread_id,tag_id), FK(project_id,thread_id)→collaboration_threads ON DELETE CASCADE, FK(project_id,tag_id)→thread_tags ON DELETE CASCADE)`；索引 `thread_tag_edges_by_tag(project_id, tag_id, thread_id)`（筛选/用量/清边共用）。
  - `thread_tag_operations(id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind='tag_batch'), request_hash TEXT NOT NULL CHECK 64-hex, status TEXT NOT NULL CHECK(status='completed'), http_status INTEGER, response_json TEXT CHECK(json_valid), created_at ISO GLOB CHECK, PRIMARY KEY(project_id,id), UNIQUE(project_id,id,request_hash), FK(project_id)→projects ON DELETE CASCADE)`——项目作用域 receipt 表；不塞进 `collaboration_operations`（其 thread_id NOT NULL 无法诚实承载跨线程批量）。
  - reopen 数据不变量 +2：edges⊆threads、edges⊆tags（favorites 不变量先例；tags⊆projects 由 FK + reopen foreign_key_check 覆盖）；write-ownership manifest owners/notes 登记 public-collaboration；identity 引用同波次同步（rejection 矩阵 legacy 1..17/unsupported 19、unsupported-schema-input 联合、current-schema 双套件、execution-audit-outbox、public-collaboration reopen/source-api/favorite/outbox 套件、persistent-threads smoke user_version——031 T-01 清单同例）。
- 路由（最少面，校验/脱敏/no-store 逐条对齐 favorite/thread-search 先例）：
  - `GET /api/projects/[projectId]/thread-tags?q=&limit=`（q 可选、单值、trim 后 ≤100 grapheme）；`POST` 同路径（严格 JSON `{name}`）。
  - `DELETE /api/projects/[projectId]/thread-tags/[tagId]`（无 body，RESOURCE_ID 校验）。
  - `PUT /api/projects/[projectId]/threads/[threadId]/tags`（`{tagId, assigned}` 严格 DTO）。
  - `POST /api/projects/[projectId]/thread-tag-batch`（静态段零碰撞；`{operationId, threadIds, addTagIds, removeTagIds}` 严格 DTO）。
  - `GET /api/projects/[projectId]/threads` query 白名单 +`tagId`（单值、RESOURCE_ID）。
  - 装配根登记 `threadTagService` 命名空间（threadFavoriteService 先例）。
- DTO 下沉 `src/shared/collaboration-contracts.ts`：`ThreadTagDto`、`ThreadTagRefDto`、`ThreadTagListItemDto`（+threadCount）、`ThreadTagCreateResponse`、`ThreadTagDeleteResponse`、`ThreadTagAssignmentResponse`、`ThreadTagBatchResponse`；`ThreadListItemDto` 增 `tags`（zod strict，组件侧 schema 与同波次夹具同步）。

## 关键流程

1. 管理标签：线程区「管理标签」对话框 → 创建（幂等）/搜索（contains+用量）/删除（强确认对话框，影响计数取自已加载的 threadCount）→ 各视图即时反映。
2. 分配/筛选：列表项或分配选择器切换 → PUT 幂等 → 列表投影 `tags` 与 `tagId` 筛选一致；事实在 canonical DB，重启一致。
3. 批量整理：「整理线程」多选 → 批量条加/去标签 → 确认对话框（移除为破坏性确认文案）→ POST batch（operationId=客户端 uuid）→ 成功 notice + 静默刷新；失败行内 role=alert，同 operationId 重试重放安全。
4. 删除标签：强确认 → DELETE → 边同事务清零、计数如实返回 → 筛选条/chips/选择器即刻消失；刷新/重启一致。

## Seam 与测试点

- Seam 1 — Tag Command/Query + schema：`tests/modules/public-collaboration/thread-tag*.test.ts`（新）+ adapters/sqlite schema 套件。
- Seam 2 — 分配 + List 筛选/投影：tests/modules/public-collaboration/ 扩展 + threads 路由套件。
- Seam 3 — Batch 命令与路由：`tests/modules/public-collaboration/thread-tag-batch*.test.ts`（新）。
- Seam 4 — 整理 UI：`tests/browser/threads/thread-tags-ui.test.tsx`（新，jsdom）。
- Seam 5 — smoke:threads 验收段（persistent-threads-browser-smoke.mjs 内聚单块，031 A-179 段后零位移先例）。

## 横切约定

- 幂等/原子/重放安全；tuple 联合校验与跨项目 404；错误稳定脱敏 envelope（无新错误码：INVALID_INPUT 400 / RESOURCE_NOT_FOUND 404 / OPERATION_CONFLICT 409 既有词汇）；tokens/44px/键盘/focus/全态；epoch+AbortController 防陈旧（029 A-154 先例）；useModalSurface 分层 dismiss（031 A-180 先例）。

## 决策记录（随架构冻结，台账见 `product/assumptions.md` A-182 起）

- 标签写**不进** `audit_event_outbox`：标签是偏好类组织事实（025 行内 created_at 审计先例）；批量整理有 `thread_tag_operations` 持久 receipt 覆盖「批量写入版本化」；搜索索引不含标签正文，consumer 零改动。未来若需标签审计可见性，经 030 纵切模板另行评估（A-188）。
- 删除与批量移除确认走 **UI 强确认**，不走 CAP-GOV-02 审批中心：029 中心服务异步 pending/approve 生命周期的高风险域（执行/内联决策）；标签删除同步、可重建、影响面仅组织元数据；S-20 永久删除才是强治理候选（A-185）。
- 批量 receipt 用独立项目作用域表而非 `collaboration_operations`（thread_id NOT NULL 语义不符）（A-187）。

## ADR 链接

- 遵守 ADR-0003；无新增难逆转决定（schema 纯增，由 canonical 唯一版本承载）。
