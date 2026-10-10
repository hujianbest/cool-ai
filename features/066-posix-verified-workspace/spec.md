# 规格：posix verified workspace（目标平台 macOS）

- 特性: 066-posix-verified-workspace
- 主子系统: Safe Execution（出站 Adapter 层）；主领域 Capability: `CAP-EXE-01` 的 posix 平台路径
- 模式: auto
- 状态: 已确认（用户 2026-10-11 指示“切换目标平台为 macOS”）

## 用户结果

Owner 在 macOS（arm64/x64）上打开本地文件夹项目后，verified workspace 的读取、执行、staged merge、救援与审计全部真实可用；行为与既有 Windows x64 路径等价（同一失败关闭语义、同一身份/审批/审计协议），不再以 `SANDBOX_UNVERIFIABLE` 失败关闭。

## 范围

- 新增 posix 原生层：`posix-native-koffi`（libSystem 绑定：openat/fstatat/getdirentries/renameat/mkdirat/unlinkat）、`posix-native-read-adapter`、`posix-native-write-adapter`（含 merge lifecycle），镜像 `windows-native-*` 的每一步验证协议。
- 平台路由：`createDefaultSandboxFsAdapter`、merge-verified 工厂、verified-execution 工厂按 `process.platform` 选择 windows/posix；消费方（路由/服务）不变。
- Windows 层与 Windows 平台测试保留，按平台门控执行。
- 产品文档平台声明（README、product、AGENTS、development-plan、backlog）从 Windows x64 切换为 macOS。

## 非目标

- 不实现 OS 级恶意代码沙箱（沿用产品既有声明：明确但非 OS 级的安全边界）。
- 不删除 Windows 适配器与其测试。
- 不改变 schema、领域服务、API 契约。

## 约束（平台等价性）

- 身份：`{volumeSerialNumber: hex(dev), fileId: hex(ino) 左补零 32 位}`，保持与 Windows 身份键格式及 `VerifiedOwnedFileRef` 正则兼容。
- 相对打开：`openat(dirfd, name, O_NOFOLLOW[|O_DIRECTORY|O_CREAT|O_EXCL])`，名称校验拒绝空/./..//、`\0` 与非 NFC；posix 名称允许 `:` 与 `\`（合法文件名字符，段不重切分）。
- 枚举：`getdirentries(fd)` 出名与类型（DT_*），`fstatat(dirfd, name, AT_SYMLINK_NOFOLLOW)` 出权威 64 位身份并交叉核对类型；symlink 视作 reparse 等价物拒绝进入。
- 规范路径：根 `realpathSync` 且 lstat 身份须与 fd 身份一致；子级规范路径由已验证链构造（全链 nofollow，无符号链接）。
- 重命名：同父目录 `renameat` 原子替换；删除 `unlinkat`；目录持久化 `fsync(dirfd)`。
- 失败关闭：任何 errno 不可分类、类型不符、身份/哈希/大小变化均 `SANDBOX_UNVERIFIABLE` 或 `mutation-uncertain`，不静默继续。
- 已知降级：macOS 无 `fcntl(F_GETPATH)` 可用，保留句柄的重命名检测退化为身份级（身份不变即视为稳定）；开放与重开路径仍全量验证。记录于 `product/assumptions.md`。

## 验收

- 全量测试（含既有 27 个失败文件中的集成/浏览器用例）在 macOS 全绿；`tsc`/`build` 绿。
- 新增 posix 适配器焦点测试：身份/类型/枚举交叉、nofollow 拒绝、独占 temp、原子替换、哈希校验失败关闭、清理结果分类。
- `smoke:review`（真实执行链）在 macOS 通过。
