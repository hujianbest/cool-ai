# 配置有技能的第一支 Agent 小队 技术设计

- 日期: 2026-07-29
- 规格: ./spec.md

## 1. 架构总览

S-2 在已 ship 的 Next.js App Router 单仓上增加独立的 `/team` 配置区，不改变 S-1 的确定性任务执行路径。依赖保持单向:

```text
app/team + components/team
        ↓ JSON DTO / stable error code
app/api/providers|skills|agents
        ↓
src/server/provider-service | skill-service | agent-service
        ↓
src/server/validation + credential-vault
        ↓
src/server/db migrations → SQLite
```

新增模块:

- `src/server/migrations.ts`: 以 SQLite `PRAGMA user_version` 顺序执行幂等迁移；S-1 三张表成为 version 1，S-2 配置表成为 version 2。
- `src/server/credential-vault.ts`: 读取环境主密钥、派生加密/签名子密钥、AES-256-GCM 加解密、掩码与验证 token。
- `src/server/provider-service.ts` / `provider-verifier.ts`: provider CRUD 与外部兼容协议验证；网络 I/O 不持有数据库事务。
- `src/server/skill-service.ts`: 文本技能 CRUD 与版本递增。
- `src/server/agent-service.ts`: Agent CRUD、模板读取与技能关联事务。
- `src/shared/team-contracts.ts` / `team-schemas.ts`: 仅公开 DTO、输入 schema、枚举与稳定错误 code；不得导出密文结构。
- `app/api/providers/**`、`skills/**`、`agents/**`: 薄 Route Handler。
- `app/team/page.tsx`、`components/team/**`: Team 导航、资源列表与编辑器。

现有 `openDatabase()` 继续是唯一数据库入口，但先执行版本迁移。现有项目/任务服务 API 保持不变。

## 2. 关键决策

### D-1: 主密钥来源
- 方案 A: 应用自动生成 `.data/master.key`。取舍: 初次使用简单，但 Windows 下 POSIX mode 不能证明 owner-only 权限，可能违反失败关闭要求。
- 方案 B: 只接受环境变量 `COCKPIT_MASTER_KEY`，要求 base64 编码的 32 字节随机值。取舍: provider 配置前多一步本机设置，但主密钥与数据库、源码和应用生成文件天然分离，跨平台边界可测试。
- 选择: B。应用其余功能在未设置密钥时仍可运行；创建/替换/验证 provider 返回 `MASTER_KEY_UNAVAILABLE`，绝不降级明文。README 提供 PowerShell 与 POSIX 生成/设置命令，但不写入真实 key。

### D-2: 凭据加密与验证凭证
- 方案 A: 只在客户端记住“已验证”，保存时相信布尔值。取舍: 简单但可伪造，修改连接字段后也难可靠失效。
- 方案 B: 服务端验证成功后签发短时验证 token，token 绑定规范化 URL、model 与 API key 摘要；保存时重新计算并校验。
- 选择: B。采用以下固定、可版本化格式:
  - `COCKPIT_MASTER_KEY`: 无 padding 的 base64url，严格解码后必须正好 32 字节。
  - `keyId = base64url(SHA-256(masterKey)).slice(0, 16)`。
  - HKDF: SHA-256，salt 为 UTF-8 `collaboration-cockpit:v1`；info 分别为 `credential-encryption:v1`、`provider-validation-token:v1`、`provider-key-fingerprint:v1`，输出各 32 字节。
  - credential envelope version 1: AES-256-GCM，12 字节随机 IV、16 字节 tag；cipher/iv/tag 以无 padding base64url TEXT 保存；AAD 为 UTF-8 `provider-api-key:v1\u0000<providerId>`。
  - keyed key fingerprint: `base64url(HMAC-SHA256(fingerprintKey, UTF8(apiKey)))`，只参与 token 绑定，不进入 public DTO。
  - validation token: `v1.<payload-base64url>.<signature-base64url>`；payload 是可判别联合，signature 是 HMAC-SHA256:
    - create canonical JSON 固定键序 `{aud:"provider-save", draftHash, exp, iat, mode:"create", v:1}`。
    - existing canonical JSON 固定键序 `{aud:"provider-save", credentialGeneration, draftHash, exp, iat, mode:"retain"|"replace", providerId, providerVersion, v:1}`。
    - create verify 不预分配 provider id；POST 保存只接受 mode=create token，重算 draftHash 与有效期后生成 provider id，并以该 id 作为 AAD 加密。existing token 则必须与 path/draft id、当前 version/generation 全部一致。
    - 解析时先检查 token/payload version、mode 与长度，再 timing-safe 比较等长 signature；有效期 5 分钟。
  - `draftHash` 是 fingerprintKey 对 canonical JSON `{baseUrl, model, keyFingerprint}` 的 HMAC，因而字段或 key 任一变化都会失效且不会暴露裸 key hash。
