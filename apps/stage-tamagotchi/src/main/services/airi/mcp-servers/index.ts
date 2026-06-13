import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type {
  ElectronMcpCallToolPayload,
  ElectronMcpCallToolResult,
  ElectronMcpStdioApplyResult,
  ElectronMcpStdioConfigFile,
  ElectronMcpStdioRuntimeStatus,
  ElectronMcpStdioServerConfig,
  ElectronMcpStdioServerRuntimeStatus,
  ElectronMcpToolDescriptor,
} from '../../../../shared/eventa'

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { useLogg } from '@guiiai/logg'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { defineInvokeHandler } from '@moeru/eventa'
import { app, shell } from 'electron'
import { z } from 'zod'

import {
  electronMcpApplyAndRestart,
  electronMcpCallTool,
  electronMcpGetRuntimeStatus,
  electronMcpListTools,
  electronMcpOpenConfigFile,
} from '../../../../shared/eventa'
import { onAppBeforeQuit } from '../../../libs/bootkit/lifecycle'
import { parseQualifiedToolName, resolveRequestedToolName, toolNameSeparator } from './tool-name'

interface McpServerSession {
  client: Client
  transport: StdioClientTransport
  config: ElectronMcpStdioServerConfig
}

/** A live MCP connection produced by a {@link ConnectServerFn}. */
interface McpConnectResult {
  client: Client
  transport: StdioClientTransport
  /** OS pid of the spawned server process, or null when unavailable. */
  pid: number | null
}

/**
 * Connects to one MCP server and returns the live client/transport. Injected
 * via {@link McpStdioManagerOptions} so tests can simulate slow/failing servers
 * without spawning real child processes.
 */
type ConnectServerFn = (name: string, config: ElectronMcpStdioServerConfig) => Promise<McpConnectResult>

/** Options for {@link createMcpStdioManager}. */
export interface McpStdioManagerOptions {
  /**
   * Overrides how a server is connected. Defaults to spawning a real
   * `StdioClientTransport` with a {@link mcpConnectTimeoutMsec} guard.
   */
  connectServer?: ConnectServerFn
}

export interface McpStdioManager {
  ensureConfigFile: () => Promise<{ path: string }>
  openConfigFile: () => Promise<{ path: string }>
  applyAndRestart: () => Promise<ElectronMcpStdioApplyResult>
  listTools: () => Promise<ElectronMcpToolDescriptor[]>
  callTool: (payload: ElectronMcpCallToolPayload) => Promise<ElectronMcpCallToolResult>
  stopAll: () => Promise<void>
  getRuntimeStatus: () => ElectronMcpStdioRuntimeStatus
}

const mcpServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  enabled: z.boolean().optional(),
}).strict()

const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerConfigSchema),
}).strict()

const defaultMcpConfig: ElectronMcpStdioConfigFile = {
  mcpServers: {},
}
const mcpRequestTimeoutMsec = 10_000
const mcpRequestMaxTotalTimeoutMsec = 15_000

/**
 * Max time to wait for a single MCP server to connect (process spawn + the MCP
 * initialize handshake). npx-based servers (e.g. `npx -y pkg@latest`) cold-start
 * slowly because npx re-resolves the package version from the registry on every
 * launch, so this is intentionally generous; it exists only so a truly hung or
 * unreachable server cannot keep a child process pending forever. Startup does
 * not block on connect (see {@link setupMcpStdioManager}), so a long connect
 * never delays the app window.
 */
const mcpConnectTimeoutMsec = 60_000

// NOTICE: parseQualifiedToolName / resolveFallbackToolName previously lived
// here; they moved to `./tool-name` (pure, electron-free) so they can be
// unit-tested together with the new resolveRequestedToolName fuzzy matcher.

