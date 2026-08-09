# 015 — 结构化消息与就地决策

- 对应切片: S-13（CI-2.3）
- 模式: 建造
- 用户可感知: 是
- 依赖: 已交付 S-12 项目内持久线程与上下文续接

## 目标

让 owner 在既有 fact-only 公开线程时间线中查看带精确来源与版本的正式消息块，并在 Proposal 或 Checklist 原位完成该块明确允许的决定；重复、冲突和陈旧提交具有确定结果，不产生重复业务动作。

## 范围

- 首批正式 block 类型限定为 Proposal、Checklist、Diff Preview、File Reference 与 Handoff Card。
- Structured Message Block 作为公开 Thread Fact/Message 的版本化不可变内容，保留 actor、顺序与精确 Source Tuple。
- Proposal 与 Checklist 支持 owner Inline Decision，并以 operation、expected version 与 Action Receipt 表达重放、冲突和陈旧结果。
- Diff Preview、File Reference 与 Handoff Card 只投影既有、已验证的来源事实。
- Agent 通过 strict structured output 提议 block；只有完整校验通过的内容才能原子成为公开事实。
- fact-only transcript 逐 block 呈现正式内容、状态和安全降级，并覆盖桌面、窄屏、键盘和可访问性。
- 兼容既有纯文本事实；重启、迁移和分页保持事实顺序、来源、版本与决定结果。
- block 创建、决定和审批关联保留脱敏、可追溯的 actor、operation、version 与 source。

## 非目标

- 任意 HTML、插件或第三方可执行渲染。
- 消息分支、回复引用、附件、搜索、标签、收藏、回收站、队列或 Steer。
- 新的 Run 生命周期、私语、Agent 投票或第二份 handoff 事实。
- 任意宿主文件读取、文件编辑、diff 合入或绕过既有执行/审批边界。
- 追溯生成旧消息的 Structured Message Block，或用 latest 来源替换冻结身份。
- 保存 raw Provider 响应、隐藏推理、凭据或原始私密 diff。

## 安全边界

- 类型、版本、大小、来源与可见文本采用 allowlist 和严格校验；未知类型/版本只显示稳定、不可执行占位。
- 文件与 diff 来源必须已存在且通过既有项目 tuple、verified-handle、sandbox 与 approval 边界；消息卡不扩张权限。
- 高风险动作只能跳转或发起正式 Approval；卡片点击和 Inline Decision 均不直接执行高风险动作。
- operation 重放只返回原 Action Receipt；同 ID 不同请求冲突，stale expected version 失败并要求重读。
- 凭据、raw Provider 响应、隐藏推理与私密原始 diff 不进入公开事实、公共审计或错误回显。
- 任何来源、归属、版本或迁移不变量不成立时失败关闭，不部分提交、不猜测解释。

## Grill 设计树结论

1. 内容前沿：采用五类正式 block allowlist；其余富消息能力保持后续切片。
2. 身份前沿：block 继承公开 Message/Thread Fact 的不可变身份、actor、版本和冻结 Source Tuple。
3. 决定前沿：只允许 Proposal/Checklist 原位决定，使用唯一动作集合、expected version 与幂等 Action Receipt。
4. 来源前沿：diff/file/handoff 仅投影既有已验证事实，不创造文件能力、Run 或私语。
5. 信任前沿：Agent 只提议 strict structured output；平台完整校验后原子提交，失败不降级为可执行内容。
6. 交互前沿：逐 block 渲染完整状态；未知类型/版本稳定失败关闭。
7. 恢复前沿：旧文本不改写，新事实在迁移、分页与重启中保持顺序、来源、版本和决定结果。
8. 审计前沿：记录 actor/operation/version/source 和脱敏结果关联，不公开秘密、原始私密内容或隐藏推理。

采用的 auto 默认已先记录于 `product/assumptions.md` A-74～A-83。

## ADR 评估

不创建 ADR。当前决定具有真实范围与安全取舍，但缺少“难以逆转”条件：block allowlist 与行为边界可通过后续版本化切片扩展，且其来源/审批原则已由现有产品决策解释；未同时满足难以逆转、脱离上下文令人意外、真实权衡三项条件。
