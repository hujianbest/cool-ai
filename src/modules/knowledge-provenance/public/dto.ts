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

export type CurationSourceInput = {
  id: string;
  type: MemorySourceType;
  version?: string | null;
};

export type ProposeCurationInput = {
  agentId: string;
  content: string;
  operationId: string;
  sources: CurationSourceInput[];
  supersedesId?: string;
  type: MemoryType;
};

export type CurationCandidateDto = {
  agentId: string;
  content: string;
  createdAt: string;
  id: string;
  projectId: string;
  sources: Array<{
    href: string | null;
    id: string;
    type: MemorySourceType;
    version: string | null;
  }>;
  status: "pending" | "published" | "rejected" | "replaced";
  supersedesId: string | null;
  type: MemoryType;
};

export type CurationDiffLineDto = {
  kind: "added" | "removed" | "unchanged";
  text: string;
};

export type CurationCandidateListItemDto = CurationCandidateDto & {
  agentName: string;
  diff: CurationDiffLineDto[];
};

export type DecideCurationInput = {
  action: "publish" | "reject";
  operationId: string;
};

export type CurationDecisionResultDto = {
  candidate: CurationCandidateListItemDto;
  memory: MemoryEntryV6 | null;
};

export type CurationApprovalProjectionDto = {
  content: string;
  createdAt: string;
  id: string;
  status: "pending" | "replaced";
  supersedesId: string | null;
  supersedesVersion: number | null;
};

export type MemoryCollectionDto = {
  id: string;
  name: string;
  projectId: string;
};

export type MemoryCollectionMemberDto = {
  chainId: string;
  memoryId: string;
};

export type MemoryCollectionCatalogDto = MemoryCollectionDto & {
  members: MemoryCollectionMemberDto[];
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

export type KnowledgeGraphDto = {
  edges: Array<{ fromId: string; kind: "collection" | "supersedes"; toId: string }>;
  nodes: Array<{ id: string; title: string }>;
};
