import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.agent.deleteMany();
  await prisma.skill.deleteMany();
  await prisma.providerConfig.deleteMany();

  const s1 = await prisma.skill.create({
    data: { name: "需求整理", description: "把欠定想法整理为可执行需求", content: "## When to Use\n需求不清晰时。", category: "product" },
  });
  await prisma.skill.create({
    data: { name: "TDD", description: "红-绿-重构循环", content: "## Procedure\n1. 写失败测试", category: "engineering" },
  });
  const p = await prisma.providerConfig.create({
    data: { name: "示例 provider (GLM)", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "" },
  });
  await prisma.agent.create({
    data: { name: "骨架 Agent", systemPrompt: "行走骨架的占位 agent", skills: JSON.stringify([s1.id]), providerConfigId: p.id, model: "glm-4-plus" },
  });

  console.log("dev.db reset to seed only (2 skills + 1 provider + 骨架 Agent)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
