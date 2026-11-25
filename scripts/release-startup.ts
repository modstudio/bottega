import { median } from '../orchestrator/src/state/statistics.ts'
import { startBounded } from '../shared/bounded-process.ts'
import { refusal, renderRefusal } from '../shared/refusal.ts'
import type { BinaryTarget } from '../shared/release-artifacts.ts'

// This catches parse-on-launch regressions with headroom for shared-runner noise.
export const RELEASE_STARTUP_CEILING_MS = 200

const RELEASE_STARTUP_SAMPLE_COUNT = 5

export type ReleaseStartupDecision = {
  ok: boolean
  medianMs: number
  message: string
}

export type ReleaseStartupMeasurement = ReleaseStartupDecision & {
  samplesMs: number[]
}

export function releaseStartupHostDecision(
  hostPlatform: string,
  hostArch: string,
  target: BinaryTarget,
): 'run' | 'skip' {
  return `${hostPlatform}-${hostArch}` === target ? 'run' : 'skip'
}

export function releaseStartupDecision(samplesMs: readonly number[]): ReleaseStartupDecision {
  if (samplesMs.length === 0) throw new Error('release startup decision requires samples')
  const medianMs = median([...samplesMs])!
  const ok = medianMs <= RELEASE_STARTUP_CEILING_MS
  const measurement = `${medianMs.toFixed(1)} ms median (ceiling ${RELEASE_STARTUP_CEILING_MS} ms)`
  return {
    ok,
    medianMs,
    message: ok
      ? `release startup passed: ${measurement}`
      : `release startup refused: ${measurement}; build with binaryCompileArgv, which carries --bytecode`,
  }
}

async function timedVersionRun(
  binary: string,
  env: Record<string, string | undefined>,
): Promise<number> {
  const startedAt = performance.now()
  const result = await startBounded([binary, '--version'], { budget: 'self-cli', env })
  const elapsedMs = performance.now() - startedAt
  if (result.exitCode !== 0) {
    throw new Error(
      renderRefusal(
        refusal(
          `${binary} --version exited ${result.exitCode}: ${[result.stdout, result.stderr]
            .filter(Boolean)
            .join('\n')
            .trim()}`,
          {
            kind: 'edit',
            text: `Repair ${binary} so --version exits zero, then rerun the release proof`,
          },
        ),
      ),
    )
  }
  return elapsedMs
}

export async function measureReleaseStartup(
  binary: string,
  env: Record<string, string | undefined>,
): Promise<ReleaseStartupMeasurement> {
  await timedVersionRun(binary, env)
  const samplesMs: number[] = []
  for (let index = 0; index < RELEASE_STARTUP_SAMPLE_COUNT; index += 1) {
    samplesMs.push(await timedVersionRun(binary, env))
  }
  const decision = releaseStartupDecision(samplesMs)
  return {
    ...decision,
    samplesMs,
    message: `${decision.message}; samples ${samplesMs
      .map((sample) => sample.toFixed(1))
      .join(', ')} ms`,
  }
}
