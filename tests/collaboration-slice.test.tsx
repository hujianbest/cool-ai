import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/server/db";

type RouteContext = { params: Promise<{ projectId: string }> };
type CollaborationRoute = {
  GET: (request: Request, context: RouteContext) => Promise<Response>;
};
type RunRoute = {
  POST: (request: Request, context: RouteContext) => Promise<Response>;
};

let rootDirectory: string;
let databasePath: string;

beforeEach(() => {
  rootDirectory = mkdtempSync(join(tmpdir(), "cockpit-collaboration-slice-"));
  databasePath = join(rootDirectory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.COCKPIT_DB_PATH;
  rmSync(rootDirectory, { force: true, recursive: true });
});

async function collaborationRoute(): Promise<CollaborationRoute> {
  const routeId = "@/app/api/projects/[projectId]/collaboration/route";
  try {
    return (await import(/* @vite-ignore */ routeId)) as CollaborationRoute;
  } catch {
    expect.fail("The project collaboration read route is unavailable.");
  }
}

async function runRoute(): Promise<RunRoute> {
  const routeId = "@/app/api/projects/[projectId]/runs/route";
  try {
    return (await import(/* @vite-ignore */ routeId)) as RunRoute;
  } catch {
    expect.fail("The create-or-append collaboration route is unavailable.");
  }
}

async function collaborationPanel(): Promise<ComponentType<{ projectId: string }>> {
  const componentId = "@/components/collaboration/collaboration-panel";
  try {
    const module = (await import(/* @vite-ignore */ componentId)) as {
      CollaborationPanel: ComponentType<{ projectId: string }>;
    };
    return module.CollaborationPanel;
  } catch {
    expect.fail("The collaboration panel is unavailable.");
  }
}

function seedReadyProject(projectId = "project-1"): void {
  const database = openDatabase(databasePath);
  const timestamp = "2026-07-30T00:00:00.000Z";
  try {
    database
      .prepare(
        `INSERT INTO projects (
           id, name, created_at, workspace_path, workspace_key, version
         ) VALUES (?, 'Equal team', ?, 'D:\\workspace', 'd:/workspace', 1)`,
      )
      .run(projectId, timestamp);
    database
      .prepare(
        `INSERT INTO providers (
           id, name, base_url, default_model, api_key_cipher, api_key_iv,
           api_key_tag, credential_version, credential_generation, key_id,
           api_key_mask, verified_at, version, created_at, updated_at
         ) VALUES (
           'provider-1', 'Local', 'http://127.0.0.1:4000/v1', 'test-model',
           'cipher', 'iv', 'tag', 1, 1, 'key-1', '***', ?, 1, ?, ?
         )`,
      )
      .run(timestamp, timestamp, timestamp);
    const insertAgent = database.prepare(
      `INSERT INTO agents (
         id, name, role, system_prompt, provider_id, model, avatar_text,
         accent_token, can_read, can_write, can_execute, max_tokens,
         max_handoffs, version, created_at, updated_at
       ) VALUES (?, ?, 'Peer', 'Work as a peer.', 'provider-1', 'test-model',
         ?, 'sage', 1, 0, 0, 1000, 5, 1, ?, ?)`,
    );
    insertAgent.run("agent-b", "Beta", "B", timestamp, timestamp);
    insertAgent.run("agent-a", "Alpha", "A", timestamp, timestamp);
    const insertMember = database.prepare(
      `INSERT INTO project_memberships (project_id, agent_id, joined_at)
       VALUES (?, ?, ?)`,
    );
    insertMember.run(projectId, "agent-b", timestamp);
    insertMember.run(projectId, "agent-a", timestamp);
    database
      .prepare(
        `INSERT INTO missions (
           id, project_id, title, goal, version, created_at, updated_at
         ) VALUES ('mission-1', ?, 'Plan together', 'Produce a plan', 1, ?, ?)`,
      )
      .run(projectId, timestamp, timestamp);
  } finally {
    database.close();
  }
}

async function postRun(projectId: string, body: Record<string, unknown>): Promise<Response> {
  const route = await runRoute();
  return route.POST(
    new Request(`http://localhost/api/projects/${projectId}/runs`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    { params: Promise.resolve({ projectId }) },
  );
}

function installRouteFetch(projectId: string) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const context = { params: Promise.resolve({ projectId }) };
    if (url.pathname === `/api/projects/${projectId}/collaboration`) {
      const route = await collaborationRoute();
      return route.GET(new Request(url, init), context);
    }
    if (url.pathname === `/api/projects/${projectId}/runs`) {
      const route = await runRoute();
      return route.POST(new Request(url, init), context);
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("collaboration T-1 vertical slice", () => {
  it("migrates a valid database to the necessary v4 collaboration facts", () => {
    const database = openDatabase(databasePath);
    try {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 5 });
      const tables = (
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'collaboration_%'
             ORDER BY name`,
          )
          .all() as Array<{ name: string }>
      ).map(({ name }) => name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "collaboration_events",
          "collaboration_messages",
          "collaboration_operations",
          "collaboration_project_sequences",
          "collaboration_runs",
        ]),
      );
    } finally {
      database.close();
    }
  });

  it("deduplicates create-or-append and preserves stable message/event sequences and first baton", async () => {
    seedReadyProject();
    const operationId = "00000000-0000-4000-8000-000000000001";
    const first = await postRun("project-1", {
      message: "Draft the release plan",
      operationId,
    });
    const firstBody = await first.json();
    const duplicate = await postRun("project-1", {
      message: "Draft the release plan",
      operationId,
    });
    const duplicateBody = await duplicate.json();

    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(201);
    expect(duplicateBody).toEqual(firstBody);
    expect(firstBody).toMatchObject({
      created: true,
      message: { content: "Draft the release plan", sequence: 1 },
      run: { currentAgentId: "agent-a", roundCount: 0, status: "running" },
    });

    const appended = await postRun("project-1", {
      message: "Include rollback criteria",
      operationId: "00000000-0000-4000-8000-000000000002",
    });
    expect(appended.status).toBe(200);
    expect(await appended.json()).toMatchObject({
      created: false,
      message: { sequence: 2 },
      run: { id: firstBody.run.id },
    });

    const database = openDatabase(databasePath);
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM collaboration_runs").get()).toEqual({
        count: 1,
      });
      expect(
        database.prepare("SELECT sequence FROM collaboration_messages ORDER BY sequence").all(),
      ).toEqual([{ sequence: 1 }, { sequence: 2 }]);
      expect(
        database.prepare("SELECT sequence, type FROM collaboration_events ORDER BY sequence").all(),
      ).toEqual([
        { sequence: 1, type: "run_started" },
        { sequence: 2, type: "owner_message" },
        { sequence: 3, type: "owner_message" },
      ]);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM collaboration_operations").get(),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }

    const read = await (await collaborationRoute()).GET(
      new Request("http://localhost/api/projects/project-1/collaboration"),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );
    expect(await read.json()).toMatchObject({
      projectMessagesPage: {
        items: [
          { content: "Draft the release plan", sequence: 1 },
          { content: "Include rollback criteria", sequence: 2 },
        ],
      },
      run: { id: firstBody.run.id },
      timelinePage: { items: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }] },
    });
  });

  it("renders route-backed loading, empty, and recoverable error states", async () => {
    seedReadyProject();
    const Panel = await collaborationPanel();
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const realFetch = installRouteFetch("project-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        await loadGate;
        return realFetch(input, init);
      }),
    );

    const loadingView = render(createElement(Panel, { projectId: "project-1" }));
    expect(screen.getByText("正在加载项目群聊…")).toBeInTheDocument();
    expect(screen.queryByText("尚无协作消息。")).not.toBeInTheDocument();
    releaseLoad();
    expect(await screen.findByText("尚无协作消息。")).toBeInTheDocument();
    loadingView.unmount();

    const routeFetch = installRouteFetch("project-1");
    let failOnce = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (failOnce) {
          failOnce = false;
          return Promise.resolve(
            Response.json(
              { error: { code: "STORAGE_UNAVAILABLE", message: "Storage unavailable." } },
              { status: 503 },
            ),
          );
        }
        return routeFetch(input, init);
      }),
    );
    const user = userEvent.setup();
    render(createElement(Panel, { projectId: "project-1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "服务暂时不可用，请稍后重试。",
    );
    await user.click(screen.getByRole("button", { name: "重试加载群聊" }));
    expect(await screen.findByText("尚无协作消息。")).toBeInTheDocument();
  });

  it("sends through the real route and reloads the persisted owner echo", async () => {
    seedReadyProject();
    installRouteFetch("project-1");
    const Panel = await collaborationPanel();
    const user = userEvent.setup();
    const firstView = render(createElement(Panel, { projectId: "project-1" }));
    await screen.findByText("尚无协作消息。");

    await user.type(screen.getByLabelText("发送给项目群聊"), "Ship the smallest useful plan");
    await user.click(screen.getByRole("button", { name: "发送并启动协作" }));
    expect(await screen.findByText("Ship the smallest useful plan")).toBeInTheDocument();
    firstView.unmount();

    render(createElement(Panel, { projectId: "project-1" }));
    expect(await screen.findByText("Ship the smallest useful plan")).toBeInTheDocument();
  });
});
