// concern: setup-harness-install
/** Runs one confirmed harness install and verifies where its binary became available. */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { which } from 'bun'
import {
  commandFailureReason,
  HARNESS_INSTALL_TIMEOUT_MS,
  type HarnessInstallRoute,
  type HarnessName,
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
): HarnessInstallOutcome {
  return {
    status: 'follow-up',
    message: `${harness} was not installed: ${reason}; run by hand: ${command}`,
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
  environment: { HOME?: string } = process.env,
): HarnessInstallOutcome {
  const result = runner(['/bin/sh', '-c', route.command], HARNESS_INSTALL_TIMEOUT_MS)
  if (result.exitCode !== 0 || result.timedOut || result.error) {
    return manualInstallNotice(harness, commandFailureReason(result), route.command)
  }
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
