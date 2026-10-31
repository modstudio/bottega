// concern: per-minute host-load series
/** Samples machine load to a bounded log and summarizes windows for operators. */

import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { parseBoardDuration } from '../../shared/board-duration.ts'
import {
  appendBoundedJsonLine,
  readBoundedJsonLinesSince,
} from '../../shared/bounded-json-lines-log.ts'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { resolveStateRoot, type StateEnvironment } from '../../shared/state-directory.ts'
import { type ContentionWait, loadContentionWaits } from './database/contention.ts'
import { type HostLoad, measureHostLoad } from './gate-load.ts'
import { nearestRankPercentile } from './state/statistics.ts'

export const HOST_LOAD_WAIT_MIN_MS = 1_000
export const HOST_LOAD_LOG_MAX_BYTES = 4 * 1024 * 1024
export const HOST_LOAD_SAMPLE_INTERVAL_MS = 1_000
const HOST_LOAD_DEFAULT_WINDOW_MS = 30 * 60 * 1_000
const HOST_LOAD_DEFAULT_QUANTILES = [0.5, 0.7, 0.75, 0.95] as const
const HOST_LOAD_LOG_NAME = 'orchestrator/host-load'

export type HostLoadSample = {
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

function parsedSample(value: unknown): HostLoadSample | null {
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
  return row as HostLoadSample
}

export function appendHostLoadSample(
  sample: HostLoadSample,
  env: StateEnvironment = process.env,
): void {
  appendBoundedJsonLine(sample, {
    env,
    maxBytes: HOST_LOAD_LOG_MAX_BYTES,
    name: HOST_LOAD_LOG_NAME,
  })
}

export function readHostLoadSamplesSince(
  since: string,
  env: StateEnvironment = process.env,
): HostLoadSample[] {
  return readBoundedJsonLinesSince(since, parsedSample, {
    env,
    label: 'host load',
    name: HOST_LOAD_LOG_NAME,
  })
}

/** Take two in-process readings so the second contains a current CPU delta. */
export async function sampleHostLoad(
  dependencies: SampleDependencies = {},
): Promise<HostLoadSample> {
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
  appendHostLoadSample(sample, dependencies.env)
  return sample
}

function hostCapacityWait(wait: ContentionWait): boolean {
  return (
    wait.resourceKind === 'cpu' &&
    wait.resourceKey === 'host-capacity' &&
    (wait.durationMs ?? 0) >= HOST_LOAD_WAIT_MIN_MS
  )
}

/** Summarize already-loaded plain values without a store, clock, or file dependency. */
export function summarizeHostLoadWindow(
  samples: readonly HostLoadSample[],
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
    hostCapacityWaitCount: waits.filter(hostCapacityWait).length,
  }
}

function parseSince(value: string | undefined, now: number): string {
  if (!value) return new Date(now - HOST_LOAD_DEFAULT_WINDOW_MS).toISOString()
  const instant = Date.parse(value)
  if (Number.isFinite(instant)) return new Date(instant).toISOString()
  return new Date(now - parseBoardDuration(value)).toISOString()
}

function parseQuantiles(value: string | undefined): number[] {
  const inputs = value?.split(',') ?? [...HOST_LOAD_DEFAULT_QUANTILES].map(String)
  const quantiles = inputs.map((input) => Number(input.trim()))
  if (!quantiles.length || quantiles.some((quantile) => !(quantile > 0 && quantile <= 1))) {
    throw new Error(
      '--quantiles must be a comma-separated list of numbers greater than zero and at most one',
    )
  }
  return quantiles
}

export async function hostLoadCommand(
  database: Database,
  options: { since?: string; quantiles?: string; json: boolean },
  presentation: {
    now?: () => number
    env?: StateEnvironment
    write: (value: string) => Promise<void>
  },
): Promise<void> {
  const now = (presentation.now ?? Date.now)()
  const since = parseSince(options.since, now)
  const quantiles = parseQuantiles(options.quantiles)
  const samples = readHostLoadSamplesSince(since, presentation.env)
  const waits = loadContentionWaits(database, since, new Date(now).toISOString())
  const report = summarizeHostLoadWindow(samples, quantiles, waits)
  if (!report) {
    const path = join(
      resolveStateRoot(presentation.env ?? process.env),
      `${HOST_LOAD_LOG_NAME}.jsonl`,
    )
    throw new Error(
      `host load window has no samples in ${path}\ncleared by: run ${PLATFORM_SLUG} machine load sample and keep its launchd sampler job running`,
    )
  }
  if (options.json) {
    await presentation.write(`${JSON.stringify({ since, ...report }, null, 2)}\n`)
    return
  }
  const quantileText = Object.entries(report.cpuBusyQuantiles)
    .map(([quantile, value]) => `cpuBusy q${quantile}=${value.toFixed(3)}`)
    .join(' ')
  await presentation.write(
    `host load: ${report.sampleCount} samples ${report.firstSampleAt} to ${report.lastSampleAt}\n` +
      `${quantileText}\n` +
      `swap latest=${report.latestSwapUsed} delta=${report.swapDelta} loadavg1=${report.latestLoadavg1.toFixed(3)} waits>=${HOST_LOAD_WAIT_MIN_MS}ms=${report.hostCapacityWaitCount}\n`,
  )
}
