const base = process.env.PROBE_URL || "http://localhost:3000";

async function main() {
  const home = await fetch(base + "/");
  const homeText = await home.text();
  if (home.status !== 200) throw new Error("home status " + home.status);
  if (!homeText.includes("COOL AI")) throw new Error("home HTML missing 'COOL AI'");

  const api = await fetch(base + "/api/agents");
  const apiJson = await api.json();
  if (!Array.isArray(apiJson.agents)) throw new Error("/api/agents.agents not array");
  if (apiJson.agents.length === 0) throw new Error("/api/agents.agents empty");

  console.log("home OK: status 200, contains 'COOL AI'");
  console.log("api OK: agents =", JSON.stringify(apiJson.agents));
}

main().catch((e) => {
  console.error("PROBE FAIL:", e.message);
  process.exit(1);
});
