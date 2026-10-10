# 进度

- 特性: 066-posix-verified-workspace
- 当前阶段: implement（T-01～T-05 完成，待 code-review/ship 收口）
- 执行模式: auto
- 已加载: 无（无 UI 面）
- 下一步: 三条冒烟残留（A-401/A-412/引导遮挡）另行收口后统一 ship。

## 状态记录

- 2026-10-11 立项：用户指示「清掉三条冒烟残留，然后切换目标平台为 macOS」。摸底 macOS 全量失败面 135 例（27 文件）：Windows 原生层/沙箱执行失败关闭 116、08-29 两次 UI 提交回归 6、Node 26 localStorage 原型差异 7、其余连带。spec 落盘（A-464）。
- 2026-10-11 前置快修（非本片票，机械/回归修复）：主题按钮水合前中性标签「切换主题」（A-469，保留 154241b 可点性、恢复不虚报）；`width: max-content` 令牌化 `--menu-width`、菜单项 `min-height` 回 `--control-min`、令牌纪律测试 `!important` 归一化（A-470）；三处 storage 注入测试改挂 `Object.getPrototypeOf(window.localStorage)`（A-468）。聚焦 220/220 绿。
- 2026-10-11 T-01 完成：`posix-native-koffi.ts` 绑定 libSystem（openat/fstatat/getdirentries/renameat/mkdirat/unlinkat/lseek；open 标志取自 `fs.constants`——硬编码 Linux 值曾致 O_NOFOLLOW 静默失效与 O_ALERT 挂死；koffi 变参须「类型串+值」成对传参，固定 4 参签名会丢 mode 使文件 mode 000，A-467）。
- 2026-10-11 T-02 完成：`posix-native-read-adapter.ts` 镜像 Windows 读协议（root realpath+lstat 身份锚定、O_NOFOLLOW 相对打开、getdirentries 枚举 + fstatat 权威 64 位身份交叉、链式规范路径、`lseek` 重绕目录游标——getdirentries 的 fd 游标持续推进，无重绕则第二次 list 恒空）。焦点 6/6。
- 2026-10-11 T-03 完成：`posix-native-write-adapter.ts` + merge lifecycle 全量镜像（独占 temp O_CREAT|O_EXCL 0600、分块写+fsync、同父 renameat 原子替换、unlinkat、目录 fsync、逐步身份/哈希自证、condition-mismatch/mutation-uncertain/cleanup 分类、ownerId 嵌名校验）。焦点 7/7。
- 2026-10-11 T-04 完成：平台路由——`windows-verified-execution-adapter` 参数化为 `createVerifiedExecutionAdapters(core)` + windows/posix 工厂 + `createPlatformVerifiedExecutionAdapters` 路由（VerifiedFileAdapter 中性化）；`createDefaultSandboxFsAdapter`/`createPlatformNativeReadAdapter` darwin 分支；`createVerifiedMergeAdapter` 路由（merge-journal 默认值）；8 处 API 路由接点换路由工厂。darwin 路径键与 win32 一致大小写折叠（13 处，A-465）。
- 2026-10-11 T-05 完成：Windows 单测平台门控（describeWindows，4 文件 49 例在 win32 之外跳过，posix 等价测试补位 13 例）；平台中立集成测试换平台底座（write-stage/orchestrator/snapshot/browse/edit/sop-state/merge 四族）。全量 335 文件 / 2890 用例连续两次全绿（52 skip 为 Windows 门控）；`tsc`/`build` 绿；`review-browser-full-chain` 真实执行链在 macOS 过。平台文档（README×2、docs×2、AGENTS、product.md、architecture.md）与假设 A-464～A-470 落盘。

## T-06 冒烟残留与尾随修复（2026-10-11）

