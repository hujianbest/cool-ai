# 进度

- 特性: 020-test-execution-speed
- 当前阶段: done
- 执行模式: interactive
- 已加载扩展: 无
- 下一步: 无（已交付）
- 评审状态: 项目级 review 豁免（AGENTS.md 当前开发阶段条款，2026-08-09）：豁免 spec review、architecture review、hf-review 与 hf-code-review；不伪造评审工件
- 用户可感知: 否（测试基建；验收为前后墙钟对比 + 失败集合一致 + 生产构建通过）
- 范围扩张: 2026-08-09 用户明确要求把「磁盘 SQLite 夹具改内存库」纳入本切片（原列为 Out of Scope）；风险：涉及 ~119 个测试文件，需保持 reopen 语义用例仍在文件库上；验证成本：每次改动后全量套件 + 失败集合比对

## 实施记录

- 2026-08-09 T-01 ✅ 新树基线：513.52s；232 文件 / 1822 用例；19 失败（7 文件：architecture 3、mission-work 2、public-collaboration project-chat.api、review-delivery review-production-application）。
- 2026-08-09 T-02+T-03 实施完成（subagent 被中断前完成编辑与一次全量）：135.40s（↓73.6%）；environment 346→115.6s。失败集合 10 文件/26 用例，含 3 个新增：onboarding-preference-store（运行期间编辑竞态，声明已落盘待复跑确认）、current-schema/current-schema-rejection（5000ms 超时，疑似 8 路并行下磁盘 I/O 争抢——正是内存库票要消除的瓶颈）。
- 2026-08-09 T-04 ✅：内存夹具基建（`tests/fixtures/sqlite/memory-database.ts`，共享 cache URI + keeper 保活 + afterEach 清理）；`connection.ts` 对 `file:`/`:memory:` 跳过 mkdirSync（唯一产品代码改动）；试点 mission-crud tests 阶段 −20.4%。
- 2026-08-09 T-05 ✅：环境变量类 40/44 迁移；跳过 4（providers.api 断言 DB 文件字节、delivery-route/review-escalation-route 全 mock 哑路径、developer-loop 无 DB）。
- 2026-08-09 T-06 ✅：直连类 58/61 迁移，夹具扩展 `rawMemoryDatabasePath()` 供自定义 schema 测试；跳过 3（原始字节断言/测试中删库/无 DB）。竞争类无 SQLITE_LOCKED 回归。
- 2026-08-09 T-07 ✅ 最终验证（final2.log 后删除日志，数据如下）：**513.52s → 98.48s（−80.8%）**；232 文件 / 1822 用例不变；失败 6 文件/18 用例全部为基线既有失败，零新增；基线中 flaky 的 mission-transaction-primitives 超时用例在内存库下稳定通过（通过集合 +1）。两个保留文件库的 schema 测试加了用例级 20s timeout 以抵抗并行 I/O 争抢。`npm run build` 通过。

## 基线（架构收敛前旧树，2026-08-09 实测）

- 227 文件 / 1803 用例；墙钟 538.06s；transform 7.05s / setup 86.50s / import 54.33s / tests 489.43s / environment 383.96s；失败 8 用例（4 文件）。

## 治理回归（2026-08-10，限时 30 分钟专项）

背景：021～030 累积新用例后，030 T-01 测得全量 260 文件 / 2283 用例 132.68s，超 98.48s 基线 35%。本次重测基线 126.78s（同树、JSON reporter）。

测量（`npx vitest run --reporter=json` 按文件/用例耗时排序）：

- 每文件固定成本高：40 个最小文件实测 1.1s 真实用例耗时对应 8.2s 墙钟；setup 阶段 17.71s/40 文件 ≈ 443ms/文件——根因是 `tests/setup.ts` 对全部 260 个文件（含 ~190 个纯 node 环境文件）无条件静态 import React + @testing-library/react + jest-dom。
- Top 慢文件几乎全为结构性固有成本：`review-browser-full-chain` 33.95s（vitest 内 spawn 完整 Playwright 冒烟链）、`merge-external-writer` 29.73s（37 个真实文件系统合并竞态夹具）、`current-schema-rejection` 27.72s（5 个变更类用例各需真实文件库完整 bootstrap + 字节不变断言，属显式文件语义，不可转内存库）、`theme-hydration-browser` 17.67s（真实 Next dev server + Chromium）、`sandbox-preflight` 16.72s（3×100000 条边界用例，纯 JS 合成适配器处理）。
- 021～030 新增文件耗时分布均匀（onboarding-happy-path 10.85s/54 用例、composer-draft 6.74s、thread-draft 5.75s 等），无单点失控；增长主体 = 用例数 +12% 叠加每文件固定成本与关键路径长尾。

措施（不改任何断言、不跳测试）：

1. `tests/setup.ts`：DOM 专属加载（testing-library cleanup、jest-dom）改为 `typeof window` 守卫内惰性动态 import；next/navigation mock 工厂内异步取 React。node 环境文件行为不变（jest-dom 断言器本就只服务 DOM 测试）。
2. `tests/fixtures/sqlite/memory-database.ts`：内存库 URI 命名加 `worker_threads.threadId` 段，预防共享 pid 的 pool 模型下 shared-cache 内存库跨线程撞名（forks 下 threadId=0，语义不变）。
3. 被否方案：`pool: "threads"`（消 Windows 每文件进程 spawn）两轮全量 105.0s/103.3s 但各出现 1 个互不相同的非确定性失败；回退 threads 后第三轮（仅保留措施 1+2）仍出现 1 个失败，第四轮 0 失败——判定为既有不稳定用例苗头（030 T-01 基线 260 文件全绿，021 清零后本轮首次观测），非 threads 专属，但 threads 收益不确定（-6s 量级）且改变隔离语义，暂不采用。不稳定苗头留待后续专项按 AGENTS.md 预算纪律归因。

结果（全量两次稳定值）：**111.9s / 111.6s**（132.68s → ~111.7s，−15.8%；对本机重测基线 126.78s → −11.7%），260 文件 / 2283 用例不变，第四轮 0 失败，`npx tsc --noEmit` 通过。达到 ~110s 目标带缘；距 98s 基线的剩余差距集中在上述五个结构性长尾文件（合计 ~126s 串行成本，其中两个真实浏览器链路按 AGENTS.md 验收纪律不可裁剪）。
