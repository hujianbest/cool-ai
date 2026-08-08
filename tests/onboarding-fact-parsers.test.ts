import { describe, expect, it } from "vitest";

import * as onboardingComponents from "@/components/onboarding-guide";
import * as onboardingMachine from "@/src/shared/onboarding-guide-machine";

const timestamp = "2026-08-08T00:00:00.000Z";
const projectId = "project-1";

const provider = {
  apiKeyMask: "••••ABCD",
  baseUrl: "https://provider.test/v1",
  createdAt: timestamp,
  defaultModel: "model-a",
  id: "provider-1",
  name: "Primary",
  status: "verified",
  updatedAt: timestamp,
  verifiedAt: timestamp,
  version: 1,
};

const agent = {
  accentToken: "sage",
  avatarText: "B",
  createdAt: timestamp,
  id: "agent-1",
  maxHandoffs: 5,
  maxTokens: 8_000,
  model: "model-a",
  name: "Builder",
  permissions: {
    readFiles: true,
    runCommands: true,
    writeFiles: true,
  },
  providerId: provider.id,
  reviewCapable: false,
  role: "builder",
  skillIds: [],
  systemPrompt: "Private runtime instruction",
  updatedAt: timestamp,
  version: 1,
};

const mission = {
  createdAt: timestamp,
  goal: "Private mission body",
  id: "mission-1",
  projectId,
  title: "Release",
  updatedAt: timestamp,
  version: 1,
};

const run = {
  createdAt: timestamp,
  currentAgentId: agent.id,
  id: "run-1",
  pauseCategory: null,
  projectId,
  roundCount: 0,
  status: "running",
  updatedAt: timestamp,
  version: 1,
};

const ownerMessage = {
  authorAgentId: null,
  authorDisplayName: "项目所有者",
  authorType: "owner",
  content: "Private owner message",
  createdAt: timestamp,
  id: "message-1",
  mentionAgentId: null,
  mentionDisplayName: null,
  mentionMemberStatus: null,
  runId: run.id,
  sequence: 1,
};

const runStarted = {
  actorId: null,
  actorType: "system",
  createdAt: timestamp,
  id: "event-1",
  payload: {
    currentAgentId: agent.id,
    messageId: ownerMessage.id,
    messageSequence: ownerMessage.sequence,
  },
  runId: run.id,
  sequence: 1,
  type: "run_started",
};

const ownerMessageEvent = {
  actorId: null,
  actorType: "owner",
  createdAt: timestamp,
  id: "event-2",
  payload: {
    mentionAgentId: null,
    mentionDisplayName: null,
    messageId: ownerMessage.id,
    messageSequence: ownerMessage.sequence,
  },
  runId: run.id,
  sequence: 2,
  type: "owner_message",
};

function collaboration(overrides: Record<string, unknown> = {}) {
  return {
    pendingDecision: null,
    projectMessagesPage: { items: [ownerMessage], nextAfter: null },
    readiness: { missing: [], ready: true },
    run,
    timelinePage: {
      items: [runStarted, ownerMessageEvent],
      nextAfter: null,
    },
    usage: {
      byAgent: [],
      completionTokens: 0,
      promptTokens: 0,
      repairCalls: 0,
      totalTokens: 0,
      unreportedCalls: 0,
    },
    ...overrides,
  };
}

function omit(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([candidate]) => candidate !== key),
  );
}

