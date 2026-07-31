# 并行且安全地执行项目工作 技术设计

- 日期: 2026-07-30
- 规格: ./spec.md

## 1. 架构总览

S-5 延续 S-4 的“客户端驱动、服务端一次推进一个原子动作”模式，但把推进单位从 collaboration turn 改为 execution action。浏览器只在当前打开的项目中调度，最多同时向两个不同 execution 发出一个 `advance`；服务端仍是唯一裁决者，并通过 SQLite 事务、partial unique index 和 CAS 同时保证每项目最多两个 active execution、每任务/每 Agent 最多一个 active execution、每 Agent 最多一个在途模型调用。没有常驻 worker，关闭页面不会继续自治执行；刷新后读取持久状态，owner 明确继续才会恢复推进。

```text
MissionBoard / ExecutionWorkspace
  ├─ EligibleTaskPicker
  ├─ ExecutionCard × 2
  ├─ ApprovalSurface
  ├─ StagedDiffSurface
  ├─ ManualRecoverySurface
  └─ ValidationPolicyEditor
              ↓
execution Route Handlers + typed public contracts
              ↓
execution-service / action-orchestrator / operation-receipts
     ├─ frozen-input + prompt-builder + S-4 OpenAI client/repair
     ├─ sandbox-manager + path-guard + file tools
     ├─ command-policy + process-runner + approval-service
     ├─ stage/diff/conflict-service
     └─ merge-journal + recovery
              ↓
SQLite v5 facts       app-managed execution root
              ↓                    ↓
S-4/S-3 facts       per-attempt sandbox / manifest / merge backup
              └──────── guarded merge ────────→ canonical workspace
```

复用现有代码:

- `migrations.ts` 的严格版本迁移/漂移拒绝模式、`openDatabase` 的 FK 开启与脱敏失败。
- S-4 `operation-receipts.ts` 的 canonical request hash 语义；v5 抽成通用 receipt primitive，S-4 表与行为不变，S-5 使用自己的有界 kind 集合。
- `openai-chat-client.ts` 的 manual redirect、90 秒 HTTP timeout、1 MiB body、可信 usage 校验和 sanitized error；`structured-repair.ts` 的一次 repair 模式。
- `context-snapshot-service`、mission DAG/claim transaction primitive、provider vault、Agent/skill/member/version 事实。
- `CollaborationPanel` 的轮询/单次 auto-advance、operation id 重试、typed timeline、mobile modal/focus primitive；`TaskPanel` 的 chat/board/run IA。
- 既有 `tokens.css` 的暖中性色、Agent accent、spacing、radius、focus、44px control 和窄屏断点。

新增服务边界:

- `src/server/execution/execution-service.ts`: 选择、资格、状态机、控制、读取。
- `action-orchestrator.ts`: acquire/lease、一次模型动作或一次已批准命令、finalize/CAS。
- `execution-prompt-builder.ts`、`execution-action-schema.ts`: 冻结输入、工具结果循环和 strict JSON。
- `sandbox-manager.ts`、`path-guard.ts`、`file-tools.ts`: 快照、manifest、路径与文本工具。
- `validation-policy-service.ts`、`command-policy.ts`、`process-runner.ts`、`approval-service.ts`。
- `stage-service.ts`、`conflict-service.ts`、`merge-journal-service.ts`、`merge-recovery.ts`。
- `src/shared/execution-contracts.ts`: DTO、事件、错误和 Zod public payload；不导出私有 prompt、凭据、原始 provider body、原始进程环境或未脱敏输出。
- `components/execution/**`: 任务选择、双卡、审批、diff、政策、控制和窄屏单 surface。

## 2. 关键决策

### D-1: 最多两个 execution 的执行载体

- 方案 A: 常驻 worker 扫描 queued execution 并自动补位。优点是页面关闭仍可运行；缺点是当前单机 Next 架构没有 worker 生命周期、领导选举或可靠 shutdown，且会违反“不得无人值守自动补位/重启不自动续跑”。
- 方案 B: 当前浏览器会话维护最多两个独立auto-loop；每个请求只推进一个logical operation，其外部children严格串行且任一时刻最多一个running。优点是复用S-4 receipt/lease/recovery且能容纳持久分段；owner关闭页面即停止推进。缺点是页面必须保持打开。
- 选择: B。`ExecutionAutoLoop` 每次从公开状态中按 `(createdAt,id)` 选择最多两个“queued且attempt ready”或`running` execution，且每个 execution 仅一个请求在途；sandbox仍preparing的queued只显示currentAction，不发advance。queued且`reasonCode='SANDBOX_RESUME_REQUIRED'`只在owner刚执行continue后调用一次`start-resume`，不把它当advance。响应后刷新再决定下一步。空出名额不创建 execution，也不启动未选择任务。服务端对所有并发限制再次机械校验，客户端不是安全边界。

每个`advance` operation是parent receipt；当前model推进使用一个可heartbeat的model child，child内可有primary/repair两条call fact；model action只校验并持久化下一tool request后返回。下一次advance建立新的parent operation和file/command child；tool result后再由下一次model operation放入prompt。因此tool-result loop跨多个短HTTP请求，parent/child schema不等于把整条自治循环塞进一个receipt。

start 请求中的 `sourceCollaborationRunId` 必须指向该项目最新的 `planned` S-4 run；所选 work item 必须在该 run 的 committed turn/event 中由同一领取 Agent claim，且仍属于当前 mission。这样 S-5 的冻结上下文和共享 usage 都有唯一 S-4 run 边界；旧 run、仍在 running/waiting/paused/failed 的 run，或不能证明 claim 来源的任务逐项拒绝。

start API 每个请求只接受一个 `workItemId`、只创建一个execution/attempt/sandbox action和一个parent receipt。UI选择两项时生成两个不同operationId并并发发出两次POST；每次独立201/4xx、独立重放，不能用一项成功掩盖另一项失败。客户端并发数≤2，服务端在各自`BEGIN IMMEDIATE`内重检project/task/Agent上限；竞态中后取得事务者返回自己的持久rejected receipt。

### D-2: Git 与非 Git workspace 的 sandbox

- 方案 A: Git 项目用 worktree、非 Git 用复制。Git 项目创建快，但 `.git` 文件指向 canonical 的 Git 元数据，命令仍可能改变共享 refs/index；两种实现具有不同边界，Git LFS/submodule/sparse checkout 还会引入链接和外部对象。
- 方案 B: 所有项目都用同一“普通文件快照复制”，Git 元数据只参与项目识别而不复制。边界一致、manifest 可复现、canonical Git 状态不被 sandbox 命令触碰；代价是磁盘和启动时间更高，并且被排除的依赖缓存需由项目已有自包含验证或 owner 明确批准的 sandbox-scoped 安装补齐。
- 选择: B。首版 sandbox 根为 Windows `%LOCALAPPDATA%\CoolAI\executions`；测试必须显式注入临时根。启动时用 verified root handle 的 normalized final path 比较 execution root 与 canonical root，若任一包含另一方即失败。目录为 `<root>/<projectId>/<executionId>/<attemptNo>/sandbox`，merge journal/backup 与其同级，绝不位于 canonical。其他平台的默认根与 adapter 留给后续切片。

native binding 实现选择与首版支持矩阵：

- 方案 A: 仓库自带 Node-API C++ addon。API 可完全定制，但会把 MSVC/Xcode/GCC + node-gyp 编译链变成普通安装和 CI 的硬前置，当前仓库没有 native build 基础。
- 方案 B: 使用 server-only Koffi FFI（包管理器安装当前兼容版本并由 Next `serverExternalPackages` 外置）直接绑定固定 OS API；TypeScript 层只暴露 D-2 的 `SandboxFsAdapter`，不让任意函数名/地址来自模型或用户输入。优点是使用预构建 native runtime、无需仓库自建 ABI；缺点是必须精确声明平台 struct/handle 生命周期并做真实平台测试。
- 选择: B，并按 A-60 将首版支持矩阵收窄为 Windows 10+/Server 2016+ x64、Node x64、NTFS/ReFS 本地卷；Linux/macOS/其他 arch/fs 在 adapter capability check 即 `SANDBOX_UNVERIFIABLE`，本切片不宣称 POSIX 支持。production build 后必须运行 native load smoke。

Windows primitive 与 ownership（所有函数名、info class、flags 固定在 server-only 模块）：

| Adapter 能力 | 固定 native primitive / 约束 |
|---|---|
| root open | `CreateFileW` absolute canonical root，`FILE_READ_ATTRIBUTES|FILE_READ_DATA|FILE_LIST_DIRECTORY|FILE_WRITE_ATTRIBUTES|FILE_ADD_FILE|DELETE`，share=`READ|WRITE|DELETE`，`OPEN_EXISTING`，flags=`FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS`; root 自身必须 ordinary directory、非 reparse |
| child directory open | `NtCreateFile` + verified parent + relative name；access=`FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES|SYNCHRONIZE`，share=`READ|WRITE|DELETE`，disposition=`FILE_OPEN`，options=`FILE_DIRECTORY_FILE|FILE_OPEN_REPARSE_POINT|FILE_SYNCHRONOUS_IO_NONALERT`，object=`OBJ_CASE_INSENSITIVE` |
| existing file read open | `NtCreateFile` + verified parent + relative name；access=`FILE_READ_DATA|FILE_READ_ATTRIBUTES|SYNCHRONIZE`，share=`READ|WRITE|DELETE`，disposition=`FILE_OPEN`，options=`FILE_NON_DIRECTORY_FILE|FILE_OPEN_REPARSE_POINT|FILE_SYNCHRONOUS_IO_NONALERT`，object=`OBJ_CASE_INSENSITIVE` |
| owned temp create | `NtCreateFile` + verified parent + generated relative name；access=`FILE_READ_DATA|FILE_WRITE_DATA|FILE_READ_ATTRIBUTES|FILE_WRITE_ATTRIBUTES|DELETE|SYNCHRONIZE`，share=`0`，disposition=`FILE_CREATE`，options=`FILE_NON_DIRECTORY_FILE|FILE_OPEN_REPARSE_POINT|FILE_SYNCHRONOUS_IO_NONALERT`，object=`OBJ_CASE_INSENSITIVE`；禁止 absolute name |
| list | `NtQueryDirectoryFile(FileIdBothDirectoryInformation, RestartScan)` 从 directory HANDLE 分页；逐 entry 校验 `FileAttributes`、64-bit file id、UTF-16 name 长度/NFC，buffer offset/record bounds 任一异常失败关闭 |
| identity/attributes/final path | `GetFileInformationByHandleEx(FileIdInfo/FileBasicInfo/FileStandardInfo)` + `GetFinalPathNameByHandleW(FILE_NAME_NORMALIZED|VOLUME_NAME_DOS)`；去 `\\?\` 后按 Windows volume/case 规则确认仍在 root；volume serial+128-bit file id 组成 identity |
| read/write/flush | `ReadFile`/`WriteFile` 循环处理 short transfer；`FlushFileBuffers` 对文件及可刷新的目录 handle，返回值/bytes/last-error 全检查 |
| relative rename/replace/delete | `NtSetInformationFile(FileRenameInformationEx)`，`RootDirectory=verified parent`，flags 固定为 `FILE_RENAME_FLAG_REPLACE_IF_EXISTS|FILE_RENAME_FLAG_POSIX_SEMANTICS`；删除用 `FileDispositionInformationEx` 固定 `FILE_DISPOSITION_FLAG_DELETE|FILE_DISPOSITION_FLAG_POSIX_SEMANTICS`；每步前后重开并核对 identity/hash，API 返回不确定即 native failure |
| close | 每个成功 handle 唯一 owner，`CloseHandle` 恰一次；目录枚举不转移 ownership。close 失败在尚未 canonical 写入时失败；journal 已开始后按 native failure matrix 进入 barrier/manual recovery |

Koffi ABI descriptor 固定断言 x64 pointer=8、`HANDLE/ULONG_PTR=8`，并逐 struct 声明 size/offset（`UNICODE_STRING`、`OBJECT_ATTRIBUTES`、`IO_STATUS_BLOCK`、`FILE_ID_INFO`、`FILE_BASIC_INFO`、`FILE_STANDARD_INFO`、`FILE_ID_BOTH_DIR_INFORMATION`、rename/disposition info）；加载时以当前进程 arch/Windows version 与 `GetFileInformationByHandleEx` 实测校验。任何 symbol、ABI、struct、NTSTATUS/Win32 result、file id、reparse attributes、final path、flush/rename/delete/close 结果不可验证即 native failure，禁止回退到 path-level `lstat/realpath/open`。

快照只复制普通目录与普通文件。`SandboxFsAdapter` 必须提供 `openRootDirectory`、`openChildDirectoryNoFollow`、`openFileNoFollow`、`readFromHandle`、`identity(handle)`、`attributes(handle)`、`list(handle)` 和 `finalPath(handle)`，首版唯一实现是上表 Windows x64 adapter。不得用先按字符串 `lstat` 再普通 `copyFile(path)` 代替。Windows/Node/volume capability、adapter 加载、ABI、file id、reparse attributes 或 final path 任一不满足即整个 attempt `SANDBOX_UNVERIFIABLE`；其他 OS/arch/fs 同样失败关闭，POSIX adapter 留给后续切片。

固定排除:

- VCS/应用管理目录: `.git`, `.hg`, `.svn`, `.data`, `.next`, `node_modules`, `dist`, `build`, `coverage`（任意层同名目录不递归）。
- 本地凭据文件: `.env`, `.env.*`，但保留普通文件 `.env.example`；以及 basename 为 `id_rsa`, `id_ed25519` 或后缀 `.pem`, `.p12`, `.pfx`, `.key` 的文件。
- execution root 本身（即使错误配置出现在 workspace 下也先因根相交而拒绝）。

排除项不进入模型、manifest 或 staged；UI 在启动预览中显示固定规则和排除计数。sandbox build 是 `execution_actions.kind='sandbox_build'` 的持久外部 action，execution 对 owner 始终保持 `queued`，`currentAction.kind='sandbox_build'`。复制算法只有一遍受控 walk，并把预检与复制闭合在同一 handle 链：

1. 取得 canonical root directory handle，记录 root identity/final path。每个目录只从已验证父 directory handle 打开；打开前由父 handle 列举得到 name/type，打开后确认 ordinary directory、无 link/reparse、final path仍在 root、identity与该 entry一致。
2. 每个 entry（包括被排除项本身）使同一个 `itemCount` 加1；第100001项立即失败。排除目录不打开子目录，排除文件不打开内容，因此秘密/managed path不可能因随后字符串路径替换进入副本。
3. 每个纳入文件只从父 directory handle no-follow打开；记录 pre identity/attributes/size，确认普通文件和final path；从该 handle流式读取并同时写 `.building-<actionId>`、累计实际读取 bytes 和SHA-256。实际累计超过2147483648立即失败；EOF后再次取 source identity/attributes/size，要求与pre完全相同且读取bytes=size，再重新确认所有祖先 directory handle identity未变化。
4. 每完成一个目录，重新核对该目录 identity和父目录中同名entry identity；walk结束再核对 root及全部仍打开的ancestor identities。任何预扫后/open前替换、read中替换、父目录rename/reparse、short/long read或属性变化都中断action，清理整个building目录，不保留部分sandbox。
5. 对building树以相同handle规则重读并生成manifest；与复制过程中记录的每文件bytes/hash逐项相等后，fsync文件/目录并原子rename为`sandbox`。成功才把attempt置ready并完成start receipt；失败/lease过期把execution置paused、`resume_target='queued'`，清理能证明归属该action的building目录。

生产 `start` route 必须使用默认 sandbox executor 把上述 preflight/snapshot 接入持久 action 协议。现有 `Promise<never>` 占位契约替换为：

```ts
type SandboxExecutionInput = {
  databasePath:string; projectId:string; executionId:string; attemptId:string;
  actionId:string; operationId:string; requestHash:string; leaseToken:string;
  canonicalRoot:string; executionRoot:string; sandboxRoot:string;
  overallDeadlineAt:string;
};
type SandboxExecutionOutcome =
  | {kind:"completed"}
  | {kind:"failed";code:string;httpStatus:number};
