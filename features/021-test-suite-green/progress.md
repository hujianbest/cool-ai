# 进度

- 特性: 021-test-suite-green
- 当前阶段: done
- 执行模式: auto（用户 2026-08-09 明示：不在电脑前，问题按助手推荐处理）
- 已加载扩展: 无
- 下一步: 无（全绿已交付）

## 实施记录

- 2026-08-10 T-01 ✅ helpers.ts 路径规范化（Windows 反斜杠 → 正斜杠），架构套件 25/25 绿；确认无未登记真实违规（预期违规均为测试内已记账 TRANSITIONAL 豁免），T-05 取消。
- 2026-08-10 T-02 ✅ project-chat.api glob 深度修正（../../../app/...），6/6 绿。
- 2026-08-10 T-03 ✅ work-item-transitions 夹具补 operationId + expectedVersion:0（对齐当前契约，非生产回归），5/5 绿。
- 2026-08-10 T-04 ✅ review-production-application 根因为夹具构造了生产不可达的 staged 非法中间态（头计数与子表基数不符），夹具对齐 persistComputedStage 真实产出，未动生产代码与断言；review-delivery 目录 186 全绿。
- 2026-08-10 T-06 ✅ 全量 232 文件 / 1822 用例全部通过（101.85s）；npm run build 通过。
- 评审状态: 项目级 review 豁免（2026-08-09）；不伪造评审工件
- 用户可感知: 否（缺陷修复与收敛收尾；验收为全量套件全绿）

## 目标

修复 master 上 6 个文件 / 18 个既有失败用例（019 T-16 未完成的收尾）：

1. tests/architecture/dependency-graph.test.ts（1）— workflow → sqlite/connection 直连边
2. tests/architecture/imports.test.ts（4）— 跨层/深导违规
3. tests/architecture/writers.test.ts（1）— 非 owner writer
4. tests/modules/mission-work/work-item-transitions.test.ts（5）— MissionError INVALID_INPUT
5. tests/modules/public-collaboration/project-chat.api.test.ts（6）— 路由/glob 断言
6. tests/modules/review-delivery/review-production-application.test.ts（1）— 原子恢复
