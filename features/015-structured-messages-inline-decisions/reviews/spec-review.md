# 需求规格评审（第 1 轮）

- 日期: 2026-08-09
- 评审方式: subagent
- 结论: 需修改

## Findings

- [一般] 用户故事 2/5、正式内容与来源契约、决定/并发与审计（第 23～42、92～97、116～121 行）: `schema version`、block 内容/状态版本、来源实体版本均被简称为 `version`，但未知版本占位、`expected block version`、request hash、Receipt 与审计分别应绑定哪一种版本没有明确契约，第三方无法机械判定 stale、展示和恢复是否正确 → 分别命名并定义 schema version、不可变 block revision/state version 与 source entity version，明确 expected version、hash、Decision、Receipt、UI 和审计各自绑定的版本。
- [一般] 审计用户故事、决定/并发与审计、测试决策（第 75～78、116～121、164～190 行）: S-13 backlog 明确要求 `operation/version/lease` 可追溯，上游 014 architecture 也把 `version/lease` 列为写入横切约定，但本规格只覆盖 operation/version/source，未说明 Inline Decision 或 Agent turn 是否使用 lease，也没有 lease 失效、恢复或审计测试 → 明确本切片各写路径的 lease 适用性；适用时补充租约身份、失效/接管/恢复、重放与审计验收，不适用时显式说明理由并与 backlog 约束对齐。
- [一般] 解决方案、重复/冲突/陈旧用户故事、决定/并发与审计（第 12～14、38～42、116～120 行）: 解决方案称重复或并发提交返回确定的 Action Receipt，但 hash conflict 与 stale version 的验收只要求“稳定冲突/结果”，第 120 行又规定失败不产生 Receipt；因此相同 operation 在 conflict/stale 后重放、当前版本随后变化或客户端未知写入恢复时，究竟重放 Receipt、持久终态还是重新计算错误没有可判定语义 → 为 success、same-hash replay、hash conflict、stale version 和 unknown-write recovery 分别定义公共响应、Receipt 是否产生/持久化、operation 是否终结及后续重放规则。
- [一般] 量化边界与对应测试决策（第 99～106、168～176 行）: `规范序列化`、KiB 和“字符”没有定义规范编码、对象字段顺序、计入范围及 Unicode 计数单位；16 KiB 决定请求同样未说明按 wire bytes 还是解析后结构计量，导致要求的边界 ±1 测试无法得到唯一结果 → 指定 block/message/request 的规范序列化形式与 UTF 编码、KiB 的字节口径、字段/包络计入范围，以及文本按 code point、UTF-16 code unit 或其他单位计数的统一规则。

# 需求规格评审（第 2 轮）

- 日期: 2026-08-09
- 评审方式: subagent
- 结论: 需修改

## 首轮 Findings 状态

1. **版本语义：已闭合。** `blockSchemaVersion`、`blockRevision`、`stateVersion`/`expectedStateVersion`、`sourceEntityVersion` 及 Decision/Receipt schema version 已分离，并明确绑定到决定、hash、UI、审计、恢复和公共测试缝。
2. **lease 适用性：已闭合。** Inline Decision 明确为同步单事务且审计 `not_applicable`；Agent turn 与 Approval 仅关联各自既有 lease，公共 API、Agent turn 与审计测试均覆盖该边界。
3. **Receipt/冲突/恢复语义：未完全闭合。** success、same-hash replay、hash conflict、terminal stale 和 unknown-write 的主体状态机已经明确，但审计用户故事仍把所有 operation 重放写成返回“同一 Receipt”，与 stale 冲突明确不产生 Receipt 的规则矛盾。
4. **量化计数口径：未完全闭合。** grapheme、KiB、UTF-8、包络计入范围、数组上限与 hash 字段范围已经明确，但自定义 `canonical JSON` 仍未给出唯一序列化标准或完整转义/数值规则，byte 边界与 request hash 仍可能因合法 JSON 表示不同而变化。

## Findings

- [一般] 审计用户故事与决定/并发/lease/审计（第 78、126～130 行）: 第 78 行对“同一 operation 重放”无条件要求关联“同一 Receipt”，但 `VERSION_CONFLICT` operation 按第 129 行持久终结且明确不产生业务 Action Receipt，只能重放冲突 envelope；该验收会迫使测试对冲突重放作出相反判断 → 将第 78 行限定为 `completed` operation，另为 `version-conflict` 明确“同一 terminal envelope、零 Receipt、零第二业务动作”的审计验收。
- [一般] 量化边界、request hash 与 A-89（第 107、112～113 行）: “canonical JSON UTF-8”只规定无 BOM/空白、键排序和数组保序，没有指定唯一标准或字符串转义、数字表示及异常 Unicode 的序列化规则；例如同一非 ASCII 字符可编码为原 UTF-8 字节或 `\uXXXX`，两者都是合法 JSON 但 byte 数和 hash 不同，因此边界 ±1 与跨重启重放仍不能机械得到唯一结果 → 引用一个精确 canonical JSON 标准，或完整定义与锁定序列化算法（至少包括字符串转义、数字、surrogate/非字符处理），并要求大小计量和 request hash 复用同一字节序列。

## 新 Findings

无。按完整 requirements 与 ext-ui checklist 复查，除上述两项首轮 finding 的残余缺口外，未发现修订新引入的严重或一般问题。

# 需求规格评审（第 3 轮）

- 日期: 2026-08-09
- 评审方式: subagent
- 结论: 通过
- 用户确认: auto-approved 2026-08-09

## 第 2 轮残余 Findings 状态

1. **Receipt/冲突审计分流：已闭合。** `completed` replay 只关联原 Action Receipt；`version-conflict` replay 只关联同一 sanitized terminal envelope 并保持零 Receipt、零 Decision/Thread Fact、零第二业务动作；异 hash `OPERATION_CONFLICT` 与客户端 pending/unknown-write 也分别具有一致且可测试的审计语义。
2. **canonical bytes 唯一性与边界分层：已闭合。** canonical domain 对象明确采用 RFC 8785 JCS，并先满足 RFC 7493 I-JSON 与 strict schema；对象排序、数组顺序、字符串转义、ECMAScript 数字、Unicode 拒绝规则及跨重启测试向量均已锁定。raw HTTP wire 32 KiB 与 `decisionIntent` JCS bytes 16 KiB 分离，大小校验与 request hash 强制复用同一 canonical byte sequence，单 block 与总 envelope 也按各自 JCS bytes 计量。

## Findings

无。完整 requirements 与 ext-ui checklist 复查未发现严重或一般问题。

> Superseded note（2026-08-09）：本评审涉及的升级/reopen 语境是历史快照。当前 S-13 存储验收使用 identity 9 canonical fresh bootstrap、exact reopen 与 unsupported/partial/drift/data-invalid fail-closed；历史评审正文与结论不改写。