function stringifyError(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

/**
 * Rejects with an Error(`message`) if `promise` does not settle within `ms`;
 * otherwise resolves/rejects with the original outcome. The timer is always
 * cleared so a settled promise never keeps the event loop alive.
 *
 * Use when:
 * - Bounding an external operation (process spawn, network handshake) that can
 *   otherwise hang indefinitely.
 *
 * Expects:
 * - `ms` is a positive timeout in milliseconds.
 *
 * Returns:
 * - The original promise's resolved value, or throws Error(`message`) on timeout.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  }
  finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function getConfigPath() {
  return join(app.getPath('userData'), 'mcp.json')
}

async function closeSession(session: McpServerSession) {
  try {
    await session.client.close()
  }
  catch {
    await session.transport.close()
  }
}

export function createMcpStdioManager(options: McpStdioManagerOptions = {}): McpStdioManager {
  const log = useLogg('main/mcp-stdio').useGlobalConfig()
  const sessions = new Map<string, McpServerSession>()
  const runtimeStatuses = new Map<string, ElectronMcpStdioServerRuntimeStatus>()
  let updatedAt = Date.now()

  const setRuntimeStatus = (status: ElectronMcpStdioServerRuntimeStatus) => {
    runtimeStatuses.set(status.name, status)
    updatedAt = Date.now()
  }

  const ensureConfigFile = async () => {
    const path = getConfigPath()
    await mkdir(app.getPath('userData'), { recursive: true })

    try {
      await readFile(path, 'utf-8')
    }
    catch {
      await writeFile(path, `${JSON.stringify(defaultMcpConfig, null, 2)}\n`)
    }

    return { path }
  }

  const openConfigFile = async () => {
    const { path } = await ensureConfigFile()
    const openResult = await shell.openPath(path)
    if (openResult) {
      throw new Error(openResult)
    }
    return { path }
  }

  const readConfigFile = async (path: string): Promise<ElectronMcpStdioConfigFile> => {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    const validated = mcpConfigSchema.safeParse(parsed)
    if (!validated.success) {
      throw new Error(validated.error.issues.map(issue => issue.message).join('; '))
    }
    return validated.data
  }

  const stopAll = async () => {
    const entries = [...sessions.entries()]
    for (const [name, session] of entries) {
      await closeSession(session)
      setRuntimeStatus({
        name,
        state: 'stopped',
        command: session.config.command,
        args: session.config.args ?? [],
        pid: null,
      })
      sessions.delete(name)
    }
  }

  // Real connector: spawn the stdio server and run the MCP handshake, bounded
  // by mcpConnectTimeoutMsec so a hung server cannot leave a child pending.
  const defaultConnectServer: ConnectServerFn = async (name, config) => {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env,
      cwd: config.cwd,
      stderr: 'pipe',
    })
    const client = new Client({
      name: `proj-airi:stage-tamagotchi:mcp:${name}`,
      version: app.getVersion(),
    })

    try {
      await withTimeout(
        client.connect(transport),
        mcpConnectTimeoutMsec,
        `mcp server "${name}" connect timed out after ${mcpConnectTimeoutMsec}ms`,
      )
    }
    catch (error) {
      // On failure or timeout, tear down the spawned process so it does not leak.
      await transport.close().catch(() => {})
      throw error
    }

    transport.stderr?.on('data', (data) => {
      const text = data.toString('utf-8').trim()
      if (text) {
        log.withFields({ serverName: name }).warn(text)
      }
    })

    return { client, transport, pid: transport.pid }
  }

  const connectServer = options.connectServer ?? defaultConnectServer

  const startServer = async (name: string, config: ElectronMcpStdioServerConfig) => {
    const { client, transport, pid } = await connectServer(name, config)
    sessions.set(name, { client, transport, config })
    setRuntimeStatus({
      name,
      state: 'running',
      command: config.command,
      args: config.args ?? [],
      pid,
    })
  }

  const applyAndRestart = async (): Promise<ElectronMcpStdioApplyResult> => {
    const { path } = await ensureConfigFile()
    const config = await readConfigFile(path)

    await stopAll()
    runtimeStatuses.clear()

    const result: ElectronMcpStdioApplyResult = {
      path,
      started: [],
      failed: [],
      skipped: [],
    }

    // Start every enabled server CONCURRENTLY. Previously sequential, so total
    // startup time was the sum of each server's spawn+handshake; a single slow
    // npx server (~30s) delayed all the others. Failures stay isolated per
    // server (each is independently try/caught), so one bad server never aborts
    // the rest. Push order is now nondeterministic; callers sort if they care.
    await Promise.all(Object.entries(config.mcpServers).map(async ([name, server]) => {
      if (server.enabled === false) {
        result.skipped.push({ name, reason: 'disabled' })
        setRuntimeStatus({
          name,
          state: 'stopped',
          command: server.command,
          args: server.args ?? [],
          pid: null,
        })
        return
      }

      try {
        await startServer(name, server)
        result.started.push({ name })
      }
      catch (error) {
        const message = stringifyError(error)
        result.failed.push({ name, error: message })
        setRuntimeStatus({
          name,
          state: 'error',
          command: server.command,
          args: server.args ?? [],
          pid: null,
          lastError: message,
        })
      }
    }))

    updatedAt = Date.now()

    return result
  }

  const listTools = async (): Promise<ElectronMcpToolDescriptor[]> => {
    const entries = [...sessions.entries()].sort(([left], [right]) => left.localeCompare(right))
    const listResult = await Promise.all(entries.map(async ([serverName, session]) => {
      try {
        const response = await session.client.listTools(undefined, {
          timeout: mcpRequestTimeoutMsec,
          maxTotalTimeout: mcpRequestMaxTotalTimeoutMsec,
        })
        return response.tools.map<ElectronMcpToolDescriptor>(item => ({
          serverName,
          name: `${serverName}${toolNameSeparator}${item.name}`,
          toolName: item.name,
          description: item.description,
          inputSchema: item.inputSchema,
        }))
      }
      catch (error) {
        log.withFields({ serverName }).withError(error).warn('failed to list tools from mcp server')
        return []
      }
    }))

    return listResult.flat()
  }

  const callTool = async (payload: ElectronMcpCallToolPayload): Promise<ElectronMcpCallToolResult> => {
    const { serverName, toolName } = parseQualifiedToolName(payload.name)
    const session = sessions.get(serverName)
    if (!session) {
      throw new Error(`mcp server is not running: ${serverName}`)
    }

    const callOnce = async (name: string) => session.client.callTool({
      name,
      arguments: payload.arguments ?? {},
    }, undefined, {
      timeout: mcpRequestTimeoutMsec,
      maxTotalTimeout: mcpRequestMaxTotalTimeoutMsec,
    })

    // Best-effort live tool listing for self-correction; an empty list means
    // "could not verify" and falls back to propagating the original error.
    const listServerToolNames = async (): Promise<string[]> => {
      try {
        const response = await session.client.listTools(undefined, {
          timeout: mcpRequestTimeoutMsec,
          maxTotalTimeout: mcpRequestMaxTotalTimeoutMsec,
        })
        return response.tools.map(item => item.name)
      }
      catch {
        return []
      }
    }

    let result
    try {
      result = await callOnce(toolName)
    }
    catch (error) {
      const availableNames = await listServerToolNames()

      // The tool exists -> this is a genuine execution failure (timeout,
      // bad arguments, upstream API error); never mask it with renaming.
      if (availableNames.length === 0 || availableNames.includes(toolName)) {
        throw error
      }

      const resolvedToolName = resolveRequestedToolName(toolName, availableNames)
      if (!resolvedToolName || resolvedToolName === toolName) {
        // Echo the real names back so the calling LLM can self-correct on
        // its next round instead of guessing again.
        throw new Error(
          `unknown tool "${toolName}" on mcp server "${serverName}". `
          + `Available tools: ${availableNames.map(name => `${serverName}${toolNameSeparator}${name}`).join(', ')}`,
        )
      }

      log.withFields({
        serverName,
        requestedToolName: toolName,
        resolvedToolName,
      }).warn('retrying mcp tool call with resolved tool name')

      result = await callOnce(resolvedToolName)
    }

    const normalized: ElectronMcpCallToolResult = {}
    if ('content' in result && Array.isArray(result.content)) {
      normalized.content = result.content as Array<Record<string, unknown>>
    }
    if ('structuredContent' in result && result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) {
      normalized.structuredContent = result.structuredContent as Record<string, unknown>
    }
    if ('isError' in result && typeof result.isError === 'boolean') {
      normalized.isError = result.isError
    }
    if ('toolResult' in result) {
      normalized.toolResult = result.toolResult
    }

    return normalized
  }

  const getRuntimeStatus = (): ElectronMcpStdioRuntimeStatus => {
    return {
      path: getConfigPath(),
      servers: [...runtimeStatuses.values()].sort((left, right) => left.name.localeCompare(right.name)),
      updatedAt,
    }
  }

  return {
    ensureConfigFile,
    openConfigFile,
    applyAndRestart,
    listTools,
    callTool,
    stopAll,
    getRuntimeStatus,
  }
}

export async function setupMcpStdioManager() {
  const log = useLogg('main/mcp-stdio').useGlobalConfig()
  const manager = createMcpStdioManager()

  onAppBeforeQuit(async () => {
    await manager.stopAll()
  })

  await manager.ensureConfigFile()

  // NOTICE:
  // Connect MCP servers in the BACKGROUND; do NOT await here. npx-based servers
  // (e.g. `npx -y tavily-mcp@latest`) cold-start in ~30s because npx re-resolves
  // the package from the registry on every launch. Awaiting previously blocked
  // the whole DI graph (windows:chat/settings/main depend on this module), so
  // the app window did not appear until every server connected, and a hung
  // server hung startup indefinitely. Tools come online when ready and are
  // listed on demand via electronMcpListTools.
  void manager.applyAndRestart()
    .then((result) => {
      log
        .withFields({ started: result.started.length, failed: result.failed.length, skipped: result.skipped.length })
        .log('mcp stdio servers initialized')
    })
    .catch((error) => {
      log.withError(error).warn('failed to apply mcp stdio config during startup')
    })

  return manager
}

export function createMcpServersService(params: { context: ReturnType<typeof createContext>['context'], manager: McpStdioManager }) {
  defineInvokeHandler(params.context, electronMcpOpenConfigFile, async () => {
    return params.manager.openConfigFile()
  })

  defineInvokeHandler(params.context, electronMcpApplyAndRestart, async () => {
    return params.manager.applyAndRestart()
  })

  defineInvokeHandler(params.context, electronMcpGetRuntimeStatus, async () => {
    return params.manager.getRuntimeStatus()
  })

  defineInvokeHandler(params.context, electronMcpListTools, async () => {
    return params.manager.listTools()
  })

  defineInvokeHandler(params.context, electronMcpCallTool, async (payload) => {
    return params.manager.callTool(payload)
  })
}
