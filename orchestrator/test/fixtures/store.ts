import { newRecordId } from '../../../shared/record/schema.ts'
import { AGENTS } from '../../src/agent/agent-registry.ts'
import { db } from '../../src/database/db.ts'
import { fixtureProjectRecordId } from '../../src/database/test-database.fixture.ts'
import { dir as preloadDir } from '../preload.ts'

export const dir = preloadDir

export function addRun(o: {
  agent: string
  job: string
  status?: string
  latency?: number
  probe?: number
  kind?: string
  parent?: string
  turn?: number
  session?: string | null
  stack?: string
  model?: string
  startedAt?: string
  lens?: string
  repo?: string
  inputTree?: string
  headCommit?: string
  transport?: 'cli' | 'acp'
  taskRecordId?: string | null
  projectRecordId?: string | null
  promptBytes?: number
  promptSha?: string
  specSha?: string
}): string {
  const recordId = newRecordId()
  db()
    .query(
      `INSERT INTO run (record_id, number, started_at, agent, job, prompt_sha, spec_sha, prompt_bytes, prompt_head,
                      status, latency_ms, probe, failure_kind, parent_run_record_id, turn, session_id, stack,
                      model, lens, repo, input_tree, head_commit, transport, task_record_id,
                      project_record_id)
     VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,?,?,?,?,?,'head',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      recordId,
      o.startedAt ?? new Date().toISOString(),
      o.agent,
      o.job,
      o.promptSha ?? 'sha',
      o.specSha ?? o.promptSha ?? 'spec',
      o.promptBytes ?? 10,
      o.status ?? 'ok',
      o.latency ?? 1000,
      o.probe ?? 0,
      o.kind ?? null,
      o.parent ?? null,
      o.turn ?? 1,
      o.session ?? null,
      o.stack ?? null,
      o.model ?? AGENTS[o.agent]?.model ?? null,
      o.lens ?? null,
      o.repo ?? null,
      o.inputTree ?? null,
      o.headCommit ?? null,
      o.transport ?? AGENTS[o.agent]?.defaultTransport ?? 'cli',
      o.taskRecordId ?? null,
      o.projectRecordId === undefined ? fixtureProjectRecordId(db()) : o.projectRecordId,
    )
  return recordId
}

/** Test-only neutral current-window reading for files that need paced codex eligibility. */
export function seedNeutralCodexQuotaReading(now = Date.now()): string {
  const windowMinutes = 10_080
  const resetsAt = Math.floor((now + windowMinutes * 60_000 * 0.9) / 1000)
  const recordId = addRun({
    agent: 'codex',
    job: 'agent-probe-quota',
    startedAt: new Date(now - 86_400_000).toISOString(),
    probe: 1,
  })
  db()
    .query(
      `UPDATE run SET number=0, vendor_tokens=0, quota_used_percent_start=0,
                      quota_used_percent_end=0, quota_window_minutes=?, quota_resets_at=?
        WHERE record_id=?`,
    )
    .run(windowMinutes, resetsAt, recordId)
  return recordId
}
export function score(
  runId: string,
  delivery: string,
  quality: string | null = null,
  fidelity: string | null = null,
) {
  db()
    .query(
      `INSERT INTO score (record_id, run_record_id, delivery, quality, fidelity, scored_at) VALUES ('${newRecordId()}', ?,?,?,?,?)`,
    )
    .run(runId, delivery, quality, fidelity, new Date().toISOString())
}
