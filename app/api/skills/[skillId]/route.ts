import { join } from "node:path";

import { readSkillJson, skillApiError } from "@/app/api/_shared/skill-api";
import { skillService } from "@/src/composition";
import { updateSkillInputSchema } from "@/src/shared/team-schemas";

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ skillId: string }> },
): Promise<Response> {
  const body = await readSkillJson(request);
  if (!body.ok) return body.response;

  const parsed = updateSkillInputSchema.safeParse(body.value);
  if (!parsed.success) {
    return Response.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: "Skill input is invalid.",
          fields: parsed.error.issues.map((issue) => ({
            code:
              issue.code === "too_big"
                ? "too_long"
                : issue.code === "invalid_type"
                  ? "invalid_format"
                  : "required",
            field: issue.path.join(".") || "input",
          })),
        },
      },
      { status: 400 },
    );
  }

  const { skillId } = await context.params;
  try {
    return Response.json({
      skill: skillService.updateSkill(skillId, parsed.data, databasePath()),
    });
  } catch (error) {
    return skillApiError(error, "PATCH /api/skills/:skillId");
  }
}
