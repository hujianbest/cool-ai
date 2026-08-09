# 结构化消息完整性需求规格

- 日期: 2026-08-09
- 特性: 017-structured-message-integrity
- 模式: 建造
- 用户可感知: 是（File Reference）
- 执行模式: auto
- 公共行为接缝: `openDatabase(databasePath)`；Structured Message Source Public Read

## 问题陈述

S-13 第 3 轮 code review 证明 current 数据仍可出现三个信任缺口：File Reference 读取时重新查询可变且可能泄漏的 artifact 名称；reopen 没有从 operation/block/state/source 全集双向证明 outcome、DAG 与来源完整性；Checklist 与 completed operation 的正式结果可能不完整或方向非法。现有全量测试还固定了 review rollback 后非法 current 数据、旧 Mission create caller 契约遗漏和一次 SQLite busy-timeout。

## 解决方案

在创建 File Reference 时把脱敏、限长的公开名称和精确 source version 冻结为正式事实，公共读取只返回该快照。直接修改唯一 `CURRENT_SCHEMA` 和 current validators，使 `openDatabase` 对 operation/block/state/source 全集做双向穷尽验证；任何孤儿、重复、字段分歧、非法 Checklist 转换或不完整 completed outcome 均稳定失败关闭。同步修复已知 current 测试图与 caller，并在有界诊断预算内解决 busy-timeout。

## 用户故事

1. **作为 owner，我想 File Reference 始终显示创建时的安全名称，从而不会因来源后来改名或路径泄漏而改变历史。**
   - 提交前从已验证 source tuple 取得明确 source version，生成并校验公开名称快照；名称按现有敏感模式脱敏并按 grapheme 限长。
   - artifact 后续改名、变为 latest 新版本或宿主内容变化后，公共读取与 reopen 仍返回原名称和原 source version。
   - 宿主绝对路径、凭据、raw provider 内容或未验证名称不得进入持久公开事实、公共错误、日志或 DOM。

2. **作为 owner，我想 reopen 拒绝不完整的结构化消息图，从而 current 数据不会被误当成合法历史。**
   - validator 从 operation、block、state revision/head、source、Decision、Business Receipt 与 decision Fact 各全集双向遍历，而非只从可达成功路径抽样。
   - 每个关系必须满足 project/thread/run/message/block、actor、operation/request hash/schema、block revision、source identity/version、from/to state version 与 action/item 全字段一致。
   - state revisions 对每个 block 形成连续、唯一、无分叉的 DAG，head 精确指向唯一末端；未知、孤儿、重复、跨 tuple 或不一致事实失败关闭。

3. **作为 owner，我想 completed Inline Decision 恰好对应一份完整结果，从而重放和审计没有缺口或重复。**
   - 每个 completed success operation 恰有一个 Decision、一个 Business Receipt、一个 decision Fact；三者与 operation/block/state/source 逐字段一致。
   - 每个 Decision、Receipt 与 decision Fact 反向恰好属于一个 completed success operation；VERSION_CONFLICT 等非成功终态保持零 Decision、零业务 Receipt、零 decision Fact。
   - 相同 operation/hash 的重放只返回原结果，不创建第二份业务事实。

4. **作为 owner，我想 Checklist 每次只发生一项合法方向变化，从而 reopen 不接受伪造状态。**
   - `check_item` 只能把指定既有 item 从 unchecked 变为 checked；`uncheck_item` 只能反向变化。
   - 一次成功转换恰改变目标 item 的 checked 状态；其余 item、顺序、文本、block revision 与非状态内容完全不变。
   - 目标缺失、方向无变化或反向、两项以上变化、内容漂移、版本跳跃均失败关闭。

5. **作为维护者，我想 current schema 与测试调用方准确表达现行契约，从而完整性修复不会靠兼容分支掩盖。**
   - schema 变化直接更新 `CURRENT_SCHEMA` identity/inventory、fresh bootstrap 与 exact reopen tests；不新增 migration、legacy fixture 或修复非法非空数据的路径。
   - review rollback fault 后必须全量回滚，不能留下 exact schema 下仍会被 reopen 接受的非法事实。
   - 旧 Mission create 测试 caller 显式提供严格 UUID `operationId` 与 `expectedVersion=0`；不恢复随机/default fallback。
   - 已知 SQLite busy-timeout 先在 15 分钟内最多复跑 10 次量化；记录锁持有者、连接/事务生命周期与复现率，找到根因后以确定性生命周期修复，不靠无限重试、扩大 timeout 或跳过断言。

## 实现决策

- File Reference write Interface 接受已验证且版本化的 source projection，并在事务内冻结 `{publicName, sourceEntityVersion}`；名称校验复用既有敏感模式、Unicode grapheme 与稳定脱敏错误。
- Source Public Read Interface 只由持久冻结 projection 构造响应；禁止 join 可变 artifact `name`、查询 latest、回退宿主路径或在读取时重新解释来源。
- `openDatabase` 继续是 schema 生命周期唯一外部 seam。`CURRENT_SCHEMA` 是唯一 DDL source；schema 形态变化更换 current identity，fresh/reopen 共用 exact 与 data validator。
- current data validator 对 operation/block/state/source 与结果表采用全集、双向、恰好一次检查；不能以单向 foreign key 或“有一条可达路径”代替穷尽性。
- review rollback 与 Mission caller 是本片已知回归收口，不扩张 Mission 产品行为。

## 测试决策

- TDD 每轮只有一个因缺失行为而失败的公共 seam RED，再做最小 GREEN；不测试 validator 私有 helper，不用编译失败、弱化断言、skip 或 mock 被测主体制造 RED。
- **File Reference public read seam**：提交、读取、改名、创建新 source version、process reopen；断言冻结名称/version、无 latest fallback 与响应/DOM/日志无敏感标记。
- **`openDatabase` seam**：从合法 current owner fixture 做单一 corruption，覆盖 operation/block/state/source/outcome/DAG 的每个正反向孤儿、重复与字段分歧；断言稳定脱敏失败且 opener 零修复写。
- **Checklist/operation seam**：通过正式 decision command 创建合法图，再逐类变异为非法 current 数据；成功 completed 恰一组结果，冲突终态零结果。
- **回归 seam**：review transaction fault 全回滚；Mission create callers 显式 command identity/version；busy-timeout 按 15 分钟/10 次停止条件量化并保留确定性回归。
- **浏览器验收**：真实 `smoke:structured` 覆盖 File Reference 创建后改名与 reopen，桌面/窄屏只显示冻结名称，宿主路径/凭据不进入 DOM，axe 无 serious/critical；不引入新视觉系统。

## 范围外事项

- stale VERSION_CONFLICT 的最新 state 呈现与重试 UI（由 018 负责）。
- 新 block 类型、File Reference 编辑/重命名、任意宿主读取、source latest 导航或新 Approval。
- 首次发布前 schema migration、legacy 数据兼容、自动修复非法 current 数据。
- 与固定失败清单无关的重构或测试清理。

## 补充说明

- 本片一个用户结果、两个紧密耦合公共 seam、5 张票；schema 与 source read 的变化共同证明“reopen 后仍冻结完整无泄漏”，未捆绑独立产品结果。
- 独立 spec-review 尚未执行；`architecture.md` 与 `tickets.md` 仅为待审草案，不构成阶段通过。
- 用户确认: auto-approved 2026-08-09
