# COOL AI

带 Web UI 的多 agent 协作平台:用户作为项目 owner 把可配置的角色 agent 拉进项目组,agent 在群组内平等协作、自主接力完成软件交付。

> 当前为行走骨架(S-1):可运行空壳 + 最薄端到端(UI→API→DB→UI)+ 一键命令 + 可观察 UI。

## 环境要求

- Node.js ≥ 20(开发基于 Node 24)
- npm

## 一键命令

```bash
npm install        # 安装依赖(首次)
npm run dev        # 启动开发服务器,访问 http://localhost:3000
npm test           # 运行全量测试
npm run build      # 生产构建
```

## 数据库

SQLite(本地文件 `prisma/dev.db`),通过 Prisma 管理。首次或 schema 变更后:

```bash
npx prisma migrate dev     # 应用迁移并生成 client
node node_modules/prisma/build/index.js db seed   # 写入种子数据
```

## 技术栈

- Next.js(App Router)+ TypeScript
- Prisma + SQLite
- Tailwind CSS(design token)
- Vitest + Testing Library
