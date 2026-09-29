import { describe, expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { reclaimResidue } from './reclaim-residue.ts'

describe('guarded residue reclaim', () => {
  test('unattended reclaim keeps an alive identity-unverified process record', () => {
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: 'project' })
    db()
      .query('UPDATE run SET agent_pid=?,agent_start_time=NULL WHERE id=?')
      .run(process.pid, runId)

    const result = reclaimResidue('process', String(runId), {
      dryRun: false,
      allowSignal: false,
    })

    expect(result.ok).toBe(false)
    expect(db().query('SELECT agent_pid FROM run WHERE id=?').get(runId)).toEqual({
      agent_pid: process.pid,
    })
  })

  for (const kind of ['ref-guard', 'retained-ref'] as const) {
    test(`${kind} refuses a subject project that differs from the recorded run project`, () => {
      const runId = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: 'alpha' })

      const result = reclaimResidue(kind, `beta:${runId}`, { dryRun: true })

      expect(result).toEqual({
        ok: false,
        action: `refused; invariant: run ${runId} belongs to project beta; fix: use its recorded project alpha`,
      })
    })
  }

  test('stale settlement updates evidence and enqueues hosted sync atomically', () => {
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'stale', repo: 'project' })

    expect(reclaimResidue('stale-run', String(runId))).toMatchObject({ ok: true })

    expect(db().query('SELECT evidence_excluded FROM run WHERE id=?').get(runId)).toEqual({
      evidence_excluded: expect.stringContaining('settled by orch reclaim stale-run'),
    })
    expect(
      db()
        .query('SELECT kind FROM outbox WHERE record_id=(SELECT record_id FROM run WHERE id=?)')
        .get(runId),
    ).toEqual({
      kind: 'run',
    })
  })

  test('stale settlement rolls evidence exclusion back when hosted enqueue fails', () => {
    const parent = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: 'project' })
    const runId = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'stale',
      repo: 'project',
      parent,
      turn: 2,
    })
    db().query('UPDATE run SET record_id=NULL WHERE id=?').run(parent)

    expect(() => reclaimResidue('stale-run', String(runId))).toThrow(
      `run ${runId} has parent_run_id ${parent} without a record id`,
    )
    expect(db().query('SELECT evidence_excluded FROM run WHERE id=?').get(runId)).toEqual({
      evidence_excluded: null,
    })
  })
})
