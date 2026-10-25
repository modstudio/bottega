import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { enqueueRunRecord } from './run-outbox.ts'
import {
  artifactPersistenceOutcome,
  checkpointTerminalWork,
  finalizeTerminalChain,
  questionsToInsert,
  recordArtifactPersistenceFailure,
  recordTerminalReviewEvidence,
  shouldCheckpointAtTerminal,
  writeTerminalOperationalState,
} from './run-terminal.ts'

test('a billing terminal outcome durably disables the agent with its operator remedy', () => {
  const runId = addRun({ agent: 'grok', job: 'implement' })

  writeTerminalOperationalState(db(), runId, null, 'billing', 'grok')

  expect(db().query("SELECT enabled,disabled_reason FROM agent WHERE name='grok'").get()).toEqual({
    enabled: 0,
    disabled_reason: `billing hold — restore the vendor balance or billing limit, then run '${PLATFORM_SLUG} agent set grok --enabled true'`,
  })
})

test('a billing terminal outcome includes the verified refusal in its hold', () => {
  const runId = addRun({ agent: 'grok', job: 'implement' })

  writeTerminalOperationalState(db(), runId, null, 'billing', 'grok', 'the paid key limit is used')

  expect(db().query("SELECT enabled,disabled_reason FROM agent WHERE name='grok'").get()).toEqual({
    enabled: 0,
    disabled_reason: `billing hold — the paid key limit is used; then run '${PLATFORM_SLUG} agent set grok --enabled true'`,
  })
})

test('a non-billing terminal outcome leaves agent enablement unchanged', () => {
  const runId = addRun({ agent: 'grok', job: 'implement' })
  db()
    .query("UPDATE agent SET enabled=0,disabled_reason='operator disabled' WHERE name='grok'")
    .run()

  writeTerminalOperationalState(db(), runId, null, 'quota', 'grok')

  expect(db().query("SELECT enabled,disabled_reason FROM agent WHERE name='grok'").get()).toEqual({
    enabled: 0,
    disabled_reason: 'operator disabled',
  })
})

test('an ok child refreshes the failed root run record with the chain outcome', () => {
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    kind: 'capacity',
  })
  const child = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    parent: root,
    turn: 2,
  })
  const machine = '01990000-0000-7000-8000-000000000099'
  enqueueRunRecord(db(), root, machine, '2026-10-16T12:00:00.000Z')

  finalizeTerminalChain(db(), {
    runId: child,
    parentRunId: root,
    status: 'ok',
    failureKind: null,
    error: null,
    record: [machine, '2026-10-16T12:01:00.000Z'],
  })

  const latest = db()
    .query<{ payload: string }, [string]>(
      `SELECT payload FROM outbox
       WHERE kind='run' AND row_id=(SELECT record_id FROM run WHERE record_id=?)
       ORDER BY id DESC LIMIT 1`,
    )
    .get(root)!
  expect(JSON.parse(latest.payload)).toMatchObject({ status: 'ok', failureKind: null })
})

test('a failed non-failover child closes its question before the root inherits failure', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  const child = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    kind: 'interrupted',
    parent: root,
    turn: 2,
  })
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
    )
    .run(child, '2026-09-29', 'What should happen?')

  finalizeTerminalChain(db(), {
    runId: child,
    parentRunId: root,
    status: 'failed',
    failureKind: 'interrupted',
    error: 'worker interrupted',
    record: ['01990000-0000-7000-8000-000000000099', '2026-10-16T12:01:00.000Z'],
  })

  expect(db().query('SELECT status,failure_kind FROM run WHERE record_id=?').get(root)).toEqual({
    status: 'failed',
    failure_kind: 'interrupted',
  })
  expect(db().query('SELECT close_reason FROM question WHERE run_record_id=?').get(child)).toEqual({
    close_reason: 'chain-terminal',
  })
})

test('artifact persistence failure retains a completed worker outcome', () => {
  expect(
    artifactPersistenceOutcome({
      status: 'ok',
      error: 'reply.json missing; used final-message fallback',
      failureKind: null,
      persistenceError: 'artifact persistence failed: named file is not a file',
    }),
  ).toEqual({
    status: 'ok',
    error:
      'reply.json missing; used final-message fallback\n' +
      'artifact persistence failed: named file is not a file',
    failureKind: null,
  })
})

