# 021-test-suite-green 任务票

- [x] T-01 修复 `tests/architecture/helpers.ts` Windows 路径分隔符缺陷（`relative()` 返回反斜杠，与测试内正斜杠正则/集合不匹配），消除 writers 201 假违规与 imports 假阳性；跑 tests/architecture 记录剩余真实违规。
- [x] T-02 修复 `tests/modules/public-collaboration/project-chat.api.test.ts` 的 `import.meta.glob` 相对路径（019 迁移后深度变化），6 用例恢复。
- [x] T-03 修复 `tests/modules/mission-work/work-item-transitions.test.ts` 夹具输入（`createMission` INVALID_INPUT），5 用例恢复；若是生产校验缺陷则另报。
- [x] T-04 诊断修复 `tests/modules/review-delivery/review-production-application.test.ts` 的 `validateCurrentDataInvariants` 返回 SCHEMA_DATA_INVALID（原子恢复后不变量失败）。根因：夹具构造了生产不可达的 staged 非法中间态；夹具对齐 persistComputedStage 真实产出，未动生产代码与断言。
- [x] T-05 收编真实架构违规（T-01 修复后确认：无未登记违规，剩余边均为测试内已记账的 TRANSITIONAL 豁免，无需代码改动）。
- [x] T-06 全量套件全绿 + `npm run build` + 数据落盘 progress.md。结果：232 文件 / 1822 用例全部通过（101.85s）。
