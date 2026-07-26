import { NextResponse } from "next/server";
import { getAgents } from "../../../src/server/agentService";

export async function GET() {
  try {
    const agents = await getAgents();
    return NextResponse.json({ agents });
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
