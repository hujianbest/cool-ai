import { execSync } from "node:child_process";

const chrome = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const url = process.env.PROBE_URL || "http://localhost:3000";

const dom = execSync(
  `"${chrome}" --headless=new --disable-gpu --no-sandbox --virtual-time-budget=8000 --dump-dom ${url}`,
  { encoding: "utf8", timeout: 30000 }
);

if (!dom.includes("骨架 Agent")) {
  throw new Error("rendered DOM missing '骨架 Agent' (client-side fetch did not render real data)");
}
if (!/<aside[\s>]/i.test(dom)) {
  throw new Error("rendered DOM missing <aside> landmark");
}
if (!/<main[\s>]/i.test(dom)) {
  throw new Error("rendered DOM missing <main> landmark");
}

console.log("render-check OK: real-browser DOM (after JS) contains '骨架 Agent' + <aside>/<main> landmarks");
