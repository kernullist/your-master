import type { ResolvedArtistryConfig } from '@proj-airi/stage-ui/stores/modules/artistry'
import type { Tool } from '@xsai/shared-chat'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { artistryGenerateHeadless } from '@proj-airi/stage-shared'
import { useBackgroundStore } from '@proj-airi/stage-ui/stores/background'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { resolveArtistryConfigFromStore, useArtistryStore } from '@proj-airi/stage-ui/stores/modules/artistry'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import { widgetsAdd } from '../../../../shared/eventa'

export function getArtistryConfig(): ResolvedArtistryConfig {
  return resolveArtistryConfigFromStore(useArtistryStore())
}

/** Probe result cache so each chat send does not re-ping the backend. */
let backendProbe: { at: number, ok: boolean } | undefined
/** Re-probe after this long; a freshly started ComfyUI is picked up within ~30s. */
const BACKEND_PROBE_TTL_MS = 30_000
/** Liveness probe deadline; LAN/local ComfyUI answers well under this. */
const BACKEND_PROBE_TIMEOUT_MS = 1_500

/**
 * Injectable dependencies for {@link isArtistryBackendReachable}; production
 * uses the real `fetch`/`Date.now`, tests pass fakes (FP + DI instead of
 * stubbing globals).
 */
export interface ArtistryBackendProbeDeps {
  /** Fetch implementation used for the liveness probe. @default globalThis.fetch */
  fetchImpl?: typeof fetch
  /** Clock used for the probe cache TTL. @default Date.now */
  now?: () => number
}

/** Clears the probe cache; test-only escape hatch. */
export function resetArtistryBackendProbeCache() {
  backendProbe = undefined
}

/**
 * Checks whether the configured artistry image backend is reachable.
 *
 * Use when:
 * - Deciding if the `image_journal` tool should be offered to the LLM for
 *   this turn — advertising the tool while ComfyUI is down makes the model
 *   call it, stall on the failed generation, and drag the whole chat turn.
 *
 * Expects:
 * - Only probes the `comfyui` provider (a local/LAN server that is commonly
 *   offline); hosted providers (replicate, nanobanana) are assumed up.
 *
 * Returns:
 * - `true` when reachable or not probeable; `false` when the configured
 *   ComfyUI URL is missing or did not answer within the timeout. Results
 *   are cached for {@link BACKEND_PROBE_TTL_MS}.
 */
