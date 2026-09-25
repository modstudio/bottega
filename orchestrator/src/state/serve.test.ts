import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun, dir, score } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { db, nowIso } from '../database/db.ts'
import { recordReview } from '../review/review-triage.ts'
import { runDetail, state } from './serve.ts'

const trackResidue = trackedTestResidue()
describe('probes are excluded from every query that reports', () => {
  test('byRepo leaves calibration traffic out', () => {
    // The rule is stated in AGENTS.md and this was the one aggregate that had
    // no test holding it: byRepo counted probes until it was noticed by eye.
    const real = addRun({ agent: 'grok', job: 'craft' })
    const probe = addRun({ agent: 'grok', job: 'craft', probe: 1 })
    for (const id of [real, probe]) {
      db().query("UPDATE run SET repo='devbox', vendor_tokens=100 WHERE id=?").run(id)
    }
    const rows = state(null).byRepo as { repo: string; runs: number; toks: number }[]
    const devbox = rows.find((r) => r.repo === 'devbox')!
    expect(devbox.runs).toBe(1)
    expect(devbox.toks).toBe(100)
  })
})

test('live child turns publish their chain root for hub badge matching', () => {
  const root = addRun({ agent: 'codex', job: 'craft', status: 'ok' })
  const child = addRun({
    agent: 'codex',
    job: 'craft',
    status: 'asking',
    parent: root,
    turn: 2,
  })
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(child, nowIso(), 'Which?')
  const live = state(null).live as { id: number; root_id: number }[]
  expect(live.find((row) => row.id === child)).toMatchObject({ id: child, root_id: root })
})

describe('run detail', () => {
  test('publishes local review lenses and findings in hosted detail shape', () => {
    const id = addRun({ agent: 'codex', job: 'review-lens' })
    db().query("UPDATE run SET lens='correctness', model='gpt' WHERE id=?").run(id)
    recordReview(id, reviewReply(1), db())
    expect(runDetail(id)!.reviews).toMatchObject([
      {
        runId: id,
        lens: expect.any(String),
        agent: 'codex',
        standardsRead: expect.any(Array),
        filesCovered: expect.any(Array),
        findings: [
          {
            ordinal: 1,
            severity: expect.any(String),
            proposedCorrection: expect.any(String),
          },
        ],
      },
    ])
  })

  test('publishes every field hub reads without publishing the ask credential', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'failed', latency: 1234, probe: 1 })
    const promptPath = trackResidue(join(dir, 'detail-prompt.txt'))
    const outputPath = trackResidue(join(dir, 'detail-output.txt'))
    writeFileSync(promptPath, 'the whole prompt')
    writeFileSync(outputPath, 'the whole reply')
    db()
      .query(
        `UPDATE run SET vendor_tokens=?, failure_kind=?, evidence_excluded=?, error=?,
                      prompt_path=?, output_path=?, run_token=?, doc_revisions=?, canon_sha=? WHERE id=?`,
      )
      .run(
        5678,
        'timeout',
        'not evidence',
        'timed out',
        promptPath,
        outputPath,
        'secret',
        '[4,9]',
        'canon-123',
        id,
      )
    score(id, 'partial', 'mixed')
    db().query('UPDATE score SET note=? WHERE run_id=?').run('read by hub', id)
    const detail = runDetail(id)!
    expect(detail).toMatchObject({
      id,
      requested_id: id,
      resolved_from: 'root',
      root_id: id,
      agent: 'grok',
      job: 'craft',
      latency_ms: 1234,
      vendor_tokens: 5678,
      status: 'failed',
      failure_kind: 'timeout',
      probe: 1,
      evidence_excluded: 'not evidence',
      error: 'timed out',
      doc_revisions: '[4,9]',
      canon_sha: 'canon-123',
      delivery: 'partial',
      quality: 'mixed',
      note: 'read by hub',
      prompt: 'the whole prompt',
      output: 'the whole reply',
    })
    expect(detail).not.toHaveProperty('run_token')
  })
  test('publishes ordered chain audit and renders a missing actor explicitly', () => {
    const root = addRun({ agent: 'codex', job: 'implement' })
    const child = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, child)
    const insertAudit = db().query(
      `INSERT INTO run_mutation_audit (run_id, root_id, action, actor_session, at, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    insertAudit.run(root, root, 'stop', null, '2026-09-05T01:00:00.000Z', null)
    insertAudit.run(
      child,
      root,
      'continue',
      'architect-session',
      '2026-09-05T02:00:00.000Z',
      'ruled',
    )
    expect(runDetail(child)!.audit).toEqual([
      {
        run_id: root,
        root_id: root,
        action: 'stop',
        actor_session: 'anonymous (no session id)',
        at: '2026-09-05T01:00:00.000Z',
        reason: null,
      },
      {
        run_id: child,
        root_id: root,
        action: 'continue',
        actor_session: 'architect-session',
        at: '2026-09-05T02:00:00.000Z',
        reason: 'ruled',
      },
    ])
    expect(runDetail(child)).toMatchObject({
      id: child,
      requested_id: child,
      resolved_from: 'turn',
      root_id: root,
    })
    expect(() => insertAudit.run(root, root, 'invented', null, nowIso(), null)).toThrow()
  })
})
