import { NextResponse } from "next/server";
import {
  createProvider,
  getProviders,
  ValidationError,
} from "../../../src/server/providerService";
import type { CreateProviderInput } from "../../../src/server/providerService";

export async function GET() {
  try {
    const configs = await getProviders();
    return NextResponse.json({ configs });
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
    const config = await createProvider((body ?? {}) as CreateProviderInput);
    return NextResponse.json({ config }, { status: 201 });
  } catch (e) {
    if (e instanceof ValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    const message = e instanceof Error ? e.message : "internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
