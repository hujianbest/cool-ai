import { execFileSync } from "node:child_process";

const base = process.env.PROBE_URL || "http://localhost:3000";
const chrome =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

async function main() {
  const res = await fetch(base + "/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "冒烟测试 Agent",
      systemPrompt: "smoke",
      tools: ["shell", "file.read"],
      skills: ["tdd"],
    }),
  });
  if (res.status !== 201) throw new Error("POST status " + res.status);
  const { agent } = await res.json();
  if (!Array.isArray(agent.tools) || !agent.tools.includes("shell"))
    throw new Error("agent.tools not array or missing 'shell'");
  if (!Array.isArray(agent.skills) || !agent.skills.includes("tdd"))
    throw new Error("agent.skills not array or missing 'tdd'");

  const list = await fetch(base + "/api/agents").then((r) => r.json());
  if (!list.agents.some((a) => a.name === "冒烟测试 Agent"))
    throw new Error("created agent not found in GET list");

  const dom = execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--virtual-time-budget=8000",
      "--dump-dom",
      base,
    ],
    { encoding: "utf-8", timeout: 30000 }
  );
  if (!dom.includes("创建 Agent")) throw new Error("create form not rendered");
  if (!dom.includes("冒烟测试 Agent"))
    throw new Error("created agent not rendered in browser list");

  console.log(
    "smoke OK: POST 201 (tools/skills arrays), list contains agent, browser renders form + agent"
  );
}

main().catch((e) => {
  console.error("SMOKE FAIL:", e.message);
  process.exit(1);
});
