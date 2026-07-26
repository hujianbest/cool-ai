import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createProvider, getProviders } from "../src/server/providerService";

let db: PrismaClient;

beforeAll(() => {
  execSync("node node_modules/prisma/build/index.js db push --skip-generate", {
    env: { ...process.env, DATABASE_URL: "file:./test-providers.db" },
    stdio: "pipe",
  });
  db = new PrismaClient({
    datasources: { db: { url: "file:./test-providers.db" } },
  });
});

beforeEach(async () => {
  await db.agent.deleteMany();
  await db.providerConfig.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("providerService.createProvider", () => {
  it("creates and returns DTO WITHOUT apiKey (key stored in db)", async () => {
    const c = await createProvider(
      { name: "P", baseUrl: "https://x/v4", apiKey: "secret" },
      db
    );
    expect(c.id).toBeGreaterThan(0);
    expect(c.name).toBe("P");
    expect(c).not.toHaveProperty("apiKey");

    const row = await db.providerConfig.findUnique({ where: { id: c.id } });
    expect(row?.apiKey).toBe("secret");
  });

  it("throws on empty name or baseUrl", async () => {
    await expect(createProvider({ name: "", baseUrl: "x" }, db)).rejects.toThrow();
    await expect(createProvider({ name: "P", baseUrl: "" }, db)).rejects.toThrow();
  });

  it("trims name and baseUrl", async () => {
    const c = await createProvider({ name: "  P  ", baseUrl: "  https://x/v4  " }, db);
    expect(c.name).toBe("P");
    expect(c.baseUrl).toBe("https://x/v4");
  });
});

describe("providerService.getProviders", () => {
  it("returns index without apiKey, with agentCount", async () => {
    const c = await createProvider({ name: "P", baseUrl: "x" }, db);
    await db.agent.create({ data: { name: "A", providerConfigId: c.id } });

    const list = await getProviders(db);

    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("apiKey");
    expect(list[0].agentCount).toBe(1);
  });

  it("returns empty array when none", async () => {
    expect(await getProviders(db)).toEqual([]);
  });
});
