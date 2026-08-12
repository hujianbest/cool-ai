# 进度

- 特性: 036-project-workspace-audit-events（对应切片: S-52 / S-23 的 AUD-PWS 纵切，CI-3.8 第四子片）
- 当前阶段: done
- 执行模式: auto（用户 2026-08-09 明示：不在电脑前，问题按助手推荐处理）
- 已加载扩展: 无
- 下一步: 等待下一切片准入
- 用户可感知: 是
- 评审状态: 项目级 review 豁免（AGENTS.md 2026-08-09 起生效）；不伪造评审工件；spec/architecture/tickets 由主会话按 backlog S-23 已确认拆分直接产出
- 共享理解: backlog S-23 source-owner 纵切拆分 auto-approved 2026-08-10；编号规则要求实现片分配新 S-* 号，本片登记为 S-52

## 实施记录

- 2026-08-12 特性开立：035/S-51 ship 后延续审计纵切线，按 S-23 拆分列表顺序取 AUD-PWS；前置 028（基座）、030/035（纵切模板）均已 ship；进入 implement。
- 2026-08-12 T-01 完成（项目级 review 豁免）：schema identity 21→22，`audit_event_outbox.source` CHECK 加 `'project_workspace'`（projection.source 无 CHECK 无需动）；同波次迁移 16 文件（13 个测试文件 23 处 identity 断言 + current-schema + unsupported-schema 夹具 legacy 并集扩至 21/rejection 套件 future 22→23 + 035 套件适配 source 过滤读取）。写入点勘察 4 处全部接线：projects.ts（project_created）、workspace-service.ts（workspace_bound/rebound，同 key 重申不入列）、membership-service.ts（member_joined/removed 每成员一行）、validation-policy-service.ts（appendAudit saved 分支镜像 validation_policy_changed，复用审计行 id）；policy_audits 取舍=复用镜像（audits 表保持领域事实）；宿主路径脱敏=canonical 末段目录名 + grapheme 截断 + 凭据分类 fail-closed，策略 executable/workdir 不入白名单；白名单集中 `project-workspace/audit-event-outbox.ts`；write-ownership manifest sharedAppendWriters 加 project-workspace 并登记 notes。验证：新聚焦套件 10 例 + 聚焦三组目录与 035 套件 31 文件 284 测试通过 + 消费方 24 文件 327 测试通过 + tsc 零错误；默认选择落台账 A-250~A-253（推送集成时因远端 035-UI 切片连续占用 A-242~A-249 而两次改号，见 A-256）。
- 2026-08-12 T-02 完成（项目级 review 豁免）：audit-panel 扩展项目域——`PROJECT_WORKSPACE_EVENT_TYPE_COPY` 6 键文案兼作域分类器（项目已创建/工作区已绑定/工作区已改绑/成员已加入/成员已移除/验证政策已变更，「验证政策」对齐 policy 面板既有词汇，未知类型兜底原文）；域徽标=裸 `.status-label` 中性基类（failed 为 danger 语义弃用，裸基类有 review-material/thread-policy 既有先例）；定位=`/projects/{projectId}` 规范身份链接（「定位来源项目」，锚定面板 prop 非空校验、畸形不渲染；项目子面板无 URL 入口，018 面板内部缝先例）；摘要按 T-01 白名单键呈现（projectName、workspaceName、rebound 前→后、agentDisplayName、修订 #N · M 项），畸形/空字段不渲染，execution 域带同名键不渲染；freshness/empty/error/只读全态零改动。验证：新套件 4 例 RED→GREEN + 聚焦 `tests/browser/project-context` 14 文件 82 测试通过 + tsc 零错误；默认选择落台账 A-254。
- 2026-08-12 T-03 完成（项目级 review 豁免）：落点 smoke:context（复用 035 同文件，审计 trail 四域混合并同步既有段断言）；验收段=API（8 项目域事件单页/六类型齐备/脱敏 basename 与成员名/outbox==projection==API project 作用域/foreign 404/跨项目隔离）+桌面明暗 UI（End 键选 tab、中性徽标/文案/摘要、定位 href、44px、焦点环）+窄屏抽屉+axe 3 态 0 serious/critical+秘密扫描（facing text+截图字节含宿主路径）零泄漏（PASS: assertions=104 axeStates=3）；实现 subagent 写完验收段后 resource_exhausted，主会话接管完成 node --check/tsc/smoke:context/全量/build 验证并收口；全量 277 文件 2542 用例 118.4s 全绿、build 绿。默认选择落台账 A-255。
