import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  answerRunFlags,
  answerRunFromArgv,
  answerRunHelpers,
  insertRun,
  newQuestionSql,
} from '../../test/fixtures/run-answer.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  assertMigrationDispatchAllowed,
  clearMigrationDrain,
  setMigrationDrain,
} from '../database/migration-drain.ts'
import { upsertProject } from '../project/projects.ts'
import type { detach } from './run-dispatch.ts'

test('answering an asking chain resumes it through a live migration drain', async () => {
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
  upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: dir })
  const id = insertRun('asking')
  db()
    .query('UPDATE run SET session_id=?,vendor_session=? WHERE record_id=?')
    .run('orch-test-session', 'vendor', id)
  db().query(newQuestionSql()).run(id, new Date().toISOString(), 'which shape?')
  const dispatch: typeof detach = async (_job, _prompt, spec) => {
    assertMigrationDispatchAllowed(db(), spec.resume !== undefined)
    return addRun({
      agent: spec.resume!.agent,
      job: 'file-question',
      status: 'running',
      parent: spec.resume!.parent,
      turn: spec.resume!.turn,
    })
  }
  setMigrationDrain(db(), '0155_rebuild', { pid: process.pid, startTime: null })
  try {
    const result = await answerRunFromArgv(
      id,
      { argv: ['use the existing shape'], recordOnly: false, flags: answerRunFlags },
      { ...answerRunHelpers, dispatch },
    )
    expect(result.outcome).toBe('resumed')
  } finally {
    clearMigrationDrain(db())
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})