type SandboxExecutor = (input:SandboxExecutionInput)=>Promise<SandboxExecutionOutcome>;
```

`startExecution` 的准备事务从已验证 project row 取得 `canonicalRoot=workspace_path`，action acquire 后把返回的 lease token 与上述全部 identity/root/deadline 传给 executor。`sandboxExecutor()` 默认返回 `createProductionSandboxExecutor()`（内部组合平台 `SandboxFsAdapter`、`preflightSandbox`、`buildSandboxSnapshot` 与 action heartbeat）；`setSandboxExecutorForTests` 只能覆盖 fault boundary，清空 override 后仍回到生产默认，不能成为 happy-path 唯一实现。

executor 完成 verified snapshot 后，以 `projectId+executionId+attemptId+actionId+operationId+leaseToken` CAS 在同一事务写 baseline/sandbox manifest、attempt `preparing→ready`、sandbox action `succeeded` 和 start receipt `completed(201)`；四项成功事实全有或全无。executor 只返回 outcome，不自行构造公开 DTO；`startExecution` 返回前重新打开数据库并只通过 completed receipt 构造响应，`completed` outcome 却无 completed receipt 是 `MERGE_INVARIANT_FAILED`。失败按下表收口：

| 故障/竞态 | 唯一持久结果与重放 oracle |
|---|---|
| link/reparse/special 在 preflight/复制/rename 前被拒且 cleanup 已确认 | attempt=`interrupted`，action=`failed(error=SPECIAL_FILE_REJECTED)`，execution=`paused,resume_target=queued`，receipt=completed 422；building/sandbox 不存在，canonical hash 不变 |
| item/byte/file 上限在 rename 前命中且 cleanup 已确认 | attempt=`interrupted`，action=`failed(error=SANDBOX_LIMIT_EXCEEDED)`，execution=`paused,resume_target=queued`，receipt=completed 413；building/sandbox 不存在，canonical hash 不变 |
| sandbox 900s overall deadline 命中且 cleanup 已确认 | attempt/action=`interrupted(error=SANDBOX_BUILD_DEADLINE_EXCEEDED)`，execution=`paused,resume_target=queued`，receipt=completed 504；building/sandbox 不存在，canonical hash 不变 |
| 普通复制 I/O 失败且 cleanup 已确认 | attempt=`interrupted`，action=`failed(error=INTERNAL_ERROR)`，execution=`paused,resume_target=queued`，receipt=completed 500；building/sandbox 不存在，canonical hash 不变 |
| adapter/identity/final-path 不可验证 | attempt/action/execution=`failed(error=SANDBOX_UNVERIFIABLE)`，receipt=completed 422；不得暴露 ready/201，canonical hash 不变 |
| 任一失败后 owned building/sandbox cleanup 无法确认 | attempt/action/execution=`failed(error=INTERNAL_ERROR)`，receipt=completed 500；保留对象只读供诊断，不得暴露 ready/201，canonical hash 不变 |
| verified sandbox rename 后、收口事务前退出，或四项写入间注入事务失败 | 四项成功事实全无；重开后 lease reconcile 令 attempt/action=`interrupted(error=SANDBOX_ACTION_INTERRUPTED)`、execution=`paused,resume_target=queued`、receipt=completed 409，并 conditional 清理仍属该 action 的 sandbox/building；canonical hash 不变 |
| 收口 commit 后响应丢失 | 四项成功事实全有；same operation 重放返回首次 completed 201，不再执行 snapshot；不同 body 同 operation 返回 conflict |
| reconcile 与 late finalizer 竞态 | 二者以 lease/status CAS 只有一个成功；reconcile 胜时 late finalizer 写入0且不得恢复 ready/201，finalizer 胜时 replay 为 completed 201 |
| 同 operation 并发 start | live child 只启动一次 snapshot，另一请求返回 in-progress；完成后重放首次结果；不同 operation 的两个合格 task 各有不同 execution/attempt/sandbox |

native failure 按发生阶段唯一收口：

| 阶段 | 持久状态 / HTTP / 文件结果 |
|---|---|
| sandbox build | 复用上表 `SANDBOX_UNVERIFIABLE` 422；无法确认 cleanup 时 execution/attempt/action=`failed`，不完成 ready/201 |
| file list/read（零写） | tool/action=`failed(error=SANDBOX_UNVERIFIABLE)`，execution=`paused,resume_target=running`，receipt=completed 422；sandbox/canonical 零写 |
| file write owned temp 创建前，或 temp 尚可由 identity/hash conditional cleanup | tool/action=`failed(error=SANDBOX_UNVERIFIABLE)`，execution=`paused,resume_target=running`，receipt=completed 422；目标保持旧 identity/hash，owned temp 已删除 |
| file write 已 replace 但 post identity/hash/finalPath 无法确认，或 owned cleanup 无法确认 | tool/action/execution=`failed(error=SANDBOX_UNVERIFIABLE)`，receipt=completed 422；attempt 不可 stage，保留当前 sandbox 供诊断，canonical 零写 |
| stage compute | action=`failed(error=SANDBOX_UNVERIFIABLE)`，execution=`paused,resume_target=running`，receipt=completed 422；不插 staged facts |
| merge capability preflight 在 operation/action acquire 前失败 | `assertCapability` 无副作用且可安全重复；低层 `executeMergePrepare` 保持 operation/action/journal=0，production merge service catch 后以短事务幂等写 `has_external_actions=0`、completed 422 `SANDBOX_UNVERIFIABLE` receipt；execution 保持 staged，canonical hash 不变 |
| journal 已创建后任一 native load/call/ABI/identity/finalPath/read/write/flush/rename/delete/close 结果不可验证 | 立即停止全部自动写；journal=`manual_recovery`、execution=`conflicted,manual_recovery_required=1`、原merge action=`failed(error=MANUAL_RECOVERY_REQUIRED)`、原receipt=completed 409；保持 read barrier，不自动覆盖不匹配内容，任务结果不存在或在 barrier 内补偿删除 |
| manual resolution verify 期间 native failure | journal/execution 保持 manual recovery，resolution action=`failed(error=SANDBOX_UNVERIFIABLE)`、receipt=completed 422；canonical 零写 |
| resolution 成功后的 owned cleanup native failure | resolution/merged/stopped 结果不回退；不再写 canonical，只把无法验证对象计入 `uncleanedOwnedPaths` |

上述各阶段都注入 FFI throw、NTSTATUS/Win32 failure、short/malformed struct、identity/finalPath 缺失、flush/rename/close 不确定与 late finalizer；canonical writer 阶段检测后 external/current bytes 覆盖次数必须为0。

manifest 只使用字节事实，不含 mtime/权限：

```ts
type ManifestEntry = {
  path: string;       // "/" 分隔的 NFC 相对路径，保留实际大小写
  size: number;
  sha256: string;     // 文件原始 bytes
  modeTag: string;    // POSIX mode&0777；Windows readonly/normal属性，仅供metadata diff
  identity: string;   // Windows volume serial + 128-bit file id；用于 stale/race，不进入 byte-manifest hash
};
```

条目按 `Buffer.from(path,"utf8").compare` 排序；确定性 byte-manifest hash 是 SHA-256，逐条输入 `uint32be(pathByteLength) || pathBytes || uint64be(size) || sha256RawBytes`，明确不受mtime或权限影响；`modeTag`另行逐路径比较，用于阻止权限/属性变化。同一规范路径（Windows additionally Unicode case-fold）碰撞即拒绝。基线 manifest、复制后 manifest 和 staged manifest 都使用这一算法。race测试在“父列举后/child open前”“file open后/read中”“EOF后”和“目录walk完成后”替换source file/parent directory，并断言secret/excluded bytes进入sandbox次数为0。

### D-3: 模型动作与工具结果循环

- 方案 A: 让模型输出自然语言，再从文本识别工具和 shell。兼容性高，但无法判定“一回合一个动作”，也会绕过参数、权限和审批边界。
- 方案 B: strict JSON discriminated union，一次 repair；工具结果以 typed、bounded、redacted JSON 作为下一轮 user/tool message。
- 选择: B。沿用当前 OpenAI-compatible client；primary/repair 每次都计共享 usage，repair 不增加业务回合。每个业务回合只接受一个 `action`：

```ts
type ExecutionAction = {
  summary: string; // 1..2000，可见结论，不是思维链
  action:
    | {type:"list"; path:string}
    | {type:"read"; path:string}
    | {type:"write"; path:string; content:string; expectedHash:string|null}
    | {type:"command"; executable:string; args:string[]; workdir:string; expectedEffect:string}
    | {type:"staged"};
};
```

全层 `.strict()`；path 1..4096，args 0..64、单项 0..4096、总 UTF-8 ≤32768，expectedEffect 1..2000。tool result 仅含 `toolCallId/type/status/code/path?/entries?/content?/beforeHash?/afterHash?/exitCode?/durationMs?/stdout?/stderr?/truncated?`，总 JSON UTF-8 ≤2 MiB；超出时按工具自身上限截断并保留 hash/count。invalid primary 仅在内存传给 repair，不入 DB/日志/DOM；第二次无效暂停。公开`advance.actionResult`只是≤64 KiB fixed summary，文件正文/进程输出不随mutation response返回。

prompt 顺序固定为：平台工具契约；当前 Agent 冻结的私有 role/system prompt/按序技能正文/权限；冻结的 prompt-safe 共享 context（其他 Agent 只有公开身份、skill names、permission summary）；冻结任务与依赖；冻结验证政策；最近本 execution 的公开 summary 和 typed tool results。provider key只在发请求前从 vault 取当前已验证凭据，不进入 snapshot/hash。绝不放入 canonical 绝对路径、其他 Agent 私有 prompt/技能正文、任何 key/密文、环境变量或原始 provider body。

### D-4: 进程、standing approval、机械禁令与一次性审批

- 方案 A: shell 字符串 + shell allowlist。能直接运行 `npm test`，但 quoting、重定向、环境展开与平台差异使 exact match 无意义。
- 方案 B: `spawn(executable,args,{shell:false,cwd,env,stdio})`，政策保存本身是 owner 在警示下授予的可撤销 standing approval；near-match/unlisted exact request使用一次性审批。
- 选择: B。政策保存时要求 `{warningAccepted:true}`；每次创建/编辑都先运行与执行时相同的机械 classifier，成功后记录 before/after policy hash、exact tuple、required flag和警示确认。冻结值为 resolved executable绝对路径、可核验identity、逐项args和规范sandbox相对cwd。exact tuple可按standing approval重复执行；大小写、路径表示、参数顺序/值/数量、cwd任一不同均不匹配，进入一次性审批而不是近似放行。

子进程环境从空对象构造，仅含:

- `CI=1`, `NO_COLOR=1`, `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`；
- `HOME/USERPROFILE=<sandbox>/.cockpit-home`、`TMPDIR/TMP/TEMP=<sandbox>/.cockpit-tmp`；
- Windows 仅复制启动所需 `SystemRoot`、`WINDIR`，且值必须为现存系统目录；不传 `PATH`, `PATHEXT`, `COMSPEC` 或任何 `COCKPIT_*`, key/token/proxy/cloud 变量。

机械 classifier 只对请求中可判定的结构作保证，保存政策和执行请求共用同一版本化规则:

1. executable不得是 `cmd/powershell/pwsh/sh/bash/zsh/fish/wscript/cscript`，不得是Windows `.bat/.cmd/.ps1`或POSIX shebang script；请求没有shell string字段、stdin或env override。
2. 任一arg含独立shell control token `|`,`||`,`&&`,`>`,`>>`,`<`,`;`，命令替换 `` `...` ``/`$(`，或环境展开`${...}`/`%NAME%`即deny。普通arg内仅含这些字符但不构成上述完整token时不推断shell行为。
3. executable basename + ordered subcommand命中公开deny matrix即deny：`git push|remote|credential`、`npm|pnpm|yarn publish`、已登记deploy/release子命令、`ssh|scp|sftp`；matrix和classifier版本进入policy hash。产品不提供这些内建动作。
4. cwd必须是sandbox内规范相对目录。仅对明确path-shaped arg（绝对/UNC/device/含separator/`.`或`..`段）以及公开path option（`-C`,`--cwd`,`--prefix`,`--output`,`--dir`及`--name=value`）解析；能解析且指向canonical、execution root或sandbox外即deny；声称为path option但缺值/格式不明即deny。普通无法分类的非path参数不宣称安全：policy save时可在警示下成为standing approval，执行时若未exact match则one-shot。
5. `curl/wget`、package install、网络工具、删除/批量覆盖或其他未知 executable不因推断真实副作用而绝对deny；若没有命中1–4，未列出请求进入one-shot，政策条目则在owner standing warning后可保存。classifier `parseResult='unknown_non_path'`只影响风险原因；`unknown_path_syntax`一律deny。

因此“绝对拒绝”只覆盖上述可机械识别形式，不声称任意 executable 的实际deploy/network/credential/系统副作用执行次数为0。测试oracle是classifier输入tuple→`deny(code)|standing_exact|one_shot(riskReasons)`，并逐条覆盖matrix、path option和unknown分支。

这里准确保留 A-53/A-58：S-5 的“安全”是平台级路径、权限、机械请求分类、审批、超时、冲突和审计 guardrail；它不是 hostile OS sandbox。standing approval和一次性批准都可能运行平台无法静态证明副作用的程序，该程序仍可能自行访问网络、本机文件、进程、服务或凭据。政策编辑、保存确认、命令审批和执行详情必须区分“standing policy match”与“one-shot approval”并显示该警示。

进程在 POSIX 新 process group、Windows detached process group 启动；120 秒时 POSIX 对 group 先 SIGTERM 后 2 秒 SIGKILL，Windows 用 `taskkill /PID <pid> /T /F` 作为固定平台 helper（参数不来自模型）。必须等待并确认根进程退出且无可枚举子进程；不能确认则 attempt failed。stdout/stderr 分别流式保留首 1048576 bytes，继续 drain 丢弃其余并标 truncated；按 UTF-8 replacement 解码并用当前 provider key、master-key marker、Authorization/bearer 和 app secret patterns 做 redaction，raw bytes/原始 env 永不持久化或发给模型。

### D-5: 外部 writer 条件下的 merge journal 与 manual recovery

- 方案 A: SQLite 事务中直接逐文件写 canonical。数据库能回滚，文件系统不能，崩溃会留下混合状态。
- 方案 B: 持久 merge journal + 每路径 old/post manifest + conditional replace/rollback/roll-forward。无检测到的外部writer时恢复全旧或全新；一旦identity/hash不匹配，不覆盖当前内容并转manual recovery。
- 选择: B，符合A-59。每项目只允许一个未解决journal并以`BEGIN IMMEDIATE`取得应用内commit lock；该锁不约束外部程序，因此设计不再宣称无条件原子。每个canonical path的冻结old/post manifest都含规范path、expected exists、ordinary-file identity、byte hash和整体manifest hash。

merge native 层必须把“准备 owned 文件”与“journal 后条件应用/恢复”拆开，不跨事务或进程持有原始 HANDLE。journal 只持久化可重开的 descriptor：

```ts
type VerifiedOwnedFileRef = {
  rootKind:"journal"|"canonical";
  relativePath:string[];
  ownerId:string;
  parentIdentity:string;
  fileIdentity:string;
  sha256:string;
  size:number;
};
type ExpectedCanonicalFile = {
  rootKind:"canonical";
  relativePath:string[];
  exists:boolean;
  parentIdentity:string;
  fileIdentity:string|null;
  sha256:string|null;
  size:number|null;
};
type NativeMutationResult<T> =
  | {kind:"succeeded";value:T}
  | {kind:"condition-mismatch";observed:{exists:boolean;parentIdentity:string;
      fileIdentity:string|null;sha256:string|null;size:number|null}}
  | {kind:"mutation-uncertain";phase:string};
```

固定生命周期 API：

- `prepareOwnedFile(rootKind,root,parentSegments,name,ownerId,bytes): NativeMutationResult<VerifiedOwnedFileRef>`: verified parent 下 relative exclusive create，完整 write+file/directory flush，返回 descriptor 前关闭全部 HANDLE。
- `reopenOwnedFile(roots,ref): NativeMutationResult<VerifiedOwnedFileRef>`: 从 `rootKind` 对应 verified root/parent handle-relative 重开并同时核对 owner、parent/file identity、hash、size、finalPath。
- `prepareCanonicalTempFromOwned(roots,sourceRef,targetParentSegments,tempName,ownerId): NativeMutationResult<VerifiedOwnedFileRef>`: 重开 journal owned source，在 canonical verified parent 创建同目录 temp并复制/flush，返回 `rootKind=canonical` descriptor；不改变目标。
- `conditionalReplacePrepared(roots,expectedTarget,preparedCanonicalTemp): NativeMutationResult<ExpectedCanonicalFile>`: `expectedTarget.relativePath` 唯一定位目标；rename 前重检 target/parent 与 temp，relative replace 后重开核对 post identity/hash/size 并 flush directory；post identity 必须等于 temp identity。
- `conditionalDelete(roots,expectedTarget): NativeMutationResult<{deleted:true}>`: 仅 parent+file identity+hash+size 全匹配时删除。
- `conditionalCleanupOwned(roots,ref): NativeMutationResult<{deleted:true}>`: 仅 owner+parent/file identity+hash+size 全匹配时删除；同字节不同 identity 保留为 `condition-mismatch`。

每个 API 内部唯一持有并关闭 HANDLE；write/flush/rename/delete/identity/finalPath/close 任一 native 不确定按 D-2 native failure matrix 返回 `mutation-uncertain`，不得按普通 I/O 自动覆盖/回滚。

modified apply=`old target + canonical temp(durable-new)`；modified rollback=`post target + canonical temp(backup)`；modified roll-forward=`old target + canonical temp(durable-new)`；added apply=`nonexistent target + canonical temp(durable-new)`；added rollback=`conditionalDelete(post target)`；所有 backup/durable-new/temp 收尾均用 `conditionalCleanupOwned`。

协议:

1. `merge_apply` action acquire事务重检execution/staged/context/policy/validation/approval/conflict，创建journal=`prepared`、old/post manifests及ordered file rows，receipt保持pending；app-owned backup/new/temp都命名含actionId并记录identity/hash。
2. 每次读取、backup、创建temp、replace、rollback、roll-forward和cleanup前后都通过canonical handle adapter核对父identity、目标存在性/identity/hash。平台只可改变“当前状态恰等于该步骤预期”的path：old→post apply；post→old rollback；old→post roll-forward。modified rollback绝不无条件restore backup；added rollback只在当前仍等于post时删除。
3. apply每路径：核对old；从durable-new写同目录owned temp并核对；replace前再次核对old；atomic replace；replace后核对post；再标file applied。任一步不匹配立即停止，不处理剩余path。
4. 所有path达到post后，在DB commit事务之前再次逐路径核对post和整体post manifest；事务取得project lock后再做一次完整post核对，随后同一事务插入task result、execution=merged并把journal置`db_committed`，但merge action保持running、receipt保持pending。所有execution/result/list read在发现该project未解决journal时必须先运行既有read barrier/helper，未恢复前不可观察私有merged/result。commit返回后立刻再次逐路径核对post和整体manifest；相符时第二事务把journal=`completed`、action succeeded、最后完成merge receipt并解除barrier。这些检查与DB commit间仍存在不可消除的外部race；post-commit检查检测到时立即执行步骤6。若进程恰在commit后/post-check前崩溃，既有 `recoverIncompleteMergeJournals` read barrier/helper只依据原journal、merge action与receipt做恢复，不创建新的public recover route、operation或action。
5. 崩溃恢复由既有read barrier/helper执行：DB尚未commit时逐路径conditional rollback post→old；已commit时逐路径conditional roll-forward old→post。每次写前后都核对。没有external writer时最终全old或全post；任一当前path既不等于该步骤允许的source manifest，或写后不等于target，立即进入步骤6。该内部恢复协议由既有T-22/T-39覆盖，T-45不修改其触发、幂等或reconcile语义。
6. 外部不匹配事务原子设置journal=`manual_recovery`、execution=`conflicted`,`manual_recovery_required=1`，保存current per-path/overall manifest和mismatch phase。若尚未DB commit则task result从未写；若在步骤4的私有commit后才检测，则同一补偿事务删除仅与该journal FK关联且从未越过read barrier的task result、清除merged_at，令merge action=`failed(code=MANUAL_RECOVERY_REQUIRED)`并最后完成原merge receipt为409。对外可观察的merged/任务结果提交次数仍为0。平台不再自动写canonical。普通advance/retry/control/merge/stop全部409 `MANUAL_RECOVERY_REQUIRED`，唯一公开写入口是既有 `/recovery/resolve` endpoint。
7. owner resolution均是独立operation + `manual_resolution` action，same id/hash幂等，different body冲突；acquire后再次读取全部path并要求exact overall/per-path manifest：
   - `recovered_old`: current必须等于old；journal=`resolved_old`，清除manual flag，execution保持conflicted但`recovery_resolution='recovered_old'`，之后只允许retry建立新attempt。
   - `recovered_new`: current必须等于post；同一DB事务写task result、execution=`merged`, `merged_at=DB clock`, `recovery_resolution='recovered_new'`、journal=`resolved_new`、完成receipt。
   - `abandon`: request带owner刚查看的current manifest hash；重新读取必须相同。canonical零写；只删除identity/hash仍等于journal记录的app-owned temp/backup，其他保留并返回`uncleanedOwnedPaths`；execution=`stopped`, `recovery_resolution='abandoned'`、journal=`abandoned`。
8. cleanup也只删除identity/hash仍等于owned manifest的temp/backup。clean failure不改resolution结果，后续只重试conditional cleanup。

生产合入不得复用 `advance`。本地单用户模型下，`POST /api/executions/:executionId/merge` route本身与现有execution mutation routes一样就是owner mutation边界，不新增credential/header/actor字段或不可构造的403分支。route通过 bounded JSON reader（沿用128KiB上限）和 strict schema 验证 `{operationId,expectedVersion,stagedHash}`并拒绝额外字段；无 execution/project 返回404，且route级body/not-found失败不创建operation。随后专用 `mergeExecution` service/orchestrator 规范化 request hash，取得project/workspace/journal roots与production verified adapter，调用既有 `executeMergePrepare`，成功时在同一次service调用继续 `executeMergeCommit`；UI 的 Merge 动作生成独立merge operation id并调用该route，不再调用 `advance`。`advance` 对 `staged` 继续固定409 `EXECUTION_STATE_CONFLICT`，不得为接通UI而放宽。

所有通过route验证的merge请求都以 `kind=merge` operation receipt为重放oracle。service先按 `(project_id,operation_id)` 查询：同request hash且completed直接返回原HTTP/body，不重检当前execution、不重复consume approval或写canonical；同hash且pending返回409 `OPERATION_IN_PROGRESS`；不同kind/hash返回409 `OPERATION_CONFLICT`且绝不改写原receipt。首次请求进入低层 `executeMergePrepare` 后，其 `assertCapability` 是无副作用、可安全重复且发生在operation/action acquire前的preflight；失败时低层契约仍是operation/action/journal=0，service catch后以短事务尝试插入 `has_external_actions=0,status=completed,http_status=422` 的拒绝receipt。same-operation并发可重复执行preflight，但receipt unique insert/CAS只有一个胜者；若另一请求在本次preflight期间先提交receipt，当前请求在insert失手、进入acquire前发现operation或收到低层operation冲突时都重读该receipt，只有same hash才逐字返回胜者结果。崩溃发生在receipt commit前没有DB或外部事实，replay重新preflight，commit后replay只读receipt。其他action acquire前的stagedHash/expectedVersion/context/validation/approval/path-conflict/manual-barrier拒绝沿用相同短事务receipt模式；取得 `merge_apply` lease后则只允许既有journal代码完成原pending receipt。`stagedHash`、expectedVersion、frozen context/policy、current validation、staged approval、path conflict、manual-recovery barrier、project唯一未解决journal、lease/overall deadline和全部FS identity/hash guard均保持原强度。

生产route/service的唯一出口如下；error body均为 `{error:{code,message}}`，completed receipt保存并逐字重放同一status/body：

| 出口 | operation/action/journal | execution/result/canonical | HTTP/code与后续 |
|---|---|---|---|
| 成功 | merge receipt=`completed(200)`；`merge_apply=succeeded`；journal=`completed`且lease清空 | execution=`merged`、唯一awaiting-review result可见；全部path=post overall manifest | 200 `{execution,result}`；same-operation replay仍200且canonical写次数不增加 |
| capability preflight失败 | service短事务唯一 `has_external_actions=0,completed(422)` receipt；低层及最终action=0、journal=0 | execution保持staged、result=0、canonical零写 | 422 `SANDBOX_UNVERIFIABLE`；same-operation并发/崩溃/replay按上段协议收口 |
| 普通pre-acquire冲突或guard拒绝 | `has_external_actions=0` completed receipt；action=0、journal=0 | `PATH_CONFLICT`/validation/approval/state失败保持原staged事实且canonical零写；frozen context变化沿既有规则唯一stale | 409 `EXECUTION_STATE_CONFLICT|STALE_EXECUTION|PATH_CONFLICT|APPROVAL_STATE_CONFLICT|MERGE_RECOVERY_REQUIRED|MANUAL_RECOVERY_REQUIRED`，或422 `STAGED_NOT_ELIGIBLE|VALIDATION_REQUIRED`；可用新operation在guard解决后重试 |
| external writer或native结果不确定 | 原receipt=`completed(409)`；`merge_apply=failed(error=MANUAL_RECOVERY_REQUIRED)`；journal=`manual_recovery` | execution=`conflicted,manual_recovery_required=1`，result=0，保存current manifests；检测后canonical自动写次数=0 | 409 `MANUAL_RECOVERY_REQUIRED`；只允许既有resolution route，普通merge/advance/retry/control均不可穿透 |
| same operation不同payload/kind | 不新增/不改operation、action、journal | execution/result/canonical不变 | 409 `OPERATION_CONFLICT`；必须换operation id |

HTTP映射保持唯一：400 `INVALID_JSON|INVALID_INPUT`；404 `PROJECT_NOT_FOUND|EXECUTION_NOT_FOUND`；409使用上表全部状态/幂等/manual-recovery code；422仅资格、验证或verified capability失败；500仅不变量/未知内部错误。route只把 typed `ExecutionError` 映射为上述响应，未知异常统一500 `INTERNAL_ERROR`并由service先终态化已取得的action/receipt；任何返回路径均不得留下无journal恢复依据的running action或pending receipt。T-45不新增automatic recover route、`kind=recover` receipt或`merge_recover` action，也不改变既有read barrier/helper的crash journal恢复；其唯一公开恢复延伸是同一merge调用内fault/external mismatch进入manual recovery后调用已有 `/recovery/resolve`。continue只适用于既有paused execution，merge失败重试必须在guard/barrier解决后使用新operation；manual recovery只经resolution，不得continue绕过。

明确fault/race窗口：old check前、backup read中、temp写中、replace前、replace后/file-row前、所有file后/final check前、final check/DB commit间、DB commit/receipt completion间、rollback/roll-forward每路径前后、resolution verify/DB commit间。每个窗口注入ordinary replace、delete、recreate-same-bytes-different-identity和link/reparse；检测后external content覆盖次数=0并进入manual recovery。只有没有检测到外部writer时才保证恢复全old或全post。

### D-6: stale 与 conflict

- 方案 A: 任意 workspace manifest 改变都 stale。简单但第一个 execution 合入不相交路径会无意义废弃第二个。
- 方案 B: 冻结业务 context 全量比对；workspace 只比对 execution 已读路径、staged 路径及这些路径的基线，另以 active staged path set 判同路径冲突。
- 选择: B。业务 context hash覆盖规格 FR-8 全部非凭据输入，任一变化在下一 action/stage/merge 置 `stale`。workspace:
  - read/write/staged 路径若 canonical 当前 hash与 baseline entry 不同（新增要求仍不存在）→ external change，`stale`。
  - 两 execution 的 staged 规范路径集合相交→两者 `conflicted`，即使内容相同；事务同时更新两者。
  - 不相交时先合入者只改变其路径，另一项的相关路径重检仍通过，继续可合入。
  - staged 前 sandbox 被命令或外部程序改变会使 sandbox manifest变化；旧 validation/staged hash失效，必须重新 stage。

### D-7: S-4/S-5 共享 Agent usage

- 方案 A: v5 把 S-4 model call 全量迁入新 ledger。查询统一，但会重写已交付审计事实并扩大迁移风险。
- 方案 B: S-4 表保持只读事实，S-5 调用写新表；共享 usage 以同一 `source_collaboration_run_id + agent_id` 的两个表做 `UNION ALL` 聚合。
- 选择: B。同 Agent partial unique active execution和 calling index消除两个 S-5 响应争抢；acquire 前与 finalize 后都在 `BEGIN IMMEDIATE` 内计算 S-4+S-5 可信 usage。retry/new attempt不重置；provider credential rotation不计 stale，非凭据 provider/Agent变化计 stale。

### D-8: receipt、lease 与恢复

- 方案 A: endpoint 各自实现幂等和超时。容易产生不同重放语义。
- 方案 B: 所有mutation使用`(project_id,operation_id)`parent receipt；外部工作是其按`action_index=0..n`连续排列的durable children，action反向FK operation。
- 选择: B。action kind固定为 `sandbox_build|model|file_list|file_read|file_write|command|stage_compute|merge_apply|merge_recover|manual_resolution`，status固定为 `pending|running|succeeded|failed|interrupted|discarded`。同operation和同execution都最多一个running child；前一child终态后才能创建/取得后一child。当前start只有一个sandbox child；model primary+可选repair选择“同一个model child、两条model_call”，避免把一次structured repair误算两个外部推进。schema仍支持其他operation顺序追加child，receipt只在最终outcome确定时完成。

统一顺序:

1. operation acquire `BEGIN IMMEDIATE`先reconcile expired actions，再读receipt。same id/kind/hash completed原样返回；same pending且有live child返回`OPERATION_IN_PROGRESS`；different返回`OPERATION_CONFLICT`。无外部动作的policy/control receipt可直接完成；有外部动作则同事务插parent operation、`action_index=0` pending child。
2. child acquire执行 `UPDATE execution_actions SET status='running',lease_token=?,lease_expires_at=min(?,overall_deadline_at),last_heartbeat_at=?,started_at=coalesce(started_at,?) WHERE project_id=? AND operation_id=? AND action_index=? AND status='pending' AND NOT EXISTS (SELECT 1 FROM execution_actions p WHERE p.project_id=? AND p.operation_id=? AND p.action_index<? AND p.status NOT IN ('succeeded','failed','interrupted','discarded')) AND NOT EXISTS (SELECT 1 FROM execution_actions r WHERE r.project_id=? AND r.operation_id=? AND r.status='running')`；expiry候选为DB now+120s，`changes===1`后提交才执行。
3. heartbeat每30秒用独立`BEGIN IMMEDIATE`执行 `UPDATE execution_actions SET lease_expires_at=min(?,overall_deadline_at),last_heartbeat_at=? WHERE project_id=? AND id=? AND status='running' AND lease_token=? AND lease_expires_at>? AND overall_deadline_at>?`，要求`changes===1`。120秒是失联检测lease；heartbeat永不改变fixed overall deadline。
   - FR-10 business clock：execution创建及sandbox期间`first_running_at/business_deadline_at`均NULL。首次queued→running事务以同一个DB clock原子写`first_running_at=now,business_deadline_at=now+900s`；若已非NULL则retry/continue只复用原值，永不重置/延长。model/file/stage/normal merge action deadline≤该business deadline。
   - sandbox clock：start事务用同一SQLite `now`写sandbox child `started_at`与`overall_deadline_at=strftime(...,'now','+900 seconds')`。900s复用A-52/A-55已批准的有界15分钟默认作为2GiB/100000项快照操作cap，不计入、也不提前启动FR-10 business wall clock，因此未引入新数字假设。它同样每30s heartbeat。
   - command deadline=`min(started_at+120s,business deadline)`；model action受business deadline，每个primary/repair call各有不可续`call_deadline_at=call_started_at+90s`。
4. 一个model action内先持久化call_index=1 primary并调用；仅primary结构无效时，在仍持有同action lease且execution/call deadline允许时插call_index=2 repair。两次之间继续heartbeat；repair有自己的90秒call deadline，但action/execution总deadline不延长。`UNIQUE(action_id,call_index)`防重复，usage逐call持久。
   - `calling` fact 一旦插入，provider 调用正常返回或抛出、response body/结构解析失败时都必须在同一业务操作内进入唯一终态并写 `finished_at`；不得让一个已 settle 的真实 HTTP 调用永久停在 `calling`。终态写入本身失败或进程在 HTTP settle 后、终态提交前退出时，由 action/lease reconcile 同步把所属 `calling` call 唯一转为 `interrupted` 并写 `finished_at`，不得补记成功 usage 或静默重放外部调用；owner 显式重试建立新 call。该约束须用两个不同 Agent 通过真实本地 OpenAI-compatible HTTP 并发推进，并在终态 UPDATE/事务提交前后注入故障、重开数据库验证，不能只依赖 mocked `fetch`。
5. child finalize执行token/lease/overall-deadline CAS为终态并清lease，`changes===1`后写child facts/events。若业务决定追加下一child，则同事务插`action_index=max+1` pending并增加operation.action_count，receipt仍pending；若本child就是最终outcome，则最后执行 `UPDATE execution_operations SET status='completed',final_action_index=?,http_status=?,response_json=?,updated_at=? WHERE project_id=? AND id=? AND status='pending' AND action_count=?`，要求`changes===1`。receipt完成时child indices必须连续0..final、最终child终态且没有pending/running child。D-5私有`db_committed`仍先受read barrier，post-check后才finalize child/receipt。
6. reconcile与heartbeat/finalize争同一SQLite writer锁。reconcile CAS条件是`status='running' AND (lease_expires_at<=DB now OR overall_deadline_at<=DB now)`并清lease；heartbeat/finalize要求两个deadline仍未来。三者只有一个`changes===1`：heartbeat先赢则reconcile随后条件不成立；reconcile先赢则heartbeat/finalize为0；finalize先赢则其余为0。reconcile只有在该child已是operation最终outcome时完成receipt；若协议允许后续恢复child，则插下一pending child且receipt保持pending。
7. sandbox lease失联或sandbox-operation 900s deadline：business clock仍NULL；若owned building tree可完整清理则execution保持queued后转`paused,resume_target=queued,reason=SANDBOX_BUILD_DEADLINE_EXCEEDED|SANDBOX_ACTION_INTERRUPTED`，若清理/完整性不能确认则`failed`。不得记录FR-10 `EXECUTION_TIME_LIMIT`。model/file action在business deadline/lease中断时running→paused；command达到120秒先终止tree；merge child中断保持barrier。duplicate start返回同parent receipt；start-resume新operation/attempt。late finalizer零写。
8. `discarded`只用于owner control、context/version失效等明确废弃：控制事务以token/version CAS running→discarded并清lease；若该child决定最终outcome则完成parent receipt，否则按协议追加恢复child。外部失败用failed，lease/overall失联用interrupted，三者不可互换。

## 3. 数据与状态

### 3.1 SQLite version 5

v4→v5 只在完整 v4 validator 通过后执行一个 `BEGIN IMMEDIATE`。DDL 使用下列精确对象（时间为 ISO-8601 TEXT，hash 为 lowercase 64-char SHA-256）：

```sql
CREATE TABLE project_validation_policies(
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  active_revision_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>=1),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),
  FOREIGN KEY(project_id,active_revision_id)
    REFERENCES project_validation_policy_revisions(project_id,id)
);
CREATE TABLE project_validation_policy_entries(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 49),
  executable TEXT NOT NULL CHECK(length(CAST(executable AS BLOB)) BETWEEN 1 AND 4096),
  executable_identity TEXT NOT NULL CHECK(length(executable_identity)=64 AND executable_identity NOT GLOB '*[^0-9a-f]*'),
  args_json TEXT NOT NULL CHECK(json_valid(args_json) AND length(CAST(args_json AS BLOB))<=32768),
  workdir TEXT NOT NULL CHECK(length(CAST(workdir AS BLOB)) BETWEEN 1 AND 4096),
  required INTEGER NOT NULL CHECK(required IN (0,1)),
  tuple_hash TEXT NOT NULL CHECK(length(tuple_hash)=64 AND tuple_hash NOT GLOB '*[^0-9a-f]*'),
  UNIQUE(project_id,revision_id,position),
  UNIQUE(project_id,revision_id,id),
  FOREIGN KEY(project_id,revision_id)
    REFERENCES project_validation_policy_revisions(project_id,id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX collaboration_runs_project_id_id
  ON collaboration_runs(project_id,id);
CREATE UNIQUE INDEX missions_project_id_id
  ON missions(project_id,id);
CREATE UNIQUE INDEX work_items_mission_id_id
  ON work_items(mission_id,id);

CREATE TABLE executions(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_collaboration_run_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  current_policy_revision_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN
    ('queued','running','waiting_approval','paused','staged','stale',
     'conflicted','failed','stopped','merged')),
  resume_target TEXT CHECK(resume_target IS NULL OR resume_target IN
    ('queued','running','waiting_approval')),
  reason_code TEXT,
  manual_recovery_required INTEGER NOT NULL DEFAULT 0 CHECK(manual_recovery_required IN (0,1)),
  recovery_resolution TEXT CHECK(recovery_resolution IS NULL OR recovery_resolution IN
    ('recovered_old','recovered_new','abandoned')),
  current_attempt_no INTEGER NOT NULL CHECK(current_attempt_no>=1),
  business_round_count INTEGER NOT NULL DEFAULT 0 CHECK(business_round_count>=0),
  tool_call_count INTEGER NOT NULL DEFAULT 0 CHECK(tool_call_count>=0),
  next_event_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_event_sequence>=1),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
  business_deadline_at TEXT CHECK(business_deadline_at IS NULL OR business_deadline_at GLOB '????-??-??T??:??:??.???Z'),
  first_running_at TEXT CHECK(first_running_at IS NULL OR first_running_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),
  merged_at TEXT CHECK(merged_at IS NULL OR merged_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE(project_id,id),
  UNIQUE(project_id,mission_id,work_item_id,id),
  FOREIGN KEY(project_id,source_collaboration_run_id)
    REFERENCES collaboration_runs(project_id,id),
  FOREIGN KEY(project_id,mission_id) REFERENCES missions(project_id,id),
  FOREIGN KEY(mission_id,work_item_id) REFERENCES work_items(mission_id,id),
  FOREIGN KEY(project_id,agent_id) REFERENCES project_memberships(project_id,agent_id),
  FOREIGN KEY(project_id,current_policy_revision_id)
    REFERENCES project_validation_policy_revisions(project_id,id),
  CHECK((manual_recovery_required=1 AND status='conflicted' AND recovery_resolution IS NULL)
     OR manual_recovery_required=0),
  CHECK((status='merged') = (merged_at IS NOT NULL)),
  CHECK((first_running_at IS NULL AND business_deadline_at IS NULL)
     OR (first_running_at IS NOT NULL AND business_deadline_at IS NOT NULL))
);
CREATE UNIQUE INDEX execution_one_active_task
  ON executions(work_item_id)
  WHERE status IN ('queued','running','waiting_approval','paused','staged');
