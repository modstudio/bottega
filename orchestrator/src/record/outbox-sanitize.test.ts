import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { enqueueReview, enqueueReviewFinding, enqueueReviewRead } from '../review/review-outbox.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import { enqueueRunRecord } from '../run/run-outbox.ts'
import { enqueueScoreRecord } from '../score/score-outbox.ts'
import {
  enqueueContention,
  enqueueLandingOverride,
} from './landing-outbox.ts'
import { outboxRowIsEligible } from './outbox-dependency.ts'
import {
  firstOutboxEvidenceRule,
  sanitizeOutboxPayload,
  WITHHELD_SECRET_SHAPED,
  type OutboxSanitizeKind,
} from './outbox-sanitize.ts'

const SECRET = 'ghp_123456789012345678901234567890123456'
const SAFE = 'ordinary evidence text'

type KindCase = {
  kind: OutboxSanitizeKind
  payload: Record<string, unknown>
  path: string
  plant: (payload: Record<string, unknown>) => void
}

const kinds: KindCase[] = [
  {
    kind: 'run',
    payload: {
      promptHead: SAFE,
      label: SAFE,
      error: SAFE,
      routeReason: SAFE,
      closeOutDetail: SAFE,
      evidenceUnvoid: { note: SAFE },
      reviewProvenance: { commands_run: [SAFE] },
    },
    path: 'error',
    plant: (payload) => {
      payload.error = SECRET
    },
  },
  {
    kind: 'score',
    payload: { note: SAFE, delivery: 'full' },
    path: 'note',
    plant: (payload) => {
      payload.note = SECRET
    },
  },
  {
    kind: 'question',
    payload: { question: SAFE, options: [SAFE], answer: SAFE, audits: [{ reason: SAFE }] },
    path: 'answer',
    plant: (payload) => {
      payload.answer = SECRET
    },
  },
  {
    kind: 'review',
    payload: { tierReasons: [SAFE], tierReason: SAFE, commitMessage: SAFE, outdatedReason: SAFE },
    path: 'commitMessage',
    plant: (payload) => {
      payload.commitMessage = SECRET
    },
  },
  {
    kind: 'review_lens',
    payload: { commandsRun: [SAFE, SAFE], filesCovered: [SAFE] },
    path: 'commandsRun[1]',
    plant: (payload) => {
      payload.commandsRun = [SAFE, SECRET]
    },
  },
  {
    kind: 'review_finding',
    payload: { location: SAFE, evidence: SAFE, proposedCorrection: SAFE },
    path: 'evidence',
    plant: (payload) => {
      payload.evidence = SECRET
    },
  },
  {
    kind: 'review_read',
    payload: { note: SAFE, branch: 'DEV-1' },
    path: 'note',
    plant: (payload) => {
      payload.note = SECRET
    },
  },
  {
    kind: 'landing',
    payload: { error: SAFE, steps: [{ detail: SAFE }, { detail: SAFE }] },
    path: 'steps[1].detail',
    plant: (payload) => {
      payload.steps = [{ detail: SAFE }, { detail: SECRET }]
    },
  },
  {
    kind: 'landing_override',
    payload: { reason: SAFE, branch: 'DEV-1' },
    path: 'reason',
    plant: (payload) => {
      payload.reason = SECRET
    },
  },
  {
    kind: 'contention',
    payload: { cause: SAFE, resourceKind: 'lock' },
    path: 'cause',
    plant: (payload) => {
      payload.cause = SECRET
    },
  },
  {
    kind: 'test_flake',
    payload: { test: SAFE, file: SAFE, signal: SAFE },
    path: 'signal',
    plant: (payload) => {
      payload.signal = SECRET
    },
  },
]

test.each(kinds)('$kind withholds one planted leaf and leaves the rest', ({ kind, payload, path, plant }) => {
  const planted = structuredClone(payload)
  plant(planted)
  const sanitized = sanitizeOutboxPayload(kind, planted)
  expect(sanitized.withheldFields).toEqual([path])
  const serialized = JSON.stringify(sanitized)
  expect(serialized).not.toContain(SECRET)
  expect(serialized).toContain(WITHHELD_SECRET_SHAPED)
  expect(firstOutboxEvidenceRule(kind, planted)).toBe('provider-prefix')
})

test('run reviewProvenance withholds a nested string leaf in place', () => {
  const sanitized = sanitizeOutboxPayload('run', {
    promptHead: SAFE,
    reviewProvenance: { commands_run: [SAFE, SECRET] },
  })
  expect(sanitized.withheldFields).toEqual(['reviewProvenance.commands_run[1]'])
  expect(sanitized.reviewProvenance).toEqual({
    commands_run: [SAFE, WITHHELD_SECRET_SHAPED],
  })
})

test('question withholds options as a unit and audit reasons as audit_reason', () => {
  const sanitized = sanitizeOutboxPayload('question', {
    question: SAFE,
    options: [SAFE, SECRET],
    audits: [{ reason: SECRET }, { reason: SAFE }],
  })
  expect(sanitized.options).toBe(WITHHELD_SECRET_SHAPED)
  expect(sanitized.audits).toEqual([
    { reason: WITHHELD_SECRET_SHAPED },
    { reason: SAFE },
  ])
  expect(sanitized.withheldFields).toEqual(['options', 'audit_reason'])
})

