// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";
import type {
  ProjectMessage,
  ThreadMessageAttachmentRefDto,
} from "@/src/shared/collaboration-contracts";
import type { MembershipState } from "@/src/shared/project-context-contracts";
import {
  TEST_THREAD_ID,
  threadPolicy,
  threadSummary,
} from "@/tests/cockpit-test-fetch";

const OTHER_THREAD_ID = "thread-2";

const members: MembershipState = {
  members: [
    {
      accentToken: "sage",
      agentId: "agent-a",
      avatarText: "A",
      joinedAt: "2026-07-30T00:00:00.000Z",
      model: "test-model",
      name: "Alpha",
      permissions: { readFiles: true, runCommands: false, writeFiles: false },
      role: "Peer",
      skillNames: [],
    },
  ],
  projectVersion: 1,
};

const activeRun = {
  createdAt: "2026-07-30T00:00:00.000Z",
  currentAgentId: "agent-a",
  id: "run-1",
  pauseCategory: null,
  projectId: "project-1",
  roundCount: 1,
  status: "running",
  threadId: TEST_THREAD_ID,
  updatedAt: "2026-07-30T00:00:00.000Z",
  version: 1,
};

type DraftRecord = {
  attachments: Array<{ attachmentId?: string; name: string; size: number }>;
  content: string;
  replyToMessageId: string | null;
  updatedAt: string;
  version: number;
};

function ownerMessage(overrides: Partial<ProjectMessage> = {}): ProjectMessage {
  return {
    attachments: [],
    authorAgentId: null,
    authorDisplayName: "项目所有者",
    authorType: "owner",
    content: "Plan the release",
    createdAt: "2026-07-30T00:00:00.000Z",
    id: "message-1",
    mentionAgentId: null,
    mentionDisplayName: null,
    mentionMemberStatus: null,
    replyTo: null,
    runId: "run-1",
    sequence: 1,
    ...overrides,
  } as ProjectMessage;
}

class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = [];
  aborted = false;
  body: unknown = null;
  headers: Record<string, string> = {};
  method = "";
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  readyState = 0;
  responseText = "";
  status = 0;
  upload: {
    onprogress:
      | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void)
      | null;
  } = { onprogress: null };
  url = "";
  constructor() {
    FakeXMLHttpRequest.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }
  send(body?: unknown) {
    this.body = body ?? null;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
}

function completeUpload(
  xhr: FakeXMLHttpRequest,
  ref: ThreadMessageAttachmentRefDto,
  registry?: Map<string, ThreadMessageAttachmentRefDto>,
) {
  registry?.set(ref.id, ref);
  xhr.status = 201;
  xhr.responseText = JSON.stringify({
    attachment: {
      createdAt: "2026-08-10T00:00:00.000Z",
      fileName: ref.fileName,
      id: ref.id,
      linkedAt: null,
      messageId: null,
      mimeType: ref.mimeType,
      projectId: "project-1",
      sha256: "a".repeat(64),
      size: ref.size,
      status: "uploaded",
      threadId: TEST_THREAD_ID,
    },
    reused: false,
  });
  act(() => xhr.onload?.());
}

function failUpload(xhr: FakeXMLHttpRequest, status = 400) {
  xhr.status = status;
  xhr.responseText = JSON.stringify({
    error: { code: "INVALID_INPUT", message: "raw upload detail" },
  });
  act(() => xhr.onload?.());
}

type DraftCall = {
  body?: Record<string, unknown>;
  method: string;
  url: string;
};

