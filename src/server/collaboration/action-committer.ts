import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { CollaborationError } from "@/src/server/collaboration/collaboration-errors";
import type { AgentTurn } from "@/src/server/collaboration/agent-turn-schema";
import { collaborationPublicMessageWindow } from "@/src/server/collaboration/prompt-builder";
import {
  appendRunEventFactTx,
} from "@/src/server/collaboration/thread-service";
import {
  claimWorkItemTx,
  createWorkItemBatchTx,
  MissionError,
} from "@/src/server/mission-service";
import type { TimelineEventType } from "@/src/shared/collaboration-contracts";
import {
  commitStructuredMessageTx,
  ingestStructuredBlocks,
  materializeStructuredBlocks,
} from "@/src/server/structured-messages/structured-message-store";

export type CommitAgentTaskActionsInput = {
  agentId: string;
  attemptId: string;
  runId: string;
  timestamp: string;
  turn: AgentTurn;
};

export type CommitAgentTaskActionsResult = {
  claimedWorkItemId: string | null;
  messageId: string;
  messageSequence: number;
  taskIdsByClientKey: Record<string, string>;
  turnId: string;
};

type CommitContext = {
  agentDisplayName: string;
  includedMessageSequence: number;
  missionId: string;
  projectId: string;
  threadId: string;
  roundCount: number;
};

type PlanReadyMissing = "participants" | "tasks" | "claim";

type OwnerRaceReconciliation = {
  hasPendingMessages: boolean;
  latestMentionAgentId: string | null;
};

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

function graphemeLength(value: string): number {
  return Array.from(segmenter.segment(value)).length;
}

function actionConflict(currentVersion?: number): CollaborationError {
  return new CollaborationError(
    "ACTION_CONFLICT",
    409,
    "Agent action conflicts with current project state.",
    {
      category: "action_invalid",
      ...(currentVersion === undefined ? {} : { currentVersion }),
    },
  );
}

function actionInvalid(
  fields?: Record<string, string>,
  missing?: PlanReadyMissing[],
): CollaborationError {
  return new CollaborationError("ACTION_INVALID", 400, "Agent action is invalid.", {
    category: "action_invalid",
    ...(fields ? { fields } : {}),
    ...(missing ? { missing } : {}),
  });
}

function boundaryReached(): CollaborationError {
  return new CollaborationError(
    "BOUNDARY_REACHED",
    409,
    "Agent handoff boundary has been reached.",
    { category: "boundary_reached" },
  );
}

function mapMissionError(error: MissionError): CollaborationError {
  if (error.code === "ACTION_CONFLICT") {
    return actionConflict(error.currentVersion);
  }
  const fields = error.fields?.reduce<Record<string, string>>((result, field) => {
    result[field.field] = field.code;
    return result;
  }, {});
  return actionInvalid(fields && Object.keys(fields).length > 0 ? fields : undefined);
}

function commitContext(
  database: DatabaseSync,
  runId: string,
  agentId: string,
  attemptId: string,
): CommitContext {
  const row = database
    .prepare(
      `SELECT runs.project_id AS projectId,runs.thread_id AS threadId,
              runs.current_agent_id AS currentAgentId,
              runs.round_count AS roundCount, agents.name AS agentDisplayName,
              missions.id AS missionId,
              attempts.included_message_sequence AS includedMessageSequence
       FROM collaboration_runs AS runs
       JOIN collaboration_attempts AS attempts
         ON attempts.id=? AND attempts.project_id=runs.project_id
        AND attempts.thread_id=runs.thread_id AND attempts.run_id=runs.id
       JOIN agents ON agents.id = runs.current_agent_id
       JOIN project_memberships AS memberships
         ON memberships.project_id = runs.project_id
        AND memberships.agent_id = runs.current_agent_id
       JOIN missions ON missions.project_id = runs.project_id
       WHERE runs.id = ?`,
    )
    .get(attemptId, runId) as
    | (CommitContext & { currentAgentId: string })
    | undefined;
  if (!row || row.currentAgentId !== agentId) throw actionConflict();
  return {
    agentDisplayName: row.agentDisplayName,
    includedMessageSequence: row.includedMessageSequence,
    missionId: row.missionId,
    projectId: row.projectId,
    threadId: row.threadId,
    roundCount: row.roundCount,
  };
}

