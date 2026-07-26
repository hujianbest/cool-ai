import { NextResponse } from "next/server";
import {
  createSkill,
  getSkills,
  ValidationError,
} from "../../../src/server/skillService";
import type { CreateSkillInput } from "../../../src/server/skillService";

export async function GET() {
  try {
    const skills = await getSkills();
    return NextResponse.json({ skills });
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  try {
    const skill = await createSkill((body ?? {}) as CreateSkillInput);
    return NextResponse.json({ skill }, { status: 201 });
  } catch (e) {
    if (e instanceof ValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    const message = e instanceof Error ? e.message : "internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