- 本切片不支持透明主密钥轮换。环境 key 缺失/格式错 → `MASTER_KEY_UNAVAILABLE`；row `key_id` 不同 → `PROVIDER_KEY_UNAVAILABLE`；未知 envelope/version、base64 错、GCM tag 失败 → `PROVIDER_KEY_CORRUPT`。列表仍返回非敏感 DTO；retain/验证失败关闭且不得覆盖密文；owner 可通过 replace 模式提交新 key 和新验证 token 原子恢复该 provider。

### D-3: schema 演进
- 方案 A: 继续在 `openDatabase()` 追加 `CREATE TABLE IF NOT EXISTS`。取舍: 代码少，但无法确认已有库是否完成约束变化或按序升级。
- 方案 B: 使用 SQLite 内建 `user_version` 和仓库内顺序迁移函数。取舍: 多一个明确模块，但无额外 ORM/生成器，能在事务中按版本升级。
- 选择: B。精确算法:
  1. 打开连接后先 `PRAGMA foreign_keys = ON`，读取 `user_version` 与 `sqlite_master`。
  2. v0 空库: 在一个 `BEGIN IMMEDIATE` 中创建完整 S-1 表/索引并写 `user_version=1`。
  3. v0 legacy 库: 只有当 `projects`、`task_runs`、`task_events` 三表全部存在，`PRAGMA table_info/foreign_key_list` 至少包含 S-1 已发布列、主键、唯一事件序号和外键时，才在事务中采用为 v1；任一表缺失或约束漂移返回 `SCHEMA_DRIFT`，不得猜测修补。
  4. v1: 在单独的 `BEGIN IMMEDIATE` 中创建全部 S-2 表/索引并写 `user_version=2`；任何 DDL/版本写失败都回滚到完整 v1。
  5. v2: 校验 S-2 最低表/列/外键后返回连接；高于 2 的版本返回 `SCHEMA_TOO_NEW`。
  6. 任一步异常均回滚活动事务、关闭连接，再抛出 sanitized storage error。外键在事务前开启且测试确认保持开启。
- 不改写或删除 S-1 数据。测试 fixture 覆盖空 v0、真实 S-1 legacy v0、残缺 v0、合法 v1/v2、未知高版本、每步故障注入、重复打开与 S-1 数据/外键保留。

### D-4: 输入校验
- 方案 A: 延续每个 Route Handler 手写检查。取舍: 无依赖，但 S-2 字段多、更新语义复杂，容易产生不一致错误。
- 方案 B: 引入 Zod schema，Route Handler 与服务共享约束，统一输出字段错误。
- 选择: B。只使用 schema 校验外部输入；领域引用、验证 token、状态与事务约束仍由服务负责。加入最新兼容的 `zod`，不引入通用表单框架。

### D-5: Agent 强调色
- 方案 A: 接受任意 CSS 色值并以内联变量渲染。取舍: 自由，但破坏 token 静态纪律并可能造成对比度问题。
- 方案 B: 使用受控 token 枚举 `sage | terracotta | gold | slate | rose | olive`。取舍: 选择有限，但每项可验证对比度且不会引入任意样式。
- 选择: B。DTO 只传 token 名，CSS 通过 `data-accent` 选择已有变量；头像同时显示文字，状态不依赖颜色。

