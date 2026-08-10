// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

import { WorkspaceSetup } from "@/components/project-context/workspace-setup";

type TreeProps = {
  projectId: string;
  onFileSelect?: (path: string) => void;
};

type TreeModule = {
  WorkspaceFileTree: ComponentType<TreeProps>;
};

const treeModules = import.meta.glob<TreeModule>(
  "../../../components/project-context/workspace-file-tree.tsx",
);

async function fileTree() {
  const load =
    treeModules["../../../components/project-context/workspace-file-tree.tsx"];
  expect(load, "the workspace file tree must exist").toBeTypeOf("function");
  return (await load()).WorkspaceFileTree;
}

type Entry = {
  kind: "dir" | "file";
  name: string;
  sensitive: boolean;
  sizeBytes?: number;
};

function listingResponse(entries: Entry[], path = ".") {
  return Response.json({ entries, path });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("workspace file tree", () => {
  it("renders the root listing with tree semantics, ordering and masked badges", async () => {
    const WorkspaceFileTree = await fileTree();
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url === "/api/projects/project-1/workspace/files?path=.") {
          return listingResponse([
            { kind: "dir", name: "docs", sensitive: false },
            { kind: "dir", name: "src", sensitive: false },
            { kind: "file", name: ".env", sensitive: true, sizeBytes: 128 },
            { kind: "file", name: "README.md", sensitive: false, sizeBytes: 2048 },
          ]);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(<WorkspaceFileTree projectId="project-1" />);

    const tree = await screen.findByRole("tree", { name: "工作区文件" });
    const items = within(tree).getAllByRole("treeitem");
    expect(
      items.map((item) => within(item).getByText(/^(docs|src|\.env|README\.md)$/).textContent),
    ).toEqual(["docs", "src", ".env", "README.md"]);
    for (const item of items) {
      expect(item).toHaveAttribute("aria-level", "1");
    }
    expect(items[0]).toHaveAttribute("aria-expanded", "false");
    expect(items[1]).toHaveAttribute("aria-expanded", "false");
    expect(items[2]).not.toHaveAttribute("aria-expanded");
    expect(items[3]).not.toHaveAttribute("aria-expanded");
    expect(items[2]).toHaveTextContent("已遮蔽");
    expect(items[3]).not.toHaveTextContent("已遮蔽");
    expect(items[0]).toHaveAttribute("tabindex", "0");
    for (const item of items.slice(1)) {
      expect(item).toHaveAttribute("tabindex", "-1");
    }
    expect(requested).toEqual([
      "/api/projects/project-1/workspace/files?path=.",
    ]);
  });

  it("lazy-loads directories on expand, collapses them, and reuses the cache", async () => {
    const WorkspaceFileTree = await fileTree();
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url === "/api/projects/project-1/workspace/files?path=.") {
          return listingResponse([
            { kind: "dir", name: "src", sensitive: false },
            { kind: "file", name: "README.md", sensitive: false },
          ]);
        }
        if (url === "/api/projects/project-1/workspace/files?path=src") {
          return listingResponse(
            [
              { kind: "dir", name: "lib", sensitive: false },
              { kind: "file", name: "index.ts", sensitive: false, sizeBytes: 64 },
            ],
            "src",
          );
        }
        if (url === "/api/projects/project-1/workspace/files?path=src%2Flib") {
          return listingResponse(
            [{ kind: "file", name: "util.ts", sensitive: false, sizeBytes: 32 }],
            "src/lib",
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(<WorkspaceFileTree projectId="project-1" />);

    const tree = await screen.findByRole("tree", { name: "工作区文件" });
    const src = within(tree).getByRole("treeitem", { name: "src" });

    await user.click(src);
    const lib = await within(tree).findByRole("treeitem", { name: "lib" });
    expect(src).toHaveAttribute("aria-expanded", "true");
    expect(lib).toHaveAttribute("aria-level", "2");
    expect(
      within(tree).getByRole("treeitem", { name: "index.ts" }),
    ).toHaveAttribute("aria-level", "2");
    expect(requested).toEqual([
      "/api/projects/project-1/workspace/files?path=.",
      "/api/projects/project-1/workspace/files?path=src",
    ]);

    await user.click(lib);
    expect(
      await within(tree).findByRole("treeitem", { name: "util.ts" }),
    ).toHaveAttribute("aria-level", "3");
    expect(requested).toContain(
      "/api/projects/project-1/workspace/files?path=src%2Flib",
    );

    await user.click(src);
    expect(src).toHaveAttribute("aria-expanded", "false");
    expect(
      within(tree).queryByRole("treeitem", { name: "lib" }),
    ).not.toBeInTheDocument();

    await user.click(src);
    expect(
      await within(tree).findByRole("treeitem", { name: "lib" }),
    ).toBeInTheDocument();
    expect(
      requested.filter((url) => url.endsWith("path=src")),
    ).toHaveLength(1);
  });

  it("supports full keyboard navigation and selects files via Enter", async () => {
    const WorkspaceFileTree = await fileTree();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects/project-1/workspace/files?path=.") {
          return listingResponse([
            { kind: "dir", name: "src", sensitive: false },
            { kind: "file", name: "a.txt", sensitive: false, sizeBytes: 8 },
            { kind: "file", name: "z.txt", sensitive: true, sizeBytes: 9 },
          ]);
        }
        if (url === "/api/projects/project-1/workspace/files?path=src") {
          return listingResponse(
            [{ kind: "file", name: "index.ts", sensitive: false, sizeBytes: 64 }],
            "src",
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const onFileSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <WorkspaceFileTree projectId="project-1" onFileSelect={onFileSelect} />,
    );

    const tree = await screen.findByRole("tree", { name: "工作区文件" });
    const src = within(tree).getByRole("treeitem", { name: "src" });
    const aTxt = within(tree).getByRole("treeitem", { name: "a.txt" });
    const zFile = within(tree).getByRole("treeitem", { name: /z\.txt/ });

    src.focus();
    await user.keyboard("{ArrowDown}");
    expect(aTxt).toHaveFocus();
    expect(aTxt).toHaveAttribute("tabindex", "0");
    expect(src).toHaveAttribute("tabindex", "-1");
    await user.keyboard("{ArrowUp}");
    expect(src).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    const indexTs = await within(tree).findByRole("treeitem", {
      name: "index.ts",
    });
    expect(src).toHaveAttribute("aria-expanded", "true");
    expect(src).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(indexTs).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(src).toHaveFocus();
    expect(src).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowLeft}");
    expect(src).toHaveAttribute("aria-expanded", "false");

    await user.keyboard("{End}");
    expect(zFile).toHaveFocus();
    await user.keyboard("{Home}");
    expect(src).toHaveFocus();
    await user.keyboard("{ArrowDown}");

    await user.keyboard("{Enter}");
    expect(onFileSelect).toHaveBeenCalledWith("a.txt");
    expect(aTxt).toHaveAttribute("aria-selected", "true");
    expect(zFile).toHaveAttribute("aria-selected", "false");

    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onFileSelect).toHaveBeenCalledWith("z.txt");
    expect(zFile).toHaveAttribute("aria-selected", "true");
    expect(within(zFile).getByText("已遮蔽")).toBeInTheDocument();

    src.focus();
    await user.keyboard("{Enter}");
    expect(src).toHaveAttribute("aria-expanded", "true");
    expect(onFileSelect).toHaveBeenCalledTimes(2);
  });

  it("distinguishes root loading, empty and error states with retry", async () => {
    const WorkspaceFileTree = await fileTree();
    const deferredRoot = (() => {
      let resolve!: (response: Response) => void;
      const promise = new Promise<Response>((resolver) => {
        resolve = resolver;
      });
      return { promise, resolve };
    })();
    let rootCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        rootCalls += 1;
        if (rootCalls === 1) return deferredRoot.promise;
        return listingResponse([]);
      }),
    );
    const user = userEvent.setup();
    render(<WorkspaceFileTree projectId="project-1" />);

    expect(screen.getByText("正在加载文件列表…")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await act(async () => {
      deferredRoot.resolve(
        Response.json(
          { error: { code: "WORKSPACE_BROWSE_UNAVAILABLE", message: "down" } },
          { status: 503 },
        ),
      );
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法加载文件列表，请重试。",
    );

    await user.click(screen.getByRole("button", { name: "重试加载文件列表" }));
    expect(await screen.findByText("该目录为空。")).toBeInTheDocument();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps branch load failures inline with a retry that does not crash the tree", async () => {
    const WorkspaceFileTree = await fileTree();
    let srcCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects/project-1/workspace/files?path=.") {
          return listingResponse([
            { kind: "dir", name: "src", sensitive: false },
            { kind: "file", name: "README.md", sensitive: false },
          ]);
        }
        if (url === "/api/projects/project-1/workspace/files?path=src") {
          srcCalls += 1;
          if (srcCalls === 1) {
            return Response.json(
              { error: { code: "WORKSPACE_PATH_REJECTED", message: "rejected" } },
              { status: 422 },
            );
          }
          return listingResponse(
            [{ kind: "file", name: "index.ts", sensitive: false }],
            "src",
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(<WorkspaceFileTree projectId="project-1" />);

    const tree = await screen.findByRole("tree", { name: "工作区文件" });
    const src = within(tree).getByRole("treeitem", { name: "src" });
    await user.click(src);

    expect(await within(tree).findByRole("alert")).toHaveTextContent(
      "无法加载该目录。",
    );
    expect(
      within(tree).getByRole("treeitem", { name: "README.md" }),
    ).toBeInTheDocument();
    expect(src).toHaveAttribute("aria-expanded", "true");

    await user.click(within(tree).getByRole("button", { name: "重试" }));
    expect(
      await within(tree).findByRole("treeitem", { name: "index.ts" }),
    ).toBeInTheDocument();
    expect(within(tree).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores stale responses when the project target switches mid-load", async () => {
    const WorkspaceFileTree = await fileTree();
    const deferredA = (() => {
      let resolve!: (response: Response) => void;
      const promise = new Promise<Response>((resolver) => {
        resolve = resolver;
      });
      return { promise, resolve };
    })();
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url === "/api/projects/project-a/workspace/files?path=.") {
          return deferredA.promise;
        }
        if (url === "/api/projects/project-b/workspace/files?path=.") {
          return listingResponse([
            { kind: "file", name: "b-file.txt", sensitive: false },
          ]);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const view = render(<WorkspaceFileTree projectId="project-a" />);
    expect(screen.getByText("正在加载文件列表…")).toBeInTheDocument();

    view.rerender(<WorkspaceFileTree projectId="project-b" />);
    const tree = await screen.findByRole("tree", { name: "工作区文件" });
    expect(
      within(tree).getByRole("treeitem", { name: "b-file.txt" }),
    ).toBeInTheDocument();

    await act(async () => {
      deferredA.resolve(
        listingResponse([{ kind: "file", name: "a-file.txt", sensitive: false }]),
      );
    });
    await waitFor(() =>
      expect(
        within(tree).queryByRole("treeitem", { name: "a-file.txt" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      within(tree).getByRole("treeitem", { name: "b-file.txt" }),
    ).toBeInTheDocument();
    expect(requested).toEqual([
      "/api/projects/project-a/workspace/files?path=.",
      "/api/projects/project-b/workspace/files?path=.",
    ]);
  });
});

describe("workspace panel mount point", () => {
  it("renders the file browser for a bound workspace and previews the selected file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects/project-1/workspace") {
          return Response.json({
            projectVersion: 2,
            workspace: { path: "D:\\ws", status: "ready" },
          });
        }
        if (url === "/api/projects/project-1/workspace/files?path=.") {
          return listingResponse([
            { kind: "file", name: "app.ts", sensitive: false, sizeBytes: 16 },
          ]);
        }
        if (url === "/api/projects/project-1/workspace/file?path=app.ts") {
          return Response.json({
            content: "console.log(1)",
            kind: "text",
            lineCount: 1,
            sizeBytes: 16,
            truncated: false,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(<WorkspaceSetup projectId="project-1" />);

    const tree = await screen.findByRole("tree", { name: "工作区文件" });
    const file = within(tree).getByRole("treeitem", { name: "app.ts" });
    await user.click(file);

    const region = await screen.findByRole("region", { name: "文件预览" });
    expect(within(region).getByText("app.ts")).toBeInTheDocument();
    await waitFor(() =>
      expect(region.querySelector("pre")?.textContent).toBe("console.log(1)"),
    );
    expect(
      screen.queryByRole("status", { name: "文件选中" }),
    ).not.toBeInTheDocument();
  });

  it("shows a distinct hint instead of the tree when no workspace is bound", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects/project-1/workspace") {
          return Response.json({ projectVersion: 1, workspace: null });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    render(<WorkspaceSetup projectId="project-1" />);

    expect(await screen.findByText("尚未绑定本地工作区。")).toBeInTheDocument();
    expect(screen.getByText("绑定工作区后即可浏览文件。")).toBeInTheDocument();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  });

  it("keeps the tree styling on design tokens with visible focus and 44px rows", () => {
    const css = readFileSync(join(process.cwd(), "app", "cockpit.css"), "utf8");
    expect(css).toMatch(
      /\.workspace-tree-item\s*\{[^}]*min-height:\s*var\(--control-min\)/s,
    );
    expect(css).toMatch(
      /\.workspace-tree-item\[aria-selected="true"\]\s*\{[^}]*background:\s*var\(--interactive-soft\)/s,
    );
    expect(css).toMatch(
      /\.workspace-tree-item:focus-visible\s*\{[^}]*box-shadow:\s*var\(--focus-ring\)/s,
    );
  });
});
