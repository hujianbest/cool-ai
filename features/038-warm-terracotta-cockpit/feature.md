# 特性

- 特性: 038-warm-terracotta-cockpit
- 对应切片: S-54
- 模式: 建造
- 用户可感知: 是
- 骨架: 否
- 状态: done
- 一句话: 按 `product/ui/cool-ai-design-md-case.html` 的暖陶工作台，把协作驾驶舱做成左对话 / 中项目群聊 / 右看板状态，并严格对齐 case 的布局与颜色。

## 背景

- 035/S-51 已把 Apple `DESIGN.md` 投影到 `app/tokens.css` 并收敛壳层 token；业务面板结构未按 case 重排。
- 用户 2026-08-14 指示「继续 product/ui 调整」，并以 case 为想要的结果：左边对话、中间项目组聊天群、右边各种看板状态；严格按 case 布局和颜色实现。
- 视觉与 IA 参考：`product/ui/cool-ai-design-md-case.html`（栅格 `56px 236px 1fr 304px`；暖陶色板 canvas `#F4EFE5` / panel `#FBF7EE` / accent `#3E6B5E` / rail `#241F18`）。
- 领域映射（不新增实体）：左栏 = Thread 目录（对话列表）；中栏 = 当前 Thread 的公开群聊；右栏 = Mission 看板 / 审批 / 共享记忆等已有上下文面。
- 037/S-53 AUD-GOV 在途（T-01 完成、T-02 未开始）；本会话按用户最新指示切到本 UI 切片，037 暂停至本片 ship 或用户改口。

## Grill 确认（2026-08-14，用户 AAAAA）

- Q1=A 暖陶 DESIGN.md 替换 Apple 原文（原文归档）— A-258
- Q2=A 本片一次做完驾驶舱三栏视觉 — A-259
- Q3=A 布局跟 case，热区保持 44×44 — A-260
- Q4=A 桌面跟 case，窄屏保留抽屉 — A-261
