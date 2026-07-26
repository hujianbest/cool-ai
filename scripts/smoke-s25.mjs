import { execFileSync } from "node:child_process";

const base = process.env.PROBE_URL || "http://localhost:3000";
const chrome =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

async function main() {
  const skillRes = await fetch(base + "/api/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "冒烟 skill", description: "smoke", content: "## c", category: "test" }),
  });
  if (skillRes.status !== 201) throw new Error("POST /api/skills status " + skillRes.status);
  const { skill } = await skillRes.json();
  if (!skill.id) throw new Error("skill has no id");

  const agentRes = await fetch(base + "/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "冒烟 agent", tools: ["shell"], skills: [skill.id] }),
  });
  if (agentRes.status !== 201) throw new Error("POST /api/agents status " + agentRes.status);
  const { agent } = await agentRes.json();
  if (!Array.isArray(agent.skills) || !agent.skills.includes(skill.id))
    throw new Error("agent.skills not array or missing skill id");

  const idx = await fetch(base + "/api/skills").then((r) => r.json());
  const s = idx.skills.find((x) => x.name === "冒烟 skill");
  if (!s) throw new Error("created skill not in index");
  if (s.agentCount !== 1) throw new Error("agentCount expected 1, got " + s.agentCount);

  const dom = execFileSync(
    chrome,
    ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=8000", "--dump-dom", base],
    { encoding: "utf-8", timeout: 30000 }
  );
  if (!dom.includes("冒烟 skill")) throw new Error("skill name not rendered");
  if (!dom.includes("冒烟 agent")) throw new Error("agent name not rendered");
  if (!dom.includes("被 1 个 agent 关联")) throw new Error("agentCount not rendered in UI");

  console.log("smoke OK: skill created, agent linked, agentCount=1, browser renders skill + agent + count");
}

main().catch((e) => {
  console.error("SMOKE FAIL:", e.message);
  process.exit(1);
});