### D-6: Team 信息架构
- 方案 A: 把所有配置塞进现有首页右栏。取舍: 少一个路由，但会让项目任务与全局 Agent 库混杂，窄屏不可用。
- 方案 B: 新增 `/team`，复用全局温暖工作台视觉；页内为“资源导航 / 列表 / 编辑器”三栏。
- 选择: B。首页增加真实可用的“工作 / 团队”导航；不新增未实现入口。

## 3. 接口与数据契约

### 3.1 SQLite version 2

```sql
providers(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  default_model TEXT NOT NULL,
  api_key_cipher TEXT NOT NULL,
  api_key_iv TEXT NOT NULL,
  api_key_tag TEXT NOT NULL,
  credential_version INTEGER NOT NULL CHECK(credential_version = 1),
  credential_generation INTEGER NOT NULL CHECK(credential_generation >= 1),
  key_id TEXT NOT NULL,
  api_key_mask TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

skills(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

agents(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  model TEXT NOT NULL,
  avatar_text TEXT NOT NULL,
  accent_token TEXT NOT NULL,
  can_read INTEGER NOT NULL CHECK(can_read IN (0,1)),
  can_write INTEGER NOT NULL CHECK(can_write IN (0,1)),
  can_execute INTEGER NOT NULL CHECK(can_execute IN (0,1)),
  max_tokens INTEGER NOT NULL,
  max_handoffs INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

agent_skills(
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id),
  position INTEGER NOT NULL,
  PRIMARY KEY(agent_id, skill_id),
  UNIQUE(agent_id, position)
);
```

密文、IV、tag、key id 只存在于 server persistence 类型；任何 `src/shared` DTO 都没有这些字段。

### 3.2 Public DTO

```ts
type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  apiKeyMask: string;
  status: "verified" | "key_unavailable" | "key_corrupt";
  verifiedAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type Skill = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type ToolPermissions = {
  readFiles: boolean;
  writeFiles: boolean;
  runCommands: boolean;
};

type AgentProfile = {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  providerId: string;
  model: string;
  skillIds: string[];
  permissions: ToolPermissions;
  maxTokens: number;
  maxHandoffs: number;
  avatarText: string;
  accentToken: "sage" | "terracotta" | "gold" | "slate" | "rose" | "olive";
  version: number;
  createdAt: string;
  updatedAt: string;
};

type AgentTemplate = {
  id: "planner" | "builder" | "reviewer";
  name: string;
  role: string;
  systemPrompt: string;
  avatarText: string;
  accentToken: AgentProfile["accentToken"];
};
```

### 3.3 Provider 输入与验证 token

```ts
type ProviderConnection = {
  baseUrl: string;
  defaultModel: string;
  allowInsecureHttp: boolean;
};

type CreateProviderDraft = ProviderConnection & {
  mode: "create";
  name: string;
  apiKey: string;
};

type RetainProviderDraft = ProviderConnection & {
  mode: "retain";
  providerId: string;
  expectedVersion: number;
  name: string;
};

type ReplaceProviderDraft = ProviderConnection & {
  mode: "replace";
  providerId: string;
  expectedVersion: number;
  name: string;
  apiKey: string;
};

type ProviderDraft =
  | CreateProviderDraft
  | RetainProviderDraft
  | ReplaceProviderDraft;

type VerifyProviderSuccess = {
  verifiedModel: string;
  validationToken: string;
  expiresAt: string;
};
```

- `POST /api/providers/verify` + `ProviderDraft` → `200 VerifyProviderSuccess`；create/replace 使用输入 key，retain 在读取当前 version/generation 后解密现有 key。
- `GET /api/providers` → `200 { providers: Provider[] }`。
- `POST /api/providers` + `{ draft, validationToken }` → `201 { provider }`。
- `PATCH /api/providers/:id` + `{ draft, validationToken }` → `200 { provider }`。

合法组合与并发语义:

