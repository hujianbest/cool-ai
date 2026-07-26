import http from "node:http";

const base = process.env.PROBE_URL || "http://localhost:3000";

let receivedAuth = "";
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    receivedAuth = req.headers.authorization || "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ choices: [{ message: { content: "mock-llm-回答" } }] })
    );
  });
});

await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const port = mock.address().port;
const mockBase = `http://127.0.0.1:${port}`;

async function post(url, payload) {
  return fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

try {
  const pr = await post("/api/providers", { name: "mock-llm", baseUrl: mockBase, apiKey: "test-key" });
  const { config } = await pr.json();
  if (!config || !config.id) throw new Error("provider create failed");

  const ar = await post("/api/agents", { name: "冒烟 run agent", providerConfigId: config.id, model: "m" });
  const { agent } = await ar.json();
  if (!agent || !agent.id) throw new Error("agent create failed");

  const rr = await post(`/api/agents/${agent.id}/run`, { task: "你好" });
  const run = await rr.json();
  if (rr.status !== 200) throw new Error("run status " + rr.status + " " + JSON.stringify(run));
  if (run.output !== "mock-llm-回答") throw new Error("output mismatch: " + run.output);
  if (!Array.isArray(run.trace) || run.trace.length !== 3) throw new Error("trace length != 3");
  if (run.trace[0].role !== "system" || run.trace[2].role !== "assistant") throw new Error("trace shape");
  if (receivedAuth !== "Bearer test-key") throw new Error("upstream auth not forwarded: " + receivedAuth);
  if (/apiKey/i.test(JSON.stringify(run))) throw new Error("apiKey leaked in run response");

  console.log("smoke OK: run 200, output+trace(3), upstream Bearer forwarded, no apiKey leak");
} finally {
  mock.close();
}
