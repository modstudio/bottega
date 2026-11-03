// concern: settings-machine-write-authority
/** Guards writes to real harness homes with the registered installation identity. */
import type { Database } from 'bun:sqlite'
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
    (facts.runningCopyIsDistribution && !facts.registeredMainCheckoutExists)
    ? { action: 'allow' }
    : { action: 'refuse-not-registered-main' }
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
  const registration = input.registeredMainCheckout
    ? ''
    : `cleared by: run \`${remedyExecutable} project add ${remedyRoot}\`, then `
  throw new Error(
    `refusing ${input.command} from installation ${runningRoot}: real harness homes may only be written from this machine's installed copy\n` +
      "invariant: A copy other than this machine's installed copy writes harness settings only under the OS temporary directory.\n" +
      `${registration || 'cleared by: run '}\`${remedyExecutable} ${input.command}\``,
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
  const mainCheckout =
    overrides.registeredMainCheckout !== undefined
      ? overrides.registeredMainCheckout
      : registeredMainCheckout(database)
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
