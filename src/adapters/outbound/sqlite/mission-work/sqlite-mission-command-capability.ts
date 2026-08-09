import type { TransactionContext } from "@/src/application/transaction-context";
import { canonicalRequestHash } from "@/src/server/collaboration/operation-receipts";
import {
  MissionError,
  type CreateMissionCommand,
  type MissionCommandCapability,
  type MissionCreated,
} from "@/src/modules/mission-work";
import { sqliteDatabaseForTransaction } from "@/src/adapters/outbound/sqlite/sqlite-unit-of-work";

export class SqliteMissionCommandCapability implements MissionCommandCapability {
  createMission(
    transaction: TransactionContext,
    command: CreateMissionCommand,
  ): MissionCreated {
    const database = sqliteDatabaseForTransaction(transaction);
    if (!database.prepare("SELECT 1 FROM projects WHERE id = ?").get(command.projectId)) {
      throw new MissionError("PROJECT_NOT_FOUND", 404, "Project was not found.");
    }
    const expectedHash = canonicalRequestHash({
      expectedVersion: command.expectedVersion,
      goal: command.goal,
      operationId: command.operationId,
      projectId: command.projectId,
      title: command.title,
    });
    if (command.requestHash !== expectedHash) {
      throw new MissionError("OPERATION_CONFLICT", 409, "Operation input changed.");
    }
    if (command.expectedVersion !== 0) {
      throw new MissionError("VERSION_CONFLICT", 409, "Mission changed concurrently.", undefined, 0);
    }
    const existing = database.prepare(
      `SELECT id,project_id AS projectId,title,goal,version,
              created_at AS createdAt,updated_at AS updatedAt
       FROM missions WHERE project_id = ?`,
    ).get(command.projectId) as MissionCreated["mission"] | undefined;
    if (existing) {
      const replayHash = canonicalRequestHash({
        expectedVersion: 0,
        goal: existing.goal,
        operationId: existing.id,
        projectId: existing.projectId,
        title: existing.title,
      });
      if (existing.id === command.operationId && replayHash === command.requestHash) {
        return {
          mission: existing,
          missionId: existing.id,
          occurredAt: existing.createdAt,
          projectId: existing.projectId,
        };
      }
      throw new MissionError(
        existing.id === command.operationId ? "OPERATION_CONFLICT" : "MISSION_EXISTS",
        409,
        existing.id === command.operationId
          ? "Operation input changed."
          : "Project already has a mission.",
      );
    }

    const missionId = command.operationId;
    const occurredAt = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO missions (
           id, project_id, title, goal, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        missionId,
        command.projectId,
        command.title,
        command.goal,
        occurredAt,
        occurredAt,
      );

    return {
      mission: {
        createdAt: occurredAt,
        goal: command.goal,
        id: missionId,
        projectId: command.projectId,
        title: command.title,
        updatedAt: occurredAt,
        version: 1,
      },
      missionId,
      occurredAt,
      projectId: command.projectId,
    };
  }
}
