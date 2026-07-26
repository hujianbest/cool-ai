import { NextResponse } from "next/server";
import { getSkill } from "../../../../src/server/skillService";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = Number((await params).id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  try {
    const skill = await getSkill(id);
    return NextResponse.json({ skill });
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    if (message === "skill not found") {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
