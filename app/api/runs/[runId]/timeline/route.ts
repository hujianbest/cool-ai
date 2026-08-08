type RouteContext = { params: Promise<{ runId: string }> };

export async function GET(
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
