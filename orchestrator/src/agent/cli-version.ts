// concern: agent-cli-version
/** Captures one bounded CLI version probe for agent eligibility and setup facts. */

import { startBoundedSync } from '../../../shared/bounded-process.ts'
import { BoundExceededError } from '../../../shared/call-budgets.ts'

export type CliVersionCapture = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  error: string | null
}

/** Keep the established agent-version grammar: only a full three-part version is accepted. */
function parsedCliVersion(text: string): string | null {
  return text.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null
}

export function capturedCliVersion(capture: CliVersionCapture | null): string | null {
  if (!capture || capture.error || capture.timedOut || capture.exitCode !== 0) return null
  return parsedCliVersion(`${capture.stdout}\n${capture.stderr}`)
}

export function captureCliVersion(bin: string): CliVersionCapture {
  try {
    const child = startBoundedSync([bin, '--version'], {
      budget: 'agent-cli',
    })
    return {
      exitCode: child.exitCode,
      stdout: child.stdout,
      stderr: child.stderr,
      timedOut: false,
      error: null,
    }
  } catch (error) {
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: error instanceof BoundExceededError,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
