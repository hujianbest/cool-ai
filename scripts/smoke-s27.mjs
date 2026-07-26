import { execFileSync } from "node:child_process";

const base = process.env.PROBE_URL || "http://localhost:3000";
const chrome =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function assertNoApiKey(obj, where) {
  const s = JSON.stringify(obj);
  if (/apiKey/i.test(s)) throw new Error(`apiKey leaked in ${where}: ${s}`);
}

async function main() {
  const res = await fetch(base + "/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "冒烟 provider",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "should-not-leak",
    }),
  });
  if (res.status !== 201) throw new Error("POST /api/providers status " + res.status);
  const { config } = await res.json();
  assertNoApiKey(config, "POST response.config");
  if (!config.id) throw new Error("config has no id");

  const listRes = await fetch(base + "/api/providers");
  const list = await listRes.json();
  assertNoApiKey(list, "GET /api/providers");
  const created = list.configs.find((c) => c.name === "冒烟 provider");
  if (!created) throw new Error("created provider not in list");

  const agentRes = await fetch(base + "/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "冒烟 agent",
      providerConfigId: config.id,
      model: "glm-4-plus",
    }),
  });
  if (agentRes.status !== 201) throw new Error("POST /api/agents status " + agentRes.status);

  const list2 = await fetch(base + "/api/providers").then((r) => r.json());
  const c2 = list2.configs.find((c) => c.name === "冒烟 provider");
  if (!c2 || c2.agentCount !== 1)
    throw new Error("agentCount expected 1, got " + (c2 && c2.agentCount));

  const dom = execFileSync(
    chrome,
    ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=8000", "--dump-dom", base],
    { encoding: "utf-8", timeout: 30000 }
  );
  if (!dom.includes("冒烟 provider")) throw new Error("provider not rendered");
  if (!dom.includes("冒烟 agent")) throw new Error("agent not rendered");
  if (!dom.includes("glm-4-plus")) throw new Error("model not rendered");
  if (/should-not-leak/.test(dom)) throw new Error("apiKey leaked into DOM");

  console.log("smoke OK: provider created (no apiKey leak), agent linked, agentCount=1, browser renders provider+agent+model (no key)");
}

main().catch((e) => {
  console.error("SMOKE FAIL:", e.message);
  process.exit(1);
});
