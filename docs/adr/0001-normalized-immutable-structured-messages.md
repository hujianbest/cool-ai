# 结构化消息采用规范化不可变状态模型

- 状态: proposed

v8 将 Structured Message Block、state revision、Inline Decision、business Action Receipt 与 decision fact 分开持久化为复合 tuple 约束的不可变记录，而不把卡片整体内嵌进 Message JSON，也不就地改写单一 block 状态行。该选择让来源、版本、CAS、重放和历史恢复可由数据库机械约束，代价是 7→8 重建、更多关系与读取投影；迁移后切换模型代价高，代码外不易看出为何不选简单 JSON，且确实在简单写入与可验证历史之间取舍，因此满足 ADR 三条件。
