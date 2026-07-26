# 代码评审 (第 1 轮)

- 日期: 2026-07-26
- 评审方式: subagent
- 结论: 需修改
- 测试运行: 评审者本人重跑 `npm test` 两次(均 20 文件 / 86 用例全过,无 flaky,exit 0);`npm run build` exit 0(TypeScript 通过,/api/agents/[id]/run 路由已注册)

## 评审依据

- 自读完整 git diff(已跟踪:`app/page.tsx` +5、`product/backlog.md`;未跟踪新文件:`src/server/agentRunner.ts`、`app/api/agents/[id]/run/route.ts`、`components/AgentRun.tsx`、`tests/{agentRunner,runsApi,AgentRun}.test.{ts,tsx}`、`scripts/smoke-s3.mjs`)。改动面与 plan 任务清单一致,无范围蔓延。
- 抽查 evidence red/green(t1/t2/t3 red 均为"模块未找到"的真实 TDD 入口红;t1-green 79、t2-green 83、t3-green 86 用例递增,green 真实;build-final、smoke 均 exit 0,有标准 hf-gate-run 头尾,无手工编辑痕迹)。
- frame 风险档位 = 2,diff 仅新增执行能力、不碰数据迁移/认证/公共契约,档位相符。
- 安全核验:grep `apiKey` 于响应路径——runner 仅在 `agentRunner.ts:66` 用于 `Authorization: Bearer`,RunResult 只含 `{output, trace}`;route.ts、AgentRun.tsx 零 `apiKey` 命中;runsApi 单测断言 body 不含 apiKey;smoke 断言 `receivedAuth === "Bearer test-key"` 且响应体不含 apiKey。**apiKey 不泄漏。**
- token 纪律:全部走 token(border-line / bg-surface / text-muted / accent-strong / rounded-token),无硬编码色值字号;a11y——两个 `<label htmlFor>` + getByLabelText 可测、`min-h-[44px]`、`focus-visible:ring-2`、`role="alert"`、`aria-label`。
- 计划符合度:PD-1(错误类 instanceof 映射)、PD-2(trace=三步含 system 全文)、PD-3(不传 tools)均落实;尾斜杠规范化 `replace(/\/$/,"")` 到位;YAGNI(无工具循环/SSE)守住。

## Findings

- [一般] `src/server/agentRunner.ts:62` — plan FR-4 与"错误处理"明确"上游非 2xx/**网络** → UpstreamError → 502",但 `await fetch(...)` 若被 reject(DNS / 连接拒绝 / 超时等网络层错误)会直接抛 TypeError,未在 runner 内捕获转换,会冒泡到 handler 的 500 兜底而非 502。当前 runner 测试仅覆盖 `res.ok===false`(非 2xx)的 UpstreamError,未覆盖网络失败。 → 用 `try { res = await fetch(...); if (!res.ok) throw new UpstreamError(...) } catch (e) { if (e instanceof UpstreamError) throw e; throw new UpstreamError("upstream network error") }`(或等价写法)统一网络失败为 UpstreamError;并补一条 runner 测试断言 `fetch` reject → UpstreamError、handler 测试断言该路径 → 502 `{error:"upstream error"}`。
- [一般] `tests/AgentRun.test.tsx` — T-3 判据与 FR-5 第二条"运行中按钮禁用 + 运行中…"无对应断言;ext-ui-design 要求"交互三态至少各有一份可核对的证据",idle/error 有证据,但 **running 态缺断言**(成功用例虽穿越 running→idle,但 mock fetch 立即 resolve,无可观察窗口,未断言 disabled/"运行中…")。 → 补测试:点击运行后、在 fetch resolve 前断言按钮 `toBeDisabled()` 且文案为"运行中…"。
- [建议] verify 阶段需补真实浏览器渲染截图(ext-ui-design verify 要求 `evidence/smoke-*.png`);当前 `smoke-*.log` 仅为 HTTP API 冒烟(node 脚本打 mock 上游),jsdom 组件测试不构成浏览器渲染冒烟。build 阶段可不阻塞,verify 前必须落地。

## 备注(不阻塞)

- runner 500 兜底返回 `e.message`,与既有 `agents/route.ts` 一致;非本切片安全范围(apiKey 不在其中),如需后续硬化可统一收口。
- `baseUrl` 尾斜杠规范化只去单个 `/`,极端多斜杠(`v4///`)不处理;真实配置不会出现,非问题。

## 第 2 轮

- 日期: 2026-07-26
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-07-26(执行模式 auto;两条 一般 已修复并经第 2 轮评审通过)
- 测试运行: 评审者本人重跑 `npm test` 两次(均 20 文件 / 88 用例全过,无 flaky,`$LASTEXITCODE=0`)。用例数由第 1 轮的 86 增至 88(+2,与两条 finding 各补一条用例相符)。

### 修复确认

1. **[一般] fetch reject → UpstreamError —— 已修复。**
   - `src/server/agentRunner.ts:63-74`:fetch 调用已包入 `try { res = await fetch(...) } catch { throw new UpstreamError("upstream unreachable") }`。关键正确点:`!res.ok` 的 UpstreamError 抛在 try 块**之外**(:75),不会被 catch 重新吞掉改写;catch 仅覆盖网络层 reject,语义清晰。无需 `instanceof UpstreamError` 二次判别即可正确,实现等价于 finding 建议。
   - `tests/agentRunner.test.ts:100-109`:新增用例 `mockRejectedValue(new Error("ECONNREFUSED"))` + `rejects.toThrow(UpstreamError)`,真实触发网络失败路径,非空壳。
   - 路由映射链闭合:`route.ts:34-36` UpstreamError → 502 `{error:"upstream error"}`;`runsApi.test.ts:63-70`(第 1 轮既有用例)已断言该映射。fetch reject → UpstreamError → 502 全链路可证。

2. **[一般] FR-5 running 态断言 —— 已修复。**
   - `tests/AgentRun.test.tsx:84-115`:用 deferred promise(`new Promise(r => { resolveRun = r })`)制造可观察窗口;点击运行后用 `findByRole("button", { name: /运行中/ })` 取到运行中态按钮并断言 `toBeDisabled()`,随后 resolveRun 并等待输出 `o`。running→idle 两态均有可核对证据,非空壳、非瞬时穿越。

3. **[建议] verify 浏览器截图 —— 延后,本轮不阻塞**(按第 1 轮约定在 verify 阶段落地)。

### 新 findings

无。

### 备注

- 两次重跑结果一致,无 flaky。
- 改动面聚焦(仅 runner 加 try/catch + 2 条新测试),无范围蔓延、无对已通过部分的回归。
