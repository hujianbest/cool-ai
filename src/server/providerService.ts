import type { PrismaClient } from "@prisma/client";
import { prisma } from "./db";
import { ValidationError } from "./agentService";

export { ValidationError };

export type ProviderConfigDTO = {
  id: number;
  name: string;
  baseUrl: string;
  createdAt: Date;
  agentCount: number;
};

export type CreateProviderInput = {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
};

type ProviderRow = {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  createdAt: Date;
};

function toDTO(c: ProviderRow, agentCount: number): ProviderConfigDTO {
  return {
    id: c.id,
    name: c.name,
    baseUrl: c.baseUrl,
    createdAt: c.createdAt,
    agentCount,
  };
}

export async function createProvider(
  input: CreateProviderInput,
  client: PrismaClient = prisma
): Promise<ProviderConfigDTO> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  if (!name) throw new ValidationError("name 必填");
  if (!baseUrl) throw new ValidationError("baseUrl 必填");

  const row = await client.providerConfig.create({
    data: { name, baseUrl, apiKey: input.apiKey ?? "" },
  });
  return toDTO(row, 0);
}

export async function getProviders(
  client: PrismaClient = prisma
): Promise<ProviderConfigDTO[]> {
  const [configs, agents] = await Promise.all([
    client.providerConfig.findMany({ orderBy: { id: "asc" } }),
    client.agent.findMany({ select: { providerConfigId: true } }),
  ]);
  return configs.map((c) =>
    toDTO(
      c,
      agents.filter((a) => a.providerConfigId === c.id).length
    )
  );
}

export async function getProviderFull(
  id: number,
  client: PrismaClient = prisma
): Promise<ProviderRow> {
  const row = await client.providerConfig.findUnique({ where: { id } });
  if (!row) throw new Error("provider config not found");
  return row;
}
