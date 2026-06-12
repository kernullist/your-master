import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type { ElectronWindowActionResult, ElectronWindowListResult } from '../../../../shared/eventa'

import process from 'node:process'

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { BrowserWindow, dialog } from 'electron'

import { electronOsWindowClose, electronOsWindowFocus, electronOsWindowList } from '../../../../shared/eventa'
import { parseWindowList, validateWindowMatch } from './script'

const execFileAsync = promisify(execFile)

/** PowerShell call timeout; window ops are near-instant. */
const PWSH_TIMEOUT_MS = 5000

// Enumerates top-level windows with a visible title as compact JSON.
const LIST_SCRIPT = `Get-Process | Where-Object { $_.MainWindowTitle -ne '' -and $_.MainWindowHandle -ne 0 } | Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress`

// Focus: restore (un-minimize) and bring the first title-matching window to
// the foreground. The match string is read from an env var so no untrusted
// text is interpolated into the script (injection-safe).
const FOCUS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AiriWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
$m = $env:AIRI_WIN_MATCH
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$m*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) {
  [void][AiriWin]::ShowWindow($p.MainWindowHandle, 9)
  [void][AiriWin]::SetForegroundWindow($p.MainWindowHandle)
  Write-Output ("focused: " + $p.MainWindowTitle)
} else {
  Write-Output ("no window matching: " + $m)
}
`.trim()

// Close: graceful CloseMainWindow (sends WM_CLOSE) so the app can prompt to
// save unsaved work — never a force kill.
const CLOSE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$m = $env:AIRI_WIN_MATCH
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$m*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) {
  $t = $p.MainWindowTitle
  [void]$p.CloseMainWindow()
  Write-Output ("closed: " + $t)
} else {
  Write-Output ("no window matching: " + $m)
}
`.trim()

async function runPowerShell(script: string, match?: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      timeout: PWSH_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf-8',
      env: match === undefined ? process.env : { ...process.env, AIRI_WIN_MATCH: match },
    },
  )
  return stdout
}

/**
 * Window-control service: list, focus, and gracefully close OS windows on
 * Windows via PowerShell + Win32 (no native deps).
 *
 * List and focus are benign (no data loss); close is approval-gated because a
 * graceful close can still prompt about unsaved work.
 *
 * Call stack:
 *
 * main/index.ts -> setupDesktopAssistantServices
 *   -> {@link createWindowControlService}
 *     -> {@link electronOsWindowList} / {@link electronOsWindowFocus} / {@link electronOsWindowClose}
 *       -> PowerShell ({@link parseWindowList}, {@link validateWindowMatch})
 */
export function createWindowControlService(params: {
  context: ReturnType<typeof createContext>['context']
}) {
  const log = useLogg('main/window-control').useGlobalConfig()

  defineInvokeHandler(params.context, electronOsWindowList, async (): Promise<ElectronWindowListResult> => {
    try {
      const stdout = await runPowerShell(LIST_SCRIPT)
      return { windows: parseWindowList(stdout) }
    }
    catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  defineInvokeHandler(params.context, electronOsWindowFocus, async (payload): Promise<ElectronWindowActionResult> => {
    const match = payload?.match ?? ''
    const invalid = validateWindowMatch(match)
    if (invalid) {
      return { ok: false, message: invalid }
    }

    try {
      const stdout = (await runPowerShell(FOCUS_SCRIPT, match.trim())).trim()
      const ok = stdout.startsWith('focused:')
      log.withFields({ match, ok }).log('window focus')
      return { ok, message: stdout }
    }
    catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  defineInvokeHandler(params.context, electronOsWindowClose, async (payload): Promise<ElectronWindowActionResult> => {
    const match = payload?.match ?? ''
    const invalid = validateWindowMatch(match)
    if (invalid) {
      return { ok: false, message: invalid }
    }

    // Approval gate: closing a window can lose unsaved work.
    const parent = BrowserWindow.getFocusedWindow() ?? undefined
    const dialogOptions = {
      type: 'warning' as const,
      title: 'AIRI window close request',
      message: 'AIRI wants to close a window:',
      detail: `Any window whose title contains:\n"${match.trim()}"\n\nThe app will close gracefully and may prompt to save unsaved work.`,
      buttons: ['Deny', 'Approve'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const choice = parent
      ? await dialog.showMessageBox(parent, dialogOptions)
      : await dialog.showMessageBox(dialogOptions)

    if (choice.response !== 1) {
      log.withFields({ match }).log('window close denied by user')
      return { ok: false, message: 'user denied the window close' }
    }

    try {
      const stdout = (await runPowerShell(CLOSE_SCRIPT, match.trim())).trim()
      const ok = stdout.startsWith('closed:')
      log.withFields({ match, ok }).log('window close')
      return { ok, message: stdout }
    }
    catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
}
