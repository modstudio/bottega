// concern: monitor-storage-conditions
/** Pure storage measurements, rankings, and disk-pressure decisions. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export const STORAGE_WALK_ENTRY_LIMIT = 1_000_000
const FREE_SPACE_PROPORTION_THRESHOLD = 0.1
export const FREE_SPACE_ABSOLUTE_FLOOR_BYTES = 20 * 1024 ** 3
const LARGEST_RUN_LIMIT = 10
const LARGEST_KIND_LIMIT = 3

export type StorageMeasurement = {
  bytes: number | null
  entries: number | null
  state: 'complete' | 'partial' | 'unreadable'
  detail: string | null
}

type LargestRun = {
  runId: number
  ageMs: number | null
  bytes: number
  status: 'live' | 'terminal'
  state: 'complete' | 'partial'
}

export type LargestRuns = {
  state: 'complete' | 'partial'
  runs: LargestRun[]
}

export type StorageVolume = {
  path: string
  freeBytes: number | null
  totalBytes: number | null
  error: string | null
}

export type StorageKindSummary = { label: string; measurement: StorageMeasurement }

export type StoragePressureCondition = {
  kind: 'disk-pressure'
  subject: string
  since: string
  ageMs: 0
  detail: string
  action: string
}

/** Count a multiply linked regular file only at its first path, while preserving visited entries. */
export function deduplicateHardLinkedBytes<T extends { bytes: number; hardLinkKey: string | null }>(
  observations: readonly T[],
): T[] {
  const seen = new Set<string>()
  return observations.map((observation) => {
    if (observation.hardLinkKey === null) return { ...observation }
    if (seen.has(observation.hardLinkKey)) return { ...observation, bytes: 0 }
    seen.add(observation.hardLinkKey)
    return { ...observation }
  })
}

/** Turn bounded observations into an honest total without filesystem access. */
export function storageMeasurement(input: {
  bytes: number
  entries: number
  stoppedAtLimit?: boolean
  errors?: readonly string[]
  unreadable?: string | null
  entryLimit?: number
}): StorageMeasurement {
  if (input.unreadable) {
    return { bytes: null, entries: null, state: 'unreadable', detail: input.unreadable }
  }
  const incomplete = Boolean(input.stoppedAtLimit || input.errors?.length)
  if (!incomplete)
    return { bytes: input.bytes, entries: input.entries, state: 'complete', detail: null }
  const reasons = [
    input.stoppedAtLimit
      ? `walk stopped at the ${input.entryLimit ?? STORAGE_WALK_ENTRY_LIMIT}-entry cap`
      : null,
    ...(input.errors ?? []),
  ].filter((value): value is string => Boolean(value))
  return {
    bytes: input.bytes,
    entries: input.entries,
    state: 'partial',
    detail: `at least ${input.bytes} bytes and ${input.entries} entries; ${reasons.join('; ')}`,
  }
}

/** Rank already-aggregated run sizes deterministically and retain scan completeness. */
export function largestRuns(
  sizes: ReadonlyMap<number, number>,
  facts: ReadonlyMap<number, { startedAt: string; status: string }>,
  clock: number,
  partial = false,
): LargestRuns {
  return {
    state: partial ? 'partial' : 'complete',
    runs: [...sizes]
      .map(([runId, bytes]) => {
        const fact = facts.get(runId)
        const started = fact ? Date.parse(fact.startedAt) : Number.NaN
        return {
          runId,
          bytes,
          ageMs: Number.isFinite(started) ? Math.max(0, clock - started) : null,
          status:
            fact && ['reserved', 'attached', 'running', 'asking'].includes(fact.status)
              ? ('live' as const)
              : ('terminal' as const),
          state: partial ? ('partial' as const) : ('complete' as const),
        }
      })
      .sort((left, right) => right.bytes - left.bytes || left.runId - right.runId)
      .slice(0, LARGEST_RUN_LIMIT),
  }
}

export function storagePressureDecision(volume: StorageVolume): {
  pressured: boolean
  thresholdBytes: number | null
  error: string | null
} {
  if (volume.freeBytes === null || volume.totalBytes === null) {
    return {
      pressured: false,
      thresholdBytes: null,
      error: volume.error ?? 'volume size unreadable',
    }
  }
  const thresholdBytes = Math.max(
    FREE_SPACE_ABSOLUTE_FLOOR_BYTES,
    Math.floor(volume.totalBytes * FREE_SPACE_PROPORTION_THRESHOLD),
  )
  return { pressured: volume.freeBytes < thresholdBytes, thresholdBytes, error: null }
}

function rankedLargestKinds(summaries: readonly StorageKindSummary[]): string[] {
  return summaries
    .filter(({ measurement }) => measurement.bytes !== null)
    .sort(
      (left, right) =>
        (right.measurement.bytes ?? -1) - (left.measurement.bytes ?? -1) ||
        left.label.localeCompare(right.label),
    )
    .slice(0, LARGEST_KIND_LIMIT)
    .map(
      ({ label, measurement }) =>
        `${label} ${measurement.bytes} bytes${measurement.state === 'partial' ? ' (at least)' : ''}`,
    )
}

/** Decide disk pressure and describe its remedy from plain measured facts. */
export function diskPressureCondition(
  volume: StorageVolume,
  summaries: readonly StorageKindSummary[],
  clock: number,
): {
  condition: StoragePressureCondition | null
  error: string | null
  largestKinds: string[]
} {
  const decision = storagePressureDecision(volume)
  const largestKinds = rankedLargestKinds(summaries)
  if (decision.error) return { condition: null, error: decision.error, largestKinds }
  if (!decision.pressured) return { condition: null, error: null, largestKinds }
  return {
    condition: {
      kind: 'disk-pressure',
      subject: volume.path,
      since: new Date(clock).toISOString(),
      ageMs: 0,
      detail: `${volume.freeBytes} free bytes is below the ${decision.thresholdBytes}-byte threshold (10% of ${volume.totalBytes} bytes or the 20 GiB floor); largest storage: ${largestKinds.join(', ') || 'unreadable'}`,
      action: `run ${PLATFORM_SLUG} machine storage, then use ${PLATFORM_SLUG} machine reclaim worktree, sandbox, or stale-run for the classified resources that apply`,
    },
    error: null,
    largestKinds,
  }
}
