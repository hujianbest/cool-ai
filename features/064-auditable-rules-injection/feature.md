# 064 可审计系统规则与提示注入检查

- 特性: 064-auditable-rules-injection（S-34 / CAP-IDC-03）
- 模式: 建造
- 用户可感知: 是
- 执行模式: auto
- 骨架: 否
- 主子系统: Identity & Capability
- 主 Capability: `CAP-IDC-03`
- 轻量级: 否（安全边界：注入检查；零 schema 只读，无跨 owner 写）
