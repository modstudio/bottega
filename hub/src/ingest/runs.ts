import { db, nowIso } from '../db.ts'
import { attribute, keyFromBranch, keyFromPromptFile, projectOf, projectOfKey } from '../attribute.ts'

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

export type OrchQuestion = {
  id: number
  run_id: number
  asked_at: string
  answered_at: string | null
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
  /** Root and turns, open and answered. Absent on older orch builds. */
  questions?: OrchQuestion[]
  /** The explicit task the run was started for. Absent on historical rows. */
  launch_key?: string | null
}

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
  return turns.some((turn) => turn.vendor_tokens != null)
    ? turns.reduce((sum, turn) => sum + (turn.vendor_tokens ?? 0), 0)
    : null
}

const ORCH = new URL('../../../bin/orch', import.meta.url).pathname

function present(value: unknown, kind: 'number' | 'string'): boolean {
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === 'string' && value.length > 0
}

function isoTimestamp(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function publishedRunIds(row: Record<string, unknown>): Set<number> {
  const ids = new Set<number>()
  if (present(row.id, 'number')) ids.add(row.id as number)
  if (Array.isArray(row.turns)) {
    for (const turn of row.turns) {
      if (turn === null || typeof turn !== 'object' || Array.isArray(turn)) continue
      const id = (turn as Record<string, unknown>).id
      if (present(id, 'number')) ids.add(id as number)
    }
  }
  return ids
}

/** Field the contract requires and this row lacks, or null if the row is complete. */
export function runsContractGap(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'id'
  const row = value as Record<string, unknown>
  for (const field of ['id', 'agent', 'job', 'status', 'started_at'] as const) {
    if (!present(row[field], field === 'id' ? 'number' : 'string')) return field
  }
  // Absent questions is older orch. Null, or anything that is not an array, is not.
  if (!Object.hasOwn(row, 'questions')) return null
  if (!Array.isArray(row.questions)) return 'questions'
  const published = publishedRunIds(row)
  for (let i = 0; i < row.questions.length; i++) {
    const entry = row.questions[i]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return `questions[${i}].id`
    }
    const question = entry as Record<string, unknown>
    if (!present(question.id, 'number')) return `questions[${i}].id`
    if (!present(question.run_id, 'number')) return `questions[${i}].run_id`
    if (!isoTimestamp(question.asked_at)) return `questions[${i}].asked_at`
    if (!Object.hasOwn(question, 'answered_at')) return `questions[${i}].answered_at`
    if (question.answered_at !== null && !isoTimestamp(question.answered_at)) {
      return `questions[${i}].answered_at`
    }
    if (!published.has(question.run_id as number)) return `questions[${i}].run_id`
  }
  return null
}

export function decodeRunsJson(text: string): OrchRun[] {
  const runs: OrchRun[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    let value: unknown
    try { value = JSON.parse(line) }
    catch { throw new Error(`orch runs --json line ${i + 1} is not JSON`) }
    const gap = runsContractGap(value)
    if (gap) throw new Error(`orch runs --json line ${i + 1} missing ${gap}`)
    runs.push(value as OrchRun)
  }
  return runs
}

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
  return decodeRunsJson(out)
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
      if (r.probe === 1) { skipped++; continue }
      // launch_key is the task orch was started for. It beats every inference
      // — worktree, branch, prompt file, prompt prose — and those run only
      // when the field is absent, which is historical rows from before orch
      // recorded one.
      const launchKey = typeof r.launch_key === 'string' && r.launch_key.trim()
        ? r.launch_key.trim().toUpperCase() : null
      let a
      if (launchKey) {
        const owner = projectOfKey(launchKey)
        a = { project: owner ?? projectOf(r.cwd), key: launchKey, via: 'launch_key' as const }
      } else {
        a = attribute({ cwd: r.cwd, prompts: [r.prompt_head] })
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
      }

      // Failover is a new root, not another turn of the run it replaces. The
      // predecessor can therefore fall outside this collect's time window even
      // while its successor is present. Close the predecessor from the handoff
      // itself; waiting to see that old row again leaves its last open sample
      // growing forever. retry_of may name either a root or a resumed child.
      if (r.retry_of != null) {
        closeReplaced.run(`orch:${r.retry_of}`, `orch:%:turn:${r.retry_of}`)
      }

      if (r.questions) {
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
          turn.latency_ms == null ? 1 : 0, r.session_id,
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
