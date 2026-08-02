# 复核与交付

每个合并后的当前结果都必须由 owner 显式选择一名合格的非执行者 Agent 进行真实 Provider 复核。平台只冻结材料、校验资格并持久化裁决，不能替 Agent 或 owner 伪造业务结论。

## 选择复核者

候选人必须同时满足：

- 是当前项目成员；
- 不是该结果的执行者；
- 角色或技能配置明确具备复核能力；
- 使用自己的已验证 Provider。

候选超过一名时由 owner 选择，平台不会暗选。复核者读取冻结的公开结果、diff、验证、产物和相关记忆；私有提示、凭据、原始 Provider body 和隐藏思维链不进入公开复核材料。

## 三种裁决

- `reject`（退回）：必须给出返工要求。旧 result 与 review 保持只读，任务进入待返工；新的 execution 产生新的 result 版本后再复核。
- `escalate`（升级）：提出问题和 2–8 个选项，任务等待 owner。owner 回答不会修改旧裁决，而是为当前材料开启新的 review attempt；也可选择返工或终止使命。
- `pass`（通过）：当前 result、复核裁决、所需验证和记忆关联同时通过校验，任务才进入已通过完成。

Provider 或解析失败的 attempt 不产生业务裁决。它只能由 owner 显式重试为新 attempt；若公开输出已形成安全 checkpoint 但本地事务失败，则只重试本地 finalize，不重复调用 Provider。

## 不可变版本链

result、review attempt、decision、memory 和 delivery 都保留稳定 id/version。退回后的新 execution 生成 result v2，而不是覆盖 v1；升级回答后生成新 attempt，而不是补写旧 attempt。任务材料、依赖或上下文变化会使旧结果/交付失效，历史仍可追溯。

## 五类共享记忆

1. 目标（goal）：使命和目标边界。
2. 决策（decision）：已确认选择及其依据。
3. 事实（fact）：可引用、可追溯的项目事实。
4. 产物（artifact）：文档、设计、代码或验证产物索引。
5. 经验（experience）：复盘后可复用的方法与限制。

owner 可按既有来源语义创建记忆。自动记忆候选由实际复核 Agent 提议并署名，只在 `pass` 裁决中确认；平台负责验证与持久化，不是业务作者。记忆按类型、去除正文首尾空白后的原 Unicode 正文和精确来源 tuple 全等去重。修订不会覆盖旧条目，而是以同类型 `supersedes` 链显式取代，历史版本继续可导航。

## 最终交付

所有任务都必须有当前 `pass` 结果、依赖已通过、无开放升级/人工恢复，且所需验证和记忆关联完整。随后 owner 生成最终交付：

- 使命结论；
- 每项任务的执行者、复核者和当前 result 版本；
- 公开摘要与限制；
- staged 变更统计、验证和产物引用；
- 记忆引用；
- 带 required/optional 与状态的证据 manifest。

最终交付由数据库事实确定性组装，不再调用模型补写结论。输入事实变化后旧 delivery 会失效并形成新版本；只有当前交付持久化后使命才完成。

![独立复核、记忆与最终交付](../images/cool-ai-review-delivery.png)
