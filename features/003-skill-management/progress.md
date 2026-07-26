# 进度

- 特性: 003-skill-management(对应切片: S-2.5)
- 当前阶段: done
- 执行模式: auto(用户授权)
- 已加载扩展: ext-ui-design(plan/build/verify)
- 下一步: 等用户决定是否提交 S-2/S-2.5 + 开始 S-3(单 agent 执行回路,接 LLM)
- 门禁输出: RESULT: PASS — 可进入 ship (verify→ship, auto 2026-07-26);ship 语义验收通过

## 交付摘要
- 交付内容: skill 升级为被管理一等实体——用户可创建/查看 skill;创建 agent 时从"已有 skill 列表"关联(替换静态勾选);agent 携带 skill 引用,卡片显示关联名、skill 索引显示被关联数。
- 需求闭合: 5/5 FR + 1/1 NFR 全部验收通过
  - FR-1 创建 skill → t1-green(createSkill trim/空白)、t2-green(POST 201/400)、t4-green(SkillForm)
  - FR-2 索引+详情 → t1-green(getSkills 含 agentCount/无 content、getSkill 全文/404)、t2-green(GET 索引、GET /:id 200/404)、t4-green(SkillList)
  - FR-3 agent 关联已有 skill → t3-green(createAgent 校验 skill id 存在)、AgentForm"存 skill id"单测、t5-green(选项来自父传 prop)
  - FR-4 关联可见 → t1-green(agentCount)、t5-green(AgentList 解析名)、smoke(被 1 个 agent 关联渲染)
  - FR-5 去 SKILLS → t3-green(grep 无残留)
  - NFR-1 a11y → t4-green(SkillForm getByLabelText/min-h/focus)
- 证据索引: baseline / t1~t5 red-green / suite×2(确定性,隔离 db)/ build-final / smoke-*.log(真实创建+关联+agentCount+浏览器渲染)/ demo-home.png
- 主要变更:
  - 数据:prisma Skill 表 + add_skill 迁移(加性)、seed 2 skill + agent 关联
  - 服务:skillService(createSkill/getSkills 索引含 agentCount/getSkill)、agentService.createAgent 校验 skill id、AgentDTO.skills 为 number[]
  - API:/api/skills(POST/GET 索引)、/api/skills/[id](GET 200/404)
  - UI:SkillForm、SkillList(纯展示三态)、AgentForm(skills 由父传)、AgentList(解析名)、page(统一 skills fetch + status)
  - 移除 SKILLS 常量;测试 db 隔离(test-agents.db / test-skills.db 消除并行竞态)
- 产品层回写: 勾选 S-2.5;A-14(skill 实体最小形态)、A-15(skill id 数组)已实践;A-16(edit/delete 推迟)生效;D-14(skills 一等实体)落地
- 遗留事项(非阻塞):
  - skill edit/delete 推迟(A-16)
  - skill 内容的 progressive disclosure 加载与 agent 执行时注入 → S-3
  - Skills Hub 联网/agentskills.io 同步、skill bundle → 后续切片
  - error 文案沿用绿色 token(语义不理想,代码评审建议级,接受现状;未来引入红色 error token)
  - getSkill 用字符串相等判 404(建议级,接受现状;未来用 NotFoundError 类)
- 未提交 git(S-2 与 S-2.5 均待用户确认;按规则不主动提交)

下一片: S-3 单 agent 执行回路(接 LLM zhipuai-coding-plan,agent 真的干活)— 需用户提供接入方式/API key
