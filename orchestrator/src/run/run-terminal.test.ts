import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { job } from '../jobs/jobs.ts'
import { RunQuestionOwnerNotLiveError } from '../question-store/run-question-write-guard.ts'
import { identity } from '../record/record-api-identity.fixture.ts'
import { EMPTY_QUOTA_READINGS } from '../transport/quota-readings.ts'
import { EMPTY_VENDOR_USAGE } from '../transport/vendor-usage.ts'
import { answerResumeUnavailable } from './run-answer-resume.ts'
import { enqueueRunRecord } from './run-outbox.ts'
import {
  artifactPersistenceOutcome,
  checkpointTerminalWork,
  finishRun,
  recordArtifactPersistenceFailure,
  recordTerminalReviewEvidence,
  shouldCheckpointAtTerminal,
  writeObservedTestOutcome,
  writeTerminalOperationalState,
} from './run-terminal.ts'
import { finalizeTerminalChain } from './run-terminal-chain.ts'
import { questionsToInsert, recordTerminalQuestions } from './run-terminal-questions.ts'

afterEach(() => {
  installRecordApiClient(null)
  delete process.env.BOTTEGA_RECORD_API_URL
})

test('a record refusal drops reply questions with a notice and does not throw', async () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const client = createMemoryRecordApiClient()
  db().query("UPDATE project SET settings=json_set(settings,'$.space','space-a')").run()
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
  installRecordApiClient({
    ...client,
    whoami: async () => identity,
    writeQuestion: async () => {
      throw new RunQuestionOwnerNotLiveError(runId)
    },
  })

  const result = await recordTerminalQuestions(runId, [
    {
      kind: 'text',
      question: 'Which implementation?',
      why: 'The implementation depends on the ruling.',
    },
  ])

  expect(result.recorded).toEqual([])
  expect(result.notice).toContain('record refused the write')
})

test('an unverified observed test outcome stores claim disagreement as null', () => {
  const runId = addRun({ agent: 'codex', job: 'implement' })

  writeObservedTestOutcome(db(), runId, {
    ran: true,
    passed: null,
    claimDisagrees: null,
    probesPassed: [],
  })

  expect(
    db()
      .query('SELECT tests_ran,tests_passed,tests_claim_disagrees FROM run WHERE record_id=?')
      .get(runId),
  ).toEqual({ tests_ran: 1, tests_passed: null, tests_claim_disagrees: null })
})

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

test('finish makes a reply question answerable before its store write finishes', async () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const question = {
    kind: 'text' as const,
    question: 'Which implementation should be used?',
    why: 'The implementation depends on the ruling.',
  }
  let releaseWrite!: () => void
  const heldWrite = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  let markWriteStarted!: () => void
  const writeStarted = new Promise<void>((resolve) => {
    markWriteStarted = resolve
  })
  const client = createMemoryRecordApiClient()
  db().query("UPDATE project SET settings=json_set(settings,'$.space','space-a')").run()
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
  installRecordApiClient({
    ...client,
    whoami: async () => identity,
    writeQuestion: async (_intent, body) => {
      markWriteStarted()
      await heldWrite
      return {
        id: body.question.id,
        number: 1,
        revision: body.question.revision,
        applied: true,
      }
    },
  })

  const finishing = finishRun({
    processless: true,
    timer: null,
    checkpointTimer: null,
    resourceObserver: null,
    proc: null,
    askLoopback: null,
    claim: { id: runId, number: 1 },
    machineId: 'machine-terminal-question-order',
    writesJob: true,
    worktree: null,
    launchKey: null,
    failureKind: null,
    endpointKey: { secretName: null, source: 'agent', projectName: null },
    scratchDir: dir,
    gitConfigEnvironment: undefined,
    writingAcp: false,
    checkpointContainment: { disableHooks: false, gitDir: null, hooksDir: null },
    opts: { job: 'implement' },
    watchedCheckouts: [],
    confinementFailures: [],
    frozenBefore: [],
    callerRemoval: { attribution: 'unattributed', removalSession: null, removalRun: null },
    removeIsolatedCwd: null,
    changes: null,
    provisionedMcpConfig: null,
    started: Date.now(),
    retargetDiagnostic: null,
    error: null,
    contract: {
      status: 'asking',
      summary: 'A ruling is required.',
      files_changed: null,
      change_guide: null,
      questions: [question],
      deviations: null,
      blockers: null,
      tests: null,
    },
    status: 'asking',
    contractObjects: 1,
    vendorTerminatedStream: null,
    acceptedQuestions: [question],
    requestedJob: job('implement'),
    checkReviewedCommit: false,
    output: 'A ruling is required.',
    confinementEvent: null,
    parsedReply: null,
    runProjectName: null,
    mcpConnection: null,
    mcpMode: null,
    declaredDeliverables: [],
    mcpSetupHeader: null,
    outPath: join(dir, 'terminal-question-order.out'),
    preConfinement: null,
    callerCwd: dir,
    promptPath: join(dir, 'terminal-question-order.prompt'),
    exitCode: 0,
    vendorTokens: null,
    callUsage: null,
    costUsd: null,
    vendorUsage: EMPTY_VENDOR_USAGE,
    quotaReadings: EMPTY_QUOTA_READINGS,
    effectiveModel: null,
    resolvedSession: 'session-from-finished-worker',
    name: 'codex',
    artifactsPersisted: false,
    mcpRuling: null,
    workerEvents: [],
  })

  await writeStarted
  expect(db().query('SELECT status,vendor_session FROM run WHERE record_id=?').get(runId)).toEqual({
    status: 'asking',
    vendor_session: 'session-from-finished-worker',
  })
  expect(
    answerResumeUnavailable({
      ownersLive: false,
      skipResume: false,
      executor: 'external',
      vendorSession: 'session-from-finished-worker',
      resumable: true,
    }),
  ).toBe(false)

  releaseWrite()
  await finishing
})

