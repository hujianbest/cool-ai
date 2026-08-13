# 037 Governance 审计事件纵切（AUD-GOV / S-53）

- 状态: in_progress
- 切片: S-23 的 source-owner 扩展纵切之一（AUD-GOV），分配实现片号 S-53
- 建立 Capability: `CAP-GOV-03` Public Governance Events（owner: Governance）
- 复用: 已 ship 的 `CAP-OPS-01`（audit_event_outbox → projection 消费）与 `CAP-OPS-02`（项目作用域审计查询 API + 审计中心 UI）
- 独立可演示结果: owner 能在审计中心查询本项目脱敏 Approval 事件（请求/批准/驳回/过期/消费），并按域徽标与文案识别、精确导航回执行审查面
- 前置: 030（AUD-COL）、035（AUD-MWK）、036（AUD-PWS）已建立同一纵切模式；本片为第四根纵切
- 评审: 项目级 review 豁免（AGENTS.md 当前开发阶段条款，2026-08-09）
