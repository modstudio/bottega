// concern: run confinement adapter
/** Gathers launch facts for the pure checkout classifier and removal attribution. */
import type { Database } from 'bun:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  callerCheckoutWatch,
  type FreezeFailure,
  freezeCheckouts,
} from '../confinement/confinement.ts'
import { checkoutWatchSet } from '../git/checkout-identity.ts'
import { gitContext } from '../git/git-environment.ts'
import { checkoutRemovalAttribution } from '../resources/resource-claims.ts'
import { confinementRoots } from './run-acp-writer.ts'
import { callerWatch } from './run-caller-watch.ts'

const HARNESS_CONFINEMENT_FILE = 'harness-confinement.json'

export type HarnessConfinementSnapshot = {
  callerCheckout: string | null
  watchedCheckouts: import('../confinement/confinement.ts').FrozenCheckout[]
  confinementFailures: FreezeFailure[]
}

export function writeHarnessConfinementSnapshot(
  runDirectory: string,
  snapshot: HarnessConfinementSnapshot,
): void {
  writeFileSync(join(runDirectory, HARNESS_CONFINEMENT_FILE), JSON.stringify(snapshot))
}

export function readHarnessConfinementSnapshot(runDirectory: string): HarnessConfinementSnapshot {
  return JSON.parse(
    readFileSync(join(runDirectory, HARNESS_CONFINEMENT_FILE), 'utf8'),
  ) as HarnessConfinementSnapshot
}

export function confinementSkipLines(failures: FreezeFailure[]): string[] {
  return failures.map(
    (failure) =>
      `confinement watch skipped ${failure.project} at ${failure.path}: ${failure.error}; ` +
      `fix the register with ${PLATFORM_SLUG} project set`,
  )
}

export function freezeBeforeRunCheckouts(input: {
  srtProfile: { filesystem: { allowWrite: string[] } } | null
  agent: string
  cwd: string
  writableRoots: string[]
  tmpDir: string | undefined
  codexSandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  callerCwd: string
  isolatedCwd: string | null
  runProject: { name: string } | null
  activeWorktree: string | undefined
  runProjectName: string | null
}) {
  const roots = confinementRoots(
    input.srtProfile,
    input.agent,
    input.cwd,
    input.writableRoots,
    input.tmpDir,
    input.codexSandbox,
  )
  const callerCheckout = input.runProject
    ? (gitContext(input.callerCwd, 'rev-parse', '--show-toplevel') ?? input.callerCwd)
    : null
  const candidates = checkoutWatchSet(
    callerWatch(callerCheckout, input.isolatedCwd, input.runProject),
    input.activeWorktree,
    input.runProjectName,
  )
  const beforeFreeze = freezeCheckouts(candidates.watched, {
    callerWatch: callerCheckoutWatch(callerCheckout, roots),
  })
  return { callerCheckout, candidates, beforeFreeze }
}

export function callerRemovalAtRunEnd(
  database: Database,
  callerCheckout: string | null,
  started: number,
) {
  return checkoutRemovalAttribution(database, callerCheckout ?? '', new Date(started).toISOString())
}