CREATE UNIQUE INDEX execution_one_active_agent
  ON executions(agent_id)
  WHERE status IN ('queued','running','waiting_approval','paused','staged');
CREATE INDEX executions_project_status ON executions(project_id,status,created_at,id);

CREATE TABLE execution_attempts(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK(attempt_no>=1),
  status TEXT NOT NULL CHECK(status IN
    ('preparing','ready','acting','interrupted','failed','superseded','completed')),
  sandbox_root TEXT NOT NULL CHECK(length(CAST(sandbox_root AS BLOB)) BETWEEN 1 AND 32767),
  baseline_manifest_path TEXT,
  sandbox_manifest_path TEXT,
  baseline_manifest_hash TEXT CHECK(baseline_manifest_hash IS NULL OR
    (length(baseline_manifest_hash)=64 AND baseline_manifest_hash NOT GLOB '*[^0-9a-f]*')),
  sandbox_manifest_hash TEXT CHECK(sandbox_manifest_hash IS NULL OR
    (length(sandbox_manifest_hash)=64 AND sandbox_manifest_hash NOT GLOB '*[^0-9a-f]*')),
  frozen_public_json TEXT NOT NULL CHECK(json_valid(frozen_public_json) AND length(CAST(frozen_public_json AS BLOB))<=2097152),
  frozen_private_json TEXT NOT NULL CHECK(json_valid(frozen_private_json) AND length(CAST(frozen_private_json AS BLOB))<=2097152),
  frozen_context_hash TEXT NOT NULL CHECK(length(frozen_context_hash)=64 AND frozen_context_hash NOT GLOB '*[^0-9a-f]*'),
  frozen_policy_revision_id TEXT NOT NULL,
  frozen_policy_version INTEGER NOT NULL CHECK(frozen_policy_version>=1),
  frozen_policy_hash TEXT NOT NULL CHECK(length(frozen_policy_hash)=64 AND frozen_policy_hash NOT GLOB '*[^0-9a-f]*'),
  started_at TEXT NOT NULL CHECK(started_at GLOB '????-??-??T??:??:??.???Z'),
  finished_at TEXT CHECK(finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE(execution_id,attempt_no),
  UNIQUE(project_id,execution_id,id),
  FOREIGN KEY(project_id,execution_id) REFERENCES executions(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,frozen_policy_revision_id)
    REFERENCES project_validation_policy_revisions(project_id,id)
);
CREATE UNIQUE INDEX execution_one_acting_attempt
  ON execution_attempts(execution_id) WHERE status='acting';

CREATE TABLE execution_actions(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  action_index INTEGER NOT NULL CHECK(action_index BETWEEN 0 AND 15),
  kind TEXT NOT NULL CHECK(kind IN
    ('sandbox_build','model','file_list','file_read','file_write','command',
     'stage_compute','merge_apply','merge_recover','manual_resolution')),
  status TEXT NOT NULL CHECK(status IN
    ('pending','running','succeeded','failed','interrupted','discarded')),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  lease_token TEXT UNIQUE,
  lease_expires_at TEXT,
  overall_deadline_at TEXT NOT NULL CHECK(overall_deadline_at GLOB '????-??-??T??:??:??.???Z'),
  last_heartbeat_at TEXT,
  result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB))<=262144)),
  error_code TEXT,
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
  started_at TEXT CHECK(started_at IS NULL OR started_at GLOB '????-??-??T??:??:??.???Z'),
  finished_at TEXT CHECK(finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE(project_id,id),
  UNIQUE(project_id,execution_id,id),
  UNIQUE(project_id,execution_id,attempt_id,id),
  UNIQUE(project_id,operation_id,id),
  UNIQUE(project_id,operation_id,action_index),
  FOREIGN KEY(project_id,execution_id,attempt_id)
    REFERENCES execution_attempts(project_id,execution_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,operation_id,execution_id)
    REFERENCES execution_operations(project_id,id,execution_id) ON DELETE CASCADE,
  CHECK((status='running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
     OR (status<>'running' AND lease_token IS NULL AND lease_expires_at IS NULL)),
  CHECK(lease_expires_at IS NULL OR lease_expires_at GLOB '????-??-??T??:??:??.???Z'),
  CHECK(last_heartbeat_at IS NULL OR last_heartbeat_at GLOB '????-??-??T??:??:??.???Z')
);
CREATE INDEX execution_actions_execution_status
  ON execution_actions(execution_id,status,created_at,id);
CREATE INDEX execution_actions_expiry
  ON execution_actions(project_id,status,lease_expires_at,id);
CREATE UNIQUE INDEX execution_one_running_action
  ON execution_actions(execution_id) WHERE status='running';
CREATE UNIQUE INDEX execution_operation_one_running_action
  ON execution_actions(project_id,operation_id) WHERE status='running';

CREATE TABLE execution_operations(
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  execution_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN
    ('start','start_resume','advance','approve','reject','revoke','replace_request',
     'pause','continue','retry','stop','stage','merge','resolve_manual',
     'policy_update','recover')),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  has_external_actions INTEGER NOT NULL CHECK(has_external_actions IN (0,1)),
  action_count INTEGER NOT NULL DEFAULT 0 CHECK(action_count BETWEEN 0 AND 16),
  final_action_index INTEGER CHECK(final_action_index IS NULL OR final_action_index BETWEEN 0 AND 15),
  status TEXT NOT NULL CHECK(status IN ('pending','completed')),
  http_status INTEGER,
  response_json TEXT CHECK(response_json IS NULL OR (json_valid(response_json) AND length(CAST(response_json AS BLOB))<=262144)),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY(project_id,id),
  UNIQUE(project_id,id,execution_id),
  FOREIGN KEY(project_id,execution_id) REFERENCES executions(project_id,id) ON DELETE CASCADE,
  CHECK((status='pending' AND http_status IS NULL AND response_json IS NULL)
     OR (status='completed' AND http_status BETWEEN 100 AND 599 AND response_json IS NOT NULL)),
  CHECK((has_external_actions=0 AND action_count=0 AND final_action_index IS NULL)
     OR (has_external_actions=1 AND action_count>=1)),
  CHECK(status<>'completed' OR has_external_actions=0
     OR final_action_index=action_count-1)
);

CREATE TABLE project_validation_policy_revisions(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_operation_id TEXT,
  created_actor_type TEXT NOT NULL CHECK(created_actor_type IN ('system','owner')),
  revision_no INTEGER NOT NULL CHECK(revision_no>=1),
  policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64 AND policy_hash NOT GLOB '*[^0-9a-f]*'),
  classifier_version INTEGER NOT NULL CHECK(classifier_version>=1),
  warning_accepted INTEGER NOT NULL CHECK(warning_accepted IN (0,1)),
  canonical_bytes INTEGER NOT NULL CHECK(canonical_bytes BETWEEN 2 AND 65536),
  entry_count INTEGER NOT NULL CHECK(entry_count BETWEEN 0 AND 50),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE(project_id,id),
  UNIQUE(project_id,revision_no),
  UNIQUE(project_id,policy_hash,revision_no),
  FOREIGN KEY(project_id,created_operation_id)
    REFERENCES execution_operations(project_id,id),
  CHECK((created_actor_type='system' AND revision_no=1 AND created_operation_id IS NULL AND warning_accepted=0)
     OR (created_actor_type='owner' AND created_operation_id IS NOT NULL AND warning_accepted=1))
);
CREATE INDEX validation_policy_revisions_page
  ON project_validation_policy_revisions(project_id,revision_no,id);

CREATE TABLE project_validation_policy_audits(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=1),
  actor_type TEXT NOT NULL CHECK(actor_type='owner'),
  outcome TEXT NOT NULL CHECK(outcome IN ('saved','rejected')),
  before_revision_id TEXT NOT NULL,
  after_revision_id TEXT,
  before_policy_hash TEXT NOT NULL CHECK(length(before_policy_hash)=64 AND before_policy_hash NOT GLOB '*[^0-9a-f]*'),
  after_policy_hash TEXT CHECK(after_policy_hash IS NULL OR (length(after_policy_hash)=64 AND after_policy_hash NOT GLOB '*[^0-9a-f]*')),
  public_change_json TEXT NOT NULL CHECK(json_valid(public_change_json) AND length(CAST(public_change_json AS BLOB))<=65536),
  warning_accepted INTEGER NOT NULL CHECK(warning_accepted IN (0,1)),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE(project_id,sequence),
  FOREIGN KEY(project_id,operation_id) REFERENCES execution_operations(project_id,id),
  FOREIGN KEY(project_id,before_revision_id)
    REFERENCES project_validation_policy_revisions(project_id,id),
  FOREIGN KEY(project_id,after_revision_id)
    REFERENCES project_validation_policy_revisions(project_id,id),
  CHECK((outcome='saved' AND after_revision_id IS NOT NULL AND after_policy_hash IS NOT NULL AND warning_accepted=1)
     OR (outcome='rejected' AND after_policy_hash IS NULL AND after_revision_id IS NULL))
);
CREATE INDEX validation_policy_audits_page
  ON project_validation_policy_audits(project_id,sequence,id);
CREATE TRIGGER validation_policy_revision_no_update
BEFORE UPDATE ON project_validation_policy_revisions
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_REVISION'); END;
CREATE TRIGGER validation_policy_revision_no_delete
BEFORE DELETE ON project_validation_policy_revisions
WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_REVISION'); END;
CREATE TRIGGER validation_policy_entry_no_update
BEFORE UPDATE ON project_validation_policy_entries
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_ENTRY'); END;
CREATE TRIGGER validation_policy_entry_no_delete
BEFORE DELETE ON project_validation_policy_entries
WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_ENTRY'); END;
CREATE TRIGGER validation_policy_audit_no_update
BEFORE UPDATE ON project_validation_policy_audits
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_AUDIT'); END;
CREATE TRIGGER validation_policy_audit_no_delete
BEFORE DELETE ON project_validation_policy_audits
WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_AUDIT'); END;

