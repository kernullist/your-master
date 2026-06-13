import type { Tool } from '@xsai/shared-chat'

import { normalizeMemoryKind, searchMemories, useChatMemoryStore } from '@proj-airi/stage-ui/stores/chat/memory-store'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { tool } from '@xsai/tool'
import { z } from 'zod'

function activeCharacterId(): string {
  return useAiriCardStore().activeCardId || 'default'
}

const tools: Promise<Tool>[] = [
  tool({
    name: 'remember',
    // strict:false because `kind` is optional (xsai tool() defaults strict:true
    // without adding optional keys to required — rejected by strict providers).
    strict: false,
    description: 'Save something durable to recall in future conversations (across restarts). Set kind to: "instruction" (a standing request the user gave you), "decision" (a choice that was made), "event" (something notable that happened), "preference" (how the user likes things), or "fact" (default). Use for names, preferences, projects, commitments, instructions, and decisions. Do NOT save secrets, passwords, or sensitive personal data.',
    execute: async ({ fact, kind }) => {
      const memoryStore = useChatMemoryStore()
      const characterId = activeCharacterId()
      await memoryStore.ensureLoaded(characterId)
      const item = await memoryStore.remember(characterId, fact, normalizeMemoryKind(kind), Date.now())
      return `OK: remembered ${item.kind} (id ${item.id})`
    },
    parameters: z.object({
      fact: z.string().describe('A single concise thing to remember, e.g. "Email the weekly report every Monday."'),
      kind: z.enum(['instruction', 'decision', 'event', 'preference', 'fact']).optional().describe('Category (default "fact")'),
    }),
  }),
  tool({
    name: 'recall_memories',
    // strict:false because `query` is optional.
    strict: false,
    description: 'Recall what you remember for this character (instructions, decisions, events, preferences, facts), each with its kind. Pass an optional query to keyword-search your memory — useful for older facts/events that may not be in your current context. Omit query to list everything.',
    execute: async ({ query }) => {
      const memoryStore = useChatMemoryStore()
      const characterId = activeCharacterId()
      await memoryStore.ensureLoaded(characterId)
      const all = memoryStore.list(characterId)
      const memories = query ? searchMemories(all, query) : all
      return JSON.stringify(memories.map(item => ({ id: item.id, kind: item.kind, text: item.text })))
    },
    parameters: z.object({
      query: z.string().optional().describe('Optional keyword to search memory text; omit to list all'),
    }),
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
