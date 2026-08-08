import { beforeEach, describe, expect, it, vi } from "vitest";

const { readThreadDetail } = vi.hoisted(() => ({
  readThreadDetail: vi.fn(),
}));

vi.mock("@/src/server/collaboration/thread-service", () => ({
  readThreadDetail,
}));

import ProjectRoute from "@/app/projects/[projectId]/[[...resource]]/page";

function route(
  searchParams: Record<string, string | string[] | undefined>,
) {
  return ProjectRoute({
    params: Promise.resolve({ projectId: "project-1", resource: [] }),
    searchParams: Promise.resolve(searchParams),
  });
}

beforeEach(() => {
  readThreadDetail.mockReset();
  readThreadDetail.mockReturnValue({ body: {}, status: 200 });
});

describe("project selection routing", () => {
  it("canonicalizes and reconciles a valid thread/run tuple", async () => {
    const element = await route({ run: "run:1", thread: "thread:1" });

    expect(readThreadDetail).toHaveBeenCalledWith(
      expect.any(String),
      "project-1",
      "thread:1",
      "run:1",
    );
    expect(element.props.returnTo).toBe(
      "/projects/project-1?thread=thread%3A1&run=run%3A1",
    );
  });

  it("falls back to the safe project for a cross-project/thread tuple", async () => {
    readThreadDetail.mockImplementation(() => {
      throw new Error("RESOURCE_NOT_FOUND");
    });

    const element = await route({ run: "foreign-run", thread: "foreign-thread" });

    expect(element.props.returnTo).toBe("/projects/project-1");
  });

  it.each([
    { thread: ["thread-1", "thread-2"] },
    { thread: "thread-1", unknown: "value" },
    { run: "run-1" },
    { thread: "" },
  ])("falls back to root for malformed selection %#", async (searchParams) => {
    const element = await route(searchParams);

    expect(readThreadDetail).not.toHaveBeenCalled();
    expect(element.props.returnTo).toBe("/");
  });
});
