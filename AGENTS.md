# AGENTS.md

本文件定义 Cool AI 仓库范围内的编码智能体规则。规则从仓库根目录向下递归生效；子目录中更近的 `AGENTS.md` 可以为其子树补充或覆盖规则。

## 项目

Cool AI 是一个本地优先、单 owner 的多 Agent 协作驾驶舱。

- 技术栈：Next.js 16 App Router、React 19、严格 TypeScript、SQLite（`node:sqlite`）。
- 界面：桌面优先的响应式驾驶舱，使用亮色/暗色设计令牌。
- 测试：Vitest、Testing Library、Playwright 和 axe。
- 运行时：Node.js 24.x 与 npm 11.x。
- 安全模型：可信本机、无身份验证、API 失败关闭、受保护的 Windows 工作区执行。

关键目录：

- `app/`：页面、布局、路由处理器和全局样式。
- `components/`：React 产品界面。
- `src/modules/`：目标领域 Module 与唯一公开 Interface。
- `src/application/workflows/`：目标跨 owner Application Workflow。
- `src/adapters/`：目标入站/出站 Adapter；`src/composition/`：唯一生产装配根。
- `src/shared/`：无业务 owner 的最小跨边界基础类型。
- `tests/`：目标上按 Module owner、Workflow、Adapter、browser、architecture 与 owner fixture 分治。
- `product/`：产品定义、待办、假设与决策。
- `features/`：特性规格、架构、任务票、评审与进度。
- `.agents/skills/`：当前 HarnessFlow 与领域技能。

## 每个开发任务的起点

1. 读取 `.agents/skills/hf-workflow/SKILL.md`；磁盘上的技能是权威来源。
2. 读取各特性与 `product` 的 `progress.md` 恢复工作流状态，不靠聊天记忆。
3. 只读取当前特性的 `progress.md`、`spec.md`、`architecture.md`、`tickets.md`、相关评审，以及存在时的 `CONTEXT.md`。
4. 只有当前阶段的评审（或被豁免）与确认完成后，才能进入下一阶段。
5. 只加载当前阶段技能及匹配的 `ext-*` 技能。

不得从聊天历史推断工作流状态。不得仅因旧工件早于当前 HarnessFlow 格式就重启历史特性；应明确协调当前活跃特性。

## 交付工作流

使用当前主链：

`grill-with-docs → to-spec → to-architecture → to-tickets → implement → ship`

### 当前开发阶段的 Review 豁免

- 用户已明确决定：当前工程在首次正式发布前的连续开发中跳过 HarnessFlow 的全部 review 环节，包括 spec review、architecture review、`hf-review` 与 `hf-code-review`。
- 本豁免优先于本文件其他要求独立 review、review 确认或 review 工件的条款；不得为了通过流程而伪造 review 结论、确认行或评审文件。
- 因本豁免跳过 review 时，应在对应 `progress.md` 记录“项目级 review 豁免”及日期后继续下一阶段；测试、构建与验收等其他完成条件仍必须满足。
- Review 豁免不免除 TDD、聚焦测试、最终全量测试、类型检查、生产构建、受影响浏览器冒烟、axe、真实 UI 验收、安全边界、任务票勾选、commit 与 push。
- 首次正式发布前必须由用户明确决定是否恢复 review；恢复前须修改本节及相关技能描述，不得静默恢复或继续豁免。

### 通用交付纪律

- 架构优先冻结已于 2026-08-09 由用户确认解除（`product/decisions.md` D-45，特性 019 已合并）；产品功能开发恢复准入，历史冻结条款仅作背景参考。
- 同一时间只处理一张未阻塞的前沿任务票。
- 产品实现与任务票工作必须委派给 subagent。
- 评审必须使用不同的 subagent 或全新会话。
- `auto` 模式只可在独立批准且评审通过（或被豁免）后自动推进。
- 用户可感知工作在 `ship` 前必须有真实浏览器演示和已落盘的验收记录。
- 默认选择必须记录到 `product/assumptions.md`，不得静默扩张范围。

## 切片规模与自动模式护栏

- 一个产品切片必须形成单一、可演示的用户结果，不得把多个独立能力打包成“一个切片”。
- 在规格确认和任务拆分前执行规模检查。出现下列任一条件时，默认先拆片：
  - 超过 8 张实现任务票；
  - 同时涉及新 schema 版本以及 API、领域、UI、浏览器验收中的两个以上独立域；
  - 包含两个以上彼此可单独交付的用户结果；
  - 预计需要跨越一个以上实现 subagent 的完整上下文。
