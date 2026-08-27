// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PolicyTerminalSurface } from "@/components/execution/policy-terminal-surface";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("policy terminal and local preview", () => {
  it("runs a frozen command, reads labeled output, stops it, and opens only the server URL", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    vi.stubGlobal("open", open);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/policy-commands")) {
        return Response.json({
          commands: [{
            args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", "4173"],
            entryId: "entry-preview",
            executable: "npm.exe",
            network: "loopback_only",
            openPath: "/",
            port: 4173,
            purpose: "preview",
            required: false,
            timeoutSeconds: 600,
            workdir: ".",
          }],
          currentProcess: null,
          executionId: "execution",
          executionVersion: 4,
          policyRevisionId: "revision-3",
          projectId: "project",
        });
      }
      if (url.pathname.endsWith("/policy-processes") && init?.method === "POST") {
        return Response.json({
          authorizationSource: "standing_policy",
          exitCode: null,
          id: "process",
          previewUrl: null,
          reasonCode: null,
          status: "running",
          stderr: { bytes: 0, text: "", truncated: false },
          stdout: { bytes: 0, text: "", truncated: false },
          version: 2,
        }, { status: 201 });
      }
      if (url.pathname.endsWith("/output")) {
        return Response.json({
          status: "ready",
          stderr: { chunks: [{ cursor: 0, text: "warning" }], nextCursor: 1 },
          stdout: { chunks: [{ cursor: 0, text: "ready in 842ms" }], nextCursor: 1 },
        });
      }
      if (url.pathname.endsWith("/policy-processes/process")) {
        return Response.json({
          authorizationSource: "standing_policy",
          exitCode: null,
          id: "process",
          previewUrl: "http://127.0.0.1:4173/",
          reasonCode: null,
          status: "ready",
          stderr: { bytes: 7, text: "warning", truncated: false },
          stdout: { bytes: 14, text: "ready in 842ms", truncated: false },
          version: 3,
        });
      }
      if (url.pathname.endsWith("/stop")) {
        return Response.json({
          id: "process",
          previewUrl: null,
          status: "stopping",
          version: 4,
        });
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    }));

    render(<PolicyTerminalSurface
      executionId="execution"
      executionRunnable
      executionVersion={4}
      taskTitle="重构 auth.ts"
    />);

    await user.click(screen.getByRole("button", { name: "终端与预览" }));
    expect(await screen.findByRole("option", { name: /npm\.exe run dev/ })).toBeInTheDocument();
    expect(screen.getByText("冻结政策 revision-3")).toBeInTheDocument();
    expect(screen.getByText("仅本机 · 端口 4173 · 超时 10 分钟")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("C:/");

    await user.click(screen.getByRole("button", { name: "运行策略命令" }));
    expect(await screen.findByText("stdout · ready in 842ms")).toBeInTheDocument();
    expect(screen.getByText("stderr · warning")).toBeInTheDocument();
    const preview = await screen.findByRole("button", { name: "打开本地预览" });
    await user.click(preview);
    expect(open).toHaveBeenCalledWith(
      "http://127.0.0.1:4173/",
      "_blank",
      "noopener,noreferrer",
    );

    await user.click(screen.getByRole("button", { name: "停止进程" }));
    await waitFor(() => expect(screen.getByText("正在停止")).toBeInTheDocument());
  });

  it("uses a structured one-shot request without exposing a shell line", async () => {
    const user = userEvent.setup();
    let requestBody: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/policy-commands")) {
        return Response.json({
          commands: [{
            args: ["test"],
            entryId: "entry",
            executable: "npm.exe",
            network: null,
            openPath: null,
            port: null,
            purpose: "validation",
            required: true,
            timeoutSeconds: 120,
            workdir: ".",
          }],
          currentProcess: null,
          executionId: "execution",
          executionVersion: 4,
          policyRevisionId: "revision",
          projectId: "project",
        });
      }
      if (url.pathname.endsWith("/policy-processes") && init?.method === "POST") {
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({
          approvalId: "approval",
          decision: "one_shot",
          reasonCode: null,
        });
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    render(<PolicyTerminalSurface
      executionId="execution"
      executionRunnable
      executionVersion={4}
      taskTitle="结构化命令"
    />);

    await user.click(screen.getByRole("button", { name: "终端与预览" }));
    await screen.findByRole("option", { name: "npm.exe test" });
    await user.click(screen.getByRole("button", { name: "申请单次命令" }));
    expect(screen.queryByLabelText("shell")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("参数（每行一个，不经过 shell）"), "run{enter}lint");
    await user.clear(screen.getByLabelText("相对工作目录"));
    await user.type(screen.getByLabelText("相对工作目录"), "packages/app");
    await user.click(screen.getByRole("button", { name: "提交审批" }));

    expect(await screen.findByText(/已送审批中心/)).toBeInTheDocument();
    expect(requestBody).toMatchObject({
      command: {
        args: ["run", "lint"],
        executable: "npm.exe",
        workdir: "packages/app",
      },
      expectedExecutionVersion: 4,
    });
  });
});