function reconcilePendingOwnerMessages(
  database: DatabaseSync,
  context: CommitContext,
): OwnerRaceReconciliation {
  const row = database
    .prepare(
      `SELECT
         EXISTS(
           SELECT 1
           FROM collaboration_messages
           WHERE project_id=? AND thread_id=? AND author_type='owner'
             AND consumed_at IS NULL AND sequence > ?
         ) AS hasPendingMessages,
         (
           SELECT mention_agent_id
           FROM collaboration_messages
           WHERE project_id=? AND thread_id=? AND author_type='owner'
             AND consumed_at IS NULL AND sequence > ?
             AND mention_agent_id IS NOT NULL
           ORDER BY sequence DESC
           LIMIT 1
         ) AS latestMentionAgentId`,
    )
    .get(
      context.projectId,
      context.threadId,
      context.includedMessageSequence,
      context.projectId,
      context.threadId,
      context.includedMessageSequence,
    ) as { hasPendingMessages: number; latestMentionAgentId: string | null };
  return {
    hasPendingMessages: row.hasPendingMessages === 1,
    latestMentionAgentId: row.latestMentionAgentId,
  };
}

function consumeIncludedOwnerMessages(
  database: DatabaseSync,
  context: CommitContext,
  timestamp: string,
): void {
  const ownerMessageIds = collaborationPublicMessageWindow(
    database,
    context.projectId,
    context.includedMessageSequence,
    context.threadId,
  )
    .filter(({ authorType }) => authorType === "owner")
    .map(({ id }) => id);
  if (ownerMessageIds.length === 0) return;
  const placeholders = ownerMessageIds.map(() => "?").join(", ");
  database
    .prepare(
      `UPDATE collaboration_messages
       SET consumed_at = ?
       WHERE consumed_at IS NULL AND id IN (${placeholders})`,
    )
    .run(timestamp, ...ownerMessageIds);
}