- POST 只接受 `mode=create`，apiKey 与 validationToken 必填。
- PATCH path id 必须与 `draft.providerId` 一致；不一致为 `INVALID_INPUT`。
- `retain` 且 name/baseUrl/model 都与当前 row 相同或只有 name 改变: 不要求 validationToken，但必须带 `expectedVersion`。
- `retain` 且 baseUrl/model 改变: 必须先以当前 row 的 key 验证并提交 token。
- `replace`: 无论连接字段是否变化都必须以新 key 验证并提交 token。
- token 对 existing provider 绑定 id、`version` 与 `credential_generation`；保存事务先以 `expectedVersion` 比较当前 row，再重算草稿 hash。任一不符返回 `PROVIDER_CONFLICT` 或 `VALIDATION_MISMATCH`，事务不写任何字段。
- name-only 更新使 row version +1，但 credential generation 不变；replace 成功使二者都 +1。并发更新后旧 token 必然因 version 不同而拒绝。
- key unavailable/corrupt 时 retain 与 retain-verify 均失败关闭；replace 仍可用新 key + token 恢复，但事务不得读取或覆盖到未经 expectedVersion 保护的 row。

验证协议:

1. 使用 WHATWG URL；协议必须为 http/https，username/password/query/hash 必须为空。host 由 URL 实现小写与 IDN punycode 化，默认端口被消除；pathname 保留规范 percent-encoding、解析 dot segment、去除末尾 `/`，空 path 视为根。
2. 规范 base URL 示例: `HTTPS://例子.测试:443/v1/` → `https://xn--fsqu00a.xn--0zwm56d/v1`；`https://host/v1?x=1` 与 `https://host/v1#x` 拒绝。
3. models URL 由相同 origin + `<normalized pathname>/models` 构造；`https://host/v1` → `https://host/v1/models`，不会用字符串拼接改变 host。
4. 发起 GET，`Authorization: Bearer <key>`，`Accept: application/json`，`redirect:"manual"`，AbortSignal 10 秒；任何 3xx 失败。
5. 响应 body 最多读取 1 MiB，`data` 最多接受 10000 项；只接受 2xx JSON `{ data: Array<{ id: string }> }` 且含完全相同的 model。
6. Provider 网络路径绝不调用现有会打印 raw Error 的兜底。typed sanitized error 只携带 `code`、`httpStatus`、`correlationId` 与非敏感 category；日志白名单只有 `{correlationId, code, providerId?}`，不记录 URL/origin、headers、body、key、token 或底层 Error。

### 3.4 Skill / Agent API

```ts
type FieldName =
  | "mode" | "providerId" | "expectedVersion"
  | "name" | "baseUrl" | "defaultModel" | "apiKey"
  | "allowInsecureHttp"
  | "description" | "instructions"
  | "role" | "systemPrompt" | "model" | "skillIds"
  | "permissions.readFiles" | "permissions.writeFiles"
  | "permissions.runCommands"
  | "maxTokens" | "maxHandoffs" | "avatarText" | "accentToken";

type FieldErrorCode =
  | "required" | "too_long" | "invalid_format" | "out_of_range"
  | "not_integer" | "invalid_reference" | "confirmation_required";

type ApiError = {
  error: {
    code: string;
    message: string;
    correlationId?: string;
    fields?: Array<{ field: FieldName; code: FieldErrorCode }>;
  };
};

type SkillInput = {
  name: string;
  description: string;
  instructions: string;
};

type UpdateSkillInput = SkillInput & { expectedVersion: number };

type AgentInput = {
  name: string;
  role: string;
  systemPrompt: string;
  providerId: string;
  model: string;
  skillIds: string[];
  permissions: ToolPermissions;
  maxTokens: number;
  maxHandoffs: number;
  avatarText: string;
  accentToken: AgentProfile["accentToken"];
};

type UpdateAgentInput = AgentInput & { expectedVersion: number };
```

- `GET /api/skills` → `200 { skills: Skill[] }`
- `POST /api/skills` + `SkillInput` → `201 { skill }`
- `PATCH /api/skills/:id` + `UpdateSkillInput` → `200 { skill }`；PATCH 是全量替换，缺任一字段为 `INVALID_INPUT`，版本不符为 `RESOURCE_CONFLICT`
- `GET /api/agent-templates` → `200 { templates: AgentTemplate[] }`
- `GET /api/agents` → `200 { agents: AgentProfile[] }`
- `POST /api/agents` + `AgentInput` → `201 { agent }`
- `PATCH /api/agents/:id` + `UpdateAgentInput` → `200 { agent }`；PATCH 是全量替换，缺字段/版本冲突语义同技能

