# PC Assistant Tools (stage-tamagotchi)

Built-in tools that let AIRI act as a local PC assistant, plus recommended MCP
servers to extend it. Reads are free. Writes/executes are approval-gated unless
the target sits under a **free-access path** registered in
Settings → File access (writes/edits only; OS/program roots stay blocked).

## Built-in tools

| Tool | Capability | Approval | Service |
|---|---|---|---|
| `file_read` | Read a text file by absolute path (512KB cap, binary rejected) | none | `main/services/airi/file-access` |
| `file_list` | List a directory (name/type/size, 300 cap) | none | `file-access` |
| `search_files` | Recursively search a folder by filename or text content | none | `file-access` |
| `file_write` | Create/overwrite a text file with full content (keeps `.airi-bak`) | **dialog** (skipped under free-access paths) | `file-access` |
| `file_edit` | Replace an exact unique string in a file; dialog shows a diff (keeps `.airi-bak`) | **dialog (diff)** (skipped under free-access paths) | `file-access` |
| `run_command` | Run a shell command via cmd.exe (30s timeout, output capped) | **dialog** | `command-exec` |
| `clipboard_read` | Read clipboard text (16KB cap) | none | `desktop-io` |
| `clipboard_write` | Replace clipboard text | none | `desktop-io` |
| `screenshot` | Capture the full screen, or a single window by title (`window` arg), to a PNG under Pictures; return its path | none | `desktop-io` |
| `system_info` | Read CPU/memory usage, OS info, hostname, uptime | none | `system-info` |
| `daily_briefing` | Gather date/time + pending to-dos + upcoming reminders for a day-at-a-glance | none | `renderer` |
| `list_tool_categories` | List tool categories and whether each is enabled | none | `renderer` tool scoping |
| `set_tool_category` | Enable/disable a tool category (capability scoping) | none | `renderer` tool scoping |
| `add_todo` | Add a personal to-do item | none | `renderer` todos store |
| `list_todos` | List to-do items (pending by default) | none | `renderer` todos store |
| `complete_todo` / `remove_todo` | Mark done / remove a to-do by id or text | none | `renderer` todos store |
| `save_routine` | Save a named multi-step routine (macro) | none | `renderer` routines store |
| `run_routine` | Return a saved routine's steps to carry out with other tools | none | `renderer` routines store |
| `list_routines` / `delete_routine` | List or delete saved routines | none | `renderer` routines store |
| `calculate` | Evaluate an arithmetic expression exactly (no eval) | none | `renderer` calc |
| `convert_units` | Convert length/mass/data/time/temperature units | none | `renderer` calc |
| `list_windows` | List open windows (process + title) | none | `window-control` |
| `focus_window` | Bring a window to the front by title substring | none | `window-control` |
| `close_window` | Gracefully close a window by title substring | **dialog** | `window-control` |
| `remember` | Save a durable fact about the user (per character) | none | `stage-ui` memory store |
| `recall_memories` | Recall memories for the active character (optional query = semantic/embedding search, keyword fallback) | none | `stage-ui` memory store + local embedding worker |
| `forget` | Delete a remembered fact by id | none | `stage-ui` memory store |
| `set_timer` | Start a countdown timer (seconds/minutes); fires like a reminder | none | `renderer` reminders store |
| `set_reminder` | Schedule a reminder; fires as a proactive chat message + OS notification | none | `renderer` reminders store |
| `list_reminders` | List pending reminders with ids and fire times | none | `renderer` reminders store |
| `cancel_reminder` | Cancel a pending reminder by id | none | `renderer` reminders store |

Tools are registered into the `widgets` and `artistry` toolsets in
`renderer/stores/chat-sync.ts`. OS-privileged services (file/command/desktop)
are registered **once** on a window-less context via
`main/services/airi/desktop-assistant`; the renderer memory tools call the
`packages/stage-ui` memory store directly (no IPC — it lives in IndexedDB).

### Free-access paths (Settings → File access)

Users can register absolute folders (or files) where `file_write` / `file_edit`
skip the approval dialog. Persistence lives in Electron userData as
`file-access-free-access.json` via `createFreeAccessStore`. Rules:

