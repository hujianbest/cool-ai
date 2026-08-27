export const EMPTY_SERVICE_HEALTH = {
  app: { detail: null, schemaIdentity: 28, status: "ok" as const },
  execution: {
    active: 0,
    detail: "需要打开项目",
    failed: 0,
    projectId: null,
    status: "unknown" as const,
  },
  memoryIndex: {
    detail: "需要打开项目",
    projectId: null,
    status: "unknown" as const,
  },
  providers: {
    detail: "未配置模型服务",
    status: "degraded" as const,
    total: 0,
    verified: 0,
  },
};

export const EMPTY_USAGE_QUOTA = {
  budgets: [] as Array<{
    agentId: string;
    maxHandoffs: number;
    maxTokens: number;
    name: string;
    usedTokens: number;
  }>,
  disclaimer: "not_invoice" as const,
  project: {
    detail: "需要打开项目" as const,
    projectId: null,
    totals: {
      completionTokens: 0,
      invalidCalls: 0,
      promptTokens: 0,
      totalTokens: 0,
      unreportedCalls: 0,
    },
  },
  providers: [] as Array<{
    id: string;
    name: string;
    totals: {
      completionTokens: number;
      invalidCalls: number;
      promptTokens: number;
      totalTokens: number;
      unreportedCalls: number;
    };
  }>,
  runs: [] as Array<{
    id: string;
    roundCount: number;
    roundLimit: number;
    totals: {
      completionTokens: number;
      invalidCalls: number;
      promptTokens: number;
      totalTokens: number;
      unreportedCalls: number;
    };
  }>,
};

export const EMPTY_CONTRIBUTION_INSIGHT = {
  disclaimer: "not_ranking" as const,
  project: {
    detail: "需要打开项目" as const,
    projectId: null,
  },
  roles: [] as Array<{
    agentId: string;
    evidence: Array<{ id: string; kind: "review" | "work_item"; title: string }>;
    name: string;
    reviews: { failed: number; passed: number };
    role: string;
    workItems: { blocked: number; completed: number; inProgress: number };
  }>,
};

export function serviceHealthResponse(input: RequestInfo | URL): Response | null {
  const url = String(input);
  if (url.includes("/api/health")) return Response.json(EMPTY_SERVICE_HEALTH);
  if (url.includes("/api/usage")) return Response.json(EMPTY_USAGE_QUOTA);
  if (url.includes("/api/contribution")) return Response.json(EMPTY_CONTRIBUTION_INSIGHT);
  return null;
}
