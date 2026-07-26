# 代码评审 (第 1 轮)

- 日期: 2026-07-26
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-07-26
- 测试运行: npm test 第 1 次 74/74 通过 exit 0;npm test 第 2 次 74/74 通过 exit 0(无 flaky);npm run build exit 0(TypeScript 通过,6 路由编译)

## 评审执行

- 自读完整 git diff(15 modified + 新增 provider 相关文件)、plan.md、frame.md、code-checklist.md、ext-ui-design(code)项。
- 自跑 `npm test` 两次与 `npm run build`,结果如上。
- 抽查 evidence/:t1-red(providerService 模块缺失 + agentService 因 provider 列删除而 Prisma 校验失败,属行为缺失)、t2-red(providersApi 模块缺失)、t5-red(AgentList 未渲染 provider 名、AgentForm model 下拉未填充,属行为缺失)——均为真实红,非编译/拼写错误;日志均带 hf-gate-run 标准头尾。
- smoke-20260726T152650Z.log:`scripts/smoke-s27.mjs` 用 headless Chrome `--dump-dom` 真实渲染,并断言 POST 的 apiKey 值 "should-not-leak" 不出现在 DOM 中——满足 ext-ui-design 的"可自动化渲染检查"要求,且端到端验证 NFR-1。
- frame 风险档位 2 与 diff 相符(新表 + API + UI,涉及 apiKey 但属本地单用户 dev.db,未达档位 3)。

## 安全 (NFR-1) 核查 — apiKey 是否泄漏

**否,apiKey 在所有对外响应与 UI 中均未泄漏。** 核查路径:

- `providerService.toDTO` (src/server/providerService.ts:29) 刻意不含 apiKey;`getProviderFull` 返回含 key 的内部 ProviderRow,仅被 `/api/providers/:id/models` 在服务端用于 `Authorization: Bearer` 头(app/api/providers/[id]/models/route.ts:23),绝不进响应体。
- POST/GET /api/providers 响应只承载 ProviderConfigDTO(无 key);GET /api/agents 响应只承载 AgentDTO(providerConfigId/model,无 key)。
- ProviderForm 的 apiKey 仅从 type=password 输入流向 POST body;ProviderList/AgentList/page 均不渲染 key。
- grep "apiKey" 于 .ts/.tsx:命中仅在 providerService 内部类型、createProvider 写入、/models 的 Authorization 头、测试断言(not.toHaveProperty)中——无响应路径泄漏。
- 运行时 smoke 脚本以真实 apiKey 值反查 DOM,确认未渲染。

## 需求覆盖

- FR-1(创建 provider,apiKey 不回显):✅ POST 201 无 key、400 name 空、GET 索引无 key。
- FR-2(查询模型,服务端代理):✅ /models 200(mock 上游)/404(配置不存在)/502(上游失败)。
- FR-3(agent 关联 providerConfigId+model):✅ AgentForm 选配置→查模型→提交 body 含 providerConfigId+model;createAgent 校验 providerConfigId 不存在抛错、存在/为空通过。
- FR-4(关联可见):✅ AgentList 卡片解析 provider 名+model(null 显示"未配置 provider"降级);ProviderList 显示 agentCount。
- FR-5(去 PROVIDERS):✅ grep PROVIDERS 于 src/ 与 tests/ 无残留。
- NFR-1(a11y+密钥不泄漏):✅ 每输入 getByLabelText、apiKey type=password、按钮 min-h-[44px] + focus-visible:ring、对比度沿用 token;密钥全链路不泄漏(见上)。

## 一致性

- PD-1~PD-4 均按决策实现:服务端代理查询(PD-1)、providerConfigId+model 拆分(PD-2)、可空 providerConfigId+校验(PD-3)、page 统一 fetch 下传(PD-4)。
- 错误处理与计划一致:400(name 空/providerConfigId 不存在)、404(配置不存在)、502(上游失败 `{error:"upstream error"}` 不泄漏内部细节)、500 不泄漏堆栈(测试断言 nottoMatch /stack|at \//)。
- token 纪律:全程走 design token(森绿 #16a34a / --accent-strong #15803d / rounded-token / shadow-token),无硬编码色值,无紫蓝渐变/emoji。
- 改动面与任务清单一致,无范围蔓延。

## Findings

- [建议] app/api/providers/[id]/models/route.ts:13-18:`getProviderFull` 的 catch 是 catch-all,任何错误(含潜在 DB 连接异常)都映射为 404。当前 getProviderFull 仅在 findUnique 返回 null 时抛错,实际风险低;但若未来 DB 层抛错会被误报 404 而非 500。→ 可选择性区分"not found→404"与其余"→500",非阻塞。
- [建议] components/ProviderForm.tsx:61 & components/AgentForm.tsx:118:校验/错误文案使用 `text-accent-strong`(绿色 #15803d)作错误色,语义上错误通常用红色。此为沿用既有 SkillForm 惯例、非本次回归,且计划未规定错误色,故仅作建议。

注:以上两条均为建议级,不阻塞通过。实现整体高质量:测试覆盖行为与边界(含 apiKey 不泄漏断言)、TDD 红绿证据真实、apiKey 全链路无泄漏、a11y 落实、需求与计划符合度高。
