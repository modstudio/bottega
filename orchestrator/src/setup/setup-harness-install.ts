// concern: setup-harness-install
/** Runs one confirmed harness install and verifies where its binary became available. */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { which } from 'bun'
import {
  HARNESS_INSTALL_TIMEOUT_MS,
  type HarnessInstallRoute,
  type HarnessName,
  resultFailure,
  runSetupCommand,
  type SetupCommandRunner,
} from './setup-mcp.ts'

export type HarnessInstallDetector = {
  which(name: string): string | null
  isFile(path: string): boolean
}

const defaultDetector: HarnessInstallDetector = {
  which: (name) => which(name, { PATH: process.env.PATH }),
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
}

export type HarnessInstallOutcome = {
  status: 'applied' | 'follow-up'
  message: string
}

function manualInstallNotice(
  harness: HarnessName,
  reason: string,
  command: string,
  output = '',
): HarnessInstallOutcome {
  const tail = output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-10)
    .join('\n')
    .slice(-2_000)
  return {
    status: 'follow-up',
    message: `${harness} was not installed: ${reason}${tail ? `\n${tail}` : ''}; run by hand: ${command}`,
  }
}

function expandedBinDir(binDir: string, home: string | undefined): string | null {
  if (binDir === '~') return home ?? null
  if (binDir.startsWith('~/')) return home ? join(home, binDir.slice(2)) : null
  return binDir
}

export function installHarness(
  harness: HarnessName,
  route: HarnessInstallRoute,
  runner: SetupCommandRunner = runSetupCommand,
  detector: HarnessInstallDetector = defaultDetector,
  environment: { HOME?: string } = { HOME: process.env.HOME },
): HarnessInstallOutcome {
  const result = runner(['/bin/sh', '-c', route.command], HARNESS_INSTALL_TIMEOUT_MS)
  const failure = resultFailure(result)
  if (failure)
    return manualInstallNotice(
      harness,
      failure,
      route.command,
      `${result.stdout}\n${result.stderr}`,
    )
  const path = detector.which(harness)
  if (path) return { status: 'applied', message: `installed ${harness} at ${path}` }
  if (route.binDir) {
    const binDir = expandedBinDir(route.binDir, environment.HOME)
    const candidate = binDir ? join(binDir, harness) : null
    if (candidate && detector.isFile(candidate)) {
      return {
        status: 'follow-up',
        message: `installed ${harness} at ${candidate}; add ${route.binDir} to PATH`,
      }
    }
  }
  return manualInstallNotice(
    harness,
    'the command completed but the binary was not found',
    route.command,
  )
}

export function skippedHarnessInstall(
  harness: HarnessName,
  route: HarnessInstallRoute,
): HarnessInstallOutcome {
  return manualInstallNotice(harness, 'installation was skipped', route.command)
}
