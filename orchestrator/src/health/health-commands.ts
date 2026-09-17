// concern: health-commands
/** Knows harness health, contention and blocker reporting. Must not know runs, routing, transports, the CLI, or worktrees. */
import { AttributionKindSchema } from '../../../shared/orch-contract.ts'
import { db } from '../database/db.ts'
import { harnessHealth, landingsWithPostStepError } from './health.ts'

type CommandFlags = { has(name: string): boolean; flag(name: string): string | undefined }
type CommandPresentation = { log(...values: unknown[]): void }

export function blockersPayload(days = 14) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const rows = db()
    .query(
      `SELECT COALESCE(b.kind, b.what) AS kind, b.source,
            COUNT(*) AS n, COUNT(DISTINCT r.repo) AS repos,
            MAX(b.at) AS last_at,
            MIN(b.why) AS example,
            GROUP_CONCAT(DISTINCT r.agent) AS agents
       FROM blocker b JOIN run r ON r.id = b.run_id
      WHERE b.at >= ?
      GROUP BY 1, 2
      ORDER BY n DESC`,
    )
    .all(since) as {
    kind: string
    source: string
    n: number
    repos: number
    last_at: string
    example: string | null
    agents: string | null
  }[]
  return {
    days,
    blockers: rows.map((r) => ({
      kind: r.kind,
      source: r.source,
      runs: r.n,
      projects: r.repos,
      agents: r.agents ? r.agents.split(',') : [],
      lastAt: r.last_at,
      example: r.example,
    })),
  }
}

export const healthPayload = (days?: number) => harnessHealth(days)

/**
 * What is stopping agents doing their work, counted.
 *
 * The counterpart to `orch inbox`: that raises decisions only the architect
 * can make, this raises conditions only the ENVIRONMENT can fix. Both were
 * arriving already and neither was visible — a blocker turns up alongside a
 * run that otherwise succeeded, so nothing about the run looked wrong.
 *
 * Ordered by RECURRENCE rather than recency, because that is the number that
 * decides anything: one denied Docker socket is an anecdote and forty is a
 * machine to fix, and the whole reason these went unaddressed is that each
 * worker met the problem once, worked around it, and moved on.
 */
export function blockersCommand(flags: CommandFlags, presentation: CommandPresentation): void {
  const { has, flag } = flags
  const { log } = presentation
  const days = Number(flag('days') ?? 14)
  const payload = blockersPayload(days)

  /**
   * PUBLISHED, because hub cannot import this concern or open orch.db.
   *
   * The same contract `orch state` and `orch project list --json` already
   * serve: what another concern needs is emitted here rather than reached
   * for. Field names are the query's, so a reader of this command and a
   * reader of the table see the same words.
   */
  if (has('json')) {
    log(JSON.stringify(payload))
    return
  }

  if (!payload.blockers.length) {
    log(`nothing reported in ${days} days`)
    return
  }
  log(`what stopped agents working, last ${days} days:\n`)
  for (const r of payload.blockers) {
    log(
      `${String(r.runs).padStart(4)}x  ${r.kind}` +
        `  (${r.source}, ${r.projects} project${r.projects === 1 ? '' : 's'}, ${r.agents.join(',') || '—'})`,
    )
    if (r.example) log(`        ${r.example.slice(0, 150)}`)
  }
  log(
    `\nThese are environment problems, not agent failures — an agent that hit one` +
      `\ncarried on and said so. Each is capping what every run in that project can` +
      `\nverify, which is why they are ranked by how often they recur.`,
  )
}

