import type {
  MemoryEntryV6,
  MemorySource,
  MemorySourceType,
  MemoryType,
} from "@/src/shared/memory-contracts";

export type {
  MemoryEntryV6,
  MemorySource,
  MemorySourceType,
  MemoryType,
} from "@/src/shared/memory-contracts";

export type CreateMemoryInput = {
  type: MemoryType;
  content: string;
  sourceType: "owner_input" | "work_item" | "artifact_path";
  sourceRef: string;
  supersedesId?: string;
};

export type ReviewMemoryCandidate = {
  content: string;
  id: string;
  sourceId: string;
  sourceType: string;
  sourceVersion: string;
  supersedesMemoryId: string | null;
  type: string;
};

export type ReviewMemoryAssociation = {
  memoryId: string;
  memoryVersion: number;
  outcome: "created" | "reused" | "superseded";
};

export type CommitReviewMemoryCandidateInput = {
  attemptId: string;
  candidate: ReviewMemoryCandidate;
  decisionId: string;
  memoryId: string;
  now: string;
  projectId: string;
  reviewerAgentId: string;
};

export type ResolveMemorySourceInput = {
  confirmingReviewAttemptId: string;
  id: string;
  projectId: string;
  type: "task" | "result" | "review" | "validation" | "artifact";
  version: string;
};

export type ResolvedMemorySource = MemorySource & { href: string; version: string };

export type SearchMemoriesOptions = {
  q: string;
  limit?: number;
  sourceType?: MemorySourceType;
  type?: MemoryType;
  version?: number;
};

export type MemorySearchHit = {
  memory: MemoryEntryV6;
  snippet: string;
};
