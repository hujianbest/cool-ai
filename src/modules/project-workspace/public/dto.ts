export type { Project } from "@/src/shared/contracts";
export type {
  MembershipState,
  ProjectMember,
  WorkspaceState,
} from "@/src/shared/project-context-contracts";

export type ValidationPolicyEntryInput = {
  args: string[];
  executable: string;
  required: boolean;
  workdir: string;
};

export type ValidationPolicyEntry = ValidationPolicyEntryInput & {
  executableIdentity: string;
  id: string;
  position: number;
  tupleHash: string;
};

export type ValidationPolicy = {
  classifierVersion: number;
  entries: ValidationPolicyEntry[];
  policyHash: string;
  projectId: string;
  revisionId: string;
  revisionNo: number;
  version: number;
  warningAccepted: boolean;
};

export type ReplaceMembersInput = {
  agentIds: string[];
  expectedProjectVersion: number;
};

export type BindWorkspaceInput = {
  path: string;
  expectedVersion: number;
  confirmRebind: boolean;
};

export type WorkspaceDirectoryEntry = {
  kind: "dir" | "file";
  name: string;
  sensitive: boolean;
  sizeBytes?: number;
};

export type WorkspaceDirectoryListing = {
  entries: WorkspaceDirectoryEntry[];
  path: string;
};

export type WorkspaceImageContentType =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export type WorkspaceFilePreview =
  | {
      content: string;
      kind: "text";
      lineCount: number;
      sizeBytes: number;
      truncated: boolean;
    }
  | {
      contentType: WorkspaceImageContentType;
      dataUrl: string;
      kind: "image";
      sizeBytes: number;
    }
  | { kind: "binary-unsupported" }
  | { kind: "sensitive-masked" };

export type WorkspaceOperation = "realpath" | "stat" | "access";

export type WorkspaceFs = {
  realpath(path: string): Promise<string>;
  statDirectory(path: string): Promise<boolean>;
  checkReadable(path: string): Promise<void>;
};

export type ResolvedExecutable = {
  executable: string;
  executableIdentity: string;
};

export type SaveValidationPolicyInput = {
  entries: ValidationPolicyEntryInput[];
  expectedVersion: number;
  operationId: string;
  warningAccepted: boolean;
};

export type SaveValidationPolicyResult = {
  outcome: "rejected" | "saved";
  policy: ValidationPolicy;
  reasonCode: string | null;
};

export type ValidationPolicyAudit = {
  afterPolicyHash: string | null;
  beforePolicyHash: string;
  outcome: "rejected" | "saved";
  sequence: number;
  warningAccepted: boolean;
};
