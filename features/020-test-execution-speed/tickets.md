# 020-test-execution-speed 任务票

- [x] T-01 新树基线测量：当前 master 完整 `npm test`，记录墙钟、阶段分解与通过/失败集合（作为对比基准）。
- [x] T-02 移除 `vitest.config.ts` 的 `maxWorkers: 2` 覆盖；跑完整套件记录墙钟与失败集合（须与基线一致）。
- [x] T-03 默认环境切 `node`：`vitest.config.ts` `environment: "node"`；`tests/setup.ts` 增加 `typeof window !== "undefined"` 守卫（node 下跳过 cleanup/history 与 jest-dom 耦合部分）；55 个 `.test.tsx` 文件头部加 `// @vitest-environment jsdom`；跑完整套件记录墙钟与失败集合（须与基线一致）。
- [x] T-04 内存库夹具基建：`tests/fixtures/sqlite/memory-database.ts` 提供 `memoryDatabasePath()`（唯一 `file:cool-ai-test-<pid>-<n>?mode=memory&cache=shared` URI + keeper 连接保持存活 + afterEach 自动关闭）；`src/adapters/outbound/sqlite/connection.ts` 对 `file:`/`:memory:` 路径跳过 `mkdirSync`；选 1 个代表文件（如 `tests/modules/mission-work/mission-crud.test.ts`）试点迁移并验证通过。
- [x] T-05 迁移 COCKPIT_DB_PATH 环境变量类测试（约 50 文件）到内存夹具；保留文件库的例外清单：spawn 子进程的（execution-write-stage-integration、execution-approvals、execution-orchestrator、theme-hydration-browser、*-smoke-contract、review-browser-full-chain）与显式文件语义测试。
- [x] T-06 迁移 mkdtemp 直连类服务测试（约 60 文件）到内存夹具；保留文件库的例外：current-schema*.test.ts、structured-message-reopen、merge-external-writer、windows-native-*、sandbox/process 相关及任何对 DB 文件本身断言的测试；拿不准的保留文件库并在 progress.md 记录原因。
- [x] T-07 收尾验证：完整套件墙钟与失败集合比对（失败集合必须与基线完全一致）；`npm run build` 通过；对比数据写入 progress.md。
