import { expect, test } from 'bun:test'
import { addRun, score } from '../../test/fixtures/store.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { samePromptSizeBucket } from './prompt-size-bucket.ts'
import { routingEvidenceWindow } from './route-statistics.ts'
import {
  boundedRoutingEvidenceRows,
  isRoutingEvidence,
  type RoutingEvidenceInput,
} from './routing-evidence-query.ts'

type SeededRow = RoutingEvidenceInput & {
  record_id: string
  agent: string
  model: string | null
  startedAt: string
  job: string
  promptBytes: number
  probe: number
  evidenceExcluded: string | null
  parentRunRecordId: string | null
}

test('the bounded SQL returns the same current-model window as the routing predicate', () => {
  const currentModel = AGENTS.codex!.model
  const job = 'craft'
  const addScored = (options: Parameters<typeof addRun>[0]) => {
    const id = addRun(options)
    score(id, 'full', 'right')
    return id
  }

  addScored({ agent: 'codex', job, model: currentModel, startedAt: '2026-01-01T00:00:00Z' })
  const tieA = addScored({
    agent: 'codex',
    job,
    model: currentModel,
    startedAt: '2026-01-02T00:00:00Z',
  })
  db().query('UPDATE run SET model=NULL WHERE record_id=?').run(tieA)
  const tieB = addScored({
    agent: 'codex',
    job,
    model: currentModel,
    startedAt: '2026-01-02T00:00:00Z',
  })
  addScored({ agent: 'codex', job, model: currentModel, startedAt: '2026-01-03T00:00:00Z' })
  const newestNull = addScored({
    agent: 'codex',
    job,
    model: currentModel,
    startedAt: '2026-01-04T00:00:00Z',
  })
  db().query('UPDATE run SET model=NULL WHERE record_id=?').run(newestNull)

  addScored({ agent: 'codex', job, model: 'other-model', startedAt: '2026-01-05T00:00:00Z' })
  const harness = addScored({ agent: 'codex', job, startedAt: '2026-01-06T00:00:00Z' })
  db().query("UPDATE run SET executor='harness' WHERE record_id=?").run(harness)
  addRun({
    agent: 'codex',
    job,
    status: 'failed',
    kind: 'quota',
    startedAt: '2026-01-07T00:00:00Z',
  })
  addRun({ agent: 'codex', job, startedAt: '2026-01-08T00:00:00Z' })
  addScored({ agent: 'codex', job, probe: 1, startedAt: '2026-01-09T00:00:00Z' })
  const excluded = addScored({ agent: 'codex', job, startedAt: '2026-01-10T00:00:00Z' })
  db().query("UPDATE run SET evidence_excluded='fixture' WHERE record_id=?").run(excluded)
  const parent = addRun({ agent: 'codex', job: 'safety', startedAt: '2026-01-11T00:00:00Z' })
  addScored({ agent: 'codex', job, parent, turn: 2, startedAt: '2026-01-11T00:01:00Z' })

  const limit = 3
  const actual = boundedRoutingEvidenceRows({
    jobName: job,
    promptBytes: 0,
    currentModels: { codex: currentModel },
    limit,
  }).map((row) => row.record_id)
  const rows = db()
    .query(
      `SELECT r.record_id,r.agent,r.model,r.started_at AS startedAt,r.job,
              r.prompt_bytes AS promptBytes,r.probe,r.evidence_excluded AS evidenceExcluded,
              r.parent_run_record_id AS parentRunRecordId,r.status,r.executor,
              r.failure_kind AS failureKind,s.delivery
         FROM run r LEFT JOIN score s ON s.run_record_id=r.record_id
        WHERE r.agent='codex'`,
    )
    .all() as SeededRow[]
  const scoped = rows.filter(
    (row) =>
      row.job === job &&
      row.probe === 0 &&
      row.evidenceExcluded === null &&
      row.parentRunRecordId === null &&
      samePromptSizeBucket(row.promptBytes, 0) &&
      isRoutingEvidence(row),
  )
  const expected = routingEvidenceWindow(scoped, 'codex', currentModel, limit).rows.map(
    (row) => row.record_id,
  )

  expect(actual).toEqual(expected)
  expect(actual).toContain(newestNull)
  expect(actual).toContain([tieA, tieB].sort().at(-1)!)
  expect(actual).not.toContain([tieA, tieB].sort()[0]!)
})
