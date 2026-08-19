// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

type PreviewProps = {
  filePath: string | null;
  projectId: string;
};

type PreviewModule = {
  WorkspaceFilePreview: ComponentType<PreviewProps>;
};

const previewModules = import.meta.glob<PreviewModule>(
  "../../../components/project-context/workspace-file-preview.tsx",
);

async function filePreview() {
  const load =
    previewModules["../../../components/project-context/workspace-file-preview.tsx"];
  expect(load, "the workspace file preview must exist").toBeTypeOf("function");
  return (await load()).WorkspaceFilePreview;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("workspace file preview", () => {
  it("shows guidance and does not fetch when no file is selected", async () => {
    const WorkspaceFilePreview = await filePreview();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkspaceFilePreview filePath={null} projectId="project-1" />);

    const region = screen.getByRole("region", { name: "文件预览" });
    expect(
      within(region).getByText("在文件树中选择文件即可预览。"),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders text previews with preserved whitespace, path header and metadata", async () => {
    const WorkspaceFilePreview = await filePreview();
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url === "/api/projects/project-1/workspace/file?path=docs%2Fnote.md") {
          return Response.json({
            content: "第一行\n  缩进保留\n第三行",
            kind: "text",
            lineCount: 3,
            sizeBytes: 2048,
            truncated: false,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const view = render(
      <WorkspaceFilePreview filePath="docs/note.md" projectId="project-1" />,
    );

    const region = await screen.findByRole("region", { name: "文件预览" });
    expect(within(region).getByText("docs/note.md")).toBeInTheDocument();
    expect(within(region).getByText("3 行 · 2 KiB")).toBeInTheDocument();
    const pre = view.container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe("第一行\n  缩进保留\n第三行");
    expect(requested).toEqual([
      "/api/projects/project-1/workspace/file?path=docs%2Fnote.md",
    ]);
  });

  it("shows a prominent truncation banner while still rendering the prefix", async () => {
    const WorkspaceFilePreview = await filePreview();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          content: "截断前缀内容",
          kind: "text",
          lineCount: 4200,
          sizeBytes: 700000,
          truncated: true,
        }),
      ),
    );

    const view = render(
      <WorkspaceFilePreview filePath="big.log" projectId="project-1" />,
    );

    const region = await screen.findByRole("region", { name: "文件预览" });
    expect(
      await within(region).findByRole("status"),
    ).toHaveTextContent("已截断（仅显示前 512KiB）");
    expect(within(region).getByText("4200 行 · 683.6 KiB")).toBeInTheDocument();
    expect(view.container.querySelector("pre")?.textContent).toBe(
      "截断前缀内容",
    );
  });

  it("renders supported images inline with an accessible file name and metadata", async () => {
    const WorkspaceFilePreview = await filePreview();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          contentType: "image/png",
          dataUrl: "data:image/png;base64,iVBORw0KGgo=",
          kind: "image",
          sizeBytes: 1536,
        }),
      ),
    );

    render(
      <WorkspaceFilePreview filePath="assets/logo.png" projectId="project-1" />,
    );

    const region = await screen.findByRole("region", { name: "文件预览" });
    const image = await within(region).findByRole("img", { name: "logo.png" });
    expect(image).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
    expect(
      within(region).getByText("image/png · 1.5 KiB"),
    ).toBeInTheDocument();
  });

  it("shows a downgrade placeholder for unsupported binary files", async () => {
    const WorkspaceFilePreview = await filePreview();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ kind: "binary-unsupported" })),
    );

    const view = render(
      <WorkspaceFilePreview filePath="dist/app.exe" projectId="project-1" />,
    );

    const region = await screen.findByRole("region", { name: "文件预览" });
    expect(
      await within(region).findByText("该文件类型不支持预览。"),
    ).toBeInTheDocument();
    expect(view.container.querySelector("pre")).toBeNull();
    expect(within(region).queryByRole("img")).toBeNull();
  });

  it("masks sensitive files without echoing any content fragment to the DOM", async () => {
    const WorkspaceFilePreview = await filePreview();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          content: "SECRET_VALUE",
          dataUrl: "data:image/png;base64,U0VDUkVU",
          kind: "sensitive-masked",
          sizeBytes: 12,
        }),
      ),
    );

    const view = render(
      <WorkspaceFilePreview filePath=".env" projectId="project-1" />,
    );

    const region = await screen.findByRole("region", { name: "文件预览" });
    expect(
      await within(region).findByText("敏感文件已遮蔽，内容不回显。"),
    ).toBeInTheDocument();
    expect(region.textContent).not.toContain("SECRET_VALUE");
    expect(region.textContent).not.toContain("U0VDUkVU");
    expect(view.container.querySelector("pre")).toBeNull();
    expect(view.container.querySelector("img")).toBeNull();
  });

  it("never flashes the previous file and ignores late stale responses when switching", async () => {
    const WorkspaceFilePreview = await filePreview();
    const deferred = () => {
      let resolve!: (response: Response) => void;
      const promise = new Promise<Response>((resolver) => {
        resolve = resolver;
      });
      return { promise, resolve };
    };
    const first = deferred();
    const second = deferred();
    const textPayload = (content: string) =>
      Response.json({
        content,
        kind: "text",
        lineCount: 1,
        sizeBytes: 10,
        truncated: false,
      });
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url === "/api/projects/project-1/workspace/file?path=a.txt") {
          return first.promise;
        }
        if (url === "/api/projects/project-1/workspace/file?path=b.txt") {
          return second.promise;
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const view = render(
      <WorkspaceFilePreview filePath="a.txt" projectId="project-1" />,
    );
    const region = await screen.findByRole("region", { name: "文件预览" });
    expect(within(region).getByText("a.txt")).toBeInTheDocument();

    view.rerender(
      <WorkspaceFilePreview filePath="b.txt" projectId="project-1" />,
    );
    expect(view.container.querySelector("pre")).toBeNull();
    expect(within(region).getByText("b.txt")).toBeInTheDocument();
    expect(within(region).getByText("正在加载预览…")).toHaveAttribute(
      "aria-busy",
      "true",
    );

    await act(async () => {
      second.resolve(textPayload("内容B"));
    });
    await waitFor(() =>
      expect(view.container.querySelector("pre")?.textContent).toBe("内容B"),
    );

    await act(async () => {
      first.resolve(textPayload("内容A"));
    });
    await waitFor(() => {
      expect(region.textContent).not.toContain("内容A");
    });
    expect(view.container.querySelector("pre")?.textContent).toBe("内容B");
    expect(requested).toEqual([
      "/api/projects/project-1/workspace/file?path=a.txt",
      "/api/projects/project-1/workspace/file?path=b.txt",
    ]);
  });

  it("shows a sanitized alert without the raw server message and retries", async () => {
    const WorkspaceFilePreview = await filePreview();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json(
            {
              error: {
                code: "WORKSPACE_PATH_REJECTED",
                message: "RAW SERVER MESSAGE D:\\secret",
              },
            },
            { status: 422 },
          );
        }
        return Response.json({
          content: "重试后的内容",
          kind: "text",
          lineCount: 1,
          sizeBytes: 6,
          truncated: false,
        });
      }),
    );
    const user = userEvent.setup();

    const view = render(
      <WorkspaceFilePreview filePath="src/index.ts" projectId="project-1" />,
    );

    const region = await screen.findByRole("region", { name: "文件预览" });
    const alert = await within(region).findByRole("alert");
    expect(alert).toHaveTextContent("无法加载文件预览，请重试。");
    expect(region.textContent).not.toContain("RAW SERVER MESSAGE");
    expect(region.textContent).not.toContain("D:\\secret");

    await user.click(
      within(region).getByRole("button", { name: "重试加载预览" }),
    );
    await waitFor(() =>
      expect(view.container.querySelector("pre")?.textContent).toBe(
        "重试后的内容",
      ),
    );
    expect(within(region).queryByRole("alert")).toBeNull();
    expect(calls).toBe(2);
  });

  it("offers 编辑 for text files and no delete or rename controls", async () => {
    const WorkspaceFilePreview = await filePreview();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          content: "只读内容",
          kind: "text",
          lineCount: 1,
          sizeBytes: 4,
          truncated: false,
        }),
      ),
    );

    render(<WorkspaceFilePreview filePath="a.txt" projectId="project-1" />);

    const region = await screen.findByRole("region", { name: "文件预览" });
    await within(region).findByText("1 行 · 4 B");
    expect(within(region).queryByRole("textbox")).toBeNull();
    expect(within(region).getByRole("button", { name: "编辑" })).toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: /删除|重命名/ })).toBeNull();
    expect(within(region).queryByRole("link")).toBeNull();
    expect(region.querySelector("[contenteditable]")).toBeNull();
  });

  it("opens a sandbox editor from 编辑 and keeps canonical preview copy until saved", async () => {
    const WorkspaceFilePreview = await filePreview();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/workspace/file?")) {
          return Response.json({
            content: "hello owner",
            kind: "text",
            lineCount: 1,
            sizeBytes: 11,
            truncated: false,
          });
        }
        if (url.endsWith("/workspace/edits") && init?.method === "POST") {
          return Response.json({
            expectedHash: "a".repeat(64),
            path: "notes.txt",
            sessionId: "11111111-1111-4111-8111-111111111111",
            stagedHash: null,
            status: "editing",
            version: 1,
          }, { status: 201 });
        }
        throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
      }),
    );
    const user = userEvent.setup();
    render(<WorkspaceFilePreview filePath="notes.txt" projectId="project-1" />);
    const region = await screen.findByRole("region", { name: "文件预览" });
    await user.click(within(region).getByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑文件" });
    expect(within(dialog).getByRole("textbox", { name: "文件内容" })).toHaveValue("hello owner");
    expect(within(dialog).getByRole("button", { name: "放弃" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "申请合入" })).toBeInTheDocument();
  });

  it("keeps the preview styling on design tokens with monospace content", () => {
    const css = readFileSync(join(process.cwd(), "app", "cockpit.css"), "utf8");
    expect(css).toMatch(
      /\.workspace-preview-content\s*\{[^}]*font:\s*var\(--text-sm\)\s*var\(--font-mono\)/s,
    );
    expect(css).toMatch(
      /\.workspace-preview-content\s*\{[^}]*background:\s*var\(--surface-muted\)/s,
    );
    expect(css).toMatch(
      /\.workspace-preview-truncated\s*\{[^}]*background:\s*var\(--interactive-soft\)/s,
    );
    expect(css).toMatch(
      /\.workspace-preview-path\s*\{[^}]*font:\s*var\(--text-sm\)\s*var\(--font-sans\)/s,
    );
  });
});
