# 绑定工作区只读浏览与预览需求规格

- 日期: 2026-08-10
- 特性: 027-workspace-readonly-browser
- 对应切片: S-22（CI-3.2）
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto（用户不在场，问题按助手推荐处理并记录假设）
- 共享理解来源: `product/backlog.md` S-22 条目（auto-approved 2026-08-10）；前置 `CAP-PWS-01`、`CAP-EXE-01` 已交付核心
- 公共行为接缝: Workspace Browse Query（Project & Workspace）；Workspace 浏览/预览 UI
- 主子系统: Project & Workspace；主 Capability: `CAP-PWS-02`（本片建立其多绑定根只读浏览、预览与敏感降级）

## 问题陈述

项目绑定了工作区根目录，但 owner 无法在驾驶舱内查看其中内容：想看一个文件、确认目录结构、读段代码，都必须离开产品打开资源管理器或编辑器。

## 解决方案

为已绑定工作区提供只读浏览与预览：目录树浏览（懒加载）、文件只读预览（文本/代码 monospace、受支持图片资产），所有路径访问经 verified-handle 限定在绑定根内；越界、符号链接逃逸、二进制（非受支持图片）、超大文件、敏感文件（如 .env、密钥材料）得到明确拒绝或降级占位，绝不回显内容。本片完全只读：无任何写/删/改入口。

## 用户故事

1. **作为 owner，我想浏览绑定工作区的目录树，从而理解项目结构。**
   - 树视图懒加载目录；条目含类型图标语义（目录/文件）；键盘可展开/收起/移动；空目录与加载失败有明确状态。
   - 目录列表拒绝越界路径（`..`、绝对路径、链接逃逸），稳定脱敏错误。
2. **作为 owner，我想只读预览文件内容，从而不离开产品确认细节。**
   - 文本/代码：monospace 预览 + 行数/大小元信息；超大（默认 >512KiB，可调常量）截断并明示"已截断"。
   - 受支持图片（png/jpeg/gif/webp）：内联渲染；其他二进制：明确"不支持预览"降级占位。
   - 敏感文件（.env、*.pem、*.key、credentials 等既有遮蔽词汇；先勘察是否已有敏感分类器可复用，如 public-text-credential-classifier）默认遮蔽：显示"敏感文件已遮蔽"占位，不回显内容。
3. **作为 owner，我相信浏览绝不越界也不可写，从而放心使用。**
   - 全部访问经 verified-handle；任何解析失败/越界/逃逸 fail-closed。
   - UI 无编辑/删除/重命名入口；刷新后视图与磁盘一致（纯实时读，不建索引/缓存）。

## 实现决策

- Project & Workspace 模块公开只读查询：`listWorkspaceDirectory(projectId, relativePath)` 与 `readWorkspaceFilePreview(projectId, relativePath)`（命名对齐现有 queries 风格）；多绑定根：现有 WorkspaceBinding 为单根，本片 API 以"当前生效绑定根"为范围，若未来多根落地则自然扩展——记录假设，不在本片建多根管理。
- verified-handle：复用 `src/adapters/outbound/workspace/` 现有 verified 适配器能力（先勘察其公开缝与路径校验语义）；不得绕过直接 fs 访问。
- 分类：magic/扩展名判定文本 vs 受支持图片 vs 其他二进制；大小上限与截断；敏感词汇表最小集合（.env*、*.pem、*.key、*credential*、*secret*——落假设台账）。
- 路由：tuple-scoped GET（目录列表 / 文件预览），严格校验 relativePath（拒绝对路径/..）、查询参数、响应大小；预览内容以 JSON（文本）或带内容类型白名单的字节流（图片）返回。
- UI：项目工作区面板内新增"文件"区（形态贴合现有面板/tab 范式）；树 + 预览双栏或抽屉（按现有窄屏模型）；tokens/44px/键盘/aria（tree 语义 role=tree/treeitem）。
- diff 预览：演示判据含 diff——本片 diff 范围限定为"若现有 staged-change 事实已有 diff 数据则展示，否则不建"；勘察后把结论记假设台账（大概率范围外移交后续 Safe Execution 编辑片 S-42）。

## 测试决策

- TDD 每轮一个公共缝 RED + 最小 GREEN；内存库夹具；文件系统用临时目录造真实文件（verified-handle 语义要求真实路径——此类测试允许临时目录，属显式文件语义豁免）。
- **Query seam**：树列举、嵌套、空目录、越界/逃逸各形态、文本预览、截断、图片、二进制降级、敏感遮蔽、tuple 404。
- **UI seam（jsdom）**：树展开/键盘、预览渲染各分支、状态矩阵、无写入口断言。
- **浏览器验收**：真实绑定临时工作区跑 smoke（复用现有绑定造数），desktop/narrow、light/dark、keyboard、axe。

## 范围外事项

- 编辑/保存/删除/重命名（S-42）；全文搜索（CAP-OPS 投影）；多绑定根管理 UI；语法高亮库；大文件分页流式阅读。
- 版本历史、git blame。

## 补充说明

- 单一用户结果（只读看懂绑定工作区）；安全边界（verified-handle/遮蔽/降级）是验收核心；预计 4 张票。
- 评审按项目级 review 豁免跳过；默认选择记入 product/assumptions.md。
