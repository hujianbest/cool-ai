import type { PrismaClient } from "@prisma/client";
import { prisma } from "./db";
import { ValidationError } from "./agentService";

export { ValidationError };

export type SkillDTO = {
  id: number;
  name: string;
  description: string;
  content: string;
  category: string;
  createdAt: Date;
};

export type SkillIndexDTO = {
  id: number;
  name: string;
  description: string;
  category: string;
  agentCount: number;
};

export type CreateSkillInput = {
  name?: string;
  description?: string;
  content?: string;
  category?: string;
};

type SkillRow = {
  id: number;
  name: string;
  description: string;
  content: string;
  category: string;
  createdAt: Date;
};

function toDTO(s: SkillRow): SkillDTO {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    content: s.content,
    category: s.category,
    createdAt: s.createdAt,
  };
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

export async function createSkill(
  input: CreateSkillInput,
  client: PrismaClient = prisma
): Promise<SkillDTO> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new ValidationError("name 必填");
  const row = await client.skill.create({
    data: {
      name,
      description: input.description ?? "",
      content: input.content ?? "",
      category: input.category ?? "",
    },
  });
  return toDTO(row);
}

export async function getSkills(
  client: PrismaClient = prisma
): Promise<SkillIndexDTO[]> {
  const [skills, agents] = await Promise.all([
    client.skill.findMany({ orderBy: { id: "asc" } }),
    client.agent.findMany({ select: { skills: true } }),
  ]);
  return skills.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    category: s.category,
    agentCount: agents.filter((a) => parseIdList(a.skills).includes(s.id)).length,
  }));
}

export async function getSkill(
  id: number,
  client: PrismaClient = prisma
): Promise<SkillDTO> {
  const row = await client.skill.findUnique({ where: { id } });
  if (!row) throw new Error("skill not found");
  return toDTO(row);
}
