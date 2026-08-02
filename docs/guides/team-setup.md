# 团队配置

团队配置依次建立 Provider（模型服务）、技能和 Agent（角色代理）。Provider/model 绑定可以更换，不会把 Agent 的项目成员身份、技能和协作历史变成另一个角色。

## 1. 添加 Provider

填写名称、Base URL、API key 和 model，然后先验证连接再保存。

- Base URL 只接受 `http` 或 `https`，不能嵌入用户名、密码、查询参数或 fragment。
- 对非 HTTPS 地址，owner 必须明确确认风险；它适合受信任的本机服务，不应被当成安全远程连接。
- 验证调用 `GET <baseUrl>/models`，目标 model 必须出现在 `data[].id`。
- 运行调用 `POST <baseUrl>/chat/completions`，要求 JSON object 结构化输出和有效 usage。
- API key 保存后只显示掩码；请求会把必要上下文发给该 Provider。

完整协议与边界见[Provider 兼容性](../provider-compatibility.md)。

## 2. 创建技能

技能是 owner 本地维护、可版本化和可分配的文本指令包，不是可执行插件或远程市场包。

1. 给技能一个明确名称和用途。
2. 在正文中写行为约束、输入期望和交付形式。
3. 保存后再分配给 Agent；修改技能会形成后续运行所读取的新配置事实。

## 3. 创建至少两个 Agent

可以从“规划、实施、复核”模板开始，但模板不代表组织层级，owner 可编辑、改名或新增角色。每个 Agent 至少核对：

- 名称、职责、系统提示；
- Provider 与 model；
- 分配的技能；
- 文件读取、写入、命令执行等工具权限；
- token 和交棒预算；
- 可辨识的头像文字与强调色。

至少两名 Agent 才能组建项目团队并满足“执行者之外由另一名 Agent 复核”的闭环。若某个 Agent 要作为复核者，其职责或技能配置必须明确具备复核能力。

## 4. 验证配置

刷新页面后确认 Provider、技能和两个 Agent 仍可读取。不要在日志、截图或共享记忆中粘贴 API key。遇到凭据不可用，先确认启动进程使用的是创建这些凭据时的同一 `COCKPIT_MASTER_KEY`，再参考[故障排查](../troubleshooting.md)。

![Provider、技能与 Agent 配置](../images/cool-ai-team-configuration.png)

下一步：[创建项目与使命](./project-workflow.md)。
