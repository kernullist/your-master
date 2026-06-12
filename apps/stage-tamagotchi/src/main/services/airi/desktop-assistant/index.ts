import type { IpcMain } from 'electron'

import { createContext } from '@moeru/eventa/adapters/electron/main'

import { createCommandExecService } from '../command-exec'
import { createDesktopIoService } from '../desktop-io'
import { createFileAccessService } from '../file-access'
import { createSystemInfoService } from '../system-info'

/**
 * Registers the PC-assistant services (file access, command execution,
 * desktop I/O) exactly once on a window-less ipcMain context.
 *
 * NOTICE:
 * These services have user-visible side effects (approval dialogs, shell
 * execution). Registering them per-window — as the other RPC services do —
 * binds a separate eventa context per window to the SHARED ipcMain
 * `eventa-message` channel, so a single renderer invoke fires every window's
 * handler and the approval dialog appeared twice (once per window).
 *
 * A single window-less context fixes this: with no bound window, eventa
 * replies to the requesting renderer (`ipcMainEvent.sender`), so any window
 * can call these tools and the handler runs exactly once. Idempotent services
 * (widgets/mcp/...) are unaffected by the duplicate-fire and stay per-window.
 *
 * Removal condition: eventa gains per-window-namespaced contexts so the
 * shared-channel fan-out no longer happens.
 *
 * Call stack:
 *
 * main/index.ts
 *   -> {@link setupDesktopAssistantServices}
 *     -> {@link createFileAccessService}
 *     -> {@link createCommandExecService}
 *     -> {@link createDesktopIoService}
 */
export function setupDesktopAssistantServices(ipcMain: IpcMain) {
  const { context } = createContext(ipcMain)

  createFileAccessService({ context })
  createCommandExecService({ context })
  createDesktopIoService({ context })
  createSystemInfoService({ context })
}
