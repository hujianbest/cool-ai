import type { TransactionContext } from "@/src/application/transaction-context";
import type {
  CommitReviewMemoryCandidateInput,
  CreateMemoryInput,
  MemoryEntryV6,
  ReviewMemoryAssociation,
} from "./dto";

export interface KnowledgeProvenanceCommands {
  createMemory: (
    databasePath: string,
    projectId: string,
    input: CreateMemoryInput,
  ) => MemoryEntryV6;
}

export interface ReviewMemoryCommitCapability {
  commitReviewMemoryCandidate: (
    transaction: TransactionContext,
    input: CommitReviewMemoryCandidateInput,
  ) => ReviewMemoryAssociation;
}
