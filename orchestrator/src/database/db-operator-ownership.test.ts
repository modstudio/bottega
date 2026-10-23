import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { WORKER_ENVIRONMENT_MARKERS } from '../../../shared/caller-classification.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { shouldExpireUnjudgedOwner } from '../cleanup/cleanup-sweep-decisions.ts'
import { pendingCommand } from '../evidence/pending-commands.ts'
import { NOT_EVIDENCE } from '../failure/failure.ts'
import { judgeRun, scoreRun } from '../judgment.ts'
import { requireBranchRunOwner } from '../review/review-read.ts'
import { adoptRunMutation, authorizeRunMutation } from '../run/run-authority.ts'
import { db, recordSessionSeen, sessionId } from './db.ts'
import { applyMigrations } from './migrations.ts'

const marker = /(?:SESSION_ID|THREAD_ID)$/
const workerMarker = (key: string) =>
  WORKER_ENVIRONMENT_MARKERS.includes(key as (typeof WORKER_ENVIRONMENT_MARKERS)[number])
let savedMarkers: Record<string, string | undefined>

beforeEach(() => {
  savedMarkers = {}
  for (const key of Object.keys(process.env)) {
    if (marker.test(key) || workerMarker(key)) {
      savedMarkers[key] = process.env[key]
      delete process.env[key]
    }
  }
})

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (marker.test(key) || workerMarker(key)) delete process.env[key]
  }
  Object.assign(process.env, savedMarkers)
})

const flags = {
  has: (_name: string) => false,
  flag: (_name: string) => undefined,
  values: (_name: string) => [],
}
const presentation = {
  log: (..._values: unknown[]) => {},
  error: (..._values: unknown[]) => {},
  pairHint: (partner: { id: string }) => `pair ${partner.id}`,
}
const judgmentOptions = {
  words: ['full', 'right'],
  note: null,
  auditReason: null,
  notEvidence: NOT_EVIDENCE,
}

test('a plain terminal owns, lists, scores, and judges its fixture runs', async () => {
  const owner = sessionId()
  expect(owner).toMatch(/^operator:/)
  expect(sessionId()).toBe(owner)

  const scoreId = addRun({ agent: 'codex', job: 'file-question', session: owner })
  const output: string[] = []
  let exitCode = 0
  pendingCommand(() => '', {
    log: (value) => output.push(value),
    setExitCode: (value) => {
      exitCode = value
    },
  })
  expect(output.join('\n')).toContain(`${PLATFORM_SLUG} score ${scoreId}`)
  expect(exitCode).toBe(1)

  await scoreRun(scoreId, flags, { ...judgmentOptions, dashboardAuthorized: false }, presentation)
  const judgeId = addRun({
    agent: 'codex',
    job: 'file-question',
    session: owner,
    promptSha: 'different-prompt',
  })
  await judgeRun(judgeId, flags, judgmentOptions, presentation)
  expect(db().query('SELECT COUNT(*) count FROM score').get()).toEqual({ count: 2 })
})

test('a plain terminal adopts an ownerless run on its first score', async () => {
  const id = addRun({ agent: 'codex', job: 'file-question', session: null })
  await scoreRun(id, flags, { ...judgmentOptions, dashboardAuthorized: false }, presentation)
  expect(db().query('SELECT session_id FROM run WHERE record_id=?').get(id)).toEqual({
    session_id: sessionId(),
  })
})

test('sessionId neither throws nor writes through a read-only store with no machine id', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-session-id-readonly-'))
  const path = join(root, 'orchestrator.db')
  const configHome = process.env.BOTTEGA_CONFIG_HOME
  try {
    process.env.BOTTEGA_CONFIG_HOME = join(root, 'config')
    const writable = new Database(path, { create: true })
    applyMigrations(writable)
    writable.close()
    const readonly = new Database(path, { readonly: true })
    try {
      expect(sessionId(readonly)).toBeNull()
      expect(
        readonly.query("SELECT value FROM schema_meta WHERE key='machine_id'").get(),
      ).toBeNull()
    } finally {
      readonly.close()
    }
  } finally {
    if (configHome === undefined) delete process.env.BOTTEGA_CONFIG_HOME
    else process.env.BOTTEGA_CONFIG_HOME = configHome
    rmSync(root, { recursive: true, force: true })
  }
})

