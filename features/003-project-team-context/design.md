# 创建项目、组队并建立共享上下文 技术设计

- 日期: 2026-07-29
- 规格: ./spec.md

## 1. 架构总览

S-3 扩展现有项目驾驶舱与 SQLite versioned migration，不引入模型调用或工作区内容工具。依赖:

```text
ProjectPanel / ProjectContextWorkspace
  ├─ WorkspaceSetup
  ├─ ProjectRoster
  ├─ MissionBoard
  ├─ SharedMemory
  └─ ContextPreview
          ↓ public JSON contracts
project-context Route Handlers
          ↓
workspace-service / membership-service / mission-service
memory-service / context-snapshot-service
          ↓
version 3 SQLite migration + fs metadata boundary
```

新增模块:

- `src/server/workspace-service.ts`: 仅做真实路径、目录/readable metadata 校验、唯一绑定与改绑并发控制；不提供文件内容 API。
- `src/server/membership-service.ts`: 项目成员集合事务与平等名册读取。
- `src/server/mission-service.ts`: 单一当前使命、任务、依赖 DAG 与状态机。
- `src/server/memory-service.ts`: append-only 来源记忆与 supersede。
- `src/server/context-snapshot-service.ts`: 只读组合并稳定排序，输出 shared/currentAgent。
- `src/shared/project-context-contracts.ts` / `project-context-schemas.ts`: DTO、输入、枚举、字段错误。
- `app/api/projects/[projectId]/workspace|members|mission|work-items|memories|context/**`: 薄 Route Handler。
- `components/project-context/**`: 驾驶舱设置、看板、记忆与预览。

现有 Provider vault 与 S-1 task run 不进入上下文序列化；现有 `/team` 保持不变。

## 2. 关键决策

### D-1: 工作区同一性
- 方案 A: 只对输入字符串做 normalize。取舍: 无文件系统访问，但无法识别 junction/symlink/大小写别名。
- 方案 B: 服务端执行 realpath + stat + read access，保存 canonical path 与平台规范 key；不枚举或读取目录内容。
- 选择: B。`WorkspaceFs` 边界只暴露 `realpath`、`statDirectory`、`checkReadable` 三个 metadata 方法，生产实现禁止 `readdir/readFile/writeFile/exec`。canonical path 用于 owner 显示；workspace key 在 Windows 使用 canonical path Unicode 小写，在其他平台使用 canonical path 原值。partial unique index 保证 active 非空 key 唯一。

### D-2: Agent 成员是引用还是快照
- 方案 A: 入组时复制 Agent 名称、model、技能与权限。取舍: 历史稳定，但 Team 更新后项目看到旧身份且产生双事实源。
- 方案 B: membership 只保存 project/agent id 与 joinedAt，读取时关联最新公开 Agent 配置。
- 选择: B。稳定身份由 Agent id 保证；上下文 snapshot 在每次生成时固定当前值，S-4 Invocation 再保存其使用的 snapshot/hash。

### D-3: 项目上下文是否持久化
- 方案 A: 每次修改都写一份完整 JSON。取舍: 读取简单但容易与规范表漂移。
- 方案 B: 使命、任务、依赖、记忆和成员各自是事实源，snapshot 按请求确定性组合。
- 选择: B。S-3 用深度相等与稳定 JSON 测试保证确定性，不提前引入事件溯源或缓存。

### D-4: 看板交互
- 方案 A: drag-and-drop 改状态/依赖。取舍: 视觉直观但键盘与失败反馈复杂。
- 方案 B: 明确表单/菜单动作更新状态、负责人和依赖。
- 选择: B。首版卡片只展示，编辑器提供有 label 的 select/checkbox；每次提交带 expectedVersion。

### D-5: 记忆修订
- 方案 A: 原地 PATCH 正文。取舍: 简单但来源知识被无痕改写。
- 方案 B: append-only 新条目可 supersede 一个 active 同类型条目。
- 选择: B。active 由“不存在 superseding child”定义，事务保证一对一线性链；不提供删除。

