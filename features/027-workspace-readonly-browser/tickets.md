# 任务票 — 绑定工作区只读浏览与预览

- 状态: 项目级 review 豁免生效，直接进入 implement
- 规模: 4 张纵向 RED/GREEN 票；单一"只读看懂绑定工作区"用户结果
- 公共缝: Workspace Browse Query、浏览/预览 UI
- TDD: 每票先一个公共行为 RED，再最小 GREEN；内存库夹具；文件语义用临时目录真实文件

- [x] T-01 只读浏览查询与路径安全 — Blocked by: None
  - 公共缝: Workspace Browse Query。
  - RED: 查询不存在；越界/遮蔽/降级行为未定义。
  - GREEN: `listWorkspaceDirectory` + `readWorkspaceFilePreview`（verified-handle 解析、越界/逃逸 fail-closed、文本/截断/图片/二进制降级/敏感遮蔽分支）；tuple-scoped GET 路由（严格校验、脱敏 envelope、图片字节白名单）；装配根登记；零 schema 变更。
  - 验证: 树列举排序、嵌套/空目录、越界各形态（..、绝对、链接逃逸）、文本/截断/图片/二进制/遮蔽、tuple 404。
  - 命令: 聚焦 tests/modules/project-workspace/；`npx tsc --noEmit`

- [x] T-02 目录树 UI — Blocked by: T-01
  - 公共缝: 目录树 UI（jsdom）。
  - RED: 无文件区/树；键盘与状态缺失。
  - GREEN: 工作区面板内"文件"区：role=tree 懒加载目录树（目录优先排序、aria-expanded/selected、方向键导航、44px、focus 可见）；empty/loading/error 全态；选中文件触发预览区。
  - 验证: 展开/收起/键盘/选择、状态矩阵、target switch 不串。
  - 命令: 聚焦对应 UI 测试；`npx tsc --noEmit`

- [x] T-03 只读预览 UI — Blocked by: T-02
  - 公共缝: 预览 UI（jsdom）。
  - RED: 预览分支均未渲染。
  - GREEN: 文本 monospace + 行数/大小元信息 + 截断条；受支持图片内联；二进制降级与敏感遮蔽占位（不回显）；无任何写/删/改入口断言；tokens。
  - 验证: 四分支渲染、截断提示、遮蔽不回显（DOM 断言无内容泄漏）、focus/键盘。
  - 命令: 聚焦对应 UI 测试；`npx tsc --noEmit`

- [x] T-04 真实浏览器验收 — Blocked by: T-03
  - 公共缝: 真实绑定工作区 + tuple 路由。
  - 验证: 临时目录真实造数（嵌套/图片/二进制/.env/大文件）→ 树浏览→预览各分支→遮蔽不回显→越界拒绝；desktop/narrow、light/dark、keyboard、focus、44px、axe 无 serious/critical；秘密扫描证据无泄漏；随后一次性全量 `npx vitest run` + `npx tsc --noEmit` + `npm run build`。
  - 命令: 复用覆盖工作区面板的现有 smoke（勘察后定）；全量一次；`npm run build`
