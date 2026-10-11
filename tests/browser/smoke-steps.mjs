// 冒烟/审计运行器的共享步骤控制：--from-step=<id> / --only-step=<id> / --list-steps。
//
// 纪律（AGENTS.md 与执行策略）：
// - 不带任何参数时默认全量跑，行为与引入本模块前完全一致（不打印额外日志、不改任何断言）；
// - 最终 DoD 验证必须不带参全量跑每个脚本；切片运行只用于修复期间的局部反馈；
// - 被跳过的步骤不会重建其前置状态——请选择自足切片（自带导航/夹具入口的步骤，自足性见各脚本头注）。
//
// 用法（脚本内，须在 spawn 任何服务之前创建）：
//   import { createStepGate } from "./smoke-steps.mjs";
//   const gate = createStepGate("browser-smoke", ["home-empty", "project-shell", ...]);
//   if (gate.listOnly) process.exit(0);          // --list-steps：只打印步骤表，不启动任何服务
//   ...
//   if (gate.run("project-shell")) { ...原有代码... }
//   gate.assertResolved();                        // try 体内最后一个 gate 之后调用

function parseStepArgs(rawArgs) {
  const args = { fromStep: null, onlyStep: null, list: false };
  for (const raw of rawArgs) {
    if (raw === "--list-steps") args.list = true;
    else if (raw.startsWith("--from-step=")) args.fromStep = raw.slice("--from-step=".length);
    else if (raw.startsWith("--only-step=")) args.onlyStep = raw.slice("--only-step=".length);
    else if (raw.startsWith("--")) throw new Error(`smoke-steps: unknown argument "${raw}"`);
  }
  if (args.fromStep && args.onlyStep) {
    throw new Error("smoke-steps: --from-step 与 --only-step 互斥，二者只能取一");
  }
  return args;
}

export function createStepGate(label, declaredSteps, rawArgs = process.argv.slice(2)) {
  const args = parseStepArgs(rawArgs);
  const declared = [...declaredSteps];
  const slicing = Boolean(args.fromStep || args.onlyStep);
  const ran = [];
  const skipped = [];
  const seen = new Set();
  let activated = !args.fromStep;
  let targetSeen = false;

  if (args.list) {
    console.log(`STEPS [${label}] ${declared.join(", ")}`);
    return {
      args,
      listOnly: true,
      slicing: false,
      run: () => false,
      assertResolved: () => {},
      summary: () => ({ label, listOnly: true, steps: [...declared] }),
    };
  }

  const target = args.onlyStep ?? args.fromStep;
  if (target && !declared.includes(target)) {
    throw new Error(`${label}: 未知步骤 "${target}"；已知步骤：${declared.join(", ")}`);
  }

  function run(id) {
    if (!declared.includes(id)) {
      throw new Error(`${label}: 未声明的步骤 "${id}"（须与 createStepGate 的步骤表一致）`);
    }
    if (seen.has(id)) throw new Error(`${label}: 重复执行步骤 "${id}"`);
    seen.add(id);
    let active = true;
    if (args.onlyStep) {
      active = id === args.onlyStep;
      if (active) targetSeen = true;
    } else if (args.fromStep) {
      if (!targetSeen && id === args.fromStep) {
        activated = true;
        targetSeen = true;
      }
      active = activated;
    }
    if (active) {
      ran.push(id);
      if (slicing) console.log(`STEP [${label}] ${id}`);
    } else {
      skipped.push(id);
      if (slicing) console.log(`SKIP [${label}] ${id}`);
    }
    return active;
  }

  function assertResolved() {
    const missing = declared.filter((id) => !seen.has(id));
    if (missing.length > 0) {
      throw new Error(`${label}: 步骤表与代码不一致，未到达：${missing.join(", ")}`);
    }
    if (target && !targetSeen) {
      throw new Error(`${label}: 目标步骤 "${target}" 未执行`);
    }
    return ran;
  }

  function summary() {
    return { label, fromStep: args.fromStep, onlyStep: args.onlyStep, ran: [...ran], skipped: [...skipped] };
  }

  return { args, run, assertResolved, summary, slicing, listOnly: false };
}
