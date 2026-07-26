import type { Agent, PrismaClient } from "@prisma/client";
import { prisma } from "./db";

export async function getAgents(client: PrismaClient = prisma): Promise<Agent[]> {
  return client.agent.findMany({ orderBy: { id: "asc" } });
}