export async function isArtistryBackendReachable(
  config: ResolvedArtistryConfig,
  deps?: ArtistryBackendProbeDeps,
): Promise<boolean> {
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch
  const now = deps?.now ?? Date.now

  if (config.provider !== 'comfyui')
    return true

  const serverUrl = config.globals?.comfyuiServerUrl as string | undefined
  if (!serverUrl?.trim())
    return false

  if (backendProbe && now() - backendProbe.at < BACKEND_PROBE_TTL_MS)
    return backendProbe.ok

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), BACKEND_PROBE_TIMEOUT_MS)
    // NOTICE:
    // `mode: 'no-cors'` on purpose: ComfyUI does not send CORS headers by
    // default, so a normal fetch from the renderer origin would reject even
    // when the server is healthy. An opaque no-cors response still resolves
    // only if the TCP/HTTP round-trip succeeded, which is all we need for
    // liveness. The actual generation runs in the main process (no CORS).
    // Removal condition: probe moves to the main process via eventa.
    await fetchImpl(new URL('system_stats', serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`), {
      mode: 'no-cors',
      signal: controller.signal,
    })
    clearTimeout(timer)
    backendProbe = { at: now(), ok: true }
  }
  catch {
    backendProbe = { at: now(), ok: false }
  }

  return backendProbe.ok
}

function createInvokers() {
  const { context } = createContext(window.electron.ipcRenderer)
  return {
    generateHeadless: defineInvoke(context, artistryGenerateHeadless),
    addWidget: defineInvoke(context, widgetsAdd),
  }
}

type Invokers = ReturnType<typeof createInvokers>
let invokeCache: Invokers | undefined

function getInvokers(): Invokers {
  if (!invokeCache)
    invokeCache = createInvokers()
  return invokeCache
}

const imageJournalParams = z.object({
  action: z.enum(['create', 'apply']).describe('Choose "create" to generate a new image, or "apply" to use an existing one.'),
  prompt: z.string().optional().describe('Description for the image (required for "create").'),
  title: z.string().optional().describe('Label for the entry (optional).'),
  query: z.string().optional().describe('Search term for existing images (required for "apply").'),
  mode: z.enum(['inline', 'widget', 'bg', 'bg_widget']).optional().describe('Display mode: "inline" (in chat), "widget" (overlay), "bg" (environment), or "bg_widget" (both). Defaults to character preference.'),
})

async function executeCreateImageJournalEntry(params: { prompt?: string, title?: string, mode?: 'inline' | 'widget' | 'bg' | 'bg_widget' }) {
  if (!params.prompt?.trim())
    throw new Error('prompt is required for image_journal.create')

  const backgroundStore = useBackgroundStore()
  const cardStore = useAiriCardStore()
  const activeCard = cardStore.activeCard
  const globalArtistryConfig = getArtistryConfig()

  const airiExt = activeCard?.extensions?.airi
  const cardArtistry = airiExt?.modules?.artistry
  const artistryConfig = {
    provider: cardArtistry?.provider || globalArtistryConfig.provider,
    model: cardArtistry?.model || globalArtistryConfig.model,
    promptPrefix: cardArtistry?.promptPrefix || globalArtistryConfig.promptPrefix,
    options: cardArtistry?.options || globalArtistryConfig.options,
    globals: globalArtistryConfig.globals,
  }

  const title = params.title || `Generation ${new Date().toLocaleString()}`

  // Resolve mode: explicit param > character fallback > global default (inline)
  const spawnMode = cardArtistry?.spawnMode
  const mode = params.mode || spawnMode || 'inline'

  const { addWidget, generateHeadless } = getInvokers()

  try {
    const artistryResult = await generateHeadless({
      prompt: artistryConfig.promptPrefix ? `${artistryConfig.promptPrefix} ${params.prompt}` : params.prompt as string,
      model: artistryConfig.model as string,
      provider: artistryConfig.provider as string,
      options: JSON.parse(JSON.stringify(artistryConfig.options || {})),
      globals: JSON.parse(JSON.stringify(artistryConfig.globals || {})),
    })

    if (artistryResult.error || (!artistryResult.base64 && !artistryResult.imageUrl)) {
      throw new Error(`Failed to generate image: ${artistryResult.error || 'No output received'}`)
    }

    let blob: Blob
    if (artistryResult.base64) {
      const response = await fetch(artistryResult.base64)
      blob = await response.blob()
    }
    else {
      const response = await fetch(artistryResult.imageUrl!)
      blob = await response.blob()
    }

    const entryId = await backgroundStore.addBackground('journal', blob, title, params.prompt, cardStore.activeCardId)

    // Handle Application Logic based on Mode
    if (mode === 'bg' || mode === 'bg_widget') {
      const cardId = cardStore.activeCardId
      if (cardId) {
        const card = cardStore.cards.get(cardId)
        if (card) {
          const extension = JSON.parse(JSON.stringify(card.extensions || {}))
          if (!extension.airi)
            extension.airi = {}
          if (!extension.airi.modules)
            extension.airi.modules = {}
          extension.airi.modules.activeBackgroundId = entryId
          cardStore.updateCard(cardId, { ...card, extensions: extension })
        }
      }
    }

    if (mode === 'widget' || mode === 'bg_widget') {
      try {
        await addWidget({
          componentName: 'artistry',
          componentProps: {
            status: 'done',
            entryId,
            imageUrl: artistryResult.imageUrl || artistryResult.base64,
            prompt: params.prompt as string,
            title,
            _skipIngestion: true,
          },
          size: 'm',
          ttlMs: 0,
        })
      }
      catch (e) {
        console.warn('[ImageJournalTool] Failed to spawn Result widget', e)
      }
    }

    // Return structured result for UI rendering
    return JSON.stringify({
      message: `Image created in ${mode} mode${mode === 'bg' || mode === 'bg_widget' ? ' and set as background' : ''}.`,
      entryId,
      imageUrl: artistryResult.imageUrl || artistryResult.base64,
      title,
      prompt: params.prompt,
      mode,
    })
  }
  catch (e) {
    console.error('[ImageJournalTool] Failed to create entry', e)
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function executeSetAsBackground(params: { query?: string }) {
  if (!params.query?.trim())
    return 'Error: query is required for image_journal.apply. Provide a title or ID to search for.'

  const backgroundStore = useBackgroundStore()
  const cardStore = useAiriCardStore()
  const cardId = cardStore.activeCardId
  const query = params.query.toLowerCase().trim()

  const entries = Array.from(backgroundStore.entries.values())
    .filter(e => e.characterId === null || e.characterId === cardId)

  let entry = entries.find(e => e.type === 'journal' && (e.id === query || e.id.toLowerCase().includes(query)))
  if (!entry)
    entry = entries.find(e => e.type === 'journal' && e.title.toLowerCase().includes(query))
  if (!entry)
    entry = entries.find(e => e.type !== 'journal' && e.title.toLowerCase().includes(query))

  if (entry) {
    try {
      if (cardId) {
        const card = cardStore.cards.get(cardId)
        if (card) {
          const extension = JSON.parse(JSON.stringify(card.extensions || {}))
          if (!extension.airi)
            extension.airi = {}
          if (!extension.airi.modules)
            extension.airi.modules = {}
          extension.airi.modules.activeBackgroundId = entry.id
          cardStore.updateCard(cardId, { ...card, extensions: extension })
        }
      }
      return `Background set to "${entry.title}".`
    }
    catch (e) {
      return `Error applying "${entry.title}": ${e instanceof Error ? e.message : String(e)}`
    }
  }

  const available = entries.filter(e => e.type === 'journal').map(e => e.title).slice(0, 10)
  return `No match for "${params.query}".${available.length > 0 ? ` Try: ${available.join(', ')}` : ''}`
}

async function executeImageJournalAction(params: any) {
  if (params.action === 'create')
    return await executeCreateImageJournalEntry(params)
  if (params.action === 'apply' || params.action === 'set_as_background')
    return await executeSetAsBackground(params)
  return 'No action performed.'
}

const tools: Promise<Tool>[] = [
  tool({
    name: 'image_journal',
    description: 'Manage AI-generated images. Use "create" to generate and display images. An optional "mode" (inline, widget, bg, bg_widget) can override the default character routing preference. Use "apply" to switch to an existing image from the journal.',
    execute: params => executeImageJournalAction(params),
    parameters: imageJournalParams,
  }),
]

export async function imageJournalTools() {
  // Backend down -> withhold the tool entirely. The model then answers in
  // plain text instead of issuing an image_journal call that cannot finish.
  if (!(await isArtistryBackendReachable(getArtistryConfig()))) {
    console.warn('[ImageJournalTool] artistry backend unreachable; image_journal excluded from this turn')
    return []
  }

  return Promise.all(tools)
}
