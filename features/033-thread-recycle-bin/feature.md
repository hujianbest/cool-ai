# 033-thread-recycle-bin

线程回收站、恢复与永久删除（S-20 / CI-2.8）。owner 能软删除线程、从回收站恢复，并在强确认后永久删除；系统线程、当前导航和悬空引用均有明确处理；删除/恢复/永久删除全程可审计、跨项目绝不泄漏。

- 规格: [spec.md](./spec.md)
- 架构: [architecture.md](./architecture.md)
- 任务票: [tickets.md](./tickets.md)
- 进度: [progress.md](./progress.md)
- Backlog: [`product/backlog.md` S-20](../../product/backlog.md)
