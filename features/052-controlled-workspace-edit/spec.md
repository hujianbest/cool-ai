# 受控工作区编辑与 Git 合入需求规格

- 日期: 2026-08-18
- 切片: S-42 / 052
- 主 Capability: `CAP-EXE-02` Controlled Workspace Mutation
- 主子系统: Safe Execution

## 1. 背景与问题

S-22 已提供 verified-handle 守护的绑定工作区只读浏览与预览。S-5 / `CAP-EXE-01` 已让 Agent 在隔离区写入、经审批合入，并留下 StagedChange / MergeJournal。Owner 仍不能从只读预览发起一次受控编辑：没有 owner 编辑会话、没有 sandbox diff 对照、没有 stale/冲突处理入口，只能依赖 Agent 执行路径或越出产品的外部编辑器。

若把编辑做成直接写 canonical workspace，会绕过 sandbox、审批与审计。S-42 要把 owner 编辑收进与 Agent 合入同一条失败关闭管道。

## 2. 目标与成功标准

- Owner 能从已绑定工作区的只读预览对单个文件发起编辑；编辑只发生在 sandbox，不直接写 canonical 根。
- Owner 能看到 sandbox 相对 canonical 的 diff，处理 stale（预览后根已变）与内容冲突，并在审批通过后合入。
- 越界路径、符号链接逃逸、秘密文件、未审批合入、不可逆 Git 动作均失败关闭，且不泄漏宿主绝对路径或凭据。
- 合入前必须经过独立复核门槛所消费的既有 staged/merge 事实；本片不让执行者或 owner 编辑会话自行宣布任务完成。
- 桌面与窄屏覆盖 loading / empty / error / disabled / success / focus；控件 ≥44px；axe 无 critical。

## 3. 范围

### 范围内

- Owner 从 S-22 预览发起的单文件受控编辑会话（sandbox 副本 + expected hash）。
- Sandbox diff 只读展示、stale 检测、冲突标记与重载/放弃。
- 将 sandbox 结果升级为 staged 变更，走既有审批后合入 canonical workspace。
- 破坏性或越界 Git 动作的失败关闭（本片只允许为合入服务的最小 Git 事实：stale/conflict/merge journal；不开放任意 rebase/force-push/reset）。
- 严格 DTO、operation/version/lease、脱敏错误 envelope、审计（StagedChange / MergeJournal）。

### 范围外

- 多文件批量编辑器、IDE 嵌入、任意终端 Git。
- 未绑定工作区、越出绑定根、写入 `.env` / 密钥材料。
- 绕过审批的合入、owner 在 canonical 根上的即时保存。
- S-43 终端/浏览器预览、S-44 救援命令。
- 伪造 UCD §9.5 复核工作台；复核仍消费已合入结果。
- 云远程、多 owner、对外部 remote 的 push。

## 4. 功能需求

### FR-1: 从只读预览创建编辑会话

- 优先级: 必须
- 描述: 已绑定项目内，owner 对可预览文本文件发起编辑。服务端用 verified-handle 打开绑定根内路径，把当前字节拷入 sandbox，并冻结 `expectedHash`。
- 验收:
  - Given 文件在绑定根内且只读预览成功 When POST 创建编辑会话 Then 201 返回 sessionId、相对路径、expectedHash、sandbox 状态 `editing`，不返回宿主绝对路径。
  - Given 路径越界、不是文件、或为敏感/秘密分类 When 创建 Then 4xx 失败关闭，canonical 与 sandbox 均无新写。
  - Given 同一 project+path 已有未结束会话 When 再创建 Then 409 或返回该会话，不产生第二份可合入 staged。

### FR-2: 只在 sandbox 写入

- 优先级: 必须
- 描述: 编辑正文只写入该会话 sandbox。PUT 必须带 session version 与 expectedHash。
- 验收:
  - Given 有效会话 When PUT 正文 Then 只更新 sandbox，canonical 字节不变。
  - Given expectedHash 与创建时不一致 When PUT Then stale，拒绝写入并提示重新预览。
  - Given 正文含 NUL 或超过既有写上限 When PUT Then 校验失败，sandbox 保持上一成功版本。