function installFetch(options?: {
  noActiveRun?: boolean;
  seedDrafts?: Record<string, DraftRecord>;
  seedMessages?: ProjectMessage[];
}) {
  const drafts = new Map<string, DraftRecord>(
    Object.entries(options?.seedDrafts ?? {}),
  );
  const messages = [...(options?.seedMessages ?? [])];
  const uploaded = new Map<string, ThreadMessageAttachmentRefDto>();
  const draftCalls: DraftCall[] = [];
  const deletedAttachments: string[] = [];
  let sentMessageCount = 0;

  function threadEnvelope(threadId: string) {
    const threadMessages = messages.map((item) => ({
      ...item,
      projectId: "project-1",
      threadId,
    }));
    const facts = threadMessages.map((item, index) => ({
      activitySequence: index + 1,
      actorId: item.authorAgentId,
      actorType: item.authorType,
      createdAt: item.createdAt,
      id: `fact-${item.id}`,
      message: item,
      messageId: item.id,
      payload: { messageId: item.id },
      policyRevisionId: null,
      projectId: "project-1",
      runEventId: null,
      runId: item.runId,
      sequence: index + 1,
      threadId,
      type: item.authorType === "owner" ? "owner_message" : "agent_message",
    }));
    return { facts, threadMessages };
  }

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const attachmentDeleteMatch = url.match(
        /\/api\/projects\/([^/]+)\/threads\/([^/]+)\/attachments\/([^/]+)$/,
      );
      if (attachmentDeleteMatch && init?.method === "DELETE") {
        deletedAttachments.push(attachmentDeleteMatch[3]!);
        return new Response(null, { status: 204 });
      }
      const draftMatch = url.match(
        /\/api\/projects\/([^/]+)\/threads\/([^/]+)\/draft$/,
      );
      if (draftMatch) {
        const [, projectId, threadId] = draftMatch;
        const key = `${projectId}|${threadId}`;
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          draftCalls.push({ body, method: "PUT", url });
          const prior = drafts.get(key);
          const record: DraftRecord = {
            attachments: body.attachments as DraftRecord["attachments"],
            content: String(body.content),
            replyToMessageId: (body.replyToMessageId ?? null) as string | null,
            updatedAt: "2026-08-10T00:00:00.000Z",
            version: (prior?.version ?? 0) + 1,
          };
          drafts.set(key, record);
          return Response.json({
            contentSaved: true,
            draft: { ...record, projectId, threadId },
          });
        }
        if (init?.method === "DELETE") {
          draftCalls.push({ method: "DELETE", url });
          drafts.delete(key);
          return Response.json({ cleared: true });
        }
        const record = drafts.get(key) ?? null;
        return Response.json({
          draft: record ? { ...record, projectId, threadId } : null,
        });
      }
      if (url.endsWith("/messages") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          attachmentIds?: string[];
          content: string;
          operationId: string;
        };
        sentMessageCount += 1;
        const message = ownerMessage({
          attachments: (body.attachmentIds ?? []).map(
            (id) => uploaded.get(id)!,
          ),
          content: body.content,
          id: `message-sent-${sentMessageCount}`,
          runId: null,
          sequence: messages.length + 1,
        });
        messages.push(message);
        return Response.json(
          {
            fact: { id: `fact-${message.id}` },
            message: {
              ...message,
              projectId: "project-1",
              threadId: TEST_THREAD_ID,
            },
            run: null,
          },
          { status: 201 },
        );
      }
      const threadMatch = url.match(/\/threads\/(thread-[^/?]+)/);
      const threadId = threadMatch?.[1] ?? TEST_THREAD_ID;
      const { facts, threadMessages } = threadEnvelope(threadId);
      if (url.endsWith("/messages")) {
        return Response.json({ items: threadMessages, nextAfter: null });
      }
      if (url.includes("/facts")) {
        return Response.json({ items: facts, nextAfter: null });
      }
      if (url.includes("/timeline")) {
        return Response.json({ items: [], nextAfter: null });
      }
      if (url.endsWith("/members")) return Response.json(members);
      if (url.includes(`/threads/${threadId}`)) {
        return Response.json({
          activeRun: options?.noActiveRun ? null : { runId: activeRun.id, threadId },
          readiness: {
            dispatch: "ready",
            missingProjectFacts: [],
            selectedMemberId: activeRun.currentAgentId,
          },
          runs: options?.noActiveRun ? [] : [{ ...activeRun, threadId }],
          selectedRun: url.includes("?run=") && !options?.noActiveRun
            ? { ...activeRun, threadId }
            : null,
          thread: {
            ...threadSummary("project-1"),
            id: threadId,
            policy: threadPolicy(),
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
  return { deletedAttachments, draftCalls, drafts, fetchMock, messages, uploaded };
}

beforeEach(() => {
  FakeXMLHttpRequest.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPanel(threadId: string = TEST_THREAD_ID, withSelectedRun = true) {
  return render(createElement(CollaborationPanel, {
    projectId: "project-1",
    selectedRunId: withSelectedRun ? "run-1" : null,
    threadId,
  }));
}

function imageFile(name: string, bytes: number, type = "image/png") {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("composer attachment upload", () => {
  it("uploads a selected image with visible progress and stores the real reference in the draft", async () => {
    const { draftCalls } = installFetch({ seedMessages: [ownerMessage()] });
    renderPanel();
    await screen.findByText("Plan the release");

    const file = imageFile("photo.png", 8);
    fireEvent.change(screen.getByLabelText("选择附件文件"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(FakeXMLHttpRequest.instances).toHaveLength(1));
    const xhr = FakeXMLHttpRequest.instances[0]!;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe(
      `/api/projects/project-1/threads/${TEST_THREAD_ID}/attachments?name=photo.png`,
    );

    const chip = await screen.findByText(/photo\.png/);
    expect(chip.textContent).toContain("上传中");

    act(() => {
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 8 });
    });
    expect(await screen.findByText(/50%/)).toBeInTheDocument();

    completeUpload(xhr, {
      fileName: "photo.png",
      id: "att-1",
      mimeType: "image/png",
      size: 8,
    });
    expect(await screen.findByText(/已上传/)).toBeInTheDocument();

    await waitFor(
      () => {
        const puts = draftCalls.filter((call) => call.method === "PUT");
        expect(puts.at(-1)?.body?.attachments).toEqual([
          { attachmentId: "att-1", name: "photo.png", size: 8 },
        ]);
      },
      { timeout: 2000 },
    );
  });

  it("uploads a pasted image through the same channel", async () => {
    installFetch({ seedMessages: [ownerMessage()] });
    renderPanel();
    const composer = await screen.findByLabelText("发送给项目对话");
    await screen.findByText("Plan the release");

    const file = imageFile("pasted.png", 6);
    fireEvent.paste(composer, {
      clipboardData: {
        items: [
          { kind: "file", type: "image/png", getAsFile: () => file },
          { kind: "string", type: "text/plain", getAsFile: () => null },
        ],
      },
    });

    await waitFor(() => expect(FakeXMLHttpRequest.instances).toHaveLength(1));
    expect(await screen.findByText(/pasted\.png/)).toBeInTheDocument();
    completeUpload(FakeXMLHttpRequest.instances[0]!, {
      fileName: "pasted.png",
      id: "att-paste",
      mimeType: "image/png",
      size: 6,
    });
    expect(await screen.findByText(/已上传/)).toBeInTheDocument();
  });

  it("marks the chip failed on rejection and supports retry and remove", async () => {
    const { draftCalls } = installFetch({ seedMessages: [ownerMessage()] });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Plan the release");

    fireEvent.change(screen.getByLabelText("选择附件文件"), {
      target: { files: [imageFile("broken.png", 4)] },
    });
    await waitFor(() => expect(FakeXMLHttpRequest.instances).toHaveLength(1));
    failUpload(FakeXMLHttpRequest.instances[0]!);

    expect(await screen.findByText(/上传失败/)).toBeInTheDocument();
    expect(screen.queryByText("raw upload detail")).not.toBeInTheDocument();
    const send = screen.getByRole("button", { name: "发送消息" });
    expect(send).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /重试上传 broken\.png/ }));
    await waitFor(() => expect(FakeXMLHttpRequest.instances).toHaveLength(2));
    completeUpload(FakeXMLHttpRequest.instances[1]!, {
      fileName: "broken.png",
      id: "att-2",
      mimeType: "image/png",
      size: 4,
    });
    expect(await screen.findByText(/已上传/)).toBeInTheDocument();
    await waitFor(
      () => {
        const puts = draftCalls.filter((call) => call.method === "PUT");
        expect(puts.at(-1)?.body?.attachments).toEqual([
          { attachmentId: "att-2", name: "broken.png", size: 4 },
        ]);
      },
      { timeout: 2000 },
    );

    await user.click(screen.getByRole("button", { name: "移除附件 broken.png" }));
    expect(screen.queryByText(/broken\.png/)).not.toBeInTheDocument();
  });

  it("rejects wrong type, oversize, and excess count with a neutral field error and no upload", async () => {
    installFetch({ seedMessages: [ownerMessage()] });
    renderPanel();
    const composer = await screen.findByLabelText("发送给项目对话");
    await screen.findByText("Plan the release");
    const input = screen.getByLabelText("选择附件文件");

    fireEvent.change(input, {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    expect(await screen.findByText(/仅支持 PNG\/JPEG\/GIF\/WebP/)).toBeInTheDocument();
    expect(FakeXMLHttpRequest.instances).toHaveLength(0);

    fireEvent.change(input, {
      target: { files: [imageFile("huge.png", 5 * 1024 * 1024 + 1)] },
    });
    expect(await screen.findByText(/5 MiB/)).toBeInTheDocument();
    expect(FakeXMLHttpRequest.instances).toHaveLength(0);

    fireEvent.change(input, {
      target: {
        files: [1, 2, 3, 4, 5].map((n) => imageFile(`f${n}.png`, 4)),
      },
    });
    expect(await screen.findByText(/最多 4 个附件/)).toBeInTheDocument();
    expect(FakeXMLHttpRequest.instances).toHaveLength(0);
    expect(composer).toBeEnabled();
  });

  it("carries uploaded attachmentIds on send and clears the chips after confirmation", async () => {
    const { fetchMock, uploaded } = installFetch({ seedMessages: [ownerMessage()] });
    const user = userEvent.setup();
    renderPanel();
    const composer = await screen.findByLabelText("发送给项目对话");
    await screen.findByText("Plan the release");

    fireEvent.change(screen.getByLabelText("选择附件文件"), {
      target: { files: [imageFile("photo.png", 8)] },
    });
    await waitFor(() => expect(FakeXMLHttpRequest.instances).toHaveLength(1));

    fireEvent.change(composer, { target: { value: "看图" } });
    const send = screen.getByRole("button", { name: "发送消息" });
    expect(send).toBeDisabled();
    expect(screen.getByText(/附件.*后才能发送/)).toBeInTheDocument();

    completeUpload(FakeXMLHttpRequest.instances[0]!, {
      fileName: "photo.png",
      id: "att-1",
      mimeType: "image/png",
      size: 8,
    }, uploaded);
    await waitFor(() => expect(send).toBeEnabled());

    await user.click(send);
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith("/messages") && init?.method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>;
      expect(body.attachmentIds).toEqual(["att-1"]);
    });
    await waitFor(() => expect(composer).toHaveValue(""));
    expect(screen.queryByText(/photo\.png/)).not.toBeInTheDocument();
  });

  it("blocks attachments on a fresh run start with a neutral field error", async () => {
    const { fetchMock, uploaded } = installFetch({
      noActiveRun: true,
      seedMessages: [ownerMessage({ runId: null })],
    });
    const user = userEvent.setup();
    renderPanel(TEST_THREAD_ID, false);
    const composer = await screen.findByLabelText("发送给项目对话");
    await waitFor(() => expect(composer).toBeEnabled());

    fireEvent.change(screen.getByLabelText("选择附件文件"), {
      target: { files: [imageFile("photo.png", 8)] },
    });
    await waitFor(() => expect(FakeXMLHttpRequest.instances).toHaveLength(1));
    completeUpload(FakeXMLHttpRequest.instances[0]!, {
      fileName: "photo.png",
      id: "att-1",
      mimeType: "image/png",
      size: 8,
    }, uploaded);
    await screen.findByText(/已上传/);

    fireEvent.change(composer, { target: { value: "带附件的首轮" } });
    const send = screen.getByRole("button", { name: /发送并开始首次运行/ });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    expect(
      await screen.findByText(/暂不能携带附件/),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith("/runs") && init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("collapses repeated selections of identical content into one uploaded chip", async () => {
    const { draftCalls } = installFetch({ seedMessages: [ownerMessage()] });
    renderPanel();
    await screen.findByText("Plan the release");

    const input = screen.getByLabelText("选择附件文件");
    fireEvent.change(input, { target: { files: [imageFile("dup.png", 8)] } });
    fireEvent.change(input, { target: { files: [imageFile("dup.png", 8)] } });
    await waitFor(() => expect(FakeXMLHttpRequest.instances).toHaveLength(2));

    for (const xhr of FakeXMLHttpRequest.instances) {
      completeUpload(xhr, {
        fileName: "dup.png",
        id: "att-dup",
        mimeType: "image/png",
        size: 8,
      });
    }
    await waitFor(() => {
      const chips = screen.getAllByText(/dup\.png/);
      expect(chips).toHaveLength(1);
      expect(chips[0]!.textContent).toContain("已上传");
    });
    await waitFor(
      () => {
        const puts = draftCalls.filter((call) => call.method === "PUT");
        expect(puts.at(-1)?.body?.attachments).toEqual([
          { attachmentId: "att-dup", name: "dup.png", size: 8 },
        ]);
      },
      { timeout: 2000 },
    );
  });

  it("aborts in-flight uploads and drops pending chips on a thread switch", async () => {
    installFetch({ seedMessages: [ownerMessage()] });
    const view = renderPanel();
    await screen.findByText("Plan the release");

    fireEvent.change(screen.getByLabelText("选择附件文件"), {
      target: { files: [imageFile("pending.png", 8)] },
    });
    await waitFor(() => expect(FakeXMLHttpRequest.instances).toHaveLength(1));
    const xhr = FakeXMLHttpRequest.instances[0]!;
    await screen.findByText(/pending\.png/);

    view.rerender(createElement(CollaborationPanel, {
      projectId: "project-1",
      selectedRunId: "run-1",
      threadId: OTHER_THREAD_ID,
    }));
    await waitFor(() => expect(xhr.aborted).toBe(true));
    expect(screen.queryByText(/pending\.png/)).not.toBeInTheDocument();

    completeUpload(xhr, {
      fileName: "pending.png",
      id: "att-late",
      mimeType: "image/png",
      size: 8,
    });
    expect(screen.queryByText(/pending\.png/)).not.toBeInTheDocument();
  });
});

describe("composer draft attachment restore", () => {
  it("restores uploaded references as ready chips and legacy placeholders as needs-reselect", async () => {
    installFetch({
      seedDrafts: {
        [`project-1|${TEST_THREAD_ID}`]: {
          attachments: [
            { attachmentId: "att-9", name: "ready.png", size: 10 },
            { name: "legacy.png", size: 5 },
          ],
          content: "带附件的草稿",
          replyToMessageId: null,
          updatedAt: "2026-08-10T00:00:00.000Z",
          version: 3,
        },
      },
      seedMessages: [ownerMessage()],
    });
    renderPanel();
    const composer = await screen.findByLabelText("发送给项目对话");
    await waitFor(() => expect(composer).toHaveValue("带附件的草稿"));

    const ready = await screen.findByText(/ready\.png/);
    expect(ready.textContent).toContain("已上传");
    const legacy = await screen.findByText(/legacy\.png/);
    expect(legacy.textContent).toContain("需重新选择");
    expect(
      screen.queryByRole("button", { name: /重试上传 legacy\.png/ }),
    ).not.toBeInTheDocument();

    fireEvent.change(composer, { target: { value: "带附件的草稿。" } });
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
  });
});

describe("message attachment rendering", () => {
  it("renders message attachments as images with accessible name and metadata", async () => {
    installFetch({
      seedMessages: [
        ownerMessage({
          attachments: [
            {
              fileName: "diagram.png",
              id: "att-1",
              mimeType: "image/png",
              size: 8,
            },
          ],
          content: "见附图",
        }),
      ],
    });
    renderPanel();
    await screen.findByText("见附图");

    const image = await screen.findByRole("img", { name: "diagram.png" });
    expect(image).toHaveAttribute(
      "src",
      `/api/projects/project-1/threads/${TEST_THREAD_ID}/attachments/att-1/content`,
    );
    expect(screen.getByText(/image\/png · 8 B/)).toBeInTheDocument();
  });
});