Agent 保存事务先校验 provider 存在且 verified、全部 skill id 存在，再写 Agent 与有序 `agent_skills`。模板是只读常量，每次请求返回新 DTO，不在数据库中被 Agent 编辑污染。

精确语义:

- Provider/Skill/Agent 列表均按 `created_at ASC, id ASC` 稳定排序；`skillIds` 按提交顺序写 `position` 并按 position 返回。
- Unicode 头像长度使用 `Intl.Segmenter("zh-CN", {granularity:"grapheme"})` 计 1–4 个 grapheme cluster，不按 UTF-16 code unit。
- `Provider.status="verified"` 当且仅当 row key id 等于当前 key id、credential envelope 可解密且 `verified_at` 非空；key mismatch/corrupt 分别返回非敏感状态，不把 provider 当作 Agent 的有效引用。
- 所有文本作为 JSON string 和 React text node 返回/渲染；禁止 `dangerouslySetInnerHTML`，技能正文中的 HTML/代码不解释执行。
- Agent 的 model 必须等于所选 Provider 的 `defaultModel`（S-2 只支持每 provider 一个已验证 model），否则 `INVALID_INPUT/model invalid_reference`。
- 创建/更新 Agent 时 provider 不是 verified → `409 PROVIDER_NOT_VERIFIED`；skill id 缺失 → `409 INVALID_SKILL_REFERENCE`；版本冲突 → `409 RESOURCE_CONFLICT`。

### 3.5 Stable errors

沿用 `{ error: { code, message, fields? } }`，新增:

- 400: `INVALID_INPUT`, `INSECURE_HTTP_CONFIRMATION_REQUIRED`, `MODEL_NOT_AVAILABLE`
- 401: `PROVIDER_UNAUTHORIZED`
- 404: `PROVIDER_NOT_FOUND`, `SKILL_NOT_FOUND`, `AGENT_NOT_FOUND`
- 409: `VALIDATION_REQUIRED`, `VALIDATION_EXPIRED`, `VALIDATION_MISMATCH`, `PROVIDER_CONFLICT`, `RESOURCE_CONFLICT`, `PROVIDER_KEY_UNAVAILABLE`, `PROVIDER_KEY_CORRUPT`, `PROVIDER_NOT_VERIFIED`, `INVALID_SKILL_REFERENCE`
- 429: `PROVIDER_RATE_LIMITED`
- 502: `PROVIDER_INCOMPATIBLE`, `PROVIDER_REDIRECTED`, `PROVIDER_UNREACHABLE`, `PROVIDER_REJECTED`, `PROVIDER_UPSTREAM_ERROR`, `PROVIDER_RESPONSE_TOO_LARGE`
- 504: `PROVIDER_TIMEOUT`
- 503: `MASTER_KEY_UNAVAILABLE`, `STORAGE_UNAVAILABLE`, `SCHEMA_DRIFT`, `SCHEMA_TOO_NEW`
- 500: `INTERNAL_ERROR`

客户端按稳定 code 映射简体中文文案；server message 仅为非敏感诊断，不直接展示。

Provider verifier 映射:

- 401/403 → client 401 `PROVIDER_UNAUTHORIZED`
- 404 或合法 2xx 但目录/model 不匹配 → 502 `PROVIDER_INCOMPATIBLE`
- 429 → 429 `PROVIDER_RATE_LIMITED`
- 其他 4xx → 502 `PROVIDER_REJECTED`
- 5xx → 502 `PROVIDER_UPSTREAM_ERROR`
- 3xx → 502 `PROVIDER_REDIRECTED`
- body >1 MiB/条目 >10000 → 502 `PROVIDER_RESPONSE_TOO_LARGE`
- 非 JSON/shape 无效 → 502 `PROVIDER_INCOMPATIBLE`
- DNS/TLS/连接失败 → 502 `PROVIDER_UNREACHABLE`
- 10 秒 abort → 504 `PROVIDER_TIMEOUT`
- Zod/字段边界 → 400 `INVALID_INPUT` + fields
- 任何未知异常 → 500 `INTERNAL_ERROR` + correlationId；日志只写 correlationId/code

