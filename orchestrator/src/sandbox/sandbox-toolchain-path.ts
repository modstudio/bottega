// concern: host toolchain resolution for commands launched inside the sandbox.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startBoundedSync } from '../../../shared/bounded-process.ts'

const COMMAND_LINE_TOOLS_DEVELOPER_DIR = '/Library/Developer/CommandLineTools'

/** macOS needs the real developer-tool directory because Linux SRT has no xcrun git shim. */
export function sandboxToolchainPath(input: {
  platform: string
  developerDir: string | null
  path: string
}): string {
  if (input.platform !== 'darwin' || input.developerDir === null) return input.path
  const developerBin = join(input.developerDir, 'usr', 'bin')
  if (input.path.split(':', 1)[0] === developerBin) return input.path
  return `${developerBin}:${input.path}`
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

/** Build the child argv that applies the host-resolved toolchain only when PATH changes. */
export function sandboxToolchainCommandArgv(
  platform: string,
  path: string,
  bin: string,
  argv: string[],
): string[] {
  const sandboxPath = sandboxToolchainPath({
    platform,
    developerDir: sandboxDeveloperDirectory(),
    path,
  })
  return sandboxPath === path
    ? [bin, ...argv]
    : ['/usr/bin/env', `PATH=${sandboxPath}`, bin, ...argv]
}
