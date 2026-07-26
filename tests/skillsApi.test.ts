import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/server/skillService", () => ({
  getSkills: vi.fn(),
  createSkill: vi.fn(),
  getSkill: vi.fn(),
  ValidationError: class ValidationError extends Error {},
}));

import { GET as listGET, POST } from "../app/api/skills/route";
import { GET as idGET } from "../app/api/skills/[id]/route";
import {
  getSkills,
  createSkill,
  getSkill,
  ValidationError,
} from "../src/server/skillService";

const mockedGetSkills = vi.mocked(getSkills);
const mockedCreateSkill = vi.mocked(createSkill);
const mockedGetSkill = vi.mocked(getSkill);

describe("GET /api/skills (index)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 200 with skill index (no content, with agentCount)", async () => {
    mockedGetSkills.mockResolvedValue([
      { id: 1, name: "需求整理", description: "d", category: "product", agentCount: 0 },
    ]);

    const res = await listGET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skills[0].name).toBe("需求整理");
    expect(body.skills[0]).not.toHaveProperty("content");
    expect(body.skills[0].agentCount).toBe(0);
  });
});

describe("POST /api/skills", () => {
  beforeEach(() => vi.resetAllMocks());

  it("creates and returns 201", async () => {
    mockedCreateSkill.mockResolvedValue({
      id: 1, name: "TDD", description: "", content: "", category: "", createdAt: new Date(),
    });

    const req = new Request("http://localhost/api/skills", {
      method: "POST",
      body: JSON.stringify({ name: "TDD" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(201);
    expect((await res.json()).skill.name).toBe("TDD");
  });

  it("returns 400 when name empty", async () => {
    mockedCreateSkill.mockRejectedValue(new ValidationError("name 必填"));

    const req = new Request("http://localhost/api/skills", {
      method: "POST",
      body: JSON.stringify({ name: "" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });
});

describe("GET /api/skills/:id", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 200 with full skill", async () => {
    mockedGetSkill.mockResolvedValue({
      id: 1, name: "TDD", description: "", content: "## Procedure", category: "", createdAt: new Date(),
    });

    const res = await idGET(new Request("http://localhost/api/skills/1"), {
      params: Promise.resolve({ id: "1" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).skill.content).toBe("## Procedure");
  });

  it("returns 404 when not found", async () => {
    mockedGetSkill.mockRejectedValue(new Error("skill not found"));

    const res = await idGET(new Request("http://localhost/api/skills/9999"), {
      params: Promise.resolve({ id: "9999" }),
    });

    expect(res.status).toBe(404);
  });
});
