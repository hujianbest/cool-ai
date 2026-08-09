# 进度

- 特性: 022-reply-references（对应切片: S-14 / CI-2.11）
- 当前阶段: done
- 执行模式: auto（用户 2026-08-09 明示：不在电脑前，问题按助手推荐处理）
- 已加载扩展: 无
- 下一步: 无（done；演示验收证据见下方 T-04 实施记录）
- 用户可感知: 是
- 评审状态: 项目级 review 豁免（2026-08-09）；不伪造评审工件；spec/architecture/tickets 由主会话按 backlog S-14 已确认条目直接产出
- 共享理解: backlog S-14 条目（演示判据/约束/准入）视为 auto-approved 2026-08-10

## 实施记录

- 2026-08-10 特性开立：依据 backlog S-14 准入（前置 CAP-COL-01 与 CAP-COL-02 Thread 核心均已交付）直接 to-spec → to-architecture → to-tickets 连续推进并进入 implement。
- 2026-08-10 T-01 完成（命令缝）：`CURRENT_SCHEMA` 为 `collaboration_messages` 加四可空回复列+自引用 FK，identity 9→10；提交事务内验证目标同 tuple 存在且合法并冻结脱敏限长快照；拒绝矩阵/敏感边界/重放聚焦套件全绿。默认记录 A-109。
- 2026-08-10 T-02 完成（读取+reopen 缝）：`ThreadMessageDto.replyTo` 恒在字段，分页读取与 facts 嵌套投影冻结快照；current-data-invariants 新增回复边全集双向校验（JS 校验器比对 trim 后 excerpt）；orphan/cross-tuple 由 FK 拦住，self/快照分歧/sequence 矛盾/null 不一致由新校验器 fail-closed 且零写。默认记录 A-110。
- 2026-08-10 T-03 完成（fact-only Transcript UI 缝）：UI 严格信封（onboarding-guide-machine MESSAGE_KEYS、面板 mutationIds）接受并校验 replyTo；transcript-model 投影 `replyTo`（畸形即 invalid）；引用片 `#sequence · 作者 · excerpt`（tokens、button、键盘激活、aria-label 含可见文本）；点击经 messageRefs 定位 scrollIntoView+1600ms 高亮+焦点，未加载则复用 facts 分页缝加载至出现或耗尽；不可用来源渲染中性占位（aria-disabled+原因可访问，不显示快照内容）；跳转全程 epoch/abort 守卫，切换目标丢弃在途定位。RED 证据：信封修复前 11/11 失败、仅信封接受后 6/6 新用例失败（无引用片/无占位）；GREEN 后 tests/browser+tests/shared 488/488、modules+adapters 619/619、`npx tsc --noEmit` 干净。默认记录 A-111。
- 2026-08-10 T-04 完成（真实浏览器验收）：smoke:threads 新增回复引用验收段——真实命令缝 POST 回复（201+冻结快照逐字段断言+DB 回复边落库断言）、键盘 Tab 聚焦引用片（focus-visible 环非 none 断言）+Enter 跳转、目标 li 焦点+`reply-target-highlight` 高亮与消退、不可用来源中性占位（aria-disabled+原因可访问、DOM 不渲染被裁目标、激活无跳转）、desktop light/dark 与 narrow 三处 axe 全零违规、窄屏双引用片 ≥44px。RED 证据：未改 smoke 先败于 identity 断言 `10 !== 9`（T-01 后 smoke 漂移）；随后锁定两处真实失败——持久层裁剪被 `thread_fact_no_delete` 触发器拒绝（IMMUTABLE_THREAD_FACT，证明"目标被裁"只能构造于响应层，改用 facts 响应路由拦截丢弃目标事实）、在途 facts 请求守卫吞掉已加载目标的键盘跳转（产品缺陷，已修：已加载定位路径不再受在途守卫，jsdom 回归用例先 RED 后 GREEN）。既有 returnLink focus+Enter 步骤遇焦点竞争，加一次性重试保持键盘语义。结果：smoke 14 断言+7 axe 状态全过；全量 `npx vitest run` 1888/1888、`npx tsc --noEmit` 干净、`npm run build` 通过；证据 `features/014-persistent-project-threads/evidence/persistent-threads-reply-reference.png` 与 `persistent-threads-results.json`。未动 review-browser-full-chain flaky 选择器（其唯一一次失败系我并行运行 build 污染 `.next` 所致，串行重跑即过，非选择器问题）。默认记录 A-112。