test('artifact persistence failure refreshes a completed child and its root', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  const child = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    parent: root,
    turn: 2,
  })
  const machine = '01990000-0000-7000-8000-000000000099'
  enqueueRunRecord(db(), child, machine, '2026-10-16T12:00:00.000Z')
  enqueueRunRecord(db(), root, machine, '2026-10-16T12:00:00.000Z')
  const error = 'artifact persistence failed: named file is not a file'

  recordArtifactPersistenceFailure(db(), {
    runId: child,
    parentRunId: root,
    error,
    machineId: machine,
    finishedAt: '2026-10-16T12:01:00.000Z',
  })

  const latestPayload = (id: string) => {
    const row = db()
      .query<{ payload: string }, [string]>(
        `SELECT payload FROM outbox
         WHERE kind='run' AND row_id=(SELECT record_id FROM run WHERE record_id=?)
         ORDER BY id DESC LIMIT 1`,
      )
      .get(id)!
    return JSON.parse(row.payload)
  }
  expect(latestPayload(child)).toMatchObject({ status: 'ok', failureKind: null, error })
  expect(latestPayload(root)).toMatchObject({ status: 'ok', failureKind: null, error })
})

describe('terminal question deduplication decision', () => {
  test('omits a question already recorded for the run', () => {
    const accepted = [{ question: 'Which table?', why: 'The migration depends on it.' }]

    expect(questionsToInsert(['Which table?'], accepted)).toEqual([])
  })

  test('treats surrounding whitespace, internal whitespace runs, and case as equivalent', () => {
    const accepted = [
      { question: '  Which table?  ', why: 'first' },
      { question: 'Which   table?', why: 'second' },
      { question: 'WHICH TABLE?', why: 'third' },
    ]

    expect(questionsToInsert([], accepted)).toEqual(accepted.slice(0, 1))
  })

  test('returns genuinely different questions in their accepted order', () => {
    const accepted = [
      { question: 'Which table?', why: 'first' },
      { question: 'Which column?', why: 'second' },
      { question: 'Which index?', why: 'third' },
    ]

    expect(questionsToInsert([], accepted)).toEqual(accepted)
  })

  test('collapses duplicates within the accepted questions', () => {
    const accepted = [
      { question: 'Which table?', why: 'first' },
      { question: 'which table?', why: 'repeated in the final reply' },
    ]

    expect(questionsToInsert([], accepted)).toEqual(accepted.slice(0, 1))
  })
})

describe('terminal checkpoint decision', () => {
  test('checkpoints an ok writing turn even when it has no task key', () => {
    expect(
      shouldCheckpointAtTerminal({
        writesJob: true,
        hasWorktree: true,
      }),
    ).toBe(true)
  })

  test('rejects checkpointing a read-only turn', () => {
    expect(
      shouldCheckpointAtTerminal({
        writesJob: false,
        hasWorktree: true,
      }),
    ).toBe(false)
  })

  test('the terminal checkpoint step surfaces a containment refusal', () => {
    const runId = addRun({ agent: 'codex', job: 'implement' })
    const worktree = '/worktrees/DEV-1647'

    expect(
      checkpointTerminalWork({
        writesJob: true,
        worktree: { path: worktree, branch: 'DEV-1647-test' },
        claim: { id: runId, number: 1647 },
        launchKey: 'DEV-1647',
        scratchDir: '/scratch/DEV-1647',
        gitConfigEnvironment: undefined,
        checkpointContainment: { disableHooks: true, gitDir: null, hooksDir: null },
        opts: { job: 'implement' },
      }),
    ).toBe(
      `Harness checkpoint failed: checkpoint refused: writing ACP run has incomplete checkpoint containment; any uncommitted work is still in the worktree at ${worktree}.`,
    )
  })
})

describe('terminal review evidence', () => {
  test('a probe run with a parsed findings reply records no review, and a non-probe run still does', () => {
    const parsedReview = reviewReply(1)
    const probeRun = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'fixture-model',
      lens: 'canon-eval',
      probe: 1,
    })
    const productRun = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'fixture-model',
      lens: 'craft',
    })
    expect(
      recordTerminalReviewEvidence(db(), {
        runId: probeRun,
        parsedReview,
        status: 'ok',
        failureKind: null,
      }),
    ).toBeNull()
    expect(
      db().query('SELECT record_id FROM review_lens WHERE run_record_id=?').get(probeRun),
    ).toBeNull()
    const reviewId = recordTerminalReviewEvidence(db(), {
      runId: productRun,
      parsedReview,
      status: 'ok',
      failureKind: null,
    })
    expect(reviewId).toMatch(/^[0-9a-f-]{36}$/)
    expect(
      db().query('SELECT review_record_id FROM review_lens WHERE run_record_id=?').get(productRun),
    ).toEqual({
      review_record_id: reviewId,
    })
  })
})
