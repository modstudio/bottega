// concern: settings-machine-write-authority
/** Guards writes to real harness homes with the registered installation identity. */
import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { mainCheckoutOf } from '../../../shared/git.ts'
import { assetPath, installationIdentity } from '../../../shared/install-root.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
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

function clearedBy(text: string): string {
  return renderRefusal(refusal('', { kind: 'edit', text })).trimStart()
}

export function decideMachineHomeWriteRefusal(input: {
  command: string
  registered: {
    path: string
    executable: string
    version: InstallationVersionRead
    beforeRerun?: string
  }
  running: { path: string; version: InstallationVersionRead }
}): { detail: string | null; remedy: string } {
  const remedyExecutable = input.registered.executable
  const rerun = input.registered.beforeRerun
    ? `run \`${input.registered.beforeRerun}\`, then \`${remedyExecutable} ${input.command}\``
    : `run \`${remedyExecutable} ${input.command}\``
  if ('reason' in input.registered.version || 'reason' in input.running.version) {
    const reason = [input.registered.version, input.running.version]
      .flatMap((value) => ('reason' in value ? [value.reason] : []))
      .join('; ')
    return {
      detail: `could not compare versions: ${reason}`,
      remedy: clearedBy(rerun),
    }
  }
  try {
    if (Bun.semver.order(input.registered.version.version, input.running.version.version) < 0) {
      return {
        detail:
          `registered checkout ${input.registered.path} is version ${input.registered.version.version}; ` +
          `running installation ${input.running.path} is version ${input.running.version.version}`,
        remedy: clearedBy(
          `run \`git -C ${input.registered.path} pull --ff-only\`, then ` +
            (input.registered.beforeRerun ? `\`${input.registered.beforeRerun}\`, then ` : '') +
            `\`${remedyExecutable} ${input.command}\``,
        ),
      }
    }
  } catch (error) {
    return {
      detail: `could not compare versions: ${error instanceof Error ? error.message : String(error)}`,
      remedy: clearedBy(rerun),
    }
  }
  return {
    detail: null,
    remedy: clearedBy(rerun),
  }
}

function installationVersion(root: string): InstallationVersionRead {
  try {
    const identity = installationIdentity(root, {})
    return {
      version: identity.kind === 'distribution' ? identity.manifest.version : identity.version,
    }
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) }
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
  if (input.registeredMainCheckout || remedyRoot !== runningRoot) {
    const refusal = decideMachineHomeWriteRefusal({
      command: input.command,
      registered: {
        path: remedyRoot,
        executable: remedyExecutable,
        version: installationVersion(remedyRoot),
        ...(input.registeredMainCheckout
          ? {}
          : { beforeRerun: `${remedyExecutable} project add ${remedyRoot}` }),
      },
      running: {
        path: runningRoot,
        version: installationVersion(runningRoot),
      },
    })
    detail = refusal.detail
    remedy = refusal.remedy
  } else {
    remedy = clearedBy(
      `run \`${remedyExecutable} project add ${remedyRoot}\`, then ` +
        `\`${remedyExecutable} ${input.command}\``,
    )
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
