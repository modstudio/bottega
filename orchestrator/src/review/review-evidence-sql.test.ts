import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  admissionReviewRunEvidenceSql,
  routingReviewRunEvidenceSql,
} from './review-evidence-sql.ts'

type EvidenceFixture = {
  voided?: boolean
  probe?: boolean
  delivery?: 'full' | 'none'
  disposition?: 'accepted' | null
}

function addLensEvidence(input: EvidenceFixture): string {
  const reviewId = newRecordId()
  db()
    .query(
      `INSERT INTO review (record_id,number,recorded_at)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM review),'2026-11-21T00:00:00Z')`,
    )
    .run(reviewId)
  const runId = addRun({
    agent: 'codex',
    job: 'review-lens',
    lens: 'correctness',
    probe: input.probe ? 1 : 0,
  })
  if (input.voided)
    db().query("UPDATE run SET evidence_excluded='fixture' WHERE record_id=?").run(runId)
  if (input.delivery) score(runId, input.delivery, input.delivery === 'none' ? null : 'right')
  const lensId = newRecordId()
  db()
    .query(
      `INSERT INTO review_lens
       (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
       VALUES (?,?,?,'correctness','codex','[]','[]','[]','[]')`,
    )
    .run(lensId, reviewId, runId)
  if ('disposition' in input) {
    db()
      .query(
        `INSERT INTO review_finding
         (record_id,review_record_id,review_lens_record_id,ordinal,severity,location,evidence,proposed_correction,disposition)
         VALUES (?,?,?,1,'high','file.ts:1','evidence','fix',?)`,
      )
      .run(newRecordId(), reviewId, lensId, input.disposition ?? null)
  }
  return lensId
}

function evidenceForms(lensId: string): { admission: number; routing: number } {
  return db()
    .query<{ admission: number; routing: number }, [string]>(
      `SELECT ${admissionReviewRunEvidenceSql('run', 'rl')} AS admission,
              ${routingReviewRunEvidenceSql('run', 'rl')} AS routing
         FROM review_lens rl
         JOIN run ON run.record_id=rl.run_record_id
        WHERE rl.record_id=?`,
    )
    .get(lensId)!
}

describe('review evidence SQL', () => {
  test.each([
    [
      'voided with a dispositioned finding',
      { voided: true, delivery: 'none', disposition: 'accepted' },
      1,
      0,
    ],
    [
      'voided with an untriaged finding',
      { voided: true, delivery: 'none', disposition: null },
      0,
      0,
    ],
    ['unvoided with delivery none', { delivery: 'none' }, 0, 0],
    [
      'voided probe',
      { probe: true, voided: true, delivery: 'none', disposition: 'accepted' },
      0,
      0,
    ],
    ['unvoided probe', { probe: true, delivery: 'full' }, 0, 0],
    ['ordinary scored lens', { delivery: 'full' }, 1, 1],
  ] satisfies [string, EvidenceFixture, number, number][])(
    '%s',
    (_name, fixture, admission, routing) => {
      expect(evidenceForms(addLensEvidence(fixture))).toEqual({ admission, routing })
    },
  )
})
