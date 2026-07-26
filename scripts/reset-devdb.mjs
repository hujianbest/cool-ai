import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
async function main() {
  await prisma.agent.deleteMany({});
  await prisma.agent.create({
    data: { name: "骨架 Agent", systemPrompt: "行走骨架的占位 agent" },
  });
  console.log("dev.db reset to seed only (1 agent)");
}
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
