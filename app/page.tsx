import { AgentList } from "../components/AgentList";

export default function Home() {
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-4 sm:flex-row sm:p-6">
      <aside className="w-full shrink-0 rounded-token border border-line bg-surface-subtle p-4 sm:w-64">
        <h1 className="text-xl font-semibold">COOL AI</h1>
        <p className="mt-1 text-sm text-muted">多 agent 协作平台</p>
      </aside>
      <main className="flex-1 rounded-token border border-line bg-surface p-4">
        <h2 className="mb-3 text-lg font-medium">Agent</h2>
        <AgentList />
      </main>
    </div>
  );
}
