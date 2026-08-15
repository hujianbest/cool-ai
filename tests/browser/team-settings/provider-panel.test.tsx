// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamPanel } from "@/components/team-panel";

const API_KEY = "ui-provider-secret-DO-NOT-LEAK-ABCD";

function provider(overrides: Record<string, unknown> = {}) {
  return {
    apiKeyMask: "••••ABCD",
    baseUrl: "https://example.test/v1",
    createdAt: "2026-07-29T00:00:00.000Z",
    defaultModel: "model-a",
    id: "provider-1",
    name: "Primary",
    status: "verified",
    updatedAt: "2026-07-29T00:00:00.000Z",
    verifiedAt: "2026-07-29T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Provider configuration panel", () => {
  it("covers loading, error, retry and empty states with keyboard resource tabs", async () => {
    const providerLoad = deferred<Response>();
    let providerGets = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/skills") return Promise.resolve(Response.json({ skills: [] }));
      if (url === "/api/providers" && !init?.method) {
        providerGets += 1;
        return providerGets === 1
          ? providerLoad.promise
          : Promise.resolve(Response.json({ providers: [] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    const view = render(<TeamPanel section="providers" />);

    const providerTab = screen.getByRole("tab", { name: "模型服务" });
    expect(providerTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("正在加载服务…")).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      providerLoad.resolve(
        Response.json(
          { error: { code: "STORAGE_UNAVAILABLE", message: "sensitive server detail" } },
          { status: 503 },
        ),
      );
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法加载模型服务，请稍后重试。",
    );
    await user.click(screen.getByRole("button", { name: "重试加载服务" }));
    expect(await screen.findByText("暂无模型服务。")).toBeInTheDocument();

    providerTab.focus();
    await user.keyboard("{ArrowLeft}");
    const skillTab = screen.getByRole("tab", { name: "技能" });
    expect(skillTab).toHaveFocus();
    view.rerender(<TeamPanel section="skills" />);
    expect(skillTab).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowRight}");
    expect(providerTab).toHaveFocus();
    view.rerender(<TeamPanel section="providers" />);
    expect(providerTab).toHaveAttribute("aria-selected", "true");
  });

  it("creates an HTTP provider through verify/save and removes its secret from the DOM", async () => {
    const verification = deferred<Response>();
    const calls: Array<{ body?: Record<string, unknown>; method?: string; url: string }> = [];
    let verifyCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ body, method: init?.method, url });
      if (url === "/api/skills") return Response.json({ skills: [] });
      if (url === "/api/providers" && !init?.method) return Response.json({ providers: [] });
      if (url === "/api/providers/verify") {
        verifyCount += 1;
        if (verifyCount === 1) return verification.promise;
        return Response.json({
          expiresAt: "2026-07-29T00:05:00.000Z",
          validationToken: `token-${verifyCount}`,
          verifiedModel: body?.defaultModel,
        });
      }
      if (url === "/api/providers" && init?.method === "POST") {
        return Response.json(
          { provider: provider({ baseUrl: "http://localhost:11434/v1", name: "Local" }) },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<TeamPanel section="providers" />);
    await screen.findByText("暂无模型服务。");

    await user.click(screen.getByRole("button", { name: "创建模型服务" }));
    await user.type(screen.getByLabelText("服务名称"), "Local");
    await user.type(screen.getByLabelText("Base URL"), "http://localhost:11434/v1");
    await user.type(screen.getByLabelText("默认模型"), "model-a");
    const keyInput = screen.getByLabelText("API key");
    await user.type(keyInput, API_KEY);
    expect(keyInput).toHaveAttribute("type", "password");
    const toggle = screen.getByRole("button", { name: "显示 API key" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(keyInput).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "隐藏 API key" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByLabelText("我了解 HTTP 会明文传输凭据的风险"));

    const verifyButton = screen.getByRole("button", { name: "验证连接" });
    const saveButton = screen.getByRole("button", { name: "保存服务" });
    expect(saveButton).toBeDisabled();
    await user.click(verifyButton);
    expect(verifyButton).toBeDisabled();
    expect(saveButton).toBeDisabled();
    await act(async () => {
      verification.resolve(
        Response.json({
          expiresAt: "2026-07-29T00:05:00.000Z",
          validationToken: "token-1",
          verifiedModel: "model-a",
        }),
      );
    });
    expect(await screen.findByRole("status")).toHaveTextContent("已验证模型 model-a");
    expect(saveButton).toBeEnabled();

    await user.clear(screen.getByLabelText("默认模型"));
    await user.type(screen.getByLabelText("默认模型"), "model-b");
    expect(saveButton).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("连接信息已变更，请重新验证。");
    await user.click(screen.getByRole("button", { name: "验证连接" }));
    expect(await screen.findByText("已验证模型 model-b")).toBeInTheDocument();
    await user.click(saveButton);

    const heading = await screen.findByRole("heading", { name: "Local" });
    expect(heading).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("模型服务已保存。");
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(document.body.textContent).not.toContain(API_KEY);
    expect(document.querySelector(`input[value="${API_KEY}"]`)).toBeNull();
    expect(calls.find((call) => call.url === "/api/providers/verify")?.body).toMatchObject({
      allowInsecureHttp: true,
      apiKey: API_KEY,
      mode: "create",
    });
  });

  it("edits without prefilling a key and switches retain/replace verification modes", async () => {
    const verifyBodies: Array<Record<string, unknown>> = [];
    let current = provider();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url === "/api/skills") return Response.json({ skills: [] });
      if (url === "/api/providers" && !init?.method) {
        return Response.json({ providers: [current] });
      }
      if (url === "/api/providers/verify") {
        verifyBodies.push(body);
        return Response.json({
          expiresAt: "2026-07-29T00:05:00.000Z",
          validationToken: `token-${verifyBodies.length}`,
          verifiedModel: body.defaultModel,
        });
      }
      if (url === "/api/providers/provider-1" && init?.method === "PATCH") {
        current = provider({
          baseUrl: (body.draft as Record<string, unknown>).baseUrl,
          name: (body.draft as Record<string, unknown>).name,
          version: current.version + 1,
        });
        return Response.json({ provider: current });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<TeamPanel section="providers" />);
    await user.click(await screen.findByRole("button", { name: "编辑 Primary" }));

    expect(screen.getByText("已保存 ••••ABCD")).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toHaveValue("");
    await user.clear(screen.getByLabelText("服务名称"));
    await user.type(screen.getByLabelText("服务名称"), "Renamed");
    expect(screen.getByRole("button", { name: "保存服务" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "保存服务" }));
    expect(await screen.findByRole("heading", { name: "Renamed" })).toHaveFocus();
    expect(verifyBodies).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "编辑 Renamed" }));
    await user.clear(screen.getByLabelText("Base URL"));
    await user.type(screen.getByLabelText("Base URL"), "https://example.test/v2");
    expect(screen.getByRole("button", { name: "保存服务" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "验证连接" }));
    expect(verifyBodies[0]).toMatchObject({ mode: "retain", providerId: "provider-1" });
    expect(verifyBodies[0]).not.toHaveProperty("apiKey");

    await user.type(screen.getByLabelText("API key"), "replacement-key-WXYZ");
    expect(screen.getByRole("button", { name: "保存服务" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "验证连接" }));
    expect(verifyBodies[1]).toMatchObject({
      apiKey: "replacement-key-WXYZ",
      mode: "replace",
      providerId: "provider-1",
    });
  });

  it("maps errors to Chinese, focuses alerts and preserves the draft for retry", async () => {
    let verifyFails = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/skills") return Response.json({ skills: [] });
      if (url === "/api/providers" && !init?.method) return Response.json({ providers: [] });
      if (url === "/api/providers/verify" && verifyFails) {
        verifyFails = false;
        return Response.json(
          { error: { code: "PROVIDER_UNAUTHORIZED", message: "raw upstream detail" } },
          { status: 401 },
        );
      }
      if (url === "/api/providers/verify") {
        return Response.json({
          expiresAt: "2026-07-29T00:05:00.000Z",
          validationToken: "token",
          verifiedModel: "model-a",
        });
      }
      if (url === "/api/providers" && init?.method === "POST") {
        return Response.json(
          { error: { code: "PROVIDER_CONFLICT", message: "raw conflict detail" } },
          { status: 409 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<TeamPanel section="providers" />);
    await screen.findByText("暂无模型服务。");
    await user.click(screen.getByRole("button", { name: "创建模型服务" }));
    await user.type(screen.getByLabelText("服务名称"), "Primary");
    await user.type(screen.getByLabelText("Base URL"), "https://example.test/v1");
    await user.type(screen.getByLabelText("默认模型"), "model-a");
    await user.type(screen.getByLabelText("API key"), API_KEY);

    await user.click(screen.getByRole("button", { name: "验证连接" }));
    const verifyAlert = await screen.findByRole("alert");
    expect(verifyAlert).toHaveTextContent("API key 无效或没有访问权限。");
    expect(verifyAlert).toHaveFocus();
    expect(screen.getByLabelText("API key")).toHaveValue(API_KEY);

    await user.click(screen.getByRole("button", { name: "验证连接" }));
    await screen.findByText("已验证模型 model-a");
    await user.click(screen.getByRole("button", { name: "保存服务" }));
    const saveAlert = await screen.findByRole("alert");
    expect(saveAlert).toHaveTextContent("服务已被其他操作更新，请重新加载后再试。");
    expect(saveAlert).toHaveFocus();
    expect(screen.getByLabelText("服务名称")).toHaveValue("Primary");
    expect(screen.getByLabelText("API key")).toHaveValue(API_KEY);
  });

  it("GET-reconciles an uncertain known-provider write without resending it", async () => {
    let current = provider();
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        if (url === "/api/providers" && method === "GET") {
          return Response.json({ providers: [current] });
        }
        if (url === "/api/providers/provider-1" && method === "PATCH") {
          current = provider({ name: "Reconciled", version: 2 });
          throw new TypeError("network response lost");
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(<TeamPanel section="providers" />);

    await user.click(await screen.findByRole("button", { name: "编辑 Primary" }));
    await user.clear(screen.getByLabelText("服务名称"));
    await user.type(screen.getByLabelText("服务名称"), "Reconciled");
    await user.click(screen.getByRole("button", { name: "保存服务" }));

    expect(
      await screen.findByText("已通过事实核对确认模型服务已保存。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reconciled" })).toHaveFocus();
    expect(
      calls.filter(({ method }) => method === "PATCH"),
    ).toHaveLength(1);
    expect(calls.at(-1)).toEqual({ method: "GET", url: "/api/providers" });
  });

  it("does not guess or resend an uncertain create when GET cannot identify its response", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    let providerGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        if (url === "/api/providers" && method === "GET") {
          providerGets += 1;
          return Response.json({
            providers: providerGets === 1 ? [] : [provider({ name: "Primary" })],
          });
        }
        if (url === "/api/providers/verify") {
          return Response.json({
            expiresAt: "2026-08-08T00:05:00.000Z",
            validationToken: "validation-token",
            verifiedModel: "model-a",
          });
        }
        if (url === "/api/providers" && method === "POST") {
          throw new TypeError("network response lost");
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(<TeamPanel section="providers" />);

    await screen.findByText("暂无模型服务。");
    await user.click(screen.getByRole("button", { name: "创建模型服务" }));
    await user.type(screen.getByLabelText("服务名称"), "Primary");
    await user.type(screen.getByLabelText("Base URL"), "https://example.test/v1");
    await user.type(screen.getByLabelText("默认模型"), "model-a");
    await user.type(screen.getByLabelText("API key"), API_KEY);
    await user.click(screen.getByRole("button", { name: "验证连接" }));
    await screen.findByText("已验证模型 model-a");
    await user.click(screen.getByRole("button", { name: "保存服务" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "保存结果不确定，已核对列表但无法确认",
    );
    expect(screen.getByLabelText("服务名称")).toHaveValue("Primary");
    expect(screen.getByLabelText("API key")).toHaveValue(API_KEY);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(2);
    expect(calls.at(-1)).toEqual({ method: "GET", url: "/api/providers" });
  });
});
