import { afterEach, describe, expect, it, vi } from "vitest";

const generatePublicDelivery = vi.hoisted(() => vi.fn());
const listMissionDeliveries = vi.hoisted(() => vi.fn());
const readMissionDelivery = vi.hoisted(() => vi.fn());

vi.mock("@/src/adapters/outbound/sqlite/review-delivery/delivery-application-service", () => ({
  generatePublicDelivery,
}));
vi.mock("@/src/adapters/outbound/sqlite/review-delivery/delivery-read-service", () => ({
  listMissionDeliveries,
  readMissionDelivery,
}));

type CurrentRoute = {
  GET(request: Request, context: { params: Promise<{ missionId: string }> }): Promise<Response>;
  POST(request: Request, context: { params: Promise<{ missionId: string }> }): Promise<Response>;
};
type HistoryRoute = {
  GET(request: Request, context: { params: Promise<{ missionId: string }> }): Promise<Response>;
};

const currentModules = import.meta.glob<CurrentRoute>(
  "../../../app/api/missions/[missionId]/delivery/route.ts",
);
const historyModules = import.meta.glob<HistoryRoute>(
  "../../../app/api/missions/[missionId]/deliveries/route.ts",
);
const operationId = "27000000-0000-4000-8000-000000000001";

async function currentRoute(): Promise<CurrentRoute> {
  const load = currentModules["../../../app/api/missions/[missionId]/delivery/route.ts"];
  expect(load, "strict delivery current route must exist").toBeTypeOf("function");
  return load!();
}

async function historyRoute(): Promise<HistoryRoute> {
  const load = historyModules["../../../app/api/missions/[missionId]/deliveries/route.ts"];
  expect(load, "strict delivery history route must exist").toBeTypeOf("function");
  return load!();
}

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.COCKPIT_DB_PATH;
});

describe("mission delivery routes", () => {
  it("returns strict current progress and cursor history", async () => {
    process.env.COCKPIT_DB_PATH = "delivery-route.sqlite";
    readMissionDelivery.mockReturnValue({
      blockers: [],
      currentDelivery: null,
      currentDeliveryId: null,
      lastErrorCode: null,
      missionId: "mission",
      state: "ongoing",
      version: 3,
    });
    listMissionDeliveries.mockReturnValue({ items: [], nextCursor: null });

    const current = await (await currentRoute()).GET(
      new Request("http://localhost/api/missions/mission/delivery"),
      { params: Promise.resolve({ missionId: "mission" }) },
    );
    const history = await (await historyRoute()).GET(
      new Request("http://localhost/api/missions/mission/deliveries?limit=2"),
      { params: Promise.resolve({ missionId: "mission" }) },
    );

    expect(current.status).toBe(200);
    expect(await current.json()).toEqual(expect.objectContaining({
      blockers: [],
      currentDelivery: null,
      missionId: "mission",
      state: "ongoing",
      version: 3,
    }));
    expect(await history.json()).toEqual({ items: [], nextCursor: null });
    expect(readMissionDelivery).toHaveBeenCalledWith("delivery-route.sqlite", "mission");
    expect(listMissionDeliveries).toHaveBeenCalledWith(
      "delivery-route.sqlite",
      "mission",
      { after: undefined, limit: "2" },
    );
  });

  it("accepts only operationId and expectedHeadVersion", async () => {
    process.env.COCKPIT_DB_PATH = "delivery-route.sqlite";
    generatePublicDelivery.mockResolvedValue({
      delivery: { id: "delivery", version: 1 },
      missionCompletion: { missionId: "mission", state: "completed", version: 5 },
    });
    const route = await currentRoute();
    const valid = await route.POST(new Request(
      "http://localhost/api/missions/mission/delivery",
      {
        body: JSON.stringify({ expectedHeadVersion: 3, operationId }),
        method: "POST",
      },
    ), { params: Promise.resolve({ missionId: "mission" }) });
    expect(valid.status).toBe(200);
    expect(generatePublicDelivery).toHaveBeenCalledWith(
      "delivery-route.sqlite",
      "mission",
      { expectedHeadVersion: 3, operationId },
    );

    for (const forged of [
      { expectedHeadVersion: 3, operationId, manifest: {} },
      { expectedHeadVersion: 3, operationId, summary: {} },
      { actor: "owner", expectedHeadVersion: 3, operationId },
      { buildInput: {}, expectedHeadVersion: 3, operationId },
    ]) {
      const response = await route.POST(new Request(
        "http://localhost/api/missions/mission/delivery",
        { body: JSON.stringify(forged), method: "POST" },
      ), { params: Promise.resolve({ missionId: "mission" }) });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    }
    expect(generatePublicDelivery).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed history queries before storage", async () => {
    const response = await (await historyRoute()).GET(
      new Request("http://localhost/api/missions/mission/deliveries?limit=2&limit=3"),
      { params: Promise.resolve({ missionId: "mission" }) },
    );
    expect(response.status).toBe(400);
    expect(listMissionDeliveries).not.toHaveBeenCalled();
  });
});