### D-6: UI 布局
- 方案 A: 新建独立项目设置路由。取舍: 分页清晰，但 owner 无法在工作上下文旁看到设置结果。
- 方案 B: 扩展 `/` 的协作驾驶舱，按未完成前置条件显示 setup，再在中栏/右栏展示项目共同上下文。
- 选择: B。左栏继续项目导航；中栏依次显示项目 header、平等成员条、使命与看板；右栏 tabs 为“共享记忆 / 上下文预览 / 骨架运行”。窄屏沿用已验证的 modal drawer。

## 3. 接口与数据契约

### 3.1 SQLite version 3

Migration v2→v3 先验证完整 v2，再在单一事务执行:

```sql
ALTER TABLE projects ADD COLUMN workspace_path TEXT;
ALTER TABLE projects ADD COLUMN workspace_key TEXT;
ALTER TABLE projects ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX projects_workspace_key_unique
  ON projects(workspace_key) WHERE workspace_key IS NOT NULL;

CREATE TABLE project_memberships(
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY(project_id, agent_id)
);

CREATE TABLE missions(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE work_items(
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('todo','in_progress','blocked','done')),
  assignee_agent_id TEXT REFERENCES agents(id),
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE work_item_dependencies(
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES work_items(id),
  PRIMARY KEY(work_item_id, depends_on_id),
  CHECK(work_item_id <> depends_on_id)
);

CREATE TABLE memory_entries(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('goal','decision','fact','artifact')),
  content TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('owner_input','work_item','artifact_path')),
  source_ref TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK(created_by = 'owner'),
  supersedes_id TEXT UNIQUE REFERENCES memory_entries(id),
  created_at TEXT NOT NULL
);
```

Migration tests使用真实 v2 fixture，确认 S-1/S-2 数据、外键与 user_version=3；漂移 v2 在 DDL 前失败且磁盘不变。

### 3.2 Public DTO

```ts
type WorkspaceBinding = {
  path: string;
  status: "ready";
};

type ProjectMember = {
  agentId: string;
  joinedAt: string;
  name: string;
  role: string;
  model: string;
  avatarText: string;
  accentToken: AgentProfile["accentToken"];
  skillNames: string[];
  permissions: ToolPermissions;
};

type Mission = {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type WorkItemStatus = "todo" | "in_progress" | "blocked" | "done";

type WorkItem = {
  id: string;
  missionId: string;
  title: string;
  description: string;
  status: WorkItemStatus;
  assigneeAgentId: string | null;
  dependencyIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

type MemoryEntry = {
  id: string;
  projectId: string;
  type: "goal" | "decision" | "fact" | "artifact";
  content: string;
  sourceType: "owner_input" | "work_item" | "artifact_path";
  sourceRef: string;
  createdBy: "owner";
  supersedesId: string | null;
  active: boolean;
  createdAt: string;
};
```

### 3.3 Workspace API

```ts
type BindWorkspaceInput = {
  path: string;
  expectedVersion: number;
  confirmRebind: boolean;
};
```

- `GET /api/projects/:id/workspace` → `{ workspace: WorkspaceBinding | null, projectVersion }`
- `PUT /api/projects/:id/workspace` + input → `{ workspace, projectVersion }`

算法:

1. 字段长度上限使用 OS 可接收输入的 32767 字符；先拒绝 NUL、空值与非绝对 path。
2. 调用 `realpath`，再 stat 必须 directory，再 read access。
3. 生产 adapter 记录 operation kind 供测试/审计；允许的 kind 只有 realpath/stat/access。
4. 计算 workspace key；事务内检查其他项目相同 key，检查 expectedVersion 与改绑确认，再更新 path/key/version+1。
5. typed path errors不携带完整 path；logger 只记录 projectId/code/correlationId。

错误: `WORKSPACE_INVALID`、`WORKSPACE_NOT_FOUND`、`WORKSPACE_NOT_DIRECTORY`、`WORKSPACE_NOT_READABLE`(400)、`WORKSPACE_ALREADY_BOUND`(409)、`REBIND_CONFIRMATION_REQUIRED`(409)、`RESOURCE_CONFLICT`(409)。

### 3.4 Membership API