### FR-3: sandbox diff 与 stale/冲突

- 优先级: 必须
- 描述: GET diff 比较 sandbox 与当前 canonical（verified-handle）。根在会话创建后变化则为 stale；双方均改且不能自动合并则为 conflict。
- 验收:
  - Given 仅 sandbox 变化 When GET diff Then 返回 unified diff 与 `ready_to_stage`。
  - Given canonical 在会话后变化且与 sandbox 不冲突 When GET Then `stale`，合入 disabled，直到 owner 重载基线或放弃。
  - Given 双方改同一区域 When GET Then `conflicted`，不自动合入。

### FR-4: 审批后合入，复用 MergeJournal

- 优先级: 必须
- 描述: Owner 确认 stage 后产生与 `CAP-EXE-01` 兼容的 staged 事实；合入必须已有有效审批。合入复用 MergeJournal，operation 可重放。
- 验收:
  - Given `ready_to_stage` When POST stage Then 生成 stagedHash，不写 canonical。
  - Given 无有效审批 When POST merge Then 拒绝，canonical 不变。
  - Given 审批有效且 stagedHash 匹配 When POST merge Then canonical 更新、journal 记成功、会话进入 `merged`。
  - Given 同一 operationId 重放 When merge Then 不重复写盘，返回同一 journal。

### FR-5: Git 与秘密失败关闭

- 优先级: 必须
- 描述: 本片不提供自由 Git CLI。仅识别合入所需的工作区状态。不可逆 Git（reset --hard、force push、改写已合入历史）没有 API。
- 验收:
  - Given 请求含绑定根外路径或链接逃逸 When 任一写/合入 Then 失败关闭。
  - Given 目标为凭据/秘密分类文件 When 编辑或合入 Then 拒绝且不回显内容。
  - Given 未实现的 Git 动词 When 调用 Then 稳定 4xx，不执行。

## 5. API 契约（先行）

路由均在项目 ownership tuple 下；入站校验路径、内容类型、大小与严格 DTO。错误用已脱敏 envelope。

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/projects/:projectId/workspace/edits` | 创建编辑会话 `{ path }` |
| GET | `/api/projects/:projectId/workspace/edits/:editId` | 会话状态 |
| PUT | `/api/projects/:projectId/workspace/edits/:editId` | 写 sandbox `{ content, expectedHash, expectedVersion, operationId }` |
| GET | `/api/projects/:projectId/workspace/edits/:editId/diff` | sandbox vs canonical |
| POST | `/api/projects/:projectId/workspace/edits/:editId/stage` | 升级 staged `{ expectedVersion, operationId }` |
| POST | `/api/projects/:projectId/workspace/edits/:editId/merge` | 审批后合入 `{ stagedHash, expectedVersion, operationId }` |
| POST | `/api/projects/:projectId/workspace/edits/:editId/abandon` | 放弃会话 |

不在 query/body/响应中出现宿主绝对路径、凭据或 sandbox 物理根。

## 6. UI（消费 API，不另造主路径）

- 入口：S-22 工作区文件预览上的「编辑」（仅文本且非秘密）。不在聊天主路径常驻编辑器。
- 编辑面：全宽治理式表面或 ActionDialog，含 Monaco/纯 textarea 二选一在 architecture 决定；必须 44px 关闭/放弃/申请合入。
- Diff：只读，失败/stale/冲突全态。
- 合入：复用统一审批中心，不做第二条审批。

## 7. 安全与审计

- verified-handle 是所有路径访问的唯一入口。
- sandbox 强制；合入前 canonical 只读。
- 审批：合入与任何破坏性工作区变更必需。
- 审计：创建会话、sandbox 写、stage、merge、abandon 进 outbox；MergeJournal 为合入单一事实。
- 独立复核：本片不完成任务；合入结果仍由 `CAP-REV-01` 消费。

## 8. 假设

- A-388（待写入 assumptions）：编辑会话按文件隔离，不做多文件工作区树写入。默认理由: 最小可演示 owner 结果，复用既有单文件 staged 模型。
