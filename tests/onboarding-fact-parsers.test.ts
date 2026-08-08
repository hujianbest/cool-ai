import { describe, expect, it } from "vitest";

import * as onboardingComponents from "@/components/onboarding-guide";
import * as onboardingMachine from "@/src/shared/onboarding-guide-machine";

const timestamp = "2026-08-08T00:00:00.000Z";
const projectId = "project-1";
const threadId = "thread-1";

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
  threadId,
  updatedAt: timestamp,
  version: 1,
};

const previousRun = {
  ...run,
  id: "run-previous",
  status: "stopped",
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
  projectId,
  runId: run.id,
  sequence: 1,
  threadId,
};

const projectOnlyMessage = {
  ...ownerMessage,
  content: "Project-only owner note",
  id: "message-project-only",
  runId: null,
  sequence: 2,
};

const previousRunMessage = {
  ...ownerMessage,
  content: "Previous run owner message",
  id: "message-previous",
  runId: previousRun.id,
  sequence: 3,
};

const thread = {
  availability: "ready",
  createdAt: timestamp,
  id: threadId,
  lastActivitySequence: 7,
  policy: {
    availability: "ready",
    createdAt: timestamp,
    members: [
      {
        agentId: agent.id,
        displayNameSnapshot: agent.name,
        live: "current",
        position: 0,
      },
      {
        agentId: "agent-2",
        displayNameSnapshot: "Reviewer",
        live: "current",
        position: 1,
      },
    ],
    revisionId: "revision-1",
    unavailableMemberIds: [],
    version: 1,
  },
  policyVersion: 1,
  projectId,
  title: "Onboarding thread",
  updatedAt: timestamp,
  version: 1,
};

function messageFact(
  message: typeof ownerMessage,
  sequence: number,
) {
  return {
    activitySequence: sequence + 2,
    actorId: null,
    actorType: "owner",
    createdAt: timestamp,
    id: `fact-${message.id}`,
    message,
    messageId: message.id,
    payload: { messageId: message.id },
    policyRevisionId: null,
    projectId,
    runEventId: null,
    runId: message.runId,
    sequence,
    threadId,
    type: "owner_message",
  };
}

const runLinkedFact = {
  activitySequence: 1,
  actorId: null,
  actorType: "system",
  createdAt: timestamp,
  id: "fact-run-linked",
  message: null,
  messageId: null,
  payload: { runId: run.id },
  policyRevisionId: null,
  projectId,
  runEventId: null,
  runId: run.id,
  sequence: 1,
  threadId,
  type: "run_linked",
};

const runStartedFact = {
  activitySequence: 2,
  actorId: null,
  actorType: "system",
  createdAt: timestamp,
  id: "fact-run-started",
  message: null,
  messageId: null,
  payload: { eventType: "run_started" },
  policyRevisionId: null,
  projectId,
  runEventId: "event-1",
  runId: run.id,
  sequence: 2,
  threadId,
  type: "run_event",
};

function collaboration(overrides: Record<string, unknown> = {}) {
  return {
    activeRun: { runId: "other-run", threadId: "other-thread" },
    factsPage: {
      items: [
        runLinkedFact,
        runStartedFact,
        messageFact(ownerMessage, 3),
        messageFact(projectOnlyMessage, 4),
        messageFact(previousRunMessage, 5),
      ],
      nextAfter: null,
    },
    messagesPage: {
      items: [ownerMessage, projectOnlyMessage, previousRunMessage],
      nextAfter: null,
    },
    readiness: {
      dispatch: "project_run_active",
      missingProjectFacts: [],
      selectedMemberId: agent.id,
    },
    runs: [run, previousRun],
    selectedRun: run,
    thread,
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

  it("accepts one thread's explicit selected run, legal multi-run history, project-only messages, and cross-thread active tuple", () => {
    expect(onboardingMachine).toHaveProperty(
      "parseCollaborationGuideEnvelope",
      expect.any(Function),
    );
    const parse = (
      onboardingMachine as unknown as {
        parseCollaborationGuideEnvelope: (
          value: unknown,
          expectedProjectId: string,
          expectedThreadId: string,
          expectedRunId: string | null,
        ) => { kind: string; started?: boolean };
      }
    ).parseCollaborationGuideEnvelope;
    expect(parse(collaboration(), projectId, threadId, run.id)).toEqual({
      kind: "success",
      started: true,
    });
    expect(
      parse(
        collaboration({ selectedRun: null }),
        projectId,
        threadId,
        null,
      ),
    ).toEqual({ kind: "success", started: false });
  });

  it("fails collaboration facts closed for malformed, extra, unknown, and cross-tuple data", () => {
    const parse = onboardingMachine.parseCollaborationGuideEnvelope as (
      value: unknown,
      expectedProjectId: string,
      expectedThreadId: string,
      expectedRunId: string | null,
    ) => { kind: string };
    for (const malformed of [
      omit(collaboration(), "factsPage"),
      { ...collaboration(), extra: true },
      collaboration({ thread: { ...thread, projectId: "other-project" } }),
      collaboration({ runs: [{ ...run, threadId: "other-thread" }, previousRun] }),
      collaboration({ runs: [{ ...run, status: "unknown" }, previousRun] }),
      collaboration({ selectedRun: previousRun }),
      collaboration({
        messagesPage: {
          items: [{ ...ownerMessage, runId: "unknown-run" }],
          nextAfter: null,
        },
      }),
      collaboration({
        messagesPage: {
          items: [{ ...ownerMessage, projectId: "other-project" }],
          nextAfter: null,
        },
      }),
      collaboration({
        factsPage: {
          items: [{ ...runLinkedFact, runId: "unknown-run" }],
          nextAfter: null,
        },
      }),
      collaboration({
        factsPage: {
          items: [
            {
              ...messageFact(ownerMessage, 3),
              message: { ...ownerMessage, threadId: "other-thread" },
            },
          ],
          nextAfter: null,
        },
      }),
      collaboration({
        activeRun: { runId: "other-run", threadId: "other-thread", extra: true },
      }),
      collaboration({
        activeRun: { runId: "unknown-run", threadId },
      }),
      collaboration({
        factsPage: {
          items: [{ ...runStartedFact, payload: { eventType: "unknown" } }],
          nextAfter: null,
        },
      }),
      collaboration({
        messagesPage: { items: ownerMessage, nextAfter: null },
      }),
    ]) {
      expect(parse(malformed, projectId, threadId, run.id)).toEqual({
        kind: "invalid",
      });
    }
  });
});