function appendEvent(
  database: DatabaseSync,
  context: Pick<CommitContext, "projectId" | "threadId">,
  runId: string,
  type: TimelineEventType,
  actorType: "agent" | "system",
  actorId: string | null,
  payload: Record<string, unknown>,
  timestamp: string,
): void {
  const sequence = (
    database
      .prepare(
        `SELECT next_event_sequence AS sequence
         FROM collaboration_runs
         WHERE project_id=? AND thread_id=? AND id=?`,
      )
      .get(context.projectId, context.threadId, runId) as { sequence: number }
  ).sequence;
  const eventId = randomUUID();
  database
    .prepare(
      `INSERT INTO collaboration_events (
         id,project_id,thread_id,run_id,sequence,type,actor_type,actor_id,
         payload_json,created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      eventId,
      context.projectId,
      context.threadId,
      runId,
      sequence,
      type,
      actorType,
      actorId,
      JSON.stringify(payload),
      timestamp,
    );
  const updated = database
    .prepare(
      `UPDATE collaboration_runs
       SET next_event_sequence = next_event_sequence + 1, updated_at = ?
       WHERE project_id=? AND thread_id=? AND id=? AND next_event_sequence=?`,
    )
    .run(timestamp, context.projectId, context.threadId, runId, sequence);
  if (updated.changes !== 1) throw actionConflict();
  appendRunEventFactTx(database, {
    actorId,
    actorType,
    eventId,
    eventType: type,
    factId: randomUUID(),
    projectId: context.projectId,
    runId,
    threadId: context.threadId,
    timestamp,
  });
}

function validateHandoff(
  database: DatabaseSync,
  context: CommitContext,
  input: CommitAgentTaskActionsInput,
  targetAgentId: string,
  overriddenByMention: boolean,
): void {
  if (input.turn.disposition.type !== "handoff") return;
  const { reason, summary } = input.turn.disposition;
  if (
    (!overriddenByMention && targetAgentId === input.agentId) ||
    graphemeLength(summary.trim()) < 1 ||
    graphemeLength(summary.trim()) > 5_000 ||
    graphemeLength(reason.trim()) < 1 ||
    graphemeLength(reason.trim()) > 5_000
  ) {
    throw actionInvalid({ disposition: "invalid_handoff" });
  }
  const target = database
    .prepare(
      `SELECT 1 FROM project_memberships
       WHERE project_id = ? AND agent_id = ?`,
    )
    .get(context.projectId, targetAgentId);
  if (!target) throw actionInvalid({ targetAgentId: "not_current_member" });

  const limits = database
    .prepare(
      `SELECT agents.max_handoffs AS maximum,
              (SELECT COUNT(*) FROM collaboration_turns
               WHERE run_id = ? AND agent_id = ? AND disposition = 'handoff') AS current
       FROM agents WHERE agents.id = ?`,
    )
    .get(input.runId, input.agentId, input.agentId) as
    | { current: number; maximum: number }
    | undefined;
  if (!limits) throw actionConflict();
  if (limits.current >= limits.maximum) throw boundaryReached();
}

function validatePlanReady(
  database: DatabaseSync,
  context: CommitContext,
  input: CommitAgentTaskActionsInput,
): void {
  if (input.turn.disposition.type !== "plan_ready") return;
  const existingAgents = database
    .prepare(
      `SELECT DISTINCT agent_id AS agentId
       FROM collaboration_turns WHERE run_id = ?`,
    )
    .all(input.runId) as Array<{ agentId: string }>;
  const participants = new Set(existingAgents.map(({ agentId }) => agentId));
  participants.add(input.agentId);
  const taskCount = (
    database
      .prepare("SELECT COUNT(*) AS count FROM work_items WHERE mission_id = ?")
      .get(context.missionId) as { count: number }
  ).count;
  const claimedCount = (
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM work_items
         WHERE mission_id = ?
           AND (assignee_agent_id IS NOT NULL OR status = 'in_progress')`,
      )
      .get(context.missionId) as { count: number }
  ).count;
  const missing: PlanReadyMissing[] = [];
  if (participants.size < 2) missing.push("participants");
  if (taskCount + input.turn.tasks.length < 1) missing.push("tasks");
  if (claimedCount < 1 && input.turn.claim === null) missing.push("claim");
  if (missing.length > 0) throw actionInvalid(undefined, missing);
}

function validateDecision(input: CommitAgentTaskActionsInput): void {
  if (input.turn.disposition.type !== "decision_request") return;
  const { options, question } = input.turn.disposition;
  const normalizedOptions = options.map((option) => option.trim());
  if (
    input.turn.tasks.length !== 0 ||
    input.turn.claim !== null ||
    graphemeLength(question.trim()) < 1 ||
    graphemeLength(question.trim()) > 1_000 ||
    options.length < 2 ||
    options.length > 8 ||
    normalizedOptions.some(
      (option) => graphemeLength(option) < 1 || graphemeLength(option) > 500,
    ) ||
    new Set(normalizedOptions).size !== normalizedOptions.length
  ) {
    throw actionInvalid({ disposition: "invalid_decision_request" });
  }
}

function existingClaimVersion(
  database: DatabaseSync,
  projectId: string,
  workItemId: string,
): number {
  const row = database
    .prepare(
      `SELECT items.version
       FROM work_items AS items
       JOIN missions ON missions.id = items.mission_id
       WHERE items.id = ? AND missions.project_id = ?`,
    )
    .get(workItemId, projectId) as { version: number } | undefined;
  if (!row) throw actionConflict();
  return row.version;
}

