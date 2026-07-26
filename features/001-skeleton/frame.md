# 001-skeleton Frame(行走骨架)

- 日期: 2026-07-26
- 意图: 为多 agent 协作平台搭建可运行的 Next.js 行走骨架,用户能一条命令启动并打开 Web UI 看到空的项目组/agent 管理界面,打通 UI→API→DB→UI 的最薄端到端路径(LLM 未接)。
- 切片: S-1
- 范围外: 不接 LLM/不实现 agent 执行逻辑/不做真实角色协作(后续切片);不做认证;不做部署;不做角色模板。
- 模式: 建造
- 风险档位: 2
- 档位理由: 全新项目全栈结构搭建(UI+API+DB 三层首次落地),非单点小改;但无可逆性风险、不碰安全/数据迁移/公共接口,属"新功能默认档"而非高危。
- 用户可感知: 是
- 环境基线: evidence/baseline-20260725T172948Z.log (exit 0)
- 基线说明: 全新项目。搭最小 vitest 测试骨架,跑通 1 个空测试,证明 Node v24 + TS + vitest 工具链可用。基线过程中修复 hf_gate.py 的 Windows 兼容性(shell=True on nt + utf-8 编码/输出),记入 A-12。
- 假设:
  - 脚手架用 create-next-app(App Router)+ TS + Tailwind,符合 D-4。
  - 数据层用 Prisma + SQLite(D-4),最薄端到端路径 = 在 DB 存一条占位记录(如默认 agent),API 读出,UI 回显一条真实数据。
  - UI 用 Tailwind 做基础布局:侧栏(项目组/agent 列表占位)+ 主区(消息流占位),内容可占位但层不可 mock。
  - 一键命令:README 写明 `npm run dev`(启动)与 `npm test`(测试)。
