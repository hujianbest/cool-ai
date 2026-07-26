import type { PrismaClient } from "@prisma/client";
import { prisma } from "./db";
import { ValidationError } from "./agentService";

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

export type RunTraceStep = { role: "system" | "user" | "assistant"; content: string };
export type RunResult = { output: string; trace: RunTraceStep[] };

function parseIdList(raw: string): number[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

export async function runAgent(
  agentId: number,
  task: string,
  client: PrismaClient = prisma
): Promise<RunResult> {
  const agent = await client.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw new NotFoundError("agent not found");
  if (agent.providerConfigId == null) {
    throw new ValidationError("agent has no provider config");
  }

  const config = await client.providerConfig.findUnique({
    where: { id: agent.providerConfigId },
  });
  if (!config) throw new ValidationError("provider config missing");

  const skillIds = parseIdList(agent.skills);
  const skills = skillIds.length
    ? await client.skill.findMany({ where: { id: { in: skillIds } } })
    : [];
  const skillBlock = skills
    .map((s) => `# Skill: ${s.name}\n${s.content}`)
    .join("\n\n");
  const systemContent = agent.systemPrompt + (skillBlock ? `\n\n${skillBlock}` : "");

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: task },
  ];

  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: agent.model, messages }),
    });
  } catch {
    throw new UpstreamError("upstream unreachable");
  }
  if (!res.ok) throw new UpstreamError(`upstream ${res.status}`);

  const data: { choices?: { message?: { content?: string } }[] } = await res.json();
  const output = data?.choices?.[0]?.message?.content ?? "";

  const trace: RunTraceStep[] = [
    { role: "system", content: systemContent },
    { role: "user", content: task },
    { role: "assistant", content: output },
  ];
  return { output, trace };
}
