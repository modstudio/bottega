// concern: harness session publication decisions

import type { HarnessName } from '../../../shared/harness-name.ts'
import type { PidRecordIdentity } from '../../../shared/process-identity.ts'

export type HarnessProcessIdentity = { pid: number; startTime: string }
export type HarnessProcessFact = { pid: number; startTime: string; command: string }

export type HarnessSessionPublication = {
  identity: HarnessProcessIdentity
  session: string
  harness: HarnessName
  source: string
  published_at: string
}

export type HarnessSessionDisposition = 'reap' | 'keep' | 'unknown'
export type ObservedHarnessSessionPublication = HarnessSessionPublication & {
  observedIdentity: PidRecordIdentity
}

export const HARNESS_SESSION_TEMP_GRACE_MS = 60_000
const TEMPORARY_PUBLICATION =
  /^\.\d+-.+\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i

/** Decide how storage treats a publication after observing its process identity. */
export function harnessSessionDisposition(identity: PidRecordIdentity): HarnessSessionDisposition {
  if (identity === 'dead' || identity === 'reused') return 'reap'
  if (identity === 'live') return 'keep'
  return 'unknown'
}

/** Decide whether a directory entry is an expired staging publication. */
export function temporaryPublicationDisposition(
  name: string,
  mtimeMs: number,
  nowMs: number,
): 'reap' | 'keep' | 'ignore' {
  if (!TEMPORARY_PUBLICATION.test(name)) return 'ignore'
  return nowMs - mtimeMs > HARNESS_SESSION_TEMP_GRACE_MS ? 'reap' : 'keep'
}

/** Whether the first command token names the Claude harness executable. */
export function isClaudeHarness(process: Pick<HarnessProcessFact, 'command'>): boolean {
  const executable = process.command.trim().split(/\s+/, 1)[0] ?? ''
  return executable.split('/').at(-1) === 'claude'
}

/** Find live Claude harness processes whose pid has no publication proven live by the reaper. */
export function unpublishedHarnessProcesses(
  processes: readonly HarnessProcessFact[],
  publications: readonly Pick<ObservedHarnessSessionPublication, 'identity' | 'observedIdentity'>[],
): HarnessProcessFact[] {
  return processes
    .filter(isClaudeHarness)
    .filter(
      (process) =>
        !publications.some(
          (publication) =>
            publication.observedIdentity === 'live' &&
            publication.identity.pid === process.pid &&
            publication.identity.startTime === process.startTime,
        ),
    )
}
