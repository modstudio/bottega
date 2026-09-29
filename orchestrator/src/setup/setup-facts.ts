// concern: setup-facts
/** Owns read-only machine setup facts. Must not know the store, registered agents, routing, or CLI grammar. */
import { readFileSync } from 'node:fs'
import { which } from 'bun'
import { runAgentAuthCheck } from '../agent/agent-auth.ts'
import {
  type CliVersionCapture,
  captureCliVersion,
  capturedCliVersion,
} from '../agent/cli-version.ts'
import { localReachable } from '../agent/model-host.ts'
import { sandboxRuntimeAvailability } from '../sandbox/sandbox-runtime.ts'

const COMMAND_TIMEOUT_MS = 3_000
export const KNOWN_HARNESSES = ['codex', 'grok', 'claude', 'opencode', 'goose'] as const
export type HarnessName = (typeof KNOWN_HARNESSES)[number]
type SetupAuthState = 'signed-in' | 'signed-out' | 'unknown'

export type CommandCapture = CliVersionCapture

export type SetupFactsCapture = {
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
  procVersion: string | null
  bun: { path: string; version: string }
  git: { path: string | null; version: CommandCapture | null }
  gh: { path: string | null; version: CommandCapture | null; auth: CommandCapture | null }
  harnesses: Record<
    HarnessName,
    { path: string | null; version: CommandCapture | null; auth: SetupAuthState }
  >
  localModelHost: Awaited<ReturnType<typeof localReachable>>
  sandboxRuntime: ReturnType<typeof sandboxRuntimeAvailability>
}

export type SetupFacts = {
  os: { platform: NodeJS.Platform; arch: NodeJS.Architecture; wsl: boolean }
  bun: { path: string; version: string }
  git: { path: string | null; version: string | null }
  gh: { path: string | null; version: string | null; loggedIn: boolean }
  harnesses: Record<
    HarnessName,
    { path: string | null; version: string | null; auth: SetupAuthState }
  >
  localModelHost: Awaited<ReturnType<typeof localReachable>>
  sandboxRuntime: ReturnType<typeof sandboxRuntimeAvailability>
}

export function classifySetupFacts(capture: SetupFactsCapture): SetupFacts {
  return {
    os: {
      platform: capture.platform,
      arch: capture.arch,
      wsl: capture.platform === 'linux' && /microsoft|wsl/i.test(capture.procVersion ?? ''),
    },
    bun: capture.bun,
    git: { path: capture.git.path, version: capturedCliVersion(capture.git.version) },
    gh: {
      path: capture.gh.path,
      version: capturedCliVersion(capture.gh.version),
      loggedIn: capture.gh.auth?.exitCode === 0 && !capture.gh.auth.timedOut,
    },
    harnesses: Object.fromEntries(
      KNOWN_HARNESSES.map((name) => [
        name,
        {
          path: capture.harnesses[name].path,
          version: capturedCliVersion(capture.harnesses[name].version),
          auth: capture.harnesses[name].auth,
        },
      ]),
    ) as SetupFacts['harnesses'],
    localModelHost: capture.localModelHost,
    sandboxRuntime: capture.sandboxRuntime,
  }
}

function runCommand(argv: string[]): CommandCapture {
  try {
    const child = Bun.spawnSync(argv, {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: COMMAND_TIMEOUT_MS,
    })
    return {
      exitCode: child.exitCode,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
      timedOut: child.exitedDueToTimeout === true,
      error: null,
    }
  } catch (error) {
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function versionCapture(path: string | null): CommandCapture | null {
  return path ? captureCliVersion(path) : null
}

function procVersion(): string | null {
  if (process.platform !== 'linux') return null
  try {
    return readFileSync('/proc/version', 'utf8')
  } catch {
    return null
  }
}

/** Gather bounded, read-only observations without consulting agent registration rows. */
export async function gatherSetupFacts(): Promise<SetupFacts> {
  const gitPath = which('git', { PATH: process.env.PATH })
  const ghPath = which('gh', { PATH: process.env.PATH })
  const harnesses = Object.fromEntries(
    KNOWN_HARNESSES.map((name) => {
      const path = which(name, { PATH: process.env.PATH })
      const auth =
        path && (name === 'codex' || name === 'grok') ? runAgentAuthCheck(name, path) : null
      return [
        name,
        {
          path,
          version: versionCapture(path),
          auth: auth?.status === 'ready' ? 'signed-in' : (auth?.status ?? 'unknown'),
        },
      ]
    }),
  ) as SetupFactsCapture['harnesses']
  return classifySetupFacts({
    platform: process.platform,
    arch: process.arch,
    procVersion: procVersion(),
    bun: { path: process.execPath, version: Bun.version },
    git: { path: gitPath, version: versionCapture(gitPath) },
    gh: {
      path: ghPath,
      version: versionCapture(ghPath),
      auth: ghPath ? runCommand([ghPath, 'auth', 'status', '--hostname', 'github.com']) : null,
    },
    harnesses,
    localModelHost: await localReachable(),
    sandboxRuntime: sandboxRuntimeAvailability(),
  })
}
