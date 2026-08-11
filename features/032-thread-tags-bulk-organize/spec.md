# 线程标签与批量整理需求规格

- 日期: 2026-08-11
- 特性: 032-thread-tags-bulk-organize
- 对应切片: S-18（CI-2.6）
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto（用户不在场，问题按助手推荐处理并记录假设）
- 共享理解来源: `product/backlog.md` S-18 条目（auto-approved 2026-08-11）；阻塞前置 S-17（`CAP-OPS-02` 线程查询，031 于 2026-08-11 ship）与 S-24（`CAP-GOV-02`，029 于 2026-08-10 ship）均已交付
- 公共行为接缝: Thread Tag Command/Query（Public Collaboration）；Thread List 筛选与投影扩展；Thread Tag Batch 命令；线程区整理 UI
- 主子系统: Public Collaboration；主 Capability: `CAP-COL-02`（本片建立其标签与版本化批量整理部分）

## 问题陈述

线程越来越多，owner 只有列表顺序与收藏（025）两种粗粒度组织手段：无法按主题归类（如「发布」「缺陷」），无法按归类筛选视图，更不能一次性给一批线程加/去归类标记。需要项目内标签：可创建、可检索、可分配到线程、可按标签筛选列表、可批量整理，删除标签后各视图与刷新后状态一致。

## 解决方案

在 Public Collaboration 线程目录上建立项目作用域标签事实（`thread_tags` + `thread_tag_edges`）：标签名称项目内折叠唯一、可搜索（含用量计数）；线程↔标签分配幂等；线程列表复用 025/031 同一 list 缝按标签筛选并在列表项恒在投影标签；批量整理=多选线程批量加/去标签，走持久 operation receipt（重放安全、全有或全无、版本化可追溯）；删除标签同事务清理全部引用边并返回影响计数，UI 强确认。跨 tuple 一律 404，跨项目绝不泄漏。

## 用户故事

1. **作为 owner，我想创建并搜索项目内标签，从而建立可复用的归类词汇。**
   - 名称 trim 后非空、≤40 grapheme；项目内折叠唯一（NFC + 大小写折叠）；重复创建同义名称幂等返回既有标签（`created:false`），不产生第二行。
   - 标签列表/搜索按名称字面 contains（ASCII 折叠，与 031 LIKE 语义一致），每项带用量计数（已分配线程数）；空结果有 empty 态。
2. **作为 owner，我想把标签分配到线程并按标签筛选列表，从而按主题组织视图。**
   - 单线程分配/解除幂等（重复操作不产生第二行或错误）；跨 tuple（他项目标签/线程组合）稳定 404。
   - 线程列表项恒在投影 `tags`（id+name）；列表可按单一标签筛选（与已收藏视图互斥、与游标分页兼容），普通列表排序完全不变。
3. **作为 owner，我想多选线程批量加/去标签，从而一次性完成整理。**
   - 批量输入 operationId + threadIds + addTagIds/removeTagIds；单事务全有或全无；同 operationId 同内容重放返回原响应（不重复生效），异内容 409。
   - 上限保护（threadIds ≤100、add+removeTagIds ≤20，自动去重）；任一 id 跨 tuple 即整体 404 回滚；批量破坏性移除在 UI 有确认步骤。
4. **作为 owner，我想删除不再用的标签，从而保持词汇表干净。**
   - 删除需 UI 强确认（对话框如实显示将解除 N 条分配）；删除同事务清理全部引用边并返回计数；线程、消息与其他标签不受任何影响。
   - 删除后筛选条/列表项 chips/分配选择器即刻消失该标签，重启与刷新后状态一致。

## 验收判据

- 创建：合法名称创建成功；空/纯空白/超长名称 400；折叠冲突幂等返回既有标签；他项目标签不可见。
- 搜索：名称 contains 命中、用量计数正确、空结果 empty 态。
- 分配/筛选：幂等切换；列表项投影与筛选结果与服务端一致；互斥与游标语义稳定；重启保持。
- 批量：真实浏览器内多选→批量加/去→确认→列表与投影一致；同 operationId 重放安全；批量移除有确认。
- 删除：强确认后删除，引用边全清且计数如实；刷新与重启后各视图一致；跨项目零泄漏（他项目标签不可见、跨 tuple 操作 404）。
- 质量：desktop/narrow × light/dark、键盘、focus、44px、axe 无 serious/critical；秘密扫描无泄漏；全量测试、类型检查、生产构建通过。

