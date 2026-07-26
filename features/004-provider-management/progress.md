# 进度

- 特性: 004-provider-management(对应切片: S-2.7)
- 当前阶段: done
- 执行模式: auto(用户授权)
- 已加载扩展: ext-ui-design(plan/build/verify)
- 下一步: 等用户决定是否提交 S-2.7 + 开始 S-3(单 agent 执行回路,接 LLM)
- 门禁输出: RESULT: PASS — 可进入 ship (verify→ship, auto 2026-07-26);ship 语义验收通过

## 交付摘要
- 交付内容: provider/model 配置升级为被管理实体——用户创建 provider 配置(名/baseUrl/apiKey);创建 agent 时选已有配置、查询其可用模型并选定;agent 携带 providerConfigId + model;关联关系可见;**apiKey 全链路不泄漏**。
- 需求闭合: 5/5 FR + 1/1 NFR
  - FR-1 创建 provider → t1-green(createProvider)、t2-green(POST 201/400)、t4-green(ProviderForm)
  - FR-2 查询模型 → t2-green(GET /:id/models 200/404/502,服务端代理查询)
  - FR-3 agent 关联 → t3-green(createAgent 校验 providerConfigId)、t5-green(AgentForm 选配置+查模型)
  - FR-4 关联可见 → t1-green(agentCount)、t5-green(AgentList provider/model,null 降级)、smoke
  - FR-5 去 PROVIDERS → t3-green(grep 无残留)
  - NFR-1 a11y + 密钥不泄漏 → 代码评审全链路核查 + smoke DOM 反查(apiKey 不泄漏确认)
- 证据索引: baseline / t1~t5 red-green / suite(74,两次确定性)/ build-final / smoke-*.log / demo-home.png
- 主要变更:
  - 数据:ProviderConfig 表 + Agent(provider→providerConfigId?/model)迁移;seed 1 provider + agent 关联
  - 服务:providerService(createProvider/getProviders 无 apiKey/getProviderFull 内部)、agentService 校验 providerConfigId
  - API:/api/providers(POST/GET 无 key)、/api/providers/[id]/models(服务端代理查 /models,404/502)
  - UI:ProviderForm(apiKey type=password)、ProviderList(纯展示三态)、AgentForm(provider 选已有+模型查询下拉)、AgentList(显示 provider/model)、page(统一 providers fetch)
  - 移除 PROVIDERS;测试 db 隔离(test-providers.db)
- 产品层回写: 勾选 S-2.7;D-15(provider 配置一等实体)落地;A-17~A-20 实践
- 遗留事项(非阻塞):
  - provider edit/delete 推迟(A-19)
  - /models catch-all 把 getProviderFull 错误一律映射 404(DB 异常会误报 404 而非 500)— 代码评审建议级,低风险
  - 真实上游模型查询需用户填入真实 baseUrl/key 后在运行时验证(S-3 执行会用)
  - error 文案用绿色 token(建议级,沿用惯例)
- 未提交 git(S-2.7 待用户确认)

下一片: S-3 单 agent 执行回路 —— 用 agent 的 providerConfig + key 调 LLM(OpenAI 兼容 chat/completions),agent 真的干活。provider 配置已在 DB(用户经 UI 填入真实 baseUrl/key),S-3 无需再问 key。