test('a sanitized run row stays eligible for the send-time payload re-check', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query(
      `INSERT INTO run
       (id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,error)
       VALUES (42,'2026-09-15T01:00:00.000Z','codex','implement','sha',4,'head','ok',?)`,
    )
    .run(SECRET)
  enqueueRunRecord(database, 42, '01990000-0000-7000-8000-000000000099', '2026-09-15T01:01:00.000Z')
  const row = database
    .query<
      {
        id: number
        kind: string
        record_id: string
        payload: string
        created_at: string
        attempts: number
        last_error: string | null
        synced_at: string | null
        quarantined_at: string | null
        retired_at: string | null
      },
      []
    >('SELECT * FROM outbox')
    .get()!
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  expect(payload.error).toBe(WITHHELD_SECRET_SHAPED)
  expect(payload.withheldFields).toEqual(['error'])
  expect(row.payload).not.toContain(SECRET)
  expect(database.query('SELECT error FROM run WHERE id=42').get()).toEqual({ error: SECRET })
  expect(outboxRowIsEligible(database, row)).toBe(true)
  database.close()
})

test('enqueue withholds a planted leaf for score, question, review, override, and contention', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database.query("INSERT INTO schema_meta (key,value) VALUES ('machine_id','01990000-0000-7000-8000-000000000099')").run()
  database
    .query(
      `INSERT INTO run (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (1,'01990000-0000-7000-8000-000000000010','2026-09-15T00:00:00Z','codex','implement','sha',1,'head','ok')`,
    )
    .run()
  database
    .query(
      `INSERT INTO score (run_id,delivery,quality,fidelity,note,scored_at,scored_by)
       VALUES (1,'full','right','faithful',?,'2026-09-15T01:00:00.000Z','architect')`,
    )
    .run(SECRET)
  enqueueScoreRecord(database, 1, '01990000-0000-7000-8000-000000000099')
  const question = database
    .query(
      `INSERT INTO question (run_id,asked_at,question,answer) VALUES (1,'2026-09-15T00:01:00Z','Which?',?) RETURNING id`,
    )
    .get(SECRET) as { id: number }
  enqueueQuestionRecord(database, question.id)
  database
    .query("INSERT INTO review (id,record_id,recorded_at,commit_message) VALUES (1,'review-record','2026-09-15T00:02:00Z',?)")
    .run(SECRET)
  enqueueReview(database, 1)
  database
    .query(
      `INSERT INTO landing_override (id,record_id,project,branch,tip,tree,reason,at)
       VALUES (1,'override-record','fixture','DEV-1','tip','tree',?,'2026-09-15T00:03:00Z')`,
    )
    .run(SECRET)
  enqueueLandingOverride(database, 1)
  database
    .query(
      `INSERT INTO contention (id,record_id,at,resource_kind,resource_key,event_kind,cause)
       VALUES (1,'contention-record','2026-09-15T00:04:00Z','lock','resource','wait',?)`,
    )
    .run(SECRET)
  enqueueContention(database, 1)

  const byKind = Object.fromEntries(
    database
      .query<{ kind: string; payload: string }, []>('SELECT kind,payload FROM outbox')
      .all()
      .map((row) => [row.kind, JSON.parse(row.payload) as Record<string, unknown>]),
  )
  expect(byKind.score?.note).toBe(WITHHELD_SECRET_SHAPED)
  expect(byKind.score?.withheldFields).toEqual(['note'])
  expect(byKind.question?.answer).toBe(WITHHELD_SECRET_SHAPED)
  expect(byKind.review?.commitMessage).toBe(WITHHELD_SECRET_SHAPED)
  expect(byKind.landing_override?.reason).toBe(WITHHELD_SECRET_SHAPED)
  expect(byKind.contention?.cause).toBe(WITHHELD_SECRET_SHAPED)
  expect(JSON.stringify(byKind)).not.toContain(SECRET)
  database.close()
})

test('review finding and read enqueue withhold planted leaves', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database.query("INSERT INTO schema_meta (key,value) VALUES ('machine_id','machine-record')").run()
  database
    .query(
      `INSERT INTO run (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (1,'run-record','2026-09-15T00:00:00Z','codex','review-lens','sha',1,'head','ok')`,
    )
    .run()
  database.query("INSERT INTO review (id,record_id,recorded_at) VALUES (1,'review-record','2026-09-15T01:00:00Z')").run()
  database
    .query(
      `INSERT INTO review_lens
       (id,record_id,review_id,run_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
       VALUES (1,'lens-record',1,1,'craft','codex','[]','[]',?,'[]')`,
    )
    .run(JSON.stringify([SECRET]))
  database
    .query(
      `INSERT INTO review_finding
       (id,record_id,review_id,review_lens_id,ordinal,severity,location,evidence,proposed_correction)
       VALUES (1,'finding-record',1,1,1,'major','a.ts:1',?,'correct it')`,
    )
    .run(SECRET)
  enqueueReviewFinding(database, 1)
  database
    .query(
      `INSERT INTO review_read
       (id,record_id,branch,tip,patch_id,path_set,tier,note,recorded_at)
       VALUES (1,'read-record','DEV-1','tip','patch','[]',1,?,'2026-09-15T01:02:00Z')`,
    )
    .run(SECRET)
  enqueueReviewRead(database, 1)
  const rows = Object.fromEntries(
    database
      .query<{ kind: string; payload: string }, []>('SELECT kind,payload FROM outbox')
      .all()
      .map((row) => [row.kind, JSON.parse(row.payload) as Record<string, unknown>]),
  )
  expect(rows.review_finding?.evidence).toBe(WITHHELD_SECRET_SHAPED)
  expect(rows.review_read?.note).toBe(WITHHELD_SECRET_SHAPED)
  expect(JSON.stringify(rows)).not.toContain(SECRET)
  database.close()
})
