/**
 * The measured half of the test-spawn rule: the fixed per-file Bun-spawn
 * ceiling, the comparison of one gate run's measurement against the
 * shrink-only baseline, and the regenerate step that only lets it shrink. It
 * knows measurement rows, a recorded baseline and a limit, not how the gate
 * runs tests or where its artifact lives.
 */
export const SPAWN_LIMIT = 20

export type SpawnMeasurement = { file: string; spawns: number }

/** Recorded per-file spawn counts; a file stays here only while it measures
 *  above the fixed limit. */
export type SpawnBaseline = { files: Record<string, number> }

export type SpawnViolation = { file: string; spawns: number; baseline: number | null }

export type SpawnRuleResult =
  | { status: 'missing' }
  | { status: 'pass'; measuredFiles: number }
  | { status: 'fail'; violations: SpawnViolation[] }

/**
 * A file above the limit and unbudgeted is a new offender; a budgeted file
 * above its recorded count grew. A budgeted file that improved never fails,
 * and a budgeted file absent from the measurement only shrank.
 */
export function spawnViolations({
  measurements,
  baseline,
  limit = SPAWN_LIMIT,
}: {
  measurements: SpawnMeasurement[]
  baseline: SpawnBaseline
  limit?: number
}): SpawnViolation[] {
  const violations: SpawnViolation[] = []
  for (const row of measurements) {
    const recorded = baseline.files[row.file]
    if (recorded === undefined) {
      if (row.spawns > limit) {
        violations.push({ file: row.file, spawns: row.spawns, baseline: null })
      }
      continue
    }
    if (row.spawns > recorded) {
      violations.push({ file: row.file, spawns: row.spawns, baseline: recorded })
    }
  }
  return violations.sort(
    (left, right) => right.spawns - left.spawns || left.file.localeCompare(right.file),
  )
}

/** The whole measured rule: a missing measurement is a failure of its own. */
export function decideSpawnRule({
  measurements,
  baseline,
  limit = SPAWN_LIMIT,
}: {
  measurements: SpawnMeasurement[] | null
  baseline: SpawnBaseline
  limit?: number
}): SpawnRuleResult {
  if (measurements === null) return { status: 'missing' }
  const violations = spawnViolations({ measurements, baseline, limit })
  if (violations.length > 0) return { status: 'fail', violations }
  return { status: 'pass', measuredFiles: measurements.length }
}

/**
 * The regenerate step: a measured file still above the limit is recorded at the
 * count just measured, and a measured file at or below the limit leaves the
 * baseline, so a measured entry can only shrink. A baselined file the
 * measurement does not mention keeps its recorded count: a partial measurement
 * (a shard, a filtered run) must never erase what it did not measure. Any file
 * that grew is refused.
 */
export function loweredSpawnBaseline({
  measurements,
  baseline,
  limit = SPAWN_LIMIT,
}: {
  measurements: SpawnMeasurement[]
  baseline: SpawnBaseline
  limit?: number
}): SpawnBaseline {
  const growth = spawnViolations({ measurements, baseline, limit })
  if (growth.length > 0) {
    throw new Error(growth.map((violation) => describeSpawnViolation(violation, limit)).join('\n'))
  }
  const files: Record<string, number> = { ...baseline.files }
  for (const row of measurements) {
    if (row.spawns > limit) files[row.file] = row.spawns
    else delete files[row.file]
  }
  const sorted: Record<string, number> = {}
  for (const file of Object.keys(files).sort((left, right) => left.localeCompare(right))) {
    sorted[file] = files[file]!
  }
  return { files: sorted }
}

/**
 * The shard a gate timing artifact's recorded command ran, as `N/M`, or null
 * when that run was not sharded. A shard measures only part of the suite, so
 * its measurement may not regenerate a whole-suite baseline.
 */
export function shardOfCommand(command: readonly string[] | null | undefined): string | null {
  for (const argument of command ?? []) {
    const match = /^--shard=(\d+\/\d+)$/.exec(argument)
    if (match?.[1]) return match[1]
  }
  return null
}

export function describeSpawnViolation(violation: SpawnViolation, limit = SPAWN_LIMIT): string {
  if (violation.baseline === null) {
    return `${violation.file}: measured ${violation.spawns} spawns, fixed limit ${limit}`
  }
  return `${violation.file}: measured ${violation.spawns} spawns, recorded baseline ${violation.baseline}`
}

export function parseSpawnBaseline(text: string): SpawnBaseline {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected a JSON object')
  }
  const files = (parsed as { files?: unknown }).files
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    throw new Error('expected a files table')
  }
  const counts: Record<string, number> = {}
  for (const [file, count] of Object.entries(files)) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      throw new Error(`file ${file} has a non-integer count`)
    }
    counts[file] = count
  }
  return { files: counts }
}
