# 002-agent-definition Frame

- 日期: 2026-07-26
- 意图: 用户能在 Web UI 上填写 agent 五要素(名/角色描述/工具/供应商/skill)创建并保存到 DB,侧栏列表能看见新建的 agent。
- 切片: S-2
- 范围外: 不做 agent 执行/LLM 调用(S-3);不做项目组(S-4);不做多角色协作(S-5);不做角色模板(S-6);不实际接通 provider/不实际执行工具/不实际注入 skill(均 S-3+);本切片只做"定义+保存+可见"。
- 模式: 建造
- 风险档位: 2
- 档位理由: 新功能 + 破坏性 schema 迁移(去 role 列 + SQLite 重建表 + 新增四列)。属档位 2:爆炸半径可控——dev.db 仅含 seed 数据、可重置,无对外 API 契约(本特性才首次定义 agent 形态),不碰安全/认证/公共接口破坏;不达档位 3(无跨 ≥3 模块结构调整、无用户数据迁移)。
- 用户可感知: 是
- 环境基线: evidence/baseline-20260726T014657Z.log (exit 0)
- 基线说明: 沿用 S-1 建立的测试套件作为本特性基线(npm test,15 用例全绿),证明改动起点可验证。
- 假设:
  - 五要素存储:tools/skills 用 JSON 字符串列(SQLite 无原生数组);provider 为字符串列;systemPrompt 为文本列;保留 name。
  - 内置 provider 清单第一版仅 "zhipuai-coding-plan"(D-6),下拉单项、为扩展预留。
  - 内置工具池(A-7):file.read / file.write / shell / web.search,UI 多选。
  - 内置 skill 清单(A-10):第一版提供若干占位 skill(如 需求整理 / TDD / 写测试)仅供勾选,实际内容与注入在 S-3+。
  - 创建表单与列表的 UI 布局细节留 plan 决定。
