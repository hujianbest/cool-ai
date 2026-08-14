# 042 AUD-UI 统一审计筛选

- 特性: 042-audit-browser-filters（S-58 / S-23 AUD-UI）
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto
- 主领域 Capability: 不适用（只改入站 UI Adapter；消费已 ship 的 CAP-EXE-05、CAP-PWS-03、CAP-COL-07、CAP-MWK-05、CAP-GOV-03、CAP-RUN-07、CAP-OPS-01/02）
- 轻量级: 是（≤3 票、无 schema/安全/跨 owner 写、单缝 audit-panel）

## 问题 / 方案

各 source-owner 事件已能出现在同一审计列表，但 owner 不能按来源筛选。本片只加只读筛选与状态，不新增写事实、不改 API（客户端过滤当前已加载页；「加载更多」后仍应用同一筛选）。

## 用户故事

作为 owner，我想按域（执行/协作/任务/项目/治理/运行时）筛选审计列表，从而在已交付来源中定位事件；空筛选结果有 empty；筛选不破坏定位链接与脱敏。

## 测试缝

jsdom AuditPanel：筛选控件、六域过滤、全部、空态、键盘/名称；既有混排回归。

## 票

- [x] T-01 筛选控件 + 客户端按 domain 过滤 + empty + 聚焦测试 RED→GREEN
- [x] T-02 smoke:execution 或既有审计段加筛选断言 + 全量/tsc/build（无 schema，code-review 豁免，progress 记录）

## 默认（A-300）

不新增 query param；筛选是面板内状态。不在本片做时间轴（S-39）或导出（S-38）。
