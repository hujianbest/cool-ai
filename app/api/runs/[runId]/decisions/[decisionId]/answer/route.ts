type RouteContext = {
  params: Promise<{ decisionId: string; runId: string }>;
};

export async function POST(
  _request: Request,
  _context: RouteContext,
): Promise<Response> {
  return Response.json(
    {
      error: {
        code: "RESOURCE_NOT_FOUND",
        message: "Resource was not found.",
      },
    },
    { status: 404 },
  );
}
