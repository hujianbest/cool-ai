# 审计投影 MVP（AUD-MVP）需求规格

- 日期: 2026-08-10
- 特性: 028-audit-projection-mvp
- 对应切片: S-23 的 AUD-MVP 纵切（CI-3.8 第一子片；S-23 为跨 owner 追踪别名，本片是其首个实现片）
- 模式: 建造
- 用户可感知: 是（最薄只读审计列表）
- 执行模式: auto（用户不在场，问题按助手推荐处理并记录假设）
- 共享理解来源: `product/backlog.md` S-23 条目与 `CAP-OPS-01`/`CAP-OPS-02`/`CAP-EXE-05` 条目（auto-approved 2026-08-10）
- 公共行为接缝: Audit Outbox Write（Safe Execution 原子写入）；Projection Consumer（Operations Projection）；Audit Query；审计列表 UI
- 主子系统: Operations Projection；主 Capability: `CAP-OPS-02`（本片建立最薄 Safe Execution 审计查询/展示）；协作 Capability: `CAP-EXE-05`（同纵切原子写入 source-owner event）；基础: `CAP-OPS-01`（consumer/checkpoint/rebuild/freshness）

## 问题陈述

各 source owner（Safe Execution、Collaboration、Mission & Work 等）已在事务内提交丰富事件事实（execution_events、collaboration_events 等），但产品没有任何横切只读投影：owner 无法按项目查看"发生了什么"的统一审计视图；后续搜索（S-17）、时间轴（S-39）、健康（S-35）都缺投影消费基座。

## 解决方案

建立投影消费基座与第一个纵切：Safe Execution 在写 `execution_events` 的同一事务内原子追加一行全局有序 outbox 事件（已脱敏 public payload）；Operations Projection 的消费者按 checkpoint 幂等追平 outbox 到审计投影表；owner 可按项目查看 Safe Execution 审计事件只读列表（类型/actor/时间/来源 execution 定位），并看到投影新鲜度（落后/重建中）。consumer 支持确定性 rebuild（清空投影+重置 checkpoint+重放），任何异常 fail-closed 不伪造最新。

## 用户故事

1. **作为 owner，我想按项目查看 Safe Execution 审计事件列表，从而知道执行域发生了什么。**
   - 列表倒序展示事件（类型可读文案、actor、时间、来源 execution）；分页/加载更多；空态明确。
   - payload 只含既有 public 脱敏字段；凭据、隐藏推理、原始 provider 响应永不可见（源 payload 已受 64KiB json_valid 约束，投影再经白名单字段提取）。
2. **作为 owner，我想看到投影新鲜度，从而知道列表是否可信。**
   - 视图显示"已追平/落后 N 条/重建中"状态；落后时如实标注，不假装最新。
   - 投影异常（rebuild 失败、checkpoint 损坏）时 UI 显示脱敏错误态，列表不展示半成品数据。
3. **作为 owner，我相信审计数据只读且可追溯，从而放心用它定位问题。**
   - 每条事件可定位来源 execution（复用现有执行详情导航）；投影绝不回写源事实；rebuild 后内容与源一致（确定性校验：投影行数与 outbox 一致）。

## 实现决策

- schema identity 14→15，三表：
  - `audit_event_outbox`（source owner 写）：id PK、project_id、source（CHECK 'safe_execution'）、event_type、payload_json（json_valid、≤64KiB、白名单脱敏字段）、occurred_at、outbox_seq INTEGER 全局唯一单调（由写路径 `COALESCE(MAX(outbox_seq),0)+1` 事务内分配）；与 execution_events 同事务插入。
  - `audit_projection_checkpoints`：consumer_id PK、last_outbox_seq、status（idle/rebuilding）、updated_at。
  - `audit_event_projection`：投影读模型（outbox_seq UNIQUE、project_id、source、event_type、public 字段展开列：actor_type/occurred_at/execution_id 等查询所需列、payload_json）。
- Consumer（CAP-OPS-01）：`catchUpAuditProjection(databasePath)` 幂等追平（批次 checkpoint 前移，重复执行/重放不产生重复行——INSERT OR IGNORE by outbox_seq）；`rebuildAuditProjection(databasePath)` 事务内清投影+重置 checkpoint+全量重放；`getAuditProjectionFreshness` 返回 {status, lag}（lag=max(outbox_seq)-last_outbox_seq）。单写者守卫：rebuild 与 catchUp 互斥（checkpoint 行 version/状态机）。
- Safe Execution（CAP-EXE-05）：勘察 execution_events 全部写入点，在同一事务追加 outbox 行；payload 白名单提取（type/actor/时间/execution 引用等公开字段，剔除任何非公开内容）；writer-ownership manifest 登记 outbox 归 safe-execution 写者、projection/checkpoint 归 operations-projection 写者。
- Query（CAP-OPS-02 最薄）：`listProjectAuditEvents(projectId, {cursor?/limit})` 倒序分页；tuple 校验；跨 project 404/空。
- UI：项目级新面板区"审计"（形态贴合现有面板/tab 范式）：事件列表 + 新鲜度徽标 + 来源定位 + empty/loading/error 全态。触发时机：进入面板时先 catchUp 再查询（MVP 同步追平，不建后台守护——记录假设）。
- 不变量：reopen 校验 outbox_seq 唯一/单调引用完整、checkpoint ≤ max(outbox_seq)、projection 与 outbox 行数一致（或其差等于 lag）。

## 测试决策

- TDD 每轮一个公共缝 RED + 最小 GREEN；内存库夹具。
- **Outbox 写缝**：execution 事件写入 → outbox 同事务可见；payload 白名单无敏感字段；seq 单调。
- **Consumer 缝**：catchUp 幂等（两遍同结果）、重放不产生重复、rebuild 确定性（重建后投影==outbox 全集）、freshness lag 计算、互斥守卫。
- **Query/UI 缝**：分页、tuple 隔离、empty/loading/error、新鲜度徽标、来源导航。
- **浏览器验收**：触发一次真实执行事件造数（复用现有 smoke 的执行造数）→ 审计列表呈现 → 新鲜度已追平 → desktop/narrow、light/dark、keyboard、axe。

## 范围外事项

- 其他 source owner 的纵切（Collaboration/Mission/Governance/Runtime——后续各自 S-23 子片）；统一审计浏览器组合视图（S-23 汇总）；后台常驻 consumer 进程；线程搜索索引（S-17 复用本基座另建投影）。
- 导出（S-38）、通知（S-41）。

## 补充说明

- 单一用户结果（可查看 Safe Execution 审计并知其新鲜度）+ 基座建设；4 张票；新子系统需谨慎但范围已压到最薄。
- 评审按项目级 review 豁免跳过；默认选择记入 product/assumptions.md。
