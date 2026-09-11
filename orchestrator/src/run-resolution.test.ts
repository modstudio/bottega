// Tests run.ts: turn and root resolution.
import { beforeEach, describe, expect, test } from 'bun:test'
import { MIN_SAMPLE, addRun, candidates, db, dir, nowIso, pendingForSession, resolveRootFromLastTurn, resolveSupersededTurn, runJob, score, unscoredCount, weigh } from '../test/fixture.ts'
import { scriptedTransportSequence } from '../test/fake-transport.ts'
import { join } from 'node:path'
import { trackedTestResidue } from '../test/residue.ts'
const trackResidue = trackedTestResidue(); beforeEach(() => { trackResidue(join(dir, '.claude')) })
describe('a conversation is one unit of work, not one per turn', () => {
  const routingEvidenceIds = () => (db().query(
    `SELECT r.id FROM run r LEFT JOIN score s ON s.run_id=r.id
      WHERE r.status IN ('ok','failed','stale') AND r.probe=0
        AND r.evidence_excluded IS NULL AND r.parent_run_id IS NULL
        AND (s.delivery IS NOT NULL OR
             (r.status IN ('failed','stale') AND s.delivery IS NULL))
      ORDER BY r.id`,
  ).all() as { id: number }[]).map((row) => row.id)

  const resumeWithGrok = async (root: number, stdout: string) => {
    const event = stdout.includes('max_tokens')
      ? { kind: 'failed' as const, error: 'response truncated at output ceiling (max_tokens)', stopReason: 'max_tokens' }
      : stdout.includes('HTTP 402')
        ? { kind: 'failed' as const, error: 'HTTP 402: no balance' }
        : { kind: 'completed' as const, output: stdout }
    scriptedTransportSequence([[event]]).install()
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      try {
        return {
          result: await runJob({
            job: 'understand', prompt: 'continue', cwd: dir, noFailover: true,
            resume: {
              parent: root, agent: 'grok', session: 'test-session', turn: 2,
              sessionId: 'orch-test-session', worktree: null,
            },
          }),
          error: null,
        }
      } catch (error) {
        return { result: null, error: error as Error }
      }
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  }

  test('superseding an answered child resolves it without changing routing evidence', () => {
    const root = addRun({ agent: 'codex', job: 'implement' })
    score(root, 'full', 'right')
    const child = addRun({
      agent: 'codex', job: 'implement', status: 'asking', parent: root, turn: 2,
    })
    // A score makes the independent child predicate load-bearing: changing
    // only `asking` to `ok` would admit this row if parent_run_id stopped being
    // part of the router's evidence rule.
    score(child, 'full', 'right')
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(child, nowIso(), 'which shape?', 'the ruled shape', nowIso())
    addRun({ agent: 'codex', job: 'implement', parent: root, turn: 3 })
    const before = routingEvidenceIds()

    expect(resolveSupersededTurn(db(), root, 2)).toBe(1)

    expect(db().query('SELECT status FROM run WHERE id=?').get(child)).toEqual({ status: 'ok' })
    expect(routingEvidenceIds()).toEqual(before)
    expect(candidates('implement').find((row) => row.agent === 'codex')?.evidence).toBe(1)
  })

  test('resolution is child-only, exact, and evidence-neutral', () => {
    const root = addRun({ agent: 'codex', job: 'implement' })
    score(root, 'full', 'right')
    const matched = addRun({
      agent: 'codex', job: 'implement', status: 'asking', parent: root, turn: 2,
    })
    score(matched, 'full', 'right')
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(matched, nowIso(), 'which shape?', 'the ruled shape', nowIso())
    addRun({ agent: 'codex', job: 'implement', parent: root, turn: 3 })

    const unanswered = addRun({
      agent: 'codex', job: 'implement', status: 'asking', parent: root, turn: 4,
    })
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(unanswered, nowIso(), 'still waiting?')
    addRun({ agent: 'codex', job: 'implement', parent: root, turn: 5 })

    const noSuccessor = addRun({
      agent: 'codex', job: 'implement', status: 'asking', parent: root, turn: 6,
    })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(noSuccessor, nowIso(), 'latest question?', 'answered', nowIso())

    const askingRoot = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(askingRoot, nowIso(), 'root question?', 'answered', nowIso())
    addRun({ agent: 'grok', job: 'implement', parent: askingRoot, turn: 2 })
    const before = routingEvidenceIds()
    const statusOf = (id: number) => db().query('SELECT status FROM run WHERE id=?').get(id)

    // The bulk cutover script is gone; these are the boundaries of the rule it
    // enforced, which now lives in the write path and is what must not drift.
    expect(resolveSupersededTurn(db(), root, 2)).toBe(1)
    expect(statusOf(matched)).toEqual({ status: 'ok' })

    // An unanswered question means the turn is still waiting, not superseded.
    expect(resolveSupersededTurn(db(), root, 4)).toBe(0)
    expect(statusOf(unanswered)).toEqual({ status: 'asking' })

    // Nothing came after it, so nothing superseded it.
    expect(resolveSupersededTurn(db(), root, 6)).toBe(0)
    expect(statusOf(noSuccessor)).toEqual({ status: 'asking' })

    // A root is addressed as nobody's child, so it can never be resolved this
    // way however answered its question is. DEV-146 is the counterpart that
    // inherits the last turn's terminal status onto the root; this function
    // must still refuse, or the two rules fight.
    expect(resolveSupersededTurn(db(), askingRoot, 1)).toBe(0)
    expect(statusOf(askingRoot)).toEqual({ status: 'asking' })

    expect(routingEvidenceIds()).toEqual(before)
  })

  test('a stranded root inherits the last turn\'s terminal status and joins routing evidence', () => {
    // The 1095 shape: root still asking, last turn stale, questions answered.
    // DEV-137 pinned that child resolution must not move the evidence set.
    // This is the opposite: the root becoming stale is a new judgement.
    for (let i = 0; i < MIN_SAMPLE - 1; i++) {
      addRun({ agent: 'grok', job: 'implement', status: 'failed', kind: 'other' })
    }
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    score(root, 'none')
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, nowIso(), 'root question?', 'answered', nowIso())
    addRun({
      agent: 'grok', job: 'implement', status: 'stale', parent: root, turn: 2, kind: 'abandoned',
    })

    const before = routingEvidenceIds()
    expect(before).not.toContain(root)
    const beforeGrok = candidates('implement').find((row) => row.agent === 'grok')!
    expect(beforeGrok.evidence).toBe(MIN_SAMPLE - 1)

    expect(resolveRootFromLastTurn(db(), root)).toBe(1)
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(root))
      .toEqual({ status: 'stale', failure_kind: null })

    const after = routingEvidenceIds()
    expect(after).toEqual([...before, root].sort((a, b) => a - b))
    const afterGrok = candidates('implement').find((row) => row.agent === 'grok')!
    expect(afterGrok.evidence).toBe(MIN_SAMPLE)
    expect(afterGrok.scored).toBe(1)
  })

  test('a root waiting on a ruling is not stranded', () => {
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(root, nowIso(), 'still waiting?')
    addRun({
      agent: 'grok', job: 'implement', status: 'stale', parent: root, turn: 2,
    })
    const before = routingEvidenceIds()

    expect(resolveRootFromLastTurn(db(), root)).toBe(0)
    expect(db().query('SELECT status FROM run WHERE id=?').get(root))
      .toEqual({ status: 'asking' })
    expect(routingEvidenceIds()).toEqual(before)
  })

  test('a recoverable root whose last turn is still asking is not ended', () => {
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, nowIso(), 'answered, not continued', 'the ruling', nowIso())
    addRun({
      agent: 'grok', job: 'implement', status: 'asking', parent: root, turn: 2,
    })
    const before = routingEvidenceIds()

    expect(resolveRootFromLastTurn(db(), root)).toBe(0)
    expect(db().query('SELECT status FROM run WHERE id=?').get(root))
      .toEqual({ status: 'asking' })
    expect(routingEvidenceIds()).toEqual(before)
  })

  test('a root whose newest turn is still running is not ended', () => {
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, nowIso(), 'answered', 'the ruling', nowIso())
    addRun({
      agent: 'grok', job: 'implement', status: 'running', parent: root, turn: 2,
    })

    expect(resolveRootFromLastTurn(db(), root)).toBe(0)
    expect(db().query('SELECT status FROM run WHERE id=?').get(root))
      .toEqual({ status: 'asking' })
  })

  test('a plain failed turn inherits its terminal status and failure kind', () => {
    const failed = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(failed, nowIso(), 'which way?', 'that way', nowIso())
    addRun({
      agent: 'codex', job: 'implement', status: 'failed', parent: failed, turn: 2, kind: 'timeout',
    })
    expect(resolveRootFromLastTurn(db(), failed)).toBe(1)
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(failed))
      .toEqual({ status: 'failed', failure_kind: 'timeout' })

    const succeeded = addRun({
      agent: 'codex', job: 'implement', status: 'asking', session: 'restored-root',
    })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(succeeded, nowIso(), 'which way?', 'that way', nowIso())
    addRun({
      agent: 'codex', job: 'implement', status: 'ok', parent: succeeded, turn: 2,
      session: 'restored-root',
    })
    expect(pendingForSession('restored-root')).toEqual([])
    expect(resolveRootFromLastTurn(db(), succeeded)).toBe(1)
    expect(db().query('SELECT status FROM run WHERE id=?').get(succeeded))
      .toEqual({ status: 'ok' })
    expect(pendingForSession('restored-root').map((row) => row.id)).toEqual([succeeded])
  })

  test('an escaped turn rolls its restorable outcome and confinement event onto the root', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
    const snapshot = JSON.stringify({ status: 'ok', failureKind: null, error: null })
    const confinement = JSON.stringify({
      classification: 'overlapping', attribution: 'unattributed',
      divergentPaths: ['artifact.ts'], overlappingPaths: ['artifact.ts'],
    })
    const turn = addRun({
      agent: 'codex', job: 'implement', status: 'failed', parent: root, turn: 2, kind: 'escaped',
    })
    db().query('UPDATE run SET pre_confinement=?, confinement=? WHERE id=?')
      .run(snapshot, confinement, turn)

    expect(resolveRootFromLastTurn(db(), root)).toBe(1)
    expect(db().query(
      'SELECT status, failure_kind, pre_confinement, confinement FROM run WHERE id=?',
    ).get(root)).toEqual({
      status: 'failed', failure_kind: 'escaped', pre_confinement: snapshot, confinement,
    })
  })

  test('a restored root is scoreable once a later turn completes', () => {
    const root = addRun({
      agent: 'codex', job: 'implement', status: 'asking', session: 'restored-later',
    })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, nowIso(), 'which way?', 'that way', nowIso())
    addRun({
      agent: 'codex', job: 'implement', status: 'ok', parent: root, turn: 2, session: 'restored-later',
    })
    expect(pendingForSession('restored-later')).toEqual([])
    expect(resolveRootFromLastTurn(db(), root)).toBe(1)
    expect(pendingForSession('restored-later').map((row) => row.id)).toEqual([root])
  })

  test('a resumed truncation rolls up through run and stays excluded', async () => {
    const root = addRun({ agent: 'grok', job: 'understand', status: 'asking' })
    const before = candidates('understand').find((row) => row.agent === 'grok')!
    expect(before.evidence).toBe(0)

    const outcome = await resumeWithGrok(root, [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'truncated-resume' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', text: 'the findings survived in the transcript' }],
          stop_reason: 'max_tokens',
        },
      }),
      JSON.stringify({
        type: 'result', subtype: 'error_during_execution', result: '', stop_reason: 'max_tokens',
        errors: ['response truncated by max_tokens'],
      }),
    ].join('\n') + '\n')
    expect(outcome.error?.message).toContain('response truncated at output ceiling (max_tokens)')
    expect(db().query(
      'SELECT status, error, failure_kind FROM run WHERE id=?',
    ).get(root)).toEqual({
      status: 'failed', error: 'response truncated at output ceiling (max_tokens)',
      failure_kind: 'truncated',
    })
    const after = candidates('understand').find((row) => row.agent === 'grok')!
    expect(after.evidence).toBe(before.evidence)
    expect(after.failures).toBe(before.failures)
  })

  test('a resumed quota failure rolls up through run and stays excluded', async () => {
    const root = addRun({ agent: 'grok', job: 'understand', status: 'asking' })
    const before = candidates('understand').find((row) => row.agent === 'grok')!

    const outcome = await resumeWithGrok(root, JSON.stringify({
      type: 'result', subtype: 'error_during_execution', errors: ['HTTP 402: no balance'],
    }) + '\n')
    expect(outcome.error?.message).toContain('HTTP 402: no balance')
    expect(db().query(
      'SELECT status, error, failure_kind FROM run WHERE id=?',
    ).get(root)).toEqual({
      status: 'failed', error: expect.stringContaining('HTTP 402: no balance'), failure_kind: 'quota',
    })
    const child = db().query(
      'SELECT id FROM run WHERE parent_run_id=?',
    ).get(root) as { id: number }
    expect(db().query(
      'SELECT resource_kind, event_kind, resource_key, run_id FROM contention WHERE run_id=?',
    ).get(child.id)).toEqual({
      resource_kind: 'vendor', event_kind: 'refusal', resource_key: 'grok', run_id: child.id,
    })
    const after = candidates('understand').find((row) => row.agent === 'grok')!
    expect(after.evidence).toBe(before.evidence)
    expect(after.failures).toBe(before.failures)
  })

  test('a dropped contention table does not roll back a terminal run', async () => {
    const table = db().query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='contention'",
    ).get() as { sql: string }
    const indexes = db().query(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='contention' AND sql IS NOT NULL",
    ).all() as { sql: string }[]
    db().exec('DROP TABLE contention')
    try {
      const root = addRun({ agent: 'grok', job: 'understand', status: 'asking' })
      const outcome = await resumeWithGrok(root, JSON.stringify({
        type: 'result', subtype: 'error_during_execution', errors: ['HTTP 402: no balance'],
      }) + '\n')
      expect(outcome.error?.message).toContain('HTTP 402: no balance')
      expect(db().query(
        'SELECT status, failure_kind FROM run WHERE id=?',
      ).get(root)).toEqual({ status: 'failed', failure_kind: 'quota' })
    } finally {
      db().exec(table.sql)
      for (const index of indexes) db().exec(index.sql)
    }
  })

  test('a successful resumed turn clears an earlier timeout from the root', async () => {
    const root = addRun({ agent: 'grok', job: 'understand', status: 'failed', kind: 'timeout' })
    db().query("UPDATE run SET error='timed out' WHERE id=?").run(root)
    score(root, 'full', 'right')

    const outcome = await resumeWithGrok(root, JSON.stringify({
      type: 'result', subtype: 'success', result: 'finished after resuming',
    }) + '\n')
    expect(outcome.error).toBeNull()
    expect(outcome.result?.status).toBe('ok')
    expect(db().query(
      'SELECT status, error, failure_kind FROM run WHERE id=?',
    ).get(root)).toEqual({ status: 'ok', error: null, failure_kind: null })
    expect(routingEvidenceIds()).toContain(root)
    expect(candidates('understand').find((row) => row.agent === 'grok')!.evidence).toBe(1)
  })

  test('turns of one run do not each count as evidence', () => {
    // A worker that asked two questions produces three rows. Counting each
    // would let an agent reach MIN_SAMPLE by being inquisitive rather than good.
    const root = addRun({ agent: 'codex', job: 'implement' })
    addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
    addRun({ agent: 'codex', job: 'implement', parent: root, turn: 3 })
    score(root, 'full', 'right')

    const c = candidates('implement').find((x) => x.agent === 'codex')!
    expect(c.runs).toBe(1)      // one unit of work
    expect(c.evidence).toBe(1)  // one judgement, not three
    expect(c.score).toBe(weigh('full', 'right'))
  })

  test('a child turn is never offered for scoring', () => {
    const root = addRun({ agent: 'codex', job: 'implement', session: 's1' })
    const child = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2, session: 's1' })
    const ids = pendingForSession('s1').map((r) => r.id)
    expect(ids).toContain(root)
    expect(ids).not.toContain(child)
  })

  test('a root is not offered while its newest turn is still running', () => {
    const root = addRun({ agent: 'codex', job: 'implement', session: 's1' })
    const child = addRun({
      agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2, session: 's1',
    })
    expect(pendingForSession('s1')).toHaveLength(0)
    expect(unscoredCount()).toBe(0)

    db().query("UPDATE run SET status='ok' WHERE id=?").run(child)
    expect(pendingForSession('s1').map((r) => r.id)).toEqual([root])
    expect(unscoredCount()).toBe(1)
  })
})
