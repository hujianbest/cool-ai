import { describe, expect, it } from "vitest";

import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type DeliveryReplayDto = {
  formatVersion: 1;
  items: unknown[];
  replayHash: string;
  scope: { detail: string; projectId: string; runId: string };
};

type ReplayModule = {
  getDeliveryReplay(
    databasePath: string,
    projectId: string,
    options: { runId: string },
  ): DeliveryReplayDto;
};

const replayModules = import.meta.glob<ReplayModule>(
  "../../../src/adapters/outbound/sqlite/operations-projection/delivery-replay.ts",
);

async function replayService(): Promise<ReplayModule> {
  const load = replayModules[
    "../../../src/adapters/outbound/sqlite/operations-projection/delivery-replay.ts"
  ];
  expect(load, "the delivery replay query must exist").toBeTypeOf("function");
  return load();
}

describe("delivery replay", () => {
  it("returns a stable hashed replay that does not invent items for an unknown run", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Replay A", databasePath);
    const service = await replayService();
    const first = service.getDeliveryReplay(databasePath, project.id, { runId: "run-missing" });
    expect(first).toMatchObject({
      formatVersion: 1,
      items: [],
      scope: { detail: "只读回放", projectId: project.id, runId: "run-missing" },
    });
    expect(first.replayHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(service.getDeliveryReplay(databasePath, project.id, { runId: "run-missing" }).replayHash)
      .toBe(first.replayHash);
    expect(() => service.getDeliveryReplay(databasePath, "missing-project", { runId: "run-missing" }))
      .toThrowError(/Project was not found/u);
  });
});
