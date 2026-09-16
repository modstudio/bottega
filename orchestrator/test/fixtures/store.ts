import { newRecordId } from '../../../shared/record/schema.ts'
import { AGENTS } from '../../src/agent-registry.ts'
import { db } from '../../src/db.ts'
import { dir as preloadDir } from '../preload.ts'

export const dir = preloadDir
export function addRun(o: {
  agent: string
  job: string
  status?: string
  latency?: number
  probe?: number
  kind?: string
  parent?: number
  turn?: number
  session?: string | null
  stack?: string
  model?: string
  startedAt?: string
  lens?: string
  repo?: string
  inputTree?: string
  headCommit?: string
  promptBytes?: number
  promptSha?: string
  specSha?: string
}): number {
  return (
    db()
      .query(
        `INSERT INTO run (record_id, started_at, agent, job, prompt_sha, spec_sha, prompt_bytes, prompt_head,
                      status, latency_ms, probe, failure_kind, parent_run_id, turn, session_id, stack,
                      model, lens, repo, input_tree, head_commit)
     VALUES (?,?,?,?,?,?,?,'head',?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .get(
        newRecordId(),
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
      ) as { id: number }
  ).id
}
export function score(
  runId: number,
  delivery: string,
  quality: string | null = null,
  fidelity: string | null = null,
) {
  db()
    .query('INSERT INTO score (run_id, delivery, quality, fidelity, scored_at) VALUES (?,?,?,?,?)')
    .run(runId, delivery, quality, fidelity, new Date().toISOString())
}
