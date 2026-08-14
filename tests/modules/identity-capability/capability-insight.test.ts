import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildCapabilityInsight } from "@/src/modules/identity-capability";
import type { CapabilityInsightInput } from "@/src/shared/capability-insight-contracts";

function agent(
  overrides: Partial<CapabilityInsightInput["agents"][number]> & {
    id: string;
    name: string;
  },
): CapabilityInsightInput["agents"][number] {
  return {
    model: "model-a",
    permissions: {
      readFiles: true,
      runCommands: false,
      writeFiles: false,
    },
    reviewCapable: false,
    role: "规划",
    skillIds: [],
    ...overrides,
  };
}

function workItem(
  overrides: Partial<CapabilityInsightInput["workItems"][number]> & {
    id: string;
    title: string;
  },
): CapabilityInsightInput["workItems"][number] {
  return {
    assigneeAgentId: null,
    description: "",
    status: "todo",
    ...overrides,
  };
}

describe("buildCapabilityInsight", () => {
  it("projects member portraits with skill names, tools, and config evidence only", () => {
    const insight = buildCapabilityInsight({
      agents: [
        agent({
          id: "agent-b",
          model: "model-b",
          name: "Builder",
          permissions: {
            readFiles: true,
            runCommands: true,
            writeFiles: true,
          },
          role: "实现",
          skillIds: ["skill-build"],
        }),
        agent({
          id: "agent-a",
          name: "Planner",
          reviewCapable: true,
          skillIds: ["skill-plan", "missing-skill"],
        }),
      ],
      skills: [
        { id: "skill-plan", name: "Plan" },
        { id: "skill-build", name: "Build" },
      ],
      workItems: [],
    });

    expect(insight.portraits).toEqual([
      {
        agentId: "agent-a",
        evidence: ["skill:Plan", "tool:readFiles", "review", "model"],
        model: "model-a",
        name: "Planner",
        reviewCapable: true,
        skillNames: ["Plan"],
        tools: {
          readFiles: true,
          runCommands: false,
          writeFiles: false,
        },
      },
      {
        agentId: "agent-b",
        evidence: [
          "skill:Build",
          "tool:readFiles",
          "tool:writeFiles",
          "tool:runCommands",
          "model",
        ],
        model: "model-b",
        name: "Builder",
        reviewCapable: false,
        skillNames: ["Build"],
        tools: {
          readFiles: true,
          runCommands: true,
          writeFiles: true,
        },
      },
    ]);
    expect(insight.suggestions).toEqual([]);
    expect(JSON.stringify(insight)).not.toMatch(/systemPrompt|apiKey|api_key/i);
  });

  it("scores unassigned todo items with deterministic weights, reasons, and ranking", () => {
    const insight = buildCapabilityInsight({
      agents: [
        agent({
          id: "agent-z",
          name: "Zero",
          permissions: {
            readFiles: true,
            runCommands: false,
            writeFiles: false,
          },
          role: "旁观",
        }),
        agent({
          id: "agent-r",
          name: "Reviewer",
          reviewCapable: true,
          role: "独立检查",
          skillIds: ["skill-plan"],
        }),
        agent({
          id: "agent-w",
          name: "Writer",
          permissions: {
            readFiles: true,
            runCommands: true,
            writeFiles: true,
          },
          role: "实现",
        }),
      ],
      skills: [{ id: "skill-plan", name: "Plan" }],
      workItems: [
        workItem({
          description: "需要检查并写入文件后运行测试",
          id: "item-open",
          title: "Plan the Café review",
        }),
        workItem({
          assigneeAgentId: "agent-r",
          id: "item-assigned",
          title: "Plan assigned work",
        }),
        workItem({
          id: "item-busy",
          status: "in_progress",
          title: "Plan in progress",
        }),
        workItem({
          assigneeAgentId: "",
          id: "item-empty-assignee",
          title: "无关标题",
        }),
      ],
    });

    expect(insight.suggestions.map((row) => row.workItemId)).toEqual([
      "item-open",
      "item-open",
    ]);
    expect(insight.suggestions).toEqual([
      {
        agentId: "agent-r",
        reasons: [
          "技能 Plan 匹配任务标题",
          "具备复核能力且任务涉及复核",
        ],
        score: 5,
        workItemId: "item-open",
      },
      {
        agentId: "agent-w",
        reasons: [
          "具备写入文件能力且任务涉及文件",
          "具备运行命令能力且任务涉及命令或测试",
        ],
        score: 4,
        workItemId: "item-open",
      },
    ]);
  });

  it("folds ASCII skill and role matches, omits non-positive scores, and keeps three suggestions", () => {
    const insight = buildCapabilityInsight({
      agents: [
        agent({
          id: "agent-d",
          name: "Delta",
          reviewCapable: true,
          role: "Planner",
        }),
        agent({
          id: "agent-c",
          name: "Charlie",
          reviewCapable: true,
          role: "Planner",
        }),
        agent({
          id: "agent-b",
          name: "Bravo",
          reviewCapable: true,
          role: "Planner",
        }),
        agent({
          id: "agent-a",
          name: "Alpha",
          reviewCapable: true,
          role: "Planner",
          skillIds: ["skill-cafe"],
        }),
      ],
      skills: [{ id: "skill-cafe", name: "Café" }],
      workItems: [
        workItem({
          description: "Ask the planner to review this",
          id: "item-fold",
          title: "cafe check",
        }),
      ],
    });

    expect(insight.suggestions).toEqual([
      {
        agentId: "agent-a",
        reasons: [
          "技能 Café 匹配任务标题",
          "具备复核能力且任务涉及复核",
          "角色匹配任务说明",
        ],
        score: 6,
        workItemId: "item-fold",
      },
      {
        agentId: "agent-b",
        reasons: [
          "具备复核能力且任务涉及复核",
          "角色匹配任务说明",
        ],
        score: 3,
        workItemId: "item-fold",
      },
      {
        agentId: "agent-c",
        reasons: [
          "具备复核能力且任务涉及复核",
          "角色匹配任务说明",
        ],
        score: 3,
        workItemId: "item-fold",
      },
    ]);
  });

  it("does not open SQLite or mention work_items in Identity adapters", () => {
    const builder = readFileSync(
      join(process.cwd(), "src/modules/identity-capability/internal/capability-insight.ts"),
      "utf8",
    );
    expect(builder).not.toMatch(/node:sqlite|openDatabase|work_items/i);

    const identityRoot = join(
      process.cwd(),
      "src/adapters/outbound/sqlite/identity-capability",
    );
    for (const file of ["agent-service.ts", "skill-service.ts", "provider-service.ts"]) {
      expect(readFileSync(join(identityRoot, file), "utf8")).not.toMatch(/work_items/);
    }
  });
});
