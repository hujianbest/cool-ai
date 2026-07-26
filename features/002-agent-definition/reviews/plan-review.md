# plan.md 评审 (第 2 轮 复审)

- 日期: 2026-07-26
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-07-26

复审范围:仅核对第 1 轮 findings 是否闭合,不翻案、不扩范围。依据修订后的 `plan.md`(v2)与 `frame.md`(v2)。

## 第 1 轮 findings 闭合情况

### 严重

- [严重→已闭合] T-1 判据"15 测试在适配后仍绿"事实错误 — plan §2 line 46 已显式声明"本特性对 S-1 既有代码是破坏性变更…必须在 T-1 内一并适配(清单见 T-1)";T-1 判据(line 109)改为"适配清单全部完成且全量 `npm test` 绿",并列出 4 个文件逐项适配(`agentService.test.ts`、`components/AgentList.tsx`、`tests/AgentList.test.tsx`、`tests/agentsApi.test.ts`)。措辞已从"仍绿"转为"适配后全绿",与破坏性事实一致。

### 一般

- [一般→已闭合] frame 档位理由失真 — frame §9 line 9 已改写为"新功能 + 破坏性 schema 迁移(去 role 列 + SQLite 重建表 + 新增四列)。属档位 2:爆炸半径可控——dev.db 仅含 seed 数据、可重置,无对外 API 契约…",理由如实,档位保留为 2 有据。

- [一般→已闭合] 读侧序列化契约未钉死 — 已在多处钉死 service 层反序列化方案并贯穿:FR-2 验收(line 23-24)明确 `tools/skills` 为 `string[]`、"service 层反序列化为数组";PD-4(line 63)选 B 显式取舍;接口契约(line 67)AgentDTO 含 `service 负责 JSON.parse(失败回退 [])`;§3 测试(line 79-81)断言数组;T-2/T-3 判据均含"数组"字样。

- [一般→已闭合] AgentList 刷新契约缺口 — 已定义 version 机制并贯穿:§2 组件契约(line 54)"新增 `version: number` prop(默认 0),写入 useEffect 依赖,version 变化时重新拉取";PD-3(line 62)记录取舍;接口契约(line 70)"`AgentList({version=0})` version 变 → 重拉";§3 测试(line 81)与 T-4 判据(line 112)均含"version+1 后出现新 mock"。

### 建议

- [建议→已闭合] provider 小标签未回指 FR — §2 line 54 与 §4 line 92 均改为"仅显示名字",小标签已移除,消除回指缺失。

- [建议→已闭合] NFR-1 主按钮对比度 — line 41、§4 line 89/105 引入 `--accent-strong #15803d`,白字对比度 ≈5.6:1 显式标注满足 AA 正文;森绿 `#16a34a` 限定为非文本点缀。歧义消除。

- [建议→已闭合] FR-4 补 name 缺失路径 — FR-4(line 36-37)、错误处理(line 73)、T-2(line 110)、T-3(line 111)均覆盖 `name 为 undefined / "" / "   "` 与 trim;handler 判据补"name undefined→400"。
  - [接受现状] 服务端按内置池校验 tools/skills/provider — §0 line 7 显式声明"亦推迟(S-3 接入执行时再做),本切片 API 仅校验 name",属明确的范围决策而非遗漏,接受现状合理。

- [建议→接受现状] T-1 体量偏大、可拆 T-1b — 未拆分,但 T-1 判据(line 109)已把适配清单按文件细化、判据可逐项核验,红绿节奏可见;原建议自评非阻塞,接受现状。

- [建议→已闭合] 迁移机制未指明 — §2 line 50 明示"用 `prisma migrate dev --name add_agent_fields` 生成 migration 文件(可复现,非 db push)";T-1 判据(line 109)同述。verify 阶段可复现。

## 新增 findings

无。未发现第 1 轮未涉及的严重问题。