## 4. NFR 落点

| NFR | 满足机制 | 验证方式 |
|-----|---------|---------|
| NFR-1 Provider 凭据保密 | env-only 主密钥；HKDF 子密钥；AES-256-GCM；public DTO 与 persistence 类型分离；redacted provider errors；缺 key 失败关闭 | 密钥缺失/错误测试、DB/源码/日志/API 明文扫描、只复制 DB 无法解密、浏览器掩码断言 |
| NFR-2 可访问性 | 语义表单、fieldset/legend、字段错误 `aria-describedby`、44px token、focus-visible、保存后标题聚焦与 aria-live | Testing Library 键盘/语义测试、Playwright 键盘路径、截图人工核对 |
| NFR-3 外发凭据边界 | manual redirect、10 秒 abort、Authorization 仅原始请求、网络错误脱敏 | 本地 HTTP 服务记录请求，3xx 目标请求数为 0，挂起请求用可控计时验证超时 |

## 5. 错误处理

- 主密钥缺失、格式不是 base64 32 字节或 key id 不匹配时，不尝试 provider 网络请求和保存；provider 列表仍可展示非敏感 DTO。
- 旧密钥 key id 不同返回 `PROVIDER_KEY_UNAVAILABLE`；envelope/version/base64/tag 损坏返回 `PROVIDER_KEY_CORRUPT`。两者都不删除/覆盖配置、不打印 crypto 输入；只有 expectedVersion 保护的 replace 可恢复。
- Provider 验证在网络调用前完成全部字段/URL/HTTP 确认校验；网络调用期间不打开 SQLite 事务。
- Provider 2xx 但响应不是合法模型目录时返回 `PROVIDER_INCOMPATIBLE`；不得把原始响应体回传或写日志。
- Skill/Agent 字段错误返回 `INVALID_INPUT` 与字段 code；引用错误在事务前收集，事务内再次确认以避免竞态。
- schema 迁移失败回滚并统一映射 `STORAGE_UNAVAILABLE`；禁止部分 version 2 表留存后继续运行。
- UI 每个资源独立保留上一次成功数据；加载失败显示重试，保存失败保留草稿，验证字段变化立即清除 validation token。
- 现有 `unexpectedErrorResponse(error)` 改为 `internalErrorResponse(context)`：调用者只传 route 名与新生成 correlationId，函数不得接收/打印 raw Error。所有 route catch 先把已知 typed error 映射；未知异常只记录 `{correlationId, code:"INTERNAL_ERROR", route}`。测试直接让 fetch/crypto/schema/SQLite 抛出包含测试 key、token、完整 URL 和响应体的 Error，扫描 API body 与捕获日志均不得出现这些输入。

## 6. 测试策略

- Migration: 从空库与真实 version 1 fixture 升级到 version 2，确认 S-1 数据保留、重复打开幂等、失败回滚。
- Vault/security: 固定测试 key 验证 round-trip、AAD、防篡改、错误主密钥、缺 key 失败关闭、validation token 过期/篡改/字段不匹配，以及明文扫描。
- Provider verifier: 本地 HTTP server 覆盖模型存在/缺失、401、非 JSON、3xx、连接失败和 10 秒超时；断言重定向目标零请求、日志无 key。
- Service/API: 使用临时 SQLite，覆盖 provider create/update/retain/replace key，skill create/update/version，agent create/update/reference/budget/field bounds，DTO 无秘密。
- Components: Provider/Skill/Agent 各自覆盖 loading/empty/error/retry/disabled/success/focus；验证后字段变化失效；草稿保留；模板不污染；键盘完成主路径。
- Static UI: 复用 token 扫描并验证新增样式无 raw visual values，accent 只来自受控 `data-accent`。
- Browser smoke: 启动本地兼容 provider 与真实 Next app，设置临时 DB/master key，创建并验证 provider、技能和两个不同 Agent，刷新后核对；扫描 smoke 输出、DB 与 API 响应无测试 key，保存 Team 桌面与窄屏截图。
- 全量命令: `npm test`；生产构建 `npm run build`；S-2 浏览器入口使用独立 `npm run smoke:team`，不覆盖 S-1 harness。

