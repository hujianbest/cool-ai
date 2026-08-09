# 进度

- 特性: 017-structured-message-integrity
- 当前阶段: done
- 执行模式: auto
- 已加载扩展: 无
- 下一步: 无（017 done；与 018 均 done 后 015 才可第 4 轮 review，018 尚未完成）
- 阶段推进: 2026-08-10 按项目级 review 豁免（AGENTS.md 当前开发阶段条款）跳过 spec/architecture review 直接进入 implement；不伪造评审工件；spec/architecture/tickets 草案转为正式基线
- 注意: 任务票内测试命令为 019 前旧路径，实现时使用新树（tests/modules/public-collaboration/、tests/adapters/sqlite/ 等）；T-04 的 Mission caller 已由 021 修复、busy-timeout 疑似已由 020 内存库消除，届时验证而非重做
- 门禁输出: RESULT: PASS — 可进入 to-spec（2026-08-09）
- 共享理解: auto-approved 2026-08-09
- 用户可感知: 是（File Reference 只展示冻结公开名称）
- 阻塞关系: 本片与 018 均 done 后，015/S-13 才可进行第 4 轮独立 code review
- 规模检查: 5 张票、单一完整性用户结果；不触发拆片阈值
- 评审状态: 未执行；不得伪造 spec-review、architecture-review 或 code-review

## 实施记录

### T-05 真实浏览器与集成验收（2026-08-10）

- UI 改动: `src/shared/transcript-model.ts`（file_reference 分支强制 `publicName` 并映射为 `fileName` 视图字段，缺失即整块 invalid 失败关闭）、`components/collaboration/structured-message-block.tsx`（File Reference 卡片直显冻结 `fileName`，复用既有 structured-block 结构，无新视觉系统/样式）。
- RED 证据: jsdom 新用例 "locks the frozen File Reference public name on the card without fetching the source" 先行失败——卡片仅渲染标题/元数据/来源按钮，冻结名称不在页面（`Unable to find an element with the text: frozen-safe-name.txt`）。
- GREEN: 上述两文件最小改动后，聚焦套件全绿（structured-message-readonly-ui / structured-message-decision-ui / transcript-model，13 用例）；`transcript-model.test.ts` 的 file_reference 夹具补齐 `publicName` 并锁定 `fileName` 映射断言。
- smoke:structured（真实 Playwright，自起服务）: PASS，14 断言 / 3 axe 状态 / providerCalls=2；新增断言 `file-reference-card-shows-frozen-name-before-source-fetch`（改名前卡片直显）与 `file-reference-frozen-name-survives-rename-reopen`（fixture 新增 rename-source 模式将 artifact 改名为 `renamed-later.txt` 后 reload + 进程重启 reopen，卡片与来源面板仍只显示 `safe-report.txt`，改名后名称零出现）。
- 验证矩阵: desktop light/dark 与 narrow dark 抽屉下冻结名称均稳定可见；键盘勾选/取消勾选、Escape 焦点归还与 ≥44px 控件断言通过；axe 三状态 0 违规（无 serious/critical）。
- 泄漏检查结论: smoke 末尾统一安全扫描（html、API 响应体、dev server 日志、落盘证据、results.json）对 apiKey/masterKey/宿主私有路径/私有 prompt/raw provider 内容/`renamed-later.txt` 全部零命中；jsdom 侧断言 DOM 不含 `D:\private` 宿主路径；证据文件见 features/015-structured-messages-inline-decisions/evidence/structured-messages-*.{png,json}。
- 全量验证: `npx tsc --noEmit` 通过；`npx vitest run` 1852/1853 通过，唯一失败为 review 域 `review-browser-full-chain` 的既有不稳定严格模式选择器（记忆标题同时出现在复核与上下文两个面板），与 017 改动面无关，单测复跑通过，记录为遗留风险；`npm run build` 通过。
- 遗留风险: review-browser-smoke.mjs 的记忆断言选择器存在时序性 strict-mode 抖动（建议后续按面板 scope 收敛，超出本票范围）；未执行 git commit（按票要求）。
