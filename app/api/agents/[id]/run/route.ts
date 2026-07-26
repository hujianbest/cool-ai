import { NextResponse } from "next/server";
import { runAgent, NotFoundError, UpstreamError } from "../../../../../src/server/agentRunner";
import { ValidationError } from "../../../../../src/server/agentService";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = Number((await params).id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const task = typeof (body as { task?: unknown })?.task === "string"
    ? (body as { task: string }).task
    : "";

  try {
    const result = await runAgent(id, task);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof NotFoundError) {
      return NextResponse.json({ error: "agent not found" }, { status: 404 });
    }
    if (e instanceof ValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    if (e instanceof UpstreamError) {
      return NextResponse.json({ error: "upstream error" }, { status: 502 });
    }
    const message = e instanceof Error ? e.message : "internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
