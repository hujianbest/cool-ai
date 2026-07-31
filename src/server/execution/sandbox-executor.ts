export type SandboxExecutionInput = {
  actionId: string;
  attemptId: string;
  executionId: string;
  operationId: string;
  projectId: string;
  sandboxRoot: string;
};

export type SandboxExecutor = (input: SandboxExecutionInput) => Promise<never>;

let testExecutor: SandboxExecutor | null = null;

export function setSandboxExecutorForTests(executor: SandboxExecutor | null): void {
  testExecutor = executor;
}

export function sandboxExecutor(): SandboxExecutor {
  if (!testExecutor) {
    throw new Error("Sandbox execution is not available in this delivery slice.");
  }
  return testExecutor;
}
