# plan.md 评审 (第 2 轮 复审)

- 日期: 2026-07-26
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-07-26

## 评审依据
- 第 1 轮 findings(本文件上一版本)
- 修订后 plan.md(2026-07-26)
- 现状代码契约核对:src/server/providerService.ts(getProviderFull 抛普通 Error)、app/api/providers/[id]/models/route.ts(尾斜杠规范化模式)

## 第 1 轮 findings 闭合情况

- [一般1] providerConfig 缺失映射不一致 — **已闭合** — plan.md:64 显式声明"runner 自己 `providerConfig.findUnique`(不复用 getProviderFull,后者抛普通 Error 会落 500),缺失则抛 ValidationError";plan.md:68 错误处理重申"providerConfigId null 或 providerConfig 记录缺失 → ValidationError → 400(runner 自查 findUnique)"。契约自洽。
- [建议1] 上游 URL 尾斜杠规范化 — **已闭合** — plan.md:64 写明 `${config.baseUrl.replace(/\/$/,"")}/chat/completions`,与 /models 路由一致。
- [建议2] 502 body 固定不透传 — **已闭合** — plan.md:68 "502,body 恰为 `{error:"upstream error"}`(不透传上游 body)";plan.md:97 T-2 判据同步"502 body 恰为 `{error:"upstream error"}`(不透传上游)"。
- [建议3] skill 注入顺序 — **接受现状** — plan.md:64 拼接公式未显式声明按 `agent.skills` 数组顺序,但 T-1 判据(plan.md:96)仅断言"system 含 skill content"(包含语义,非有序),顺序不影响测试可判定性与单轮文本回合的 LLM 行为;skill 集合确定即足够,非阻塞。
- [建议4] UI empty 态 — **接受现状** — plan.md:86 三态(idle/running/error)+ 成功已覆盖核心交互,未补"无 agent 可选"与"output 为空"占位;此为 UI 完整性增强,实现阶段按常规(下拉空提示 + 按钮禁用)处理即可,建议级非阻塞。
- [建议5] apiKey 不泄漏断言拆分 — **接受现状** — plan.md:71 表述仍偏综合("断言发起上游请求的 body/header 不含明文 key 于返回结果"),未拆为发起侧/返回侧两条;但 T-2 判据(plan.md:97)已强化"所有响应 body 不含 apiKey",且 runner 返回字段集合固定为 `{output, trace}`(plan.md:63),安全由多层保证,表述精度不构成阻塞。
- [建议6] T-1 任务拆分 — **接受现状** — plan.md:96 T-1 仍为单任务承载 4 判据;第 1 轮已明确标注"不阻塞,纯节奏优化",TDD 实践中红绿循环可按判据序内部推进,无需结构变更。

## 新增 findings
无。

## 备注
- 一般级(唯一阻塞项)已闭合,契约(plan ↔ 现状代码 ↔ 测试判据)三处对齐。
- 4 条建议级接受现状均有合理理由(测试语义不依赖 / 边界场景 / 多层保证 / 节奏优化),不阻塞进入 build。
- 风险档位维持 2,无升档触发器。
