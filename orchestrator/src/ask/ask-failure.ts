// concern: ask-server startup failure artifact
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ASK_SERVER_FAILURE_FILE = 'ask-server-failure.txt'

export function askServerFailurePath(scratchDir: string): string {
  return join(scratchDir, ASK_SERVER_FAILURE_FILE)
}

export function writeAskServerFailure(error: unknown, scratchDir = process.env.ORCH_SCRATCH): void {
  if (!scratchDir) return
  const line = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ')
  try {
    mkdirSync(scratchDir, { recursive: true })
    writeFileSync(askServerFailurePath(scratchDir), `${line}\n`)
  } catch {
    // Evidence is best effort and must not replace the command's original failure.
  }
}

export function readAskServerFailure(scratchDir: string): string | null {
  const path = askServerFailurePath(scratchDir)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/, 1)[0] || null
  } catch {
    return null
  }
}
