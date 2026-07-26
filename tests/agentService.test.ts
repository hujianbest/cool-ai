import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getAgents, createAgent } from "../src/server/agentService";

let db: PrismaClient;

beforeAll(() => {
  execSync(
    "node node_modules/prisma/build/index.js db push --skip-generate",
    {
      env: { ...process.env, DATABASE_URL: "file:./test-agents.db" },
      stdio: "pipe",
    }
  );
  db = new PrismaClient({
    datasources: { db: { url: "file:./test-agents.db" } },
  });
});

beforeEach(async () => {
  await db.agent.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("agentService.getAgents", () => {
  it("returns agents persisted in db (with parsed tool/skill arrays)", async () => {
    await db.agent.create({
      data: {
        name: "骨架 Agent",
        systemPrompt: "占位",
        tools: JSON.stringify(["shell", "file.read"]),
      },
    });

    const agents = await getAgents(db);

    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("骨架 Agent");
    expect(agents[0].tools).toEqual(["shell", "file.read"]);
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

describe("agentService.createAgent", () => {
  it("creates an agent, stores skill ids, returns DTO with skill id array", async () => {
    const s = await db.skill.create({ data: { name: "需求整理" } });
    const agent = await createAgent(
      {
        name: "PM",
        systemPrompt: "产品经理",
        tools: ["shell", "file.read"],
        skills: [s.id],
      },
      db
    );

    expect(agent.id).toBeGreaterThan(0);
    expect(agent.name).toBe("PM");
    expect(agent.tools).toEqual(["shell", "file.read"]);
    expect(agent.skills).toEqual([s.id]);

    const row = await db.agent.findUnique({ where: { id: agent.id } });
    expect(row?.skills).toBe(JSON.stringify([s.id]));
  });

  it("throws when a referenced skill id does not exist", async () => {
    await expect(createAgent({ name: "PM", skills: [9999] }, db)).rejects.toThrow();
  });

  it("throws when providerConfigId does not exist", async () => {
    await expect(
      createAgent({ name: "PM", providerConfigId: 9999 }, db)
    ).rejects.toThrow();
  });

  it("accepts a valid providerConfigId + model", async () => {
    const p = await db.providerConfig.create({
      data: { name: "P", baseUrl: "https://x/v4" },
    });
    const agent = await createAgent(
      { name: "PM", providerConfigId: p.id, model: "glm-4-plus" },
      db
    );
    expect(agent.providerConfigId).toBe(p.id);
    expect(agent.model).toBe("glm-4-plus");
  });

  it("throws when name is missing/empty/whitespace", async () => {
    await expect(createAgent({ name: "" }, db)).rejects.toThrow();
    await expect(createAgent({ name: "   " }, db)).rejects.toThrow();
    await expect(
      createAgent({ name: undefined as unknown as string }, db)
    ).rejects.toThrow();
  });

  it("trims surrounding whitespace from name", async () => {
    const agent = await createAgent({ name: "  架构师  " }, db);
    expect(agent.name).toBe("架构师");
  });
});
