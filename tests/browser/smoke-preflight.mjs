#!/usr/bin/env node
// 冒烟预检：任何 smoke / 审计运行器执行前先跑本脚本。
// - 清理归属本仓库的残留 next dev / next-server 进程（保留交互式 3000/3001 开发服务器）；
// - 确认 .next 锁（陈旧锁且进程已死则移除，活锁则报错退出）；
// - 清理超过 15 分钟的陈旧测试产物目录（.next-*-smoke-*、.next-audit-*、.next-probe-* 等）。
// 纪律：测试期间绝不回滚 tsconfig.json / next-env.d.ts；全部运行结束后统一 `git checkout -- tsconfig.json next-env.d.ts` 一次。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const keepPorts = new Set([3000, 3001]);
const staleMinutes = 15;
const problems = [];

function sh(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout : "";
}

function listeningPortsFor(pid) {
  const output = sh("lsof", ["-a", "-p", String(pid), "-i", "-P", "-n"]);
  const ports = new Set();
  for (const line of output.split("\n")) {
    const match = line.match(/:(\d+)\s+\(LISTEN\)/u);
    if (match) ports.add(Number(match[1]));
  }
  return ports;
}

function pidCwd(pid) {
  const output = sh("lsof", ["-p", String(pid)]);
  for (const line of output.split("\n")) {
    if (/(?:^|\s)cwd\s/u.test(line)) return line.trim().split(/\s+/u).at(-1);
  }
  return null;
}

function killProcessTree(pid, label) {
  try {
    process.kill(Number(pid), "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      process.kill(Number(pid), 0);
    } catch {
      break;
    }
    spawnSync("sleep", ["0.2"]);
  }
  try {
    process.kill(Number(pid), 0);
    process.kill(Number(pid), "SIGKILL");
    console.log(`PREFLIGHT: killed (SIGKILL) ${label} pid=${pid}`);
  } catch {
    console.log(`PREFLIGHT: killed ${label} pid=${pid}`);
  }
}

// 1) 残留 next 进程：按 cwd 归属本仓库判定；交互式开发端口 3000/3001 保留并提示。
const psOutput = sh("ps", ["-axo", "pid=,command="]);
const nextProcesses = [];
for (const line of psOutput.split("\n")) {
  const match = line.trim().match(/^(\d+)\s+(.*)$/u);
  if (!match) continue;
  const [, pid, command] = match;
  if (!/(?:next-server|next\/dist\/bin\/next\s+dev|next dev)/u.test(command)) continue;
  const cwd = pidCwd(pid);
  if (cwd !== repoRoot) continue;
  const ports = listeningPortsFor(pid);
  const reserved = [...ports].some((port) => keepPorts.has(port));
  nextProcesses.push({ pid, ports: [...ports], reserved });
}
if (nextProcesses.length === 0) {
  console.log("PREFLIGHT: no leftover next processes");
}
for (const entry of nextProcesses) {
  if (entry.reserved) {
    console.log(
      `PREFLIGHT: keep interactive dev server pid=${entry.pid} ports=${entry.ports.join(",")} (started manually?)`,
    );
    problems.push(`interactive dev server still running on port ${entry.ports.join(",")}`);
    continue;
  }
  killProcessTree(entry.pid, "leftover next server");
}

// 2) 陈旧测试产物目录（>15 分钟）。
let removed = 0;
for (const name of readdirSync(repoRoot)) {
  const isGeneratedTestDist = /^\.next-.*(?:smoke|audit|probe|hydration|thread|structured|settings|team).*$/u.test(name);
  if (!isGeneratedTestDist) continue;
  const full = join(repoRoot, name);
  const ageMinutes = (Date.now() - statSync(full).mtimeMs) / 60_000;
  if (ageMinutes < staleMinutes) {
    console.log(`PREFLIGHT: keep recent dist ${name} (age ${ageMinutes.toFixed(1)}m)`);
    continue;
  }
  rmSync(full, { recursive: true, force: true });
  removed += 1;
}
console.log(`PREFLIGHT: removed ${removed} stale dist dir(s)`);

// 3) .next 锁：Next 在 dev 启动时写 .next/lock（内容为 pid）。
const lockPath = join(repoRoot, ".next", "lock");
if (existsSync(lockPath)) {
  let lockPid = null;
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) lockPid = parsed;
  } catch {
    lockPid = null;
  }
  if (lockPid !== null) {
    let alive = true;
    try {
      process.kill(lockPid, 0);
    } catch {
      alive = false;
    }
    if (!alive) {
      rmSync(lockPath, { force: true });
      console.log(`PREFLIGHT: removed stale .next/lock (pid ${lockPid} not running)`);
    } else {
      problems.push(`.next/lock held by running pid ${lockPid}`);
      console.log(`PREFLIGHT: .next/lock held by live pid ${lockPid}`);
    }
  } else {
    console.log("PREFLIGHT: .next/lock present but unreadable; leaving as is");
  }
} else {
  console.log("PREFLIGHT: no .next/lock");
}

if (problems.length > 0) {
  console.error(`PREFLIGHT FAIL: ${problems.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log("PREFLIGHT OK");
}
