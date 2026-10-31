// concern: per-minute host-load series
/** Samples machine load to a bounded log and summarizes windows for operators. */

import type { Database } from 'bun:sqlite'
import { dirname } from 'node:path'
import {
  boundedJsonLinePath,
  readBoundedJsonLinesSince,
  writeBoundedJsonLine,
} from '../../shared/bounded-json-lines-log.ts'
import type { StateEnvironment } from '../../shared/state-directory.ts'
import {
  type ContentionWait,
  isHostCapacityWait,
  loadContentionWaits,
} from './database/contention.ts'
import { type HostLoad, measureHostLoad } from './gate-load.ts'
import { nearestRankPercentile } from './state/statistics.ts'

export const HOST_LOAD_WAIT_MIN_MS = 10_000
const HOST_LOAD_LOG_MAX_BYTES = 4 * 1024 * 1024
const HOST_LOAD_SAMPLE_INTERVAL_MS = 1_000
export const HOST_LOAD_LOG_NAME = 'orchestrator/host-load'

export type HostLoadSeriesSample = {
  at: string
  cpuBusy: number
  swapUsed: number
  loadavg1: number
}

export type HostLoadWindow = {
  sampleCount: number
  firstSampleAt: string
  lastSampleAt: string
  cpuBusyQuantiles: Record<string, number>
  latestSwapUsed: number
  swapDelta: number
  latestLoadavg1: number
  hostCapacityWaitCount: number
}

type SampleDependencies = {
  measure?: () => HostLoad
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => Date
  env?: StateEnvironment
}

function parsedSample(value: unknown): HostLoadSeriesSample | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (
    typeof row.at !== 'string' ||
    !Number.isFinite(Date.parse(row.at)) ||
    typeof row.cpuBusy !== 'number' ||
    !Number.isFinite(row.cpuBusy) ||
    typeof row.swapUsed !== 'number' ||
    !Number.isFinite(row.swapUsed) ||
    typeof row.loadavg1 !== 'number' ||
    !Number.isFinite(row.loadavg1)
  )
    return null
  return row as HostLoadSeriesSample
}

function appendHostLoadSeriesSample(
  sample: HostLoadSeriesSample,
  env: StateEnvironment = process.env,
): void {
  writeBoundedJsonLine(sample, {
    env,
    maxBytes: HOST_LOAD_LOG_MAX_BYTES,
    name: HOST_LOAD_LOG_NAME,
  })
}

export function readHostLoadSeriesSince(
  since: string,
  env: StateEnvironment = process.env,
): HostLoadSeriesSample[] {
  return readBoundedJsonLinesSince(since, parsedSample, {
    env,
    label: 'host load',
    name: HOST_LOAD_LOG_NAME,
  })
}

/** Take two in-process readings so the second contains a current CPU delta. */
export async function recordHostLoadSeriesSample(
  dependencies: SampleDependencies = {},
): Promise<HostLoadSeriesSample> {
  const measure = dependencies.measure ?? (() => measureHostLoad(dependencies.env))
  measure()
  await (dependencies.sleep ?? Bun.sleep)(HOST_LOAD_SAMPLE_INTERVAL_MS)
  const load = measure()
  if (load.cpuBusy === null) {
    throw new Error('host load CPU sampling produced no delta; retry the sampler on a healthy host')
  }
  const sample = {
    at: (dependencies.now ?? (() => new Date()))().toISOString(),
    cpuBusy: load.cpuBusy,
    swapUsed: load.swapUsed,
    loadavg1: load.loadavg,
  }
  try {
    appendHostLoadSeriesSample(sample, dependencies.env)
  } catch (error) {
    const path = boundedJsonLinePath(HOST_LOAD_LOG_NAME, dependencies.env ?? process.env)
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(
      `host load sample could not be written: ${path}: ${cause}\n` +
        `cleared by: make the state directory writable: ${dirname(path)}`,
      { cause: error },
    )
  }
  return sample
}

/** Summarize already-loaded plain values without a store, clock, or file dependency. */
export function summarizeHostLoadWindow(
  samples: readonly HostLoadSeriesSample[],
  quantiles: readonly number[],
  waits: readonly ContentionWait[],
): HostLoadWindow | null {
  if (!samples.length) return null
  const first = samples[0]!
  const last = samples.at(-1)!
  const values = samples.map((sample) => sample.cpuBusy)
  return {
    sampleCount: samples.length,
    firstSampleAt: first.at,
    lastSampleAt: last.at,
    cpuBusyQuantiles: Object.fromEntries(
      quantiles.map((quantile) => [String(quantile), nearestRankPercentile(values, quantile)!]),
    ),
    latestSwapUsed: last.swapUsed,
    swapDelta: last.swapUsed - first.swapUsed,
    latestLoadavg1: last.loadavg1,
    hostCapacityWaitCount: waits.filter(
      (wait) => isHostCapacityWait(wait) && (wait.durationMs ?? 0) >= HOST_LOAD_WAIT_MIN_MS,
    ).length,
  }
}

export function loadHostLoadWindow(
  database: Database,
  since: string,
  until: string,
  quantiles: readonly number[],
  env: StateEnvironment = process.env,
): HostLoadWindow | null {
  return summarizeHostLoadWindow(
    readHostLoadSeriesSince(since, env),
    quantiles,
    loadContentionWaits(database, since, until),
  )
}