export function healthCommand(flags: CommandFlags, presentation: CommandPresentation): void {
  const { has, flag } = flags
  const { log } = presentation
  const report = healthPayload(flag('days') ? Number(flag('days')) : undefined)
  if (has('json')) {
    log(JSON.stringify(report))
    return
  }
  const duration = (ms: number) =>
    ms < 60_000
      ? `${(ms / 1000).toFixed(1)}s`
      : ms < 3_600_000
        ? `${(ms / 60_000).toFixed(1)}m`
        : `${(ms / 3_600_000).toFixed(1)}h`
  log(report.header)
  log(`window: ${report.days} days from ${report.from}`)
  log(
    '\nFAILURE CLASS'.padEnd(25) +
      'COUNT'.padStart(7) +
      'TOTAL'.padStart(10) +
      'MEAN'.padStart(10) +
      'PRESERVED'.padStart(11) +
      '  FIRST SEEN'.padEnd(27) +
      'LAST SEEN',
  )
  for (const row of report.classes) {
    log(
      row.kind.padEnd(25) +
        String(row.count).padStart(7) +
        duration(row.totalTimeMs).padStart(10) +
        duration(row.meanTimeMs).padStart(10) +
        String(row.workPreserved).padStart(11) +
        '  ' +
        (row.firstSeen ?? '-').padEnd(25) +
        (row.lastSeen ?? '-') +
        (row.kind === 'idle' && row.reclaimedMs ? `  reclaimed ${duration(row.reclaimedMs)}` : ''),
    )
    for (const cluster of row.clusters) {
      log(`  ${cluster.count}x [run ${cluster.exampleRunId}] ${cluster.text}`)
    }
    if (row.kind === 'escaped' && row.attribution) {
      log(
        '  attribution  ' +
          AttributionKindSchema.options
            .map((kind) => `${kind}=${row.attribution![kind]}`)
            .join(' '),
      )
    }
  }
  log('\nFALSE HARNESS VERDICTS')
  log('KIND'.padEnd(25) + 'FALSE'.padStart(7) + 'TOTAL'.padStart(7) + 'RATE'.padStart(9))
  for (const row of report.falseVerdicts.filter((row) => row.verdicts || row.falseVerdicts)) {
    log(
      row.kind.padEnd(25) +
        String(row.falseVerdicts).padStart(7) +
        String(row.verdicts).padStart(7) +
        `${(row.rate * 100).toFixed(1)}%`.padStart(9),
    )
  }
  log(
    `landing refused`.padEnd(25) + String(report.landingRefusals).padStart(7) + '      -        -',
  )
  log(
    `mcp probe failures`.padEnd(25) +
      String(report.mcpProbeFailures).padStart(7) +
      '      -        -',
  )
  log(`mcp unprobed`.padEnd(25) + String(report.mcpUnprobed).padStart(7) + '      -        -')
  for (const row of report.mcpUnverifiedByAgent ?? []) {
    log(
      `mcp unverified ${row.agent}`.padEnd(25) + String(row.count).padStart(7) + '      -        -',
    )
  }
  for (const row of landingsWithPostStepError()) {
    log(`landed with post-step error`.padEnd(25) + `${row.project} ${row.branch}`)
    log(`  ${row.error}`)
  }
  log('\nCONTENTION (never routing evidence)')
  log(
    'KIND'.padEnd(25) +
      'COUNT'.padStart(7) +
      'TOTAL'.padStart(10) +
      'MEAN'.padStart(10) +
      '  TOP KEYS',
  )
  for (const row of report.contention.resources) {
    const keys = row.topKeys.length
      ? row.topKeys.map((key) => `${key.key} (${key.count})`).join(', ')
      : '-'
    log(
      row.kind.padEnd(25) +
        String(row.count).padStart(7) +
        duration(row.totalDurationMs).padStart(10) +
        duration(row.meanDurationMs).padStart(10) +
        '  ' +
        keys,
    )
  }
  log('SESSION'.padEnd(25) + 'WAITS'.padStart(7) + 'INVALIDATIONS CAUSED'.padStart(22))
  for (const row of report.contention.sessions) {
    log(
      row.sessionId.padEnd(25) +
        String(row.waitsSuffered).padStart(7) +
        String(row.invalidationsCaused).padStart(22),
    )
  }
  if (!report.contention.sessions.length) log('(none)')
  log('\nFLAKES')
  log('TEST'.padEnd(36) + 'FILE'.padEnd(36) + 'COUNT'.padStart(7) + '  LOAD')
  if (!report.flakes?.length) log('(none)')
  for (const row of report.flakes ?? []) {
    const load = row.loadAtFailure
    log(
      row.test.slice(0, 35).padEnd(36) +
        row.file.slice(0, 35).padEnd(36) +
        String(row.count).padStart(7) +
        `  gates=${load.gates} loadavg=${load.loadavg} ncpu=${load.ncpu} mem=${load.freeMem}` +
        ` signal=${row.signal ?? '-'}`,
    )
  }
}
