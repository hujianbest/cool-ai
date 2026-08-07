# Clowder 能力继承决策计划

- 日期: 2026-08-08
- frame: ./frame.md

## 1. 需求

### FR-1: 可追溯继承目录
- 描述: 只收录 Clowder 已接通的正式用户能力与可复用设计原则；每项具有稳定 ID、分类、说明、Clowder 证据、Cool 状态、建议、风险和最终决定。
- 验收标准:
  - Given 两仓源码与现有产品工件 When 读取目录 Then 每项至少有一个可定位源码证据，且状态限定为已有、部分、缺失或冲突
  - Given 未完成、隐藏后端、演示能力或品牌资产 When 归档 Then 它们只出现在排除附录，不进入待继承清单
  - Given Clowder 的正式页面、导航入口、设置分区、API 路由和设计规范入口清单 When 交叉核对目录 Then 每个入口已映射到条目或排除附录；无条目的分类显式记录“无”及依据

### FR-2: 按类逐项确认
- 描述: owner 按 8 类依次确认，每项只能决定为继承、不继承、延后或已有保持，并保留理由与依赖。
- 验收标准:
  - Given 一类待确认项 When owner 提交确认 Then 该类每项都有唯一决定、确认日期和聊天确认引用，且类级完成标记引用同一轮确认
  - Given 条目没有有效 owner 确认引用 When 检查决定 Then 它保持待确认，禁止从建议自动推导
  - Given 决定为继承或延后 When 记录 Then 依赖、风险和建议优先级仍可追溯

### FR-3: 产品范围回写
- 描述: 全部项目确认后，把边界变化追加到产品定义与决策记录，并把继承/部分继承项拆成独立垂直切片 backlog。
- 验收标准:
  - Given 全部 8 类已确认 When 回写产品层 Then `product.md` 不再与已确认决定冲突，`decisions.md` 只追加不改历史
  - Given 已有保持、不继承、延后或继承 When 生成 backlog Then 只有需要近期实现的缺口成为未完成切片，已有项不重复实现

### FR-4: 品牌与安全边界
- 描述: 所有获批能力依据 `product/architecture.md` 横切约定与 `product/product.md` 安全边界重新实现，不复制 Clowder 源码或品牌资产，不削弱工作区边界、sandbox、凭据保护、审批、独立复核和审计规则。
- 验收标准:
  - Given 任一继承项 When 形成实施切片 Then 切片描述不含 Clowder 名称、猫角色、Logo、文案、图片、精灵或源码搬运
  - Given 每个继承项 When 记录目录 Then `安全影响` 必填为无、适用契约或冲突，并引用上述产品依据
  - Given Clowder 能力与 Cool 安全边界冲突 When 决定继承 Then backlog 明确列出适用的工作区、sandbox、凭据、审批、复核和审计约束

## 2. 设计

### 工件
- `inheritance-catalog.md`: 本特性的单一继承目录与决定事实源。
- `product/product.md`: 只回写最终确认后的产品边界。
- `product/decisions.md`: 只追加本轮确认形成的决策。
- `product/backlog.md`: 只追加需要实现的垂直切片。

### 目录分类
1. 应用外壳、导航与设计系统
2. 聊天、线程与 Agent 协作
3. 项目、工作区与安全执行
4. Mission、任务与审批治理
5. 记忆、检索与知识管理
6. Provider、Skill、设置与运维
7. 通知、外部集成与自动化
8. 导出、回放、桌面形态与其他正式体验

### 条目契约
```text
ID | 名称 | Clowder 状态/证据 | Cool 状态/依据 | 建议 | 风险/依赖 | 安全影响/依据 | 决定 | owner确认日期/引用 | 决定理由
```

