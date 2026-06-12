import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/llm-tools'
import { createFlattenedMcpTools, createMcpTools } from '@proj-airi/stage-ui/tools/mcp'
import { defineStore } from 'pinia'

import { electronMcpCallTool, electronMcpListTools } from '../../shared/eventa'

/**
 * Registers Electron-backed MCP tools into the shared LLM tools store.
 *
 * Use when:
 * - The Tamagotchi renderer needs live MCP tools during chat streaming
 *
 * Expects:
 * - Electron Eventa handlers for MCP listing and invocation are available
 *
 * Returns:
 * - Store actions for refreshing and disposing MCP runtime tools
 */
export const useTamagotchiMcpToolsStore = defineStore('tamagotchi-mcp-tools', () => {
  const llmToolsStore = useLlmToolsStore()
  const listMcpTools = useElectronEventaInvoke(electronMcpListTools)
  const callMcpTool = useElectronEventaInvoke(electronMcpCallTool)

  async function refresh() {
    const runtime = {
      listTools: () => listMcpTools(),
      callTool: (payload: Parameters<typeof callMcpTool>[0]) => callMcpTool(payload),
    }

    // Flattened tools expose each MCP tool (name/description/schema) directly
    // in the model's tool list — weak local models rarely manage the generic
    // two-hop list-then-call flow. The proxy pair stays registered as a
    // fallback for servers added after this refresh.
    // TODO: re-run refresh() when MCP apply-and-restart broadcasts a change
    // event, so newly started servers flatten without an app reload.
    const registration = (async () => {
      const [proxyTools, flattenedTools] = await Promise.all([
        Promise.all(createMcpTools(runtime)),
        createFlattenedMcpTools(runtime),
      ])
      return [...proxyTools, ...flattenedTools]
    })()

    return llmToolsStore.registerTools('mcp', registration)
  }

  function dispose() {
    llmToolsStore.clearTools('mcp')
  }

  return {
    dispose,
    refresh,
  }
})
