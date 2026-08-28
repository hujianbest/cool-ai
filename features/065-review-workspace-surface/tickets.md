# 任务票 — 独立复核工作台表面

- 状态: done
- 规模: 4 张纵向票（A-459）
- 公共缝: 任务看板「打开复核」；既有 `ReviewProductSurface`；`review-browser-full-chain`

- [x] T-01 任务卡入口 — Blocked by: None
  - RED: 任务看板工作项卡没有「打开复核」。
  - GREEN: 每个工作项有 ≥44px「打开复核」；点击后挂载 `ReviewProductSurface`；不要求 Execution merged。
  - 验证: 任务看板 / 复核接线 jsdom。

- [x] T-02 UCD chrome 与空态 — Blocked by: T-01
  - RED: 打开后标题仍是「任务看板」或缺少空态文案。
  - GREEN: 标题为 `独立复核工作台 · [任务标题]`；无材料时「当前工作项无复核材料」+ 刷新；loading/error/retry；令牌与焦点。
  - 验证: 同上 jsdom。

- [x] T-03 冒烟改道 — Blocked by: T-02
  - RED: `review-browser-full-chain` 仍找「运行详情」tab 并失败。
  - GREEN: 冒烟经图标轨「任务」+「打开复核」走完全链；既有「打开复核闭环」深链仍在 Execution 卡片。
  - 验证: review-browser-smoke 聚焦。

- [x] T-04 收口 — Blocked by: T-03
  - 验证: 聚焦 → tsc → build → 全量。
  - review: 纯 UI，hf-code-review 按 A-459 豁免。
