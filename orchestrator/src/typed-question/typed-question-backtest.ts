// concern: typed-question-backtest
/** Replays declared typed questions over their declared historical subjects. */

import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import type { TypedQuestion } from '../../../shared/typed-question/registry.ts'
import { renderTypedQuestionBlock } from '../../../shared/typed-question/typed-question-render.ts'
import {
  findingRows,
  selectFindingDuplicatePairs,
} from '../collect/finding-duplicate-suggestions.ts'
import { db } from '../database/db.ts'
import { gitBlobPrefix, gitContext } from '../git/git-environment.ts'
import { projectByName } from '../project/projects.ts'
import { CITED_FILE_BYTES, type CitedFileReader } from './cited-context.ts'
import { FINDING_PAIR_SUBJECT_KIND } from './finding-duplicate-question.ts'
import { specQuestionState, specSubjectKind, specSubjectKinds } from './spec-unsettled-question.ts'
import { TYPED_QUESTION_DECLARATIONS, typedQuestionReport } from './typed-question-report.ts'
import { askTypedQuestion } from './typed-question-service.ts'

/** Asks in flight at once while replaying a question over history. */
const BACKTEST_ASK_CONCURRENCY = 8

type BacktestDeclaration = (typeof TYPED_QUESTION_DECLARATIONS)[number]

type BacktestSubject = {
  subjectKind: string
  subjectRef: string
  state: string | Record<string, unknown>
}

type BacktestOptions = {
  question: string
  version: number
  job?: string
  limit: number
  project?: string
}

/** Up to `limit` distinct unanswered subjects, newest first; what was passed over, and why. */
type SourcedSubjects = {
  subjects: BacktestSubject[]
  alreadyAnswered: number
  unreadable: number
}

type Answered = (subjectKind: string, subjectRef: string) => boolean

type SubjectSource = (
  database: Database,
  declaration: BacktestDeclaration,
  options: BacktestOptions,
  answered: Answered,
) => SourcedSubjects

function answeredFor(database: Database, question: TypedQuestion): Answered {
  const statement = database.query<unknown, [string, number, string, string]>(
    `SELECT 1 FROM typed_question_answer
      WHERE question_id=? AND question_version=? AND subject_kind=? AND subject_ref=?
        AND answer_json IS NOT NULL AND error IS NULL LIMIT 1`,
  )
  return (subjectKind, subjectRef) =>
    Boolean(statement.get(question.id, question.version, subjectKind, subjectRef))
}

/**
 * Reads cited files as they were at the commit each run started from, in that project's checkout.
 * A commit the checkout no longer holds gives no reader, so the run counts unreadable instead of
 * being asked, and recorded, with no context.
 */
function readerAtBase(database: Database): ReaderFor {
  const checkouts = new Map<string, string | null>()
  const commits = new Map<string, boolean>()
  return (row) => {
    if (!row.repo || !row.base_commit) return null
    if (!checkouts.has(row.repo))
      checkouts.set(row.repo, projectByName(row.repo, database)?.path ?? null)
    const checkout = checkouts.get(row.repo)
    if (!checkout) return null
    const commit = row.base_commit
    const key = `${row.repo}\0${commit}`
    if (!commits.has(key))
      commits.set(key, gitContext(checkout, 'rev-parse', '--verify', `${commit}^{commit}`) !== null)
    return commits.get(key)
      ? (path) => gitBlobPrefix(checkout, commit, path, CITED_FILE_BYTES)
      : null
  }
}

type SpecRunRow = {
  job: string
  repo: string | null
  base_commit: string | null
  prompt_path: string
  spec_sha: string
}

/** The cited-file reader for one run's context, or null when it cannot be rebuilt. */
export type ReaderFor = (row: SpecRunRow) => CitedFileReader | null

/** Root runs that carry a caller spec, newest first, narrowed by job and project. */
function specRunRows(database: Database, options: BacktestOptions): Iterable<SpecRunRow> {
  const clauses = [
    'parent_run_record_id IS NULL',
    'prompt_path IS NOT NULL',
    'spec_sha IS NOT NULL',
  ]
  const parameters: string[] = []
  if (options.job) {
    clauses.push('job=?')
    parameters.push(options.job)
  }
  if (options.project) {
    clauses.push('repo=?')
    parameters.push(options.project)
  }
  return database
    .query<SpecRunRow, string[]>(
      `SELECT job,repo,base_commit,prompt_path,spec_sha FROM run WHERE ${clauses.join(' AND ')}
       ORDER BY started_at DESC`,
    )
    .iterate(...parameters)
}

/** The state live asking would use for this run's spec, or null when it cannot be rebuilt. */
export function specState(
  row: SpecRunRow,
  declaration: BacktestDeclaration,
  readerFor: ReaderFor,
): BacktestSubject['state'] | null {
  if (!existsSync(row.prompt_path)) return null
  const spec = readFileSync(row.prompt_path, 'utf8')
  if (!('contextBuilder' in declaration)) return spec
  const read = readerFor(row)
  return read ? specQuestionState(declaration, spec, read) : null
}

