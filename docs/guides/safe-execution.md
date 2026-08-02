# 安全执行

execution（执行）让 Agent 在项目工作区之外的独立 staging sandbox 中读取、修改文本文件并运行获准命令。平台在合入 canonical workspace 前检查权限、路径、资源、基线、验证和冲突。

## 支持前提

完整 verified execution 只支持 Windows 10+/Windows Server 2016+ x64、Node.js x64 和 NTFS/ReFS 本地卷。其他 OS、架构或文件系统上的文件执行会失败关闭为 `SANDBOX_UNVERIFIABLE`，不会降级成只检查字符串路径。基础 Web、配置和协作可用不代表完整执行受支持。

## 启动条件与并发

- 任务必须属于当前项目、已领取、状态为进行中且所有依赖已完成。
- 同一项目最多两个 active execution。
- 同一任务最多一个 active execution。
- 同一 Agent 同时最多一个 active execution，也最多一个在途 execution 模型调用。
- 有依赖关系的任务不能并行；两项 execution 的状态与控制彼此独立。

## 一次执行的流程

1. 冻结任务、依赖、项目上下文、工作区基线和验证政策。
2. 在 `COCKPIT_EXECUTION_ROOT` 下建立独立 sandbox。
3. Agent 通过结构化 `list`、`read`、`write`、`command` 动作工作；命令以 executable + args 直接启动，不经任意 shell 字符串。
4. 平台校验权限、路径和资源限制。越界、reparse/特殊文件、二进制或超限操作失败关闭。
5. 精确命中 owner 保存的验证政策可按 standing approval 运行；未命中但未被机械禁止的命令进入一次性审批。
6. owner 查看 staged 预览、验证结果、基线变化和冲突。
7. 仅低风险、UTF-8 文本、基线未变、验证成功且无冲突的变更可自动合入；其他情况等待 owner 处理。

## 审批与合并边界

验证政策只授权完全相同的 executable、参数顺序和工作目录；近似命令不继承授权。一次性批准只绑定该精确请求。包安装、网络工具及其他无法静态证明副作用的程序需要明确审批，机械识别出的越界、shell 语法、远程发布和危险参数会直接拒绝。

平台 guardrail **不是 hostile OS sandbox**。即使命令已获批准，本地程序仍可能访问网络、其他本机文件、进程、服务或凭据。只批准你理解并信任的程序；需要抵抗恶意代码时应使用本产品范围外的容器、虚拟机或 OS 隔离。

合并前检测到 stale 基线、同路径并发修改、删除、重命名、二进制、权限变化、验证失败或资源超限时不会静默覆盖。若提交/恢复窗口发现外部程序改写 canonical 文件，平台保留外部内容并进入冲突或人工恢复状态。

## 资源和恢复边界

- 单个 sandbox：最多 100,000 个目录项、2 GiB。
- 单次文本读取/写入：最多 1 MiB；目录列举最多 1,000 项。
- 单个 execution：最多 20 个模型业务回合、40 次工具调用、15 分钟业务墙钟。
- 单命令：最多 120 秒；stdout/stderr 各最多保留 1 MiB，超出会截断并标记。
- 自动合入：最多 100 个 UTF-8 文本新增/修改，总最终内容不超过 10 MiB。

刷新或重启后状态可读取，但没有后台 worker，也不会跨重启无人值守自动推进；owner 必须显式继续、重试或处理恢复。

![安全 execution、审批与 staged 变更](../images/cool-ai-safe-execution.png)

平台与安全声明的完整版本见[安全模型](../security.md)和[限制与平台](../limits-and-platforms.md)。
