# 034-thread-message-queue-steer

消息队列、重排与 Steer（S-21 / CI-2.9）。owner 能在单线程查看待处理消息队列，执行撤回、重排与安全 steer；并在运行态/非运行态与跨线程活跃运行场景下获得一致、可解释、可审计的结果。

- 规格: [spec.md](./spec.md)
- 架构: [architecture.md](./architecture.md)
- 任务票: [tickets.md](./tickets.md)
- 进度: [progress.md](./progress.md)
- Backlog: [`product/backlog.md` S-21](../../product/backlog.md)
