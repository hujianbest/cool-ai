# 043 SOP 状态投影 code-review

- 固定点: `7f997ec`（042/S-58 ship）
- 范围: 该点之后的 043 工作树
- 日期: 2026-08-15
- 评审人: 独立 subagent（Standards + Spec 双轴）；作者未自评通过

## Standards

1. **严重（已修复）** MWK `sop-state-projection.ts` 曾直接 import PWS 私有 `workspace-browse-service`。已改为注入 `ProjectWorkspaceQueries` 浏览端口；route 从 composition 接线 verified-handle。独立复审 PASS。
2. **一般** SOP DTO 挂在 MissionWorkQueries；产品架构写 MWK 不拥有 SOP 读投影，本片 backlog 指定 `CAP-MWK-03`。不阻塞。
3. **建议** onboarding 多处 SOP stub 可抽公共夹具；面板 JSON 解析可去重。

## Spec

无严重/一般缺口。发现/解析/匹配/陈旧/未绑定 200、无正文、相对路径、零 schema/outbox、流程状态区均落地。

建议：补 20 条上限与 `source_unreadable` 专项用例；`done（…）` 后缀按 A-305 精确 `done`。

## 结论

初审 Standards 需修改；作者去掉跨 owner 私有 Adapter 导入后独立复审 **PASS**（2026-08-15）。延期不阻塞：stub 去重、20 条上限专项用例。
