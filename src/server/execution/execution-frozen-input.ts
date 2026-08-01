import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { ExecutionError } from "./execution-service";
import {
  frozenExecutionPromptInputSchema,
  type FrozenExecutionPromptInput,
} from "./execution-prompt-builder";

type CaptureInput = {
  agentId: string;
  baselineManifestHash: string | null;
  missionId: string;
  projectId: string;
  sourceCollaborationRunId: string;
  workItemId: string;
};

const publicFactsSchema = z.object({
  dependencies: frozenExecutionPromptInputSchema.shape.dependencies,
  members: z.array(z.object({
    accentToken: z.string(),
    agentId: z.string(),
    avatarText: z.string(),
    joinedAt: z.string(),
    model: z.string(),
    name: z.string(),
    permissions: frozenExecutionPromptInputSchema.shape.currentAgent.shape.permissions,
    role: z.string(),
    skills: z.array(z.object({
      id: z.string(),
      name: z.string(),
      version: z.number().int(),
    }).strict()),
  }).strict()),
  mission: frozenExecutionPromptInputSchema.shape.mission,
  provider: z.object({
    baseUrl: z.string(),
    defaultModel: z.string(),
    id: z.string(),
    model: z.string(),
    name: z.string(),
  }).strict(),
  sharedMemory: frozenExecutionPromptInputSchema.shape.sharedContext,
  sourceCollaborationRunId: z.string(),
  task: frozenExecutionPromptInputSchema.shape.task,
  validationPolicy: frozenExecutionPromptInputSchema.shape.validationPolicy,
  workspaceBaselineHash: z.string().nullable(),
}).strict();

const privateFactsSchema = z.object({
  currentAgent: frozenExecutionPromptInputSchema.shape.currentAgent,
}).strict();

export const frozenPublicEnvelopeSchema = z.object({
  facts: publicFactsSchema,
  fingerprintVersion: z.literal(1),
  schemaVersion: z.literal(5),
}).strict();

export const frozenPrivateEnvelopeSchema = z.object({
  facts: privateFactsSchema,
  fingerprintVersion: z.literal(1),
  promptInput: frozenExecutionPromptInputSchema,
  schemaVersion: z.literal(5),
}).strict();

type FrozenPublicEnvelope = z.infer<typeof frozenPublicEnvelopeSchema>;
type FrozenPrivateEnvelope = z.infer<typeof frozenPrivateEnvelopeSchema>;

export type CapturedExecutionFrozenInput = {
  contextHash: string;
  privateEnvelope: FrozenPrivateEnvelope;
  publicEnvelope: FrozenPublicEnvelope;
};

export type FrozenInputBoundary =
  | { categories: []; disposition: "current"; frozenHash: string }
  | {
      body: { error: { code: "STALE_EXECUTION"; message: string } };
      categories: string[];
      disposition: "stale";
      frozenHash: string;
    };

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function parseArgs(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Stored validation policy arguments are invalid.");
  }
  return parsed;
}

function permissions(row: { canExecute: number; canRead: number; canWrite: number }) {
  return {
    execute: row.canExecute === 1,
    read: row.canRead === 1,
    write: row.canWrite === 1,
  };
}

