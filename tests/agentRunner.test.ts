import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { runAgent, UpstreamError, NotFoundError } from "../src/server/agentRunner";
import { ValidationError } from "../src/server/agentService";

let db: PrismaClient;

beforeAll(() => {
  execSync("node node_modules/prisma/build/index.js db push --skip-generate", {
    env: { ...process.env, DATABASE_URL: "file:./test-runner.db" },
    stdio: "pipe",
  });
  db = new PrismaClient({
    datasources: { db: { url: "file:./test-runner.db" } },
  });
});

beforeEach(async () => {
  await db.agent.deleteMany();
  await db.skill.deleteMany();
  await db.providerConfig.deleteMany();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("agentRunner.runAgent", () => {
  it("calls upstream, returns output + trace; injects skill content into system", async () => {
    const skill = await db.skill.create({
      data: { name: "需求整理", content: "## 步骤\n1. 澄清目标" },
    });
    const provider = await db.providerConfig.create({
      data: { name: "P", baseUrl: "https://x/v4", apiKey: "secret" },
    });
    const agent = await db.agent.create({
      data: {
        name: "A",
        systemPrompt: "你是助手",
        skills: JSON.stringify([skill.id]),
        providerConfigId: provider.id,
        model: "glm-4-plus",
      },
    });

    let capturedBody: { model?: string; messages?: { content?: string }[] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse((init?.body as string) ?? "{}");
        return {
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: "回答内容" } }] }),
        };
      })
    );

    const result = await runAgent(agent.id, "你好", db);

    expect(result.output).toBe("回答内容");
    expect(result.trace).toHaveLength(3);
    expect(result.trace[0].role).toBe("system");
    expect(result.trace[0].content).toContain("## 步骤");
    expect(result.trace[1].role).toBe("user");
    expect(result.trace[2].role).toBe("assistant");
    expect(capturedBody!.model).toBe("glm-4-plus");
  });

  it("throws ValidationError when agent has no providerConfig", async () => {
    const agent = await db.agent.create({
      data: { name: "A", providerConfigId: null },
    });
    await expect(runAgent(agent.id, "x", db)).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError when providerConfig record missing", async () => {
    const agent = await db.agent.create({
      data: { name: "A", providerConfigId: 9999, model: "m" },
    });
    await expect(runAgent(agent.id, "x", db)).rejects.toThrow(ValidationError);
  });

  it("throws NotFoundError when agent missing", async () => {
    await expect(runAgent(9999, "x", db)).rejects.toThrow(NotFoundError);
  });

  it("throws UpstreamError when upstream fails", async () => {
    const provider = await db.providerConfig.create({
      data: { name: "P", baseUrl: "https://x/v4", apiKey: "k" },
    });
    const agent = await db.agent.create({
      data: { name: "A", providerConfigId: provider.id, model: "m" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(runAgent(agent.id, "x", db)).rejects.toThrow(UpstreamError);
  });

  it("throws UpstreamError when fetch rejects (network failure)", async () => {
    const provider = await db.providerConfig.create({
      data: { name: "P", baseUrl: "https://unreachable/v4", apiKey: "k" },
    });
    const agent = await db.agent.create({
      data: { name: "A", providerConfigId: provider.id, model: "m" },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(runAgent(agent.id, "x", db)).rejects.toThrow(UpstreamError);
  });
});
