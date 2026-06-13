import type { Tool } from '@xsai/shared-chat'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import { electronCommandRun } from '../../../../shared/eventa'

function createInvokers() {
  const { context } = createContext(window.electron.ipcRenderer)
  return {
    runCommand: defineInvoke(context, electronCommandRun),
  }
}

type Invokers = ReturnType<typeof createInvokers>
let invokeCache: Invokers | undefined

function getInvokers(): Invokers {
  if (!invokeCache) {
    invokeCache = createInvokers()
  }
  return invokeCache
}

const tools: Promise<Tool>[] = [
  tool({
    name: 'run_command',
    // strict:false because `cwd` is optional (see search_files note).
    strict: false,
    description: 'Run a shell command on the user\'s Windows computer (via cmd.exe). THE USER MUST APPROVE EVERY COMMAND in a system dialog and may deny it — if denied, accept the decision and do not retry. Dangerous commands (disk format, recursive delete, registry/firewall/antivirus changes, shutdown) are always blocked. Times out after 30s. Use for launching apps, running scripts, and read-only system queries.',
    execute: async ({ command, cwd }) => {
      const result = await getInvokers().runCommand({ command, cwd })
      if (!result.ok) {
        return `Rejected: ${result.message}`
      }
      return JSON.stringify({
        exitCode: result.exitCode,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      })
    },
    parameters: z.object({
      command: z.string().describe('The full shell command line to run, e.g. "code ." or "dir /b"'),
      cwd: z.string().optional().describe('Optional absolute working directory for the command'),
    }),
  }),
]

export const commandExecTools = async () => Promise.all(tools)