CREATE TABLE execution_model_calls(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  business_round INTEGER NOT NULL CHECK(business_round>=1),
  kind TEXT NOT NULL CHECK(kind IN ('primary','repair')),
  call_index INTEGER NOT NULL CHECK(call_index IN (1,2)),
  status TEXT NOT NULL CHECK(status IN
    ('calling','succeeded','provider_failed','response_invalid','usage_invalid','interrupted','discarded')),
  prompt_hash TEXT NOT NULL CHECK(length(prompt_hash)=64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),
  prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens>=0),
  completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens>=0),
  total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens>=0),
  error_category TEXT,
  call_started_at TEXT NOT NULL CHECK(call_started_at GLOB '????-??-??T??:??:??.???Z'),
  call_deadline_at TEXT NOT NULL CHECK(call_deadline_at GLOB '????-??-??T??:??:??.???Z'),
  finished_at TEXT CHECK(finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE(action_id,call_index),
  UNIQUE(attempt_id,business_round,call_index),
  FOREIGN KEY(project_id,execution_id,attempt_id,action_id)
    REFERENCES execution_actions(project_id,execution_id,attempt_id,id) ON DELETE CASCADE,
  CHECK(total_tokens IS NULL OR total_tokens=prompt_tokens+completion_tokens),
  CHECK((status='calling' AND finished_at IS NULL)
     OR (status<>'calling' AND finished_at IS NOT NULL))
);
```

每 Agent 在途模型调用由 `executions` 的 active Agent unique、`execution_attempts` 的 acting unique和 acquire 事务共同保证；不在缺少 `agent_id` 的 model-call 表上建立伪约束。

```sql
CREATE TABLE execution_tool_calls(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  action_id TEXT UNIQUE,
  business_round INTEGER NOT NULL CHECK(business_round>=1),
  type TEXT NOT NULL CHECK(type IN ('list','read','write','command')),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK(status IN
    ('requested','waiting_approval','succeeded','rejected','failed','interrupted','discarded')),
  public_request_json TEXT NOT NULL CHECK(json_valid(public_request_json) AND length(CAST(public_request_json AS BLOB))<=131072),
  public_result_json TEXT CHECK(public_result_json IS NULL OR (json_valid(public_result_json) AND length(CAST(public_result_json AS BLOB))<=2097152)),
  before_sandbox_hash TEXT CHECK(before_sandbox_hash IS NULL OR
    (length(before_sandbox_hash)=64 AND before_sandbox_hash NOT GLOB '*[^0-9a-f]*')),
  after_sandbox_hash TEXT CHECK(after_sandbox_hash IS NULL OR
    (length(after_sandbox_hash)=64 AND after_sandbox_hash NOT GLOB '*[^0-9a-f]*')),
  started_at TEXT NOT NULL CHECK(started_at GLOB '????-??-??T??:??:??.???Z'),
  finished_at TEXT CHECK(finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE(attempt_id,business_round),
  UNIQUE(project_id,execution_id,attempt_id,id),
  FOREIGN KEY(project_id,execution_id,attempt_id)
    REFERENCES execution_attempts(project_id,execution_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,execution_id,attempt_id,action_id)
    REFERENCES execution_actions(project_id,execution_id,attempt_id,id),
  CHECK((type='command' AND action_id IS NULL) OR action_id IS NOT NULL)
);

CREATE TABLE execution_approvals(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  tool_call_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('command','staged_merge')),
  status TEXT NOT NULL CHECK(status IN
    ('pending','approved','consumed','rejected','revoked','replaced','expired')),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  staged_hash TEXT CHECK(staged_hash IS NULL OR (length(staged_hash)=64 AND staged_hash NOT GLOB '*[^0-9a-f]*')),
  public_request_json TEXT NOT NULL CHECK(json_valid(public_request_json) AND length(CAST(public_request_json AS BLOB))<=131072),
  decided_at TEXT CHECK(decided_at IS NULL OR decided_at GLOB '????-??-??T??:??:??.???Z'),
  consumed_at TEXT CHECK(consumed_at IS NULL OR consumed_at GLOB '????-??-??T??:??:??.???Z'),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
  FOREIGN KEY(project_id,execution_id,attempt_id)
    REFERENCES execution_attempts(project_id,execution_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,execution_id,attempt_id,tool_call_id)
    REFERENCES execution_tool_calls(project_id,execution_id,attempt_id,id),
  CHECK((kind='command')=(tool_call_id IS NOT NULL)),
  CHECK((kind='staged_merge')=(staged_hash IS NOT NULL))
);
CREATE UNIQUE INDEX execution_one_pending_approval
  ON execution_approvals(execution_id)
  WHERE status IN ('pending','approved');
CREATE INDEX execution_approvals_page
  ON execution_approvals(execution_id,created_at,id);

CREATE TABLE execution_validation_results(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  policy_revision_id TEXT NOT NULL,
  policy_entry_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL UNIQUE,
  sandbox_manifest_hash TEXT NOT NULL CHECK(length(sandbox_manifest_hash)=64 AND sandbox_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  required INTEGER NOT NULL CHECK(required IN (0,1)),
  exit_code INTEGER NOT NULL,
  succeeded INTEGER NOT NULL CHECK(succeeded IN (0,1)),
  stdout_bytes INTEGER NOT NULL CHECK(stdout_bytes BETWEEN 0 AND 1048576),
  stderr_bytes INTEGER NOT NULL CHECK(stderr_bytes BETWEEN 0 AND 1048576),
  stdout_sha256 TEXT NOT NULL CHECK(length(stdout_sha256)=64 AND stdout_sha256 NOT GLOB '*[^0-9a-f]*'),
  stderr_sha256 TEXT NOT NULL CHECK(length(stderr_sha256)=64 AND stderr_sha256 NOT GLOB '*[^0-9a-f]*'),
  stdout_truncated INTEGER NOT NULL CHECK(stdout_truncated IN (0,1)),
  stderr_truncated INTEGER NOT NULL CHECK(stderr_truncated IN (0,1)),
  finished_at TEXT NOT NULL CHECK(finished_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE(execution_id,policy_entry_id,sandbox_manifest_hash),
  FOREIGN KEY(project_id,execution_id,attempt_id)
    REFERENCES execution_attempts(project_id,execution_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,execution_id,attempt_id,tool_call_id)
    REFERENCES execution_tool_calls(project_id,execution_id,attempt_id,id),
  FOREIGN KEY(project_id,policy_revision_id,policy_entry_id)
    REFERENCES project_validation_policy_entries(project_id,revision_id,id)
);
CREATE INDEX execution_validations_page
  ON execution_validation_results(execution_id,finished_at,id);
CREATE TABLE execution_validation_output_chunks(
  validation_id TEXT NOT NULL REFERENCES execution_validation_results(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr')),
  chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 16),
  byte_offset INTEGER NOT NULL CHECK(byte_offset BETWEEN 0 AND 1048575),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 65536),
  text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))=byte_length),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(validation_id,stream,chunk_index),
  UNIQUE(validation_id,stream,byte_offset)
);

CREATE TABLE execution_staged_results(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  action_id TEXT NOT NULL UNIQUE,
  baseline_manifest_hash TEXT NOT NULL CHECK(length(baseline_manifest_hash)=64 AND baseline_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  sandbox_manifest_hash TEXT NOT NULL CHECK(length(sandbox_manifest_hash)=64 AND sandbox_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  context_hash TEXT NOT NULL CHECK(length(context_hash)=64 AND context_hash NOT GLOB '*[^0-9a-f]*'),
  policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64 AND policy_hash NOT GLOB '*[^0-9a-f]*'),
  staged_hash TEXT NOT NULL UNIQUE CHECK(length(staged_hash)=64 AND staged_hash NOT GLOB '*[^0-9a-f]*'),
  observed_path_count INTEGER NOT NULL CHECK(observed_path_count BETWEEN 1 AND 100000),
  observed_final_bytes INTEGER NOT NULL CHECK(observed_final_bytes BETWEEN 0 AND 9007199254740991),
  merge_file_count INTEGER NOT NULL CHECK(merge_file_count BETWEEN 0 AND 100),
  merge_final_bytes INTEGER NOT NULL CHECK(merge_final_bytes BETWEEN 0 AND 10485760),
  blocker_count INTEGER NOT NULL CHECK(blocker_count BETWEEN 0 AND 100000),
  classification TEXT NOT NULL CHECK(classification IN ('auto_eligible','approval_required','blocked')),
  block_reasons_json TEXT NOT NULL CHECK(json_valid(block_reasons_json) AND length(CAST(block_reasons_json AS BLOB))<=65536),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE(project_id,execution_id,id),
  UNIQUE(project_id,execution_id,attempt_id,id),
  FOREIGN KEY(project_id,execution_id,attempt_id,action_id)
    REFERENCES execution_actions(project_id,execution_id,attempt_id,id) ON DELETE CASCADE
);
CREATE TABLE execution_staged_observations(
  id TEXT PRIMARY KEY,
  staged_result_id TEXT NOT NULL REFERENCES execution_staged_results(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 99999),
  path TEXT NOT NULL CHECK(length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),
  path_key TEXT NOT NULL CHECK(length(CAST(path_key AS BLOB)) BETWEEN 1 AND 4096),
  kind TEXT NOT NULL CHECK(kind IN
    ('added','modified','deleted','renamed','binary','permission','special')),
  baseline_hash TEXT CHECK(baseline_hash IS NULL OR (length(baseline_hash)=64 AND baseline_hash NOT GLOB '*[^0-9a-f]*')),
  observed_hash TEXT CHECK(observed_hash IS NULL OR (length(observed_hash)=64 AND observed_hash NOT GLOB '*[^0-9a-f]*')),
  final_size INTEGER NOT NULL CHECK(final_size BETWEEN 0 AND 9007199254740991),
  diff_text TEXT CHECK(diff_text IS NULL OR length(CAST(diff_text AS BLOB))<=262144),
  diff_bytes INTEGER NOT NULL CHECK(diff_bytes BETWEEN 0 AND 262144),
  diff_truncated INTEGER NOT NULL CHECK(diff_truncated IN (0,1)),
  UNIQUE(staged_result_id,position),
  UNIQUE(staged_result_id,path_key),
  UNIQUE(staged_result_id,id),
  CHECK((diff_text IS NULL AND diff_bytes=0)
     OR (diff_text IS NOT NULL AND length(CAST(diff_text AS BLOB))=diff_bytes))
);
CREATE TABLE execution_staged_files(
  id TEXT PRIMARY KEY,
  staged_result_id TEXT NOT NULL REFERENCES execution_staged_results(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 99),
  path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('added','modified')),
  baseline_hash TEXT CHECK(baseline_hash IS NULL OR (length(baseline_hash)=64 AND baseline_hash NOT GLOB '*[^0-9a-f]*')),
  staged_hash TEXT NOT NULL CHECK(length(staged_hash)=64 AND staged_hash NOT GLOB '*[^0-9a-f]*'),
  size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 1048576),
  UNIQUE(staged_result_id,position),
  UNIQUE(staged_result_id,path_key),
  UNIQUE(staged_result_id,observation_id),
  FOREIGN KEY(staged_result_id,observation_id)
    REFERENCES execution_staged_observations(staged_result_id,id)
);
CREATE INDEX staged_files_path_key ON execution_staged_files(path_key,staged_result_id);
CREATE TABLE execution_staged_blockers(
  staged_result_id TEXT NOT NULL REFERENCES execution_staged_results(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 99999),
  path TEXT NOT NULL CHECK(length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),
  kind TEXT NOT NULL CHECK(kind IN
    ('deleted','renamed','binary','permission','special',
     'file_size_limit','file_count_limit','byte_limit')),
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json) AND length(CAST(detail_json AS BLOB))<=4096),
  PRIMARY KEY(staged_result_id,position),
  UNIQUE(staged_result_id,observation_id),
  FOREIGN KEY(staged_result_id,observation_id)
    REFERENCES execution_staged_observations(staged_result_id,id)
);
CREATE INDEX staged_observations_page
  ON execution_staged_observations(staged_result_id,position,id);
CREATE INDEX staged_blockers_page
  ON execution_staged_blockers(staged_result_id,position,observation_id);

CREATE TABLE execution_artifacts(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 255),
  path TEXT NOT NULL CHECK(length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),
  content_bytes INTEGER NOT NULL CHECK(content_bytes BETWEEN 0 AND 1048576),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
  FOREIGN KEY(project_id,execution_id,attempt_id)
    REFERENCES execution_attempts(project_id,execution_id,id) ON DELETE CASCADE
);
CREATE INDEX execution_artifacts_page
  ON execution_artifacts(execution_id,created_at,id);
CREATE TABLE execution_artifact_chunks(
  artifact_id TEXT NOT NULL REFERENCES execution_artifacts(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 16),
  byte_offset INTEGER NOT NULL CHECK(byte_offset BETWEEN 0 AND 1048575),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 65536),
  text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))=byte_length),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(artifact_id,chunk_index),
  UNIQUE(artifact_id,byte_offset)
);

CREATE TABLE execution_events(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=1),
  attempt_no INTEGER NOT NULL CHECK(attempt_no>=1),
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('owner','agent','system')),
  actor_id TEXT,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=65536),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE(execution_id,sequence),
  FOREIGN KEY(project_id,execution_id) REFERENCES executions(project_id,id) ON DELETE CASCADE
);

CREATE TABLE execution_merge_journals(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  staged_result_id TEXT NOT NULL UNIQUE,
  merge_action_id TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN
    ('prepared','applying','db_committed','rolling_back','rolling_forward',
     'manual_recovery','completed','resolved_old','resolved_new','abandoned')),
  next_file_position INTEGER NOT NULL DEFAULT 0 CHECK(next_file_position>=0),
  old_manifest_hash TEXT NOT NULL CHECK(length(old_manifest_hash)=64 AND old_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  post_manifest_hash TEXT NOT NULL CHECK(length(post_manifest_hash)=64 AND post_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  observed_manifest_hash TEXT CHECK(observed_manifest_hash IS NULL OR
    (length(observed_manifest_hash)=64 AND observed_manifest_hash NOT GLOB '*[^0-9a-f]*')),
  mismatch_phase TEXT,
  mismatch_path_key TEXT,
  journal_root TEXT NOT NULL CHECK(length(CAST(journal_root AS BLOB)) BETWEEN 1 AND 32767),
  error_code TEXT,
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE(project_id,id),
  FOREIGN KEY(project_id,execution_id,attempt_id,staged_result_id)
    REFERENCES execution_staged_results(project_id,execution_id,attempt_id,id),
  FOREIGN KEY(project_id,execution_id,attempt_id,merge_action_id)
    REFERENCES execution_actions(project_id,execution_id,attempt_id,id),
  FOREIGN KEY(project_id,operation_id)
    REFERENCES execution_operations(project_id,id),
  FOREIGN KEY(project_id,operation_id,merge_action_id)
    REFERENCES execution_actions(project_id,operation_id,id),
  CHECK(status<>'manual_recovery' OR observed_manifest_hash IS NOT NULL)
);
CREATE UNIQUE INDEX execution_one_project_merge
  ON execution_merge_journals(project_id)
  WHERE status IN ('prepared','applying','db_committed','rolling_back',
                   'rolling_forward','manual_recovery');
CREATE TABLE execution_merge_files(
  journal_id TEXT NOT NULL REFERENCES execution_merge_journals(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position>=0),
  path TEXT NOT NULL CHECK(length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),
  path_key TEXT NOT NULL CHECK(length(CAST(path_key AS BLOB)) BETWEEN 1 AND 4096),
  old_target_ref_json TEXT NOT NULL CHECK(json_valid(old_target_ref_json)
    AND length(CAST(old_target_ref_json AS BLOB))<=16384),
  post_target_ref_json TEXT CHECK(post_target_ref_json IS NULL OR
    (json_valid(post_target_ref_json) AND length(CAST(post_target_ref_json AS BLOB))<=16384)),
  backup_ref_json TEXT CHECK(backup_ref_json IS NULL OR
    (json_valid(backup_ref_json) AND length(CAST(backup_ref_json AS BLOB))<=16384)),
  durable_new_ref_json TEXT NOT NULL CHECK(json_valid(durable_new_ref_json)
    AND length(CAST(durable_new_ref_json AS BLOB))<=16384),
  canonical_temp_locator_json TEXT NOT NULL CHECK(json_valid(canonical_temp_locator_json)
    AND length(CAST(canonical_temp_locator_json AS BLOB))<=8192),
  canonical_temp_ref_json TEXT CHECK(canonical_temp_ref_json IS NULL OR
    (json_valid(canonical_temp_ref_json) AND length(CAST(canonical_temp_ref_json AS BLOB))<=16384)),
  status TEXT NOT NULL CHECK(status IN
    ('pending','temp_ready','applied','rolled_back','rolled_forward','verified')),
  PRIMARY KEY(journal_id,position),
  UNIQUE(journal_id,path_key),
  CHECK((status='pending' AND canonical_temp_ref_json IS NULL AND post_target_ref_json IS NULL)
     OR (status<>'pending' AND canonical_temp_ref_json IS NOT NULL AND post_target_ref_json IS NOT NULL))
);

`old_target_ref_json` / `post_target_ref_json` 写 strict `ExpectedCanonicalFile`；`backup_ref_json` / `durable_new_ref_json` / `canonical_temp_ref_json` 写 strict `VerifiedOwnedFileRef`；`canonical_temp_locator_json` 只含 `{rootKind:"canonical",relativePath,ownerId}`。所有 relativePath 为 validated NFC segments，ownerId 固定 merge action id。modified 在 journal 创建前于 journal root 准备 backup+durable-new，added 只有 durable-new；随后一次事务创建 journal/file rows并持久化 refs 与 deterministic canonical temp locator。

apply 时先 `prepareCanonicalTempFromOwned`；成功后在目标仍未改变时用独立事务写 `canonical_temp_ref_json`、由该 ref identity/hash/size 生成 `post_target_ref_json` 并置 `temp_ready`，再执行 conditional replace。进程若在 temp 创建后、ref 事务前退出，目标仍为 old；该未登记 temp 不因名字猜测 ownership，恢复完成 rollback 后把 locator 计入 uncleaned orphan。进程在 ref 已持久化后退出，recovery 只凭 DB refs + `journal_root` + canonical root 即可 reopen 并 rollback/roll-forward。`post_target_ref` 的 file identity 来自 canonical temp，relative rename 后必须保持同一 identity。

CREATE TABLE work_item_execution_results(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  execution_id TEXT NOT NULL UNIQUE,
  staged_result_id TEXT NOT NULL UNIQUE,
  merge_journal_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status='awaiting_review'),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
  FOREIGN KEY(project_id,mission_id,work_item_id,execution_id)
    REFERENCES executions(project_id,mission_id,work_item_id,id),
  FOREIGN KEY(project_id,execution_id,staged_result_id)
    REFERENCES execution_staged_results(project_id,execution_id,id),
  FOREIGN KEY(project_id,merge_journal_id)
    REFERENCES execution_merge_journals(project_id,id)
);
CREATE INDEX work_item_execution_results_item
  ON work_item_execution_results(work_item_id,created_at,id);
