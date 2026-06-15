import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type { ElectronScreenshotResult } from '../../../../shared/eventa'

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { app, clipboard, desktopCapturer, Notification, screen } from 'electron'

import {
  electronClipboardRead,
  electronClipboardWrite,
  electronNotify,
  electronScreenshotCapture,
} from '../../../../shared/eventa'
import { selectWindowSource } from './window-match'

/** Max clipboard characters returned to the model; protects context budget. */
const CLIPBOARD_READ_MAX_CHARS = 16 * 1024

/**
 * Desktop I/O service: clipboard read/write and screenshot capture.
 *
 * Clipboard read/write and screen capture are low-risk (no destructive
 * effect), so unlike the file/command services they are not approval-gated.
 *
 * Call stack:
 *
 * setupMainWindowElectronInvokes / setupChatWindowElectronInvokes (../../../windows)
 *   -> {@link createDesktopIoService}
 *     -> {@link electronClipboardRead} / {@link electronClipboardWrite} / {@link electronScreenshotCapture}
 */
export function createDesktopIoService(params: {
  context: ReturnType<typeof createContext>['context']
}) {
  const log = useLogg('main/desktop-io').useGlobalConfig()

  defineInvokeHandler(params.context, electronNotify, async (payload) => {
    if (!Notification.isSupported()) {
      return { ok: false }
    }

    new Notification({ title: payload?.title ?? 'AIRI', body: payload?.body ?? '' }).show()
    return { ok: true }
  })

  defineInvokeHandler(params.context, electronClipboardRead, async () => {
    const text = clipboard.readText() ?? ''
    return { text: text.length > CLIPBOARD_READ_MAX_CHARS ? text.slice(0, CLIPBOARD_READ_MAX_CHARS) : text }
  })

  defineInvokeHandler(params.context, electronClipboardWrite, async (payload) => {
    clipboard.writeText(payload?.text ?? '')
    return { ok: true }
  })

  defineInvokeHandler(params.context, electronScreenshotCapture, async (payload): Promise<ElectronScreenshotResult> => {
    try {
      // Size the thumbnails to the primary display so a captured window or
      // screen is not downscaled. desktopCapturer thumbnails are the documented
      // main-process way to grab pixels without a renderer media stream.
      const primary = screen.getPrimaryDisplay()
      const { width, height } = primary.size
      const scale = primary.scaleFactor || 1
      const thumbnailSize = { width: Math.round(width * scale), height: Math.round(height * scale) }

      const windowQuery = payload?.window?.trim()

      // Window-targeted capture: enumerate windows and match by title so a
      // request like "screenshot VMware" grabs just that window, not the whole
      // screen (the previous behavior, which ignored any target).
      if (windowQuery) {
        const windows = await desktopCapturer.getSources({ types: ['window'], thumbnailSize })
        const matched = selectWindowSource(windows, windowQuery)

        if (!matched) {
          // Echo the open window titles back so the model can retry with a real one.
          return {
            error: `no open window title contains "${windowQuery}"`,
            availableWindows: windows.map(source => source.name).filter(Boolean),
          }
        }

        const image = matched.thumbnail
        // Minimized/occluded windows can yield an empty DWM thumbnail; tell the
        // user to bring it to the front rather than save a blank image.
        if (image.isEmpty()) {
          return { error: `window "${matched.name}" could not be captured (it may be minimized); bring it to the front and try again` }
        }

        const buffer = image.toPNG()
        const size = image.getSize()
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const outPath = join(app.getPath('pictures'), `airi-screenshot-${stamp}.png`)
        await writeFile(outPath, buffer)

        log.withFields({ path: outPath, window: matched.name, width: size.width, height: size.height }).log('window screenshot captured')
        return { path: outPath, width: size.width, height: size.height, source: 'window', matchedWindow: matched.name }
      }

      // Full-screen capture (no window target).
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
      if (sources.length === 0) {
        return { error: 'no screen sources available' }
      }

      const image = sources[0].thumbnail
      const buffer = image.toPNG()
      const size = image.getSize()

      // Timestamped filename via the app's pictures path; no Date.now() reliance
      // beyond the OS clock, which is fine in the main process.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const outPath = join(app.getPath('pictures'), `airi-screenshot-${stamp}.png`)
      await writeFile(outPath, buffer)

      log.withFields({ path: outPath, width: size.width, height: size.height }).log('screenshot captured')
      return { path: outPath, width: size.width, height: size.height, source: 'screen' }
    }
    catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
}