- `决定` 初始为 `待确认`，只能由 owner 的逐项答复改为 `继承|不继承|延后|已有保持`；每类另有 `类别确认完成: 日期 + 聊天引用`。
- Clowder 证据必须位于 `D:/clowder-ai`，Cool 证据必须位于仓库路径或产品工件。
- Cool `已有/部分` 引用实现路径；`缺失` 引用入口/路由枚举中无实现的核对结果；`冲突` 引用 `product.md`、`decisions.md` 或 `architecture.md` 的具体边界。
- 同一能力跨多个页面时保持一个业务条目，以用户可完成的结果而非组件数量计数。

### 关键决策
- 目录存放方案：选择特性内 `inheritance-catalog.md`，而不是提前写入产品层；理由是未确认项不是产品承诺。
- 实施拆分方案：选择确认完成后按用户可演示价值拆垂直切片，而不是按 Clowder 页面或源码包复制；理由是保持 Cool 架构和验收闭环。

### 错误与冲突处理
- 证据不足或 Clowder 仅部分接通：移入排除附录，不向 owner 表述为正式能力。
- 决定与现有产品边界冲突：保留原决定并在新 `decisions.md` 条目显式注明被后续决定取代，不删除历史。
- 继承项依赖未获批项：标记阻塞依赖，不能排入近期实施 backlog。

## 3. 测试策略

- 基线: 010 不修改代码；先由 009 或独立恢复切片恢复 `npm test` 全量成功，成功前 010 的 T-2 至 T-5 均阻塞。
- 目录验证入口全集:
  - 页面: `rg --files packages/web/src/app -g "page.tsx"`，逐一映射 22 个 App Router 页面。
  - 导航: 核对 `components/ActivityBar.tsx`、`components/{memory/MemoryNav,signals/SignalNav,settings/SettingsNav}.tsx` 与 `components/settings/settings-nav-config.ts` 的全部入口。
  - API: `rg --files packages/api/src/routes -g "*.ts"` 枚举候选，再以 `packages/api/src/index.ts` 的 import/register 调用确认正式注册；未注册文件进入排除附录。
  - 设计: 核对 `docs/design/*.md`、`docs/design-system.md`、`app/theme-tokens.css`、`app/console-tokens.css` 和 `app/console-shell.css`，只收录被现行组件消费的原则。
  - 对上述清单逐入口标注正式条目 ID 或排除 ID，并用路径存在检查复核；分类为空也保留核对结果。
- 决策完整性: 8 类均有类别完成标记，且所有正式条目有合法枚举、owner 确认日期和聊天引用后才允许回写产品层。
- backlog 约束: 每个新切片反向引用至少一个获批 ID，并逐项检查品牌禁用项及适用的工作区、sandbox、凭据、审批、复核和审计约束。
- 回归: 本特性只改文档；产品层回写后运行文档结构检查与 `hf_gate.py check`。

## 4. 任务清单

- [x] T-1 [verification-only] 核验外部恢复切片已恢复环境基线 — 判据: 直接运行 `npm test` 全量退出 0；未通过时 T-2 至 T-5 不得开始
- [x] T-2 [verification-only] 固化继承目录与排除附录 (覆盖: FR-1, FR-4) — 判据: 8 类均有入口枚举核对，正式条目有 Clowder 证据、符合状态语义的 Cool 依据、安全影响和建议，排除项不进入确认清单
- [x] T-3 [verification-only] 按 8 类逐项取得并记录 owner 决定 (覆盖: FR-2) — 判据: 8 个类别完成标记齐全，所有正式条目有唯一合法决定、owner 确认日期和聊天引用
- [x] T-4 [verification-only] 回写产品边界与决策 (覆盖: FR-3, FR-4) — 判据: T-3 完成后，product.md 与最终决定一致，decisions.md 只追加且保留历史
- [x] T-5 [verification-only] 拆分实施 backlog (覆盖: FR-3, FR-4) — 判据: T-3 完成后，每个新切片引用获批 ID、具有用户可演示判据和依赖顺序，且明确品牌禁用项及适用的工作区、sandbox、凭据、审批、复核和审计约束