describe("T-13 strict runtime fact envelope parsers", () => {
  it("fails Provider closed for duplicate IDs, missing keys, extra keys, and illegal status", () => {
    const parse = onboardingComponents.parseProviderGuideEnvelope;
    expect(parse({ providers: [provider] }).kind).toBe("success");
    for (const malformed of [
      { providers: [{ ...provider, status: "pending" }] },
      { providers: [omit(provider, "verifiedAt")] },
      { providers: [{ ...provider, apiKey: "must-not-enter-guide" }] },
      { providers: [provider, provider] },
      { providers: provider },
      { providers: [provider], extra: true },
    ]) {
      expect(parse(malformed).kind).toBe("invalid");
    }
  });

  it("fails Agent closed for malformed shape, enum, IDs, and Provider relationships", () => {
    const parse = onboardingComponents.parseAgentGuideEnvelopes;
    const providers = { providers: [provider] };
    expect(parse(providers, { agents: [agent] }).kind).toBe("project_pending");
    for (const malformed of [
      { agents: [omit(agent, "id")] },
      { agents: [{ ...agent, accentToken: "purple" }] },
      { agents: [{ ...agent, providerId: "missing-provider" }] },
      { agents: [{ ...agent, skillIds: ["duplicate", "duplicate"] }] },
      { agents: [{ ...agent, privateKey: "must-not-enter-guide" }] },
      { agents: [agent, agent] },
      { agents: agent },
      { agents: [agent], extra: true },
    ]) {
      expect(parse(providers, malformed).kind).not.toBe("project_pending");
    }
  });

  it("fails Project and Workspace closed for malformed envelopes and readiness fields", () => {
    const project = { createdAt: timestamp, id: projectId, name: "Project" };
    expect(onboardingMachine.parseProjectGuideEnvelope({ projects: [project] }).kind)
      .toBe("success");
    expect(
      onboardingMachine.parseWorkspaceGuideEnvelope({
        projectVersion: 2,
        workspace: { path: "D:\\workspace", status: "ready" },
      }).kind,
    ).toBe("success");
    for (const malformed of [
      { projects: [omit(project, "name")] },
      { projects: [{ ...project, status: "ready" }] },
      { projects: [{ ...project, id: "../project" }] },
      { projects: [project, project] },
      { projects: project },
      { projects: [project], extra: true },
    ]) {
      expect(onboardingMachine.parseProjectGuideEnvelope(malformed).kind).toBe(
        "invalid",
      );
    }
    for (const malformed of [
      { mission: omit(mission, "goal"), workItems: [] },
      { workspace: { path: "D:\\workspace", status: "ready" } },
      { projectVersion: 1, workspace: { status: "ready" } },
      { projectVersion: 1, workspace: { path: "relative", status: "ready" } },
      { projectVersion: 1, workspace: { path: "D:\\workspace", status: "pending" } },
      {
        projectVersion: 1,
        workspace: { path: "D:\\workspace", status: "ready", token: "secret" },
      },
    ]) {
      expect(onboardingMachine.parseWorkspaceGuideEnvelope(malformed).kind).toBe(
        "invalid",
      );
    }
  });

  it("exports a Mission parser that validates exact shape and project/work-item relationships", () => {
    expect(onboardingMachine).toHaveProperty(
      "parseMissionGuideEnvelope",
      expect.any(Function),
    );
    const parse = (
      onboardingMachine as unknown as {
        parseMissionGuideEnvelope: (
          value: unknown,
          expectedProjectId: string,
        ) => { kind: string };
      }
    ).parseMissionGuideEnvelope;
    expect(parse({ mission, workItems: [] }, projectId)).toEqual({
      kind: "success",
    });
    for (const malformed of [
      { mission: { ...mission, projectId: "other-project" }, workItems: [] },
      { mission: { ...mission, extra: true }, workItems: [] },
      { mission: { ...mission, version: 0 }, workItems: [] },
      { mission, workItems: {} },
      {
        mission,
        workItems: [
          {
            assigneeAgentId: null,
            createdAt: timestamp,
            dependencyIds: [],
            description: "Description",
            id: "work-1",
            missionId: "other-mission",
            status: "todo",
            title: "Work",
            updatedAt: timestamp,
            version: 1,
          },
        ],
      },
      {
        mission,
        workItems: [
          {
            assigneeAgentId: null,
            createdAt: timestamp,
            dependencyIds: [],
            description: "Description",
            id: "work-1",
            missionId: mission.id,
            status: "unknown",
            title: "Work",
            updatedAt: timestamp,
            version: 1,
          },
        ],
      },
      { mission: null, workItems: [{ id: "orphan" }] },
      { mission, workItems: [], goal: "must-not-enter-guide" },
    ]) {
      expect(parse(malformed, projectId)).toEqual({ kind: "invalid" });
    }
  });

  it("exports a Collaboration parser that validates exact shape, status, project/run, and owner timeline links", () => {
    expect(onboardingMachine).toHaveProperty(
      "parseCollaborationGuideEnvelope",
      expect.any(Function),
    );
    const parse = (
      onboardingMachine as unknown as {
        parseCollaborationGuideEnvelope: (
          value: unknown,
          expectedProjectId: string,
        ) => { kind: string; started?: boolean };
      }
    ).parseCollaborationGuideEnvelope;
    expect(parse(collaboration(), projectId)).toEqual({
      kind: "success",
      started: true,
    });
    for (const malformed of [
      omit(collaboration(), "usage"),
      { ...collaboration(), extra: true },
      collaboration({ run: { ...run, projectId: "other-project" } }),
      collaboration({ run: { ...run, status: "unknown" } }),
      collaboration({
        projectMessagesPage: {
          items: [{ ...ownerMessage, runId: "other-run" }],
          nextAfter: null,
        },
      }),
      collaboration({
        timelinePage: {
          items: [{ ...runStarted, runId: "other-run" }, ownerMessageEvent],
          nextAfter: null,
        },
      }),
      collaboration({
        timelinePage: {
          items: [
            {
              ...runStarted,
              payload: { ...runStarted.payload, messageId: "missing-message" },
            },
            ownerMessageEvent,
          ],
          nextAfter: null,
        },
      }),
      collaboration({
        timelinePage: {
          items: [{ ...runStarted, status: "illegal" }, ownerMessageEvent],
          nextAfter: null,
        },
      }),
      collaboration({ projectMessagesPage: { items: ownerMessage, nextAfter: null } }),
    ]) {
      expect(parse(malformed, projectId)).toEqual({ kind: "invalid" });
    }
  });
});
