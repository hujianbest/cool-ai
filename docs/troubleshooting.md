# 故障排查

## 应用无法启动

**Node 版本不符**

运行 `node --version`。仓库要求 Node.js 24.x，并使用内置 `node:sqlite`。完整 verified execution 还要求 x64 Node.js。

**3000 端口被占用**

```powershell
npm run dev -- --port 3001
```

然后打开 `http://localhost:3001`。

**数据库目录不可写**

将 `COCKPIT_DB_PATH` 指向可写文件路径。应用不会静默回退到内存数据库。确认父目录和 SQLite 文件没有被安全软件或另一异常进程锁定。

## Provider 或凭据失败

**提示主密钥/凭据不可用**

确认启动当前进程的 `COCKPIT_MASTER_KEY` 是 32 字节 canonical base64url，并与保存该 Provider 时使用的值完全相同。密钥丢失或变更后不能从数据库恢复 API key，只能重新填写 Provider 凭据。

**连接验证超时或不兼容**

检查 `GET <baseUrl>/models` 是否在 10 秒内返回不超过 1 MiB 的 JSON object，且 `data[].id` 包含目标 model。3xx 不会跟随；HTTP 地址需要明确确认。

**验证成功，但协作/执行/复核失败**

检查 `POST <baseUrl>/chat/completions` 是否接受 JSON object response format，在 90 秒和 1 MiB 内返回非空 `choices[0].message.content`，并提供合法 usage。详见[Provider 兼容性](./provider-compatibility.md)。

## 协作不继续

- 运行可能正在等待 owner 决策、手工暂停、预算边界或显式重试。
- 页面关闭后没有后台 worker；重新打开只恢复状态，不自动推进。
- usage 缺失/无效、结构输出两次无效、50 轮上限、Agent token/交棒上限都会暂停。
- lease 过期或进程中断后，旧 attempt 不会提交；使用界面提供的显式重试，而不是重复创建事实。

## execution 无法启动或推进

**`SANDBOX_UNVERIFIABLE`**

确认是 Windows 10+/Server 2016+ x64、Node x64、NTFS/ReFS，且工作区与 `COCKPIT_EXECUTION_ROOT` 可由应用访问。其他 OS/架构/文件系统不会降级执行。

**任务不符合条件**

检查任务是否已领取、为进行中、依赖全部完成、负责人仍是项目成员，且该任务/Agent 没有其他 active execution。每项目最多两个 active execution。

**命令等待审批**

核对 executable、参数顺序和工作目录。standing policy 只匹配完全相同的请求；近似命令需要一次性批准。平台不是 OS sandbox，批准前先评估程序可能访问的网络和系统资源。

**stale、conflicted 或 manual recovery**

不要直接复制 staged 文件覆盖 canonical workspace。先查看基线变化、冲突路径、验证结果和恢复状态；外部 writer 的内容会被保留，owner 需按界面选择精确恢复动作。

## 复核或交付被阻止

- 复核者必须是当前成员、具备复核职责/技能，且不是当前 result 的执行者。
- `reject` 后必须产生新 execution/result 版本再复核。
- `escalate` 后先由 owner 回答，再创建新 review attempt；旧裁决不会被修改。
- required diff、validation、artifact、review checkpoint 或 memory association 缺失/不完整时不能 `pass` 或生成最终交付。
- 所有任务必须当前通过，且没有开放升级、返工或人工恢复；最终 delivery 成功持久化后使命才完成。

## 浏览器 smoke 失败

确认本机已准备 Playwright Chromium 运行时。smoke 会创建临时数据库、Provider 和工作区；同时确认系统临时目录可写、端口可用，安全软件未阻止本地 Node 子进程。不要把失败后的 evidence 日志手工改成通过；修复环境或实现后按项目流程重新运行。

更多配置见[配置说明](./configuration.md)，测试命令见[测试与验证](./testing.md)。
