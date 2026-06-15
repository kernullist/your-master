# AIRI — Personal PC Assistant Fork

> This is a downstream fork of [moeru-ai/airi](https://github.com/moeru-ai/airi).
> The upstream project README is preserved as [`README.md`](./README.md); this
> file documents **only what this fork adds on top of upstream**.

This fork extends the AIRI desktop app (`apps/stage-tamagotchi`, Electron) into a
capable, reliable **personal PC assistant on Windows**, with a natural-feeling
chat and a durable long-term memory. Everything below is additive: the character,
stage, and chat experience from upstream are unchanged unless noted.

The authoritative, always-current reference for the assistant tools (full table,
parameters, approval behavior, usage examples, limitations) is
[`docs/ai/context/pc-assistant-tools.md`](./docs/ai/context/pc-assistant-tools.md).
This page is a high-level summary and changelog.

## What this fork adds

### PC-assistant tool suite

Tools the model can call to act on the computer. Read-only actions run freely;
every **write or execute** action is gated behind an approval dialog.

- **Files** — read files, list folders, recursively search a folder by filename
  or content, and (with approval) create / overwrite / edit. `file_edit` shows a
  line diff in the approval dialog and keeps a `.airi-bak` backup.
- **Commands** — run a shell command via `cmd.exe` with approval (30s timeout,
  output capped). A best-effort blocklist rejects obviously destructive commands.
- **Desktop I/O** — read/write the clipboard, take a **screenshot** (full screen,
  or a single window by title — e.g. capture only the VMware window), and read
  system info (CPU / memory / OS / hostname / uptime).
- **Window control** — list open windows, bring one to the front, or (with
  approval) close one, matched by title.

### Productivity

- **Reminders** — schedule a reminder spoken proactively when it elapses
  (chunked timers avoid the 32-bit `setTimeout` overflow that fired long-delay
  reminders immediately).
- **Timers** — countdown timers.
- **To-dos** — a personal pending-task list.
- **Routines** — saved multi-step workflows.
- **Daily briefing** — a day-at-a-glance combining date/time, pending to-dos,
  standing instructions, and upcoming reminders.
- **Calculator** — arithmetic and unit conversion with per-function arity checks.

### Long-term memory

A permanent, per-character memory stored in IndexedDB that survives restarts.

- **Typed memories** — each item is an `instruction` / `decision` / `event` /
  `preference` / `fact`, so the assistant can tell "what you asked me to do" from
  "what we decided" from "facts about you". Injected into the prompt grouped by
  kind, with absolute dates on the time-relevant kinds (KV-cache stable).
- **Automatic capture** — after each turn a background extractor pulls durable
  items from the conversation and stores new ones, so things are retained even
  when the model forgets to call `remember`. Non-blocking, best-effort, and
  paraphrase-deduplicated.
- **Relevance-bounded recall** — the prompt keeps all durable items plus only the
  most recent events/facts; older ones stay reachable on demand.
- **Semantic (embedding) recall** — `recall_memories` with a query retrieves by
  *meaning*, not just literal substring, using a small local sentence-transformer
  (`Xenova/all-MiniLM-L6-v2`, runs offline in a worker) and cosine ranking, with
  cached per-memory vectors and a keyword fallback.

Secrets / passwords / sensitive data are never stored (enforced in the prompt and
the extractor instructions).

### Capability scoping

Tools are grouped into toggleable categories (`files`, `system`, `productivity`,
`memory`, `math`, `web`, `creative`, `project`). The chat assembles only the
**enabled** categories, so weak local models are not flooded with every tool at
once, and the assistant can self-toggle categories conversationally.

### Chat & provider reliability

- Reasoning-model streaming handling (`reasoning_content` vs `content`), an
  empty-response guard, and history windowing for natural, dependable replies.
- MCP tool flattening, fuzzy tool-name self-correction, and an active-tools merge
  so tools work with weak local models.
- Provider-compatibility hardening for OpenAI-strict providers (`strict: false`
  on tools that expose optional parameters).
- Security hardening: realpath-resolved write paths, command blocklists, and an
  approval dialog on every write/execute action.

### Developer experience

- **App run/stop scripts** — [`scripts/app-start.ps1`](./scripts/app-start.ps1)
  and [`scripts/app-stop.ps1`](./scripts/app-stop.ps1) launch/terminate the
  Electron dev app as a detached, log-redirected background process.
- **Non-blocking MCP startup** — MCP stdio servers connect in the background
  (concurrently, each with a connect timeout) instead of blocking the app window
  for ~30s while an `npx`-based server cold-starts.
- **Stable dev reloads** — lazily-imported heavy deps (embeddings, TTS) are
  pre-bundled via `optimizeDeps.include` so Vite no longer re-optimizes
  mid-session and force-reloads the renderer.

## Running the fork (dev)

```powershell
# from the repo root
pnpm install
./scripts/app-start.ps1          # start the Electron desktop app (background)
./scripts/app-stop.ps1           # stop it
```

Per-package commands (typecheck / test / lint) follow the upstream conventions in
[`AGENTS.md`](./AGENTS.md), e.g.:

```bash
pnpm -F @proj-airi/stage-tamagotchi typecheck
pnpm exec vitest run <path/to/file>
pnpm lint:fix
```

## Where to read more

- [`docs/ai/context/pc-assistant-tools.md`](./docs/ai/context/pc-assistant-tools.md)
  — full tool reference, approval behavior, usage examples, and known limitations.
- [`AGENTS.md`](./AGENTS.md) — contributor guide, project structure, and coding
  conventions (inherited from upstream).
- [`README.md`](./README.md) — the upstream Project AIRI README.
