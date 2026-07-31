# 技术设计 评审 (第 14 轮)

- 日期: 2026-07-31
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-07-31

## Findings

无。第 13 轮两项 findings 均已闭合：

- descriptor 与 journal DDL 已统一为 strict ref JSON，完整持久化 stable root、handle-relative path、owner、parent/file identity、hash 与 size；canonical temp/post identity 的生成时点及仅凭 DB refs、journal root、canonical root 的重启恢复路径已明确。
- 生命周期签名已补 canonical target 定位、`NativeMutationResult` 分支和 canonical temp preparation，并明确映射 modified/added 的 apply、rollback、roll-forward 与 conditional cleanup；T-38 可独立按该 primitive 契约测试。

# 技术设计 评审 (第 15 轮)

- 日期: 2026-07-31
- 评审方式: subagent
- 结论: 需修改

## Findings

- [严重] `design.md` §7（verified sandbox manifest 生命周期）与 T-41：当前只要求“成功且可能改变文件的 command”在成功事实前刷新整树 manifest，但非零退出、超时后已确认终止等失败命令同样可能已经改写 sandbox；此时 attempt 缓存 hash 与 validation freshness 可继续停留在命令前状态，违反“整棵 sandbox 的唯一字节事实”和失败关闭。该段也未把 write/command/validation/stage 的唯一顺序及 CAS 失败结果写完整：`before_sandbox_hash` 来自哪次 verified refresh、attempt 旧 hash/lease/version/status 的 CAS 条件、validation 绑定 pre-command 还是 post-command hash、stage 是否只消费同一次 refresh 返回的 entries/hash，均仍需实现阶段自行发明。应明确：每次 write 与每个实际启动过且已确认终止的 command（不论 exit code）都执行受 lease/status/version/expected-current-hash 约束的 pre/post 整树 refresh；tool/action、attempt manifest 与 validation（若可产生）按一个明确 finalize 顺序提交，任一 CAS/refresh 失败均不得留下 succeeded tool/action/validation/stage；stage 仅使用其当次 verified refresh 的同一份 entries/hash 计算 observations。T-41 的单一测试还须覆盖成功/失败 command、validation 新鲜度、CAS 竞争/失败和 stage refresh 失败，而不只覆盖成功 write→validation→stage happy path；T-42 必须在 T-41 闭合后，T-43 再仅验证 T-42 已公开贯通的行为。

# 技术设计 评审 (第 16 轮)

- 日期: 2026-07-31
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-07-31

## Findings

无。第 15 轮 finding 已闭合：write 与所有实际启动且已确认终止的 command（成功、非零退出、timeout）均明确执行 verified pre/post 整树 refresh；finalize 已规定 lease/token、execution version/status、attempt status、preHash 的 CAS 与 tool/action、postHash validation、attempt manifest、receipt 的唯一事务顺序，refresh/CAS/termination 不确定均不留下成功事实且旧 attempt 不可 stage；validation 绑定同次 postHash，stage 只消费单次 refresh 的不可变 entries/hash。T-41 已在单一测试任务中覆盖成功/失败/timeout command、`sha256` 统一、validation 失鲜、stage、refresh/遍历失败及 lease/version/hash CAS 竞争，并保持 T-41→T-42→T-43 顺序。
