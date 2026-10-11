// 冒烟/审计运行器的进程收尾助手：posix 下补「按端口反查」兜底，避免孤儿 next 进程占端口。
// 背景：win32 分支用 taskkill /T /F 能回收进程树；posix 只对父进程 SIGTERM 时，
// next dev/next start 的子进程可能存活并继续监听端口，导致下一轮运行对着旧进程假绿或被占端口。
import { spawnSync } from "node:child_process";

function listeningPids(port) {
  const result = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    return false;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  spawnSync("sleep", [String(milliseconds / 1000)]);
}

// 回收监听指定端口的进程（SIGTERM → 宽限 → SIGKILL）。
export function sweepPort(port, { graceMilliseconds = 3_000, label = "" } = {}) {
  const pids = listeningPids(port);
  for (const pid of pids) {
    signal(pid, "SIGTERM");
  }
  const deadline = Date.now() + graceMilliseconds;
  while (Date.now() < deadline && pids.some(alive)) delay(200);
  for (const pid of pids.filter(alive)) {
    signal(pid, "SIGKILL");
    console.log(`RUNNER: killed (SIGKILL) ${label} pid=${pid} port=${port}`);
  }
  for (const pid of pids) {
    if (!alive(pid)) console.log(`RUNNER: reclaimed ${label} pid=${pid} port=${port}`);
  }
}

// 停止子进程并确认端口释放；posix 下若父进程退出后端口仍被占用，则按端口清扫。
export function stopServerTree(child, { port, label = "server" } = {}) {
  if (child?.pid) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        // 进程可能已退出。
      }
    }
  }
  if (port && process.platform !== "win32") {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && listeningPids(port).length > 0) delay(200);
    if (listeningPids(port).length > 0) sweepPort(port, { label });
  }
}
