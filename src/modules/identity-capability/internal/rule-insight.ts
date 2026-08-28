import type {
  RuleInsight,
  RuleInsightAgentInput,
  RuleInsightFinding,
  RuleInsightInput,
  RuleInsightSeverity,
  RuleInsightSourceType,
} from "@/src/shared/rule-insight-contracts";

const MAX_EXCERPT_GRAPHEMES = 40;
const EXCERPT_CONTEXT_GRAPHEMES = 20;

type ConflictBoundary = "write" | "execute" | "review";
type InstructionPolarity = "allow" | "deny";

interface BoundaryDirective {
  index: number;
  polarity: InstructionPolarity;
}

interface FindingRule {
  code: string;
  severity: RuleInsightSeverity;
  reason: string;
  locate: (foldedText: string, agent: RuleInsightAgentInput) => number | null;
}

function asciiFold(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function locate(pattern: RegExp, text: string): number | null {
  return pattern.exec(text)?.index ?? null;
}

function locatePositive(pattern: RegExp, text: string): number | null {
  const matcher = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  for (const match of text.matchAll(matcher)) {
    const index = match.index;
    const prefix = text.slice(Math.max(0, index - 20), index);
    if (
      !/(?:\b(?:never|not|without)\s*|(?:禁止|不要|不得|不可|不准|永不)\s*)$/u.test(
        prefix,
      )
    ) {
      return index;
    }
  }
  return null;
}

function locateWriteRequest(text: string): number | null {
  return locatePositive(
    /\b(?:write|edit|modify|change|create|update)\b[\s\S]{0,24}(?:\bfiles?\b|\b[a-z0-9][a-z0-9._/\\-]*\.[a-z0-9]{1,12}\b)|(?:写入|写|编辑|修改|创建|更新)[\s\S]{0,12}(?:文件|档案|[a-z0-9][a-z0-9._/\\-]*\.[a-z0-9]{1,12})/u,
    text,
  );
}

function locateExecuteRequest(text: string): number | null {
  return locatePositive(
    /\b(?:run|execute)\b[\s\S]{0,20}\b(?:commands?|shell|terminal|powershell|bash|npm|npx|pnpm|yarn|node|python|pytest|vitest|git|cmd)\b|(?:运行|执行)[\s\S]{0,12}(?:命令|shell|终端|脚本|npm|npx|pnpm|yarn|node|python|pytest|vitest|git|cmd)/u,
    text,
  );
}

function locateReviewDeny(text: string): number | null {
  return locate(
    /\b(?:skip|bypass|ignore|disable)\b[\s\S]{0,32}\b(?:independent\s+)?review\b|\bdo\s+not\s+(?:independently\s+)?review\b|(?:跳过|绕过|忽略|不要|无需|不必)[\s\S]{0,8}(?:独立)?复核/u,
    text,
  );
}

const FINDING_RULES: FindingRule[] = [
  {
    code: "override_review",
    locate: (text) => locateReviewDeny(text),
    reason: "该指令试图绕过独立复核，不能覆盖复核安全边界。",
    severity: "block",
  },
  {
    code: "elevate_write",
    locate: (text, agent) =>
      agent.permissions.writeFiles ? null : locateWriteRequest(text),
    reason: "该指令要求写入或编辑文件，但此 Agent 未获写文件权限。",
    severity: "block",
  },
  {
    code: "elevate_execute",
    locate: (text, agent) =>
      agent.permissions.runCommands ? null : locateExecuteRequest(text),
    reason: "该指令要求运行命令或 Shell，但此 Agent 未获命令执行权限。",
    severity: "block",
  },
  {
    code: "exfiltrate_credential",
    locate: (text) =>
      locate(
        /\b(?:reveal|print|show|display|output|return|expose|provide|send)\b[\s\S]{0,40}\b(?:api[\s_-]*key|secret|password|credentials?|cockpit_master_key)\b|(?:揭示|显示|打印|输出|回显|返回|提供|发送|索取|泄露)[\s\S]{0,20}(?:api[\s_-]*key|密钥|秘密|密码|凭据|cockpit_master_key)/u,
        text,
      ),
    reason: "该指令要求索取或回显凭据，不能泄露密钥、密码或 Secret。",
    severity: "block",
  },
  {
    code: "ignore_previous",
    locate: (text) =>
      locate(
        /\bignore\b[\s\S]{0,16}\b(?:previous|above)\b(?:\s+instructions?)?|忽略(?:之前|以上)(?:的)?(?:指令|说明)?/u,
        text,
      ),
    reason: "该指令试图忽略既有指令，可能造成提示注入。",
    severity: "warn",
  },
  {
    code: "role_hijack",
    locate: (text) =>
      locate(/\byou\s+are\s+now\b|\bpretend\s+to\s+be\s+(?:the\s+)?system\b|你现在是/u, text),
    reason: "该指令试图劫持 Agent 角色，可能改变既定身份边界。",
    severity: "warn",
  },
  {
    code: "hidden_override",
    locate: (text) =>
      locate(/\bhidden\s+system(?:\s+prompt)?\b|隐藏(?:的)?系统提示/u, text),
    reason: "该指令引用隐藏系统提示，可能尝试覆盖不可见规则。",
    severity: "warn",
  },
];

function redactCredentials(value: string): string {
  return value
    .replace(
      /\b((?:api[\s_-]*key|secret|password|cockpit_master_key)\s*(?:is|=|:)?\s*)([^\s,!?;，。！？；]+)/giu,
      "$1***",
    )
    .replace(
      /((?:密钥|密码|凭据)\s*(?:是|=|:|：)?\s*)([^\s,!?;，。！？；]+)/giu,
      "$1***",
    )
    .replace(/[a-z0-9]+(?:[._-][a-z0-9]+)+/giu, "***")
    .replace(/[a-z0-9]{8,}/giu, "***");
}

function excerptFor(value: string, matchIndex: number): string {
  const redacted = redactCredentials(value);
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
  const graphemes = [...segmenter.segment(redacted)].map((part) => part.segment);
  const prefixLength = [
    ...segmenter.segment(redacted.slice(0, Math.min(matchIndex, redacted.length))),
  ].length;
  const start = Math.max(0, prefixLength - EXCERPT_CONTEXT_GRAPHEMES);
  const window = graphemes.slice(start, start + MAX_EXCERPT_GRAPHEMES);
  if (window.length === 0) return "…";
  const hiddenCount = Math.max(1, Math.ceil(window.length / 2));
  const matchInWindow = Math.min(
    window.length - 1,
    Math.max(0, prefixLength - start),
  );
  const hiddenStart = Math.min(
    window.length - hiddenCount,
    Math.max(0, matchInWindow - Math.floor(hiddenCount / 2)),
  );
  const before = window.slice(0, hiddenStart).join("");
  const after = window.slice(hiddenStart + hiddenCount).join("");
  const leadingClip = start > 0 ? "…" : "";
  const trailingClip =
    start + window.length < graphemes.length ? "…" : "";
  return `${leadingClip}${before}…${after}${trailingClip}`;
}

function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function findingsForSource(
  agent: RuleInsightAgentInput,
  sourceType: RuleInsightSourceType,
  sourceId: string,
  sourceName: string,
  text: string,
): RuleInsightFinding[] {
  const foldedText = asciiFold(text);
  const findings: RuleInsightFinding[] = [];
  for (const rule of FINDING_RULES) {
    const matchIndex = rule.locate(foldedText, agent);
    if (matchIndex === null) continue;
    findings.push({
      agentId: agent.id,
      code: rule.code,
      conflictGroupId: null,
      excerpt: excerptFor(text, matchIndex),
      id: `${agent.id}:${sourceType}:${sourceId}:${rule.code}`,
      reason: rule.reason,
      severity: rule.severity,
      sourceId,
      sourceName,
      sourceType,
    });
  }
  return findings;
}

function locateWriteDeny(text: string): number | null {
  return locate(
    /\b(?:never|do\s+not|don't|must\s+not|mustn't)\b[^.!?;\n]{0,16}\b(?:write|edit|modify|change|create|update)\b|(?:禁止|不要|不得|不可|不准|永不)[^。！？；\n]{0,8}(?:写入|写|编辑|修改|创建|更新)/u,
    text,
  );
}

function locateExecuteDeny(text: string): number | null {
  return locate(
    /\b(?:never|do\s+not|don't|must\s+not|mustn't)\b[^.!?;\n]{0,16}\b(?:run|execute)\b|(?:禁止|不要|不得|不可|不准|永不)[^。！？；\n]{0,8}(?:运行|执行)/u,
    text,
  );
}

function locateReviewAllow(text: string): number | null {
  return locatePositive(
    /\b(?:always|must|required\s+to)\b[\s\S]{0,20}\b(?:independent\s+)?review\b|(?:始终|必须|务必)[\s\S]{0,8}(?:独立)?复核/u,
    text,
  );
}

function boundaryDirective(
  text: string,
  boundary: ConflictBoundary,
): BoundaryDirective | null {
  const folded = asciiFold(text);
  const denyIndex =
    boundary === "write"
      ? locateWriteDeny(folded)
      : boundary === "execute"
        ? locateExecuteDeny(folded)
        : locateReviewDeny(folded);
  if (denyIndex !== null) return { index: denyIndex, polarity: "deny" };

  const allowIndex =
    boundary === "write"
      ? locateWriteRequest(folded)
      : boundary === "execute"
        ? locateExecuteRequest(folded)
        : locateReviewAllow(folded);
  return allowIndex === null
    ? null
    : { index: allowIndex, polarity: "allow" };
}

function conflictReason(boundary: ConflictBoundary): string {
  if (boundary === "write") {
    return "Agent 提示与技能说明对写文件给出相反指令，已阻断该冲突规则。";
  }
  if (boundary === "execute") {
    return "Agent 提示与技能说明对运行命令给出相反指令，已阻断该冲突规则。";
  }
  return "Agent 提示与技能说明对独立复核给出相反指令，已阻断该冲突规则。";
}

function conflictFinding(
  agent: RuleInsightAgentInput,
  sourceType: RuleInsightSourceType,
  sourceId: string,
  sourceName: string,
  text: string,
  matchIndex: number,
  boundary: ConflictBoundary,
): RuleInsightFinding {
  return {
    agentId: agent.id,
    code: "instruction_conflict",
    conflictGroupId: `${agent.id}:${boundary}`,
    excerpt: excerptFor(text, matchIndex),
    id: `${agent.id}:${sourceType}:${sourceId}:instruction_conflict:${boundary}`,
    reason: conflictReason(boundary),
    severity: "block",
    sourceId,
    sourceName,
    sourceType,
  };
}

function conflictFindingsForAgent(
  agent: RuleInsightAgentInput,
  skills: RuleInsightAgentInput["skills"],
): RuleInsightFinding[] {
  const findings: RuleInsightFinding[] = [];
  const emittedSources = new Set<string>();
  for (const boundary of [
    "write",
    "execute",
    "review",
  ] satisfies ConflictBoundary[]) {
    const promptDirective = boundaryDirective(agent.systemPrompt, boundary);
    if (!promptDirective) continue;
    for (const skill of skills) {
      const skillDirective = boundaryDirective(skill.instructions, boundary);
      if (!skillDirective || skillDirective.polarity === promptDirective.polarity) {
        continue;
      }
      const promptKey = `${boundary}:agent_prompt:${agent.id}`;
      if (!emittedSources.has(promptKey)) {
        findings.push(
          conflictFinding(
            agent,
            "agent_prompt",
            agent.id,
            agent.name,
            agent.systemPrompt,
            promptDirective.index,
            boundary,
          ),
        );
        emittedSources.add(promptKey);
      }
      const skillKey = `${boundary}:skill_instruction:${skill.id}`;
      if (!emittedSources.has(skillKey)) {
        findings.push(
          conflictFinding(
            agent,
            "skill_instruction",
            skill.id,
            skill.name,
            skill.instructions,
            skillDirective.index,
            boundary,
          ),
        );
        emittedSources.add(skillKey);
      }
    }
  }
  return findings;
}

export function buildRuleInsight(input: RuleInsightInput): RuleInsight {
  const sortedAgents = [...input.agents].sort((left, right) =>
    compareId(left.id, right.id),
  );
  const findings: RuleInsightFinding[] = [];

  for (const agent of sortedAgents) {
    const sortedSkills = [...agent.skills].sort((left, right) =>
      compareId(left.id, right.id),
    );
    findings.push(
      ...findingsForSource(
        agent,
        "agent_prompt",
        agent.id,
        agent.name,
        agent.systemPrompt,
      ),
    );
    for (const skill of sortedSkills) {
      findings.push(
        ...findingsForSource(
          agent,
          "skill_instruction",
          skill.id,
          skill.name,
          skill.instructions,
        ),
      );
    }
    findings.push(...conflictFindingsForAgent(agent, sortedSkills));
  }

  return {
    agents: sortedAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      scope: "project_member",
    })),
    findings,
  };
}
