# 017 — 结构化消息完整性

- 模式: 建造
- 用户可感知: 是（File Reference）
- 执行模式: auto
- 对应补救: S-13 第 3 轮 code review 的后端完整性发现
- 主架构单元: Public Collaboration 持久事实 + SQLite Storage Adapter
- 公共行为接缝: `openDatabase(databasePath)`；Structured Message Source Public Read
- 依赖: 016 首次发布前唯一 canonical schema 已完成
- 阻塞: 015/S-13 第 4 轮 code review 与 ship

## 目标

让 owner 可信任 reopen 后的结构化消息和 File Reference 仍是创建时冻结、完整、无泄漏的正式事实。

## 范围

- File Reference 提交时冻结经脱敏、grapheme 限长的公开名称与精确 source version；读取只返回冻结投影，不查询可变名称或 latest。
- 直接更新唯一 `CURRENT_SCHEMA`、fresh bootstrap、exact reopen 与 current data invariants；不新增 migration 或 legacy 分支。
- 从 operation、block、state、source 全集双向穷尽 Structured Message outcome、DAG 与 source 关系。
- Checklist 成功决定只允许目标 item 按动作发生唯一合法方向变化，其余内容与 item 不变。
- completed inline-decision operation 恰有一组匹配的 Decision、Business Receipt 与公开 Fact，反向也无孤儿或重复。
- 修复 review rollback 后仍可落成的非法 current 数据；旧 Mission create 测试 caller 显式传 `operationId` 与 `expectedVersion=0`。
- 稳定诊断并解决一次已知 SQLite busy-timeout；15 分钟预算、最多 10 次量化复现，达到停止条件即记录证据并拆分，不无限循环。

## 非目标

- 不改变五种 block 类型、Inline Decision 动作集合或 UI 视觉系统。
- 不新增 schema migration、legacy adoption/backfill、旧 schema fixture 或数据自动修复。
- 不从宿主路径、可变 artifact name、latest source 或 Provider 原始内容生成公开名称。
- 不顺带修复 stale decision UI 或范围外测试。

## 用户确认

- auto-approved 2026-08-09：按推荐结果拆为 5 张票；默认与公共缝记录于 `product/assumptions.md` A-94～A-95。
