import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { selectFindingDuplicatePairs, findingRows } from '../collect/finding-duplicate-suggestions.ts'
import { db } from '../database/db.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { FINDING_DUPLICATE_QUESTION } from './finding-duplicate-question.ts'
import { findingBacktestSubjects, typedQuestionBacktest } from './typed-question-backtest.ts'

test('refuses an undeclared question and names the declared ids', async () => {
  await expect(
    typedQuestionBacktest(
      { question: 'unknown', version: 1, limit: 50 },
      { log: () => {} },
      db(),
    ),
  ).rejects.toThrow('declared ids: spec_unsettled, finding_duplicate')
})

test('does not ask a subject already answered for that version', async () => {
  const database = db()
  const runId = newRecordId()
  const promptPath = join(mkdtempSync(join(tmpdir(), 'typed-backtest-')), 'prompt.txt')
  writeFileSync(promptPath, 'caller spec')
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,spec_sha,prompt_bytes,prompt_head,status,
        turn,project_record_id,prompt_path)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','implement','p','spec-id',1,
               'p','ok',1,?,?)`,
    )
    .run(runId, new Date().toISOString(), fixtureProjectRecordId(database), promptPath)
  database
    .query(
      `INSERT INTO typed_question_answer
       (record_id,question_id,question_version,subject_kind,subject_ref,state_sha,answer_json,
        model,input_tokens,latency_ms,error,created_at)
       VALUES (?,'spec_unsettled',1,'spec:implement','spec-id','state','{"noul":0.1}',
               'jev',1,1,NULL,?)`,
    )
    .run(newRecordId(), new Date().toISOString())
  let asks = 0
  const lines: string[] = []
  await typedQuestionBacktest(
    { question: 'spec_unsettled', version: 1, limit: 50 },
    { log: (line) => lines.push(line) },
    database,
    async () => {
      asks += 1
      return { noul: 0 }
    },
  )
  expect(asks).toBe(0)
  expect(lines).toContain('asked 0; already answered 1; errors 0')
})

function seedFindingPair(): string {
  const database = db()
  const reviewId = newRecordId()
  database
    .query(
      `INSERT INTO review (record_id,number,recorded_at)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM review),?)`,
    )
    .run(reviewId, new Date().toISOString())
  let newestRun = ''
  for (const ordinal of [1, 2]) {
    const runId = newRecordId()
    newestRun = runId
    database
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,spec_sha,prompt_bytes,prompt_head,status,
          turn,project_record_id,head_commit)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','review-lens','p','s',1,
                 'p','ok',1,?,'tip')`,
      )
      .run(runId, new Date(Date.now() + ordinal).toISOString(), fixtureProjectRecordId(database))
    const lensId = newRecordId()
    database
      .query(
        `INSERT INTO review_lens
         (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,
          commands_run,could_not_verify)
         VALUES (?,?,?,'correctness','codex','[]','[]','[]','[]')`,
      )
      .run(lensId, reviewId, runId)
    database
      .query(
        `INSERT INTO review_finding
         (record_id,review_record_id,review_lens_record_id,ordinal,severity,location,evidence,
          proposed_correction) VALUES (?,?,?,?, 'high','file.ts:1',?,'fix')`,
      )
      .run(newRecordId(), reviewId, lensId, ordinal, `evidence ${ordinal}`)
  }
  return newestRun
}

test('finding backtest source returns the same pairs as live selection', () => {
  const database = db()
  const currentRun = seedFindingPair()
  const live = selectFindingDuplicatePairs(
    currentRun,
    findingRows(database, currentRun),
    new Map(),
  )
  const backtest = findingBacktestSubjects(database)
  expect(backtest.map((subject) => subject.subjectRef)).toContain(live[0]!.subjectRef)
  expect(backtest.find((subject) => subject.subjectRef === live[0]!.subjectRef)?.state).toEqual(
    live[0]!.state,
  )
  expect(FINDING_DUPLICATE_QUESTION.backtestSource).toBe('finding-pairs')
})