export function captureExecutionFrozenInput(
  database: DatabaseSync,
  input: CaptureInput,
): CapturedExecutionFrozenInput {
  const task = database.prepare(`
    SELECT id,title,description,status,assignee_agent_id AS assigneeAgentId,version
    FROM work_items WHERE id=? AND mission_id=?
  `).get(input.workItemId, input.missionId) as {
    assigneeAgentId: string | null;
    description: string;
    id: string;
    status: FrozenExecutionPromptInput["task"]["status"];
    title: string;
    version: number;
  } | undefined;
  const mission = database.prepare(`
    SELECT id,title,goal,version FROM missions WHERE id=? AND project_id=?
  `).get(input.missionId, input.projectId) as FrozenExecutionPromptInput["mission"] | undefined;
  const agent = database.prepare(`
    SELECT a.id,a.name,a.role,a.system_prompt AS systemPrompt,a.model,
           a.avatar_text AS avatarText,a.accent_token AS accentToken,
           a.can_read AS canRead,a.can_write AS canWrite,a.can_execute AS canExecute,
           p.id AS providerId,p.name AS providerName,p.base_url AS baseUrl,
           p.default_model AS defaultModel
    FROM agents a JOIN providers p ON p.id=a.provider_id
    WHERE a.id=?
  `).get(input.agentId) as {
    accentToken: string;
    avatarText: string;
    baseUrl: string;
    canExecute: number;
    canRead: number;
    canWrite: number;
    defaultModel: string;
    id: string;
    model: string;
    name: string;
    providerId: string;
    providerName: string;
    role: string;
    systemPrompt: string;
  } | undefined;
  if (!task || !mission || !agent) {
    throw new Error("Execution frozen input facts are unavailable.");
  }

  const dependencies = database.prepare(`
    WITH RECURSIVE dependencies(id) AS (
      SELECT depends_on_id FROM work_item_dependencies WHERE work_item_id=?
      UNION
      SELECT d.depends_on_id FROM work_item_dependencies d
      JOIN dependencies prior ON d.work_item_id=prior.id
    )
    SELECT w.id,w.title,w.status,w.version
    FROM dependencies d JOIN work_items w ON w.id=d.id
    ORDER BY w.id
  `).all(input.workItemId) as FrozenExecutionPromptInput["dependencies"];
  const memory = database.prepare(`
    SELECT entry.id,entry.type,entry.content,entry.source_id AS sourceRef
    FROM memory_entries entry
    WHERE entry.project_id=?
      AND NOT EXISTS (
        SELECT 1 FROM memory_entries child WHERE child.supersedes_id=entry.id
      )
    ORDER BY entry.created_at,entry.id
  `).all(input.projectId) as FrozenExecutionPromptInput["sharedContext"];
  const memberRows = database.prepare(`
    SELECT pm.agent_id AS agentId,pm.joined_at AS joinedAt,a.name,a.role,a.model,
           a.avatar_text AS avatarText,a.accent_token AS accentToken,
           a.can_read AS canRead,a.can_write AS canWrite,a.can_execute AS canExecute
    FROM project_memberships pm JOIN agents a ON a.id=pm.agent_id
    WHERE pm.project_id=? ORDER BY pm.joined_at,pm.agent_id
  `).all(input.projectId) as Array<{
    accentToken: string;
    agentId: string;
    avatarText: string;
    canExecute: number;
    canRead: number;
    canWrite: number;
    joinedAt: string;
    model: string;
    name: string;
    role: string;
  }>;
  const memberSkills = database.prepare(`
    SELECT s.id,s.name,s.version
    FROM agent_skills assignment JOIN skills s ON s.id=assignment.skill_id
    WHERE assignment.agent_id=? ORDER BY assignment.position,s.id
  `);
  const members = memberRows.map((member) => {
    const skills = memberSkills.all(member.agentId) as Array<{
      id: string;
      name: string;
      version: number;
    }>;
    return {
      accentToken: member.accentToken,
      agentId: member.agentId,
      avatarText: member.avatarText,
      joinedAt: member.joinedAt,
      model: member.model,
      name: member.name,
      permissions: permissions(member),
      role: member.role,
      skills,
    };
  });
  const skillRows = database.prepare(`
    SELECT assignment.position,s.id,s.version,s.name,s.instructions
    FROM agent_skills assignment JOIN skills s ON s.id=assignment.skill_id
    WHERE assignment.agent_id=? ORDER BY assignment.position,s.id
  `).all(input.agentId) as FrozenExecutionPromptInput["currentAgent"]["skills"];
  const policy = database.prepare(`
    SELECT pointer.active_revision_id AS revisionId,pointer.version,
           revision.policy_hash AS policyHash,
           revision.classifier_version AS classifierVersion
    FROM project_validation_policies pointer
    JOIN project_validation_policy_revisions revision
      ON revision.project_id=pointer.project_id
     AND revision.id=pointer.active_revision_id
    WHERE pointer.project_id=?
  `).get(input.projectId) as Omit<
    FrozenExecutionPromptInput["validationPolicy"],
    "entries"
  > | undefined;
  if (!policy) throw new Error("Execution validation policy is unavailable.");
  const policyRows = database.prepare(`
    SELECT position,id,executable,executable_identity AS executableIdentity,
           args_json AS argsJson,workdir,required,tuple_hash AS tupleHash
    FROM project_validation_policy_entries
    WHERE project_id=? AND revision_id=? ORDER BY position,id
  `).all(input.projectId, policy.revisionId) as Array<{
    argsJson: string;
    executable: string;
    executableIdentity: string;
    id: string;
    position: number;
    required: number;
    tupleHash: string;
    workdir: string;
  }>;
  const validationPolicy: FrozenExecutionPromptInput["validationPolicy"] = {
    ...policy,
    entries: policyRows.map(({ argsJson, required, ...entry }) => ({
      ...entry,
      args: parseArgs(argsJson),
      required: required === 1,
    })),
  };
  const promptMembers: FrozenExecutionPromptInput["members"] = members.map((member) => ({
    accentToken: member.accentToken,
    agentId: member.agentId,
    avatarText: member.avatarText,
    name: member.name,
    permissions: member.permissions,
    role: member.role,
    skillNames: member.skills.map((skill) => skill.name),
  }));
  const promptInput: FrozenExecutionPromptInput = {
    currentAgent: {
      id: agent.id,
      name: agent.name,
      permissions: permissions(agent),
      role: agent.role,
      skills: skillRows,
      systemPrompt: agent.systemPrompt,
    },
    dependencies,
    manifests: {
      baseline: {
        fileCount: 0,
        hash: input.baselineManifestHash ?? hash({ empty: true }),
        totalBytes: 0,
      },
      sandbox: null,
    },
    members: promptMembers,
    mission,
    priorToolResults: [],
    publicCollaboration: [],
    publicSummaries: [],
    schemaVersion: 5,
    sharedContext: memory,
    task,
    validationPolicy,
  };
  const publicFacts = {
    dependencies,
    members,
    mission,
    provider: {
      baseUrl: agent.baseUrl,
      defaultModel: agent.defaultModel,
      id: agent.providerId,
      model: agent.model,
      name: agent.providerName,
    },
    sharedMemory: memory,
    sourceCollaborationRunId: input.sourceCollaborationRunId,
    task,
    validationPolicy,
    workspaceBaselineHash: input.baselineManifestHash,
  };
  const privateFacts = {
    currentAgent: promptInput.currentAgent,
  };
  const publicEnvelope = frozenPublicEnvelopeSchema.parse({
    facts: publicFacts,
    fingerprintVersion: 1,
    schemaVersion: 5,
  });
  const privateEnvelope = frozenPrivateEnvelopeSchema.parse({
    facts: privateFacts,
    fingerprintVersion: 1,
    promptInput,
    schemaVersion: 5,
  });
  return {
    contextHash: hash({ privateFacts, promptInput, publicFacts }),
    privateEnvelope,
    publicEnvelope,
  };
}

