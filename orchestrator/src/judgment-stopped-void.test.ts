import { beforeEach, expect, test } from 'bun:test'
import { flags } from '../test/fixtures/judgment.ts'
import { addRun } from '../test/fixtures/store.ts'
import { db } from './database/db.ts'
import { NOT_EVIDENCE } from './failure/failure.ts'
import { scoreRun } from './judgment.ts'
import { VOID_EXCLUSION_REASON } from './verdict/verdict-rules.ts'

beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
})

test("score --void excludes a stopped '(pending)' run without recording a score", async () => {
  const id = addRun({
    agent: '(pending)',
    job: 'file-question',
    status: 'stopped',
    session: 'orch-test-session',
  })
  db().query("UPDATE run SET failure_kind='stopped' WHERE record_id=?").run(id)
  await scoreRun(
    id,
    flags({ void: true }),
    {
      words: ['none'],
      note: null,
      auditReason: null,
      notEvidence: NOT_EVIDENCE,
      dashboardAuthorized: false,
    },
    { log: () => {}, error: () => {}, pairHint: () => '' },
  )
  expect(db().query('SELECT evidence_excluded FROM run WHERE record_id=?').get(id)).toEqual({
    evidence_excluded: VOID_EXCLUSION_REASON,
  })
  expect(db().query('SELECT * FROM score WHERE run_record_id=?').get(id)).toBeNull()
})
