import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function TypeScriptFiles(relativeDirectory: string): string[] {
  const directory = resolve(process.cwd(), relativeDirectory);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => resolve(entry.parentPath, entry.name));
}

describe("mission workflow architecture boundaries", () => {
  it("keeps runtime Mission code independent from migrations and Review internals", () => {
    const missionSources = [
      "src/adapters/outbound/sqlite/mission-work/mission-service.ts",
      "src/adapters/outbound/sqlite/mission-work/sqlite-mission-command-capability.ts",
      "src/modules/mission-work/public/commands.ts",
      "src/modules/mission-work/public/dto.ts",
      "src/modules/mission-work/public/errors.ts",
      "src/modules/mission-work/public/queries.ts",
    ].map(source);

    for (const missionSource of missionSources) {
      expect(missionSource).not.toMatch(/from\s+["'][^"']*migrations(?:-v\d+)?["']/u);
      expect(missionSource).not.toMatch(/from\s+["'][^"']*\/review\//u);
      expect(missionSource).not.toContain("initializeMissionDeliveryTx");
    }
  });

  it("keeps Workflow and public capabilities free of SQLite details", () => {
    const workflow = source("src/server/application/create-mission-workflow.ts");
    expect(workflow).toContain("@/src/application/unit-of-work");
    expect(workflow).toContain("@/src/modules/mission-work");
    expect(workflow).toContain("@/src/modules/review-delivery");
    expect(workflow).not.toMatch(/storage\/sqlite|node:sqlite|DatabaseSync|\.prepare\(/u);

    for (const publicBoundary of [
      source("src/application/transaction-context.ts"),
      source("src/application/unit-of-work.ts"),
      source("src/modules/mission-work/public/commands.ts"),
      source("src/modules/mission-work/public/dto.ts"),
      source("src/modules/mission-work/public/errors.ts"),
      source("src/modules/mission-work/public/queries.ts"),
      source("src/modules/review-delivery/public/commands.ts"),
      source("src/modules/review-delivery/public/dto.ts"),
      source("src/modules/review-delivery/public/errors.ts"),
      source("src/modules/review-delivery/public/queries.ts"),
    ]) {
      expect(publicBoundary).not.toMatch(/node:sqlite|DatabaseSync|\.prepare\(|\b(?:SELECT|INSERT|UPDATE|DELETE)\b/u);
    }
  });

  it("keeps the shared current fixture technical and fact-free", () => {
    const fixture = source("tests/fixtures/sqlite/current-database.ts");
    expect(fixture).toContain("export function openEmptyCurrentDatabase");
    expect(fixture.match(/\bexport\b/gu)).toHaveLength(1);
    expect(fixture).toContain("openDatabase(databasePath)");
    expect(fixture).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b|missions|review_events/iu);
  });
});

describe("current schema Contract boundaries", () => {
  it("keeps current product architecture aligned with the pre-release canonical policy", () => {
    const architecture = source("product/architecture.md");
    expect(architecture).not.toMatch(
      /src\/server\/migrations-v[78]\.ts|tests\/migrations-v[78][^`\s]*\.test\.ts/u,
    );
    expect(architecture).not.toContain("每一步都必须保持旧数据可迁移");
    expect(architecture).toContain("0003-pre-release-canonical-database-schema");
    expect(architecture).toContain("fresh bootstrap");
    expect(architecture).toContain("exact reopen");
  });

  it("has no historical migration modules, fixtures, or upgrade-only tests", () => {
    const forbidden = [
      "src/server/migrations.ts",
      "src/server/migrations-v5.ts",
      "src/server/migrations-v6.ts",
      "src/server/migrations-v7.ts",
      "src/server/migrations-v8.ts",
      "tests/v6-fixture-db.ts",
      "tests/v7-fixture-graph.ts",
      "tests/persistent-threads-v6-fixture.ts",
      "tests/structured-messages-browser-fixture.ts",
      "tests/context-migrations.test.ts",
      "tests/migrations-v4.test.ts",
      "tests/migrations-v5.test.ts",
      "tests/migrations-v6.test.ts",
      "tests/migrations-v7-complete.test.ts",
      "tests/migrations-v8-contract.test.ts",
      "tests/migrations.test.ts",
      "tests/v6-fixture-db.test.ts",
    ];
    expect(forbidden.filter((path) => existsSync(resolve(process.cwd(), path)))).toEqual([]);
  });

  it("keeps CURRENT_SCHEMA as the only production DDL source", () => {
    const serverFiles = TypeScriptFiles("src");
    const migrationImports = serverFiles.filter((path) =>
      /from\s+["'][^"']*migrations(?:-v\d+)?["']|migrateDatabase/u.test(
        readFileSync(path, "utf8"),
      ));
    expect(migrationImports).toEqual([]);

    const ddlSources = serverFiles.filter((path) =>
      /\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\b/iu.test(
        readFileSync(path, "utf8"),
      ));
    expect(ddlSources).toEqual([
      resolve(process.cwd(), "src/adapters/outbound/sqlite/current-schema.ts"),
    ]);
    expect(source("src/adapters/outbound/sqlite/current-schema.ts")).not.toContain(
      "CURRENT_IDENTITY",
    );
  });
});
