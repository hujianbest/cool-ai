import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const s1 = await prisma.skill.upsert({
    where: { id: 1 },
    update: { name: "需求整理", description: "把欠定想法整理为可执行需求", content: "## When to Use\n需求不清晰时。\n## Procedure\n1. 澄清目标用户\n2. 列出可观察的成功标准", category: "product" },
    create: { name: "需求整理", description: "把欠定想法整理为可执行需求", content: "## When to Use\n需求不清晰时。\n## Procedure\n1. 澄清目标用户\n2. 列出可观察的成功标准", category: "product" },
  });
  await prisma.skill.upsert({
    where: { id: 2 },
    update: { name: "TDD", description: "红-绿-重构循环", content: "## Procedure\n1. 写失败测试\n2. 最小实现转绿\n3. 重构", category: "engineering" },
    create: { name: "TDD", description: "红-绿-重构循环", content: "## Procedure\n1. 写失败测试\n2. 最小实现转绿\n3. 重构", category: "engineering" },
  });

  await prisma.agent.upsert({
    where: { id: 1 },
    update: { name: "骨架 Agent", systemPrompt: "行走骨架的占位 agent", skills: JSON.stringify([s1.id]) },
    create: { name: "骨架 Agent", systemPrompt: "行走骨架的占位 agent", skills: JSON.stringify([s1.id]) },
  });
  console.log("seeded: 2 skills + 骨架 Agent(关联 skill 1)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