## 7. UI 设计

### 信息架构
- 全局 `nav aria-label="主导航"` 新增“工作”“团队”两个真实链接；`/` 保持 S-1，`/team` 进入配置。
- `/team` 桌面三栏:
  - 左栏: 单选资源切换使用 ARIA tabs：`tablist aria-label="团队资源"`，三个 `tab` 以 ArrowLeft/Right、Home/End 切换并控制唯一 `tabpanel`；不混用普通 button 导航语义。数量只来自真实数据。
  - 中栏: 当前资源列表与创建入口；Agent 卡显示头像文字、名称、职责、model、技能名和权限文本。
  - 右栏: 创建/编辑表单；窄屏作为带标题和关闭按钮的抽屉。
- Provider 表单顺序: 名称 → base URL → model → key/保留提示 → HTTP 风险确认 → 验证 → 保存。
- Skill 表单顺序: 名称 → 说明 → 指令正文。
- Agent 表单顺序: 模板/空白 → 身份 → provider/model → 技能 → 权限 → 预算 → 头像与强调色。

### 状态矩阵
- loading: 三类资源分别显示 `aria-busy`；一个区域加载不阻塞已加载区域。
- empty: 每类给唯一下一步创建按钮；Agent 空状态在 provider 未就绪时引导先配置 provider。
- error: 区域内 `role=alert` 简体中文摘要 + 重试；字段错误 summary 聚焦后链接到第一个无效字段，编辑草稿不清空。
- disabled: Provider 验证中禁用验证/保存；未验证或验证 token 失效时禁用保存；Agent 缺 verified provider 时禁用保存并说明原因。
- success: 保存后列表更新，焦点移到实体标题，独立 `role=status aria-live=polite` 宣告；Provider 验证成功/失败也使用 status/alert，不只改变颜色。
- focus: 打开编辑器聚焦标题或第一个错误字段；关闭窄屏抽屉恢复到 opener。
- Provider key: 编辑时永不回填；显示 `已保存 ••••ABCD`，空输入表示保留，输入新值表示替换。
- key 显示切换是 `button type=button aria-pressed`，可访问名称在“显示 API key / 隐藏 API key”间切换；切换只改变 input type，不改 state/value，保存成功后完整 key 从 DOM 和客户端 state 清除。
- Agent 技能选择用 `fieldset` + `legend` 和 checkbox 列表；无技能时显示 empty + “创建技能”动作，引用失效时 fieldset 下显示关联错误；Space 切换，Tab 按 DOM 顺序离开。
- 窄屏编辑器为 `role=dialog aria-modal=true aria-labelledby`；打开后设置其余 app shell `inert` 并锁定 body 滚动，Tab/Shift+Tab 限制在 dialog，Escape 关闭且焦点恢复 opener。桌面右栏不是 dialog。

### 视觉系统
- 完全复用 S-1 的字体、surface、border、spacing、radius、shadow、focus 与 44px control token。
- `tokens.css` 新增以下前景/浅底 token，组件通过 `data-accent` 使用，不接受内联颜色:
  - sage: `--agent-sage-fg:#315A52` / `--agent-sage-bg:#E1ECE8`
  - terracotta: `--agent-terracotta-fg:#7B3F31` / `--agent-terracotta-bg:#F4E3DC`
  - gold: `--agent-gold-fg:#6B4E19` / `--agent-gold-bg:#F5EBCF`
  - slate: `--agent-slate-fg:#44515F` / `--agent-slate-bg:#E7EBEF`
  - rose: `--agent-rose-fg:#7D394C` / `--agent-rose-bg:#F5E1E7`
  - olive: `--agent-olive-fg:#4F5824` / `--agent-olive-bg:#E9EDD7`
- 静态/单元测试按 WCAG 相对亮度公式断言每组 fg/bg ≥4.5:1，且 Agent 名称仍使用全局正文色；不合格即测试失败。
- Provider 验证状态使用图标库前先评估必要性；S-2 默认用文本 + 状态点，避免为三个符号引入依赖。
- 头像为 44px 圆角几何块 + 1–4 字符；强调色是辅助识别，名称/职责始终可见。
- 不新增渐变、玻璃拟态、装饰动画、虚构统计或不可用入口。

