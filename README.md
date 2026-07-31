# Cool AI collaboration cockpit

This walking skeleton proves one real path through the application: create a project, run the deterministic example Agent, persist every task state in SQLite, and recover it after refresh.

## Requirements

- Node.js 24.x and the bundled npm 11.x
- Windows, macOS, or Linux

## Install

```powershell
npm install
```

## Run locally

```powershell
npm run dev
```

Open `http://localhost:3000`. Local data is stored in `.data/cockpit.sqlite` by default. To use another location, set `COCKPIT_DB_PATH` before starting:

```powershell
$env:COCKPIT_DB_PATH='D:\temp\cockpit.sqlite'
npm run dev
```

Team model-service credentials also require a process-local 32-byte master key. Generate a fresh base64url value rather than copying a key from documentation or committing one:

```powershell
$env:COCKPIT_MASTER_KEY = node -e 'const { randomBytes } = require("node:crypto"); process.stdout.write(randomBytes(32).toString("base64url"))'
npm run dev
```

Keep `COCKPIT_MASTER_KEY` in the local process environment or your deployment secret manager. The database stores only encrypted provider credentials; losing or changing this key makes existing credentials unavailable and requires replacing them through Team settings.

## Test and build

Run the complete automated suite:

```powershell
npm test
```

Create a production build:

```powershell
npm run build
```

## Real browser smoke

Install the Chromium runtime once:

```powershell
npx playwright install chromium
```

Then run the end-to-end browser check:

```powershell
npm run smoke
```

The smoke command starts the real app on an isolated port with a temporary `COCKPIT_DB_PATH`, creates and reloads persisted data, checks the narrow layout and keyboard drawers, writes screenshots under `features/001-walking-skeleton/evidence/`, and removes its temporary database.

Run the separate S-2 Team configuration smoke with:

```powershell
npm run smoke:team
```

This command generates an ephemeral `COCKPIT_MASTER_KEY`, temporary SQLite database, and local OpenAI-compatible provider. It validates provider credential boundaries, creates and edits a skill, creates two distinct Agents, verifies refresh persistence and desktop/narrow accessibility, scans runtime surfaces for secret leakage, writes S-2 screenshots, and removes all temporary runtime state.

Run the complete S-3 project-context browser acceptance with:

```powershell
npm run smoke:context
```

This isolated Playwright harness creates a temporary workspace, SQLite database, master key, and local provider. It drives Team prerequisites and the complete workspace→members→mission/DAG→memory→context path, verifies refresh persistence and desktop/narrow keyboard modals, and writes the three S-3 screenshots. Its operation audit requires `content read/enumerate/write/exec = 0`; logs, error responses, and snapshots are also scanned according to the project path and Provider secret boundaries. All temporary runtime state is removed in `finally`.

Run the complete S-4 collaboration orchestration smoke with:

```powershell
npm run smoke:collaboration
```

This isolated browser harness starts the real app and a local OpenAI-compatible provider with a temporary workspace, SQLite database, and generated encryption key. It configures encrypted credentials and two distinct Agents, then drives primary and repair model calls through task proposal/claim, handoff, owner mention, decision answer, valid usage, and planned state. Refresh and process-restart recovery, current-Agent private separation, outbound prompt allowlists, product-surface secret/CoT scans, desktop keyboard behavior, and the narrow keyboard surface are verified before the two S-4 demo screenshots are written. Temporary runtime state is always removed.

Run the S-5 safe parallel execution smoke with:

```powershell
npm run smoke:execution
```

This verification-only harness starts an isolated app, SQLite database, generated master key, real temporary workspace, execution root, and local OpenAI-compatible provider. It drives two independent in-progress tasks through concurrent Agent model/file edits, standing and exact one-shot command authorization, staged review, nonoverlapping merge, replay and budget boundaries, stale/conflict/manual recovery contracts, refresh/restart persistence, and desktop/narrow keyboard UI. It scans provider bodies, database text, product API bodies, DOM, logs, and screenshot-facing surfaces for credentials, ciphertext, raw host paths, environment markers, and hidden reasoning. The harness writes `demo-execution-desktop.png` and `demo-execution-narrow.png` under the S-5 evidence directory and removes all temporary runtime state.

## Troubleshooting

- **Wrong Node version:** run `node --version`; this repository expects Node.js 24.x because it uses `node:sqlite`.
- **Port 3000 is occupied:** run `npm run dev -- --port 3001`, then open `http://localhost:3001`.
- **Data directory is not writable:** set `COCKPIT_DB_PATH` to a writable absolute path. The app does not fall back to in-memory storage.
- **Chromium is missing:** rerun `npx playwright install chromium` before `npm run smoke`.
- **Team credentials are unavailable:** confirm the same valid `COCKPIT_MASTER_KEY` is present in every process that reads the database. Never replace it with an example or committed value.
- **Execution smoke cannot start:** confirm the temporary directory is writable and no security product is blocking isolated Node child processes.
- **Windows native SWC warning:** the scripts explicitly use Next.js Webpack so the supported WASM fallback can build and run on this host.