## 实现决策

- schema identity 17→18 **纯增三张表，零既有表改动**：`thread_tags`（id PK、project_id、name CHECK trim/非空、name_key 折叠唯一键、created_at ISO GLOB；FK→projects CASCADE）、`thread_tag_edges`（PK (project_id,thread_id,tag_id)、created_at；FK→threads/tags 双 CASCADE）、`thread_tag_operations`（项目作用域批量 receipt：id/request_hash/response_json/created_at）；`thread_tag_edges_by_tag` 索引；reopen 数据不变量新增两条（边⊆threads、边⊆tags）；write-ownership 登记 public-collaboration；全部 identity 引用同波次同步（031 T-01 清单同例）。
- Commands（公开缝扩展）：`createThreadTag`（幂等）、`deleteThreadTag`（同事务清边+计数）、`setThreadTagAssignment`（幂等、receipt-less，025 收藏先例）、`applyThreadTagBatch`（持久 receipt、原子、上限）；Queries：`listProjectTags`（可选 query、用量计数）；`listThreads` rawInput 增 `tagId` 过滤、ThreadListItemDto 恒在 `tags` 投影。wire DTO 下沉 `src/shared/collaboration-contracts.ts`（A-122/A-145 先例）。
- 路由最少面：`GET/POST /api/projects/[projectId]/thread-tags`、`DELETE …/thread-tags/[tagId]`、`PUT …/threads/[threadId]/tags`、`POST …/thread-tag-batch`；`GET …/threads` 白名单 +`tagId`。严格校验/脱敏 envelope/no-store/tuple 404 逐条对齐既有惯例。
- 删除语义与确认：同事务显式 DELETE 边→删标签（FK CASCADE 仅兜底线程级联），响应 `removedEdgeCount`；确认走 UI 强确认对话框（删除前经标签列表的用量计数如实显示影响面），**不走 CAP-GOV-02 审批中心**（决策与理由见 architecture.md 与 A-185）。
- 审计：单写/分配为偏好类组织事实，行内 created_at 足够（025 先例）；批量以 `thread_tag_operations` 持久 receipt 承载「批量写入版本化」。**标签写不进 audit_event_outbox**（决策见 architecture.md 与 A-188）；标签不入 thread_search_index 正文，031 检索范围不变。
- UI：线程区「管理标签」对话框（创建/搜索/删除+强确认）、列表项标签 chips、筛选 chip 条、「整理线程」多选+批量条（加/去标签+确认）；tokens/44px/键盘/focus/全态/防陈旧沿用既有纪律。
- 错误稳定脱敏（复用 INVALID_INPUT/RESOURCE_NOT_FOUND/OPERATION_CONFLICT 既有词汇）；tuple 联合校验一致。

## 测试决策

- TDD 每轮一个公共缝 RED + 最小 GREEN；需要数据库的测试一律用 `tests/fixtures/sqlite/memory-database.ts` 内存库夹具。
- **Tag Command/Query 缝**：创建幂等/折叠唯一矩阵（NFC、大小写、trim）、grapheme 上限、搜索 contains 与用量计数、删除清边计数、跨项目 404/隔离、reopen 幂等与不变量负例。
- **List 缝**：tagId 过滤、互斥/游标语义、tags 恒在投影、普通列表排序不变。
- **Batch 缝**：重放/409、原子性负例（部分失配零生效）、上限与去重、receipt 持久可查。
- **UI 缝（jsdom）**：管理对话框、chips、筛选、批量条、确认对话框、全态与键盘、target switch 防串。
- **浏览器验收**：smoke:threads 增加标签段：创建→分配→筛选→批量→删除→重启保持→跨项目隔离；desktop/narrow × light/dark、keyboard、focus、44px、axe。

## 范围外事项

- 标签重命名、颜色/图标、嵌套分组、跨项目标签；标签回收站（S-20 范畴；改名需求由删除+重建覆盖）。
- 标签进入搜索索引正文或搜索面过滤（031 检索范围不变；按标签筛选走 list 缝）。
- 批量删除/归档线程（S-20）、标签审计事件进 audit outbox（本片决策不进，A-188）、审批中心接入（A-185）。

## 补充说明

- 单一用户结果（用标签把线程整理成可筛选的主题视图）；5 张票。
- 评审按项目级 review 豁免跳过（AGENTS.md 2026-08-09 起生效，不伪造评审工件）；默认选择记入 `product/assumptions.md`（A-182 起）。
