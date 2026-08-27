import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-21T08:00:00.000Z";
const CIPHER = "CIPHER-SECRET-LEAK-MARKER";
const PROMPT = "PRIVATE-PROMPT-LEAK";
const HOST_PATH = "D:\\export-leak-workspace";

type RedactedExportDto = {
  contentHash: string;
  events: unknown[];
  exportedAt: string;
  formatVersion: 1;
  messages: unknown[];
  scope: {
    detail: string;
    projectId: string;
    threadId: string | null;
  };
};

type ExportModule = {
  getRedactedExport(
    databasePath: string,
    projectId: string,
    options?: { now?: string; threadId?: string },
  ): RedactedExportDto;
};

const exportModules = import.meta.glob<ExportModule>(
  "../../../src/adapters/outbound/sqlite/operations-projection/redacted-export.ts",
);

async function exportService(): Promise<ExportModule> {
  const load = exportModules[
    "../../../src/adapters/outbound/sqlite/operations-projection/redacted-export.ts"
  ];
  expect(load, "the redacted export query must exist").toBeTypeOf("function");
  return load();
}

describe("redacted export", () => {
  it("returns a versioned project-scoped package with a content hash", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Export A", databasePath);
    const other = createProject("Export B", databasePath);
    const service = await exportService();
    const pack = service.getRedactedExport(databasePath, project.id, { now: NOW });
    expect(pack).toMatchObject({
      exportedAt: NOW,
      formatVersion: 1,
      messages: [],
      scope: { detail: "当前项目", projectId: project.id, threadId: null },
    });
    expect(pack.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(pack.events.length).toBeGreaterThan(0);
    expect(service.getRedactedExport(databasePath, other.id, { now: NOW }).scope.projectId).toBe(
      other.id,
    );
    expect(() => service.getRedactedExport(databasePath, "missing-project", { now: NOW }))
      .toThrowError(/Project was not found/u);
  });

  it("hashes canonical JSON and omits credentials, host paths, and hidden prompts", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Export Secrets", databasePath);
    const database = openDatabase(databasePath);
    try {
      database.exec(`
        UPDATE projects SET workspace_path='${HOST_PATH.replaceAll("\\", "\\\\")}',
          workspace_key='export-leak-key' WHERE id='${project.id}';
        INSERT INTO providers (
          id, name, base_url, default_model, api_key_cipher, api_key_iv,
          api_key_tag, credential_version, credential_generation, key_id,
          api_key_mask, verified_at, version, created_at, updated_at
        ) VALUES (
          'provider-export', 'Local', 'http://127.0.0.1:4000/v1', 'model',
          '${CIPHER}', 'i', 't', 1, 1, 'k', '***', '${NOW}', 1, '${NOW}', '${NOW}'
        );
        INSERT INTO agents (
          id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
          can_read, can_write, can_execute, max_tokens, max_handoffs, version, created_at, updated_at
        ) VALUES (
          'agent-export', 'Alpha', '规划', '${PROMPT}',
          'provider-export', 'model', 'A', 'sage', 1, 1, 0, 1000, 5, 1, '${NOW}', '${NOW}'
        );
      `);
    } finally {
      database.close();
    }

    const service = await exportService();
    const pack = service.getRedactedExport(databasePath, project.id, { now: NOW });
    const serialized = JSON.stringify(pack);
    expect(pack.events.some((event) => (
      typeof event === "object"
      && event !== null
      && "eventType" in event
      && event.eventType === "project_created"
    ))).toBe(true);
    expect(serialized).not.toContain(CIPHER);
    expect(serialized).not.toContain(PROMPT);
    expect(serialized).not.toContain("export-leak-workspace");
    const { contentHash, ...unsigned } = pack;
    const canonical = canonicalize(unsigned);
    expect(canonical).toBeTypeOf("string");
    expect(contentHash).toBe(createHash("sha256").update(canonical ?? "", "utf8").digest("hex"));
  });
});