const specRunSubjects: SubjectSource = (database, declaration, options, answered) => {
  const readerFor = readerAtBase(database)
  const seen = new Set<string>()
  const subjects: BacktestSubject[] = []
  let alreadyAnswered = 0
  let unreadable = 0
  for (const row of specRunRows(database, options)) {
    if (subjects.length >= options.limit) break
    const subjectKind = specSubjectKind(row.job)
    const key = `${subjectKind}\0${row.spec_sha}`
    if (seen.has(key)) continue
    seen.add(key)
    if (specSubjectKinds(row.job).some((kind) => answered(kind, row.spec_sha))) {
      alreadyAnswered += 1
      continue
    }
    const state = specState(row, declaration, readerFor)
    if (state === null) unreadable += 1
    else subjects.push({ subjectKind, subjectRef: row.spec_sha, state })
  }
  return { subjects, alreadyAnswered, unreadable }
}

export const findingPairSubjects: SubjectSource = (database, _declaration, options, answered) => {
  const runs = database
    .query<{ id: string }, string[]>(
      `SELECT DISTINCT lens.run_record_id AS id,run.number
         FROM review_lens lens JOIN run ON run.record_id=lens.run_record_id
        ${options.project ? 'WHERE run.repo=?' : ''}
        ORDER BY run.number DESC`,
    )
    .iterate(...(options.project ? [options.project] : []))
  const seen = new Set<string>()
  const subjects: BacktestSubject[] = []
  let alreadyAnswered = 0
  for (const run of runs) {
    for (const pair of selectFindingDuplicatePairs(
      run.id,
      findingRows(database, run.id),
      new Map(),
    )) {
      if (subjects.length >= options.limit) return { subjects, alreadyAnswered, unreadable: 0 }
      if (seen.has(pair.subjectRef)) continue
      seen.add(pair.subjectRef)
      if (answered(FINDING_PAIR_SUBJECT_KIND, pair.subjectRef)) {
        alreadyAnswered += 1
        continue
      }
      subjects.push({
        subjectKind: FINDING_PAIR_SUBJECT_KIND,
        subjectRef: pair.subjectRef,
        state: pair.state,
      })
    }
  }
  return { subjects, alreadyAnswered, unreadable: 0 }
}

const SOURCES: Record<BacktestDeclaration['backtest'], SubjectSource> = {
  'spec-runs': specRunSubjects,
  'finding-pairs': findingPairSubjects,
}

/** Names what is declared: the versions of a known id, or the ids when the id is unknown. */
function undeclaredRefusal(question: string, version: number): string {
  const versions = TYPED_QUESTION_DECLARATIONS.filter((candidate) => candidate.id === question).map(
    (candidate) => `v${candidate.version}`,
  )
  if (versions.length)
    return `typed question ${question} has no v${version}; declared versions: ${versions.join(', ')}`
  const ids = [...new Set(TYPED_QUESTION_DECLARATIONS.map((candidate) => candidate.id))]
  return `undeclared typed question ${JSON.stringify(question)}; declared ids: ${ids.join(', ')}`
}

export async function typedQuestionBacktest(
  options: BacktestOptions,
  presentation: { log(value: string): void },
  database: Database = db(true),
  ask: typeof askTypedQuestion = askTypedQuestion,
): Promise<void> {
  const declaration = TYPED_QUESTION_DECLARATIONS.find(
    (candidate) => candidate.id === options.question && candidate.version === options.version,
  )
  if (!declaration) throw new Error(undeclaredRefusal(options.question, options.version))
  const sourced = SOURCES[declaration.backtest](
    database,
    declaration,
    options,
    answeredFor(database, declaration),
  )
  const pending = sourced.subjects
  let next = 0
  let errors = 0
  await Promise.all(
    Array.from({ length: Math.min(BACKTEST_ASK_CONCURRENCY, pending.length) }, async () => {
      for (;;) {
        const subject = pending[next++]
        if (!subject) return
        const answer = await ask({ question: declaration, ...subject })
        if (!answer) errors += 1
      }
    }),
  )
  presentation.log(
    `asked ${pending.length}; already answered ${sourced.alreadyAnswered}; unreadable ${sourced.unreadable}; errors ${errors}`,
  )
  const blocks = typedQuestionReport(
    { question: declaration.id, job: options.job },
    database,
  ).filter((candidate) => candidate.questionVersion === declaration.version)
  for (const block of blocks) renderTypedQuestionBlock(block, presentation)
}

export function backtestLimit(value: string | undefined): number {
  const limit = Number(value ?? 50)
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('--limit must be a positive integer')
  return limit
}
