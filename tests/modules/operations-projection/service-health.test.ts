import { describe, expect, it } from "vitest";

import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { CURRENT_SCHEMA } from "@/src/adapters/outbound/sqlite/current-schema";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type HealthStatus = "degraded" | "failed" | "ok" | "unknown";

type ServiceHealthDto = {
  app: { detail: string | null; schemaIdentity: number; status: HealthStatus };
  execution: {
    active: number;
    detail: string | null;
    failed: number;
    projectId: string | null;
    status: HealthStatus;
  };
  memoryIndex: { detail: string | null; projectId: string | null; status: HealthStatus };
  providers: {
    detail: string | null;
    status: HealthStatus;
    total: number;
    verified: number;
  };
};

type HealthModule = {
  getServiceHealth(databasePath: string, projectId?: string): ServiceHealthDto;
};

const healthModules = import.meta.glob<HealthModule>(
  "../../../src/adapters/outbound/sqlite/operations-projection/service-health.ts",
);

async function healthService(): Promise<HealthModule> {
  const load = healthModules[
    "../../../src/adapters/outbound/sqlite/operations-projection/service-health.ts"
  ];
  expect(load, "the service health query must exist").toBeTypeOf("function");
  return load();
}

describe("service health", () => {
  it("aggregates app and provider signals and keeps project cards unknown without a project", async () => {
    const databasePath = memoryDatabasePath();
    const service = await healthService();
    const health = service.getServiceHealth(databasePath);

    expect(health).toEqual({
      app: {
        detail: null,
        schemaIdentity: CURRENT_SCHEMA.identity.userVersion,
        status: "ok",
      },
      execution: {
        active: 0,
        detail: "需要打开项目",
        failed: 0,
        projectId: null,
        status: "unknown",
      },
      memoryIndex: {
        detail: "需要打开项目",
        projectId: null,
        status: "unknown",
      },
      providers: {
        detail: "未配置模型服务",
        status: "degraded",
        total: 0,
        verified: 0,
      },
    });
  });

  it("scopes index and execution cards to a real project and rejects unknown projects", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Health project", databasePath);
    const service = await healthService();
    const health = service.getServiceHealth(databasePath, project.id);

    expect(health.memoryIndex).toEqual({
      detail: null,
      projectId: project.id,
      status: "ok",
    });
    expect(health.execution).toEqual({
      active: 0,
      detail: null,
      failed: 0,
      projectId: project.id,
      status: "ok",
    });
    expect(() => service.getServiceHealth(databasePath, "missing-project")).toThrowError(
      /Project was not found/u,
    );
  });
});