test('operator authority covers answer, continue, tell, review read, and sweep liveness', () => {
  const owner = sessionId()!
  for (const action of ['answer', 'continue', 'tell'] as const) {
    const id = addRun({ agent: 'codex', job: 'implement', session: owner })
    expect(adoptRunMutation(authorizeRunMutation(id, action), action).actor).toBe(owner)
  }
  db()
    .query(
      "INSERT INTO project (record_id,name,path,settings) VALUES (?,'fixture','/fixture','{}')",
    )
    .run(newRecordId())
  const reviewId = addRun({ agent: 'codex', job: 'implement', session: owner, repo: 'fixture' })
  db()
    .query(
      "UPDATE run SET branch='DEV-1105-operator',project_record_id=(SELECT record_id FROM project WHERE name='fixture') WHERE record_id=?",
    )
    .run(reviewId)
  expect(requireBranchRunOwner(db(), 'fixture', 'DEV-1105-operator', owner)).toBe(owner)

  recordSessionSeen(owner, '2026-10-05T12:00:00.000Z')
  const seen = db()
    .query<{ last_seen: string }, [string]>('SELECT last_seen FROM session_seen WHERE session_id=?')
    .get(owner)
  expect(
    shouldExpireUnjudgedOwner({
      ownerSessionId: owner,
      ownerLastSeenAt: Date.parse(seen!.last_seen),
      runLastActivityAt: 0,
      now: Date.parse('2026-10-05T12:00:01.000Z'),
      windowMs: 10_000,
    }),
  ).toBe(false)
})

describe('worker refusal', () => {
  beforeEach(() => {
    process.env.BOTTEGA_RUN_ID = '42'
  })

  test('a worker cannot score', async () => {
    const id = addRun({ agent: 'codex', job: 'file-question', session: null })
    await expect(
      scoreRun(id, flags, { ...judgmentOptions, dashboardAuthorized: false }, presentation),
    ).rejects.toThrow('this caller is a worker; a worker cannot score')
  })

  test('a worker cannot score or adopt after dropping only run id and depth', async () => {
    for (const marker of WORKER_ENVIRONMENT_MARKERS) process.env[marker] = 'worker-value'
    delete process.env.BOTTEGA_RUN_ID
    delete process.env.BOTTEGA_DEPTH
    const id = addRun({ agent: 'codex', job: 'file-question', session: null })
    await expect(
      scoreRun(id, flags, { ...judgmentOptions, dashboardAuthorized: false }, presentation),
    ).rejects.toThrow('this caller is a worker; a worker cannot score')
    expect(() => adoptRunMutation(authorizeRunMutation(id, 'answer'), 'answer')).toThrow(
      'this caller is a worker; a worker cannot answer',
    )
  })
})

test('a Claude session cannot assume the reserved operator identity', () => {
  process.env.CLAUDE_CODE_SESSION_ID = `operator:machine-id`
  expect(sessionId()).toBeNull()
})

describe('unsupported harness refusal', () => {
  beforeEach(() => {
    process.env.CODEX_THREAD_ID = 'thread-1'
  })

  test('an unsupported harness is directed to an outside terminal', async () => {
    const id = addRun({ agent: 'codex', job: 'file-question', session: null })
    await expect(
      scoreRun(id, flags, { ...judgmentOptions, dashboardAuthorized: false }, presentation),
    ).rejects.toThrow(
      'this caller is an unsupported harness (CODEX_THREAD_ID); run the command from a terminal outside that harness',
    )
  })
})
