# 进度

- 特性: 023-thread-drafts（对应切片: S-15 / CI-2.12）
- 当前阶段: done
- 执行模式: auto（用户 2026-08-09 明示：不在电脑前，问题按助手推荐处理）
- 已加载扩展: 无
- 下一步: 无（done；演示验收证据见 T-05 实施记录与 smoke 落盘证据）
- 用户可感知: 是
- 评审状态: 项目级 review 豁免（2026-08-09）；不伪造评审工件；spec/architecture/tickets 由主会话按 backlog S-15 已确认条目直接产出
- 共享理解: backlog S-15 条目视为 auto-approved 2026-08-10；S-14 回复来源前置已于同日 ship

## 实施记录

- 2026-08-10 特性开立：S-15 前置（CAP-COL-01、S-9 偏好 Adapter、S-14 回复来源）均已交付，直接 to-spec → to-tickets 进入 implement。
- 2026-08-10 T-05 真实浏览器验收通过（smoke:threads，`tests/browser/persistent-threads-browser-smoke.mjs` 新增草稿/历史验收段）：
  - 草稿连续性：文字 + 附件占位 chip（{name,size}）+ 回复链接 chip 刷新后全部恢复（`draft-restore-text-attachment-reply-after-reload`）；选定历史运行后草稿保留，发送成功本地与服务端草稿均清空、刷新后 composer 为空（`draft-survives-run-selection-clears-after-send-reload`）。
  - 敏感降级：敏感样例文本防抖保存返回 `contentSaved:false`、中性提示可见、服务端 draft.content 为空且响应不含样例；清空输入触发 DELETE 且服务端 draft 为 null（`draft-sensitive-content-skipped-server-evidence`）。
  - 输入历史：发送后面板内搜到该输入；空命中态可见；历史项键盘激活回填 composer 并焦点落入输入框；Escape 关面板且焦点回到入口按钮（`input-history-search-keyboard-fill-escape-light-dark-axe`）；两段确认清除全部（先取消再确认），DELETE 200 后列表与 API 均为空、lastClearedAt 存在（`input-history-clear-two-step-confirm-api-empty`）。
  - 矩阵覆盖：desktop/narrow、light/dark 均过 axe（11 个状态全部 0 serious/critical、0 对比度违规）；narrow 下历史面板全部交互控件 ≥44px；分层 Escape（面板关闭、任务编辑 dialog 保持）通过（`input-history-narrow-44px-axe-layered-escape`）。
  - 证据卫生：smoke 收尾校验 DOM/DB/API 响应体/服务器日志/落盘证据不含 apiKey、masterKey、Bearer（`no-secret-db-api-dom-evidence`）；证据落盘 `features/014-persistent-project-threads/evidence/persistent-threads-{draft-restored,input-history}.png` 与 results.json（assertions=20，axeStates=11）。
  - 验收中修复的真实缺陷（T-04 实现补强）：① 历史面板 Escape 改用 region 原生 keydown 监听消费——任务编辑 dialog 的 Escape 关闭走 dialog 元素原生监听，先于 React 合成事件，原 stopPropagation 无法拦截；② 两段确认控件卸载后焦点回落 <body> 导致 Escape 失效，新增确认关闭后焦点返还「清除全部」触发钮；③ 补齐搜索框 placeholder 与 `--full-width` token（input-placeholders / visual-tokens 标准套件）。
  - smoke 文件增益：新增失败诊断 catch（落盘 failure txt/png 后重抛），仅失败时产生工件。
  - 最终确认：全量 `npx vitest run` 239 文件 / 1988 测试全绿（109s）；`npx tsc --noEmit` 干净；`npm run build` 通过；最终代码上 smoke:threads 复跑 PASS。
  - 观察项（未改动）：首次 smoke 运行曾在既有 restart 段（`restart-preserves-ownership-facts-policy-order-source-tuple` 前的 getByText 等待）超时一次，后续 4 次运行均通过，判定为冷编译时序抖动；已知无关 flaky（review-browser-full-chain strict-mode 选择器）本次未撞上，未触碰。