test('a superseded turn finishes without recording its reply question', async () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const outPath = join(dir, 'superseded-terminal-question.out')
  const question = {
    kind: 'text' as const,
    question: 'Which implementation should be used?',
    why: 'The implementation depends on the ruling.',
  }

  const result = await finishRun({
    processless: true,
    timer: null,
    checkpointTimer: null,
    resourceObserver: null,
    proc: null,
    askLoopback: null,
    claim: { id: runId, number: 1 },
    machineId: 'machine-superseded-terminal-question',
    writesJob: true,
    worktree: null,
    launchKey: null,
    failureKind: null,
    endpointKey: { secretName: null, source: 'agent', projectName: null },
    scratchDir: dir,
    gitConfigEnvironment: undefined,
    writingAcp: false,
    checkpointContainment: { disableHooks: false, gitDir: null, hooksDir: null },
    opts: { job: 'implement' },
    watchedCheckouts: [],
    confinementFailures: [],
    frozenBefore: [],
    callerRemoval: { attribution: 'unattributed', removalSession: null, removalRun: null },
    removeIsolatedCwd: null,
    changes: null,
    provisionedMcpConfig: null,
    started: Date.now(),
    retargetDiagnostic: null,
    error: null,
    contract: {
      status: 'asking',
      summary: 'A ruling is required.',
      files_changed: null,
      change_guide: null,
      questions: [question],
      deviations: null,
      blockers: null,
      tests: null,
    },
    status: 'asking',
    contractObjects: 1,
    vendorTerminatedStream: null,
    acceptedQuestions: [question],
    requestedJob: job('implement'),
    checkReviewedCommit: false,
    output: 'A ruling is required.',
    confinementEvent: null,
    parsedReply: null,
    runProjectName: null,
    mcpConnection: null,
    mcpMode: null,
    declaredDeliverables: [],
    mcpSetupHeader: null,
    outPath,
    preConfinement: null,
    callerCwd: dir,
    promptPath: join(dir, 'superseded-terminal-question.prompt'),
    exitCode: 0,
    vendorTokens: null,
    callUsage: null,
    costUsd: null,
    vendorUsage: EMPTY_VENDOR_USAGE,
    quotaReadings: EMPTY_QUOTA_READINGS,
    effectiveModel: null,
    resolvedSession: 'session-from-superseded-worker',
    name: 'codex',
    artifactsPersisted: false,
    mcpRuling: null,
    workerEvents: [],
  })

  expect(
    db().query('SELECT COUNT(*) count FROM question WHERE run_record_id=?').get(runId),
  ).toEqual({ count: 0 })
  expect(result.output).toContain(
    `Dropped 1 reply question because run ${runId} was already superseded or finished.`,
  )
  rmSync(outPath)
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
