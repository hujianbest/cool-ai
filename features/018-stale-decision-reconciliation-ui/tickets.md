# 任务票 — 陈旧 Inline Decision 对账 UI

- 状态: 待 spec-review；草案不得进入 implement
- 规模: 4 张纵向 RED/GREEN 票；单一 stale reconciliation 用户结果
- 公共缝: fact-only Structured Block Public UI
- TDD: 每票先产生一个公共 UI 行为 RED，再以最小 GREEN 闭合；不得测试私有 hook/state 或弱化断言

- [ ] T-01 纵向闭合 Proposal stale 对账 — Blocked by: None
  - 公共缝: fact-only Proposal Public UI。
  - RED: decision 返回 `VERSION_CONFLICT` 后断言旧动作 disabled、零自动 POST、焦点进入说明并显示最新完整 Proposal；当前至少一项失败。
  - GREEN: conflict 后 GET canonical latest block，以 request epoch 完整替换 state；loading/error/empty 保持旧动作 disabled，说明成为语义焦点目标。
  - 验证: latest 内容/state version/当前决定/允许动作完整；target switch abort；读取重试不发业务 POST。
  - 命令: `npm test -- tests/structured-message-block-ui.test.tsx tests/structured-message-stale-ui.test.tsx`；`git diff --check`

- [ ] T-02 纵向闭合 Checklist 显式新 operation 重试 — Blocked by: T-01
  - 公共缝: fact-only Checklist Public UI。
  - RED: 双客户端制造 stale，证明 UI 按旧 item/action 自动或直接重试、复用 operation，或未展示最新完整 items。
  - GREEN: 展示最新 item 顺序/文本/checked/state version；只有 owner 激活当前合法动作才生成新 operation ID 并用 latest expected version 提交。
  - 验证: item 删除/已达目标/动作失效时无业务 retry；pending 防重复；success 用现有 Receipt；二次 conflict 返回对账且不自动循环。
  - 命令: `npm test -- tests/structured-message-stale-ui.test.tsx tests/structured-message-block-ui.test.tsx`；`git diff --check`

- [ ] T-03 让五种 block 与 source loading 可访问 — Blocked by: T-01
  - 公共缝: fact-only Structured Block Public UI。
  - RED: 对 Proposal、Checklist、Diff Preview、File Reference、Handoff Card 查询 accessible region name，并让 source 保持 pending；证明正式类型、`aria-busy` 或 live status 缺失。
  - GREEN: region name 包含本地化正式类型与既有标题；source pending 设置 busy/status，success/error 清除并准确播报；复用 Cool tokens/components。
  - 验证: loading/empty/error/disabled/success/focus、keyboard、visible focus、44px、WCAG AA；无硬编码视觉值或新徽标系统。
  - 命令: `npm test -- tests/structured-message-block-ui.test.tsx tests/structured-message-readonly-ui.test.tsx`；`git diff --check`

- [ ] T-04 真实浏览器验收 stale reconciliation — Blocked by: T-02, T-03
  - 公共缝: 真实 fact-only transcript + tuple-scoped GET/decision POST。
  - RED: smoke 双页面产生 VERSION_CONFLICT，先锁定网络、DOM、焦点与辅助技术判据。
  - GREEN: 仅补足浏览器 fixture/交互所需最小实现；参考 `D:\clowder-ai` 只核对稳定消息壳、事实收敛、文本标签和窄屏原则，不复制实现。
  - 验证: desktop/narrow、light/dark、keyboard-only、focus、44px、五类型名称、source busy/status、axe 无 serious/critical；冲突后零自动 POST，显式 retry 恰一次全新 operation。随后一次运行受影响全量测试、typecheck/build。
  - 命令: `npm run smoke:structured`；`npm test`；`npx tsc --noEmit`；`npm run build`；`git diff --check`
