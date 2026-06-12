import type { Tool } from '@xsai/shared-chat'

import { useChatMemoryStore } from '@proj-airi/stage-ui/stores/chat/memory-store'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { tool } from '@xsai/tool'
import { z } from 'zod'

function activeCharacterId(): string {
  return useAiriCardStore().activeCardId || 'default'
}

const tools: Promise<Tool>[] = [
  tool({
    name: 'remember',
    description: 'Save a durable fact about the user or an ongoing topic so you recall it in future conversations (across restarts). Use for names, preferences, projects, and commitments. Do NOT save secrets, passwords, or sensitive personal data.',
    execute: async ({ fact }) => {
      const memoryStore = useChatMemoryStore()
      const characterId = activeCharacterId()
      await memoryStore.ensureLoaded(characterId)
      const item = await memoryStore.remember(characterId, fact, Date.now())
      return `OK: remembered (id ${item.id})`
    },
    parameters: z.object({
      fact: z.string().describe('A single concise fact to remember, e.g. "The user prefers Korean."'),
    }),
  }),
  tool({
    name: 'recall_memories',
    description: 'List everything you currently remember about the user for this character. Use to check what you already know before answering questions about the user.',
    execute: async () => {
      const memoryStore = useChatMemoryStore()
      const characterId = activeCharacterId()
      await memoryStore.ensureLoaded(characterId)
      const memories = memoryStore.list(characterId)
      return JSON.stringify(memories.map(item => ({ id: item.id, text: item.text })))
    },
    parameters: z.object({}),
  }),
  tool({
    name: 'forget',
    description: 'Delete a remembered fact by its id (get ids from recall_memories). Use when the user asks you to forget something or a fact is no longer true.',
    execute: async ({ id }) => {
      const memoryStore = useChatMemoryStore()
      const characterId = activeCharacterId()
      await memoryStore.ensureLoaded(characterId)
      const removed = await memoryStore.forget(characterId, id)
      return removed ? `OK: forgot ${id}` : `No memory with id ${id}`
    },
    parameters: z.object({
      id: z.string().describe('The id of the memory to delete'),
    }),
  }),
]

export const memoryTools = async () => Promise.all(tools)
