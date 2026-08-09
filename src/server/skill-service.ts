import { randomUUID } from "node:crypto";
import type { ZodIssue } from "zod";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import type { Skill, SkillInput, UpdateSkillInput } from "@/src/shared/team-contracts";
import {
  skillInputSchema,
  updateSkillInputSchema,
} from "@/src/shared/team-schemas";

type SkillRow = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

function toSkill(row: SkillRow): Skill {
  return { ...row };
}

export class SkillServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly fields?: Array<{ field: string; code: string }>,
  ) {
    super(message);
    this.name = "SkillServiceError";
  }
}

function fieldCode(issue: ZodIssue): string {
  if (issue.code === "too_big") return "too_long";
  if (issue.code === "invalid_type") return "invalid_format";
  return "required";
}

function invalidInput(issues: ZodIssue[]): SkillServiceError {
  return new SkillServiceError(
    "INVALID_INPUT",
    400,
    "Skill input is invalid.",
    issues.map((issue) => ({
      code: fieldCode(issue),
      field: issue.path.join(".") || "input",
    })),
  );
}

function parseSkillInput(input: unknown): SkillInput {
  const parsed = skillInputSchema.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error.issues);
  return parsed.data;
}

function parseUpdateSkillInput(input: unknown): UpdateSkillInput {
  const parsed = updateSkillInputSchema.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error.issues);
  return parsed.data;
}

function selectSkill(
  database: ReturnType<typeof openDatabase>,
  skillId: string,
): SkillRow | undefined {
  return database
    .prepare(`
      SELECT
        id,
        name,
        description,
        instructions,
        version,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM skills
      WHERE id = ?
    `)
    .get(skillId) as SkillRow | undefined;
}

export function createSkill(input: SkillInput, databasePath: string): Skill {
  const parsedInput = parseSkillInput(input);
  const timestamp = new Date().toISOString();
  const skill: Skill = {
    id: randomUUID(),
    name: parsedInput.name,
    description: parsedInput.description,
    instructions: parsedInput.instructions,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const database = openDatabase(databasePath);

  try {
    database
      .prepare(`
        INSERT INTO skills (
          id, name, description, instructions, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        skill.id,
        skill.name,
        skill.description,
        skill.instructions,
        skill.version,
        skill.createdAt,
        skill.updatedAt,
      );
    return skill;
  } finally {
    database.close();
  }
}

export function updateSkill(
  skillId: string,
  input: UpdateSkillInput,
  databasePath: string,
): Skill {
  const parsedInput = parseUpdateSkillInput(input);
  const database = openDatabase(databasePath);

  try {
    const updatedAt = new Date().toISOString();
    const result = database
      .prepare(`
        UPDATE skills
        SET name = ?,
            description = ?,
            instructions = ?,
            version = version + 1,
            updated_at = ?
        WHERE id = ? AND version = ?
      `)
      .run(
        parsedInput.name,
        parsedInput.description,
        parsedInput.instructions,
        updatedAt,
        skillId,
        parsedInput.expectedVersion,
      );
    if (result.changes === 0) {
      const current = selectSkill(database, skillId);
      if (!current) {
        throw new SkillServiceError("SKILL_NOT_FOUND", 404, "Skill was not found.");
      }
      throw new SkillServiceError(
        "RESOURCE_CONFLICT",
        409,
        "Skill version is stale.",
      );
    }
    return toSkill(selectSkill(database, skillId)!);
  } finally {
    database.close();
  }
}

export function listSkills(databasePath: string): Skill[] {
  const database = openDatabase(databasePath);

  try {
    const rows = database
      .prepare(`
        SELECT
          id,
          name,
          description,
          instructions,
          version,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM skills
        ORDER BY created_at ASC, id ASC
      `)
      .all() as SkillRow[];
    return rows.map(toSkill);
  } finally {
    database.close();
  }
}