- schema 迁移、基础模块重构和用户功能同时出现时，优先拆成明确的基础切片与产品切片；确需同批时，使用有边界的扩张—收缩批次。
- `auto` 模式不授权扩大切片。建议默认一旦触发规模阈值，必须自动拆片并记录到假设台账，而不是继续堆叠任务。
- 若用户明确要求不拆，必须把例外、风险和验证成本写入 `progress.md`；不得仅以“连续自动执行”为理由绕过规模护栏。
- 同一评审类别连续两轮仍有严重或一般问题时，停止局部补丁循环，返回规格或架构重新评估，并优先拆小切片。

## 在不降低质量的前提下提速

- 广泛搜索前先读取 `CONTEXT.md` 或特性架构。
- 按模块、契约或符号窄搜，避免重复扫描整个仓库。
- 并行批处理互不依赖的只读工具调用。
- 不得重复启动开发服务器；复用已有健康进程。
- 任务票必须纵向、可独立验证，并能在一个上下文窗口内完成。跨不相关领域或多个独立接缝的工作必须拆分。
- 大范围迁移使用明确的扩张—收缩批次，不得靠大量偶发下游修复完成。
- schema 或 API 迁移开始时先建立共享夹具构建器；测试不得在多个文件中复制大型直接 SQL 图。
- 一个契约的所有调用方与夹具应在同一计划迁移波次更新。
- RED/GREEN 期间只跑聚焦测试；类型检查和构建只在有意义的里程碑运行；全量测试只在最终集成与最终修复确认时运行，不得在每个小改动后重复执行。
- 实现阶段只运行受影响的浏览器冒烟测试；全部必需冒烟测试只在最终集成或 `ship` 前运行一次。
- 双轴代码评审每轮共同使用一次由独立评审方发起的全量测试；各评审轴另跑自己的聚焦测试，不得各自重复整套全量测试。
- 评审修复期间先跑发现项对应的聚焦测试；全部发现关闭后只再跑一次全量测试。
- 大型回归修复必须维护具体失败清单，逐项清零，不得反复无目标运行全量套件。
- 避免机会主义重构、格式化噪声和生成文件噪声。

### 时间预算与失控保护

- 单个实现 subagent 通常只承接 2～5 张同模块、同接缝的相关任务票；默认墙钟预算为 30 分钟。
- 单次缺陷诊断或不稳定测试循环默认预算为 15 分钟；达到预算仍无明确根因时，必须停止、报告证据并拆分下一步。
- 不稳定测试默认最多重复 10 次以量化复现率；超过 10 次必须写明统计目的和停止条件，禁止无边界循环 20～50 次。
- 长命令开始前应估计成本。超过预期两倍仍无新信号时，应终止或缩小反馈循环，而不是继续等待。
- subagent 超时、上下文饱和或形成错误假设时，立即交接给新 subagent；不得因已经投入时间而继续错误路线。
- 自动长任务也必须遵守时间预算。无人值守不是取消超时、拆片或报告义务的理由。

### Subagent 连续性

- 同一模块和预先约定测试接缝中的相邻前沿任务票，通常应继续使用上一个实现 subagent。
- 一个实现 subagent 只复用短小且内聚的批次，通常为 2～5 张相关任务票，同时保持每张票的 RED/GREEN 与勾选独立。
- 跨领域、改变架构、上下文饱和或前一个 agent 形成错误假设时，必须启用新的实现 subagent。
- 实现作者不得担任独立评审者。
- 交接时提供事实来源文件路径，不要粘贴整份内容。

## TDD 与测试

- 遵循 `.agents/skills/hf-tdd/SKILL.md`。
- 通过已批准的公共接缝测试行为，不测试私有实现。
- 一轮循环只包含一个因行为缺失而失败的测试，以及使它通过的最小改动。
- 有效 RED 必须因行为尚未实现而失败，不能只因代码无法编译而失败。
- 不得弱化断言、跳过测试或 mock 被测主体。
- 重构不属于 RED/GREEN 循环；应在评审纪律下执行。
- 优先使用共享、确定性的夹具，不使用临时数据库插入。

### 测试执行效率

