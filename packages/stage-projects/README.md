# @proj-airi/stage-projects

Local project-management domain models for AIRI's desktop project board and worker/reviewer runner.

## What It Does

- Defines project, work item, run record, comment, and agent settings types.
- Provides Valibot schemas for persisted project-management state.
- Provides board helpers for status grouping, ordering, and runner status transitions.
- Supplies defaults for project manager, worker, and reviewer model configuration, including provider selection contracts.

## When To Use It

Use this package when code needs shared project-management data contracts across Electron main, renderer settings, the localhost project board, chat tools, or tests.

Do not put Electron IPC, filesystem, git, HTTP server, or model-provider runtime code here. Those belong to the app service layers, such as `apps/stage-tamagotchi/src/main/services/airi/project-management` and `apps/stage-tamagotchi/src/main/services/airi/project-runner`.

## Board Design Notes

The localhost board is rendered by the desktop app's project-board server. Its current design follows common patterns from GitHub Projects and Linear:

- Dense columns with stable status counts for fast scanning.
- Clear status accents on the left edge of cards instead of large decorative surfaces.
- Project-level flow metrics for total, active, done, and blocked work.
- A sticky detail panel so review notes, branch names, and worktree paths stay visible while scanning cards.
- No `cancelled` work-item status. Work that should no longer exist is deleted instead of moved to another terminal column.

Keep board changes utilitarian and readable. Prefer small visual cues, stable dimensions, and concise card metadata over marketing-style layouts.

## Agent Roles

Project-management automation uses three roles:

- Project Manager: prepares a concise implementation brief before execution. It does not edit files. Its output is passed to both Worker and Reviewer so the run has a shared plan, risk list, review focus, and suggested checks.
- Worker: reads, searches, edits, and runs allowed shell commands in the agent worktree.
- Reviewer: checks the Worker result against the work item, acceptance criteria, project-manager brief, diff, and test summary.

The Project Manager model is separate from the main chat consciousness model. Main chat still uses the `settings/consciousness/*` selection; project automation uses the project-management settings here.

Run records now keep the small orchestration artifact that makes chat and board progress answers useful: lifecycle phase, worktree state, project-manager plan summary, plan steps, risk notes, review focus, verifier commands, and latest subtask progress. Status fields still drive the board columns; lifecycle fields explain what the runner is doing inside that column.

Verifier commands are optional project-management settings. When configured, AIRI prioritizes them before model-suggested checks and inferred package scripts, so teams can define a stable "definition of done" without relying on every Worker prompt to rediscover it.

Supported project-management providers:

- LM Studio, Ollama, and OpenRouter through OpenAI-compatible chat completions.
- Codex CLI through the installed `codex` command. The desktop app discovers selectable models by executing `codex debug models`, then runs configured roles through `codex exec --sandbox read-only --ask-for-approval never` so Codex CLI can reason in the project folder while AIRI keeps file edits inside the worker tool loop.

## Agent Stability Policy

Git-backed work items run in isolated git worktrees. Each runner invocation receives a unique `airi/work/<identifier>/<run-id>` branch and matching `.airi-worktrees/<project>/<identifier>/<run-id>` checkout. This avoids branch resets and folder reuse when retries or parallel agents finish close together.

When auto-commit is enabled, the worker commits in its isolated branch first. AIRI then serializes integration per original project and cherry-picks one completed agent branch at a time. If the original worktree is dirty or git reports a conflict, AIRI aborts the cherry-pick, leaves the agent branch and worktree intact, marks the work item blocked, and records a board comment for manual review.

If another agent has already applied the same patch, Git can report an empty cherry-pick. AIRI treats that as a successful skipped integration instead of a conflict, aborts the empty cherry-pick state, and leaves the original worktree clean.

When auto-commit is disabled, or when a reviewed change cannot be committed, AIRI preserves the agent worktree instead of deleting it. This keeps accepted but uncommitted edits inspectable from the board's worktree path.

This mirrors the practical worktree pattern used by modern coding-agent workflows: isolate authoring, review the small branch, then integrate through one ordered gate.

## Testing

Run focused tests while working on this package or the desktop runner:

```sh
pnpm exec vitest run packages/stage-projects/src/utils/board.test.ts
pnpm exec vitest run apps/stage-tamagotchi/src/main/services/airi/project-runner/git.test.ts
pnpm exec vitest run apps/stage-tamagotchi/src/main/services/airi/project-runner/orchestrator.test.ts
```

Before handing off broader project-management changes, also run:

```sh
pnpm -F @proj-airi/stage-projects typecheck
pnpm -F @proj-airi/stage-tamagotchi typecheck
pnpm lint:fix
```
