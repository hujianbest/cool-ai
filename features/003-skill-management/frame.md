# 003-skill-management Frame

- 日期: 2026-07-26
- 意图: 把 skill 升级为被管理的一等实体:用户能创建/查看 skill;创建 agent 时从"已有 skill 列表"关联(替换 S-2 的静态勾选池);agent 携带 skill 引用,关联关系在 UI 可见。
- 切片: S-2.5
- 范围外: skill 内容的 progressive disclosure 加载与 agent 执行时注入(S-3);skill 的 edit/delete(本切片先做 create+list+view,见 A-16);Skills Hub 联网安装/agentskills.io 同步(S-3+);skill bundle(组合多 skill);frontmatter 高级字段(version/platforms/conditional-activation);agent 执行/LLM(S-3)。
- 模式: 建造
- 风险档位: 2
- 档位理由: 新功能(Skill 表 + CRUD)+ Agent.skills 语义变更(从静态工具池字符串 → skill id 引用)。属档位 2:dev.db 仅 seed 可重置、无对外 API 契约(本切片首次定义 skill 形态);不碰安全/认证/公共接口破坏,不达档位 3。
- 用户可感知: 是
- 环境基线: evidence/baseline-20260726T134017Z.log (exit 0)
- 基线说明: 沿用 S-1/S-2 测试套件(27 用例)作为起点,证明改动可验证。
- 假设:
  - Skill CRUD 第一版做 create + list + view;edit/delete 推迟(A-16)。
  - Skill 实体:name + description + content(markdown)+ 可选 category(A-14)。
  - agent.skills 改存 skill id 数组(JSON 列,A-15);S-2 的 SKILLS 静态常量被移除,AgentForm 的 skill 输入改为"从 GET /api/skills 拉取并多选"。
  - 既有 Agent.tools 仍为静态工具池(本切片不动 tools,只动 skills)。
