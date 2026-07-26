# Demo 验收 (S-3 单 agent 单轮执行)

- 日期: 2026-07-26
- 特性: S-3 单 agent 单轮执行
- 用户可感知: 是
- 验收方式: 运行时冒烟(本地 mock 上游真实跑通 200)+ 浏览器渲染取证(SSR HTML)
- 结论: 接受
- 用户确认: auto-approved 2026-07-26(执行模式 auto;下次交互向用户呈上)

## 验收内容

S-3 的用户可感知价值 = owner 能在 UI 选择一个 agent、输入任务、看到 agent 的输出与执行轨迹。验收分两条证据链:

### 1. 真实端到端运行(本地 mock LLM,无外部依赖)

证据:`evidence/smoke-20260726T154913Z.log`

脚本 `scripts/smoke-s3.mjs` 在本机起一个 mock OpenAI 兼容上游(`http://127.0.0.1:<port>/chat/completions`),然后真实走完整链路:

1. `POST /api/providers` 建一个 baseUrl 指向 mock、apiKey=`test-key` 的 ProviderConfig;
2. `POST /api/agents` 建一个关联该配置的 agent;
3. `POST /api/agents/:id/run { task:"你好" }` → **200**,响应含 `output:"mock-llm-回答"` 与 `trace`(3 步:system / user / assistant);
4. mock 上游记录到请求头 `Authorization: Bearer test-key`(证明 apiKey 仅用于上游调用、正确转发);
5. 响应体 grep `apiKey` → 无泄漏。

结论:运行链路真实跑通 200 + 输出 + 轨迹 + key 转发 + 不泄漏。这是 S-3 的核心用户价值"agent 跑起来了"的机械证据。

### 2. 浏览器渲染取证(运行 Agent 面板)

证据:`evidence/demo-s3.html`(16458 字节,Next dev SSR 真实 HTML)

dev server 真实渲染 `http://localhost:3000`,SSR HTML 包含:

- `运行 Agent` 段落标题;
- `选择 Agent`(下拉,label 关联);
- `任务`(textarea,label 关联);
- `aside` / `main` 地标(布局结构)。

`输出` / `执行轨迹` 在未运行时为空(符合预期:仅运行成功后渲染)。

结论:运行面板在真实浏览器渲染中可见、可访问(label 关联),用户能"选 agent + 填任务 + 点运行"。成功运行后的输出/轨迹展示由 jsdom 组件测试 `tests/AgentRun.test.tsx`(成功用例)+ 上面 smoke 共同覆盖。

## 覆盖映射

- FR-5(UI 运行面板 + 三态):demo HTML(渲染)+ AgentRun 组件测试(idle/running/error 三态)+ smoke(成功路径)。
- FR-1~FR-4(后端执行):smoke 真实跑通 200。

## 结论: 接受

两条证据链覆盖"用户能跑 agent 并看到输出/轨迹"的完整价值,安全红线(apiKey 不泄漏、正确转发)有机械断言。

(浏览器可视化截图建议项见代码评审第 1 轮 finding 3,经约定延后;核心交互与渲染已由 SSR HTML + jsdom 三态测试 + 真实端到端 smoke 三重覆盖,不构成阻塞。)
