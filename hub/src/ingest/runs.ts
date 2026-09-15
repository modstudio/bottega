import { db, nowIso } from '../db.ts'
import { attributeRun } from '../attribute.ts'
import { readRuns } from '../orch.ts'
import type { OrchRun } from '../../../shared/orch-contract.ts'

export type { OrchQuestion, OrchRun, OrchTurn } from '../../../shared/orch-contract.ts'

/**
 * Delegated agent runs, as intervals.
 *
 * Read through `orch runs --json` rather than by opening orch.db. The
 * orchestrator owns that file; a second concern reading it directly is how the
 * "a database per concern" line stops being true, and the CLI is a published
 * interface that can keep working when the schema behind it moves.
 */
function rootRef(id: number) {
  return `orch:${id}`
}

function runRef(rootId: number, questionRunId: number, hasTurns: boolean) {
  return hasTurns ? `orch:${rootId}:turn:${questionRunId}` : `orch:${rootId}`
}

export function executionSpans(r: OrchRun, now = Date.now()) {
  return (r.turns ?? [r]).flatMap((turn) => {
    const start = new Date(turn.started_at).getTime()
    if (!Number.isFinite(start)) return []
    if (turn.latency_ms == null && turn.status !== 'running') return []
    const end = turn.latency_ms == null ? Math.max(now, start) : start + turn.latency_ms
    return [{ start, end }]
  })
}

export function chainVendorTokens(r: OrchRun): number | null {
  const turns = r.turns ?? [r]
  let total: number | null = null
  for (const turn of turns) {
    if (turn.vendor_tokens != null) total = (total ?? 0) + turn.vendor_tokens
  }
  return total
}

export async function ingestRuns(since: string): Promise<{ rows: number; skipped: number }> {
  // Snapshot time, not completion: anything that happens during the read is
  // re-fetched next time. Overlap is cheap; a missed answer is not.
  const snapshot = nowIso()
  const runs = await readRuns(since)
  const d = db()
  const stmt = d.query(
    `INSERT INTO interval (task_key, project, source, agent, job, start_at, end_at,
                           claude_tokens, vendor_tokens, vendor_cost_usd, ref, via, open, session_id)
     VALUES (?,?,'orch',?,?,?,?,0,?,?,?,?,?,?)
     ON CONFLICT(source, ref, start_at) DO UPDATE SET
       end_at          = excluded.end_at,
       vendor_tokens   = excluded.vendor_tokens,
       vendor_cost_usd = excluded.vendor_cost_usd,
       task_key        = excluded.task_key,
       project         = excluded.project,
       job             = excluded.job,
       via             = excluded.via,
       open            = excluded.open,
       session_id      = excluded.session_id`,
  )
  const upsertQuestion = d.query(
    `INSERT INTO question (question_id, run_ref, root_ref, task_key, session_id, asked_at, answered_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(question_id) DO UPDATE SET
       run_ref     = excluded.run_ref,
       root_ref    = excluded.root_ref,
       task_key    = excluded.task_key,
       session_id  = excluded.session_id,
       asked_at    = excluded.asked_at,
       answered_at = excluded.answered_at`,
  )
  const deleteRootQuestions = d.query(`DELETE FROM question WHERE root_ref = ?`)
  const close = d.query(`UPDATE interval SET open = 0 WHERE source = 'orch' AND ref = ?`)
  const removeOtherStarts = d.query(
    `DELETE FROM interval WHERE source = 'orch' AND ref = ? AND start_at <> ?`,
  )
  const clearChain = d.query(
    `DELETE FROM interval WHERE source = 'orch' AND (ref = ? OR ref LIKE ?)`,
  )
  const closeReplaced = d.query(
    `UPDATE interval SET open = 0
      WHERE source = 'orch' AND open = 1
        AND (ref = ? OR ref LIKE ?)`,
  )

  let rows = 0
  let skipped = 0
  const now = Date.now()
  const write = d.transaction((batch: OrchRun[]) => {
    for (const r of batch) {
      const a = attributeRun(r)

      const root = rootRef(r.id)
      const hasTurns = Boolean(r.turns)
      deleteRootQuestions.run(root)
      for (const q of r.questions) {
        upsertQuestion.run(
          q.id,
          runRef(r.id, q.run_id, hasTurns),
          root,
          a.key,
          r.session_id,
          q.asked_at,
          q.answered_at,
        )
      }

      // A probe is a smoke test — "reply with ok" — that did no work on
      // anything, so it is not engaged time on any task. A question on it is
      // still a request for a ruling.
      if (r.probe === 1) {
        skipped++
        continue
      }

      // Failover is a new root, not another turn of the run it replaces. The
      // predecessor can therefore fall outside this collect's time window even
      // while its successor is present. Close the predecessor from the handoff
      // itself; waiting to see that old row again leaves its last open sample
      // growing forever. retry_of may name either a root or a resumed child.
      if (r.retry_of != null) {
        closeReplaced.run(`orch:${r.retry_of}`, `orch:%:turn:${r.retry_of}`)
      }

      const turns = r.turns ?? [r]
      if (r.turns) clearChain.run(`orch:${r.id}`, `orch:${r.id}:turn:%`)
      for (const turn of turns) {
        const ref = r.turns ? `orch:${r.id}:turn:${turn.id}` : `orch:${r.id}`
        const start = new Date(turn.started_at).getTime()
        if (!Number.isFinite(start)) {
          skipped++
          continue
        }

        // A live turn grows to NOW until its measured latency arrives. A turn
        // that stopped without a latency contributes no execution interval.
        if (turn.latency_ms == null && turn.status !== 'running') {
          if (!r.turns) close.run(ref)
          skipped++
          continue
        }
        const end = turn.latency_ms == null ? Math.max(now, start) : start + turn.latency_ms
        stmt.run(
          a.key,
          a.project,
          r.agent,
          r.job,
          new Date(start).toISOString(),
          new Date(end).toISOString(),
          turn.vendor_tokens ?? 0,
          turn.vendor_cost_usd,
          ref,
          a.via,
          turn.latency_ms == null ? 1 : 0,
          r.session_id,
        )
        if (!r.turns) removeOtherStarts.run(ref, new Date(start).toISOString())
        rows++
      }
    }
  })
  write(runs)

  d.query(`INSERT INTO setting (key, value) VALUES ('collect.runs.at', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(snapshot))
  return { rows, skipped }
}
