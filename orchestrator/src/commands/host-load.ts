// concern: host-load command edge
/** Registers host-load CLI flags and delegates validated values to the service. */

import type { Command } from 'commander'
import { parseBoardDuration } from '../../../shared/board-duration.ts'
import { boundedJsonLinePath } from '../../../shared/bounded-json-lines-log.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { StateEnvironment } from '../../../shared/state-directory.ts'
import { db } from '../database/db.ts'
import {
  HOST_LOAD_LOG_NAME,
  HOST_LOAD_WAIT_MIN_MS,
  loadHostLoadWindow,
  recordHostLoadSeriesSample,
} from '../host-load-series.ts'
import { writeStdout } from './support.ts'

const HOST_LOAD_DEFAULT_WINDOW_MS = 30 * 60 * 1_000
const HOST_LOAD_DEFAULT_QUANTILES = [0.5, 0.7, 0.75, 0.95] as const

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
  database: ReturnType<typeof db>,
  options: { since?: string; quantiles?: string; json: boolean },
  presentation: {
    now?: () => number
    env?: StateEnvironment
    write: (value: string) => Promise<void>
  },
): Promise<void> {
  const now = (presentation.now ?? Date.now)()
  const since = parseSince(options.since, now)
  const report = loadHostLoadWindow(
    database,
    since,
    new Date(now).toISOString(),
    parseQuantiles(options.quantiles),
    presentation.env,
  )
  if (!report) {
    const path = boundedJsonLinePath(HOST_LOAD_LOG_NAME, presentation.env ?? process.env)
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

export function registerHostLoadCommands(program: Command): void {
  const load = program.command('load').description('sample or report machine host load')
  load
    .option('--since <value>', 'report samples since an ISO time or duration (default: 30m)')
    .option('--quantiles <list>', 'comma-separated CPU busy quantiles')
    .option('--json', 'write the host-load report as JSON')
    .allowExcessArguments(false)
    .action((options) =>
      hostLoadCommand(
        db(),
        {
          since: options.since,
          quantiles: options.quantiles,
          json: Boolean(options.json),
        },
        { write: writeStdout },
      ),
    )
  load
    .command('sample')
    .description('append one machine host-load sample')
    .allowExcessArguments(false)
    .action(async () => {
      await recordHostLoadSeriesSample()
    })
}
