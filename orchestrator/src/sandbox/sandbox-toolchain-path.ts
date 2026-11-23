// concern: host toolchain resolution for commands launched inside the sandbox.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startBoundedSync } from '../../../shared/bounded-process.ts'

const COMMAND_LINE_TOOLS_DEVELOPER_DIR = '/Library/Developer/CommandLineTools'

/** macOS needs the real developer-tool directory because Linux SRT has no xcrun git shim. */
export function sandboxToolchainPrefix(platform: string, developerDir: string | null): string {
  if (platform !== 'darwin' || developerDir === null) return ''
  const developerBin = join(developerDir, 'usr', 'bin')
  const quotedDeveloperBin = /^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/.test(developerBin)
    ? developerBin
    : `'${developerBin.replaceAll("'", `'"'"'`)}'`
  return `PATH=${quotedDeveloperBin}\${PATH:+:$PATH}; export PATH; `
}

function hasGit(developerDir: string): boolean {
  return existsSync(join(developerDir, 'usr', 'bin', 'git'))
}

function resolveDeveloperDirectory(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const selected = startBoundedSync(['xcode-select', '-p'], { budget: 'sandbox-probe' })
    const developerDir = selected.exitCode === 0 ? selected.stdout.trim() : ''
    if (developerDir && hasGit(developerDir)) return developerDir
  } catch {}
  return hasGit(COMMAND_LINE_TOOLS_DEVELOPER_DIR) ? COMMAND_LINE_TOOLS_DEVELOPER_DIR : null
}

let memoizedDeveloperDirectory: string | null | undefined

/** Resolve the host developer directory at most once in this process. */
export function sandboxDeveloperDirectory(): string | null {
  if (memoizedDeveloperDirectory === undefined) {
    memoizedDeveloperDirectory = resolveDeveloperDirectory()
  }
  return memoizedDeveloperDirectory
}
