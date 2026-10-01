import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Command } from 'commander'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { register } from './rulings.ts'

const SESSION = 'ruling-cli-test'
let priorRunId: string | undefined
let priorSession: string | undefined

beforeEach(() => {
  priorRunId = process.env.ORCH_RUN_ID
  priorSession = process.env.CLAUDE_CODE_SESSION_ID
  delete process.env.ORCH_RUN_ID
  process.env.CLAUDE_CODE_SESSION_ID = SESSION
})

afterEach(() => {
  if (priorRunId === undefined) delete process.env.ORCH_RUN_ID
  else process.env.ORCH_RUN_ID = priorRunId
  if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorSession
})

function answeredQuestion(project: string): number {
  const runId = addRun({
    agent: 'codex',
    job: 'file-question',
    status: 'ok',
    session: SESSION,
    repo: project,
  })
  return (
    db()
      .query(
        `INSERT INTO question
          (run_id,asked_at,question,answer,answered_at,answered_by,answerer_kind,answer_channel)
         VALUES (?,'2026-10-01','Which shape?','Keep it.','2026-10-01',?,'operator','cli')
         RETURNING id`,
      )
      .get(runId, SESSION) as { id: number }
  ).id
}

async function fileThroughCli(questionId: number): Promise<void> {
  const program = new Command().exitOverride()
  register(program)
  await program.parseAsync(['node', 'orch', 'ruling', 'file', String(questionId), '--as', 'doc'])
}

test('CLI ruling file --as doc allows an architect caller and refuses a worker caller', async () => {
  const project = 'ruling-cli-project'
  upsertProject({ name: project, path: process.cwd() })
  const allowed = answeredQuestion(project)
  await fileThroughCli(allowed)
  expect(db().query('SELECT filed_as FROM question WHERE id=?').get(allowed)).toEqual({
    filed_as: 'doc',
  })

  const refused = answeredQuestion(project)
  process.env.ORCH_RUN_ID = 'ruling-cli-worker'
  await expect(fileThroughCli(refused)).rejects.toThrow(
    'refusing document store write from an orch worker run',
  )
  expect(db().query('SELECT filed_as FROM question WHERE id=?').get(refused)).toEqual({
    filed_as: null,
  })
})
