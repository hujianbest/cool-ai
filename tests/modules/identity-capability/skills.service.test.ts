import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as skillServiceModule from "@/src/adapters/outbound/sqlite/identity-capability/skill-service";

type SkillInput = {
  description: string;
  instructions: string;
  name: string;
};

type SkillService = typeof skillServiceModule & {
  updateSkill: (
    skillId: string,
    input: SkillInput & { expectedVersion: number },
    databasePath: string,
  ) => ReturnType<typeof skillServiceModule.createSkill>;
};

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-skills-service-"));
  temporaryDirectories.push(directory);
  return join(directory, "cockpit.sqlite");
}

function service(): SkillService {
  const candidate = skillServiceModule as SkillService;
  expect(candidate.updateSkill, "skill service must support versioned updates").toBeTypeOf(
    "function",
  );
  return candidate;
}

function validInput(overrides: Partial<SkillInput> = {}): SkillInput {
  return {
    description: "Useful notes",
    instructions: "Follow the checklist.",
    name: "Planning",
    ...overrides,
  };
}

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("skill service", () => {
  it("trims valid fields and preserves instruction text literally", () => {
    const path = databasePath();
    const created = service().createSkill(
      {
        description: "  Notes  ",
        instructions: "  <script>not executed</script>\nDo the work.  ",
        name: "  Planning  ",
      },
      path,
    );

    expect(created).toMatchObject({
      description: "Notes",
      instructions: "<script>not executed</script>\nDo the work.",
      name: "Planning",
      version: 1,
    });
    expect(service().listSkills(path)).toEqual([created]);
  });

  it.each([
    [{ ...validInput(), name: "" }, "name", "required"],
    [{ ...validInput(), instructions: "   " }, "instructions", "required"],
    [{ ...validInput(), name: "n".repeat(81) }, "name", "too_long"],
    [{ ...validInput(), description: "d".repeat(281) }, "description", "too_long"],
    [{ ...validInput(), instructions: "i".repeat(20_001) }, "instructions", "too_long"],
  ])("rejects invalid field bounds without persisting", (input, field, fieldCode) => {
    const path = databasePath();

    expect(() => service().createSkill(input, path)).toThrowError(
      expect.objectContaining({
        code: "INVALID_INPUT",
        fields: expect.arrayContaining([{ code: fieldCode, field }]),
      }),
    );
    expect(service().listSkills(path)).toEqual([]);
  });

  it("fully replaces a skill, increments version and rejects stale or missing updates", () => {
    const path = databasePath();
    const created = service().createSkill(validInput(), path);
    const updated = service().updateSkill(
      created.id,
      {
        description: "Updated",
        expectedVersion: 1,
        instructions: "<b>still text</b>",
        name: "Reviewer",
      },
      path,
    );

    expect(updated).toMatchObject({
      description: "Updated",
      instructions: "<b>still text</b>",
      name: "Reviewer",
      version: 2,
    });
    expect(service().listSkills(path)).toEqual([updated]);
    expectCode(
      () =>
        service().updateSkill(
          created.id,
          { ...validInput(), expectedVersion: 1 },
          path,
        ),
      "RESOURCE_CONFLICT",
    );
    expectCode(
      () =>
        service().updateSkill(
          "missing",
          { ...validInput(), expectedVersion: 1 },
          path,
        ),
      "SKILL_NOT_FOUND",
    );
    expectCode(
      () =>
        service().updateSkill(
          created.id,
          { description: "Missing instructions", expectedVersion: 2 } as never,
          path,
        ),
      "INVALID_INPUT",
    );
  });

  it("lists deterministically by creation time and then id", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    const path = databasePath();
    const first = service().createSkill(validInput({ name: "First" }), path);
    const second = service().createSkill(validInput({ name: "Second" }), path);

    expect(service().listSkills(path)).toEqual(
      [first, second].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      ),
    );
  });
});