```ts
type ReplaceMembersInput = {
  agentIds: string[];
  expectedProjectVersion: number;
};
```

- `GET /api/projects/:id/members` → `{ members: ProjectMember[], projectVersion }`
- `PUT /api/projects/:id/members` → full replace，返回同结构。

校验去重后必须仍与输入长度相同且至少 2；所有 Agent 必须存在。保留成员保留 joinedAt，新成员使用同一事务时间。移除成员前查询其 assigned 非空任务；若存在返回 `MEMBER_HAS_ASSIGNMENTS` 与非敏感 agent id 列表。事务检查 project version，替换集合并 version+1。排序 `joined_at ASC, agent_id ASC`。

### 3.5 Mission / Work Item API

- `GET /api/projects/:id/mission` → `{ mission: Mission | null, workItems: WorkItem[] }`
- `POST /api/projects/:id/mission` + `{title, goal}` → 201；已有使命 → `MISSION_EXISTS`
- `PATCH /api/missions/:id` + `{title, goal, expectedVersion}` → full replace
- `POST /api/missions/:id/work-items` + `{title, description, assigneeAgentId, dependencyIds}` → 201 todo
- `PATCH /api/work-items/:id` + full metadata `{title, description, assigneeAgentId, dependencyIds, expectedVersion}` → 200；不含 status
- `POST /api/work-items/:id/transition` + `{toStatus, expectedVersion}` → 200；只执行状态机动作

状态机固定:

```text
todo        -> in_progress | blocked
in_progress -> blocked | done
blocked     -> todo | in_progress
done        -> in_progress
```

transition 的 same-status/其他边拒绝；metadata PATCH 保持当前 status，不做 same-status 转换校验。进入 in_progress/done 要求全部直接依赖 done；为当前 in_progress/done 保存依赖时也要求全部 done。done→in_progress 前查询所有直接后继，任一 in_progress/done 则拒绝。

两类写入均在单个 `BEGIN IMMEDIATE` 中先重读 row/version。metadata PATCH 的原子顺序为字段校验→成员/依赖引用→替换后 DAG→当前状态 dependency readiness→写 row/version+1→替换 dependencies。transition 顺序为版本→状态边→依赖/downstream 条件→写 status/version+1；任一步失败整体回滚。

依赖创建/替换:

1. 所有 id 存在且同 mission；去重、非 self。
2. 在“替换后的完整 dependency graph”上执行 DFS 三色检测，无环才写。
3. assignee 为 null 或当前 membership。
4. expectedVersion 匹配后删除旧依赖、插入新依赖并更新 row/version。

错误: `MISSION_NOT_FOUND`、`WORK_ITEM_NOT_FOUND`(404)；`MISSION_EXISTS`、`INVALID_TRANSITION`、`DEPENDENCY_NOT_READY`、`DEPENDENCY_CYCLE`、`DEPENDENCY_SCOPE`、`ASSIGNEE_NOT_MEMBER`、`MEMBER_HAS_ASSIGNMENTS`、`RESOURCE_CONFLICT`(409)。

任务排序 `created_at ASC,id ASC`；dependencyIds 按被依赖任务 `created_at ASC,id ASC`。

### 3.6 Memory API

```ts
type CreateMemoryInput = {
  type: MemoryEntry["type"];
  content: string;
  sourceType: MemoryEntry["sourceType"];
  sourceRef: string;
  supersedesId?: string;
};
```

- `GET /api/projects/:id/memories?includeInactive=0|1` → `{ memories }`
- `POST /api/projects/:id/memories` → 201 `{ memory }`

source 规则:

- `owner_input`: sourceRef 是 1–2048 字符 owner 来源标签。
- `work_item`: sourceRef 必须是同项目当前使命 work item id。
- `artifact_path`: 平台无关 lexical 算法:
  1. 拒绝空值、NUL、以 `/` 或 `\\` 开头、`//`/`\\\\` UNC、`^[A-Za-z]:` drive 和 URI scheme `^[A-Za-z][A-Za-z0-9+.-]*:`。
  2. 将 `\\` 替换为 `/` 并按 `/` 分段；空段和 `.` 丢弃。
  3. 遇到 `..` 时若 stack 非空则 pop；stack 为空则表示越出工作区并拒绝。percent-encoded `%2e%2e` 不解码，作为普通文件名段。
  4. 最终 stack 必须非空，以 `/` join 后作为 opaque relative string 保存，不调用 fs。

