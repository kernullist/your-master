import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable config JSON the mocked fs returns; each test sets it before running.
const state = vi.hoisted(() => ({ configJson: '{"mcpServers":{}}' }))

// NOTICE:
// This module imports electron, the MCP SDK, logg, eventa, and node:fs. The
// unit under test (createMcpStdioManager) takes an injected connectServer, so
// none of those are exercised on the tested path; we stub them only so the
// module imports cleanly under the node test env.
// Removal condition: integration test that spawns a real stdio MCP server.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/airi-test-userdata', getVersion: () => '0.0.0' },
  shell: { openPath: vi.fn(async () => '') },
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: vi.fn() }))
vi.mock('../../../libs/bootkit/lifecycle', () => ({ onAppBeforeQuit: vi.fn() }))
vi.mock('@guiiai/logg', () => {
  const logger = {
    useGlobalConfig: () => logger,
    withFields: () => logger,
    withError: () => logger,
    warn: vi.fn(),
    log: vi.fn(),
  }
  return { useLogg: () => logger }
})
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => state.configJson),
  writeFile: vi.fn(async () => undefined),
}))

const { createMcpStdioManager, withTimeout } = await import('./index')

// Fake live connection; client/transport are unused on the tested paths.
function fakeConnection(pid = 1) {
  return { client: {} as unknown as Client, transport: {} as unknown as StdioClientTransport, pid }
}

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'timeout')).resolves.toBe(42)
  })

  it('rejects with the message when the promise never settles', async () => {
    // ROOT CAUSE:
    //
    // startServer previously did `await client.connect(transport)` with no
    // timeout. A hung MCP server left that promise pending forever, and because
    // setupMcpStdioManager awaited applyAndRestart, the whole app boot hung.
    //
    // We bound connect with withTimeout; a never-settling connect now rejects
    // after the timeout instead of hanging.
    const never = new Promise<never>(() => {})
    await expect(withTimeout(never, 10, 'connect timed out')).rejects.toThrow('connect timed out')
  })

  it('propagates the original rejection unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'timeout')).rejects.toThrow('boom')
  })
})

describe('createMcpStdioManager.applyAndRestart', () => {
  beforeEach(() => {
    state.configJson = '{"mcpServers":{}}'
  })

  it('isolates a failing server: others still start, disabled ones are skipped', async () => {
    state.configJson = JSON.stringify({
      mcpServers: {
        ok: { command: 'good', enabled: true },
        fail: { command: 'bad', enabled: true },
        off: { command: 'disabled', enabled: false },
      },
    })

    const connectServer = vi.fn(async (name: string) => {
      if (name === 'fail') {
        throw new Error('spawn failed')
      }
      return fakeConnection(123)
    })

    const manager = createMcpStdioManager({ connectServer })
    const result = await manager.applyAndRestart()

    // Push order is nondeterministic under Promise.all, so compare sorted.
    expect(result.started.map(s => s.name).sort()).toEqual(['ok'])
    expect(result.failed.map(f => f.name)).toEqual(['fail'])
    expect(result.failed[0].error).toContain('spawn failed')
    expect(result.skipped.map(s => s.name)).toEqual(['off'])

    const servers = manager.getRuntimeStatus().servers
    expect(servers.find(s => s.name === 'ok')?.state).toBe('running')
    expect(servers.find(s => s.name === 'ok')?.pid).toBe(123)
    expect(servers.find(s => s.name === 'fail')?.state).toBe('error')
    expect(servers.find(s => s.name === 'off')?.state).toBe('stopped')
  })

  it('starts servers concurrently, not sequentially', async () => {
    // ROOT CAUSE:
    //
    // applyAndRestart previously started servers in a sequential for-await loop,
    // so total startup time was the sum of every server's spawn+handshake; one
    // slow npx server (~30s) delayed all the others.
    //
    // We start them with Promise.all. This test proves both connectors are
    // invoked before either resolves (i.e. they run concurrently).
    state.configJson = JSON.stringify({
      mcpServers: {
        a: { command: 'a', enabled: true },
        b: { command: 'b', enabled: true },
      },
    })

    const releases: Array<() => void> = []
    const connectServer = vi.fn(() => new Promise<ReturnType<typeof fakeConnection>>((resolve) => {
      releases.push(() => resolve(fakeConnection(1)))
    }))

    const manager = createMcpStdioManager({ connectServer })
    const pending = manager.applyAndRestart()

    // Flush microtasks/timers so the Promise.all map has kicked off both
    // connectors; neither has resolved yet (we have not released them).
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(connectServer).toHaveBeenCalledTimes(2)

    releases.forEach(release => release())
    const result = await pending
    expect(result.started.map(s => s.name).sort()).toEqual(['a', 'b'])
  })
})
