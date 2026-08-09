import { join } from "node:path";

import { readSkillJson, skillApiError } from "@/app/api/_shared/skill-api";
import { skillService } from "@/src/composition";
import { skillInputSchema } from "@/src/shared/team-schemas";

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(): Promise<Response> {
  try {
    return Response.json({ skills: skillService.listSkills(databasePath()) });
  } catch (error) {
    return skillApiError(error, "GET /api/skills");
  }
}

export async function POST(request: Request): Promise<Response> {
  const body = await readSkillJson(request);
  if (!body.ok) return body.response;

  const parsed = skillInputSchema.safeParse(body.value);
  if (!parsed.success) {
    return Response.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: "Skill input is invalid.",
          fields: parsed.error.issues.map((issue) => ({
            code: issue.code === "too_big" ? "too_long" : "required",
            field: issue.path.join("."),
          })),
        },
      },
      { status: 400 },
    );
  }

  try {
    return Response.json(
      { skill: skillService.createSkill(parsed.data, databasePath()) },
      { status: 201 },
    );
  } catch (error) {
    return skillApiError(error, "POST /api/skills");
  }
}