export function commitAgentTaskActionsTx(
  database: DatabaseSync,
  input: CommitAgentTaskActionsInput,
): CommitAgentTaskActionsResult {
  const context = commitContext(database, input.runId, input.agentId, input.attemptId);
  const ownerRace = reconcilePendingOwnerMessages(database, context);
  const handoffTargetAgentId =
    input.turn.disposition.type === "handoff"
      ? ownerRace.latestMentionAgentId ?? input.turn.disposition.targetAgentId
      : null;
  validateHandoff(
    database,
    context,
    input,
    handoffTargetAgentId ?? input.agentId,
    ownerRace.latestMentionAgentId !== null,
  );
  validatePlanReady(database, context, input);
  validateDecision(input);
  const claim = input.turn.claim;
  if (
    claim?.source === "proposed" &&
    !input.turn.tasks.some(({ clientKey }) => clientKey === claim.clientKey)
  ) {
    throw actionInvalid({ claim: "unresolved_client_key" });
  }

  const existingVersion =
    input.turn.claim?.source === "existing"
      ? existingClaimVersion(
          database,
          context.projectId,
          input.turn.claim.workItemId,
        )
      : null;
  const structuredBlocks = ingestStructuredBlocks(JSON.stringify({
    blocks: input.turn.blocks ?? [],
  }));
  const persistedBlocks = materializeStructuredBlocks(database, {
    projectId: context.projectId,
    runId: input.runId,
    threadId: context.threadId,
  }, {
    displayName: context.agentDisplayName,
    id: input.agentId,
    type: "agent",
  }, structuredBlocks);

  try {
    const taskIdsByClientKey = createWorkItemBatchTx(
      database,
      context.projectId,
      context.missionId,
      input.turn.tasks,
      { type: "agent", agentId: input.agentId },
    );
    const messageId = randomUUID();
    const turnId = randomUUID();
    const messageSequence = commitStructuredMessageTx(database, {
      actor: {
        displayName: context.agentDisplayName,
        id: input.agentId,
        type: "agent",
      },
      blocks: persistedBlocks,
      content: input.turn.message,
      factId: randomUUID(),
      messageId,
      projectId: context.projectId,
      runId: input.runId,
      threadId: context.threadId,
      timestamp: input.timestamp,
    });

    let claimedWorkItemId: string | null = null;
    if (input.turn.claim) {
      claimedWorkItemId =
        input.turn.claim.source === "existing"
          ? input.turn.claim.workItemId
          : taskIdsByClientKey[input.turn.claim.clientKey];
      claimWorkItemTx(
        database,
        context.projectId,
        claimedWorkItemId,
        input.agentId,
        input.turn.claim.source === "existing" ? existingVersion! : 1,
      );
    }
    database
      .prepare(
        `INSERT INTO collaboration_turns (
           id,project_id,thread_id,attempt_id,run_id,agent_id,round_number,
           message_id, disposition, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        turnId,
        context.projectId,
        context.threadId,
        input.attemptId,
        input.runId,
        input.agentId,
        context.roundCount + 1,
        messageId,
        input.turn.disposition.type,
        input.timestamp,
      );
    appendEvent(
      database,
      context,
      input.runId,
      "agent_message",
      "agent",
      input.agentId,
      {
        agentDisplayName: context.agentDisplayName,
        agentId: input.agentId,
        messageId,
        messageSequence,
        turnId,
      },
      input.timestamp,
    );
    if (input.turn.tasks.length > 0) {
      appendEvent(
        database,
        context,
        input.runId,
        "tasks_created",
        "agent",
        input.agentId,
        {
          items: input.turn.tasks.map((task) => ({
            dependsOnIds: task.dependsOnKeys.map((key) => taskIdsByClientKey[key]),
            id: taskIdsByClientKey[task.clientKey],
            title: task.title,
          })),
          turnId,
        },
        input.timestamp,
      );
    }
    if (claimedWorkItemId) {
      appendEvent(
        database,
        context,
        input.runId,
        "task_claimed",
        "agent",
        input.agentId,
        { agentId: input.agentId, turnId, workItemId: claimedWorkItemId },
        input.timestamp,
      );
    }
    if (input.turn.disposition.type === "handoff") {
      const disposition = input.turn.disposition;
      appendEvent(
        database,
        context,
        input.runId,
        "handoff",
        "agent",
        input.agentId,
        {
          fromAgentId: input.agentId,
          overriddenByMention: ownerRace.latestMentionAgentId !== null,
          reason: disposition.reason,
          summary: disposition.summary,
          toAgentId: handoffTargetAgentId,
          turnId,
        },
        input.timestamp,
      );
      const updated = database
        .prepare(
          `UPDATE collaboration_runs
           SET current_agent_id = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND status = 'running' AND current_agent_id = ?`,
        )
        .run(handoffTargetAgentId, input.timestamp, input.runId, input.agentId);
      if (updated.changes !== 1) throw actionConflict();
    } else if (input.turn.disposition.type === "decision_request") {
      const disposition = input.turn.disposition;
      const decisionId = randomUUID();
      database
        .prepare(
          `INSERT INTO decision_requests (
             id,project_id,thread_id,run_id,turn_id,requesting_agent_id,
             question,options_json,
             status, answer, answer_message_id, version, created_at, answered_at
           ) VALUES (?,?,?,?,?,?,?,?,'open',NULL,NULL,1,?,NULL)`,
        )
        .run(
          decisionId,
          context.projectId,
          context.threadId,
          input.runId,
          turnId,
          input.agentId,
          disposition.question,
          JSON.stringify(disposition.options),
          input.timestamp,
        );
      appendEvent(
        database,
        context,
        input.runId,
        "decision_requested",
        "agent",
        input.agentId,
        {
          agentId: input.agentId,
          decisionId,
          options: disposition.options,
          question: disposition.question,
          turnId,
        },
        input.timestamp,
      );
      const updated = database
        .prepare(
          `UPDATE collaboration_runs
           SET status = 'waiting_owner', version = version + 1, updated_at = ?
           WHERE id = ? AND status = 'running' AND current_agent_id = ?`,
        )
        .run(input.timestamp, input.runId, input.agentId);
      if (updated.changes !== 1) throw actionConflict();
      consumeIncludedOwnerMessages(database, context, input.timestamp);
    } else if (input.turn.disposition.type === "plan_ready") {
      if (!ownerRace.hasPendingMessages) {
        appendEvent(
          database,
          context,
          input.runId,
          "run_planned",
          "agent",
          input.agentId,
          { turnId },
          input.timestamp,
        );
      }
      const nextAgentId = ownerRace.latestMentionAgentId ?? input.agentId;
      const updated = database
        .prepare(
          ownerRace.hasPendingMessages
            ? `UPDATE collaboration_runs
               SET current_agent_id = ?, version = version + 1, updated_at = ?
               WHERE id = ? AND status = 'running' AND current_agent_id = ?`
            : `UPDATE collaboration_runs
               SET status = 'planned', version = version + 1, updated_at = ?
               WHERE id = ? AND status = 'running' AND current_agent_id = ?`,
        )
        .run(
          ...(ownerRace.hasPendingMessages
            ? [nextAgentId, input.timestamp, input.runId, input.agentId]
            : [input.timestamp, input.runId, input.agentId]),
        );
      if (updated.changes !== 1) throw actionConflict();
    }
    if (input.turn.disposition.type !== "decision_request") {
      consumeIncludedOwnerMessages(database, context, input.timestamp);
    }
    return {
      claimedWorkItemId,
      messageId,
      messageSequence,
      taskIdsByClientKey,
      turnId,
    };
  } catch (error) {
    if (error instanceof MissionError) throw mapMissionError(error);
    throw error;
  }
}
