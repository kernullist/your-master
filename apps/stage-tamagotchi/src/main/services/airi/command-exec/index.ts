import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type { ElectronCommandRunResult } from '../../../../shared/eventa'

import { Buffer } from 'node:buffer'
import { exec } from 'node:child_process'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { BrowserWindow, dialog } from 'electron'

import { electronCommandRun } from '../../../../shared/eventa'
import { clampOutput, COMMAND_OUTPUT_MAX_BYTES, COMMAND_TIMEOUT_MS, commandBlockReason, validateCwd } from './policy'

/**
 * Shell command execution service: every run is user-approved, dangerous
 * commands are blocked outright.
 *
 * Call stack:
 *
 * setupMainWindowElectronInvokes / setupChatWindowElectronInvokes (../../../windows)
 *   -> {@link createCommandExecService}
 *     -> {@link electronCommandRun}
 *       -> {@link commandBlockReason} (categorical block)
 *         -> dialog.showMessageBox (approval gate)
 *           -> child_process.exec (timeout + output cap)
 */
export function createCommandExecService(params: {
  context: ReturnType<typeof createContext>['context']
}) {
  const log = useLogg('main/command-exec').useGlobalConfig()

  // The approval dialog parents to whatever window is focused at request time
  // (no window is bound to this single global context). Falls back to a
  // parent-less modal if nothing is focused.
  const approve = async (detail: string): Promise<boolean> => {
    const parent = BrowserWindow.getFocusedWindow() ?? undefined
    const options = {
      type: 'warning' as const,
      title: 'AIRI command execution request',
      message: 'AIRI wants to run a shell command:',
      detail,
      buttons: ['Deny', 'Approve'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const choice = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    return choice.response === 1
  }

  defineInvokeHandler(params.context, electronCommandRun, async (payload): Promise<ElectronCommandRunResult> => {
    const command = payload?.command ?? ''
    const cwd = payload?.cwd?.trim() || undefined

    const blocked = commandBlockReason(command)
    if (blocked) {
      log.withFields({ command, blocked }).warn('command blocked by policy')
      return { ok: false, message: blocked }
    }

    const cwdInvalid = validateCwd(cwd)
    if (cwdInvalid) {
      return { ok: false, message: cwdInvalid }
    }

    // Approval gate: default button is "deny" so an accidental Enter never
    // runs a command.
    const approved = await approve(`${command}${cwd ? `\n\nworking directory: ${cwd}` : ''}`)
    if (!approved) {
      log.withFields({ command }).log('command denied by user')
      return { ok: false, message: 'user denied the command' }
    }

    return await new Promise<ElectronCommandRunResult>((resolve) => {
      // NOTICE:
      // exec runs through the platform shell (cmd.exe on Windows), which is
      // what users mean by "run this command". maxBuffer guards against an
      // OOM from a chatty process; timeout kills runaways (SIGTERM then the
      // OS cleans up). Output is clamped again for the model's context.
      exec(command, {
        cwd,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_OUTPUT_MAX_BYTES * 4,
        windowsHide: true,
        encoding: 'utf-8',
      }, (error, stdout, stderr) => {
        const stdoutText = clampOutput(typeof stdout === 'string' ? stdout : Buffer.from(stdout).toString('utf-8'))
        const stderrText = clampOutput(typeof stderr === 'string' ? stderr : Buffer.from(stderr).toString('utf-8'))

        if (error) {
          // `killed` with a signal indicates the timeout fired.
          if ((error as { killed?: boolean }).killed) {
            log.withFields({ command }).warn('command timed out')
            resolve({ ok: false, message: `command timed out after ${COMMAND_TIMEOUT_MS}ms`, stdout: stdoutText, stderr: stderrText })
            return
          }

          const exitCode = typeof (error as { code?: number }).code === 'number' ? (error as { code: number }).code : undefined
          log.withFields({ command, exitCode }).log('command finished with non-zero exit')
          resolve({ ok: true, exitCode, stdout: stdoutText, stderr: stderrText, message: `command exited with code ${exitCode ?? 'unknown'}` })
          return
        }

        log.withFields({ command }).log('command executed successfully')
        resolve({ ok: true, exitCode: 0, stdout: stdoutText, stderr: stderrText, message: 'command executed successfully' })
      })
    })
  })
}
