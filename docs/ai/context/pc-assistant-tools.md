# PC Assistant Tools (stage-tamagotchi)

Built-in tools that let AIRI act as a local PC assistant, plus recommended MCP
servers to extend it. All "action" tools (write/execute) are approval-gated;
reads are free.

## Built-in tools

| Tool | Capability | Approval | Service |
|---|---|---|---|
| `file_read` | Read a text file by absolute path (512KB cap, binary rejected) | none | `main/services/airi/file-access` |
| `file_list` | List a directory (name/type/size, 300 cap) | none | `file-access` |
| `file_write` | Create/overwrite a text file with full content (keeps `.airi-bak`) | **dialog** | `file-access` |
| `file_edit` | Replace an exact unique string in a file; dialog shows a diff (keeps `.airi-bak`) | **dialog (diff)** | `file-access` |
| `run_command` | Run a shell command via cmd.exe (30s timeout, output capped) | **dialog** | `command-exec` |
| `clipboard_read` | Read clipboard text (16KB cap) | none | `desktop-io` |
| `clipboard_write` | Replace clipboard text | none | `desktop-io` |
| `screenshot` | Capture primary screen to a PNG under Pictures, return its path | none | `desktop-io` |
| `system_info` | Read CPU/memory usage, OS info, hostname, uptime | none | `system-info` |
| `remember` | Save a durable fact about the user (per character) | none | `stage-ui` memory store |
| `recall_memories` | List remembered facts for the active character | none | `stage-ui` memory store |
| `forget` | Delete a remembered fact by id | none | `stage-ui` memory store |
| `set_reminder` | Schedule a reminder; fires as a proactive chat message + OS notification | none | `renderer` reminders store |
| `list_reminders` | List pending reminders with ids and fire times | none | `renderer` reminders store |
| `cancel_reminder` | Cancel a pending reminder by id | none | `renderer` reminders store |

Tools are registered into the `widgets` and `artistry` toolsets in
`renderer/stores/chat-sync.ts`. OS-privileged services (file/command/desktop)
are registered **once** on a window-less context via
`main/services/airi/desktop-assistant`; the renderer memory tools call the
`packages/stage-ui` memory store directly (no IPC — it lives in IndexedDB).

### Usage examples

What the user can say in chat to trigger each tool:

| Say this | Triggers |
|---|---|
| "F:\notes\todo.md 읽고 요약해줘" | `file_read` |
| "바탕화면에 뭐 있어?" | `file_list` |
| "메모.txt 만들고 회의 내용 적어줘" | `file_write` → approval dialog |
| "config.json에서 port를 8080으로 바꿔줘" | `file_edit` → approval dialog with diff |
| "메모장 열어줘" / "npm run build 실행해줘" | `run_command` → approval dialog |
| "방금 복사한 거 정리해줘" | `clipboard_read` |
| "이 결과 클립보드에 넣어줘" | `clipboard_write` |
| "지금 화면 캡처해줘" | `screenshot` (saved to Pictures) |
| "메모리 얼마나 쓰고 있어?" / "내 PC 사양 알려줘" | `system_info` |
| "뭐가 CPU 잡아먹고 있어?" | `system_info` + `run_command` (tasklist) |
| "내 이름은 꿀보야, 기억해" | `remember` |
| "나에 대해 뭘 알고 있어?" | `recall_memories` |
| "그 사실은 잊어줘" | `forget` |
| "30분 뒤에 스트레칭하라고 알려줘" | `set_reminder` |
| "예약된 알림 뭐 있어?" | `list_reminders` |
| "그 알림 취소해줘" | `cancel_reminder` |

### Reminders

`set_reminder`/`list_reminders`/`cancel_reminder` schedule timers in the
renderer (`stores/reminders.ts`), persisted to localStorage so they survive
reloads — `initialize()` re-arms them at startup and past-due ones fire shortly
after. On fire, AIRI appends a proactive assistant message to the active chat
session and shows an OS notification via the main process
(`electronNotify` → `desktop-io`). Max delay ~30 days.

### Long-term memory

`remember`/`recall_memories`/`forget` persist facts to IndexedDB, scoped per
character card, surviving restarts. Stored facts are injected into the system
message as a `## What you remember about the user` section
(`packages/stage-ui/src/stores/chat/memory-store.ts`,
`...stores/chat/session-store.ts`). The section is refreshed on every send, so
a freshly remembered fact reaches the next turn. Empty memory yields an empty
string (KV-cache stable). Secrets/sensitive data must not be stored (the
conversational-style prompt instructs the model accordingly).

### Capability discovery

The conversational-style system prompt
(`packages/stage-ui/src/constants/prompts/conversational-style.ts`) includes a
short "What you can do on this computer" summary. With ~19 built-in tools plus
MCP tools exposed at once, a weak local model otherwise has to infer its
abilities from tool schemas alone; the summary improves tool selection and
willingness to act. Keep it concise and update it when capability areas change
(not per individual tool).

### Safety model

- **Reads are free, every action is gated or blocked.** `file_write` and
  `run_command` always show a native dialog whose default button is *Deny*.
- `file_write` blocks OS/program directories; `run_command` blocks an explicit
  list of destructive commands (format, recursive delete, registry/firewall/AV
  changes, shutdown, shadow-copy deletion) before the dialog even appears.
- Policy logic lives in pure, unit-tested `policy.ts` modules per service.

### Known limitations

- `run_command` runs single commands with no transactional rollback.
- `file_edit` replaces one exact unique string per call (no fuzzy/multi-edit);
  `file_write` replaces whole content. Both show an approval dialog —
  `file_edit`'s shows a line diff.
- `screenshot` returns a file path, not an inline image — wiring tool-result
  images into the next LLM turn (vision) is a separate, provider-dependent
  feature and is not implemented.
- Memory facts are plain strings with exact-text dedup; no semantic recall or
  automatic summarization of old conversations yet.

> When adding a new assistant tool, update this file in the same change:
> add a row to the tools table, a chat usage example, and note any approval
> gate or limitation.

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