- smoke:onboarding 全绿：引导卡不再参与 `.cockpit-flow` flex 高度争夺（`.cockpit-flow > section.stack:not(.onboarding-guide)`）+ 团队资源面板 `cockpit-flow-scrollable` 允许整列滚动（修复「聚焦合格 Agent 被时间线拦截」）；对比度收口 4 项（线程 tab、composer-hint、消息时间戳与条目 meta、msg role-tag）；`settleAnimations` 保证 axe 采样落定态（主题切换 150ms 背景过渡曾被采到中途色）；陈旧段现代化（首页 ready 语义、改绑对话框流程、使命交接到治理视图、群聊→对话术语）；产品修复：`onFocusMission` 冷路径在看板挂载后重试点击创建并按轮询聚焦表单（A-477/A-378）。
- smoke:context 全绿：工作区浏览面从引导步进入（A-401 口径）；4 处 axe 全部前置 settle；同一套陈旧断言现代化（改绑对话框、向导交接、自带 Agent 语义的精确计数与审计事件数、术语）；测试侧修正 macOS `/var → /private/var` 的 getcwd 归一化比较。
- smoke:execution 全绿：审批/审计视图改由图标轨（Cmd/Ctrl+4/5）打开；「运行详情」治理视图承载执行摘要与救援（openRunTab）；术语与按钮名对齐（批准执行/驳回）；两张同名卡以失效徽标收窄定位；对比度（needs-me）修复；Escape 嵌套守卫（A-476）；execution-panel 最近两条执行排序（A-475）；安全扫描仅对数据库表面豁免按设计落库的 at-rest 路径（A-477 口径）；修复 `已过期`/计数/审计轨迹断言到自带 Agent 语义。
- 冒烟全景：smoke / team / review / settings / onboarding / context / execution 全绿；collaboration 停在 run 表面决策 UI（050 progress 记录缺口）；threads/structured 完成术语与基座现代化，尾部 run 表面段落待独立工作流（A-479）。
- 验证：全量 `npx vitest run` 339 文件 / 2942 用例（335 文件 2890 例通过，4 文件 52 例为 Windows 平台门控 skip；偶发 1-2 个真实浏览器时序用例单跑即过）；`npm run build`、`npx tsc --noEmit` 绿；7 条冒烟在终态构建全绿。代码门见 `hf-review` 结论（另行记录）。
- 视觉双闸（AGENTS.md 规则 8）：像素基线 diff 通过（`npm run smoke` 三视图 0 px / 0.000%）；视觉评审未执行（Provider 未配置）——本机无 `COCKPIT_VISUAL_REVIEW_*`，`npm run review:visual` 按失败关闭输出未配置原因，不宣称评审通过。

## 独立代码门评审（2026-10-11，hf-review 代码门 Standards + Spec）

- 结论：初审「需修改」（无阻塞性代码/安全缺陷；必改项为台账/记录类）。评审者逐行镜像比对 posix 层与 Windows 层，并以独立 koffi 探针复现 struct stat 偏移、dirent 布局、O_NOFOLLOW、变参 mode=600、getdirentries rewind 必需性等 ABI 事实，全部与实现一致。
- 必改项收口：(1) 假设编号与并行会话的 A-471～473 撞号 → 本片六条重编号为 A-474～479 并同步全部引用（无重复编号）；(2) 视觉双闸记录补齐（像素基线 0 px 通过 + 视觉评审未执行/Provider 未配置）；(3) A-465 实测 13 处并补大小写敏感卷上的「误放 vs 报错失败关闭」边界说明；A-475 补记 auto-advance 集合随展示窗口改为最新两条。
- 次要项处置：posix 死代码清理（errno 常量表、O_APPEND/O_TRUNC、写核心未用的 listedEntry、conditionalReplacePrepared 未用 temp 绑定）；`AT_FDCWD` 加注（实测本内核任意负 dirfd 等同 AT_FDCWD）；冒烟安全扫描豁免收窄为精确路由形状（`/api/directory-picker` + `/api/projects/:id/workspace$`）。清理后 `tsc` 绿、posix 聚焦 13/13、`smoke:execution` 复跑全绿。
- 终判：复审确认两处行级引用修正后 **PASS**（代码、测试、安全与闸门无遗留；评审者以独立 koffi 探针对 ABI 与失败关闭语义完成外部复现）。
- 遗留改进（登记，不阻塞）：(a) darwin 原生层测试覆盖不对称——Windows 原生 52 例在 darwin 门控跳过，posix 替换件 13 例，缺 `post-replace-unverifiable` 分类、replace/delete 竞争、merge 逐级故障、常量/ABI pinning 的对位断言（merge 层四族集成 30/30 在真实文件系统上覆盖条件替换/删除/清理，缓解但不等价）；(b) `createPlatformNativeReadAdapter` 的单一 cast 缝建议改为共享最小结构接口；(c) 「定位来源执行」与 run 表面决策答复在 P1 会话面无可达成功路径（A-474/A-479 同族），需产品决策：恢复 run 表面或重挂决策答复，建议立独立特性。
