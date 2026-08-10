# 架构 — 绑定工作区只读浏览与预览

- 日期: 2026-08-10
- 对应规格: [`spec.md`](./spec.md)
- 状态: 项目级 review 豁免生效；未送独立评审，不伪造工件

## 架构目标

只读浏览是 Project & Workspace 的出站能力：公开查询 → verified 工作区 Adapter → 磁盘。复杂性（路径安全、分类、截断、遮蔽）留在 Adapter；UI 只消费 DTO。

## Module 与 Interface

- Project & Workspace 公开 Queries 新增：
  - `listWorkspaceDirectory(databasePath, projectId, relativePath)` → `{ entries: { name, kind: "dir"|"file", sizeBytes?, sensitive: boolean }[] }`（稳定排序：目录优先、名称决胜）。
  - `readWorkspaceFilePreview(projectId, relativePath)` → 判别联合：`{ kind: "text", content, truncated, sizeBytes, lineCount }` | `{ kind: "image", contentType, dataUrl? 或字节路由 }` | `{ kind: "binary-unsupported" }` | `{ kind: "sensitive-masked" }`。
- 所有路径先经 verified-handle 解析（复用 src/adapters/outbound/workspace/ 现有适配器；勘察其缝后定调用方式）；绑定不存在/未 ready → 稳定错误。
- 敏感判定与分类常量集中在 Adapter 一处；路由只做 DTO 校验与脱敏 envelope。
- 图片字节路由：内容类型白名单 + Content-Length 上限 + no-store。

## 关键流程

1. 树区加载 → list(".") → 渲染；展开 → list(sub)。
2. 选中文件 → preview → 按 kind 渲染（文本 monospace/截断条、图片 img、降级占位、遮蔽占位）。
3. 任何越界/逃逸/读取失败 → fail-closed 脱敏错误；UI 展示错误态。

## Seam 与测试点

- Seam 1 — Browse Query：tests/modules/project-workspace/（新）；临时目录真实文件。
- Seam 2 — 浏览/预览 UI：tests/browser/ 下对应面板测试。
- Seam 3 — smoke 验收（选覆盖工作区面板的现有 smoke，勘察后定）。

## 横切约定

- role=tree/treeitem、aria-expanded/selected、44px、focus 可见；empty/loading/error 全态；tokens；无写入口；无索引/缓存（纯实时读）。

## ADR 链接

- 遵守 ADR-0003；无新增难逆转决定。
