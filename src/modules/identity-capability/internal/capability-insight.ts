import type {
  CapabilityInsight,
  CapabilityInsightAgent,
  CapabilityInsightInput,
  CapabilityPortrait,
  CapabilitySuggestion,
} from "@/src/shared/capability-insight-contracts";

const REVIEW_PATTERN = /复核|review|检查/iu;
const WRITE_PATTERN = /写入|文件|file|edit/iu;
const COMMAND_PATTERN = /命令|测试|command|test/iu;
const MAX_SUGGESTIONS_PER_ITEM = 3;

function asciiFold(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function containsFolded(haystack: string, needle: string): boolean {
  const foldedNeedle = asciiFold(needle);
  if (foldedNeedle.length === 0) return false;
  return asciiFold(haystack).includes(foldedNeedle);
}

function isUnassignedTodo(item: CapabilityInsightInput["workItems"][number]): boolean {
  return (
    item.status === "todo" &&
    (item.assigneeAgentId === null || item.assigneeAgentId === "")
  );
}

function skillNamesFor(
  agent: CapabilityInsightAgent,
  skillsById: Map<string, string>,
): string[] {
  const names: string[] = [];
  for (const skillId of agent.skillIds) {
    const name = skillsById.get(skillId);
    if (name !== undefined) names.push(name);
  }
  return names;
}

function portraitEvidence(
  skillNames: string[],
  agent: CapabilityInsightAgent,
): string[] {
  const evidence = skillNames.map((name) => `skill:${name}`);
  if (agent.permissions.readFiles) evidence.push("tool:readFiles");
  if (agent.permissions.writeFiles) evidence.push("tool:writeFiles");
  if (agent.permissions.runCommands) evidence.push("tool:runCommands");
  if (agent.reviewCapable) evidence.push("review");
  evidence.push("model");
  return evidence;
}

function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scoreAgent(
  agent: CapabilityInsightAgent,
  skillNames: string[],
  title: string,
  description: string,
): { reasons: string[]; score: number } | null {
  let score = 0;
  const reasons: string[] = [];
  const combined = `${title}\n${description}`;

  const matchedSkills = skillNames.filter(
    (name) => containsFolded(title, name) || containsFolded(description, name),
  );
  if (matchedSkills.length > 0) {
    score += 3;
    for (const name of matchedSkills) {
      reasons.push(
        containsFolded(title, name)
          ? `技能 ${name} 匹配任务标题`
          : `技能 ${name} 匹配任务说明`,
      );
    }
  }

  if (agent.reviewCapable && REVIEW_PATTERN.test(combined)) {
    score += 2;
    reasons.push("具备复核能力且任务涉及复核");
  }
  if (agent.permissions.writeFiles && WRITE_PATTERN.test(combined)) {
    score += 2;
    reasons.push("具备写入文件能力且任务涉及文件");
  }
  if (agent.permissions.runCommands && COMMAND_PATTERN.test(combined)) {
    score += 2;
    reasons.push("具备运行命令能力且任务涉及命令或测试");
  }
  if (containsFolded(title, agent.role) || containsFolded(description, agent.role)) {
    score += 1;
    reasons.push(
      containsFolded(title, agent.role) ? "角色匹配任务标题" : "角色匹配任务说明",
    );
  }

  if (score <= 0) return null;
  return { reasons, score };
}

export function buildCapabilityInsight(
  input: CapabilityInsightInput,
): CapabilityInsight {
  const skillsById = new Map(input.skills.map((skill) => [skill.id, skill.name]));
  const portraits: CapabilityPortrait[] = [...input.agents]
    .sort((left, right) => compareId(left.id, right.id))
    .map((agent) => {
      const skillNames = skillNamesFor(agent, skillsById);
      return {
        agentId: agent.id,
        evidence: portraitEvidence(skillNames, agent),
        model: agent.model,
        name: agent.name,
        reviewCapable: agent.reviewCapable,
        skillNames,
        tools: {
          readFiles: agent.permissions.readFiles,
          runCommands: agent.permissions.runCommands,
          writeFiles: agent.permissions.writeFiles,
        },
      };
    });

  const suggestions: CapabilitySuggestion[] = [];
  for (const item of input.workItems) {
    if (!isUnassignedTodo(item)) continue;
    const ranked: CapabilitySuggestion[] = [];
    for (const agent of input.agents) {
      const scored = scoreAgent(
        agent,
        skillNamesFor(agent, skillsById),
        item.title,
        item.description,
      );
      if (!scored) continue;
      ranked.push({
        agentId: agent.id,
        reasons: scored.reasons,
        score: scored.score,
        workItemId: item.id,
      });
    }
    ranked.sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return compareId(left.agentId, right.agentId);
    });
    suggestions.push(...ranked.slice(0, MAX_SUGGESTIONS_PER_ITEM));
  }

  return { portraits, suggestions };
}