固定样例:

| 输入 | 结果 |
|------|------|
| `docs/plan.md` | 接受为 `docs/plan.md` |
| `docs/./draft/../plan.md` | 接受为 `docs/plan.md` |
| `a\\b\\..\\c.txt` | 接受为 `a/c.txt` |
| `../secret`、`a/../../secret` | 拒绝 |
| `/tmp/a`、`C:\\a`、`\\\\server\\share` | 拒绝 |
| `docs/%2e%2e/note` | 接受为同字面字符串，不 URL decode |

supersede 事务验证 target 同 project/type、active 且不是自身；`supersedes_id UNIQUE` 与事务保证并发只成功一次。active 查询为 `NOT EXISTS(SELECT 1 FROM memory_entries child WHERE child.supersedes_id = entry.id)`。排序 `created_at ASC,id ASC`。

错误: `MEMORY_NOT_FOUND`、`MEMORY_NOT_ACTIVE`、`MEMORY_TYPE_MISMATCH`、`INVALID_SOURCE`、`RESOURCE_CONFLICT`。

### 3.7 Context Snapshot API

- `GET /api/projects/:projectId/context?agentId=<member>` → `ProjectContextSnapshot`

```ts
type ProjectContextSnapshot = {
  schemaVersion: 1;
  shared: {
    project: { id: string; name: string; workspacePath: string };
    roster: ProjectMember[];
    mission: Mission;
    workItems: WorkItem[];
    memories: MemoryEntry[]; // active only
  };
  currentAgent: {
    id: string;
    name: string;
    role: string;
    systemPrompt: string;
    skills: Array<{ id: string; name: string; instructions: string }>;
    permissions: ToolPermissions;
  };
};
```

生成前置: workspace ready、members≥2、mission exists、agentId 为成员，否则 `CONTEXT_NOT_READY`/`AGENT_NOT_MEMBER`。DTO 不含时钟字段；同一数据库事实连续读取的完整 JSON 必须深度相等。shared 排序严格遵循 spec。snapshot query 显式 select allowlist，不使用 `SELECT *`，不 join provider secret columns；递归 deny-key scanner 与 known-secret sentinel test 均为 0。

### 3.8 Field errors

所有 request body 文本先用 ECMAScript `trim()` 去首尾空白并持久化该结果，内部换行/空白保留；长度以 `Intl.Segmenter("zh-CN",{granularity:"grapheme"})` 的 grapheme 数计算。字段完整类型:

```ts
type CreateMissionInput = { title: string; goal: string };
type UpdateMissionInput = CreateMissionInput & { expectedVersion: number };
type CreateWorkItemInput = {
  title: string;
  description: string;
  assigneeAgentId: string | null;
  dependencyIds: string[];
};
type UpdateWorkItemInput = CreateWorkItemInput & { expectedVersion: number };
type TransitionWorkItemInput = {
  toStatus: WorkItemStatus;
  expectedVersion: number;
};

type ProjectContextError = {
  error: {
    code: string;
    message: string;
    correlationId?: string;
    fields?: Array<{field: ProjectContextField; code: FieldErrorCode}>;
    currentVersion?: number;
    missing?: Array<"workspace" | "members" | "mission">;
  };
};
```

数值边界: mission title 1–80 grapheme、goal 1–5000；work item title 1–160、description 0–5000。空 description 合法并持久化为空字符串；其他 required 文本 trim 后为 0 时 `INVALID_INPUT`。

沿用稳定 error envelope。新增 field paths:

`path, confirmRebind, agentIds, title, goal, description, status, assigneeAgentId, dependencyIds, type, content, sourceType, sourceRef, supersedesId, expectedVersion, expectedProjectVersion`。

唯一 HTTP 映射:

