import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getAgents } from "../src/server/agentService";

let db: PrismaClient;

beforeAll(() => {
  execSync(
    "node node_modules/prisma/build/index.js db push --skip-generate",
    {
      env: { ...process.env, DATABASE_URL: "file:./test.db" },
      stdio: "pipe",
    }
  );
  db = new PrismaClient({
    datasources: { db: { url: "file:./test.db" } },
  });
});

beforeEach(async () => {
  await db.agent.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("agentService.getAgents", () => {
  it("returns agents persisted in db", async () => {
    await db.agent.create({ data: { name: "骨架 Agent", role: "占位角色" } });

    const agents = await getAgents(db);

    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("骨架 Agent");
  });

  it("returns empty array when no agents", async () => {
    const agents = await getAgents(db);

    expect(agents).toEqual([]);
  });

  it("throws when db read fails", async () => {
    const failing = {
      agent: {
        findMany: async () => {
          throw new Error("db down");
        },
      },
    } as unknown as PrismaClient;

    await expect(getAgents(failing)).rejects.toThrow("db down");
  });
});
