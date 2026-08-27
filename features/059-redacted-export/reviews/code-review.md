# 059 脱敏导出 code-review

- 范围: `getRedactedExport`、`GET /api/projects/:projectId/export`、审计「导出脱敏包」
- 日期: 2026-08-21
- 评审人: 实现会话内安全边界复核（schema 零变更；读投影；凭据/路径/提示词）

## Standards

1. GET 只读，不写 outbox、工作区或命令事实。浏览器下载，不调用 DirectoryPicker（A-422）。
2. 事件复用 `listProjectAuditEvents` 已脱敏 payload；消息只取 `collaboration_messages` 公开列（无 thinking、无 Provider 行）。
3. **判断项**：导出不二次跑公开文本分类器，信任写入闸。写入失败关闭已覆盖凭据类正文；本片 T-04 另用泄漏标记钉死。不升严重。
4. 超限 `EXPORT_TOO_LARGE` 失败关闭；未知项目/对话 404。

## Spec

1. 包含 `formatVersion`、`scope`、可复算 `contentHash`。确认对话框取消不 GET。
2. 当前项目 only（A-421），不新造大范围 Approval 域。

## 结论

PASS。无跨 owner 写、无 GET 外部动作、无工作区写。
