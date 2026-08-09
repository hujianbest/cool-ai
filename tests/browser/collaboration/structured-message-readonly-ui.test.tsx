// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StructuredMessageBlock } from "@/components/collaboration/structured-message-block";
import type { TranscriptKnownBlock, TranscriptUnknownBlock } from "@/src/shared/transcript-model";

function readonlyBlock(
  kind: "diff_preview" | "file_reference" | "handoff_card",
): TranscriptKnownBlock {
  const id = `${kind}-1`;
  const sourceKind = kind === "handoff_card" ? "handoff" : kind === "file_reference"
    ? "artifact"
    : "execution";
  return {
    actorLabel: "Alpha",
    blockRevision: 1,
    blockSchemaVersion: 1,
    executable: false,
    ...(kind === "file_reference" ? { fileName: "frozen-safe-name.txt" } : {}),
    id,
    kind,
    payload: {
      blockRevision: 1,
      blockSchemaVersion: 1,
      blockType: kind,
      logicalBlockId: `logical-${id}`,
      ...(kind === "file_reference" ? { publicName: "frozen-safe-name.txt" } : {}),
      title: `${kind} title`,
    },
    position: 0,
    source: {
      entityVersion: `${kind}-version`,
      id: `${kind}-source`,
      kind: sourceKind,
      messageId: "message-1",
      projectId: "project-1",
      runId: "run-1",
      threadId: "thread-1",
    },
    sourceLabel: `${sourceKind} · ${kind}-source · ${kind}-version`,
    state: { stateVersion: 1, status: "read_only" },
    stateVersion: 1,
    title: `${kind} title`,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Diff/File/Handoff read-only public UI surface", () => {
  it("shows only a persisted redacted Diff projection and execution/Approval navigation", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({
      display: { preview: "@@ safe\\n-old\\n+new" },
      navigation: { executionId: "execution-1", sourceId: "diff_preview-source" },
      source: { id: "diff_preview-source", kind: "execution", version: "diff_preview-version" },
    }))));
    const user = userEvent.setup();
    render(
      <StructuredMessageBlock
        block={readonlyBlock("diff_preview")}
        targetKey="project-1|thread-1|run-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "加载 Diff Preview 安全来源" }));

    expect(await screen.findByText(/@@ safe/)).toBeVisible();
    expect(screen.getByText(/source version diff_preview-version/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /编辑|合入|批准/ })).toBeNull();
    expect(screen.getByRole("link", { name: "前往 execution execution-1" }))
      .toHaveAttribute("href", expect.stringContaining("#execution-execution-1-title"));
    expect(screen.getByRole("link", { name: "前往正式 Approval surface" }))
      .toHaveAttribute("href", expect.stringContaining("#execution-execution-1-title"));
  });

  it("opens File Reference only through controlled source navigation without exposing host paths", async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(Response.json({
      display: { hostPath: "D:\\private\\secret.txt", name: "safe-artifact.txt" },
      navigation: { executionId: "execution-file", sourceId: "file_reference-source" },
      source: {
        id: "file_reference-source",
        kind: "artifact",
        version: "file_reference-version",
      },
      }))
    );
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(
      <StructuredMessageBlock
        block={readonlyBlock("file_reference")}
        targetKey="project-1|thread-1|run-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "打开 File Reference 安全来源" }));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(await screen.findByText("safe-artifact.txt")).toBeVisible();
    expect(document.body.textContent).not.toContain("D:\\private");
    expect(screen.getByRole("link", { name: "在 execution 中查看 safe-artifact.txt" }))
      .toHaveAttribute("href", expect.stringContaining("execution-file"));
  });

  it("locks the frozen File Reference public name on the card without fetching the source", async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(Response.json({
        display: { hostPath: "D:\\private\\secret.txt", name: "frozen-safe-name.txt" },
        navigation: { executionId: "execution-file", sourceId: "file_reference-source" },
        source: {
          id: "file_reference-source",
          kind: "artifact",
          version: "file_reference-version",
        },
      }))
    );
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(
      <StructuredMessageBlock
        block={readonlyBlock("file_reference")}
        targetKey="project-1|thread-1|run-1"
      />,
    );

    expect(screen.getByText("frozen-safe-name.txt")).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("D:\\private");

    await user.click(screen.getByRole("button", { name: "打开 File Reference 安全来源" }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("D:\\private");
  });

  it("navigates Handoff to its canonical existing thread/run without creating facts or runs", async () => {
    const fetcher = vi.fn(() => Promise.resolve(Response.json({
      display: { fromAgentId: "agent-a", summary: "Continue review", toAgentId: "agent-b" },
      navigation: { runId: "run-1", sourceId: "handoff_card-source" },
      source: {
        id: "handoff_card-source",
        kind: "handoff",
        version: "handoff_card-version",
      },
    })));
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(
      <StructuredMessageBlock
        block={readonlyBlock("handoff_card")}
        targetKey="project-1|thread-1|run-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "加载 Handoff Card 安全来源" }));

    expect(await screen.findByText((_, element) =>
      element?.tagName === "P" && element.textContent?.includes("Continue review") === true
    )).toBeVisible();
    const link = screen.getByRole("link", { name: "查看既有 handoff 运行" });
    expect(link).toHaveAttribute(
      "href",
      "/projects/project-1?thread=thread-1&run=run-1",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("names each read-only region with its formal localized type and existing title", () => {
    vi.stubGlobal("fetch", vi.fn());
    const view = render(
      <StructuredMessageBlock
        block={readonlyBlock("diff_preview")}
        targetKey="project-1|thread-1|run-1"
      />,
    );
    expect(screen.getByRole("region", { name: "Diff Preview：diff_preview title" }))
      .toBeVisible();

    view.rerender(
      <StructuredMessageBlock
        block={readonlyBlock("file_reference")}
        targetKey="project-1|thread-1|run-1"
      />,
    );
    expect(screen.getByRole("region", { name: "File Reference：file_reference title" }))
      .toBeVisible();

    view.rerender(
      <StructuredMessageBlock
        block={readonlyBlock("handoff_card")}
        targetKey="project-1|thread-1|run-1"
      />,
    );
    expect(screen.getByRole("region", { name: "Handoff Card：handoff_card title" }))
      .toBeVisible();
  });

  it("marks the region busy with a live status while the source is pending and clears both on success", async () => {
    let resolveSource!: (response: Response) => void;
    const sourcePending = new Promise<Response>((resolve) => {
      resolveSource = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(() => sourcePending));
    const user = userEvent.setup();
    render(
      <StructuredMessageBlock
        block={readonlyBlock("diff_preview")}
        targetKey="project-1|thread-1|run-1"
      />,
    );
    const region = screen.getByRole("region", { name: /Diff Preview/ });
    expect(region).toHaveAttribute("aria-busy", "false");

    const loadButton = screen.getByRole("button", { name: "加载 Diff Preview 安全来源" });
    loadButton.focus();
    await user.keyboard("{Enter}");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("正在核对来源");
    expect(loadButton).toBeDisabled();

    resolveSource(Response.json({
      display: { preview: "@@ safe\n-old\n+new" },
      navigation: { executionId: "execution-1", sourceId: "diff_preview-source" },
      source: { id: "diff_preview-source", kind: "execution", version: "diff_preview-version" },
    }));
    await waitFor(() => expect(region).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByRole("status")).toHaveTextContent("来源已核对");
    expect(screen.getByText(/@@ safe/)).toBeVisible();
  });

  it("clears busy and announces the stable error when the source read fails", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({
      error: { code: "RESOURCE_NOT_FOUND", message: "gone" },
    }, { status: 404 }))));
    const user = userEvent.setup();
    render(
      <StructuredMessageBlock
        block={readonlyBlock("handoff_card")}
        targetKey="project-1|thread-1|run-1"
      />,
    );
    const region = screen.getByRole("region", { name: /Handoff Card/ });

    await user.click(screen.getByRole("button", { name: "加载 Handoff Card 安全来源" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("来源不可用");
    expect(region).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "加载 Handoff Card 安全来源" }))
      .toBeEnabled();
  });

  it("fails closed for unavailable sources and keeps unknown schemas non-executable", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({
      error: { code: "RESOURCE_NOT_FOUND", message: "private path D:\\secret" },
    }, { status: 404 }))));
    const user = userEvent.setup();
    const view = render(
      <StructuredMessageBlock
        block={readonlyBlock("diff_preview")}
        targetKey="project-1|thread-1|run-1"
      />,
    );
    await user.click(screen.getByRole("button", { name: "加载 Diff Preview 安全来源" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("来源不可用");
    expect(document.body.textContent).not.toContain("D:\\secret");
    expect(document.body.textContent).not.toMatch(/latest/i);

    const unknown: TranscriptUnknownBlock = {
      actorLabel: "Future",
      blockRevision: 2,
      blockSchemaVersion: 9,
      executable: false,
      id: "unknown-1",
      kind: "unknown",
      position: 0,
      source: readonlyBlock("diff_preview").source,
      sourceLabel: "execution · opaque · v9",
      stateVersion: 3,
    };
    view.rerender(
      <StructuredMessageBlock
        block={unknown}
        targetKey="project-1|thread-1|run-1"
      />,
    );
    expect(screen.getByRole("region", { name: "不支持的结构化消息" })).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
