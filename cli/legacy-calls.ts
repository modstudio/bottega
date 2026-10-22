import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { resolveStateRoot, type StateEnvironment } from '../shared/state-directory.ts'

type LegacyCall = {
  time: string
  oldName: 'orch' | 'hub'
  tokens: string[]
  cwd: string
  harnessSessionId: string | null
  source: 'internal' | 'external'
}

function legacyPath(env: StateEnvironment): string {
  return join(resolveStateRoot(env), 'legacy-calls.jsonl')
}

export type LegacyCallCount = {
  command: string
  source: 'internal' | 'external'
  count: number
  firstSeen: string
  lastSeen: string
}

export function legacyCallCounts(
  since: string | undefined,
  env: StateEnvironment = process.env,
): LegacyCallCount[] {
  const lowerBound = since === undefined ? null : Date.parse(since)
  if (since !== undefined && Number.isNaN(lowerBound))
    throw new Error(`invalid --since timestamp: ${since}`)
  let contents = ''
  try {
    contents = readFileSync(legacyPath(env), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const counts = new Map<string, LegacyCallCount>()
  for (const line of contents.split('\n')) {
    if (!line) continue
    try {
      const row = JSON.parse(line) as LegacyCall
      const instant = Date.parse(row.time)
      if (!Number.isFinite(instant) || (lowerBound !== null && instant < lowerBound)) continue
      const command = [row.oldName, ...row.tokens].join(' ')
      const key = `${command}\0${row.source}`
      const current = counts.get(key)
      if (current) {
        current.count += 1
        if (row.time < current.firstSeen) current.firstSeen = row.time
        if (row.time > current.lastSeen) current.lastSeen = row.time
      } else {
        counts.set(key, {
          command,
          source: row.source,
          count: 1,
          firstSeen: row.time,
          lastSeen: row.time,
        })
      }
    } catch {
      // A partial or old telemetry line does not make the report unavailable.
    }
  }
  return [...counts.values()].sort(
    (left, right) =>
      left.command.localeCompare(right.command) || left.source.localeCompare(right.source),
  )
}

export function reportLegacyCalls(argv: readonly string[]): number {
  let since: string | undefined
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--json') json = true
    else if (value === '--since' && argv[index + 1]) since = argv[++index]
    else {
      console.error(
        `working form: ${PLATFORM_SLUG} machine legacy-calls [--since <ISO timestamp>] [--json]`,
      )
      return 2
    }
  }
  try {
    const rows = legacyCallCounts(since)
    if (json) console.log(JSON.stringify(rows, null, 2))
    else if (rows.length === 0) console.log('legacy calls: none')
    else
      for (const row of rows)
        console.log(
          `${row.command}\t${row.source}\t${row.count}\t${row.firstSeen}\t${row.lastSeen}`,
        )
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
}
