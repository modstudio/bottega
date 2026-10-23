// concern: record-releases
/** Owns tenant-bound hosted release reads. Must not know local release execution or HTTP. */
import { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import type { RecordCursor } from './record-cursor.ts'
import {
  type LatestRecordRelease,
  latestRecordReleases,
  type RecordRelease,
} from './record-release-reading.ts'

type ReleaseListInput = TenantPrincipal & {
  url: string
  projectId: string
  limit: number
  before: RecordCursor | null
}

type ReleaseLatestInput = TenantPrincipal & {
  url: string
  projectId: string
}

const iso = (value: unknown) => (value == null ? null : new Date(String(value)).toISOString())

function releaseRow(row: Record<string, unknown>): RecordRelease {
  return {
    id: String(row.id),
    rung: String(row.rung),
    candidateCommit: String(row.candidate_commit),
    trunk: row.trunk == null ? null : String(row.trunk),
    trunkTip: row.trunk_tip == null ? null : String(row.trunk_tip),
    commitsBehindTrunk: row.commits_behind_trunk == null ? null : Number(row.commits_behind_trunk),
    behindTrunkReason: row.behind_trunk_reason == null ? null : String(row.behind_trunk_reason),
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

export async function listRecordReleases(input: ReleaseListInput): Promise<RecordRelease[] | null> {
  return tenant(input, async (tx) => {
    const project = await tx`SELECT id FROM project WHERE id=${input.projectId}::uuid`
    if (!project[0]) return null
    const rows = await tx`
      SELECT id, rung, candidate_commit, trunk, trunk_tip, commits_behind_trunk,
        behind_trunk_reason, live_commit_before, live_commit_after, rollback,
        rollback_reason, actor, session_id, started_at, finished_at, exit_code,
        live_matches_candidate, warning
      FROM release
      WHERE project_id=${input.projectId}::uuid
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
    const project = await tx`SELECT id FROM project WHERE id=${input.projectId}::uuid`
    if (!project[0]) return null
    const rows = await tx`
      WITH latest AS (
        SELECT DISTINCT ON (rung) * FROM release WHERE project_id=${input.projectId}::uuid
        ORDER BY rung, started_at DESC, id DESC
      ), successful AS (
        SELECT DISTINCT ON (rung) * FROM release
        WHERE project_id=${input.projectId}::uuid AND finished_at IS NOT NULL AND exit_code=0
        ORDER BY rung, started_at DESC, id DESC
      )
      SELECT * FROM latest UNION SELECT * FROM successful
    `
    return latestRecordReleases(rows.map((row: Record<string, unknown>) => releaseRow(row)))
  })
}
