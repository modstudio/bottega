// concern: duel
/**
 * Knows comparison validation, atomic duel persistence, partners, and matrices. Must not know worktrees, runs, routing, transports, or CLI adapters.
 */
import { db, writableDb, writeTransaction } from './db.ts'
import { changeIdentityJoin, pairReasonSql, sameChangeSql, sameTaskSql } from './evidence-query.ts'
import { judgeability } from './score.ts'

export type DuelJobMatrix = {
  job: string
  agents: string[]
  cells: Record<string, Record<string, { wins: number; losses: number }>>
}

export function parseRunIds(value: string, flagName: string): number[] {
  if (!value) throw new Error(`${flagName} needs at least one run id`)
  const ids = value.split(',').map((part) => {
    if (!/^\d+$/.test(part) || Number(part) < 1) {
      throw new Error(`${flagName} needs run ids separated by commas, got '${value}'`)
    }
    return Number(part)
  })
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${flagName} names the same run more than once`)
  }
  return ids
}

function validateComparisons(
  runId: number,
  otherRunIds: number[],
  callerSession: string | null,
  force = false,
): { job: string } {
  writableDb()
  const ids = [runId, ...otherRunIds]
  const rows = db()
    .query(`SELECT id, job, session_id FROM run WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as { id: number; job: string; session_id: string | null }[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const id of ids) {
    if (!byId.has(id)) throw new Error(`no run ${id}`)
  }
  const subject = byId.get(runId)!
  for (const otherId of otherRunIds) {
    if (otherId === runId) {
      throw new Error(`run ${runId} cannot be better than itself`)
    }
    const other = byId.get(otherId)!
    if (other.job !== subject.job) {
      throw new Error(
        `runs ${runId} and ${otherId} cannot be compared: ` +
          `jobs differ (${subject.job} and ${other.job})`,
      )
    }
  }
  if (!force) {
    for (const row of rows) {
      const owner = judgeability(row.session_id, callerSession)
      if (owner.verdict === 'foreign') {
        throw new Error(
          `run ${row.id} was made by another session - you did not read its output.\n` +
            `  its session:   ${owner.owner}\n` +
            `  your session:  ${callerSession}\n\n` +
            `Both runs in a duel must be scoreable by this session; --force overrides.`,
        )
      }
    }
  }
  return { job: subject.job }
}

/** Record one winner against every named loser after validating the comparison. */
export function recordDuels(
  winnerRunId: number,
  loserRunIds: number[],
  callerSession: string | null,
  at: string,
  force = false,
): void {
  const winner = validateComparisons(winnerRunId, loserRunIds, callerSession, force)
  const insert = db().query(
    `INSERT INTO duel (job, winner_run_id, loser_run_id, session_id, at)
     VALUES (?,?,?,?,?) ON CONFLICT(winner_run_id, loser_run_id) DO NOTHING`,
  )
  writeTransaction(() => {
    for (const loserId of loserRunIds) {
      insert.run(winner.job, winnerRunId, loserId, callerSession, at)
      recordComparedPair(winnerRunId, loserId, at)
    }
  })
}

/** Record every named winner over one loser after validating the whole set. */
export function recordLosses(
  loserRunId: number,
  winnerRunIds: number[],
  callerSession: string | null,
  at: string,
  force = false,
): void {
  const loser = validateComparisons(loserRunId, winnerRunIds, callerSession, force)
  const insert = db().query(
    `INSERT INTO duel (job, winner_run_id, loser_run_id, session_id, at)
     VALUES (?,?,?,?,?) ON CONFLICT(winner_run_id, loser_run_id) DO NOTHING`,
  )
  writeTransaction(() => {
    for (const winnerId of winnerRunIds) {
      insert.run(loser.job, winnerId, loserRunId, callerSession, at)
      recordComparedPair(winnerId, loserRunId, at)
    }
  })
}

function orderedPair(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a]
}

/** Mark scored roots as compared without adding directional duel evidence. */
export function recordTies(
  runId: number,
  otherRunIds: number[],
  callerSession: string | null,
  at: string,
  force = false,
): void {
  validateComparisons(runId, otherRunIds, callerSession, force)
  writeTransaction(() => {
    for (const otherId of otherRunIds) recordComparedPair(runId, otherId, at)
  })
}

function recordComparedPair(a: number, b: number, at: string): void {
  const [runA, runB] = orderedPair(a, b)
  db()
    .query(
      `INSERT INTO compared_pair (run_a_id, run_b_id, compared_at) VALUES (?,?,?)
     ON CONFLICT(run_a_id, run_b_id) DO NOTHING`,
    )
    .run(runA, runB, at)
}

export type PairPartner = { id: number; agent: string; reason: string }
export type UnrecordedPair = {
  runId: number
  partnerId: number
  partnerAgent: string
  reason: string
}

