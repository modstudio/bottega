import { newRecordId } from '../../../shared/record-id.ts'
import { ARGV_PROMPT_BYTES } from '../../src/agent/agents.ts'
import { assertWorkerText, readMessageText, readWorkerFile } from '../../src/cli/args.ts'
import { db } from '../../src/database/db.ts'
import { fixtureProjectRecordId } from '../../src/database/test-database.fixture.ts'
import { answerRun as answerRunService, retryRun } from '../../src/run/run-answer.ts'
import { answerInputFromArgv } from '../../src/run/run-message-commands.ts'
import { dir } from './store.ts'

const presentation = {
  dur: (ms: number | null | undefined) => String(ms ?? 0),
  scoreHint: () => '',
  argvResumeLimit: () => ARGV_PROMPT_BYTES,
  printRunId: () => {},
}
export const answerRunHelpers = {
  argvResumeLimit: () => ARGV_PROMPT_BYTES,
  assertWorkerText,
  readWorkerFile,
  readMessageText,
  presentation,
}
export const answerRunFlags = { detach: true, follow: false, quiet: true }
export const answerRunFromArgv = async (
  id: string,
  options: {
    argv: string[]
    recordOnly: boolean
    json?: boolean
    flags: typeof answerRunFlags
  },
  runHelpers: Parameters<typeof answerRunService>[2] & typeof answerRunHelpers,
) =>
  answerRunService(
    id,
    await answerInputFromArgv(
      options.argv,
      options.recordOnly,
      options.json ?? false,
      options.flags,
      runHelpers,
    ),
    runHelpers,
  )
export const retryRunFromFixture = (id: string, options: { agent?: string; model?: string } = {}) =>
  retryRun(id, { ...options, flags: answerRunFlags }, answerRunHelpers)

export function insertRun(status: string, job = 'file-question', recordId = newRecordId()): string {
  return (
    db()
      .query(
        `INSERT INTO run (record_id,number,started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status, repo, cwd, project_record_id)
     VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?, 'codex', ?, 'x', 1, 'x', ?, 'continuation-fixture', ?, ?) RETURNING record_id AS id`,
      )
      .get(recordId, new Date().toISOString(), job, status, dir, fixtureProjectRecordId(db())) as {
      id: string
    }
  ).id
}

export function newQuestionSql(): string {
  return `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`
}

export function returningQuestionSql(): string {
  return `${newQuestionSql()} RETURNING number`
}
