import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createSkill, getSkills, getSkill } from "../src/server/skillService";

let db: PrismaClient;

beforeAll(() => {
  execSync("node node_modules/prisma/build/index.js db push --skip-generate", {
    env: { ...process.env, DATABASE_URL: "file:./test-skills.db" },
    stdio: "pipe",
  });
  db = new PrismaClient({
    datasources: { db: { url: "file:./test-skills.db" } },
  });
});

beforeEach(async () => {
  await db.agent.deleteMany();
  await db.skill.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("skillService.createSkill", () => {
  it("creates a skill and returns DTO", async () => {
    const skill = await createSkill(
      { name: "需求整理", description: "d", content: "c", category: "product" },
      db
    );
    expect(skill.id).toBeGreaterThan(0);
    expect(skill.name).toBe("需求整理");
    expect(skill.content).toBe("c");
  });

  it("throws on empty/whitespace name", async () => {
    await expect(createSkill({ name: "" }, db)).rejects.toThrow();
    await expect(createSkill({ name: "   " }, db)).rejects.toThrow();
  });

  it("trims name", async () => {
    const skill = await createSkill({ name: "  TDD  " }, db);
    expect(skill.name).toBe("TDD");
  });
});

describe("skillService.getSkills", () => {
  it("returns index without content, with agentCount", async () => {
    const s = await createSkill({ name: "需求整理", description: "d" }, db);
    await db.agent.create({
      data: { name: "A", skills: JSON.stringify([s.id]) },
    });

    const list = await getSkills(db);

    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("content");
    expect(list[0].agentCount).toBe(1);
  });

  it("returns empty array when no skills", async () => {
    expect(await getSkills(db)).toEqual([]);
  });
});

describe("skillService.getSkill", () => {
  it("returns full skill with content", async () => {
    const s = await createSkill({ name: "TDD", content: "## Procedure" }, db);
    const got = await getSkill(s.id, db);
    expect(got.content).toBe("## Procedure");
  });

  it("throws when not found", async () => {
    await expect(getSkill(9999, db)).rejects.toThrow();
  });
});
