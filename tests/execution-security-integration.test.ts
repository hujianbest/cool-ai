import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  callOpenAiChat,
  OPENAI_CHAT_TIMEOUT_MILLISECONDS,
} from "@/src/server/collaboration/openai-chat-client";
import {
  classifyExecutionCommand,
  classifyPolicyEntry,
  commandTupleHash,
} from "@/src/server/execution/command-policy";
import { runDirectProcess } from "@/src/server/execution/process-runner";
import { preflightSandbox } from "@/src/server/execution/sandbox-preflight";
import { buildSandboxSnapshot } from "@/src/server/execution/sandbox-snapshot";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(
    (server) => new Promise<void>((done) => server.close(() => done())),
  ));
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `cool-ai-t31-${label}-`));
  roots.push(root);
  return root;
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("execution security integration", () => {
  it("keeps two real sandboxes isolated while a real harmless process changes only one", async () => {
    const root = temporaryRoot("sandboxes");
    const canonical = join(root, "canonical");
    const managed = join(root, "managed");
    const sandboxA = join(managed, "project", "execution-a", "1", "sandbox");
    const sandboxB = join(managed, "project", "execution-b", "1", "sandbox");
    mkdirSync(join(canonical, "src"), { recursive: true });
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(canonical, "src", "shared.txt"), "canonical");
    writeFileSync(join(canonical, ".env"), "TOP_LEVEL_SECRET=do-not-copy");
    writeFileSync(join(canonical, "src", "private.pem"), "PEM-SECRET");

    const preflight = await preflightSandbox({
      canonicalRoot: canonical,
      managedSandboxRoot: managed,
    });
    await Promise.all([
      buildSandboxSnapshot({ preflight, sandboxRoot: sandboxA, sourceRoot: canonical }),
      buildSandboxSnapshot({ preflight, sandboxRoot: sandboxB, sourceRoot: canonical }),
    ]);

    const script = join(sandboxA, "change-one.mjs");
    writeFileSync(script, `
      import { writeFileSync } from "node:fs";
      writeFileSync(new URL("./src/shared.txt", import.meta.url), "execution-a");
      process.stdout.write(JSON.stringify({cwd:process.cwd(),env:process.env}));
    `);
    const result = await runDirectProcess({
      args: [script],
      authorizationSource: "standing_policy",
      executable: process.execPath,
      heartbeat: () => true,
      sandboxRoot: sandboxA,
      workdir: ".",
    });

    expect(result.status).toBe("completed");
    expect(readFileSync(join(sandboxA, "src", "shared.txt"), "utf8")).toBe("execution-a");
    expect(readFileSync(join(sandboxB, "src", "shared.txt"), "utf8")).toBe("canonical");
    expect(readFileSync(join(canonical, "src", "shared.txt"), "utf8")).toBe("canonical");
    for (const sandbox of [sandboxA, sandboxB]) {
      expect(existsSync(join(sandbox, ".env"))).toBe(false);
      expect(existsSync(join(sandbox, "src", "private.pem"))).toBe(false);
    }
    const child = JSON.parse(result.stdout.chunks.map((chunk) => chunk.text).join("")) as {
      cwd: string;
      env: Record<string, string>;
    };
    expect(resolve(child.cwd)).toBe(resolve(sandboxA));
    expect(child.env.PATH ?? "").toBe("");
    expect(child.env.PATHEXT ?? "").toBe("");
    expect(child.env.COMSPEC ?? "").toBe("");
    expect(child.env).not.toHaveProperty("COCKPIT_MASTER_KEY");
  });

  it("fails a verified-handle replacement race without copying replacement bytes", async () => {
    const root = temporaryRoot("handle-race");
    const canonical = join(root, "canonical");
    const managed = join(root, "managed");
    const sandbox = join(managed, "project", "execution", "1", "sandbox");
    const source = join(canonical, "src", "safe.txt");
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(managed, { recursive: true });
    writeFileSync(source, "safe");
    const preflight = await preflightSandbox({
      canonicalRoot: canonical,
      managedSandboxRoot: managed,
    });

    await expect(buildSandboxSnapshot({
      hooks: {
        onPhase(phase, path) {
          if (phase === "before-source-open" && path === "src/safe.txt") {
            rmSync(source);
            writeFileSync(source, "replacement-secret");
          }
        },
      },
      preflight,
      sandboxRoot: sandbox,
      sourceRoot: canonical,
    })).rejects.toMatchObject({ code: "SANDBOX_SOURCE_MISMATCH" });
    expect(existsSync(sandbox)).toBe(false);
  });

  it("uses real local OpenAI-compatible HTTP concurrently without leaking secrets into bodies or logs", async () => {
    const captures: Array<{ authorization: string; body: string }> = [];
    const server = createServer(async (request, response) => {
      captures.push({
        authorization: String(request.headers.authorization),
        body: await requestBody(request),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          summary: "Business result first.",
          action: { type: "staged" },
        }) } }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      }));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind.");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const forbidden = [
      "provider-key-a",
      "provider-key-b",
      "master-key-marker",
      "cipher-marker",
      "Authorization:",
      "D:\\canonical-secret",
      "raw-environment-marker",
      "hidden-chain-of-thought",
    ];

    const results = await Promise.all([
      callOpenAiChat({
        apiKey: "provider-key-a",
        baseUrl,
        messages: [{ role: "user", content: "Agent A public task." }],
        model: "local-model",
      }, { attemptId: "attempt-a", correlationId: "correlation-a", runId: "execution-a" }),
      callOpenAiChat({
        apiKey: "provider-key-b",
        baseUrl,
        messages: [{ role: "user", content: "Agent B public task." }],
        model: "local-model",
      }, { attemptId: "attempt-b", correlationId: "correlation-b", runId: "execution-b" }),
    ]);

    expect(results.map((result) => result.status)).toEqual(["succeeded", "succeeded"]);
    expect(captures).toHaveLength(2);
    expect(new Set(captures.map(({ authorization }) => authorization))).toEqual(
      new Set(["Bearer provider-key-a", "Bearer provider-key-b"]),
    );
    const modelBodies = captures.map(({ body }) => body).join("\n");
    const publicResultsAndLogs = JSON.stringify({
      logs: consoleSpy.mock.calls,
      results,
    });
    for (const secret of forbidden) {
      expect(modelBodies).not.toContain(secret);
      expect(publicResultsAndLogs).not.toContain(secret);
    }
    expect(OPENAI_CHAT_TIMEOUT_MILLISECONDS).toBe(90_000);
  });

  it("distinguishes standing exact, one-shot near matches, and known mechanical denies", () => {
    const context = {
      canonicalRoot: process.platform === "win32" ? "D:/canonical" : "/canonical",
      executionRoot: process.platform === "win32" ? "D:/managed" : "/managed",
      platform: process.platform === "win32" ? "win32" as const : "posix" as const,
      sandboxRoot: process.platform === "win32"
        ? "D:/managed/project/execution/1/sandbox"
        : "/managed/project/execution/1/sandbox",
    };
    const exact = {
      args: ["--version"],
      executable: process.execPath,
      executableIdentity: "a".repeat(64),
      workdir: ".",
    };
    const standing = {
      ...exact,
      required: true,
      tupleHash: commandTupleHash({ ...exact, required: true }),
    };
    expect(classifyPolicyEntry(exact, context).decision).toBe("standing_eligible");
    expect(classifyExecutionCommand(exact, [standing], context).decision).toBe("standing_exact");
    expect(classifyExecutionCommand(
      { ...exact, args: ["--help"] },
      [standing],
      context,
    ).decision).toBe("one_shot");
    expect(classifyExecutionCommand(
      { ...exact, args: ["push"], executable: "git" },
      [],
      context,
    )).toMatchObject({ code: "DEPLOY_PUBLISH_PUSH_DENIED", decision: "deny" });
  });
});