```

以上对象、列顺序、类型、NULL、PK、FK/on-delete、CHECK、UNIQUE、named partial index 和普通查询 index均须精确匹配。`args_json/frozen_*_json/public_*_json/block_reasons_json/detail_json/payload_json` 写入前由对应 strict Zod schema生成，读取时再次 parse；不能将任意对象直接 stringify。

strict migration validator:

1. v4 打开先完整验证 v1-v4 所有既有表、列、默认值、PK/FK、CHECK、unique/index/partial predicate；失败 `SCHEMA_DRIFT`，不写 DDL/version。
2. 一个`BEGIN IMMEDIATE`创建全部v5对象。每个既有project先插system empty revision(no=1, entries=0, warning=0)，再插active policy pointer(version=1)；新project创建事务同样执行。随后完整schema/data validator，最后`user_version=5`；任一点rollback不留对象/row/version。
3. v5新增table全集（23）恰为：`project_validation_policies`,`project_validation_policy_entries`,`executions`,`execution_attempts`,`execution_actions`,`execution_operations`,`project_validation_policy_revisions`,`project_validation_policy_audits`,`execution_model_calls`,`execution_tool_calls`,`execution_approvals`,`execution_validation_results`,`execution_validation_output_chunks`,`execution_staged_results`,`execution_staged_observations`,`execution_staged_files`,`execution_staged_blockers`,`execution_artifacts`,`execution_artifact_chunks`,`execution_events`,`execution_merge_journals`,`execution_merge_files`,`work_item_execution_results`。
4. 新增index全集（22）恰为：`collaboration_runs_project_id_id`,`missions_project_id_id`,`work_items_mission_id_id`,`execution_one_active_task`,`execution_one_active_agent`,`executions_project_status`,`execution_one_acting_attempt`,`execution_actions_execution_status`,`execution_actions_expiry`,`execution_one_running_action`,`execution_operation_one_running_action`,`validation_policy_revisions_page`,`validation_policy_audits_page`,`execution_one_pending_approval`,`execution_approvals_page`,`execution_validations_page`,`staged_files_path_key`,`staged_observations_page`,`staged_blockers_page`,`execution_artifacts_page`,`execution_one_project_merge`,`work_item_execution_results_item`。trigger全集（6）恰为三个policy immutable对象各自no-update/no-delete trigger。
5. 每次open验证exact ordered columns/type/null/default、PK、单列/复合FK/on-delete、CHECK、UNIQUE、index order/predicate和trigger normalized SQL；执行`foreign_key_check`，有row即`SCHEMA_DRIFT`，不补建。
6. 数据validator验证：policy pointer.version=active revision_no，revision entry_count/bytes/policy_hash与immutable entries重算值相等，revision/audit sequence连续；execution.current_policy_revision=当前attempt frozen revision，validation引用该attempt frozen revision/entry；operation child indices连续0..action_count-1、parent/execution一致、最多一running、completed final index正确；`first_running_at/business_deadline_at`同时NULL或同时非NULL，非NULL时差恰900s且历史attempt/retry中不回退/改变；`sandbox_build` child overall=start DB clock+900s且不引用business deadline；lease≤action overall、heartbeat单调；command≤start+120s、model call=start+90s；terminal child无lease、late无success fact；validation/artifact chunks index 0..16连续、scalar边界合法、每块≤65536且总计≤1048576，拼接bytes/sha等于header、空body零chunk；staged observations/counts和manual/journal barrier invariants保持。任何违反`SCHEMA_DATA_INVALID`。
7. 测试覆盖每个table/index/trigger/FK/CHECK漂移；policy retention；首次running DB clock、sandbox 899/900/901s与business clock仍NULL、retry不延15m；heartbeat/reconcile/finalize竞态；chunk 0/16/17、缺口/重排/hash及最坏三字节UTF-8 scalar；0/100/101/100000 observations；migration rollback/重开/future version。

### 3.2 Execution/attempt 状态

active只含`queued|running|waiting_approval|paused|staged`。服务层SQL总带`WHERE id=? AND version=? AND status IN (...)`并断言changes=1。`stale|failed|ordinary conflicted(manual_recovery_required=0)`可retry；`manual_recovery_required=1`时所有普通transition（含retry/pause/continue/stop/merge/recover）均拒绝，只有D-5 exact resolution。公开`stopped|merged`永不可变。

首次business acquire执行 `UPDATE executions SET status='running',first_running_at=coalesce(first_running_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),business_deadline_at=coalesce(business_deadline_at,strftime('%Y-%m-%dT%H:%M:%fZ','now','+900 seconds')),version=version+1 WHERE id=? AND version=? AND status='queued' AND ((first_running_at IS NULL AND business_deadline_at IS NULL) OR (first_running_at IS NOT NULL AND business_deadline_at IS NOT NULL))`；SQLite同一step的`now`固定，故首次两字段恰差900s。retry后的queued由coalesce保留原值；若DB now≥旧deadline则不创建model child并以`EXECUTION_TIME_LIMIT`暂停。

`execution_merge_journals.status='db_committed'`是project read barrier后的私有恢复态，不是一条公开execution transition：同事务可暂存execution/result行用于崩溃判向，但任何list/detail/result query先见barrier并不得返回它。post-commit mismatch的补偿只在barrier内删除未公开result并把行改为conflicted/manual；不存在客户端先观察merged再倒退。只有journal completed/resolved_new解除barrier后，public merged才成为终态。

attempt 只描述一次隔离与自治历史：`preparing→ready→acting↔ready→completed`；任一在途 lease失败为 `interrupted`，sandbox不确定为 `failed`，retry 后旧 attempt=`superseded`。公开 execution 状态是 owner UI 唯一状态；attempt 状态只用于恢复和审计。

| 当前 execution | 唯一允许的下一状态/触发 |
|---|---|
| queued | queued（sandbox_build完成，attempt preparing→ready；或SANDBOX_RESUME_REQUIRED时start-resume建新attempt/action）；running（ready后advance首次设置/后续保留business clock）；paused(resume=queued，owner pause或sandbox action中断/独立sandbox deadline)；stopped(owner stop) |
| running | waiting_approval(command request)；paused(resume=running，owner/guard/interrupted)；staged(stage成功)；stale；conflicted；failed；stopped |
| waiting_approval | running(批准被下一advance消费)；paused(resume=waiting_approval，owner pause)；paused(resume=running，reject/revoke/replace)；stale；failed；stopped |
| paused | 记录的 queued/running/waiting_approval(owner continue且前置满足)；queued(owner retry并创建新 attempt，仅 interrupted/failed前置类别)；failed；stopped |
| staged | merged；stale；conflicted；failed；stopped |
| stale/failed/ordinary conflicted | queued(owner retry，新attempt、新sandbox、新冻结输入)；stopped |
| conflicted + manualRecoveryRequired | recovered_old后仍conflicted但可retry；recovered_new→merged；abandoned→stopped；除此无transition |
| stopped/merged | 无，所有 mutation 409或幂等返回既有 receipt |

start body只有一个`workItemId`。UI双选时按选择顺序创建两个独立operationId并最多并发两次；每次只返回自己的`{execution}`或`TaskRejection`。两项直接/间接相关时服务端active/task/DAG事务使至多一项成功，另一项独立409；没有部分成功数组或共享receipt。

### 3.3 事务/CAS 矩阵

| 操作 | `BEGIN IMMEDIATE` 内检查/写入 | 事务外动作 | finalize CAS / 失败结果 |
|---|---|---|---|
| start one | parent receipt→sandbox child0；建execution queued且business clock NULL；sandbox overall=DB now+900s | verified-handle snapshot+30s heartbeat | 成功attempt ready仍queued/clock仍NULL；sandbox cap或lease失败paused/failed且非FR-10 reason |
| acquire advance | recover；queued→running CAS首次写DB now/now+900或保留旧值；未超business deadline才建model child | provider primary+可选repair；30s heartbeat；每call90s | child overall≤business deadline；retry不延clock；`UNIQUE(action,call_index)` |
| file tool | acting attempt；权限、count<40；parent receipt→对应file child0 | verified-handle path guard+单动作；必要时heartbeat | child token/context/deadline；写tool result、count+1、attempt ready，最后receipt |
| command request | request前复用既有 stale/context检查；`requestExecutionCommand` 的短 `BEGIN IMMEDIATE` 重读current execution/attempt/version/status及缓存`attempt.sandbox_manifest_hash`；one-shot同一事务插completed advance receipt、tool/approval/事件并CAS waiting，二者input/before hash均取该manifest | one-shot无事务外动作、无request action/lease/FS refresh；standing exact仍按既有路径建立command child并process | CAS/attempt/hash或operation并发失手整笔rollback，tool/approval/event=0；same operation replay唯一completed receipt，崩溃只可能事务前无事实或commit后完整事实 |
| approval consume | receipt；owner；status approved；全部hash/execution/attempt相同；approved→consumed；建立command action并CAS running | 随后启动一次命令 | 旧/重复消费changes=0，返回原receipt/409 |
| stage | running；无pending/running child；context；权限/必需验证；parent receipt→stage child0 | sandbox manifest/全量observation/diff；30s heartbeat | token重检hash/version；插observations/blockers/eligible rows、status staged，最后receipt |
| conflict | 两 staged path集合相交 | 无 | 同一事务双方 conflicted、审批失效、事件各一 |
| control | receipt；owner；expectedVersion；transition table；epoch由 version体现 | running process请求终止 | late result CAS=0；原状态/usage审计保留 |
| merge prepare | parent receipt→merge child0；status staged；hash/验证/approval/conflict；project merge unique | backup/temp/conditional apply+30s heartbeat | child token/overall deadline；journal与private commit见D-5 |
| recover | barrier识别journal；先reconcileexpired merge child/parent；新parent→recover child0 | conditional rollback/roll-forward+heartbeat | live lease in-progress；mismatch转manual |
| manual resolution | parent receipt→resolution child0；owner/version/observed hash | exact whole-manifest verify+heartbeat；仅abandon cleanup | resolution CAS；final child后receipt |

## 4. 文件、路径与 TOCTOU

所有 API/模型 path 都先做纯词法校验，再访问 sandbox。规则:

- 非空、NUL-free、UTF-8 string；统一 `\` 为 `/` 仅用于检测，输入含反斜杠在 POSIX按普通字符仍拒绝，避免跨平台歧义。
- 必须相对；拒绝 `/` 开头、`\\server`/UNC、`X:` drive、`\\?\`/`\\.\`、ADS `:`、空段、`.`/`..` 段。
- 每段 NFC 后 1..255 UTF-8 bytes，全路径≤4096 bytes；拒绝控制字符 U+0000–001F/U+007F。
- Windows 大小写不敏感拒绝 `CON/PRN/AUX/NUL/CLOCK$/COM1..9/LPT1..9`，含扩展名/尾随点空格也拒绝；path key为 Unicode simple case-fold后的 `/` 路径。POSIX key为 NFC原值。
- 列举/读取/写入必须复用D-2的`SandboxFsAdapter` verified directory/file handle链，任何link/reparse/special拒绝；`finalPath(handle)`必须仍在sandbox root且identity与父handle列举项一致。不得退回“字符串lstat后再按path打开”。

TOCTOU:

1. 从已验证sandbox root directory handle逐段`openChildDirectoryNoFollow`；每一步比较父list entry identity、child identity/attributes/finalPath，并保留祖先handle至动作结束。不一致失败。
2. Windows x64 adapter 使用上表 root `CreateFileW` 与 child/file `NtCreateFile(RootDirectory=parent)` 链，并直接从 handle 取 attributes/file id/final path；任一 primitive/identity 不可用即 `SANDBOX_UNVERIFIABLE`。其他 OS/arch/fs 在 capability check 失败关闭；符合 A-53 且不宣称 hostile OS sandbox。
3. read从verified file handle读取，前后比较identity/attributes/size和全部祖先directory identity，读取bytes/size/hash一致才返回。
4. write只从verified parent handle在该目录创建随机owned temp `wx`，写/fsync/hash；replace前再次验证parent、target expected identity/hash，atomic rename；之后重开核验post identity/hash并再次验证parent。任何race失败，且只conditional删除identity/hash仍等于owned temp的对象。
5. list只从directory handle列举，逐项用no-follow handle确认type/identity；结束时重验directory/祖先identity。稳定按UTF-8 name bytes排序，最多1000并给`truncated/totalObserved`，不读取第1001项正文。
6. canonical merge使用同一adapter和D-5更严格的每步pre/post及overall检查；检测race转manual recovery，不作hostile sandbox承诺。

read 仅普通文件、0..1048576 bytes、strict UTF-8（允许并剥离 BOM）、无 NUL；返回文本和原始 bytes hash。write content 经 JS string→UTF-8严格编码，≤1048576、无 NUL；`expectedHash` 为现有 hash或新增时 null，失配 `SANDBOX_FILE_CONFLICT`。

read 文本在进入模型/tool-result/公开 DTO 前还要用调用时内存中的当前 provider key、master-key marker、Authorization/bearer 模式和固定 app credential patterns 做语义占位替换；原始 bytes 只用于 hash 且不入 DB/日志。若发生替换，结果带 `redacted:true`，模型不得用该内容作 expected full-file replacement，避免把占位符写回。

## 5. Prompt、命令与审批流程

### 5.1 Frozen input

start 在同一 SQLite read transaction生成:

- public: task/直接及传递依赖、mission、active memories、roster、当前 Agent公开身份、provider identity/endpoint/model非凭据配置、权限、验证政策、canonical baseline manifest hash和版本。
- private server-only: 当前 Agent role/system prompt、按位置技能 id/version/name/instructions。
- fingerprints: 每类独立 hash及总 `frozen_context_hash`；owner DTO只返回类别版本/hash，不返回 private正文或 endpoint绝对值。

每次 action/stage/merge重算当前非凭据 facts。凭据只轮换 generation时不 stale；开始调用使用当时解密 key，后续调用取新 verified key。其余字段变化 stale，并 expire pending/approved approval。

### 5.2 Approval lifecycle

command request 的两个 hash 职责固定分离：

- `request_hash` 只对既有规范命令请求契约做 canonical hash（保留 exact executable identity/args/workdir 及既有 classifier/context/attempt 绑定字段）；明确排除 `inputHash`/sandbox manifest hash。manifest变化由独立 input snapshot 判定，不能被伪装成“另一条命令”。
- `approval.input_hash` 与 `tool.before_sandbox_hash` 是同一 current attempt 的缓存 sandbox 快照。该缓存只由先前受 action lease 保护的 write/command finalize 更新；one-shot request phase 不新增 action/lease，也不访问文件系统或做 verified refresh。
- 进入 `requestExecutionCommand` 前保留现有 frozen stale/context检查。其单个短 `BEGIN IMMEDIATE` 事务重读 current execution/attempt、version/status 与 `attempt.sandbox_manifest_hash`，要求传入 execution/attempt identity和expectedVersion仍匹配；直接把事务内读到的同一 manifest值写入 approval/tool，不接受调用方另算的 input hash。
- one-shot 的 completed advance receipt、tool、approval、两个事件、execution=`waiting_approval`/version/tool count 在同一事务全有或全无；插入值必须满足 `approval.input_hash = tool.before_sandbox_hash = current attempt.sandbox_manifest_hash`。version/status/current-attempt/manifest CAS或operation并发失手时整笔回滚，tool/approval/event/可批准DTO=0。
- 该短事务没有 heartbeat、deadline 或 reconcile：崩溃发生在事务/commit前则SQLite回滚且无事实，commit成功后则completed receipt与全部waiting facts均完整可重读，不存在 running action 或 pending receipt。
- standing policy exact match不走上述waiting approval分支，继续按既有路径创建真实 command action并执行；不新增request-phase approval/action，既有 exact tuple授权与执行语义不变。
- same operation+same body只重放唯一completed request receipt，不重复insert；same operation different body、旧 request hash 或把旧 input hash 带到新 attempt均返回409 conflict/stale，不能命中或改写既有 approval/tool。

1. command 非 absolute-deny、非 frozen exact policy时，按上述原子快照创建 tool call pending + approval pending，execution=`waiting_approval`。
2. `approve` 绑定 execution/attempt/tool call、canonical request hash、当前 sandbox manifest/input hash；状态 approved，但不在批准 HTTP请求内启动命令。
3. 下一 `advance` 在事务内原子 `approved→consumed`、execution→running并建立唯一 pending command action/parent receipt。消费时必须令 `approval.input_hash = tool.before_sandbox_hash = attempt.sandbox_manifest_hash`；action 只直接持有与 approval/tool 相同的 `request_hash`，并由 `tool.action_id`、三表 `(project_id,execution_id,attempt_id)` 复合身份和 action 的 operation/action-index 间接绑定到该 input hash。事务提交后只有取得该 action lease 的 CAS 胜者可启动命令；不新增或改动 v5 DDL。
4. reject/revoke/replace 分别置 approval终态，execution→paused，`resume_target=running`和对应 reason；continue 后下一模型回合收到 typed rejection。replace 只废弃旧请求，不允许 owner改参数。
5. execution stale/conflict/retry/stop、attempt变化、任一 tuple/hash变化全部 expire；consumed不能撤销，只能 pause/stop请求终止进程。
6. 无 required validation 的 staged merge approval同理绑定 staged hash，消费发生在 merge prepare事务；它不放宽任何 guard。

一次性命令的执行授权不是“存在一条 consumed approval”，而是消费事务建立的完整因果链。`process-runner` 在 spawn 前从当前 leased command action 反查 `tool.action_id=action.id` 的唯一 command tool，再反查 `approval.tool_call_id=tool.id` 的唯一 approval，并同时证明：

- approval=`consumed`，approval/tool/action 的 `(project_id,execution_id,attempt_id)` 完全相等，且都指向当前 execution/current attempt；
- `approval.request_hash = tool.request_hash = action.request_hash`；
- `approval.input_hash = tool.before_sandbox_hash = consume 时及执行前重读的 attempt.sandbox_manifest_hash`；
- action 的 `operation_id/action_index/status='running'/lease_token/lease expiry/overall deadline` 仍是当前 CAS 胜者，execution=`running`，attempt=`ready|acting`。

只有这组真实 v5 列上的精确绑定事实可放行 `authorizationSource='one_shot'`。`pending`、尚未消费的 `approved`、`expired/rejected/revoked/replaced`、来自旧 attempt/action/operation 的 consumed、同 hash 但不同 tool call，以及 `approval.input_hash`、`tool.before_sandbox_hash`、`tool.action_id`、action 的复合 identity/request_hash/operation_id/action_index/lease 任一篡改或 replay，spawn 次数均为 0。standing policy 继续只凭冻结 policy revision 的 exact executable identity/args/workdir 匹配，不要求或借用 approval 行；存在 command approval 反而是 authorization source 冲突。

consume 提交后，command action 的所有同步/异步出口由统一 terminalizer 收口。`manifest` 列中的 `pre`/`post` 指 attempt 的持久 `sandbox_manifest_hash`；`validation=matching` 仅指 frozen standing-policy entry exact match 时写一条绑定 postHash 的结果，one-shot 不凭 approval 伪造 validation。唯一持久矩阵如下，未列组合禁止出现：

| 出口 | command action；advance receipt | execution（resume/reason）；owner 后续 | attempt；tool | manifest；validation |
|---|---|---|---|---|
| success（exit=0） | `succeeded(null)`；completed 200、无 error code | `running`（null/null）；自动进入下一模型动作 | `ready`；`succeeded` | pre-refresh 相等且 pointer→postHash；matching validation=`succeeded=1` |
| nonzero exit | `failed(null)`；completed 200、无 error code | `running`（null/null）；自动进入下一模型动作 | `ready`；`failed`，保留 exit/output | pointer→postHash；matching validation=`succeeded=0` |
| 120s process timeout，进程树已确认终止且 process finalizer 先赢 | `failed(null)`；completed 200、无 error code | `running`（null/null）；自动进入下一模型动作 | `ready`；`failed`，保留 `timed_out` 结果 | pointer→postHash；validation=0 |
| spawn 同步/异步异常，确认进程从未启动 | `failed(COMMAND_PROCESS_FAILED)`；completed 500 `COMMAND_PROCESS_FAILED` | `paused`（resume=`running`, reason=`COMMAND_PROCESS_FAILED`）；continue | `ready`；`failed` | pointer 保持 preHash；validation=0 |
| run/stream/adapter 异常，进程树已确认终止且 post-refresh 成功 | `failed(COMMAND_PROCESS_FAILED)`；completed 500 `COMMAND_PROCESS_FAILED` | `paused`（resume=`running`, reason=`COMMAND_PROCESS_FAILED`）；continue | `ready`；`failed`，只持久脱敏有界摘要 | pointer→postHash；validation=0 |
| 任一终止请求无法确认进程树已退出 | `failed(PROCESS_TERMINATION_UNCONFIRMED)`；completed 503 `PROCESS_TERMINATION_UNCONFIRMED` | `failed`（resume=null, reason=`PROCESS_TERMINATION_UNCONFIRMED`）；retry 新 attempt | `failed`；`interrupted` | pointer 保持 preHash且旧 attempt 永不可 stage；validation=0 |
| pre-manifest refresh/parse/identity 失败或与 consumed input hash 不等 | `failed(SANDBOX_UNVERIFIABLE)`；completed 422 `SANDBOX_UNVERIFIABLE` | `failed`（resume=null, reason=`SANDBOX_UNVERIFIABLE`）；retry 新 attempt | `failed`；`failed` | pointer 保持旧值且视为不可信；validation=0；spawn=0 |
| post-manifest refresh/parse/persist 失败 | `failed(SANDBOX_UNVERIFIABLE)`；completed 422 `SANDBOX_UNVERIFIABLE` | `failed`（resume=null, reason=`SANDBOX_UNVERIFIABLE`）；retry 新 attempt | `failed`；`interrupted` | pointer 保持 preHash且旧 attempt 永不可 stage；validation=0 |
| artifact/validation/tool/result/event/final receipt 事务异常或回滚 | fallback CAS=`failed(INTERNAL_ERROR)`；completed 500 `INTERNAL_ERROR` | `failed`（resume=null, reason=`INTERNAL_ERROR`）；retry 新 attempt | `failed`；`interrupted` | pointer 保持事务前值；事务内 manifest/validation/artifact/result/event 全部为0 |
| owner pause 先赢且进程树已确认终止 | `discarded(OWNER_PAUSED)`；completed 409 `EXECUTION_STATE_CONFLICT` | `paused`（resume=`running`, reason=`OWNER_PAUSED`）；continue 前由 control cleanup 完成一次 verified refresh | `ready`；`discarded` | 未启动则保持 preHash；已启动则 control cleanup pointer→postHash；validation=0 |
| owner stop 先赢 | `discarded(OWNER_STOPPED)`；completed 409 `EXECUTION_STATE_CONFLICT` | `stopped`（resume=null, reason=`OWNER_STOPPED`）；无 continue/retry | `ready`；`discarded` | pointer 不再推进；validation=0；任何 late facts=0 |
| command lease expiry reconcile 先赢且进程树已确认终止 | `interrupted(ACTION_LEASE_LOST)`；completed 409 `ACTION_LEASE_LOST` | `paused`（resume=`running`, reason=`ACTION_LEASE_LOST`）；只允许 retry 新 attempt | `interrupted`；`interrupted` | pointer 保持 preHash；validation=0 |
| command overall deadline reconcile 先赢且进程树已确认终止 | `interrupted(ACTION_DEADLINE_EXCEEDED)`；completed 504 `ACTION_DEADLINE_EXCEEDED` | `paused`（resume=`running`, reason=`ACTION_DEADLINE_EXCEEDED`）；只允许 retry 新 attempt | `interrupted`；`interrupted` | pointer 保持 preHash；validation=0 |

authorization chain 无效或 stored request 无效使用 `COMMAND_AUTHORIZATION_INVALID` 409：action=`failed`、receipt=completed、execution/attempt=`failed`、tool=`failed`、manifest pointer不变、validation=0，owner只可 retry 新 attempt。owner pause 的 control operation 必须先请求并确认 command tree 终止，再原子提交 pause 行；无法确认时不暴露 paused，而由该 control operation 按 `PROCESS_TERMINATION_UNCONFIRMED` 行失败关闭。owner stop 已是终态，终止不确定只追加固定审计且不得改变 stopped 或提交 manifest/validation。每行在事务提交及数据库重开后均要求 running command action=0、pending advance receipt=0。

owner pause/stop、lease/deadline reconcile 与 process finalizer 以 action status+lease CAS 竞争：胜者在同一事务写完该行 action/receipt/execution/attempt/tool 状态；late finalizer CAS=0，只读取胜者 receipt，artifact/validation/manifest/result/event 写入均为0，不得恢复 running、覆盖 owner 状态或改写 HTTP/code。terminalizer 主事务注入失败时以新短事务执行 persist 行的 fallback CAS；若 control/reconcile 已赢则 fallback 也必须 CAS=0。

request→approve、approve→consume、consume acquire 前都重读 current attempt identity和manifest：request 后 manifest/attempt 变化时 approve 返回409 `APPROVAL_STALE`并把 pending approval置`expired`，不创建action且spawn=0；approve 后变化时下一advance不消费，approved approval置`expired`并返回409 `APPROVAL_STALE`，command action=0、spawn=0；消费事务内 CAS/manifest再次变化则整笔rollback并返回409 `APPROVAL_STATE_CONFLICT`，approval不被错误消费、action/receipt不创建、spawn=0。旧hash重放只返回既有失败receipt或明确冲突，绝不以新manifest执行旧请求。

## 6. API、DTO、错误与事件契约

所有 mutation body 含 UUID `operationId`；hash排除该字段但包含 route kind、path ids、expectedVersion和全部业务字段。owner 是本地单用户，但所有审批/控制 endpoint仍只接受产品 UI 的 owner actor，不接受模型调用路径。

### 6.1 Routes

- `GET /api/projects/:projectId/executions?after=<createdAt,id>&limit=1..50` → `ExecutionListResponse`
- `GET /api/executions/:executionId` → `ExecutionDetailResponse`（只有标量/摘要，不内嵌可增长集合）
- `GET /api/executions/:executionId/events?after=<sequence,id>&limit=1..100` → `CursorPage<ExecutionEvent>`
- `GET /api/executions/:executionId/artifacts?after=<createdAt,id>&limit=1..20` → `CursorPage<ArtifactSummaryDto>`
- `GET /api/executions/:executionId/artifacts/:artifactId/chunks?after=<chunkIndex>&limit=1` → `CursorPage<TextChunkDto>`（page text≤65536 bytes）
- `GET /api/executions/:executionId/approvals?after=<createdAt,id>&limit=1..10` → `CursorPage<ApprovalDto>`
- `GET /api/executions/:executionId/validations?after=<finishedAt,id>&limit=1..20` → `CursorPage<ValidationDto>`
- `GET /api/executions/:executionId/validations/:validationId/:stream(stdout|stderr)/chunks?after=<chunkIndex>&limit=1` → `CursorPage<TextChunkDto>`（page text≤65536 bytes）
- `GET /api/executions/:executionId/staged/:stagedId/observations?after=<position,id>&limit=1..20` → `CursorPage<StagedObservationDto>`
- `GET /api/executions/:executionId/staged/:stagedId/blockers?after=<position,observationId>&limit=1..20` → `CursorPage<StagedBlockerDto>`
- `GET /api/executions/:executionId/staged/:stagedId/observations/:observationId/diff?offset=0..262143&limit=1..65536` → `DiffChunkDto`
- `GET /api/executions/:executionId/recovery/files?after=<position,pathKey>&limit=1..20` → `CursorPage<RecoveryFileDto>`
- `POST /api/projects/:projectId/executions` body `{operationId,sourceCollaborationRunId,workItemId:string}` → 201 `{execution:ExecutionDto}`或持久4xx `{rejection:TaskRejection}`；不接受array
- `POST /api/executions/:executionId/start-resume` body `{operationId,expectedVersion}` → `{execution}`；只接受queued+`SANDBOX_RESUME_REQUIRED`，创建新attempt/sandbox_build action，语义与D-8 `start_resume` receipt一致
- `POST /api/executions/:executionId/advance` body `{operationId,expectedVersion}` → `{execution,attempt,actionResult,newEvents:ExecutionEvent[0..10]}`
- `POST /api/executions/:executionId/control` body `{operationId,action:"pause"|"continue"|"retry"|"stop",expectedVersion}` → `{execution}`
- `POST /api/executions/:executionId/approvals/:approvalId` body `{operationId,action:"approve"|"reject"|"revoke"|"replace",expectedVersion}` → `{execution,approval}`
- `POST /api/executions/:executionId/stage` body `{operationId,expectedVersion}` → `{execution,staged}`
- `POST /api/executions/:executionId/merge` body `{operationId,expectedVersion,stagedHash}` → `{execution,result}`
- `POST /api/executions/:executionId/recovery/resolve` body `{operationId,expectedVersion,action:"recovered_old"|"recovered_new"|"abandon",observedManifestHash}` → `{execution,recovery,uncleanedOwnedPathCount}`
- `GET /api/projects/:projectId/validation-policy`
- `GET /api/projects/:projectId/validation-policy/revisions?after=<revisionNo,id>&limit=1..20` → `CursorPage<ValidationPolicyRevisionDto>`
- `GET /api/projects/:projectId/validation-policy/audits?after=<sequence,id>&limit=1..20` → `CursorPage<ValidationPolicyAuditDto>`
- `PUT /api/projects/:projectId/validation-policy` body `{operationId,expectedVersion,warningAccepted:boolean,entries:ValidationPolicyEntryInput[0..50]}` → `{policy}`；只有literal true保存，false或known deny均完成rejected revision/receipt且政策不变

所有list route使用独立opaque base64url cursor，cursor含route、parent id、排序键和HMAC；跨route/parent、篡改或过期cursor为`INVALID_CURSOR`。服务端拒绝过大limit。普通list≤512KiB，detail/mutation≤256KiB，请求≤128KiB；每个text/diff chunk正文≤65536 bytes，envelope≤72KiB。合法≤1048576-byte validation stream/artifact由0..17个连续chunk读取（indices 0..16），一次返回一块；17是保留UTF-8 scalar边界的最坏上限。验证政策≤65536 bytes/50 entries；approval page≤10，observation/blocker/validation/artifact≤20，event≤100；数据库取limit+1，`hasMore`才返回nextCursor。

### 6.2 Public DTO

```ts
type ExecutionStatus =
  "queued"|"running"|"waiting_approval"|"paused"|"staged"|
  "stale"|"conflicted"|"failed"|"stopped"|"merged";
