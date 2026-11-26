// concern: settings-machine-write-authority
/** Guards writes to real harness homes with the registered installation identity. */
import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { mainCheckoutOf } from '../../../shared/git.ts'
import { assetPath, installationIdentity } from '../../../shared/install-root.ts'
import {
  realPathForPotentialPath,
  temporaryStateStoreMigrationAllowed,
} from '../../../shared/state-directory.ts'
import { db } from '../database/db.ts'
import { projectByName } from '../project/projects.ts'

export type MachineHomeWriteAuthorityDecision =
  | { action: 'allow' }
  | { action: 'refuse-not-registered-main' }

export function decideMachineHomeWriteAuthority(facts: {
  runningFromRegisteredMainCheckout: boolean
  runningCopyIsDistribution: boolean
  registeredMainCheckoutExists: boolean
  targetHomesUnderTemporaryDirectory: boolean
}): MachineHomeWriteAuthorityDecision {
  return facts.runningFromRegisteredMainCheckout ||
    facts.targetHomesUnderTemporaryDirectory ||
    facts.runningCopyIsDistribution
    ? { action: 'allow' }
    : { action: 'refuse-not-registered-main' }
}

export type InstallationVersionRead = { version: string } | { reason: string }

export function decideMachineHomeWriteRefusal(input: {
  command: string
  registered: { path: string; version: InstallationVersionRead }
  running: { path: string; version: InstallationVersionRead }
}): { detail: string | null; remedy: string } {
  const remedyExecutable = join(input.registered.path, 'bin', PLATFORM_SLUG)
  if ('reason' in input.registered.version || 'reason' in input.running.version) {
    const reason = [input.registered.version, input.running.version]
      .flatMap((value) => ('reason' in value ? [value.reason] : []))
      .join('; ')
    return {
      detail: `could not compare versions: ${reason}`,
      remedy: `cleared by: run \`${remedyExecutable} ${input.command}\``,
    }
  }
  try {
    if (Bun.semver.order(input.registered.version.version, input.running.version.version) < 0) {
      return {
        detail:
          `registered checkout ${input.registered.path} is version ${input.registered.version.version}; ` +
          `running installation ${input.running.path} is version ${input.running.version.version}`,
        remedy:
          `cleared by: run \`git -C ${input.registered.path} pull --ff-only\`, then ` +
          `\`${remedyExecutable} ${input.command}\``,
      }
    }
  } catch (error) {
    return {
      detail: `could not compare versions: ${error instanceof Error ? error.message : String(error)}`,
      remedy: `cleared by: run \`${remedyExecutable} ${input.command}\``,
    }
  }
  return {
    detail: null,
    remedy: `cleared by: run \`${remedyExecutable} ${input.command}\``,
  }
}

function readInstallationVersion(root: string): InstallationVersionRead {
  const manifestPath = join(root, 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
    if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
      return { reason: `${manifestPath} has no version` }
    }
    return { version: manifest.version }
  } catch (error) {
    return {
      reason: `${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function registeredMainCheckout(database: Database): string | null {
  return projectByName(PLATFORM_SLUG, database)?.path ?? null
}

function isRunningFromRegisteredMainCheckout(
  runningInstallationRoot: string,
  mainCheckout: string | null,
): boolean {
  return (
    mainCheckout !== null &&
    realPathForPotentialPath(runningInstallationRoot) === realPathForPotentialPath(mainCheckout)
  )
}

export function machineHomesUnderTemporaryDirectory(
  targetHomes: readonly string[],
  temporaryRoot = tmpdir(),
  userHome = homedir(),
): boolean {
  const temporaryDirectory = realPathForPotentialPath(temporaryRoot)
  const resolvedUserHome = realPathForPotentialPath(userHome)
  if (
    resolvedUserHome === temporaryDirectory ||
    temporaryStateStoreMigrationAllowed(resolvedUserHome, temporaryDirectory)
  ) {
    return false
  }
  return targetHomes.every((home) =>
    temporaryStateStoreMigrationAllowed(realPathForPotentialPath(home), temporaryDirectory),
  )
}

export function assertMachineHomeWriteAuthority(input: {
  command: string
  targetHomes: readonly string[]
  runningFromRegisteredMainCheckout: boolean
  runningCopyIsDistribution: boolean
  registeredMainCheckout: string | null
  runningInstallationRoot: string
  binaryRepositoryRoot: string | null
}): void {
  const decision = decideMachineHomeWriteAuthority({
    runningFromRegisteredMainCheckout: input.runningFromRegisteredMainCheckout,
    runningCopyIsDistribution: input.runningCopyIsDistribution,
    registeredMainCheckoutExists: input.registeredMainCheckout !== null,
    targetHomesUnderTemporaryDirectory: machineHomesUnderTemporaryDirectory(input.targetHomes),
  })
  if (decision.action === 'allow') return
  const runningRoot = input.runningInstallationRoot
  const remedyRoot = input.registeredMainCheckout ?? input.binaryRepositoryRoot ?? runningRoot
  const remedyExecutable = join(remedyRoot, 'bin', PLATFORM_SLUG)
  let remedy: string
  let detail: string | null = null
  if (input.registeredMainCheckout) {
    const refusal = decideMachineHomeWriteRefusal({
      command: input.command,
      registered: {
        path: input.registeredMainCheckout,
        version: readInstallationVersion(input.registeredMainCheckout),
      },
      running: {
        path: runningRoot,
        version: readInstallationVersion(runningRoot),
      },
    })
    detail = refusal.detail
    remedy = refusal.remedy
  } else {
    remedy =
      `cleared by: run \`${remedyExecutable} project add ${remedyRoot}\`, then ` +
      `\`${remedyExecutable} ${input.command}\``
  }
  throw new Error(
    `refusing ${input.command} from installation ${runningRoot}: real harness homes may only be written from this machine's installed copy\n` +
      "invariant: A copy other than this machine's installed copy writes harness settings only under the OS temporary directory.\n" +
      (detail ? `${detail}\n` : '') +
      remedy,
  )
}

export function assertCurrentMachineHomeWriteAuthority(
  command: string,
  targetHomes: readonly string[],
  database: Database = db(),
  overrides: {
    runningFromRegisteredMainCheckout?: boolean
    runningCopyIsDistribution?: boolean
    registeredMainCheckout?: string | null
    runningInstallationRoot?: string
    binaryRepositoryRoot?: string | null
  } = {},
): void {
  const runningRoot = overrides.runningInstallationRoot ?? assetPath()
  const registeredCheckout =
    overrides.registeredMainCheckout !== undefined
      ? overrides.registeredMainCheckout
      : registeredMainCheckout(database)
  const mainCheckout =
    registeredCheckout && existsSync(registeredCheckout) ? registeredCheckout : null
  assertMachineHomeWriteAuthority({
    command,
    targetHomes,
    runningFromRegisteredMainCheckout:
      overrides.runningFromRegisteredMainCheckout ??
      isRunningFromRegisteredMainCheckout(runningRoot, mainCheckout),
    runningCopyIsDistribution:
      overrides.runningCopyIsDistribution ??
      installationIdentity(import.meta.dir, {}).kind === 'distribution',
    registeredMainCheckout: mainCheckout,
    runningInstallationRoot: runningRoot,
    binaryRepositoryRoot:
      overrides.binaryRepositoryRoot !== undefined
        ? overrides.binaryRepositoryRoot
        : mainCheckoutOf(runningRoot),
  })
}