/** Scored sibling roots for the same task and change in this session, not yet compared. */
export function pairPartners(runId: number, sid: string | null): PairPartner[] {
  if (!sid) return []
  return db()
    .query(
      `SELECT partner.id, partner.agent,
            ${pairReasonSql('subject', 'partner', 'subject_review', 'partner_review')} AS reason
       FROM run subject
       ${changeIdentityJoin('subject', 'subject_lens', 'subject_review')}
       JOIN run partner ON partner.id <> subject.id
        AND partner.parent_run_id IS NULL
        AND partner.job = subject.job
        AND partner.session_id = ?
        AND COALESCE(partner.probe, 0) = 0
        AND partner.evidence_excluded IS NULL
       ${changeIdentityJoin('partner', 'partner_lens', 'partner_review')}
       JOIN score partner_score ON partner_score.run_id = partner.id
       LEFT JOIN compared_pair compared
         ON compared.run_a_id = MIN(subject.id, partner.id)
        AND compared.run_b_id = MAX(subject.id, partner.id)
      WHERE subject.id = ?
        AND COALESCE(subject.probe, 0) = 0
        AND subject.evidence_excluded IS NULL
        AND ${sameTaskSql('subject', 'partner')}
        AND ${sameChangeSql('subject_review', 'partner_review')}
        AND datetime(partner_score.scored_at) >= datetime('now', '-24 hours')
        AND compared.run_a_id IS NULL
      ORDER BY partner.id`,
    )
    .all(sid, runId) as PairPartner[]
}

/** Each recent, scored, comparable pair once, oriented toward the newer run. */
export function unrecordedPairsForSession(sid: string | null): UnrecordedPair[] {
  if (!sid) return []
  return db()
    .query(
      `SELECT newer.id AS runId, older.id AS partnerId, older.agent AS partnerAgent,
            ${pairReasonSql('newer', 'older', 'newer_review', 'older_review')} AS reason
       FROM run newer
       ${changeIdentityJoin('newer', 'newer_lens', 'newer_review')}
       JOIN score newer_score ON newer_score.run_id = newer.id
       JOIN run older ON older.id < newer.id
        AND older.parent_run_id IS NULL
        AND older.job = newer.job
        AND older.session_id = newer.session_id
        AND COALESCE(older.probe, 0) = 0
        AND older.evidence_excluded IS NULL
       ${changeIdentityJoin('older', 'older_lens', 'older_review')}
       JOIN score older_score ON older_score.run_id = older.id
       LEFT JOIN compared_pair compared
         ON compared.run_a_id = older.id AND compared.run_b_id = newer.id
      WHERE newer.parent_run_id IS NULL AND newer.session_id = ?
        AND COALESCE(newer.probe, 0) = 0
        AND newer.evidence_excluded IS NULL
        AND ${sameTaskSql('newer', 'older')}
        AND ${sameChangeSql('newer_review', 'older_review')}
        AND datetime(newer_score.scored_at) >= datetime('now', '-24 hours')
        AND datetime(older_score.scored_at) >= datetime('now', '-24 hours')
        AND compared.run_a_id IS NULL
      ORDER BY newer.id, older.id`,
    )
    .all(sid) as UnrecordedPair[]
}

/** The directed duel evidence, grouped into one agent-by-agent matrix per job. */
export function duelMatrices(jobName?: string): DuelJobMatrix[] {
  const rows = db()
    .query(
      `SELECT d.job, winner.agent AS winner, loser.agent AS loser, COUNT(*) AS n
       FROM duel d
       JOIN run winner ON winner.id = d.winner_run_id
       JOIN run loser ON loser.id = d.loser_run_id
      WHERE (? IS NULL OR d.job = ?)
      GROUP BY d.job, winner.agent, loser.agent
      ORDER BY d.job, winner.agent, loser.agent`,
    )
    .all(jobName ?? null, jobName ?? null) as {
    job: string
    winner: string
    loser: string
    n: number
  }[]
  const jobs = new Map<string, DuelJobMatrix>()
  for (const row of rows) {
    let matrix = jobs.get(row.job)
    if (!matrix) {
      matrix = { job: row.job, agents: [], cells: {} }
      jobs.set(row.job, matrix)
    }
    for (const agent of [row.winner, row.loser]) {
      if (!matrix.agents.includes(agent)) matrix.agents.push(agent)
    }
  }
  for (const matrix of jobs.values()) {
    matrix.agents.sort()
    for (const a of matrix.agents) {
      matrix.cells[a] = {}
      for (const b of matrix.agents) matrix.cells[a]![b] = { wins: 0, losses: 0 }
    }
  }
  for (const row of rows) {
    const matrix = jobs.get(row.job)!
    matrix.cells[row.winner]![row.loser]!.wins += row.n
    matrix.cells[row.loser]![row.winner]!.losses += row.n
  }
  return [...jobs.values()]
}
