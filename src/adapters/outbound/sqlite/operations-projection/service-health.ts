import { CURRENT_SCHEMA } from "@/src/adapters/outbound/sqlite/current-schema";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  OperationsProjectionError,
  type ServiceHealthDto,
  type ServiceHealthStatus,
} from "@/src/modules/operations-projection";
import { getProjectMemoryIndexHealth } from "./memory-index-health";

const NEEDS_PROJECT = "需要打开项目";
const NO_PROVIDERS = "未配置模型服务";

function indexStatus(status: "behind" | "caught_up" | "failed" | "rebuilding"): ServiceHealthStatus {
  if (status === "caught_up") return "ok";
  if (status === "failed") return "failed";
  return "degraded";
}

export function getServiceHealth(
  databasePath: string,
  projectId?: string,
): ServiceHealthDto {
  const database = openDatabase(databasePath);
  let schemaIdentity: number;
  let verified = 0;
  let total = 0;
  try {
    schemaIdentity = (
      database.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    const providerCounts = database.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN verified_at IS NOT NULL AND trim(verified_at) != '' THEN 1 ELSE 0 END) AS verified
      FROM providers
    `).get() as { total: number; verified: number | null };
    total = providerCounts.total;
    verified = providerCounts.verified ?? 0;
    if (projectId !== undefined) {
      const project = database.prepare("SELECT 1 AS found FROM projects WHERE id=?").get(projectId);
      if (project === undefined) {
        throw new OperationsProjectionError("PROJECT_NOT_FOUND", "Project was not found.");
      }
    }
  } finally {
    database.close();
  }

  const appOk = schemaIdentity === CURRENT_SCHEMA.identity.userVersion;
  const providersOk = total > 0 && verified === total;
  let memoryIndex: ServiceHealthDto["memoryIndex"] = {
    detail: NEEDS_PROJECT,
    projectId: null,
    status: "unknown",
  };
  let execution: ServiceHealthDto["execution"] = {
    active: 0,
    detail: NEEDS_PROJECT,
    failed: 0,
    projectId: null,
    status: "unknown",
  };

  if (projectId !== undefined) {
    const index = getProjectMemoryIndexHealth(databasePath, projectId);
    memoryIndex = {
      detail: null,
      projectId,
      status: indexStatus(index.status),
    };
    const countsDb = openDatabase(databasePath);
    try {
      const counts = countsDb.prepare(`
        SELECT
          SUM(CASE WHEN status IN ('queued','running','waiting_approval','paused','staged') THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
        FROM executions
        WHERE project_id=?
      `).get(projectId) as { active: number | null; failed: number | null };
      const active = counts.active ?? 0;
      const failed = counts.failed ?? 0;
      execution = {
        active,
        detail: null,
        failed,
        projectId,
        status: failed > 0 ? "degraded" : "ok",
      };
    } finally {
      countsDb.close();
    }
  }

  return {
    app: {
      detail: appOk ? null : "应用架构身份不匹配",
      schemaIdentity,
      status: appOk ? "ok" : "failed",
    },
    execution,
    memoryIndex,
    providers: {
      detail: providersOk ? null : NO_PROVIDERS,
      status: providersOk ? "ok" : "degraded",
      total,
      verified,
    },
  };
}