- 全量套件墙钟必须保持在约 2 分钟以内（2026-08-09 基线：98s）；发现明显变慢时先停下来重构测试执行速度，再继续功能开发。
- 新测试默认不需要 DOM：纯服务端/领域测试不得引入 jsdom 依赖；需要 DOM 的测试文件首行显式声明 `// @vitest-environment jsdom`。
- 需要数据库的测试一律使用 `tests/fixtures/sqlite/memory-database.ts` 的内存库夹具；只有显式文件语义（文件字节断言、跨进程共享、磁盘 reopen/损坏）才允许临时目录文件库。
- 不得引入依赖墙钟等待的用例；I/O 重型用例必须设置用例级 timeout，禁止放宽全局 `testTimeout`。
- 聚焦测试是 RED/GREEN 的默认反馈环；全量套件只在切片收尾与最终确认运行。

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

实现时使用聚焦 Vitest 文件：

```powershell
npm test -- tests/<target>.test.ts
```

## 代码与契约标准

- TypeScript 必须保持严格模式。不得使用不安全类型转换或非空断言绕过领域校验。
- 路由处理器在调用领域模块前，必须校验路径、查询参数、内容类型、正文大小和严格 DTO 形态。
- 公共错误使用稳定、已脱敏的 envelope。不得返回原始异常、Provider 响应、提示词、凭据、宿主路径或隐藏推理。
- 持久写入复用现有 operation/version/lease 语义与事务。重试必须重放事实或明确失败，绝不能重复业务动作。
- Project/thread/run 及其他 ownership tuple 必须联合校验，优先使用复合数据库约束与 tuple-scoped 查询。
- **首次正式发布前 SQLite 只支持唯一 current canonical schema**：不承诺任何历史 schema 或本地开发数据兼容；`openDatabase` 只允许空库原子 bootstrap，或对 current exact schema 做幂等 reopen 与完整数据不变量校验。
- 首次正式发布前不得新增或保留版本间 migration、legacy adoption/backfill、旧 schema fixture 或升级兼容分支。schema 变化必须直接更新唯一 canonical manifest、exact validator、fresh bootstrap tests 与 current-schema reopen tests；任何非空 legacy、partial、drift 或 unsupported schema 均以稳定脱敏错误失败关闭。
- 本地开发者可人工删除并重建 `.data/`；应用绝不能静默删除、覆盖、重命名或自动重建非空数据库。首次正式发布后如需 schema 兼容，必须先以 ADR 决定兼容政策并修改本规则。
- current schema bootstrap 必须原子化；重复打开必须幂等、执行 exact-schema 与数据不变量校验，并在任何漂移或非法 current 数据时失败关闭。
- 保留不可变历史、来源身份与冻结 provenance。不得用“最新”实体替换显式选择或冻结的来源。
- 浏览器代码不得直接访问 SQLite、Provider 凭据或宿主文件。

## UI 标准

- 复用 `app/tokens.css` 与现有驾驶舱基础元素；不得硬编码颜色、间距、圆角、排版、阴影或断点。
- 每个关键交互按适用情况覆盖 loading、empty、error、disabled、success 与 focus。
- 使用语义化 HTML、可见焦点、键盘操作、可访问名称，以及至少 44×44px 的控件。
- 保持 WCAG AA 文本对比度，并用 axe 验证受影响界面。
- 支持桌面布局与现有窄屏抽屉模型。
- 避免未要求的渐变、发光、玻璃效果、装饰动画、emoji 图标、泛化 AI 提示框，以及复制的品牌资产或文案。
- Project/thread/run 切换必须使用规范目标 身份与 abort/epoch 检查，防止陈旧读取、轮询、写入和焦点更新。

## UI 改动工作流

UI 改动具有视觉与交互双重属性，纯文本描述不足以完全传达设计意图。UI 工作必须在标准交付工作流基础上增加视觉验证环节。

### UI 改动的特殊要求

**双模表达（文本 + 视觉）：**
- 设计规范：`DESIGN.md`（产品级设计令牌单一事实源）或等效设计文档
- 视觉预览：`preview.html`/`preview-dark.html`（可交互的设计目录页）或真实页面渲染
- 截图对比：关键页面的 before/after 视觉对比（无法用文本完全描述的效果）

**验证层次（从机器到人工）：**
1. 契约测试：tokens 存在性、命名规范、声明完整性（`tests/browser/cockpit-shell/visual-tokens.test.ts`）
2. 视觉测试：关键页面截图对比、回归检测（视觉变更的可量化验证）
3. 人工验收：真实浏览器打开、交互体验、审美判断（需要人眼判断的部分）

