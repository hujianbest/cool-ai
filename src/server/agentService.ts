import type { PrismaClient } from "@prisma/client";
import { prisma } from "./db";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export type AgentDTO = {
  id: number;
  name: string;
  systemPrompt: string;
  tools: string[];
  provider: string;
  skills: number[];
  createdAt: Date;
};

type AgentRow = {
  id: number;
  name: string;
  systemPrompt: string;
  tools: string;
  provider: string;
  skills: string;
  createdAt: Date;
};

function parseList(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function parseIdList(raw: string): number[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((x): x is number => typeof x === "number")
      : [];
  } catch {
    return [];
  }
}

function toDTO(a: AgentRow): AgentDTO {
  return {
    id: a.id,
    name: a.name,
    systemPrompt: a.systemPrompt,
    tools: parseList(a.tools),
    provider: a.provider,
    skills: parseIdList(a.skills),
    createdAt: a.createdAt,
  };
}

export async function getAgents(
  client: PrismaClient = prisma
): Promise<AgentDTO[]> {
  const rows = await client.agent.findMany({ orderBy: { id: "asc" } });
  return rows.map(toDTO);
}

export type CreateAgentInput = {
  name?: string;
  systemPrompt?: string;
  tools?: string[];
  provider?: string;
  skills?: number[];
};

export async function createAgent(
  input: CreateAgentInput,
  client: PrismaClient = prisma
): Promise<AgentDTO> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new ValidationError("name 必填");

  const skillIds = Array.isArray(input.skills) ? input.skills : [];
  if (skillIds.length > 0) {
    const found = await client.skill.findMany({
      where: { id: { in: skillIds } },
      select: { id: true },
    });
    if (found.length !== new Set(skillIds).size) {
      throw new ValidationError("unknown skill id");
    }
  }

  const row = await client.agent.create({
    data: {
      name,
      systemPrompt: input.systemPrompt ?? "",
      tools: JSON.stringify(input.tools ?? []),
      skills: JSON.stringify(skillIds),
      provider: input.provider ?? "zhipuai-coding-plan",
    },
  });
  return toDTO(row);
}
