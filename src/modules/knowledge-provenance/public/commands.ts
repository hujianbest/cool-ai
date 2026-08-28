import type { TransactionContext } from "@/src/application/transaction-context";
import type {
  CommitReviewMemoryCandidateInput,
  CreateMemoryInput,
  CurationCandidateDto,
  CurationDecisionResultDto,
  DecideCurationInput,
  MemoryCollectionCatalogDto,
  MemoryCollectionDto,
  MemoryEntryV6,
  ProposeCurationInput,
  ReviewMemoryAssociation,
} from "./dto";

export interface KnowledgeProvenanceCommands {
  createMemory: (
    databasePath: string,
    projectId: string,
    input: CreateMemoryInput,
  ) => MemoryEntryV6;
  createMemoryCollection: (
    databasePath: string,
    projectId: string,
    input: { name: string },
  ) => MemoryCollectionDto;
  addMemoryToCollection: (
    databasePath: string,
    projectId: string,
    collectionId: string,
    input: { memoryId: string },
  ) => void;
  deleteMemoryCollection: (
    databasePath: string,
    projectId: string,
    collectionId: string,
  ) => void;
  removeMemoryFromCollection: (
    databasePath: string,
    projectId: string,
    collectionId: string,
    input: { memoryId: string },
  ) => void;
  proposeCuration: (
    databasePath: string,
    projectId: string,
    input: ProposeCurationInput,
  ) => CurationCandidateDto;
  decideCuration: (
    databasePath: string,
    projectId: string,
    candidateId: string,
    input: DecideCurationInput,
  ) => CurationDecisionResultDto;
}

export interface ReviewMemoryCommitCapability {
  commitReviewMemoryCandidate: (
    transaction: TransactionContext,
    input: CommitReviewMemoryCandidateInput,
  ) => ReviewMemoryAssociation;
}
