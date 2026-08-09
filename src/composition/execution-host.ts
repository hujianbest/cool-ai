/**
 * Windows verified-host 执行能力装配入口。这些 Adapter 的传递闭包含
 * `server-only` 标记模块（windows-native-*），不能进入 index.ts barrel；
 * 只有对应 route（merge / recovery resolve / advance）从这里取装配。
 */

export * as mergeJournalService from "@/src/adapters/outbound/sqlite/safe-execution/merge-journal-service";
export * as mergeService from "@/src/adapters/outbound/sqlite/safe-execution/merge-service";
export * as windowsVerifiedExecution from "@/src/adapters/outbound/workspace/windows-verified-execution-adapter";
