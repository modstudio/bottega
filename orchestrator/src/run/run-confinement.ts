// concern: run confinement adapter
/** Gathers launch facts for the pure checkout classifier and removal attribution. */
import type { Database } from 'bun:sqlite'
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
