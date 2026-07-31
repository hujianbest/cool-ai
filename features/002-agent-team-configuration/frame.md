# 配置有技能的第一支 Agent 小队 Frame

- 日期: 2026-07-29
- 意图: 让独立产品 owner 在 Web UI 中安全配置并验证 OpenAI-compatible 服务、创建可复用文本技能，并持久化至少两个具有不同身份、模型、技能、工具权限与预算的角色 Agent。
- 切片: S-2
- 范围外: 把 Agent 加入具体项目、群聊、自主接力、共享记忆、实际工具执行与并行任务；这些由 S-3 至 S-6 交付。
- 模式: 建造
- 风险档位: 3
- 档位理由: 本切片持久化外部模型 API key、发起用户配置的外部网络请求并扩展跨 UI/API/服务/存储的配置模型，命中安全面与跨多模块结构调整判据，必须分离规格与设计并进行三轮评审。
- 用户可感知: 是
- 环境基线: evidence/baseline-20260729T161149Z.log (exit 0)
- 基线说明: 在 S-1 已 ship 的代码上通过 HarnessFlow 运行 `npm test`，12 个测试文件共 42 项全部通过；Node 24 仍输出已知的 `node:sqlite` experimental warning，不影响退出码。
- 假设: Provider 凭据加密、非 HTTPS 确认、文字/几何头像边界已同步记录在 product/assumptions.md A-20 至 A-22，如不对请指出。
