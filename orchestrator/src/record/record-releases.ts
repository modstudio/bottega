// concern: record-releases
/** Owns tenant-bound hosted release reads. Must not know local release execution or HTTP. */
import { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import type { RecordCursor } from './record-cursor.ts'

export type RecordRelease = {
  id: string
  rung: string
  candidateCommit: string
  liveCommitBefore: string | null
  liveCommitAfter: string | null
  rollback: boolean
  rollbackReason: string | null
  actor: string
  sessionId: string | null
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  liveMatchesCandidate: boolean | null
  warning: string | null
}

export type LatestRecordRelease = {
  rung: string
  lastGood: RecordRelease | null
  latestAttempt: RecordRelease | null
}

type ReleaseListInput = TenantPrincipal & {
  url: string
  project: string
  limit: number
  before: RecordCursor | null
}

type ReleaseLatestInput = TenantPrincipal & {
  url: string
  project: string
}

const iso = (value: unknown) => (value == null ? null : new Date(String(value)).toISOString())

function releaseRow(row: Record<string, unknown>): RecordRelease {
  return {
    id: String(row.id),
    rung: String(row.rung),
    candidateCommit: String(row.candidate_commit),
    liveCommitBefore: row.live_commit_before == null ? null : String(row.live_commit_before),
    liveCommitAfter: row.live_commit_after == null ? null : String(row.live_commit_after),
    rollback: row.rollback === true,
    rollbackReason: row.rollback_reason == null ? null : String(row.rollback_reason),
    actor: String(row.actor),
    sessionId: row.session_id == null ? null : String(row.session_id),
    startedAt: iso(row.started_at)!,
    finishedAt: iso(row.finished_at),
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    liveMatchesCandidate:
      row.live_matches_candidate == null ? null : row.live_matches_candidate === true,
    warning: row.warning == null ? null : String(row.warning),
  }
}

function newest(first: RecordRelease, second: RecordRelease): RecordRelease {
  const byStartedAt = first.startedAt.localeCompare(second.startedAt)
  if (byStartedAt !== 0) return byStartedAt > 0 ? first : second
  return first.id.localeCompare(second.id) > 0 ? first : second
}

export function latestRecordReleases(rows: RecordRelease[]): LatestRecordRelease[] {
  const releases = new Map<string, { latest: RecordRelease; lastGood: RecordRelease | null }>()
  for (const row of rows) {
    const current = releases.get(row.rung)
    const latest = current ? newest(current.latest, row) : row
    const successful = row.finishedAt !== null && row.exitCode === 0
    const lastGood = successful
      ? current?.lastGood
        ? newest(current.lastGood, row)
        : row
      : (current?.lastGood ?? null)
    releases.set(row.rung, { latest, lastGood })
  }
  return [...releases.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rung, value]) => ({
      rung,
      lastGood: value.lastGood,
      latestAttempt: value.latest.id === value.lastGood?.id ? null : value.latest,
    }))
}

async function tenant<T>(
  input: { url: string } & TenantPrincipal,
  read: (tx: SQL) => Promise<T>,
): Promise<T> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, input)
      return read(tx)
    })
  } finally {
    await client.close()
  }
}

async function projectId(tx: SQL, project: string): Promise<string | null> {
  const rows = await tx`SELECT id FROM project WHERE name=${project} ORDER BY id LIMIT 1`
  return rows[0] ? String(rows[0].id) : null
}

export async function listRecordReleases(input: ReleaseListInput): Promise<RecordRelease[] | null> {
  return tenant(input, async (tx) => {
    const id = await projectId(tx, input.project)
    if (!id) return null
    const rows = await tx`
      SELECT id, rung, candidate_commit, live_commit_before, live_commit_after, rollback,
        rollback_reason, actor, session_id, started_at, finished_at, exit_code,
        live_matches_candidate, warning
      FROM release
      WHERE project_id=${id}::uuid
        AND (${input.before?.at ?? null}::timestamptz IS NULL OR (started_at, id) < (${input.before?.at ?? null}::timestamptz, ${input.before?.id ?? null}::uuid))
      ORDER BY started_at DESC, id DESC LIMIT ${input.limit + 1}
    `
    return rows.map((row: Record<string, unknown>) => releaseRow(row))
  })
}

export async function readLatestRecordReleases(
  input: ReleaseLatestInput,
): Promise<LatestRecordRelease[] | null> {
  return tenant(input, async (tx) => {
    const id = await projectId(tx, input.project)
    if (!id) return null
    const rows = await tx`
      WITH latest AS (
        SELECT DISTINCT ON (rung) * FROM release WHERE project_id=${id}::uuid
        ORDER BY rung, started_at DESC, id DESC
      ), successful AS (
        SELECT DISTINCT ON (rung) * FROM release
        WHERE project_id=${id}::uuid AND finished_at IS NOT NULL AND exit_code=0
        ORDER BY rung, started_at DESC, id DESC
      )
      SELECT * FROM latest UNION SELECT * FROM successful
    `
    return latestRecordReleases(rows.map((row: Record<string, unknown>) => releaseRow(row)))
  })
}