- Reads/lists/search stay free everywhere (unchanged).
- Free-access only affects write/edit approval.
- OS / Program Files / ProgramData writes stay blocked even if registered.
- Whole drive roots (`C:\`) cannot be registered.
- Symlink/junction targets are realpath'd before free-access and block checks.
- Overwrites still write a `.airi-bak` backup.
- Settings UI: `apps/stage-tamagotchi/src/renderer/pages/settings/file-access.vue`.
- **Model visibility:** each time tools are resolved, `fileAccessTools()` loads
  the registered paths and injects them into tool descriptions + parameter
  hints. When the user says "write a file" without a path, the model is
  instructed to use the first free-access folder (not Desktop/Documents).

### Usage examples

What the user can say in chat to trigger each tool:

| Say this | Triggers |
|---|---|
| "F:\notes\todo.md 읽고 요약해줘" | `file_read` |
| "바탕화면에 뭐 있어?" | `file_list` |
| "문서 폴더에서 계약서 파일 찾아줘" | `search_files` (name) |
| "어느 파일에 'API_KEY'가 들어있어?" | `search_files` (content) |
| "메모.txt 만들고 회의 내용 적어줘" | `file_write` → approval dialog (or auto-write under free-access path) |
| "config.json에서 port를 8080으로 바꿔줘" | `file_edit` → approval dialog with diff (or auto-edit under free-access path) |
| "메모장 열어줘" / "npm run build 실행해줘" | `run_command` → approval dialog |
| "방금 복사한 거 정리해줘" | `clipboard_read` |
| "이 결과 클립보드에 넣어줘" | `clipboard_write` |
| "지금 화면 캡처해줘" | `screenshot` (full screen, saved to Pictures) |
| "VMware 창만 캡처해줘" | `screenshot({ window: "VMware" })` (single window) |
| "메모리 얼마나 쓰고 있어?" / "내 PC 사양 알려줘" | `system_info` |
| "뭐가 CPU 잡아먹고 있어?" | `system_info` + `run_command` (tasklist) |
| "내 이름은 꿀보야, 기억해" | `remember` |
| "나에 대해 뭘 알고 있어?" | `recall_memories` |
| "그 사실은 잊어줘" | `forget` |
| "10분 타이머 맞춰줘" / "30초 타이머" | `set_timer` |
| "30분 뒤에 스트레칭하라고 알려줘" | `set_reminder` |
| "예약된 알림 뭐 있어?" | `list_reminders` |
| "그 알림 취소해줘" | `cancel_reminder` |
| "오늘 하루 브리핑해줘" / "내 하루 어때?" | `daily_briefing` (+ weather/news) |
| "프로젝트 관리 도구는 꺼줘" | `set_tool_category` (project off) |
| "넌 어떤 기능들을 켤 수 있어?" | `list_tool_categories` |
| "장보기 할 일에 추가해줘" | `add_todo` |
| "내 할 일 뭐 있어?" | `list_todos` |
| "우유 사기 완료했어" | `complete_todo` (text match) |
| "1234 곱하기 56 나누기 7 계산해줘" | `calculate` |
| "100 화씨는 섭씨로 몇 도야?" | `convert_units` |
| "아침 루틴 저장해줘: 날씨 확인하고 할 일 알려줘" | `save_routine` |
| "아침 루틴 실행해줘" | `run_routine` → carries out the steps with other tools |
| "지금 열린 창 뭐 있어?" | `list_windows` |
| "메모장 창 앞으로 가져와줘" | `focus_window` |
| "그 브라우저 창 닫아줘" | `close_window` → approval dialog |

### Reminders

`set_reminder`/`list_reminders`/`cancel_reminder` schedule timers in the
renderer (`stores/reminders.ts`), persisted to localStorage so they survive
reloads — `initialize()` re-arms them at startup and past-due ones fire shortly
after. On fire, AIRI appends a proactive assistant message to the active chat
session and shows an OS notification via the main process
(`electronNotify` → `desktop-io`). Max delay ~30 days, armed in chunks of at
most `MAX_SAFE_TIMEOUT_MS` so a long delay never hits setTimeout's 32-bit
overflow (which would fire it immediately). `set_timer`
(`tools/builtin/timer.ts`) is a countdown built on the same store/scheduler —
it adds second-level precision and appears in `list_reminders`/`cancel_reminder`.

### Long-term memory

`remember`/`recall_memories`/`forget` persist memories to IndexedDB, scoped per
character card, surviving restarts. Each memory has a `kind` —
`instruction` (a standing request), `decision`, `event`, `preference`, or
`fact` — so the assistant can tell "what you asked me to do" from "what we
decided" from "facts about you". Memories are injected into the system message
as a `## What you remember` section grouped by kind, with dates on
instructions/decisions/events (`packages/stage-ui/src/stores/chat/memory-store.ts`,
`...stores/chat/session-store.ts`). The section is refreshed on every send, so
a freshly remembered item reaches the next turn. Empty memory yields an empty
string (KV-cache stable; dates are absolute `YYYY-MM-DD`, not relative, to keep
the prefix stable). Pre-`kind` records migrate to `fact` on load. Secrets must
not be stored (the conversational-style prompt instructs the model accordingly).

**Automatic capture.** Besides the explicit `remember` tool, after every chat
turn a background extraction (`stores/memory-capture.ts`, fired from
`chat-sync.ts` `executeIngest`) asks the model to pull durable
instructions/decisions/events/preferences/facts from the just-finished turn and
stores any new ones — so important things are retained even when the model
forgets to call `remember`. It is non-blocking (does not delay the reply),
best-effort (never throws), passes the user's existing memories to the
extractor so paraphrases are not re-saved, caps items per turn, and is gated on
the `memory` tool category being enabled. The extractor is instructed to skip
questions, one-off requests, small talk, and secrets.

**Relevance-bounded recall.** As memory grows, the prompt does not dump
everything: `selectMemoriesForPrompt` always keeps instructions/decisions/
preferences (low-volume, durable) but only the most recent
`PROMPT_RECENT_EVENT_FACT_LIMIT` events/facts. The rest stay reachable —
`recall_memories` takes an optional `query` so the model can pull older
facts/events on demand. `daily_briefing` also surfaces standing `instruction`
memories alongside one-off to-dos and upcoming reminders, tying recurring
requests and tasks into one day-at-a-glance.

**Semantic (embedding) recall.** When `recall_memories` is given a `query`, it
recalls by *meaning*, not just literal substring: `semanticRecall`
(`stores/chat/memory-embeddings.ts`) embeds the query and each memory with a
small local sentence-transformer (`Xenova/all-MiniLM-L6-v2`, 384-dim, ~23MB)
running in a worker — fully offline, no provider/API key required — and ranks
by cosine similarity (`rankMemoriesBySimilarity`, default top-8, min score
0.3). Vectors are computed lazily and cached on each `MemoryItem`
(`embedding` + `embeddingModel`) in IndexedDB, so a memory is embedded once and
reused; backfill is bounded per call (`MAX_BACKFILL_PER_RECALL`). It is
best-effort and degrades gracefully: if the worker/model fails, the query
embed throws, or nothing clears the similarity threshold, it falls back to
keyword `searchMemories` — recall is never worse than the substring path. The
pure ranking math (`cosineSimilarity`, `rankMemoriesBySimilarity`,
`memoriesNeedingEmbedding`) lives in `memory-store.ts` and is unit-tested.

Usage example — the user changes wording but the meaning matches:

```
User: "내가 평소에 뭘 마시는지 기억해?"   (do you remember what I usually drink?)
  -> recall_memories({ query: "what do I drink" })
     embeds the query, cosine-ranks memories
     -> ["Likes green tea", "Enjoys coffee in the morning"]   (matched by meaning,
        even though neither stored memory contains the word "drink")
Assistant: "녹차를 즐겨 마시고, 아침에는 커피도 드시죠."
```

Omit `query` to list everything (no embedding work):

```
recall_memories({})  ->  all memories, each with { id, kind, text }
```

### Capability scoping

Tools are grouped into toggleable categories (`stores/tool-categories.ts`):
`files`, `system`, `productivity`, `memory`, `math`, `web`, `creative`,
`project`. `chat-sync.ts`'s `resolveTools` only assembles the **enabled**
categories (plus the always-on scoping tools), so weak local models are not
flooded with every tool at once. State persists in
`stores/assistant-tools-settings.ts` (localStorage). Defaults: everything on
except `project` (git-bound work-item management — not a personal-assistant
feature). The user controls it conversationally via `list_tool_categories` /
`set_tool_category` (no settings UI needed); changes apply on the next message.

### Capability discovery

The conversational-style system prompt
(`packages/stage-ui/src/constants/prompts/conversational-style.ts`) includes a
short "What you can do on this computer" summary. With two dozen-plus built-in
tools plus MCP tools exposed at once, a weak local model otherwise has to infer its
abilities from tool schemas alone; the summary improves tool selection and
willingness to act. Keep it concise and update it when capability areas change
(not per individual tool).

### Safety model

- **Reads are free, every action is gated or blocked.** `file_write` and
  `run_command` always show a native dialog whose default button is *Deny*.
- `file_write`/`file_edit` block writes into OS/program directories; the target
  is first resolved with `realpath` (following symlinks/junctions) and stripped
  of trailing dots/spaces so canonicalization tricks cannot bypass the
  blocklist. `run_command` blocks an explicit list of destructive commands
  (format, recursive delete incl. PowerShell aliases, registry/firewall/AV
  changes, shutdown, shadow-copy deletion, encoded PowerShell) before the dialog.
  These denylists are best-effort defense-in-depth behind the approval dialog,
  not a hard sandbox boundary.
- Policy logic lives in pure, unit-tested `policy.ts` modules per service.

### Reliability & provider compatibility

Cross-cutting invariants established during review — keep them when editing tools:

- **Strict-mode schemas.** xsai `tool()` defaults `strict: true`, which forces
  `additionalProperties: false` but does **not** add optional keys to
  `required` — a schema OpenAI-strict providers reject. Any tool with optional
  parameters must declare `strict: false` (e.g. `search_files`, `run_command`,
  `set_timer`, `list_todos`, `image_journal`), matching `createFlattenedMcpTools`.
- **Light schemas for weak models.** The hand-authored `stage_widgets` and
  `stage_project_management` schemas require only `action`; per-action fields
  are validated at runtime, so the model isn't forced to emit large payloads.
- **Timer/reminder delays** are armed in chunks to avoid the setTimeout 32-bit
  overflow (see Reminders above).
- **`calculate`** enforces per-function arity (e.g. `abs` takes exactly one arg)
  instead of silently ignoring extras.
- **`focus_window`/`close_window`** escape PowerShell `-like` wildcards in the
  match string so `*`/`?`/`[` can't match an arbitrary window.
- **Store ids** (reminders/todos/memory) use a monotonic per-session counter,
  not `Date.now()+listLength`, which collided and was reused after removals.

### Known limitations

- `run_command` runs single commands with no transactional rollback.
- `file_edit` replaces one exact unique string per call (no fuzzy/multi-edit);
  `file_write` replaces whole content. Both show an approval dialog —
  `file_edit`'s shows a line diff.
- `screenshot` returns a file path, not an inline image — wiring tool-result
  images into the next LLM turn (vision) is a separate, provider-dependent
  feature and is not implemented.
- `screenshot` can target a single window by title (`window` arg, matched
  case-insensitively, shortest title wins) via `desktopCapturer` window
  sources; without it the full primary screen is captured. A minimized window
  yields an empty thumbnail (the tool asks the user to bring it to the front),
  and some GPU-accelerated apps (e.g. certain VM or game windows) can render a
  black DWM thumbnail — fall back to full-screen capture in that case.
- Memory recall is semantic when `recall_memories` is given a `query` (local
  `Xenova/all-MiniLM-L6-v2` embeddings, cosine ranking) with a keyword/substring
  fallback; the prompt itself still keeps all durable items plus the most recent
  events/facts, with older ones reachable on demand via `recall_memories`. The
  embedding worker downloads the model (~23MB) on first semantic recall, then
  caches it; vectors are cached per memory in IndexedDB. Prompt-time memory
  selection is still recency/kind-based (not embedding-ranked) to stay
  KV-cache stable — semantic ranking applies to on-demand `recall_memories`.
- GUI control is limited to window management (list/focus/close). Mouse and
  keyboard injection are intentionally not implemented — they need native
  modules (nut.js/robotjs) and carry a high misfire risk. The
  `@proj-airi/computer-use-mcp` service is macOS-only and does not apply here.
- `search_files` is keyword/substring search (filename + text content), not
  semantic RAG: no embeddings or index, so it is always current but matches
  literal text only. Semantic document search is a possible future step.

> When adding a new assistant tool, update this file in the same change:
> add a row to the tools table, a chat usage example, and note any approval
> gate or limitation. If the tool has any optional parameter, declare it
> `strict: false` (see Reliability & provider compatibility).

## Recommended MCP servers

Add these under `mcpServers` in the app's `mcp.json`
(Settings → Modules → MCP server → "open config file"), then "Apply & Restart".
All are stdio servers launched via `npx` (Node required on PATH).

```jsonc
{
  "mcpServers": {
    // Web search (already configured this session)
    "tavily": {
      "command": "npx",
      "args": ["-y", "tavily-mcp@latest"],
      "env": { "TAVILY_API_KEY": "tvly-..." },
      "enabled": true
    },
    // Sandboxed filesystem access scoped to explicit roots (safer than the
    // built-in file tools when you want to hard-limit reachable folders)
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\me\\Documents"],
      "enabled": true
    },
    // Git repository operations (status, diff, log, commit) on a local repo
    "git": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-git", "--repository", "F:\\path\\to\\repo"],
      "enabled": false
    },
    // Persistent knowledge-graph memory across sessions
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "enabled": false
    }
  }
}
```

MCP tools are flattened into first-class entries (`mcp_<server>_<tool>`) so
local models can call them directly without the list-then-call discovery hop
(see `packages/stage-ui/src/tools/mcp.ts`).

> Verify the exact package name and args on each server's npm page before
> enabling; the MCP ecosystem renames packages often.