type ExecutionDto = {
  id:string; projectId:string; sourceCollaborationRunId:string;
  workItem:{id:string;title:string}; agent:{id:string;name:string;avatarText:string;accentToken:string};
  status:ExecutionStatus; reasonCode:ExecutionReason|null; resumeTarget:"queued"|"running"|"waiting_approval"|null;
  attemptNo:number; version:number; businessRounds:number; toolCalls:number;
  limits:{businessRounds:20;toolCalls:40;businessWallClockSeconds:900;
    businessClockStarts:"first_running";sandboxBuildSeconds:900;commandSeconds:120};
  usage:{promptTokens:number;completionTokens:number;totalTokens:number;maxTokens:number};
  currentAction:{kind:"sandbox_build"|"model"|"file_list"|"file_read"|"file_write"|
    "command"|"stage_compute"|"merge_apply"|"merge_recover"|"manual_resolution"|null;
    actionIndex:number|null;startedAt:string|null;overallDeadlineAt:string|null;
    lastHeartbeatAt:string|null};
  manualRecoveryRequired:boolean;
  createdAt:string;firstRunningAt:string|null;businessDeadlineAt:string|null;
  updatedAt:string;mergedAt:string|null;
};
type TaskRejection = {workItemId:string;code:
  "NOT_FOUND"|"NOT_IN_PROGRESS"|"UNASSIGNED"|"ASSIGNEE_NOT_MEMBER"|
  "DEPENDENCY_NOT_DONE"|"RELATED_SELECTION"|"TASK_ACTIVE"|"AGENT_ACTIVE"|
  "PROJECT_LIMIT"; messageKey:string};
type ApprovalDto = {
  id:string;kind:"command"|"staged_merge";status:
    "pending"|"approved"|"consumed"|"rejected"|"revoked"|"replaced"|"expired";
  requestHash:string;inputHash:string;stagedHash:string|null;
  command:null|{executable:string;args:string[];workdir:string;expectedEffect:string;
    riskReasons:string[];permission:"execute"};
  createdAt:string;decidedAt:string|null;consumedAt:string|null;
};
type StagedDto = {
  id:string;stagedHash:string;classification:"auto_eligible"|"approval_required"|"blocked";
  blockReasons:string[];observedPathCount:number;observedFinalBytes:number;
  mergeFileCount:number;mergeFinalBytes:number;blockerCount:number;
  blockerCounts:Record<string,number>;
};
type StagedObservationDto = {id:string;position:number;path:string;
  kind:"added"|"modified"|"deleted"|"renamed"|"binary"|"permission"|"special";
  baselineHash:string|null;observedHash:string|null;finalSize:number;
  diffBytes:number;diffTruncated:boolean};
type StagedBlockerDto = {position:number;observationId:string;path:string;
  kind:"deleted"|"renamed"|"binary"|"permission"|"special"|
    "file_size_limit"|"file_count_limit"|"byte_limit";
  detailCode:string;secondaryCodes:string[]};
type DiffChunkDto = {observationId:string;offset:number;nextOffset:number|null;
  totalBytes:number;text:string;sha256:string};
type ValidationDto = {id:string;policyEntryId:string;required:boolean;exitCode:number;
  succeeded:boolean;afterLastWrite:boolean;
  stdout:{bytes:number;sha256:string;truncated:boolean};
  stderr:{bytes:number;sha256:string;truncated:boolean};finishedAt:string};
type ArtifactSummaryDto = {id:string;name:string;path:string;contentBytes:number;
  sha256:string;truncated:boolean;createdAt:string};
type TextChunkDto = {stream:"stdout"|"stderr"|"artifact";chunkIndex:number;
  byteOffset:number;byteLength:number;text:string;sha256:string};
