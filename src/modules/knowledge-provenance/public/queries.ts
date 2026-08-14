import type { TransactionContext } from "@/src/application/transaction-context";
import type {
  MemoryEntryV6,
  MemorySearchHit,
  ResolvedMemorySource,
  ResolveMemorySourceInput,
  SearchMemoriesOptions,
} from "./dto";

export interface KnowledgeProvenanceQueries {
  listMemories: (
    databasePath: string,
    projectId: string,
    includeInactive?: boolean,
  ) => MemoryEntryV6[];
  listMemoriesInTransaction: (
    transaction: TransactionContext,
    projectId: string,
    includeInactive?: boolean,
  ) => MemoryEntryV6[];
  resolveMemorySource: (
    transaction: TransactionContext,
    input: ResolveMemorySourceInput,
  ) => ResolvedMemorySource;
  searchMemories: (
    databasePath: string,
    projectId: string,
    options: SearchMemoriesOptions,
  ) => MemorySearchHit[];
}
