# 实现代码评审 (第 1 轮)

- 日期: 2026-08-02
- 评审方式: subagent
- 结论: 需修改

## 评审范围与证据

- 首个实现提交: `7752a6c9fe49386e594d4703b62c36eaa48a6f89`
- 实现基线（首个实现提交的父提交）: `7cadd5a9c42022df6e109100084790fcf767a888`
- 当前实现提交: `5c3c69a388cc39c3b85823a80fc94ee8b7ff767c`
- 已读取 `frame.md`、`spec.md`、`design.md`，并检查基线至当前提交的完整 diff、T-1 至 T-33 任务提交与当前代码。
- 独立全量测试: `evidence/review-suite-20260801T165504Z.log`，171 个测试文件、1143 项测试通过，exit 0。
- 抽查 `t1-red/green`、`t24-red/green`、`t29-red/green`、`t32-red/green`、`t33-red/green`：均为 `hf_gate.py run` 标准信封；抽查 red 是缺失行为而非编译或拼写错误。
- 风险档位 3 与持久化迁移、安全边界、跨模块状态机和公共接口改动相符。
- 已核对原子裁决与记忆提交、checkpoint 后本地恢复、actor 防伪、redaction、strict DTO、事件兼容、多轮 escalation、memory/delivery、生产 routes 与真实产品 UI。
- UI 样式使用既有 token，未在新增 review 组件或 `cockpit.css` 中发现硬编码色值/字号；a11y 测试覆盖键盘、焦点、44px、AA 对比度与单窄屏弹层。
- 已读取真实渲染截图 `evidence/smoke-review-desktop.png` 与 `evidence/smoke-review-narrow.png`；本轮全量测试重新生成了两张截图。

## Findings

- [一般] `app/api/work-items/[workItemId]/reviews/route.ts:38-50`: 生产复核 mutation 直接调用 `request.json()`，没有执行设计 §8.1 和相邻 escalation/delivery route 已落实的 128 KiB 请求上限；攻击者或误客户端可让服务在 strict DTO 校验前无界读取并解析请求体，且当前生产 route 测试未覆盖超限请求 → 改为先读取有界文本、按 UTF-8 字节数返回 `REQUEST_LIMIT_EXCEEDED`，再解析 JSON，并增加超限、临界值及零副作用测试。
- [建议] `app/cockpit.css:746-750`: 窄屏真实截图中状态标签 `passed` 被拆成两行（`passe` / `d`），降低状态扫读性 → 为短状态标签增加 token 化的不换行约束，并在 390px 真实渲染断言中覆盖。