function invalidFrozenInput(): ExecutionError {
  return new ExecutionError(
    "FROZEN_INPUT_INVALID",
    500,
    "Stored frozen execution input failed integrity validation.",
  );
}

function parseEnvelope<T>(value: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(value) as unknown);
  } catch {
    throw invalidFrozenInput();
  }
}

export function parseFrozenPrivateEnvelope(value: string): FrozenPrivateEnvelope {
  return parseEnvelope(value, frozenPrivateEnvelopeSchema);
}

function changedCategories(
  frozen: Record<string, unknown>,
  current: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(frozen), ...Object.keys(current)]);
  return [...keys]
    .filter((key) => hash(frozen[key]) !== hash(current[key]))
    .sort(compareUtf8);
}

export function staleExecutionIfFrozenInputChanged(
  database: DatabaseSync,
  executionId: string,
): FrozenInputBoundary {
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare(`
      SELECT e.id,e.project_id AS projectId,e.source_collaboration_run_id AS sourceRunId,
             e.mission_id AS missionId,e.work_item_id AS workItemId,e.agent_id AS agentId,
             e.current_attempt_no AS attemptNo,e.version,
             a.id AS attemptId,a.baseline_manifest_hash AS baselineHash,
             a.frozen_public_json AS publicJson,a.frozen_private_json AS privateJson,
             a.frozen_context_hash AS contextHash
      FROM executions e JOIN execution_attempts a
        ON a.project_id=e.project_id AND a.execution_id=e.id
       AND a.attempt_no=e.current_attempt_no
      WHERE e.id=?
    `).get(executionId) as {
      agentId: string;
      attemptId: string;
      attemptNo: number;
      baselineHash: string | null;
      contextHash: string;
      missionId: string;
      privateJson: string;
      projectId: string;
      publicJson: string;
      sourceRunId: string;
      version: number;
      workItemId: string;
    } | undefined;
    if (!row) throw new Error("Execution was not found.");
    const frozenPublic = parseEnvelope(row.publicJson, frozenPublicEnvelopeSchema);
    const frozenPrivate = parseFrozenPrivateEnvelope(row.privateJson);
    if (hash({
      privateFacts: frozenPrivate.facts,
      promptInput: frozenPrivate.promptInput,
      publicFacts: frozenPublic.facts,
    }) !== row.contextHash) {
      throw invalidFrozenInput();
    }
    const frozenBaseline = (frozenPublic.facts as {
      workspaceBaselineHash?: unknown;
    }).workspaceBaselineHash;
    const current = captureExecutionFrozenInput(database, {
      agentId: row.agentId,
      baselineManifestHash: frozenBaseline === null ? null : row.baselineHash,
      missionId: row.missionId,
      projectId: row.projectId,
      sourceCollaborationRunId: row.sourceRunId,
      workItemId: row.workItemId,
    });
    if (current.contextHash === row.contextHash) {
      if (frozenBaseline === null && row.baselineHash !== null) {
        const hydrated = captureExecutionFrozenInput(database, {
          agentId: row.agentId,
          baselineManifestHash: row.baselineHash,
          missionId: row.missionId,
          projectId: row.projectId,
          sourceCollaborationRunId: row.sourceRunId,
          workItemId: row.workItemId,
        });
        const updated = database.prepare(`
          UPDATE execution_attempts
          SET frozen_public_json=?,frozen_private_json=?,frozen_context_hash=?
          WHERE id=? AND frozen_context_hash=?
        `).run(
          JSON.stringify(hydrated.publicEnvelope),
          JSON.stringify(hydrated.privateEnvelope),
          hydrated.contextHash,
          row.attemptId,
          row.contextHash,
        );
        if (updated.changes !== 1) {
          throw new Error("Execution frozen input changed during baseline hydration.");
        }
        database.exec("COMMIT");
        return {
          categories: [],
          disposition: "current",
          frozenHash: hydrated.contextHash,
        };
      }
      database.exec("COMMIT");
      return { categories: [], disposition: "current", frozenHash: row.contextHash };
    }
    const categories = [
      ...changedCategories(frozenPublic.facts, current.publicEnvelope.facts),
      ...changedCategories(frozenPrivate.facts, current.privateEnvelope.facts),
    ].sort(compareUtf8);
    const body = {
      error: {
        code: "STALE_EXECUTION" as const,
        message: "Execution inputs changed; retry to capture the current context.",
      },
    };
    database.prepare(`
      UPDATE executions
      SET status='stale',resume_target=NULL,reason_code='STALE_EXECUTION',
          version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND status IN ('queued','running','waiting_approval','paused','staged')
    `).run(executionId);
    database.prepare(`
      UPDATE execution_actions
      SET status='discarded',lease_token=NULL,lease_expires_at=NULL,
          result_json=NULL,error_code='STALE_EXECUTION',
          finished_at=coalesce(finished_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      WHERE execution_id=? AND status IN ('pending','running')
    `).run(executionId);
    database.prepare(`
      UPDATE execution_model_calls
      SET status='discarded',error_category='stale_context',
          finished_at=coalesce(finished_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      WHERE execution_id=? AND status<>'discarded'
        AND action_id IN (
          SELECT id FROM execution_actions
          WHERE execution_id=? AND status='discarded'
            AND error_code='STALE_EXECUTION' AND result_json IS NULL
        )
    `).run(executionId, executionId);
    database.prepare(`
      UPDATE execution_tool_calls
      SET status='discarded',
          finished_at=coalesce(finished_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      WHERE execution_id=? AND status IN ('requested','waiting_approval')
    `).run(executionId);
    database.prepare(`
      UPDATE execution_approvals
      SET status='expired',decided_at=coalesce(decided_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      WHERE execution_id=? AND status IN ('pending','approved')
    `).run(executionId);
    database.prepare(`
      UPDATE execution_operations
      SET status='completed',final_action_index=action_count-1,http_status=409,
          response_json=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE execution_id=? AND status='pending' AND action_count>0
    `).run(JSON.stringify(body), executionId);
    const sequence = (database.prepare(`
      SELECT next_event_sequence AS value FROM executions WHERE id=?
    `).get(executionId) as { value: number }).value;
    database.prepare(`
      INSERT INTO execution_events (
        id,project_id,execution_id,sequence,attempt_no,type,actor_type,
        actor_id,payload_json,created_at
      ) VALUES (?, ?, ?, ?, ?, 'stale_detected', 'system', NULL, ?,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(
      randomUUID(),
      row.projectId,
      executionId,
      sequence,
      row.attemptNo,
      JSON.stringify({ categories, pathCount: 0 }),
    );
    database.prepare(`
      UPDATE executions SET next_event_sequence=next_event_sequence+1 WHERE id=?
    `).run(executionId);
    database.exec("COMMIT");
    return {
      body,
      categories,
      disposition: "stale",
      frozenHash: row.contextHash,
    };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the frozen-input error.
    }
    throw error;
  }
}
