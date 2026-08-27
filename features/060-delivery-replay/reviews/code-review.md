# 060 交付回放 code-review

- 范围: `getDeliveryReplay`、`GET /api/projects/:projectId/replay`、时间轴「打开回放」
- 日期: 2026-08-21
- 评审人: 实现会话内只读边界复核

## Standards

1. GET 只读，复用时间轴公开事件，不写 outbox、不重放命令。
2. 未知 run 返回空 items，不补造。来源 href 复用审计面板。
3. 判断项：时间轴分页上限 100，超长运行可能截断。MVP 与时间轴同源；不升严重。

## 结论

PASS。
