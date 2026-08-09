import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as collectionRoute from "@/app/api/skills/route";

type ItemRoute = {
  PATCH: (
    request: Request,
    context: { params: Promise<{ skillId: string }> },
  ) => Promise<Response>;
};

const itemRoutes = import.meta.glob<ItemRoute>("../../../app/api/skills/[skillId]/route.ts");
let directory: string;

async function loadItemRoute(): Promise<ItemRoute> {
  const load = itemRoutes["../../../app/api/skills/[skillId]/route.ts"];
  expect(load, "the versioned skill PATCH route must exist").toBeTypeOf("function");
  return load();
}

function request(url: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-skills-api-"));
  process.env.COCKPIT_DB_PATH = join(directory, "cockpit.sqlite");
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  rmSync(directory, { force: true, recursive: true });
});

describe("skill API", () => {
  it("creates, lists and fully replaces a skill through stable contracts", async () => {
    const itemRoute = await loadItemRoute();
    const createdResponse = await collectionRoute.POST(
      request("http://localhost/api/skills", {
        description: "  Notes  ",
        instructions: "<strong>literal</strong>",
        name: "  Planning  ",
      }),
    );
    expect(createdResponse.status).toBe(201);
    const { skill: created } = await createdResponse.json();
    expect(created).toMatchObject({ description: "Notes", name: "Planning", version: 1 });

    const patched = await itemRoute.PATCH(
      request(
        `http://localhost/api/skills/${created.id}`,
        {
          description: "New notes",
          expectedVersion: 1,
          instructions: "<em>still literal</em>",
          name: "Reviewer",
        },
        "PATCH",
      ),
      { params: Promise.resolve({ skillId: created.id }) },
    );
    expect(patched.status).toBe(200);
    const { skill: updated } = await patched.json();
    expect(updated).toMatchObject({
      instructions: "<em>still literal</em>",
      name: "Reviewer",
      version: 2,
    });
    await expect((await collectionRoute.GET()).json()).resolves.toEqual({
      skills: [updated],
    });
  });

  it("returns field errors, full-replace errors, not-found and version conflicts", async () => {
    const itemRoute = await loadItemRoute();
    const invalid = await collectionRoute.POST(
      request("http://localhost/api/skills", {
        description: "d".repeat(281),
        instructions: "",
        name: "n".repeat(81),
      }),
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: {
        code: "INVALID_INPUT",
        fields: expect.arrayContaining([
          { code: "too_long", field: "name" },
          { code: "too_long", field: "description" },
          { code: "required", field: "instructions" },
        ]),
      },
    });

    const created = await (
      await collectionRoute.POST(
        request("http://localhost/api/skills", {
          description: "",
          instructions: "Do it",
          name: "Builder",
        }),
      )
    ).json();
    const missingField = await itemRoute.PATCH(
      request(
        `http://localhost/api/skills/${created.skill.id}`,
        { description: "", expectedVersion: 1, name: "Builder" },
        "PATCH",
      ),
      { params: Promise.resolve({ skillId: created.skill.id }) },
    );
    expect(missingField.status).toBe(400);
    await expect(missingField.json()).resolves.toMatchObject({
      error: { code: "INVALID_INPUT" },
    });

    const update = {
      description: "",
      expectedVersion: 1,
      instructions: "Updated",
      name: "Builder",
    };
    expect(
      (
        await itemRoute.PATCH(
          request(`http://localhost/api/skills/${created.skill.id}`, update, "PATCH"),
          { params: Promise.resolve({ skillId: created.skill.id }) },
        )
      ).status,
    ).toBe(200);
    const stale = await itemRoute.PATCH(
      request(`http://localhost/api/skills/${created.skill.id}`, update, "PATCH"),
      { params: Promise.resolve({ skillId: created.skill.id }) },
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "RESOURCE_CONFLICT" },
    });

    const missing = await itemRoute.PATCH(
      request("http://localhost/api/skills/missing", update, "PATCH"),
      { params: Promise.resolve({ skillId: "missing" }) },
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "SKILL_NOT_FOUND" },
    });
  });
});
