import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { failingDefaultCanonEvals } from './canon-eval-status.ts'

test('default eval failures follow evaluation timestamps, not insertion order', () => {
  const olderRunId = addRun({ agent: 'codex', job: 'implement', probe: 1 })
  const newerRunId = addRun({ agent: 'codex', job: 'implement', probe: 1 })
  db()
    .query(
      `INSERT INTO canon_eval (record_id, slug, run_record_id, canon_sha, agent, model, pass, why, at)
       VALUES (?, 'timestamp-order', ?, 'new-sha', 'codex', 'model', 0, 'new failure', '2026-10-23T12:00:00.000Z'),
              (?, 'timestamp-order', ?, 'old-sha', 'codex', 'model', 1, 'old pass', '2026-10-22T12:00:00.000Z')`,
    )
    .run(newRecordId(), newerRunId, newRecordId(), olderRunId)

  expect(failingDefaultCanonEvals()).toEqual([{ slug: 'timestamp-order', agent: 'codex' }])
})
