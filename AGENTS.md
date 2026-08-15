# AGENTS.md

本文件定义 Cool AI 仓库范围内的编码智能体规则。规则从仓库根目录向下递归生效；子目录中更近的 `AGENTS.md` 可以为其子树补充或覆盖规则。

## 项目

Cool AI 是一个本地优先、单 owner 的多 Agent 协作驾驶舱。

- 技术栈：Next.js 16 App Router、React 19、严格 TypeScript、SQLite（`node:sqlite`）。
- 界面：桌面优先的响应式驾驶舱，使用亮色/暗色设计令牌。
- 测试：Vitest、Testing Library、Playwright 和 axe。
- 运行时：Node.js 24.x 与 npm 11.x。
- 安全模型：可信本机、无身份验证、API 失败关闭、受保护的 Windows 工作区执行。

## 架构地图

### 关键目录

- `app/`：页面、布局、路由处理器和全局样式。
- `components/`：React 产品界面。
- `src/modules/`：目标领域 Module 与唯一公开 Interface。
- `src/application/workflows/`：目标跨 owner Application Workflow。
- `src/adapters/`：目标入站/出站 Adapter；`src/composition/`：唯一生产装配根。
- `src/shared/`：无业务 owner 的最小跨边界基础类型。
- `tests/`：目标上按 Module owner、Workflow、Adapter、browser、architecture 与 owner fixture 分治。
- `product/`：七份关键文档——产品规格说明书（`product.md`）、领域词汇表（`词汇表.md`）、产品架构设计说明书（`architecture.md`）、特性分解清单（`backlog.md`）、开发计划（`development-plan.md`，交付顺序单一事实源）、开发进展（`progress.md`）、UI 设计（`ui/UI设计.md` + `ui/DESIGN.md` 令牌）。决策与假设台账为附录。
- `features/`：特性规格、架构、任务票、评审与进度。
- `.cursor/skills/`：当前 UI/UX 设计技能（`ui-ux-pro-max`）。

### 架构约定

- **分层**：领域模块（`src/modules/`，深模块 + 唯一公开 Interface）→ 出站 Adapter（`src/adapters/outbound/`，SQLite / workspace / model-runtime 等）→ 入站 Adapter（`app/api/` 路由）→ 装配根（`src/composition/`，唯一生产组装点）。
- **依赖方向**：上层依赖下层接口；跨 owner 协作只通过公开 Capability Interface 或 Application Workflow，禁止跨层或跨 owner 深导入。
- **持久化**：SQLite 唯一 current canonical schema（`CURRENT_SCHEMA` 为唯一 DDL 事实源，无版本间 migration）；应用对空库原子 bootstrap、对 exact schema 幂等 reopen，任何非空 legacy / partial / drift / unsupported schema 稳定脱敏失败关闭。本地开发者可人工删除重建 `.data/`，应用绝不静默删除或重建非空数据库。
- **可追溯性**：保留不可变历史、来源身份与冻结 provenance；不得用“最新”实体替换显式选择或冻结的来源。

## 开发指导

### 开始工作

1. **从新上下文开始开发时，先读取 `product/development-plan.md`（开发计划）**，确认当前交付阶段、切片顺序与开发步骤规则；不靠聊天记忆推断工作流状态。文档地图见 `product/README.md`。
2. 读取 `product/progress.md`（开发进展）与当前阶段对应特性的 `progress.md` 恢复工作流状态。
3. 只读取当前特性/阶段的 `progress.md`、`spec.md`、`architecture.md`、`tickets.md`、相关评审，以及存在时的 `CONTEXT.md`。写规格或公开 DTO 时同时对照 `product/词汇表.md`，不得另造同义术语。
4. 不得从聊天历史推断工作流状态；不得仅因旧工件早于当前工作流格式就重启历史特性。
5. 设计、构建或评审界面时，先读 `product/ui/UI设计.md`（UCD）与 `product/ui/DESIGN.md`（令牌），再按需加载 `.cursor/skills/ui-ux-pro-max` 技能；其设计系统/可访问性/交互/排版等指导与检索数据优先于本文件的通用表述。

### TDD 与测试

- 通过公共接缝测试行为，不测试私有实现。
- 一轮循环只包含一个因行为缺失而失败的测试，以及使它通过的最小改动；有效 RED 必须因行为尚未实现而失败，不能只因代码无法编译而失败。
- 机械性改动（identity/断言号同步、测试夹具补字段、纯配置、纯文档、无行为变化的迁移性编辑）可豁免行为性 RED，直接以验证/回归测试收尾；豁免须在票或 `progress.md` 记录理由。不得把行为性功能改动伪装成机械改动。
- 不得弱化断言、跳过测试或 mock 被测主体。
- 优先使用共享、确定性的夹具（`tests/fixtures/sqlite/memory-database.ts`）；新测试默认不需要 DOM，需要 DOM 的测试文件首行声明 `// @vitest-environment jsdom`。
- 不得引入依赖墙钟等待的用例；I/O 重型用例必须设置用例级 timeout。
- 聚焦测试是默认反馈环；全量套件只在收尾与最终确认运行。

常用命令：

```powershell
npm test
npm run build
npm run smoke
npm run smoke:team
npm run smoke:context
npm run smoke:collaboration
npm run smoke:execution
npm run smoke:review
npm run smoke:settings
npm run smoke:onboarding
npm run smoke:threads
```

聚焦测试：`npm test -- tests/<target>.test.ts`

### 代码与契约标准

- TypeScript 严格模式；不得使用不安全类型转换或非空断言绕过领域校验。
- 路由处理器调用领域模块前，必须校验路径、查询参数、内容类型、正文大小和严格 DTO 形态。
- 公共错误使用稳定、已脱敏的 envelope；不得返回原始异常、Provider 响应、提示词、凭据、宿主路径或隐藏推理。
- 持久写入复用 operation/version/lease 语义与事务；重试必须重放事实或明确失败，绝不重复业务动作。
- Project/thread/run 等 ownership tuple 必须联合校验，优先使用复合数据库约束与 tuple-scoped 查询。
- UI 视觉样式复用 `app/tokens.css` 与既有驾驶舱基础元素，不硬编码颜色、间距、圆角、排版、阴影或断点。
- Project/thread/run 切换必须使用规范目标身份与 abort/epoch 检查，防止陈旧读取、轮询、写入和焦点更新。
- 浏览器代码不得直接访问 SQLite、Provider 凭据或宿主文件。

### 安全与本地数据

- 不得提交 `.env` 文件、密钥、凭据、私有工作区内容、`.data/`、sandbox 内容或未经脱敏的浏览器证据。
- `COCKPIT_MASTER_KEY` 必须保留在仓库之外。
- 不得把开发服务器或 API 暴露给不可信网络。
- 不得宣称任意本地可执行文件已被安全 sandbox。

### Git 与生成文件

- 不得 reset、checkout、覆盖或删除无关的用户改动。
- 只有用户或活跃交付流程明确要求时，才能 commit 或 push。
- 提交前检查状态、完整差异、未跟踪文件和近期提交风格；排除秘密与生成噪声。
- 不得提交 `.next/`、`node_modules/`、缓存、`__pycache__/`、临时数据库或生成的 `next-env.d.ts` 变动。
- 浏览器证据必须由测试或冒烟运行器生成，不得手写。
