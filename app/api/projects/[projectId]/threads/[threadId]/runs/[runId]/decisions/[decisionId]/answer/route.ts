import { threadDecisionAnswerPost } from "@/app/api/_shared/collaboration/thread-decision-answer-api";

type RouteContext = {
  params: Promise<{
    decisionId: string;
    projectId: string;
    runId: string;
    threadId: string;
  }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return threadDecisionAnswerPost(request, context);
}
