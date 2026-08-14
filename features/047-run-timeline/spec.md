# 规格 — 跨任务运行轨迹时间轴

- 特性: 047-run-timeline（S-39）
- 用户确认: auto-approved 2026-08-15
- 评审: spec/architecture 豁免；轻量级零 schema，implement 后 hf-code-review 豁免

## Problem

审计列表按 outbox 新到旧分页，不能按使命把跨任务公开轨迹排成一条时间轴，也无法在缺来源时稳定占位。Owner 难以顺着一次 Mission 的运行故事跳回线程/任务/证据。

## Solution

在已有 `audit_event_projection` 上增加只读时间轴查询：项目隔离、可选 mission 过滤、按 occurredAt 正序、确定性去重、来源链接或「来源缺失」占位。不写事实、不补造事件。

## User Stories

1. As owner, I want a chronological trajectory for a project or Mission so I can follow public run history across tasks.
2. As owner, I want to jump to thread/task/evidence when the payload has a frozen identity, and see a missing-source placeholder otherwise.
3. As owner, I want duplicates collapsed so retries or identical outbox echoes do not look like extra events.

## Decisions

- 零 schema。只读 `audit_event_projection`（先 catchUp，与审计列表同协议）（A-327）。
- GET `/api/projects/:projectId/timeline`：可选 `missionId`（资源 id 形态）、`limit` 默认 50 最大 100、`beforeSeq` 可选（正序分页：outbox_seq > beforeSeq）。未知 query key 拒绝。
- mission 过滤：`json_extract(payload_json,'$.missionId') = ?`；无 missionId 的事件在指定使命时排除（不猜测归属）（A-328）。
- 去重键：`event_type + occurred_at + ifnull(execution_id,'') + ifnull(json_extract workItemId,'') + ifnull(json_extract threadId,'') + ifnull(json_extract approvalId,'')`；保留最小 outbox_seq（A-329）。
- 排序：occurred_at ASC, outbox_seq ASC。
- 条目：复用审计事件字段 + `sourceMissing: boolean`（无可定位身份时 true，不编造 href）（A-330）。
- UI：审计面板增加「时间轴」视图（同一面板，不新 tab 事实源）。正序列表；缺失来源文案「来源缺失」；已有定位链接复用 audit-panel 规则。
- 浏览器：`smoke:execution` 既有审计段增加时间轴断言，不新开 Agent 执行（A-331）。

## Testing

- 缝：`listProjectTimeline` + GET + audit-panel jsdom + smoke:execution。
- 断言：跨项目 404；缺来源不编造 id；去重；正序；无密钥。

## Out of Scope

导出（S-38）、交付回放（S-40）、新 outbox 类型、客户端域筛选改动（已由 042 交付）。
