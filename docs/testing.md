# 测试与验证

所有项目命令以当前 `package.json` 为准。本页不声明 `start`、`lint` 或 `typecheck` 脚本，因为仓库没有这些命令。

## 安装、测试与构建

开发环境安装：

```powershell
npm install
```

按 lockfile 干净安装：

```powershell
npm ci
```

启动开发服务器：

```powershell
npm run dev
```

运行完整 Vitest 测试：

```powershell
npm test
```

生成 Next.js Webpack 构建：

```powershell
npm run build
```

## 浏览器 smoke

首次运行前需准备 Playwright Chromium 运行时。

仓库提供六个 smoke 命令：

```powershell
npm run smoke
npm run smoke:team
npm run smoke:context
npm run smoke:collaboration
npm run smoke:execution
npm run smoke:review
```

- `smoke`：行走骨架、持久化、窄屏与键盘抽屉。
- `smoke:team`：Provider 验证、技能和两个 Agent 配置。
- `smoke:context`：工作区、成员、使命/DAG、记忆和上下文。
- `smoke:collaboration`：真实本地 HTTP Provider、双 Agent 接力、@、决策、usage 与重启恢复。
- `smoke:execution`：双 execution、权限/审批、staged 合并、stale/冲突/人工恢复和重启。
- `smoke:review`：退回、新 result 版本、升级回答、通过、记忆与最终交付。

这些浏览器脚本会创建临时 SQLite 数据库、临时 Provider、临时工作区（execution/review 还会创建临时 execution root），启动真实应用并走公开产品路径。脚本结束时清理临时运行状态，并把截图或机器日志写入对应、已被忽略的 `features/<切片>/evidence/`。这些 evidence 是验证产物，不应被 `docs/` 当作公开图片来源；公开文档使用 [`docs/images/`](./images/) 中受跟踪的截图。

## 证据纪律

HarnessFlow 开发阶段的测试/build/smoke/demo 必须通过 gate runner 生成机器 evidence；不要手写或编辑 evidence 日志。各切片的规格、任务、评审和证据边界见 [`features/`](../features/)。

S-7“项目文档与产品展示”当前获得了产品回归测试豁免，因此本切片只检查 Markdown 链接、双语一致性、图片和真实渲染，不运行 `npm test`。这是本切片因已知环境基线而作的明确例外，**不是**项目常规规范，也不免除后续产品代码变更的测试、构建、smoke、评审和 demo 要求。

故障处理见[故障排查](./troubleshooting.md)。
