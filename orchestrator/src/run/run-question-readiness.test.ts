import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { answerResumeUnavailable } from './run-answer-resume.ts'
import { type ChainTurn, continuationWorker } from './run-control.ts'
import { recordRunQuestionReadiness } from './run-question-readiness.ts'

const MACHINE_ID = '01990000-0000-7000-8000-000000000099'

function row(runId: string): { status: string; vendor_session: string | null } {
  return db()
    .query<{ status: string; vendor_session: string | null }, [string]>(
      'SELECT status,vendor_session FROM run WHERE record_id=?',
    )
    .get(runId)!
}

function continuationTurn(runId: string): ChainTurn {
  return db()
    .query<ChainTurn, [string]>(
      `SELECT record_id,agent,vendor_session,turn,cwd,worktree,branch,base_commit,
              worktree_source,executor FROM run WHERE record_id=?`,
    )
    .get(runId)!
}

test('a reply question is answerable while its store write remains pending', async () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  let releaseWrite!: () => void
  const heldWrite = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })

  const recordQuestions = async () => {
    recordRunQuestionReadiness(
      { machineId: MACHINE_ID },
      db(),
      runId,
      'session-from-finished-worker',
      [{}],
    )
    await heldWrite
  }
  const pendingWrite = recordQuestions()

  expect(row(runId)).toEqual({
    status: 'asking',
    vendor_session: 'session-from-finished-worker',
  })
  expect(continuationWorker(runId, continuationTurn(runId), false)).toEqual({
    agent: 'codex',
    session: 'session-from-finished-worker',
  })
  expect(
    answerResumeUnavailable({
      ownersLive: false,
      skipResume: false,
      executor: 'external',
      vendorSession: row(runId).vendor_session,
      resumable: true,
    }),
  ).toBe(false)

  releaseWrite()
  await pendingWrite
})

test('a questionless reply persists its session without changing running status', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })

  recordRunQuestionReadiness(
    { machineId: MACHINE_ID },
    db(),
    runId,
    'session-before-terminal-row',
    [],
  )

  expect(row(runId)).toEqual({
    status: 'running',
    vendor_session: 'session-before-terminal-row',
  })
})
