import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { register as registerReviewCommand } from '../commands/review.ts'
import { db } from '../database/db.ts'
import { recordReview } from './review-triage.ts'
import { restoreReviewTriage } from './review-triage-restore.ts'

type FindingSeed = {
  findingId: number
  reviewId: number
  originalRecordId: string
  remintedRecordId: string
  payload: Record<string, unknown>
}

function seedFinding(name: string, completed = true): FindingSeed {
  const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: name })
  const reviewId = recordReview(runId, reviewReply(1, 'high'), db())
  const finding = db()
    .query<{ id: number; record_id: string }, [number]>(
      'SELECT id,record_id FROM review_finding WHERE review_id=?',
    )
    .get(reviewId)!
  const outbox = db()
    .query<{ payload: string }, [number]>(
      "SELECT payload FROM outbox WHERE kind='review_finding' AND json_extract(payload,'$.localId')=? ORDER BY id DESC LIMIT 1",
    )
    .get(finding.id)!
  const remintedRecordId = `reminted-${name}-${finding.id}`
  db().query('UPDATE review_finding SET record_id=? WHERE id=?').run(remintedRecordId, finding.id)
  if (completed) {
    db()
      .query('UPDATE review SET completed_at=? WHERE id=?')
      .run('2026-09-21T00:00:00.000Z', reviewId)
  }
  return {
    findingId: finding.id,
    reviewId,
    originalRecordId: finding.record_id,
    remintedRecordId,
    payload: JSON.parse(outbox.payload) as Record<string, unknown>,
  }
}

function appendSource(seed: FindingSeed, overrides: Record<string, unknown> = {}): number {
  const payload = {
    ...seed.payload,
    disposition: 'accepted',
    rejectionCategory: null,
    triagedSeverity: 'high',
    triagedAt: '2026-09-20T12:00:00.000Z',
    ...overrides,
  }
  return Number(
    db()
      .query<{ id: number }, [string, string, string]>(
        `INSERT INTO outbox (kind,record_id,payload,created_at)
         VALUES ('review_finding',?,?,?) RETURNING id`,
      )
      .get(seed.originalRecordId, JSON.stringify(payload), '2026-09-22T00:00:00.000Z')!.id,
  )
}

test('restores triage through an audited amendment and is idempotent', () => {
  const seed = seedFinding('restore-triage-apply')
  const outboxId = appendSource(seed)

  const report = restoreReviewTriage(db(), { dryRun: false })
  expect(report.applied).toBe(1)
  expect(report.byDisposition.accepted).toBe(1)
  expect(
    db()
      .query(
        `SELECT record_id,disposition,rejection_category,triaged_severity,triaged_at
           FROM review_finding WHERE id=?`,
      )
      .get(seed.findingId),
  ).toEqual({
    record_id: seed.originalRecordId,
    disposition: 'accepted',
    rejection_category: null,
    triaged_severity: 'high',
    triaged_at: '2026-09-20T12:00:00.000Z',
  })
  const amendment = db()
    .query<{ reason: string; at: string }, [number]>(
      'SELECT reason,at FROM review_finding_amendment WHERE review_id=?',
    )
    .get(seed.reviewId)!
  expect(amendment).toEqual({
    reason: `restored from outbox row ${outboxId}`,
    at: expect.any(String),
  })
  expect(amendment.at).not.toBe('2026-09-20T12:00:00.000Z')

  expect(restoreReviewTriage(db(), { dryRun: false }).applied).toBe(0)
})

test('skips null-only, mismatched, open, missing, and hosted-diverged findings', () => {
  seedFinding('restore-triage-null')
  const mismatch = seedFinding('restore-triage-mismatch')
  appendSource(mismatch, { location: 'other.ts:1' })
  const open = seedFinding('restore-triage-open', false)
  appendSource(open)
  const missing = seedFinding('restore-triage-missing')
  db()
    .query("DELETE FROM outbox WHERE kind='review_finding' AND json_extract(payload,'$.localId')=?")
    .run(missing.findingId)
  const diverged = seedFinding('restore-triage-diverged')
  appendSource(diverged)
  db()
    .query("INSERT INTO outbox (kind,record_id,payload,created_at) VALUES ('run',?,?,?)")
    .run(diverged.remintedRecordId, '{}', '2026-09-23T00:00:00.000Z')

  const report = restoreReviewTriage(db(), { dryRun: false })
  expect(report.applied).toBe(0)
  expect(report.byReason).toEqual({
    'latest outbox row has null disposition': 1,
    'identity mismatch': 1,
    'review is not completed': 1,
    'no outbox row': 1,
    'hosted identity already diverged': 1,
  })
})

test('dry-run reports the amendment but writes nothing', () => {
  const seed = seedFinding('restore-triage-dry-run')
  appendSource(seed)
  const before = {
    finding: db().query('SELECT * FROM review_finding WHERE id=?').get(seed.findingId),
    amendments: db().query('SELECT COUNT(*) AS count FROM review_finding_amendment').get(),
    outbox: db().query('SELECT COUNT(*) AS count FROM outbox').get(),
  }

  const report = restoreReviewTriage(db(), { dryRun: true })

  expect(report.applied).toBe(1)
  expect({
    finding: db().query('SELECT * FROM review_finding WHERE id=?').get(seed.findingId),
    amendments: db().query('SELECT COUNT(*) AS count FROM review_finding_amendment').get(),
    outbox: db().query('SELECT COUNT(*) AS count FROM outbox').get(),
  }).toEqual(before)
})

test('review command dispatches restore-triage with --dry-run in process', async () => {
  const seed = seedFinding('restore-triage-command-dry-run')
  appendSource(seed)
  const before = db().query('SELECT * FROM review_finding WHERE id=?').get(seed.findingId)
  const program = new Command().exitOverride()
  registerReviewCommand(program)

  await program.parseAsync(['node', 'orch', 'review', 'restore-triage', '--dry-run'])

  expect(db().query('SELECT * FROM review_finding WHERE id=?').get(seed.findingId)).toEqual(before)
})
