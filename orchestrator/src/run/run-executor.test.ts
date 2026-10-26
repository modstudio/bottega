import { beforeEach, expect, test } from 'bun:test'
import { flags } from '../../test/fixtures/judgment.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { NOT_EVIDENCE } from '../failure/failure.ts'
import { scoreRun } from '../judgment.ts'

beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
})

test('a harness execution verdict is stored without voiding the run', async () => {
  const id = addRun({
    agent: 'harness',
    job: 'file-question',
    status: 'ok',
    session: 'orch-test-session',
  })
  db().query("UPDATE run SET executor='harness' WHERE record_id=?").run(id)

  await scoreRun(
    id,
    flags({}),
    {
      words: ['full', 'right'],
      note: null,
      auditReason: null,
      notEvidence: NOT_EVIDENCE,
      dashboardAuthorized: false,
    },
    { log: () => {}, error: () => {}, pairHint: () => '' },
  )

  expect(db().query('SELECT evidence_excluded FROM run WHERE record_id=?').get(id)).toEqual({
    evidence_excluded: null,
  })
  expect(db().query('SELECT delivery,quality FROM score WHERE run_record_id=?').get(id)).toEqual({
    delivery: 'full',
    quality: 'right',
  })
})