- 任一 body JSON 无法解析 → 400 `INVALID_JSON`；类型/缺字段/文本或数组边界 → 400 `INVALID_INPUT` + fields。
- 任一路径 project id 不存在 → 404 `PROJECT_NOT_FOUND`。
- workspace typed 输入/fs 失败 → 本节 3.3 所列 400；唯一/确认/version → 409，对 version 冲突附 `currentVersion`。
- members: Agent 不存在 → 404 `AGENT_NOT_FOUND`；少于 2/重复 → 400 `INVALID_INPUT/agentIds`；assigned removal/version → 409。
- mission: 不存在读取返回 200 null；create 已存在 → 409 `MISSION_EXISTS`；PATCH mission id 不存在 → 404 `MISSION_NOT_FOUND`；version → 409 + currentVersion。
- work item 不存在始终 404 `WORK_ITEM_NOT_FOUND`；非法转换/readiness/cycle/scope/assignee/version 始终 409 并按本节 code 区分，version 附 currentVersion。
- memory project 不存在 → 404；supersede target 不存在 → 404 `MEMORY_NOT_FOUND`；source 字段/路径 → 400 `INVALID_SOURCE` + field；inactive/type/concurrency → 409。
- context project/agent 不存在 → 404；agent 存在但非成员 → 409 `AGENT_NOT_MEMBER`；前置缺失 → 409 `CONTEXT_NOT_READY` + 去重且固定顺序 workspace,members,mission 的 `missing`。
- schema/storage → 503 `STORAGE_UNAVAILABLE`；未知 → 500 `INTERNAL_ERROR` + correlationId。

Route 未知异常继续使用 S-2 sanitized correlation logger，不传 raw Error/path/input。

## 4. NFR 落点

| NFR | 满足机制 | 验证方式 |
|-----|---------|---------|
| NFR-1 工作区路径安全 | metadata-only WorkspaceFs、canonical key unique index、transaction version/confirm、sanitized path errors | adapter operation audit=仅 realpath/stat/access；别名双项目冲突；日志/错误完整测试 path 匹配 0 |
| NFR-2 上下文完整性 | 外键、事务 full replace、DAG 检测、固定状态机、optimistic version、allowlist snapshot 与稳定排序 | 合法/非法状态属性测试、环路/悬空/并发失败测试、规范 JSON 深度相等、deny key/sentinel=0 |
| NFR-3 可访问性 | 复用 44px/focus/token；语义 list/heading/form；非拖拽看板；dialog/focus trap | 组件键盘/语义断言、contrast 静态断言、桌面/窄屏真实浏览器路径 |

## 5. 错误处理

- fs 原始错误统一映射 typed workspace code；不得把 path、errno stack 或 OS message 直接返回/记录。
- Migration v2 漂移在 DDL 前拒绝；v3 DDL/版本号同事务，失败回滚并关闭。
- 所有集合替换/状态/依赖/supersede 在 `BEGIN IMMEDIATE` 内重读 version/active/references，避免 TOCTOU。
- UI 每区保留上次成功数据与草稿；409 显示“数据已更新，请刷新后重试”并提供 reload，不自动覆盖。
- Snapshot 任一前置缺失返回结构化 `missing: ("workspace"|"members"|"mission")[]`，客户端显示 setup checklist，不返回部分伪 ready snapshot。

## 6. 测试策略

- Migration: 真实 v2 fixture→v3、漂移/故障/重复打开、S-1/S-2 数据/外键/unique path 保留。
- Workspace: 临时目录、相对/文件/不存在/不可读、realpath alias、Windows/POSIX lexical cases、唯一/改绑/version；operation audit 无内容 I/O。
- Membership: min2/duplicate/missing、joinedAt 保留、latest agent profile、assigned removal、并发冲突与平等 DTO。
- Mission: 全状态边、dependency readiness、done reopen downstream、同/跨 mission、自依赖/环路、负责人、version 事务。
- Memory: 四类型/三来源、lexical artifact、missing/symlink opaque、同项目/type active linear supersede 与并发分叉拒绝。
- Snapshot: readiness、sorting/tie-breaker、shared equality、currentAgent differences、provider/vault deny keys 与 secret sentinel scan。
- Components: 每区 loading/empty/error/retry/disabled/success/focus；setup 顺序、成员多选、看板表单、来源记忆、context checklist；桌面/窄屏键盘。
- Browser: 临时 workspace/DB/master key，复用本地 provider 建立两个 Agent，创建项目→绑定→组队→使命/依赖→四类记忆→两成员快照比较，刷新恢复；截图和 operation/security scan。
- 全量: `npm test`、`npm run build`、独立 `npm run smoke:context`。

