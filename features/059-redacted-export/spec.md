# 规格 — 脱敏对话与项目数据导出

- 切片: 059 / S-38
- 主用户结果: Owner 从当前项目的审计中心导出用户可见消息、公开事件与元数据；包有版本、范围与内容 hash，不含凭据、隐藏推理或原始 Provider 响应。
- 主 Capability: `CAP-OPS-04`
- 来源: `product/backlog.md` S-38、`product/architecture.md` Operations Projection、`product/ui/UI设计.md` §9.2.6、`product/词汇表.md`

## 范围

### 包含

1. 只读脱敏导出投影与 `GET /api/projects/:projectId/export`。
2. 包内容：用户可见消息块、已投影审计事件、范围/版本/`contentHash`。
3. 可选 `threadId` 收窄到一条对话；缺省为当前项目全部对话。
4. 审计治理视图「导出脱敏包」：确认范围后浏览器下载 JSON。
5. 失败关闭：未知项目 404；超限拒绝；脱敏失败不得降级为成功。

### 不包含

- 跨项目、全部工作区、或「导出到文件夹」写入（A-421、A-422）。
- 新 Approval 域、新 schema、outbox、命令回写。
- 交付回放（S-40）、工作区文件副本、原始 Provider 响应、隐藏推理、凭据。
- 修改 `smoke:execution` 的 P1 前 IA（A-412）。

## 领域口径

- **脱敏导出**：对已公开、已脱敏来源的只读打包，不是命令事实，不重放动作。
- 消息取 Collaboration 用户可见块；事件取 Operations Projection 审计列表（与审计面板同源）。
- `contentHash`：对去掉 hash 字段后的规范 JSON 做 SHA-256；hash 自己不算进输入。

## 功能需求

### FR-1 组装查询

`GET /api/projects/:projectId/export`

```json
{
  "formatVersion": 1,
  "exportedAt": "2026-08-21T00:00:00.000Z",
  "scope": {
    "detail": "当前项目",
    "projectId": "project-1",
    "threadId": null
  },
  "contentHash": "64-char lowercase hex",
  "messages": [],
  "events": []
}
```

- 可选 `threadId`；非法 400，未知项目/对话 404。
- 额外查询键 400。
- `no-store`；GET 无外部调用、无业务写。
- 消息或事件超过 5000 条 → `EXPORT_TOO_LARGE` 失败关闭，提示按对话收窄。

### FR-2 强制脱敏

- 不得包含 API key、主密钥、提示词、隐藏推理、原始 Provider 响应、宿主绝对路径。
- 审计事件复用已脱敏 payload；消息复用公开块，不含 thinking。
- 包恒含 `formatVersion` 与 `scope`。

### FR-3 UI

- 审计视图工具条「导出脱敏包」；确认对话框展示项目（及可选对话）范围。
- loading / empty / error / disabled / success / focus；≥44px。
- 无项目时该视图不挂载；确认取消不发起 GET。

## 错误

- `INVALID_INPUT`
- `PROJECT_NOT_FOUND`
- `THREAD_NOT_FOUND`
- `EXPORT_TOO_LARGE`

## 验收

1. 打开项目后可下载带版本与 hash 的 JSON。
2. 他项项目隔离；包内无凭据/路径/隐藏推理。
3. 取消确认不下载。
4. GET 不写命令事实。
