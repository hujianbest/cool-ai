# 特性

- 特性: 049-icon-first-cockpit
- 对应切片: S-59
- 模式: 建造
- 用户可感知: 是
- 骨架: 否
- 状态: in-progress
- 一句话: 按 UI UX Pro Max 把驾驶舱改成图标优先、点按后弹出表单、说明收入可操作帮助提示的安静工作台。

## 背景

- 038/S-54 已把暖陶四列与 case 色板落到壳层，但业务面仍把创建表单、说明段落和分区标题全部摊在栏内，owner 反馈界面杂乱。
- 用户 2026-08-15 指示安装 ui-ux-pro-max 技能并推倒重来：输入框点击按钮后弹出，文字描述做成帮助提示，能用图标就不要用文字。
- 技能检索结论（Minimalism & Swiss、density 9、Phosphor 线性图标）：dense dashboard、icon-only chrome、overlay 表单、可见焦点、表单内仍要可见 label。暖陶色板（D-46）不替换。
- 领域映射：不新增实体。只改变入站 UI Adapter 的披露方式与 chrome。

## Grill 确认（2026-08-15，用户明确需求 + auto 默认）

- Q1=A 保留暖陶四列/色板，重做交互语言而非换皮肤 — A-341
- Q2=A 配置/创建表单一律点按后弹出；群聊 composer 保持常驻 — A-343、A-351
- Q3=A 说明改成可操作 HelpTip，禁止 hover-only — A-344
- Q4=A 导航/工具/tab 能图标化的用 Phosphor，保留 aria-label — A-342、A-348
- Q5=A 桌面与窄屏同一套浮层，窄屏抽屉模型不变 — A-352