## 7. UI 设计

### 信息架构
- 左栏项目列表在选中项目下显示 setup 进度“工作区 / 成员 / 使命”，均来自真实状态。
- 中栏:
  1. Project header + workspace path/改绑。
  2. 平等成员 strip，按 joinedAt 显示 Agent 头像与职责，不出现 leader/rank。
  3. Mission title/goal。
  4. 四列语义 section（待办/进行中/阻塞/完成），不用拖拽；卡片编辑按钮打开表单。
- 右栏 `tablist`: “共享记忆 / 上下文预览 / 骨架运行”；保留 S-1 运行入口但默认显示记忆。
- 无项目时仍显示创建项目；有项目但未 setup 时按工作区→成员→使命逐步引导，不隐藏后续完成条件。

### 状态与交互
- Workspace: path label、校验中 status、具体字段 error、改绑 confirm dialog、成功后聚焦 path summary。
- Members: checkbox fieldset；少于 2 时保存 disabled + 文本原因；已分配成员不可直接移除并显示任务链接。
- Mission/task: 新使命 empty action；任务编辑器用 status/assignee select、dependency checkbox；非法转换/依赖在字段旁显示，409 提供刷新。
- Memory: 类型 radio、来源类型 select、正文/sourceRef、可选 supersede active 同类条目；artifact 显示“仅引用，尚未读取”。
- Context: member select；未就绪显示 missing checklist；ready 用可读 sections，不展示原始 JSON 墙；提供“查看结构化快照”details。
- 每区 loading 不冒充 empty；error 有 retry；保存中 disabled；成功 aria-live；表单错误聚焦第一个字段。
- `ProjectPanel` 统一拥有 `mobileSurface: "projects" | "context" | "editor" | null`，保证同一时间最多一个 mobile surface；TaskPanel/ProjectContext 通过回调请求打开，不再各自维护可同时开启的 drawer。
- `components/mobile-dialog.ts` 扩展为共享 `useModalSurface({active,dialogRef,inertRootRefs,initialFocusRef,restoreFocusRef,onClose})`：active 时其余 cockpit region 设置 native `inert`、body scroll lock，焦点进入指定标题/首字段，Tab/Shift+Tab trap，Escape 关闭，cleanup 后恢复 opener。
- 窄屏 active surface 为 `role=dialog aria-modal=true aria-labelledby`；inactive surface `hidden` 且不在 tab order。桌面三栏始终呈现，不带 dialog/aria-modal/inert，资源 tabs 仍按 Arrow/Home/End 操作。
- mobile “项目”“上下文”“编辑”三个 opener 位于主工具栏且顺序固定；打开 editor 时关闭 context，关闭后恢复对应 opener。看板四列变为按状态分组的单列 sections，无水平滚动。

### 视觉系统
- 完全复用 S-1/S-2 tokens 与 Agent accent，不增加任意颜色、阴影或渐变。
- 看板状态使用现有 success/warning/danger/text-muted token + 明文标签；待办使用 border/text，不以颜色作为唯一信号。
- 依赖用文本“等待: <任务名>”，不自画连线/SVG；成员头像沿用 `data-accent`。
- 路径使用等宽系统字体 token（新增 `--font-mono: "Cascadia Mono","Consolas",monospace` 仅在 tokens.css），长路径允许安全换行。

### 可访问性
- 看板使用 heading + list/listitem；状态更新是有 label 的 select，不模拟拖拽。
- 成员与依赖多选均用 fieldset/legend；错误 aria-describedby。
- 右栏 tabs 使用既有 Arrow/Home/End 契约；context details 使用原生 summary/details。
- 改绑确认也复用同一 modal primitive，但不与 mobile surface 同时打开；确认关闭后恢复“改绑”按钮。
- 集成测试从当前 S-1 `ProjectPanel`/`TaskPanel` 双 drawer 起步，断言重构后任何时刻 `aria-modal=true` 元素最多一个、背景 region inert、既有任务输入在打开/关闭项目上下文后仍保持、desktop DOM 不误带 modal 语义。

