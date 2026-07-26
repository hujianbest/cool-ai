# 004-provider-management Frame

- 日期: 2026-07-26
- 意图: provider/model 配置升级为被管理实体:用户能创建 provider 配置(名/baseUrl/apiKey);创建 agent 时选已有配置、查询其可用模型并选定;agent 携带 providerConfigId + model;配置列表与 agent 详情可见。
- 切片: S-2.7
- 范围外: 实际 LLM 调用/agent 执行(S-3);provider config edit(A-19 推迟);流式/function-calling 等高级模型特性(S-3);工具实际执行(S-3);apiKey 加密存储(生产化);按 provider 反查 agent。
- 模式: 建造
- 风险档位: 2
- 档位理由: 新功能(ProviderConfig 表 + Agent.provider 语义变更:静态字符串 → providerConfigId + model)+ 模型列表运行时查询。属档位 2:apiKey 为用户自有 provider key、存本地 SQLite dev.db(gitignored),非应用自身认证/授权/支付面,故不达档位 3"安全面";爆炸半径可控(本地单用户、dev.db 可重置、无对外 API 契约破坏)。
- 用户可感知: 是
- 环境基线: evidence/baseline-20260726T150927Z.log (exit 0)
- 基线说明: 沿用 S-1~S-2.5 测试套件(51 用例)作为起点。
- 假设:
  - ProviderConfig 实体:name + baseUrl + apiKey + createdAt(A-17)。apiKey 仅存本地 dev.db(gitignored),不回显到前端(列表只回 name/baseUrl,详情不回显 key)。
  - 模型列表:服务端用配置的 key 查询 `{baseUrl}/models`(OpenAI 兼容),返回模型 id 列表;前端选定后存 model 字符串(A-18)。
  - Agent.provider(String)→ 拆为 providerConfigId(Int)+ model(String);迁移既有:seed agent 改为关联一条 seed provider 配置。
  - ProviderConfig CRUD 第一版 create + list(+ delete 可选);edit 推迟(A-19)。
  - 移除 PROVIDERS 静态常量;AgentForm provider 下拉改为"选已有配置"+ model 选择(A-20)。
