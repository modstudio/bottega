// concern: machine-home-write-authority
/** Guards writes to real harness homes with the registered installation identity. */
import type { Database } from 'bun:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { assetPath } from '../../../shared/install-root.ts'
import {
  realPathForPotentialPath,
  temporaryStateStoreMigrationAllowed,
} from '../../../shared/state-directory.ts'
import { DATABASE_RESOLUTION, db } from '../database/db.ts'
import { projectByName } from '../project/projects.ts'

export type MachineHomeWriteAuthorityDecision =
  | { action: 'allow' }
  | { action: 'refuse-not-registered-main' }

export function decideMachineHomeWriteAuthority(facts: {
  runningFromRegisteredMainCheckout: boolean
  targetHomesUnderTemporaryDirectory: boolean
}): MachineHomeWriteAuthorityDecision {
  return facts.runningFromRegisteredMainCheckout || facts.targetHomesUnderTemporaryDirectory
    ? { action: 'allow' }
    : { action: 'refuse-not-registered-main' }
}

export function registeredMainCheckout(database: Database = db()): string | null {
  return projectByName(PLATFORM_SLUG, database)?.path ?? null
}

export function isRunningFromRegisteredMainCheckout(
  runningInstallationRoot = assetPath(),
  mainCheckout = registeredMainCheckout(),
): boolean {
  return (
    mainCheckout !== null &&
    realPathForPotentialPath(runningInstallationRoot) === realPathForPotentialPath(mainCheckout)
  )
}

export function machineHomesUnderTemporaryDirectory(targetHomes: readonly string[]): boolean {
  const temporaryDirectory = realPathForPotentialPath(tmpdir())
  return targetHomes.every((home) =>
    temporaryStateStoreMigrationAllowed(realPathForPotentialPath(home), temporaryDirectory),
  )
}

export function assertMachineHomeWriteAuthority(input: {
  command: string
  targetHomes: readonly string[]
  runningFromRegisteredMainCheckout: boolean
  registeredMainCheckout?: string | null
  runningInstallationRoot?: string
  binaryRepositoryRoot?: string | null
}): void {
  const decision = decideMachineHomeWriteAuthority({
    runningFromRegisteredMainCheckout: input.runningFromRegisteredMainCheckout,
    targetHomesUnderTemporaryDirectory: machineHomesUnderTemporaryDirectory(input.targetHomes),
  })
  if (decision.action === 'allow') return
  const runningRoot = input.runningInstallationRoot ?? assetPath()
  const remedyRoot =
    input.registeredMainCheckout ??
    input.binaryRepositoryRoot ??
    DATABASE_RESOLUTION.binaryRepositoryRoot ??
    runningRoot
  throw new Error(
    `refusing ${input.command} from installation ${runningRoot}: real harness homes may only be written from the registered main checkout\n` +
      'invariant: A secondary checkout writes harness settings only under the OS temporary directory.\n' +
      `cleared by: run \`${join(remedyRoot, 'bin', PLATFORM_SLUG)} ${input.command}\``,
  )
}

export function assertCurrentMachineHomeWriteAuthority(
  command: string,
  targetHomes: readonly string[],
  database: Database = db(),
): void {
  const mainCheckout = registeredMainCheckout(database)
  assertMachineHomeWriteAuthority({
    command,
    targetHomes,
    runningFromRegisteredMainCheckout: isRunningFromRegisteredMainCheckout(
      assetPath(),
      mainCheckout,
    ),
    registeredMainCheckout: mainCheckout,
  })
}
