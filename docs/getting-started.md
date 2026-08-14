# 快速开始

## 1. 先确认适用场景

Cool AI 当前是本地优先、单 owner、无登录认证的 Web 应用。只在你信任的本机使用，不要把开发服务器暴露到不可信网络。配置 Agent 后，模型请求及所需上下文会发送到 owner 配置的 Provider，因此产品不是“完全离线”工具。

基础 Web、团队配置和协作界面可以在常见桌面系统上运行；但完整 verified execution（可验证安全执行）只支持 Windows 10+/Windows Server 2016+ x64、Node.js x64，以及 NTFS/ReFS 本地卷。其他平台的文件执行会失败关闭为 `SANDBOX_UNVERIFIABLE`。详见[限制与平台](./limits-and-platforms.md)。

## 2. 环境准备

- Node.js 24.x（包含项目使用的 `node:sqlite`）
- npm 11.x
- 如需运行浏览器 smoke，安装 Playwright Chromium

首次开发安装：

```powershell
npm install
```

在锁文件已确定的干净环境或 CI 中可使用：

```powershell
npm ci
```

## 3. 配置本地环境

Provider 凭据保存需要一个独立的 32 字节 base64url 主密钥：

```powershell
$env:COCKPIT_MASTER_KEY = node -e 'const { randomBytes } = require("node:crypto"); process.stdout.write(randomBytes(32).toString("base64url"))'
npm run dev
```

默认数据库为仓库下 `.data/cockpit.sqlite`，默认 execution 隔离目录为 `.data/executions`。如需更改路径或了解密钥备份影响，请先读[配置说明](./configuration.md)。

## 4. 启动

```powershell
npm run dev
```

打开 `http://localhost:3000`。如果端口被占用：

```powershell
npm run dev -- --port 3001
```

## 5. 走通完整用户路径

按以下顺序完成配置，后一步依赖前一步的事实：

1. 添加并验证 OpenAI-compatible Provider。
2. 创建或编辑文本技能。
3. 创建至少两个职责不同的 Agent，并分配 Provider、技能、工具权限与预算。
4. 不选择文件夹项目即可先与一名 Agent 进行 1:1 对话；需要多人协作时打开本地文件夹，系统会创建或恢复以文件夹名命名且已绑定工作区的项目。
5. 将至少两个 Agent 加入项目，成员之间没有固定 leader。
6. 建立使命和带负责人、依赖关系的任务 DAG。
7. 在项目群聊提交目标，观察 Agent 拆分、领取、交棒；必要时 @Agent、回答决策请求或暂停。
8. 对 DAG-ready 任务启动安全 execution（执行），在隔离区检查文件操作、验证、审批和 staged 变更，再决定合并。
9. 为每个当前结果显式选择一名合格且非执行者的 Agent 独立复核。
10. 处理退回、升级或通过；查看带来源的五类共享记忆。
11. 所有任务独立通过后生成最终交付，核对摘要、结果版本和证据清单。

下一步阅读：[团队配置](./guides/team-setup.md)与[项目工作流](./guides/project-workflow.md)。

![团队配置界面](./images/cool-ai-team-configuration.png)
