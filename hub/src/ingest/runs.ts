import { db, nowIso } from '../db.ts'
import { attribute, keyFromBranch, keyFromPromptFile } from '../attribute.ts'

/**
 * Delegated agent runs, as intervals.
 *
 * Read through `orch runs --json` rather than by opening orch.db. The
 * orchestrator owns that file; a second concern reading it directly is how the
 * "a database per concern" line stops being true, and the CLI is a published
 * interface that can keep working when the schema behind it moves.
 */
export type OrchTurn = {
  id: number
  started_at: string
  latency_ms: number | null
  vendor_tokens: number | null
  vendor_cost_usd: number | null
  status: string
  turn: number
}

export type OrchRun = {
  id: number
  started_at: string
  agent: string
  job: string
  repo: string | null
  cwd: string | null
  session_id: string | null
  latency_ms: number | null
  vendor_tokens: number | null
  vendor_cost_usd: number | null
  prompt_head: string
  /** Present only under --json; where orch kept the full prompt. */
  prompt_path?: string | null
  /** Present only under --json; the branch the work was on. */
  branch?: string | null
  probe: number
  status: string
  /** Present only under --json; the runs view needs the verdict. */
  delivery?: string | null
  quality?: string | null
  /** The prior execution this retry or automatic failover replaced. */
  retry_of?: number | null
  /** Every execution in a resumable chain, including the root turn. */
  turns?: OrchTurn[]
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
  return turns.some((turn) => turn.vendor_tokens != null)
    ? turns.reduce((sum, turn) => sum + (turn.vendor_tokens ?? 0), 0)
    : null
}

const ORCH = new URL('../../../bin/orch', import.meta.url).pathname

export async function readRuns(since: string): Promise<OrchRun[]> {
  const proc = Bun.spawn([ORCH, 'runs', '--json', '--since', since], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`orch runs --json exited ${code}: ${err.trim()}`)
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as OrchRun)
}

export async function ingestRuns(since: string): Promise<{ rows: number; skipped: number }> {
  const runs = await readRuns(since)
  const d = db()
  const stmt = d.query(
    `INSERT INTO interval (task_key, project, source, agent, job, start_at, end_at,
                           claude_tokens, vendor_tokens, vendor_cost_usd, ref, via, open)
     VALUES (?,?,'orch',?,?,?,?,0,?,?,?,?,?)
     ON CONFLICT(source, ref, start_at) DO UPDATE SET
       end_at          = excluded.end_at,
       vendor_tokens   = excluded.vendor_tokens,
       vendor_cost_usd = excluded.vendor_cost_usd,
       task_key        = excluded.task_key,
       project         = excluded.project,
       job             = excluded.job,
       via             = excluded.via,
       open            = excluded.open`,
  )
  const close = d.query(
    `UPDATE interval SET open = 0 WHERE source = 'orch' AND ref = ?`,
  )
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
      // A probe is a smoke test — "reply with ok" — that did no work on
      // anything, so it is not engaged time on any task.
      if (r.probe) { skipped++; continue }
      // The prompt head is searched for a key only as a last resort, and it is
      // genuinely useful here: a review pack names the task it reviews even
      // when the run happened in a plain checkout.
      const a = attribute({ cwd: r.cwd, prompts: [r.prompt_head] })
      // The FULL prompt before the commit window, because it is direct evidence
      // and the window is an inference. Where both fired they disagreed every
      // single time, and the prompt was right every single time.
      // The branch first: it was named before the work started, where a prompt
      // only mentions a ticket in passing.
      if (!a.key) {
        const b = keyFromBranch(r.branch, a.project)
        if (b) { a.key = b; a.via = 'branch' }
      }
      if (!a.key) {
        const named = keyFromPromptFile(r.prompt_path, a.project)
        if (named) { a.key = named; a.via = 'prompt-file' }
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
        if (!Number.isFinite(start)) { skipped++; continue }

        // A live turn grows to NOW until its measured latency arrives. A turn
        // that stopped without a latency contributes no execution interval.
        if (turn.latency_ms == null && turn.status !== 'running') {
          if (!r.turns) close.run(ref)
          skipped++
          continue
        }
        const end = turn.latency_ms == null ? Math.max(now, start) : start + turn.latency_ms
        stmt.run(
          a.key, a.project, r.agent, r.job,
          new Date(start).toISOString(), new Date(end).toISOString(),
          turn.vendor_tokens ?? 0, turn.vendor_cost_usd, ref, a.via,
          turn.latency_ms == null ? 1 : 0,
        )
        if (!r.turns) removeOtherStarts.run(ref, new Date(start).toISOString())
        rows++
      }
    }
  })
  write(runs)

  d.query(`INSERT INTO setting (key, value) VALUES ('collect.runs.at', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(nowIso()))
  return { rows, skipped }
}
