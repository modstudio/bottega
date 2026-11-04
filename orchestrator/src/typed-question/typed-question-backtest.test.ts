import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  findingRows,
  selectFindingDuplicatePairs,
} from '../collect/finding-duplicate-suggestions.ts'
import { db } from '../database/db.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { FINDING_DUPLICATE_QUESTION } from './finding-duplicate-question.ts'
import { findingPairSubjects, typedQuestionBacktest } from './typed-question-backtest.ts'

test('refuses an undeclared question and names the declared ids', async () => {
  await expect(
    typedQuestionBacktest({ question: 'unknown', version: 1, limit: 50 }, { log: () => {} }, db()),
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
  expect(lines).toContain('asked 0; already answered 1; unreadable 0; errors 0')
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
  const live = selectFindingDuplicatePairs(currentRun, findingRows(database, currentRun), new Map())
  const backtest = findingPairSubjects(
    database,
    FINDING_DUPLICATE_QUESTION,
    { question: FINDING_DUPLICATE_QUESTION.id, version: 1, limit: 50 },
    () => false,
  ).subjects
  expect(backtest.map((subject) => subject.subjectRef)).toContain(live[0]!.subjectRef)
  expect(backtest.find((subject) => subject.subjectRef === live[0]!.subjectRef)?.state).toEqual(
    live[0]!.state,
  )
})

test('the limit counts only unanswered subjects, so answered ones never exhaust it', async () => {
  const database = db()
  const dir = mkdtempSync(join(tmpdir(), 'backtest-limit-'))
  const job = `limit-job-${newRecordId()}`
  for (const [index, specSha] of ['older', 'newer'].entries()) {
    const promptPath = join(dir, `${specSha}.txt`)
    writeFileSync(promptPath, `spec ${specSha}`)
    database
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,spec_sha,prompt_bytes,prompt_head,status,
          turn,project_record_id,prompt_path)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex',?,'p',?,1,'p','ok',1,?,?)`,
      )
      .run(
        newRecordId(),
        new Date(Date.now() + index).toISOString(),
        job,
        `${job}-${specSha}`,
        fixtureProjectRecordId(database),
        promptPath,
      )
  }
  database
    .query(
      `INSERT INTO typed_question_answer
       (record_id,question_id,question_version,subject_kind,subject_ref,state_sha,answer_json,
        model,input_tokens,latency_ms,error,created_at)
       VALUES (?,'spec_unsettled',1,?,?,'state','{"noul":0.1}','jev',1,1,NULL,?)`,
    )
    .run(newRecordId(), `spec:${job}`, `${job}-newer`, new Date().toISOString())
  const asked: string[] = []
  await typedQuestionBacktest(
    { question: 'spec_unsettled', version: 1, job, limit: 1 },
    { log: () => {} },
    database,
    async (input) => {
      asked.push(input.subjectRef)
      return { noul: 0 }
    },
  )
  expect(asked).toEqual([`${job}-older`])
})

test("a declared id with an undeclared version names that id's versions", async () => {
  await expect(
    typedQuestionBacktest(
      { question: 'spec_unsettled', version: 9, limit: 50 },
      { log: () => {} },
      db(),
    ),
  ).rejects.toThrow('declared versions: v1, v2')
})

test('a spec dispatched twice is asked once, and a missing prompt is counted unreadable', async () => {
  const database = db()
  const dir = mkdtempSync(join(tmpdir(), 'backtest-dedupe-'))
  const job = `dedupe-job-${newRecordId()}`
  const promptPath = join(dir, 'spec.txt')
  writeFileSync(promptPath, 'spec')
  const rows: [string, string][] = [
    [`${job}-shared`, promptPath],
    [`${job}-shared`, promptPath],
    [`${job}-gone`, join(dir, 'missing.txt')],
  ]
  for (const [index, [specSha, path]] of rows.entries()) {
    database
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,spec_sha,prompt_bytes,prompt_head,status,
          turn,project_record_id,prompt_path)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex',?,'p',?,1,'p','ok',1,?,?)`,
      )
      .run(
        newRecordId(),
        new Date(Date.now() + index).toISOString(),
        job,
        specSha,
        fixtureProjectRecordId(database),
        path,
      )
  }
  const asked: string[] = []
  const lines: string[] = []
  await typedQuestionBacktest(
    { question: 'spec_unsettled', version: 1, job, limit: 50 },
    { log: (line) => lines.push(line) },
    database,
    async (input) => {
      asked.push(input.subjectRef)
      return { noul: 0 }
    },
  )
  expect(asked).toEqual([`${job}-shared`])
  expect(lines).toContain('asked 1; already answered 0; unreadable 1; errors 0')
})
