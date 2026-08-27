# 规格 — 服务健康与可观察性中心

- 切片: 055 / S-35
- 主用户结果: Owner 在 `/team` 看到应用、Provider、记忆索引与执行服务的真实健康、失败原因和恢复入口；未知不得显示为成功。
- 主 Capability: `CAP-OPS-03`
- 来源: `product/backlog.md` S-35、`product/architecture.md` Operations Projection、`product/ui/UI设计.md` §9.3.6

## 范围

### 包含

1. 只读聚合健康查询与 `GET /api/health`。
2. 四张卡片：应用、模型服务、记忆索引、执行。
3. 稳定状态词 `ok | degraded | failed | unknown`；缺失数据显示 unknown。
4. `/team`「服务健康」region：覆盖与恢复深链，不新增图标轨项。
5. 项目作用域卡片在提供 `projectId` 时才判定；否则 unknown。

### 不包含

- 用量/配额（S-36）、贡献视图（S-37）、救援命令（S-44）。
- 对 Provider 做实时探测、自动修复、sandbox 或新 Approval 域。
- 新 schema、新命令事实、回写 Identity / Execution / Knowledge。
- 日志原文、凭据、宿主路径或隐藏推理。

## 领域口径

- **健康**：对已公开、可机械判定信号的只读投影，不是业务终态。
- **应用**：canonical schema 可打开且 identity 匹配。
- **模型服务**：至少一名已验证 Provider；零 Provider 为 degraded，不是 ok。
- **记忆索引**：复用 S-29 project health；无项目为 unknown。
- **执行**：当前项目非终态/失败 Execution 计数；无项目为 unknown。
- **恢复入口**：只深链既有动作（配置模型服务、打开项目、重建索引、打开审批/审计）。

## 功能需求

### FR-1 聚合查询

`GET /api/health`

```json
{
  "app": { "status": "ok", "schemaIdentity": 28, "detail": null },
  "providers": { "status": "degraded", "verified": 0, "total": 0, "detail": "未配置模型服务" },
  "memoryIndex": { "status": "unknown", "projectId": null, "detail": "需要打开项目" },
  "execution": { "status": "unknown", "projectId": null, "active": 0, "failed": 0, "detail": "需要打开项目" }
}
```

- 可选查询 `projectId`；非法值 400，未知项目 404。
- 响应 `no-store`；不含凭据、正文、路径、异常栈。
- GET 不得发起 Provider HTTP、进程或重建。

### FR-2 未知不伪造成功

- 缺项目、缺信号、投影失败 → `unknown` 或 `failed`，不得映射 `ok`。
- 应用 schema 打不开 → `failed` + 稳定错误码。
- 索引 `behind|rebuilding|failed` → 卡片 `degraded`/`failed`，并保留 S-29 覆盖数字。

### FR-3 UI

- `/team` 独立 region「服务健康」，不新增 `SETTINGS_SECTIONS` id。
- 每卡展示状态徽标、脱敏说明、一个恢复入口（disabled 当动作不可达）。
- 覆盖 loading / empty / error / disabled / success / focus；控件 ≥44px；亮/暗/窄屏与 axe。

## 错误

- `INVALID_INPUT`
- `PROJECT_NOT_FOUND`
- `HEALTH_UNAVAILABLE`

## 验收

1. 无 Provider 时模型服务为 degraded，并链到「模型服务」。
2. 未带 projectId 时索引/执行为 unknown，不显示 ok。
3. 打开项目后索引卡复用 S-29 口径；降级链到记忆视图重建。
4. 响应与 UI 不泄漏密钥、路径、Memory 正文或原始异常。
5. GET 不产生外部调用或业务写。