## 8. 任务清单

- [x] T-1 打通工作区绑定的最薄端到端路径 (覆盖: FR-1) — 判据: `npm test -- tests/workspace-slice.test.tsx` 先红后绿；最小 v3 happy migration、UI→API→真实目录 metadata→SQLite→回显/刷新贯通
- [x] T-2 固化 v3 迁移与工作区安全边界 (覆盖: FR-1, NFR-1) — 判据: `npm test -- tests/context-migrations.test.ts tests/workspace.service.test.ts` 先红后绿；v2/漂移/故障、别名唯一、改绑/version、typed path errors 与 operation audit 通过
- [x] T-3 建立平等成员关系与名册 (覆盖: FR-2, NFR-2) — 判据: `npm test -- tests/members.service.test.ts tests/members.api.test.ts` 先红后绿；min2/duplicate/missing/joinedAt/latest profile/assigned removal/version 与无 rank DTO 通过
- [x] T-4 实现使命与基础任务 CRUD (覆盖: FR-3) — 判据: `npm test -- tests/mission-crud.test.ts` 先红后绿；使命唯一、字段边界、todo 创建、负责人 membership、metadata full replace/version 与稳定 API 通过
- [x] T-5 实现任务状态机与依赖 readiness (覆盖: FR-3, NFR-2) — 判据: `npm test -- tests/work-item-transitions.test.ts` 先红后绿；全部允许/拒绝边、same-status、dependency ready、done reopen downstream 与事务冲突通过
- [x] T-6 实现依赖 DAG full replace (覆盖: FR-3, NFR-2) — 判据: `npm test -- tests/work-item-dependencies.test.ts` 先红后绿；同/跨 mission、自依赖、重复、替换后环路、当前状态约束和原子回滚通过
- [x] T-7 实现带来源 append-only 共享记忆 (覆盖: FR-4, NFR-2) — 判据: `npm test -- tests/memory.service.test.ts tests/memory.api.test.ts` 先红后绿；字段/三来源、artifact 规范样例、linear supersede/active/concurrency 通过
- [x] T-8 生成稳定且无敏感信息的成员上下文 (覆盖: FR-5, NFR-1, NFR-2) — 判据: `npm test -- tests/context-snapshot.test.ts tests/context.api.test.ts` 先红后绿；完整 JSON 重复相等、排序、shared equality、currentAgent allowlist、deny-key/secret scan 通过
- [x] T-9 交付工作区与成员 setup UI (覆盖: FR-1, FR-2, FR-6, NFR-3) — 判据: `npm test -- tests/project-setup-panel.test.tsx tests/cockpit-mobile-integration.test.tsx` 先红后绿；三态、改绑、成员多选、统一单 modal/inert/focus restore 与既有任务流兼容通过
- [x] T-10 交付使命看板 UI (覆盖: FR-3, FR-6, NFR-3) — 判据: `npm test -- tests/mission-board.test.tsx` 先红后绿；使命/任务/transition/dependency/assignee 的三态、字段错误、键盘和窄屏单列通过
- [x] T-11 交付记忆与上下文 UI (覆盖: FR-4, FR-5, FR-6, NFR-3) — 判据: `npm test -- tests/memory-panel.test.tsx tests/context-preview.test.tsx tests/context-accessibility.test.tsx` 先红后绿；来源/supersede/readiness/shared 预览、tabs/details、三态/focus/token 纪律通过
- [x] T-12 收口真实项目上下文浏览器验收 (覆盖: FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, NFR-1, NFR-2, NFR-3) — 判据: README、`npm test`、`npm run build`、`npm run smoke:context` 通过；真实目录→双 Agent→使命/DAG→四类记忆→双成员快照/刷新完整，内容 I/O 与敏感字段扫描为 0，桌面/窄屏 smoke/demo 落盘
