import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const s1 = await prisma.skill.upsert({
    where: { id: 1 },
    update: { name: "需求整理", description: "把欠定想法整理为可执行需求", content: "## When to Use\n需求不清晰时。", category: "product" },
    create: { name: "需求整理", description: "把欠定想法整理为可执行需求", content: "## When to Use\n需求不清晰时。", category: "product" },
  });
  await prisma.skill.upsert({
    where: { id: 2 },
    update: { name: "TDD", description: "红-绿-重构循环", content: "## Procedure\n1. 写失败测试\n2. 最小实现转绿", category: "engineering" },
    create: { name: "TDD", description: "红-绿-重构循环", content: "## Procedure\n1. 写失败测试\n2. 最小实现转绿", category: "engineering" },
  });

  const p = await prisma.providerConfig.upsert({
    where: { id: 1 },
    update: { name: "示例 provider (GLM)", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
    create: { name: "示例 provider (GLM)", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "" },
  });

  await prisma.agent.upsert({
    where: { id: 1 },
    update: { name: "骨架 Agent", systemPrompt: "行走骨架的占位 agent", skills: JSON.stringify([s1.id]), providerConfigId: p.id, model: "glm-4-plus" },
    create: { name: "骨架 Agent", systemPrompt: "行走骨架的占位 agent", skills: JSON.stringify([s1.id]), providerConfigId: p.id, model: "glm-4-plus" },
  });
  console.log("seeded: 2 skills + 1 provider config + 骨架 Agent");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
