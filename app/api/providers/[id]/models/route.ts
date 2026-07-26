import { NextResponse } from "next/server";
import { getProviderFull } from "../../../../../src/server/providerService";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = Number((await params).id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  let config;
  try {
    config = await getProviderFull(id);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  try {
    const url = `${config.baseUrl.replace(/\/$/, "")}/models`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const data: { data?: { id?: string }[] } = await res.json();
    const models: string[] = Array.isArray(data?.data)
      ? data.data
          .map((m) => m?.id)
          .filter((x): x is string => typeof x === "string")
      : [];
    return NextResponse.json({ models });
  } catch {
    return NextResponse.json({ error: "upstream error" }, { status: 502 });
  }
}
