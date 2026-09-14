/** Diagnostic payload assembled by the Electron main process for the management window. */

import { formatDesktopMessage, type DesktopMessages } from './locale.ts'

/** Facts the main process reads about one installation. */
export interface DesktopDiagnosticsInput {
  readonly applicationVersion: string
  readonly dshVersion: string
  readonly harnessHome: string
  readonly runtimeLocation: string
  readonly failure: string | undefined
}

/** Installation facts the management window renders and copies as one block. */
export interface DesktopDiagnostics {
  readonly applicationVersion: string
  readonly dshVersion: string
  readonly harnessHome: string
  readonly runtimeLocation: string
  readonly startupFailed: boolean
  readonly startupFailure: string | undefined
  readonly block: string
}

/**
 * Assemble the diagnostic block from locale-owned labels and main-process facts.
 * @param input - Application, runtime, and startup facts read in the main process.
 * @param messages - Shell-owned translations.
 * @returns The payload the management window renders and copies.
 */
export function assembleDesktopDiagnostics(
  input: DesktopDiagnosticsInput,
  messages: DesktopMessages,
): DesktopDiagnostics {
  const startup = input.failure === undefined
    ? messages.diagnosticsStartupSucceeded
    : formatDesktopMessage(messages.diagnosticsStartupFailed, { message: input.failure })
  const block = [
    `${messages.diagnosticsApplication}: ${input.applicationVersion}`,
    `${messages.diagnosticsDsh}: ${input.dshVersion}`,
    `${messages.diagnosticsHome}: ${input.harnessHome}`,
    `${messages.diagnosticsRuntime}: ${input.runtimeLocation}`,
    `${messages.diagnosticsStartup}: ${startup}`,
  ].join('\n')
  return {
    applicationVersion: input.applicationVersion,
    dshVersion: input.dshVersion,
    harnessHome: input.harnessHome,
    runtimeLocation: input.runtimeLocation,
    startupFailed: input.failure !== undefined,
    startupFailure: input.failure,
    block,
  }
}
