# 配置说明

Cool AI 当前通过进程环境变量配置本地持久化和 execution（执行）隔离目录。应用没有内置自动备份、密钥轮换或灾难恢复服务。

## 环境变量

### `COCKPIT_MASTER_KEY`

- 必须是严格 canonical base64url 编码的 32 字节随机值。
- 用于派生 Provider API key 的本地加密密钥及验证令牌密钥。
- 数据库只保存加密后的 Provider 凭据、掩码和密钥标识，不保存可回显的 API key 明文。
- 未设置、格式错误、丢失或换成另一把密钥后，既有 Provider 凭据无法解密；需在团队配置中重新填写凭据。

PowerShell 生成示例：

```powershell
$env:COCKPIT_MASTER_KEY = node -e 'const { randomBytes } = require("node:crypto"); process.stdout.write(randomBytes(32).toString("base64url"))'
```

不要把真实密钥写进仓库、截图、日志或文档示例。保持数据库可用的同时也要保存对应主密钥；只备份数据库并不能恢复 Provider 凭据。

### `COCKPIT_DB_PATH`

- 默认值：`<仓库目录>/.data/cockpit.sqlite`
- 保存 Provider、技能、Agent、项目、使命、协作、execution、复核、记忆和交付事实。
- 可设为可写的 SQLite 文件路径；父目录会在打开数据库时创建。
- 应用不会在路径不可写时静默回退到内存数据库。

示例：

```powershell
$env:COCKPIT_DB_PATH = 'D:\cool-ai-data\cockpit.sqlite'
```

### `COCKPIT_EXECUTION_ROOT`

- 默认值：`<仓库目录>/.data/executions`
- 保存 execution 的独立 sandbox、manifest、staged 内容和恢复所需文件。
- 完整执行支持要求该目录及相关工作区位于受支持的 Windows x64、NTFS/ReFS 环境。
- 不要与某个项目的 canonical workspace 配成同一路径，也不要在 execution 进行中手工移动或清理。

示例：

```powershell
$env:COCKPIT_EXECUTION_ROOT = 'D:\cool-ai-data\executions'
```

## 一次启动示例

```powershell
$env:COCKPIT_MASTER_KEY = '<你本机保存的 32 字节 base64url 值>'
$env:COCKPIT_DB_PATH = 'D:\cool-ai-data\cockpit.sqlite'
$env:COCKPIT_EXECUTION_ROOT = 'D:\cool-ai-data\executions'
npm run dev
```

## 备份与恢复

1. 先暂停协作和 execution，停止应用进程，避免复制到一半的 SQLite 或隔离状态。
2. 一起备份 SQLite 文件、`COCKPIT_EXECUTION_ROOT` 内容和与该数据库匹配的 `COCKPIT_MASTER_KEY`；密钥应放在数据库备份之外的安全位置。
3. 恢复时保持路径权限、文件系统能力、Node x64 和同一主密钥，然后启动应用检查 Provider、项目、execution 与复核历史。
4. 如果只恢复数据库而缺少 execution 文件，历史记录仍可能可见，但未完成执行、staged 内容或恢复流程可能不可验证；不要猜测成功或直接合入。
5. 如果密钥丢失，只能替换 Provider 凭据；产品没有自动找回、自动轮换或自动重加密功能。

安全边界详见[安全模型](./security.md)，平台限制见[限制与平台](./limits-and-platforms.md)。