type FrozenInputSummary = {
  contextHash:string;taskVersion:number;missionVersion:number;memoryHash:string;
  rosterHash:string;agentVersion:number;providerVersion:number;skillsHash:string;
  permissionsHash:string;policyRevisionId:string;policyVersion:number;policyHash:string;
  baselineManifestHash:string;
};
type ExecutionDetailResponse = {
  execution:ExecutionDto;frozen:FrozenInputSummary;staged:StagedDto|null;
  counts:{events:number;artifacts:number;approvals:number;validations:number;
    stagedObservations:number;stagedBlockers:number;mergeFiles:number};
  recovery:{required:boolean;journalStatus:string|null;oldManifestHash:string|null;
    postManifestHash:string|null;observedManifestHash:string|null;mismatchPhase:string|null;
    allowedResolutions:Array<"recovered_old"|"recovered_new"|"abandon">};
};
```

DTO 只含上述字段。stdout/stderr/diff/tool content均是边界内脱敏文本；不返回 sandbox/canonical绝对路径、private prompt/skill正文、provider endpoint/key/mask/cipher、raw provider body、raw environment、lease token、backup path或隐藏思维链。

### 6.3 事件

每种 payload 单独 `.strict()`：

- `execution_created {workItemId,agentId,attemptNo}`、`sandbox_preflight {itemCount,copiedBytes,excludedCount}`、`sandbox_ready {manifestHash}`。
- `action_started {operationId,actionId,actionIndex,kind,attemptNo,overallDeadlineAt}`、`action_finished {operationId,actionId,actionIndex,kind,status,code}`、`action_reconciled {operationId,actionId,actionIndex,kind,resumeTarget}`；heartbeat只更新action row不刷timeline，不发lease token。
- `status_changed {from,to,reasonCode}`、`attempt_started {attemptNo}`、`attempt_interrupted {attemptNo,kind}`。
- `model_call_started|model_call_succeeded {modelCallId,attemptNo,round,kind}`；`model_call_failed {modelCallId,attemptNo,round,kind,category}`；`usage_recorded {modelCallId,agentId,promptTokens,completionTokens,totalTokens,reported}`。
- `tool_requested {toolCallId,type,requestSummary}`、`tool_succeeded {toolCallId,type,resultSummary,beforeHash,afterHash}`、`tool_rejected|tool_failed {toolCallId,type,guardCode,recovery}`。
- `approval_requested {approvalId,kind,requestHash,riskReasons}`、`approval_decided {approvalId,decision}`、`approval_consumed {approvalId}`。
- `validation_recorded {validationId,policyEntryId,required,exitCode,succeeded,sandboxManifestHash,truncated}`。
- `staged_created {stagedId,stagedHash,observedPathCount,observedFinalBytes,mergeFileCount,mergeFinalBytes,blockerCount,classification,blockReasons}`。
- `stale_detected {categories,pathCount}`、`conflict_detected {otherExecutionIds,pathCount}`。
- `control_applied {action}`、`merge_prepared {journalId,stagedHash,mergeFileCount}`、`merge_recovered {journalId,direction:"rollback"|"roll_forward"}`、`merged {journalId,resultId,stagedHash}`。
- `manual_recovery_required {journalId,mismatchPhase,pathCount,oldManifestHash,postManifestHash,observedManifestHash}`、`manual_recovery_resolved {journalId,resolution,uncleanedOwnedPathCount}`。
- `operation_replayed {operationId,kind}`；late finalizer只读取既有discarded/interrupted action与receipt，不新增事件。

事件不含具体私有 prompt、文件正文、diff、stdout/stderr或完整 command args；这些只在受限 detail DTO对应对象中出现。事件 request/result summary是固定 code/count/hash，不接收任意 Error/message。

### 6.4 Errors

统一 `{error:{code,message,category?,fields?,currentVersion?,executionId?,correlationId?}}`；客户端只按 code/category映射固定中文 copy。

- 400: `INVALID_JSON`, `INVALID_INPUT`, `INVALID_CURSOR`, `STRUCTURED_OUTPUT_INVALID`, `PATH_INVALID`, `TEXT_INVALID`
- 403: `AGENT_PERMISSION_REQUIRED`, `COMMAND_ABSOLUTELY_DENIED`, `OWNER_REQUIRED`
- 404: `PROJECT_NOT_FOUND`, `EXECUTION_NOT_FOUND`, `WORK_ITEM_NOT_FOUND`, `APPROVAL_NOT_FOUND`, `POLICY_NOT_FOUND`, `POLICY_REVISION_NOT_FOUND`, `VALIDATION_NOT_FOUND`, `ARTIFACT_NOT_FOUND`, `STAGED_OBSERVATION_NOT_FOUND`, `CHUNK_NOT_FOUND`
- 409: `TASK_NOT_ELIGIBLE`, `PROJECT_EXECUTION_LIMIT`, `TASK_EXECUTION_ACTIVE`, `AGENT_EXECUTION_ACTIVE`, `EXECUTION_STATE_CONFLICT`, `OPERATION_CONFLICT`, `OPERATION_IN_PROGRESS`, `ACTION_LEASE_LOST`, `EXECUTION_TIME_LIMIT`, `STALE_EXECUTION`, `PATH_CONFLICT`, `SANDBOX_FILE_CONFLICT`, `APPROVAL_STATE_CONFLICT`, `COMMAND_AUTHORIZATION_INVALID`, `MERGE_RECOVERY_REQUIRED`, `MANUAL_RECOVERY_REQUIRED`, `RECOVERY_MANIFEST_MISMATCH`, `MERGE_ALREADY_COMMITTED`
- 413: `REQUEST_LIMIT_EXCEEDED`, `RESPONSE_LIMIT_EXCEEDED`, `SANDBOX_LIMIT_EXCEEDED`, `FILE_LIMIT_EXCEEDED`, `OUTPUT_LIMIT_EXCEEDED`, `STAGED_LIMIT_EXCEEDED`
- 422: `SANDBOX_UNVERIFIABLE`, `SPECIAL_FILE_REJECTED`, `VALIDATION_REQUIRED`, `STAGED_NOT_ELIGIBLE`
- 401/429/502/504/503: 复用 S-4 provider/storage codes；新增504 `ACTION_DEADLINE_EXCEEDED`,`SANDBOX_BUILD_DEADLINE_EXCEEDED`，503 `PROCESS_TERMINATION_UNCONFIRMED`
- 500: `COMMAND_PROCESS_FAILED`, `MERGE_INVARIANT_FAILED`, `INTERNAL_ERROR`

错误/receipt response先过 public schema和secret redactor；未知 cause只记录 correlationId/code/route。数据库、HTTP响应、DOM、console、截图和 evidence 对 key、Authorization、master key、cipher、raw provider body、private prompt marker与隐藏思维 marker匹配数必须为0。

## 7. Validation policy 与 staged/merge 判定

政策是append-only snapshot。PUT先解析classifier/executable identity/workdir但不执行；`BEGIN IMMEDIATE`用expectedVersion CAS当前pointer，合法保存插入新的immutable revision_no/version、该revision的全套0..50 entries和saved audit，最后更新`project_validation_policies.active_revision_id/version`。不得UPDATE/DELETE旧revision/entry/audit，DDL trigger直接拒绝；rejected请求只追加audit/receipt，不创建revision、不移动pointer。execution attempt冻结`frozen_policy_revision_id/version/hash`，validation result复合FK同一revision entry。

retention：revision、entries、audit在project生命周期内永久保留，不做时间/数量GC；被attempt/validation引用的revision因此始终可重放。显式删除整个project时才允许FK cascade清理，immutable delete trigger以parent project已不存在为条件放行。当前policy GET只读active pointer；history分页只读immutable revisions/audits。空policy由system创建revision_no=1/entries=0，合法且`automaticMergeAllowed:false`。

verified sandbox manifest 是整棵 sandbox 的唯一字节事实，不得用单文件 hash 代替。baseline/当前 manifest 文件与 adapter DTO 使用 strict `{path,size,sha256,modeTag,identity}`，禁止 `hash`/`sha256` 双契约；baseline 写 immutable `baseline_manifest_path`，每次成功 refresh 原子写新的 `sandbox_manifest_path` 后再 CAS attempt 指针/hash，旧文件只读保留供审计。重启后 baseline/current 都从对应路径 strict parse identity；byte-manifest hash 仍只输入 path/size/sha256。`refreshSandboxManifest` 只经 verified handle 遍历并返回确定性 entry 集与 hash：

- 每次 write 与每个实际启动的 command 都先在 action lease 有效、execution/attempt 可执行时做一次 verified pre-refresh；其 hash 必须等于 attempt 当前 `sandbox_manifest_hash`，并成为 tool-call `before_sandbox_hash`。write 完成后、command 在确认进程树已终止后（无论 exit=0、非零、timeout）都做 post-refresh；termination 无法确认时 attempt/execution 直接 failed 且永久禁止 stage，不把缓存视为可信。
- 唯一 finalize 顺序：外部动作完成并取得 post entries/hash → 事务以 action lease/token、execution status/version、attempt status 与 `sandbox_manifest_hash=preHash` 做 CAS → 写 tool/action 终态（按真实 exit/错误决定 succeeded/failed）、command validation（若属于政策 entry，绑定 postHash）→ 更新 attempt `sandbox_manifest_hash=postHash` 与 execution version → 最后完成 receipt。任一 pre/post refresh 或 CAS 失败均不得留下 succeeded tool/action/validation；若文件已改变但 late CAS 失败，attempt 由 reconcile 进入 interrupted/failed，owner 只能 retry 新 attempt，旧 attempt 不得 stage。
- validation 总是绑定同次 command post-refresh 的整树 hash；之后任一 refresh 改变 hash，旧 validation 只读保留但不满足 required。
- stage 不以缓存 hash 相等直接判 `STAGED_NO_CHANGES`；先通过 production adapter 单次重算整树 entries+hash，并只使用这一份不可变结果计算 observations、diff、staged hash。事务以 action lease、execution version/status、attempt status 与旧缓存 hash 做 CAS；实际 hash 与缓存不一致时同一事务更新 attempt 后再判 required validation freshness，旧 validation 不新鲜则拒绝 stage。遍历/CAS 失败不得插 staged facts；遍历失败 `SANDBOX_UNVERIFIABLE`，实际等于 baseline 才是 `STAGED_NO_CHANGES`。
- baseline/current canonical 与 sandbox entry 都必须从打开的 verified file handle 保留 `identity`；同 bytes 但 identity 改变仍判 external stale。确定性 byte-manifest hash 明确只输入 path/size/sha256，不因 identity 改变而变化；identity 独立进入 frozen/staged stale 比较。existing entry 缺 identity 是 `SANDBOX_UNVERIFIABLE`，不得作为 `identity:null` 传给 conflict comparator。
- `stage_compute` action acquire 后所有路径都必须终态收口：success/stale/known guard error/adapter error/未知异常均在 catch/finally 中以 lease CAS 完成 action 与 receipt，并把 execution 置 staged/stale/paused/failed 的唯一状态；未知异常公开为 500 `INTERNAL_ERROR`，可验证性错误为 422 `SANDBOX_UNVERIFIABLE`。任何异常后 `running stage_compute` 数量必须为0，且不插部分 staged facts。

stage action acquire 后出口矩阵：

| 出口 | action / receipt | execution / attempt | staged facts |
|---|---|---|---|
| success | `succeeded`, completed 200 | `staged`, attempt=`completed` | 同一事务全量插入 |
| canonical/context stale | `failed(STALE_EXECUTION)`, completed 409 | execution=`stale`, attempt=`completed` | 0 |
| actual manifest=baseline | `failed(STAGED_NO_CHANGES)`, completed 409 | execution=`paused,resume_target=running,reason=STAGED_NO_CHANGES`, attempt=`ready` | 0 |
| required validation 不新鲜 | `failed(VALIDATION_REQUIRED)`, completed 422 | execution=`paused,resume_target=running,reason=VALIDATION_REQUIRED`, attempt=`ready` | 0 |
| adapter/identity/manifest parse error | `failed(SANDBOX_UNVERIFIABLE)`, completed 422 | execution=`paused,resume_target=running,reason=SANDBOX_UNVERIFIABLE`, attempt=`ready` | 0 |
| 未知异常（lease 仍归本 action） | `failed(INTERNAL_ERROR)`, completed 500 | execution=`failed,reason=INTERNAL_ERROR`, attempt=`failed` | 0 |
| lease/deadline/reconcile 先赢或事务注入后重开 | reconcile 置 `interrupted(ACTION_LEASE_LOST)`, completed 409 | execution=`paused,resume_target=running,reason=ACTION_LEASE_LOST`, attempt=`interrupted` | 0 |
| late finalizer CAS=0 | 只返回上述已持久 receipt，不新增事件/事实 | 不改 durable 状态 | 0 |

pending/running child 等 acquire 前 guard 在创建 stage action/receipt 前返回 `OPERATION_IN_PROGRESS` 409，因此 stage action 数=0。每个完成分支的 action、receipt、execution、attempt 与 staged facts 在同一事务提交；事务注入 rollback 后不声称 catch 已完成，而由重开/lease reconcile 唯一收口。

required validation有效 iff：exact tuple命中冻结 entry、exit=0、结果 `sandbox_manifest_hash` 等于当前 staged sandbox manifest。任一文件工具或会改变 manifest 的命令后，旧结果仍审计可见但不满足 required。staged条件:

- 至少一个 added/modified UTF-8 ordinary file；无 pending approval或running command。
- stage先将全部observed changed paths按UTF-8 path排序写`execution_staged_observations`，最多sandbox上限100000项；header记录真实`observed_path_count/observed_final_bytes`，即使>100或>10MiB也能持久并分页。每observation最多一条blocker，primary优先级固定为`special>binary>renamed>deleted>permission>file_size_limit>file_count_limit>byte_limit`，其余命中放`detail_json.secondaryCodes[0..7]`，因此不丢阻断原因且blocker总数≤100000。第101项仍写observation并至少命中file_count_limit。完整observation清单不等于merge清单。
- 只有全部observations均为≤1MiB的added/modified UTF-8、observed count≤100且final bytes≤10MiB时，才按同序复制到`execution_staged_files`作为merge-eligible rows并令`merge_file_count=observed_path_count`；任一blocker时merge rows/count/bytes均为0、classification=`blocked`。唯一old/new同hash稳定归类rename；权限不可读按special。
- 所有 required entry对当前 manifest成功；若 required集合为空则 `approval_required`。
- context/baseline有效、无同路径 staged conflict。

diff使用LF展示但hash/merge保留原始bytes；每observation diff≤256KiB并以≤64KiB chunk读取。validation stdout/stderr与artifact正文先redact为UTF-8，分别≤1048576 bytes，按不拆Unicode scalar的≤65536-byte immutable chunks落库，允许indices 0..16。最坏例是1048575 bytes连续三字节scalar：每个满chunk只能取65535 bytes，16块后仍余15 bytes，故需要第17块。header+全部chunks单事务提交；空stream零chunk，非空index/offset连续且拼接bytes/hash等于header。

`staged_hash`输入recursive-key-sorted canonical JSON：`{attemptId,baselineManifestHash,sandboxManifestHash,contextHash,policyRevisionId,policyHash,observedTotals,observations,blockers,mergeFiles,validations}`。observations按path bytes且含kind/hashes/size/mode/diff hash；blockers按position；mergeFiles只有全局eligible时存在；validations含immutable policy revision/entry、manifest、exit、whole output hashes/truncation。任何第101+ observation、chunk正文、validation、context或policy变化都改变hash。

## 8. 错误与恢复矩阵

| 失败 | 持久状态 | canonical 变化 | owner 恢复 |
|---|---|---|---|
| task资格/并发拒绝 | 不创建或仅 rejected receipt | 0 | 修复看板后新 start |
| sandbox link/special/2GiB或独立900s cap/复制失败 | queued未进入running；可清理则paused(resume queued)，不可确认则failed；business clock NULL | 0 | 清理workspace或显式retry；不记FR-10 timeout |
| provider/usage/二次 schema无效 | paused，call/usage保留 | 0 | 修 provider后 retry/continue按原因 |
| 权限缺失/absolute deny | paused，tool rejected | 0 | 修改 Agent会使旧 attempt stale，再 retry |
| 待批拒绝/撤销/替换 | paused，旧 approval终态 | 0 | continue，模型收到结果 |
| production one-shot request CAS/attempt/operation并发失败 | 短事务整笔rollback；approval/tool/event/可批准DTO=0，无request action/running action/pending receipt | 0；standing exact行为不变 | same operation重放唯一completed receipt；旧request/input hash明确冲突；重开仍为全无或完整waiting事实 |
| one-shot consumed 因果链/存储请求无效 | §5.2 authorization 行：action failed、receipt 409 `COMMAND_AUTHORIZATION_INVALID`、execution/attempt failed、tool failed、spawn/manifest/validation=0 | 0 | retry 新 attempt；旧 approval 永不重放 |
| process success/nonzero/已确认终止的120s timeout | §5.2 对应三行：receipt 均200；execution running、attempt ready；tool按 exit/timed_out 唯一终态；实际启动均 post-refresh，validation只按矩阵 | 0 | 无 owner 恢复，下一模型动作读取 typed result |
| spawn/run异常且未启动或已确认终止 | §5.2 对应行：500 `COMMAND_PROCESS_FAILED`；execution paused(resume running)、attempt ready、tool failed；manifest按是否启动选择 pre/post | 0 | continue；绝不重新执行旧 consumed approval |
| process tree终止无法确认 | action failed、receipt 503 `PROCESS_TERMINATION_UNCONFIRMED`；execution/attempt failed、tool interrupted；manifest停在pre、validation=0 | 0，旧sandbox不可提交 | retry 新 attempt |
| command pre/post manifest不可验证 | action failed、receipt 422 `SANDBOX_UNVERIFIABLE`；execution/attempt failed；tool按§5.2为failed/interrupted；validation=0 | 0，旧sandbox不可提交 | retry 新 attempt |
| command persist事务异常/回滚 | fallback action failed、receipt 500 `INTERNAL_ERROR`；execution/attempt failed、tool interrupted；事务内manifest/validation/artifact/result/event=0 | 0，旧sandbox不可提交 | retry 新 attempt |
| owner pause/stop先赢 | §5.2 owner行：command action/tool discarded、advance receipt 409；pause仅在确认终止后paused(resume running)并可continue，stop为stopped且无恢复；validation=0 | 0 | 严格按 pause=continue、stop=无操作 |
| heartbeat按30s成功 | running child/parent pending | 0 | 无；lease续至min(now+120s,overall)，总deadline不变 |
| heartbeat与reconcile/finalize竞态 | 唯一CAS胜者状态 | 0 | changes=0一方读durable child/receipt；不补写 |
| command lease/overall deadline reconcile先赢 | action/tool/attempt interrupted；receipt分别409 `ACTION_LEASE_LOST`/504 `ACTION_DEADLINE_EXCEEDED`；execution paused(resume running,同reason)；manifest停在pre、validation=0 | 0，旧sandbox不可提交 | 只允许 retry 新 attempt，不允许 continue |
| owner/reconcile 与 command late finalizer 竞态 | owner/reconcile 完整写入§5.2对应行；late CAS=0 | late artifact/validation/manifest/result/event=0 | 读取胜者 receipt；不得恢复 running 或覆盖 HTTP/code |
| provider单call 90s deadline | model child failed/interrupted，call timeout保留 | 0 | continue/retry；repair不会继承或延长primary deadline |
| sandbox_build lease过期 | execution paused/resume queued，attempt interrupted | 0 | continue后新start-resume operation/attempt；原start只重放interrupted receipt |
| context变化 | stale | 0 | retry捕获新事实 |
| external相关路径变化 | stale | 0 | retry新基线 |
| 两 staged同路径 | 双方 conflicted | 0 | owner选择顺序并分别 retry |
| stage无变化/验证不足 | paused或保持 running，明确原因 | 0 | 继续修改/运行验证 |
| merge失败且无external writer、DB未commit | 既有read barrier/helper conditional rollback后全旧 | 最终0 | 修复原因后以新merge operation重试；无public recover operation |
| 无external writer、DB commit后崩溃 | 既有read barrier/helper conditional roll-forward后全新 | 最终完整 | helper只补齐原journal，不创建recover receipt/action或重放业务动作 |
| 任一merge/helper path identity/hash mismatch | conflicted+manualRecoveryRequired；result不存在或被补偿删除 | 保留检测到的current，不覆盖 | owner经既有 `/recovery/resolve` 选择recovered_old/recovered_new/abandon |
| manual resolution verify后又变化 | 仍manual recovery | 0 | 刷新observed manifest后重新选择 |
| receipt重复same hash | 返回首次 status/body | 最多一次 | 无 |
| receipt同id不同内容 | 409 | 0 | 新 operationId |

## 9. NFR 落点

| NFR | 满足机制 | 验证方式 |
|---|---|---|
| NFR-1 并发/隔离/原子性 | active task/Agent partial unique；project count事务；独立外置 sandbox；path conflict；条件式 merge journal/recovery | 并发 start/advance/merge，双 sandbox/canonical hashes；无external writer时all-old/all-new，有writer时零覆盖并manual recovery |
| NFR-2 路径/资源 | sandbox独立15m operation cap；business 15m从首次running；120s command/90s call；1MiB正文≤17×64KiB chunks | sandbox与business clock隔离、retry不延、0/16/17 chunks及三字节scalar、101+/100k preview |
| NFR-3 权限/审批/表述 | Agent capability先判；frozen exact tuple；absolute deny；hash-bound one-shot approval；A-53逐字语义 | 权限矩阵、near-match/replay/tamper、桌面/窄屏文案与命令副作用 fixture |
| NFR-4 持久/幂等/审计 | parent receipt←ordered child actions；120s heartbeat lease+fixed deadline；append-only policy；chunk/observation facts；manual recovery | heartbeat/reconcile/finalize races、revision retention、chunk/101+重启、重复operation与secret scans |
| NFR-5 a11y/响应式 | 复用 tokens/mobile modal；语义 status/log/dialog；44px/focus；状态非仅颜色 | component axe-equivalent语义断言、键盘 desktop/narrow真实浏览器与focus restore |

### 9.1 FR 设计落点

| FR | 设计落点 |
|---|---|
| FR-1 | D-1、active partial indexes、start资格事务与双卡调度 |
| FR-2 | execution/attempt/action schema、3.2状态表、detail/recovery DTO |
| FR-3 | D-3、5.1 frozen prompt、action orchestrator |
| FR-4 | D-2、第四节 path guard、list/read handle工具 |
| FR-5 | 外置每attempt snapshot、原子write、manifest重检 |
| FR-6 | D-4、append-only validation policy revisions、5.2 approval lifecycle |
| FR-7 | observed/merge-eligible staged tables、chunked validation/artifact/diff DTO |
| FR-8 | D-6、frozen hashes、相关路径重检与双staged path index |
| FR-9 | D-5 merge journal、DB commit point、work item result |
| FR-10 | 固定deadline、heartbeat lease、64KiB chunks、100k observation/100 merge边界、共享usage |
| FR-11 | D-8 parent receipt←ordered child actions、CAS矩阵、restart reconcile/conditional merge recovery |
| FR-12 | 3.2 transition table、control CAS和在途终止 |
| FR-13 | strict public event schemas、typed DTO/redaction、稳定sequence |
| FR-14 | 第十一节桌面双卡/窄屏单surface及真实browser smoke |

## 10. 测试策略

- 迁移: 真实临时SQLite，v4→v5完整/漂移/故障/23表/22 index/6 trigger/FK；initial empty revision；policy revision/entry/audit UPDATE/DELETE拒绝与project delete cascade。
- 文件系统: Windows x64/NTFS-ReFS 上用临时目录创建真实 canonical/execution roots；覆盖普通文件、空文件、UTF-8/BOM/NUL/invalid、junction/reparse、设备名、大小/条目边界、write race和manifest determinism。其他 OS/arch/fs 测 capability fail-closed；mock FS只用于注入不可达分支，不替代当前支持平台的真实测试。
- 进程: 真实 child fixture 创建孙进程、写 stdout/stderr、hang、尝试 env读取和sandbox内改动；验证 direct args、minimal env、120s fake-clock单测+短真实 timeout、tree kill、截断/redaction、无法确认终止注入。
- 审批→进程集成: 扩展 `tests/execution-approvals.test.ts`，由 `advanceExecution` 走真实 approve→consume→command action acquire→`process-runner` 链路，以 harmless child 断言 one-shot 只启动一次；同文件分别篡改 `approval.input_hash`、`tool.before_sandbox_hash`、`tool.action_id`、action `(project_id,execution_id,attempt_id)`/`request_hash`/`operation_id`/`action_index`/lease，并覆盖 pending、未消费 approved、旧 consumed/replay，断言 spawn=0且不改 v5 DDL。扩展 `tests/process-runner.test.ts` 注入 success/nonzero/confirmed-timeout、authorization、pre/post manifest、spawn/run/termination/persist throw/reject、owner pause/stop及 lease/deadline reconcile late-finalizer 竞态，逐行核对 §5.2 的 action/receipt HTTP+code、execution/resume/reason、attempt/tool、manifest/validation，数据库重开后 running action=0/pending receipt=0。standing policy 既有 exact-match 测试必须保持不变。
- 生产请求→审批集成: 扩展 `tests/execution-orchestrator.test.ts`，用生产 `runCommandRequest/requestExecutionCommand` 从真实模型 command disposition 建立 one-shot，再经公开 `decideExecutionApproval` approve与 `advanceExecution` consume/execute；RED稳定得到当前 `APPROVAL_STATE_CONFLICT`，GREEN断言 approval input/tool before/attempt缓存manifest三者相等、request hash只随规范命令变化且只spawn一次。扩展 `tests/command-request.test.ts` 做 expectedVersion/status/current-attempt/manifest CAS、same/different operation并发、事务注入与数据库重开，断言短事务后tool/approval/event/receipt全无或完整，running action=0、pending receipt=0；扩展 `tests/execution-approvals.test.ts` 覆盖 request→approve、approve→consume 间 manifest/attempt变化的 expired/stale/conflict与spawn=0。三处都断言one-shot request不调用FS adapter、不创建request action/lease/heartbeat/reconcile，并保留standing exact既有command action、same-operation replay和old-hash conflict。
- 生产merge route集成: 新增 `tests/execution-merge-route.test.ts`，不得直接调用 `executeMergePrepare` 作为happy path；从公开 start/advance/stage（需要时经公开 staged approval）得到真实 `stagedHash`，再 `POST /api/executions/:executionId/merge` 至少一次返回200 merged/result且canonical等于post manifest。RED稳定证明当前route缺失且UI Merge误发advance得到409；GREEN覆盖strict body/128KiB、same-operation同payload逐字重放且merge写一次、different payload 409零新增，以及一个普通pre-acquire conflict的既有error mapping。capability测试同时保留低层直接调用失败operation/action/journal=0，并在production service层覆盖completed 422 receipt、并发preflight唯一insert/CAS胜者、receipt前崩溃后replay重跑与commit后只读receipt。通过专用merge orchestrator fault hook触发external writer，在同一route调用内得到409 `MANUAL_RECOVERY_REQUIRED`，再只经既有 `/recovery/resolve` 完成公开resolution；不测试或新增automatic recover route/operation/action，既有read barrier/helper的crash journal恢复继续由T-22/T-39负责。扩展 `tests/execution-cards-ui.test.tsx` 断言Merge使用独立operation id/body调用 `/merge`，不调用 `/advance`，409 manual recovery切换既有恢复surface。
- Provider: 本地OpenAI-compatible server；同model child primary+repair call_index 1/2、各90s不可续deadline、30s action heartbeat、usage与delay/late竞态。
- 并发/恢复: UI两次独立start；parent/ordered child；heartbeat恰在expiry前后与reconcile/finalize三方竞态；overall deadline不延；D-5全fault/race和三resolution。
- Service/API: append-only policy；sandbox 15m cap与首次running business DB clock隔离；1MiB validation/artifact按最多17×64KiB读回；0/16/17 chunks、1048575-byte三字节scalar、gap/hash；100/101/100000 observations。
- UI: 两项选择发两个独立start并分别成功/失败；validation/artifact chunks、observations/blockers load-more；standing revision历史；manual recovery；固定error copy和secret scan。
- Browser: desktop双卡和窄屏单 surface，键盘完成选择/审批/控制/diff；本地 provider+真实 temp workspace+真实 child；security scans覆盖响应、DOM、日志、SQLite和截图。
- 命令: `npm test`、`npm run build`、新增 `npm run smoke:execution`。最终 smoke只调用已由前序任务实现的公开行为。

## 11. UI 设计

### 11.1 信息架构

- 桌面 `TaskPanel` 保持 chat / board / run 三个既有 surface；board 的任务行新增可判定选择框与拒绝原因，run 改为 execution workspace。
- run 顶部是“选择并执行”摘要、当前验证政策入口；主体最多并列两张 `ExecutionCard`，每张固定显示任务/Agent、状态文字、当前动作、round/tool/token进度、阻断原因和独立控制。
- 卡片内 tabs: 时间线、验证、变更；approval出现时在对应卡顶部高优先级区域并保持关联，不建立全局含糊“全部允许”。
- staged diff 显示 path/kind/hash/size、文本 diff、验证新鲜度、风险/边界和自动合入资格；merge与command approval是不同按钮/审批。
- `manualRecoveryRequired`时对应卡顶部替换为不可关闭的高优先级恢复区，显示mismatch phase、old/post/observed manifest短码和分页path差异；advance、普通control、merge、approval全部disabled。owner只能选择“已恢复为旧版本并重试”“已确认完整新版本”“放弃且不改canonical”，每个按钮先展示exact-manifest条件、abandon可能遗留owned temp和不可逆状态变化，再二次确认。

### 11.2 状态

- 任务选择: loading skeleton；empty解释无eligible task；error保留选择；最多2项。提交双选时显示两个独立pending row并发出两个operationId/POST；一项失败不撤销另一项，分别重试且复用各自operationId；每项成功聚焦对应execution heading。
- 双卡: loading不伪造状态；empty引导回看板；error提供读取重试；queued/running/waiting/paused/staged/stale/conflicted/failed/stopped/merged都有文本和下一动作。
- approval: request loading、expired/error、approve/reject/revoke/replace disabled规则、提交 success live region；可恢复错误保留当前卡/tab/滚动。
- diff: loading/empty/error，error时无“可合入”；success后聚焦预览 heading；blocked/warning不只用颜色。
- controls: pause/continue/retry/stop按状态启用；stop确认复用现有 modal；一项控制不把另一项置 loading。
- events/artifacts/approvals/validations/validation-output/artifact-body/staged observations/blockers/recovery files各自独立loading/empty/page error/load-more。1MiB正文逐个≤64KiB chunk加载并显示bytes/truncated；第101+ observation仍可翻页。chunk/diff失败保留已读只读内容且禁止merge。
- manual recovery: 初始/分页/verify/submit error各自明确；manifest变化返回`RECOVERY_MANIFEST_MISMATCH`并刷新observed摘要，不保留“已确认”状态；成功后polite live region，`recovered_old`聚焦retry，`recovered_new`聚焦merged heading，`abandon`聚焦stopped heading。

### 11.3 窄屏

- 复用既有 `mobileSurface` 与 `useModalSurface`，run surface内一次只打开一个 execution detail、approval或diff覆盖区；打开子区时其余 cockpit inert，关闭/Escape后焦点回触发按钮。
- 两项 execution 先显示可切换摘要列表，一次渲染一个详情；不得并列压缩或叠 modal。全部审批/撤销/替换/控制/diff/政策操作键盘可达。

### 11.4 风险文案

一次性审批精确展示 executable（只显示已冻结值）、逐项 args、workdir、expected effect、Agent execute权限、request/input hash短码、风险原因和“一次性，仅此 attempt”。紧邻按钮固定显示：

> 此 guardrail 不是 hostile OS sandbox。获批的本地程序仍可能产生平台无法隔离的本机、网络、进程或服务副作用。

staged warning显示文件数/bytes/路径边界、required validation及新鲜度；政策为空显示“禁止自动合入，需要对当前 staged hash 单次批准”。

validation policy编辑区标题和每个entry固定标记“持续批准（standing approval）”；保存前摘要显示exact tuple、classifier版本、required flag、before/after policy hash，并要求未预选的`warningAccepted` checkbox。文案明确：匹配tuple可在未来attempt重复执行，不会逐次询问；平台无法静态证明程序任意副作用。命中known deny时保存按钮disabled并给机械code；parse-unknown path语法同样deny；`unknown_non_path`允许在警示后保存。执行详情必须显示“由持续政策放行”或“由本次一次性批准”，不可只显示“已批准”。

manual recovery警示明确“检测到平台外写入；平台已停止自动改写，当前workspace可能既非完整旧版也非完整新版”。三种resolution均展示正在比对整个manifest而非单文件；`abandon`明确只conditional清理平台owned对象且不会恢复canonical，若`uncleanedOwnedPathCount>0`提供分页只读清单。

### 11.5 视觉与可访问性

- 只复用 `--canvas/--surface/--surface-muted/--text/--border/--accent/--success/--warning/--danger`、Agent accent、现有 type/space/radius/shadow/focus；不新增硬编码色值、渐变、emoji或装饰动效。
- 双卡以现有 border/space区分，status同时有文字；diff使用 `--font-mono`，不以红绿单独表达 added/modified/block。
- `section`+heading、timeline `role=log`、progress含文本、approval `role=dialog`/描述关联、错误 `role=alert`、异步成功 polite live region。
- 所有交互目标≥44×44px，WCAG AA，focus-visible；tablist支持 Arrow/Home/End；dialog trap/inert/restore沿用现有 primitive。

## 12. 任务清单

- [x] T-1 建立完整严格SQLite v5原子迁移基础 (覆盖: FR-2, FR-10, FR-11, FR-13, NFR-1, NFR-4) — 判据: `npm test -- tests/migrations-v5.test.ts`先红后绿；23表/22 index/6 trigger、全部CHECK/composite FK/data invariant、initial revision、每个fault rollback、重开幂等通过
- [x] T-2 打通最小owner→持久execution→真实UI状态切片 (覆盖: FR-1, FR-2, FR-11, FR-14, NFR-1, NFR-4, NFR-5) — 判据: `npm test -- tests/execution-slice.test.tsx`先红后绿；在完整v5上选择一个happy-path task，hold住注入的sandbox executor时start receipt/execution/preparing attempt/running sandbox action已持久化，并发GET和卡片真实显示queued/currentAction且刷新回显；POST仍pending，不伪造sandbox ready或完成receipt
- [x] T-3 完成单任务start资格与UI双POST并发事务 (覆盖: FR-1, NFR-1) — 判据: `npm test -- tests/execution-eligibility.test.ts`先红后绿；API拒绝array，UI两个operationId并发、独立成功/拒绝/replay，DAG/member/project≤2/task≤1/Agent≤1竞态通过
- [x] T-4 实现parent operation与ordered child receipt契约 (覆盖: FR-11, FR-12, FR-13, NFR-4) — 判据: `npm test -- tests/execution-operations.test.ts`先红后绿；连续action_index、parent/action_count/final index、最多一running child、same/different hash、receipt只随final outcome完成、duplicate start/recover通过
- [x] T-5 实现generic child heartbeat与business clock CAS (覆盖: FR-2, FR-10, FR-11, FR-12, FR-13, NFR-1, NFR-4) — 判据: `npm test -- tests/execution-actions.test.ts`先红后绿；创建/queued时business fields NULL、首次running DB now/+900、retry不变、30s heartbeat/120s lease、deadline边界与三方竞态唯一changes=1通过
- [x] T-6 实现execution root校验与sandbox 100k/2GiB预检 (覆盖: FR-4, FR-5, FR-10, NFR-2, NFR-3) — 判据: `npm test -- tests/sandbox-preflight.test.ts`先红后绿；Git/非Git、根相交、secret/managed排除、limit-1/limit/+1、link/reparse/special和adapter不可用失败关闭通过
- [x] T-7 实现verified-handle快照与独立sandbox deadline (覆盖: FR-5, FR-8, FR-11, NFR-1, NFR-2, NFR-4) — 判据: `npm test -- tests/sandbox-snapshot.test.ts`先红后绿；A-52/A-55独立900s cap的899/900/901、>120s heartbeat继续、business clock始终NULL、paused/failed cleanup语义、source race/hash/restart通过
- [x] T-8 实现跨平台path guard与有界list action (覆盖: FR-3, FR-4, FR-10, FR-11, NFR-2, NFR-3, NFR-4) — 判据: `npm test -- tests/execution-list-tool.test.ts`先红后绿；绝对/UNC/device/ADS/dot/device names、handle chain、1000排序/truncated、race、action late结果通过
- [x] T-9 实现handle-based UTF-8 read action与redaction (覆盖: FR-3, FR-4, FR-10, FR-13, NFR-2, NFR-3, NFR-4) — 判据: `npm test -- tests/execution-read-tool.test.ts`先红后绿；0/1MiB/+1、BOM/NUL/invalid、identity race、hash、credential patterns不入model/DTO/DB通过
- [x] T-10 实现expected-hash原子UTF-8 write action (覆盖: FR-3, FR-5, FR-10, FR-11, NFR-1, NFR-2, NFR-3) — 判据: `npm test -- tests/execution-write-tool.test.ts`先红后绿；新增/替换、handle temp/fsync/rename、1MiB、父/目标race、conditional cleanup、失败零部分写、双sandbox隔离通过
- [x] T-11 实现append-only validation policy与classifier (覆盖: FR-6, FR-8, FR-10, FR-14, NFR-2, NFR-3, NFR-4) — 判据: `npm test -- tests/validation-policy.test.ts tests/command-policy.test.ts`先红后绿；active CAS、新revision/entries/audit、历史update/delete拒绝、attempt/validation frozen FK、project-lifetime retention、50/64KiB、standing/deny通过
- [x] T-12 实现command one-shot request与机械分类结果 (覆盖: FR-3, FR-6, FR-10, FR-13, NFR-3, NFR-4) — 判据: `npm test -- tests/command-request.test.ts`先红后绿；standing exact直通、near/unlisted one-shot、shell/path/deploy deny零执行、parse unknown分支、hash-bound waiting request通过
- [x] T-13 实现direct process、heartbeat、tree timeout与chunked streams (覆盖: FR-6, FR-10, FR-11, FR-13, NFR-2, NFR-3, NFR-4) — 判据: `npm test -- tests/process-runner.test.ts`先红后绿；真实child tree、30s续lease但120s overall不延、1MiB redacted stream按64KiB chunks/hash、termination-unconfirmed/late通过
- [x] T-14 实现strict model action与同child primary/repair (覆盖: FR-3, FR-10, FR-11, NFR-2, NFR-4) — 判据: `npm test -- tests/execution-action-schema.test.ts tests/execution-structured-repair.test.ts`先红后绿；`UNIQUE(action,call_index)`允许1/2且拒绝重复、每call独立90s、heartbeat不延call/execution deadline、repair usage/二次无效通过
- [x] T-15 实现frozen public/private prompt与typed tool-result (覆盖: FR-3, FR-8, FR-13, NFR-3, NFR-4) — 判据: `npm test -- tests/execution-prompt.test.ts`先红后绿；当前私有/他人隔离、absolute path/secret/raw排除、稳定顺序、2MiB内部/64KiB公开summary边界通过
- [x] T-16 实现client-driven parent/child model-tool CAS loop (覆盖: FR-2, FR-3, FR-4, FR-5, FR-6, FR-11, NFR-1, NFR-4) — 判据: `npm test -- tests/execution-orchestrator.test.ts`先红后绿；每advance一个parent logical step、children严格串行、model child内primary/repair、下一tool为新operation、receipt final/late discard通过
- [x] T-17 实现S-4+S-5 per-Agent共享可信usage与20/40/15m (覆盖: FR-1, FR-3, FR-10, NFR-1, NFR-2, NFR-4) — 判据: `npm test -- tests/execution-usage-budget.test.ts`先红后绿；S-4初值、primary/repair/failure/retry、missing/invalid、pre/post越界零动作、Agent隔离通过
- [x] T-18 实现frozen context重算、credential例外与stale (覆盖: FR-3, FR-8, FR-11, FR-12, FR-13, NFR-1, NFR-4) — 判据: `npm test -- tests/execution-stale-context.test.ts`先红后绿；A-56上下文全集、纯credential轮换、每action/stage/merge检查、approval expiry和旧结果只读通过
- [x] T-19 实现全量staged observations与chunked outputs (覆盖: FR-3, FR-6, FR-7, FR-9, FR-10, NFR-1, NFR-2) — 判据: `npm test -- tests/execution-staging.test.ts`先红后绿；0/100/101/100000 observations、blocked/eligible rows；output 0/16/17 chunks、1MiB与1048575-byte三字节scalar、gap/hash/freshness通过
- [x] T-20 实现external edit stale与双execution path conflict (覆盖: FR-1, FR-7, FR-8, FR-9, FR-12, NFR-1, NFR-4) — 判据: `npm test -- tests/execution-conflicts.test.ts`先红后绿；owner/程序/另一execution相关路径、同内容同路径双方conflict、不相交先合入不stale、并发stage/merge通过
- [x] T-21 实现merge prepare、owned backup/new与conditional per-file apply (覆盖: FR-8, FR-9, FR-11, NFR-1, NFR-2, NFR-4) — 判据: `npm test -- tests/merge-journal-prepare.test.ts`先红后绿；project lock、old/post identity/hash、temp/fsync/order、每path pre/post、modified/added conditional rollback和fault通过
- [x] T-22 实现无external writer的DB commit与restart recovery (覆盖: FR-2, FR-9, FR-11, FR-13, NFR-1, NFR-4) — 判据: `npm test -- tests/merge-recovery.test.ts`先红后绿；commit前后post-check、action/receipt顺序、每crash点rollback/roll-forward、最终all-old/all-new、result/execution一致、cleanup幂等通过
- [x] T-23 实现external-writer race检测与三种manual resolution (覆盖: FR-2, FR-8, FR-9, FR-11, FR-12, FR-13, NFR-1, NFR-4) — 判据: `npm test -- tests/merge-external-writer.test.ts`先红后绿；D-5每race窗口replace/delete/new-identity/link，外部bytes覆盖0、普通动作阻断、recovered_old/new/abandon exact whole-manifest/幂等/mismatch/owned cleanup通过
- [x] T-24 实现pause/continue/retry/stop与attempt重建 (覆盖: FR-2, FR-10, FR-11, FR-12, FR-13, NFR-1, NFR-4) — 判据: `npm test -- tests/execution-controls.test.ts`先红后绿；合法/非法transition/resume target/version、单项独立、retry新sandbox继承usage、inflight terminate/late零提交、manual gate通过
- [x] T-25 实现command/staged approval完整lifecycle API (覆盖: FR-2, FR-6, FR-9, FR-11, FR-12, FR-13, NFR-3, NFR-4) — 判据: `npm test -- tests/execution-approvals.test.ts`先红后绿；consume一次、reject/revoke/replace、tuple/input/staged篡改、跨attempt/replay/终态、standing与one-shot审计通过
- [x] T-26 实现bounded summary/chunk/observation APIs (覆盖: FR-2, FR-7, FR-10, FR-11, FR-13, NFR-2, NFR-4) — 判据: `npm test -- tests/execution-read-api.test.ts`先红后绿；合法1MiB/最坏多字节逐≤17 chunks完整可读、indices0..16/cursor/total caps、101+ observation/blocker、strict DTO/secret scan通过
- [x] T-27 交付双独立start与append-only policy UI (覆盖: FR-1, FR-6, FR-14, NFR-3, NFR-5) — 判据: `npm test -- tests/execution-start-policy-ui.test.tsx`先红后绿；双选发两个POST/operationId、独立loading/error/retry；active revision/history、standing警示、known deny、CAS draft/focus通过
- [x] T-28 交付桌面双ExecutionCard与max-two client auto-loop (覆盖: FR-1, FR-2, FR-3, FR-10, FR-12, FR-14, NFR-1, NFR-5) — 判据: `npm test -- tests/execution-cards-ui.test.tsx`先红后绿；两卡独立/current sandbox action、每卡单advance、全局≤2请求、不自动补任务、刷新/error retry/单项control通过
- [x] T-29 交付chunked validation/artifact与101+ staged review UI (覆盖: FR-6, FR-7, FR-8, FR-9, FR-13, FR-14, NFR-2, NFR-3, NFR-5) — 判据: `npm test -- tests/execution-review-ui.test.tsx`先红后绿；1MiB逐chunk、totals/truncated、observation/blocker独立load-more、第101项可见、blocked无merge、standing vs one-shot与focus/error通过
- [x] T-30 交付manual recovery与窄屏可访问surface (覆盖: FR-2, FR-9, FR-12, FR-14, NFR-1, NFR-3, NFR-5) — 判据: `npm test -- tests/execution-recovery-ui.test.tsx tests/execution-accessibility.test.tsx`先红后绿；普通动作全禁、manifest/path分页、三resolution二次确认/变化错误/焦点、单surface trap/inert/Escape/restore、44px/AA/非仅颜色通过
- [x] T-31 收口真实FS/process/provider/并发/崩溃安全集成套件 (覆盖: FR-1..FR-13, NFR-1, NFR-2, NFR-3, NFR-4) — 判据: `npm test -- tests/execution-security-integration.test.ts tests/merge-fault-injection.test.ts tests/execution-pagination-limits.test.ts`先红后绿；sandbox独立15m/business首次running15m/heartbeat race、provider90/process120、17-chunk multibyte、101+/100k observations、merge/secret scan通过
- [x] T-32 修复真实 provider 双 Agent 并发时 model-call 未终态化 (覆盖: FR-3, FR-10, FR-11, NFR-1, NFR-4) — 判据: `npm test -- tests/execution-orchestrator.test.ts`先红后绿；两个不同 Agent execution 经真实本地 OpenAI-compatible HTTP 并发成功与 provider/解析失败路径均在有界时间内完成，每条 `execution_model_calls` 唯一进入合法终态且 `finished_at` 非空，`calling` 残留为 0，action/operation 状态一致；在 HTTP 返回后、终态 UPDATE/提交前后注入故障并重开数据库或等待 lease reconcile，旧 call 唯一转 `interrupted`、可信 usage 不补记，显式重试使用新 call 且不静默重放旧外部请求
- [x] T-33 建立 Windows x64 Koffi ABI loader 与 fail-closed capability (覆盖: FR-4, FR-8, FR-9, NFR-2, NFR-3) — 判据: `npm test -- tests/windows-native-loader.test.ts`先红后绿；安装 Koffi 并配置 Next external，固定 symbol/info-class/flags，验证 OS/arch/fs 与全部 struct size/offset，root handle identity/attributes/finalPath/close 真实通过；symbol/ABI/struct/unsupported platform/native load/close 任一异常唯一返回 `SANDBOX_UNVERIFIABLE`，production build 后 native load smoke 通过
- [x] T-34 实现 Windows handle-relative 只读 traversal/list/read (覆盖: FR-4, FR-5, FR-8, NFR-1, NFR-2, NFR-3) — 判据: `npm test -- tests/windows-native-read-adapter.test.ts`先红后绿；`NtCreateFile` relative child/file open、`NtQueryDirectoryFile` list、`ReadFile` short-read loop、祖先 identity/finalPath 重检和 ownership/close 通过；junction/reparse/special、parent/file replace/rename、malformed native buffer 均失败关闭且 secret bytes 读取0
- [x] T-35 实现 Windows handle-relative temp/write/flush/rename/delete (覆盖: FR-5, FR-8, FR-9, NFR-1, NFR-2, NFR-3) — 判据: `npm test -- tests/windows-native-write-adapter.test.ts`先红后绿；verified parent 下 exclusive temp、short-write loop、file/directory flush、relative atomic replace/delete、pre/post identity/hash 与 conditional cleanup 通过；每个 native fault/race 只改预期对象，外部/secret bytes 覆盖0
- [x] T-36 将 verified adapter 接入 sandbox snapshot (覆盖: FR-4, FR-5, FR-8, FR-10, FR-11, NFR-1, NFR-2, NFR-4) — 判据: `npm test -- tests/sandbox-preflight.test.ts tests/sandbox-snapshot.test.ts`先红后绿；删除 snapshot 的 path-level `lstat/realpath/open` 和 `O_NOFOLLOW ?? 0` fallback，复制、manifest、race、100k/2GiB、cleanup 全部只经 verified handle，native failure 按矩阵收口
- [x] T-37 将 verified adapter 接入 file list/read/write/stage (覆盖: FR-3, FR-4, FR-5, FR-7, FR-8, FR-11, NFR-1, NFR-2, NFR-3, NFR-4) — 判据: `npm test -- tests/execution-list-tool.test.ts tests/execution-read-tool.test.ts tests/execution-write-tool.test.ts tests/execution-staging.test.ts`先红后绿；删除 Node path fallback，四类 action 复用同一 handle chain，race/identity/finalPath/native failure 的精确 action/execution/receipt 状态通过
- [x] T-38 实现 Windows merge-owned file 跨 journal 生命周期原语 (覆盖: FR-8, FR-9, NFR-1, NFR-2, NFR-4) — 判据: `npm test -- tests/windows-native-merge-lifecycle.test.ts`先红后绿；prepare 后全部 HANDLE 已关闭且新 adapter/进程可按 descriptor 重开，identity/hash/size/finalPath/parent identity/owner 全匹配；old→post、post→old、added rollback、conditional cleanup 通过；replace/delete/same-bytes-new-identity/reparse race 与每个 native fault 均 external bytes 覆盖0、成功 handle close恰一次
- [x] T-39 将 verified adapter 接入 merge/recovery/manual resolution (覆盖: FR-8, FR-9, FR-11, NFR-1, NFR-2, NFR-4) — 判据: `npm test -- tests/merge-journal-prepare.test.ts tests/merge-recovery.test.ts tests/merge-fault-injection.test.ts tests/merge-external-writer.test.ts`先红后绿；首次 canonical 写前 capability failure 零 journal/零写，journal 后任一 native 不确定进入 manual barrier，conditional apply/rollback/roll-forward/cleanup 全经 handle，external bytes 覆盖0、任务结果提交0
- [x] T-40 接通生产默认 sandbox executor 与 start receipt 收口 (覆盖: FR-1, FR-2, FR-4, FR-5, FR-8, FR-10, FR-11, NFR-1, NFR-2, NFR-4) — 判据: `npm test -- tests/execution-sandbox-orchestrator.test.ts`先红后绿；不调用 `setSandboxExecutorForTests`，公开 start route 对真实临时 SQLite/canonical/execution root 返回201，verified snapshot 文件存在且 canonical 零修改，attempt=`ready`、sandbox action=`succeeded`、start receipt=`completed`、manifest一致；逐项覆盖 D-2 fault/concurrency oracle，断言四项成功事实全有或全无、snapshot执行次数、精确状态/HTTP/清理结果与 canonical hash
- [x] T-41 统一并刷新 verified sandbox manifest 生命周期 (覆盖: FR-3, FR-5, FR-7, FR-8, FR-10, FR-11, NFR-1, NFR-2, NFR-4) — 判据: `npm test -- tests/execution-write-stage-integration.test.ts`先红后绿；生产 Windows adapter 的真实 write、成功 command、非零/timeout且已确认终止 command 均记录 pre/post 整树 hash并更新 attempt，canonical 不变，baseline/current entry 统一 `sha256`；validation 只绑定 postHash，后续 refresh 正确失鲜；stage 只消费单次 refresh 的 entries/hash并产生 observation+merge file；pre/post refresh、stage遍历、lease/version/expected-hash CAS 竞争失败均不留 succeeded tool/action/validation/staged facts并按设计进入 paused/failed/interrupted
- [x] T-42 保留 canonical identity 并收口 stage action 全异常路径 (覆盖: FR-7, FR-8, FR-11, NFR-1, NFR-4) — 判据: `npm test -- tests/execution-write-stage-integration.test.ts`先红后绿；strict baseline/current manifest 持久 identity 并在关闭数据库/adapter后重开，同 bytes 新 identity 仍 stale；完整 production adapter 逐项覆盖 success、stale、no-changes、validation stale、identity/parse error、未知异常、lease/reconcile、事务注入重开与 late finalizer，精确匹配 §7 矩阵，非成功分支 running action=0、pending receipt=0、staged facts=0且 handle close恰一次
- [x] T-43 修复 one-shot consume→execute 精确授权与全异常终态收口 (覆盖: FR-2, FR-6, FR-10, FR-11, FR-12, FR-13, NFR-1, NFR-2, NFR-3, NFR-4) — 判据: `npm test -- tests/execution-approvals.test.ts tests/process-runner.test.ts`先红后绿；RED 必须通过 `advanceExecution`（不得直接调用 consume/runner 拼接中间状态）的真实 approve→consume→execute 链路稳定复现“approval 已 consumed 后 runner 拒绝且遗留 running action/pending receipt”，并使 §5.2 至少一个异常注入暴露孤儿；GREEN 必须只凭真实 v5 列证明 `approval.input_hash=tool.before_sandbox_hash=consume时attempt.sandbox_manifest_hash`，由 `tool.action_id`+三表复合 identity 间接绑定 action、由共同 `request_hash` 直接绑定请求，standing policy 行为不变，pending/未消费 approved/旧 consumed/replay及 `approval.input_hash`、`tool.before_sandbox_hash`、`tool.action_id`、action identity/request_hash/operation/action-index/lease tamper 全部 spawn=0且不改 DDL；success、nonzero、已确认终止120s timeout、spawn/run异常、终止不确定、pre/post manifest、persist、owner pause/stop、lease/deadline reconcile 与 late-finalizer 逐行匹配 §5.2 的 action/receipt HTTP+code、execution/resume/reason、attempt/tool、manifest/validation；数据库重开后 running command action=0、pending receipt=0，late CAS 不覆盖 owner/reconcile 胜者
- [x] T-44 修复生产 one-shot command request 的 manifest/input snapshot 原子绑定 (覆盖: FR-2, FR-3, FR-6, FR-8, FR-11, FR-13, NFR-1, NFR-3, NFR-4) — 判据: `npm test -- tests/command-request.test.ts tests/execution-orchestrator.test.ts tests/execution-approvals.test.ts`先红后绿；RED 必须通过生产 `runCommandRequest/requestExecutionCommand` 与公开 approve→advance 链路稳定复现 approval input误用canonical request hash而返回`APPROVAL_STATE_CONFLICT`，不得手工插业务SQLite合成请求；GREEN 必须由 `requestExecutionCommand` 现有短事务读取current execution/attempt/version/status与缓存manifest，并原子写 `approval.input_hash=tool.before_sandbox_hash=current attempt.sandbox_manifest_hash`，`request_hash`仅表示规范命令请求，完整公开链只spawn一次；one-shot request不得创建action/lease或调用FS refresh，CAS/operation并发/事务注入失败后approval/tool/event/可批准DTO=0，same-operation replay唯一completed receipt，重开后running action=0、pending receipt=0且事实全无或完整；request→approve或approve→consume间manifest/attempt变化时approval stale/expired或事务conflict且spawn=0；standing policy exact match沿用既有command action与执行行为
- [x] T-45 接通专用production merge route/service与UI调用 (覆盖: FR-2, FR-7, FR-8, FR-9, FR-11, FR-13, FR-14, NFR-1, NFR-4, NFR-5) — 判据: `npm test -- tests/execution-merge-route.test.ts tests/execution-cards-ui.test.tsx`先红后绿；RED 必须由公开start/advance/stage得到真实staged execution，证明 `POST /api/executions/:executionId/merge` 缺失且UI Merge错误调用advance稳定409，不得直接调用merge service或写业务SQLite合成happy path；GREEN任务只接通bounded strict route、专用 `mergeExecution` service与UI `/merge` 调用，并复用既有 `executeMergePrepare→executeMergeCommit`、guards和read barrier/helper；从真实staged至少一次200 merged/result且canonical=post，advance仍拒绝staged；same payload只写一次并逐字重放、different payload 409零新增，一个普通conflict保持既有映射；capability failure低层operation/action/journal=0，service唯一completed 422 receipt且并发/receipt前崩溃/replay符合D-5；fault injection同一调用进入manual recovery并只经既有 `/recovery/resolve` 可达，不新增automatic recover route、receipt或action；UI使用独立merge operation，409 manual recovery进入既有恢复surface
- [ ] T-46 收口只经公开行为的真实 browser smoke harness (覆盖: FR-1, FR-2, FR-3, FR-8, FR-9, FR-11, FR-14, NFR-1, NFR-4, NFR-5) — 判据: `npm test -- tests/execution-browser-smoke.test.ts`先红后绿；smoke 不拦截 start/advance/stage/merge及既有 `/recovery/resolve` 路由、不直接写业务 SQLite 或复制 canonical 文件来合成状态，双 execution 从 start 经真实 provider、工具/验证、stage 到至少一次 merge 只走产品公开 API；stale/conflict由公开行为触发，manual recovery固定由merge fault injection触发后只调用既有 `/recovery/resolve`，不假设automatic recover route；provider 健康探针不计入 execution 并发断言
- [ ] T-47 运行S-5 desktop+narrow smoke/demo，仅验证前序已实现行为 (覆盖: FR-1..FR-14, NFR-1..NFR-5) — 判据: 本任务不得新增或修改product code/test行为；README、`npm test`、`npm run build`、`npm run smoke:execution`通过，并留真实provider双Agent不相交合入、重复/边界/standing+one-shot、stale/conflict/manual recovery及desktop/narrow证据

任务覆盖索引：FR-1→T-2/3/17/20/27/28/31/40/46–47；FR-2→T-1/2/5/16/22–26/28/30–31/40/43–47；FR-3→T-8–10/12/14–19/28/31–32/37/41/44/46–47；FR-4→T-6–10/16/31/33–34/36–37/40/47；FR-5→T-6/7/10/16/31/34–37/40–41/47；FR-6→T-11–13/16/19/25/27/29/31/43–44/47；FR-7→T-19/20/26/29/31/37/41–42/45/47；FR-8→T-7/11/15/18–23/29/31/33–42/44–47；FR-9→T-19–23/25/29/30–31/33/35/38–39/45–47；FR-10→T-1/5/6/8–14/17/19/24/26/28/31–32/36/40–41/43/47；FR-11→T-1/2/4/5/7/8/10/13/14/16/18/21–26/31/36–47；FR-12→T-4/5/18/20/23–25/28/30–31/43/47；FR-13→T-1/4/5/9/11–15/18/22–26/29/31/43–45/47；FR-14→T-2/11/27–30/45–47。NFR-1→T-1–3/5/7/10/16–24/28/30–47；NFR-2→T-6–17/19/21/26/29/31/33–41/43/47；NFR-3→T-6/8–15/25/27/29/30–35/37/43–44/47；NFR-4→T-1/2/4/5/7–9/11–18/20–26/31/36–47；NFR-5→T-2/27–30/45–47。