### UI 改动工作流程

```
1. 设计输入阶段（grill-with-docs/to-spec）
   ├── 设计规范文本（DESIGN.md、设计令牌、组件规范）
   ├── 可视化预览（preview.html、Figma、设计稿）
   └── 视觉参考（截图、品牌资产、竞品分析）

2. 设计系统投影（to-tickets → implement）
   ├── tokens.css 映射（DESIGN.md → CSS 变量）
   ├── 组件/壳层收敛（按新 token 统一视觉语言）
   └── 预览页创建（design catalog 供验证参考）

3. 视觉验证阶段（implement）
   ├── 契约测试（tokens 投影完整性）
   ├── 截图对比（关键页面视觉回归检测）
   └── 真实浏览器验收（实际渲染效果确认）

4. 渐进式应用（多切片收敛）
   ├── 壳层与公共组件（优先收敛，影响范围最大）
   ├── 业务面板（逐面收敛，避免一次性改动过大）
   └── 视觉回归测试（确保后续改动不破坏已收敛部分）
```

### UI 改动完成定义

除通用完成条件外，UI 改动必须额外满足：

- 设计规范文本（DESIGN.md 或等效）已落盘为产品级单一事实源
- 可视化预览（preview.html 或真实页面截图）已创建并可访问
- 契约测试通过（tokens 投影完整性、命名规范、声明完整性）
- 关键页面已通过真实浏览器渲染验证（桌面 + 窄屏、亮色 + 暗色）
- axe 可访问性测试 0 serious/critical（对比度、焦点、语义化标签）
- 视觉对比截图已记录（如适用，before/after 证据归档至 `evidence/`）

### 与标准工作流的差异

**超越纯文本 harness flow：**
- 需要视觉预览工具（preview.html、截图对比工具）
- 需要真实浏览器验收（不能只依赖单元测试）
- 需要人工审美判断（颜色、间距、层级是否协调）

**仍遵循的 harness flow 原则：**
- 设计规范是单一事实源（DESIGN.md 或等效）
- TDD：契约测试先行、最小改动通过
- 渐进式收敛：先壳层/公共组件，后业务面板
- 视觉回归：后续改动不能破坏已收敛的设计语言

### 设计工具集成（可选扩展）

如需集成专业设计工具，可考虑：
- Figma API：同步设计 tokens 到 tokens.css
- Percy/Chromatic：自动化视觉回归测试
- Storybook：组件级视觉文档与交互预览

集成时必须保持设计规范为单一事实源，工具输出必须可追溯到 DESIGN.md 或等效文本规范。

## 安全与本地数据

- 不得提交 `.env` 文件、密钥、凭据、私有工作区内容、`.data/`、sandbox 内容或未经脱敏的浏览器证据。
- `COCKPIT_MASTER_KEY` 必须保留在仓库之外。
- 不得把开发服务器或 API 暴露给不可信网络。
- 工作区、文件和进程行为必须保留 verified-handle、sandbox、approval、limits、validation 与 conflict 边界。
- 不得宣称任意本地可执行文件已被安全 sandbox。

## Git 与生成文件

- 不得 reset、checkout、覆盖或删除无关的用户改动。
- 只有用户或活跃交付流程明确要求时，才能 commit 或 push。
- 每个已交付产品切片只应有一个聚焦 commit 和一次 push。
- 提交前检查状态、完整差异、未跟踪文件和近期提交风格；排除秘密与生成噪声。
- 不得提交 `.next/`、`node_modules/`、缓存、`__pycache__/`、临时数据库或生成的 `next-env.d.ts` 变动。
- 浏览器证据必须由测试或冒烟运行器生成，不得手写。

## 完成定义

只有满足以下全部条件，特性才算完成：

- 所有任务票已勾选；
- 聚焦测试与全量测试通过；
- 生产构建与必需浏览器冒烟测试通过；
- 受影响 UI 已完成真实渲染与可访问性验证；
- 独立 Standards 与 Spec 评审通过；
- 用户可感知工作已记录演示验收；
- `ship` 阶段完成（评审与验收记录齐备）；
- 产品、上下文与假设记录已更新；
- 工作树不存在意外工件；
- 用户要求的 commit 与 push 已成功。
