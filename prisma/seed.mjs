import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.agent.upsert({
    where: { id: 1 },
    update: { name: "骨架 Agent", role: "占位角色" },
    create: { name: "骨架 Agent", role: "占位角色" },
  });
  console.log("seeded: 骨架 Agent");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