### 可访问性
- 资源导航使用语义 button/tab 模式并有选中状态；表单 label 与错误 id 一一关联。
- 技能多选使用 fieldset/legend；权限开关有文本状态；预算输入带单位说明。
- key 字段支持密码显示切换，但切换按钮不改变保存值；保存后 DOM 中不存在完整 key。
- 所有窄屏抽屉支持 Escape、焦点进入/恢复和背景不可聚焦。

## 8. 任务清单

- [x] T-1 打通 `/team` 创建技能的最薄纵向路径 (覆盖: FR-4) — 判据: `npm test -- tests/team-skill-slice.test.tsx` 先红后绿；从 Team 导航经真实 Skill API 写入临时 SQLite 并回显纯文本技能，刷新读取仍在
- [x] T-2 固化 v0→v1→v2 迁移安全边界 (覆盖: FR-4, FR-6) — 判据: `npm test -- tests/migrations.test.ts` 先红后绿；空库、真实 legacy v0、v1/v2、漂移/残缺/高版本、故障回滚、重复打开、S-1 数据与外键保留全部通过
- [x] T-3 实现版本化凭据保险箱与验证 token (覆盖: NFR-1) — 判据: `npm test -- tests/credential-vault.test.ts` 先红后绿；HKDF/AES envelope、AAD、防篡改、key 状态、replace 恢复、token 过期/篡改/版本竞态与明文扫描通过
- [x] T-4 实现 Provider 安全网络验证器 (覆盖: FR-2, NFR-3) — 判据: `npm test -- tests/provider-verifier.test.ts` 先红后绿；URL 规范化、模型目录、1MiB/10000 项、3xx 零转发、401/403/404/429/5xx、DNS/TLS、10 秒超时和 sanitized 日志映射通过
- [x] T-5 实现 Provider 持久化与 API 并发契约 (覆盖: FR-1, FR-3, NFR-1) — 判据: `npm test -- tests/providers.service.test.ts tests/providers.api.test.ts` 先红后绿；create/retain/name-only/connection-change/replace、expectedVersion、generation、mask、DTO 无秘密及全部稳定错误通过
- [x] T-6 交付 Provider 配置 UI (覆盖: FR-1, FR-2, FR-3, FR-7, NFR-1, NFR-2) — 判据: `npm test -- tests/provider-panel.test.tsx` 先红后绿；掩码 key、HTTP 确认、验证失效、loading/empty/error/retry/disabled/success/focus、密码切换与中文错误通过
- [x] T-7 补全技能编辑与 UI 三态 (覆盖: FR-4, FR-7, NFR-2) — 判据: `npm test -- tests/skills.service.test.ts tests/skills.api.test.ts tests/skill-panel.test.tsx` 先红后绿；字段边界、version 冲突、纯文本、草稿保留、三态与键盘路径通过
- [x] T-8 建立 Agent 模板、能力与技能关联 (覆盖: FR-5, FR-6) — 判据: `npm test -- tests/agents.service.test.ts tests/agents.api.test.ts` 先红后绿；不可变模板、grapheme 头像、verified provider/skill 引用、预算边界、权限、有序关联和 expectedVersion 事务通过
- [x] T-9 交付可辨识 Agent 配置 UI (覆盖: FR-5, FR-6, FR-7, NFR-2) — 判据: `npm test -- tests/agent-panel.test.tsx tests/team-accessibility.test.tsx tests/team-visual-tokens.test.ts` 先红后绿；模板/空白、技能/权限/预算、六色 AA token、tabs/dialog/focus trap/inert、三态与无硬编码视觉值通过
- [x] T-10 收口 Team 真实浏览器与安全验收 (覆盖: FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, NFR-1, NFR-2, NFR-3) — 判据: README、`npm test`、`npm run build` 与独立 `npm run smoke:team` 通过；浏览器完成 provider+skill+双 Agent 并刷新恢复，DB/API/log/兜底错误明文扫描为 0，桌面/窄屏 smoke 与 demo 证据落盘
