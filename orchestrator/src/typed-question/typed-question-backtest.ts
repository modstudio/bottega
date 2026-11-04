// concern: typed-question-backtest
/** Replays declared typed questions over their declared historical subjects. */

import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import type { TypedQuestion } from '../../../shared/typed-question/registry.ts'
import { renderTypedQuestionBlock } from '../../../shared/typed-question/typed-question-render.ts'
import {
  FINDING_DUPLICATE_ASK_CONCURRENCY,
  findingRows,
  selectFindingDuplicatePairs,
} from '../collect/finding-duplicate-suggestions.ts'
import { db } from '../database/db.ts'
import { gitContext } from '../git/git-environment.ts'
import { projectByName } from '../project/projects.ts'
import { type CitedFileReader, checkoutFileReader } from './cited-context.ts'
import { TYPED_QUESTION_DECLARATIONS, typedQuestionReport } from './typed-question-report.ts'
import { askTypedQuestion } from './typed-question-service.ts'

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

/** Up to `limit` unanswered subjects, newest first, and how many answered ones were passed over. */
type SourcedSubjects = { subjects: BacktestSubject[]; alreadyAnswered: number; commits: string[] }

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

type Checkout = { read: CitedFileReader; commit: string | null }

/** Reads cited files from each project's main checkout, resolving it and its commit once. */
function checkoutContext(database: Database): (repo: string) => Checkout | null {
  const checkouts = new Map<string, Checkout | null>()
  return (repo) => {
    if (!checkouts.has(repo)) {
      const project = projectByName(repo, database)
      checkouts.set(
        repo,
        project
          ? {
              read: checkoutFileReader(project.path),
              commit: gitContext(project.path, 'rev-parse', '--verify', 'HEAD^{commit}'),
            }
          : null,
      )
    }
    return checkouts.get(repo) ?? null
  }
}

export const specRunSubjects: SubjectSource = (database, declaration, options, answered) => {
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
  const rows = database
    .query<{ job: string; repo: string | null; prompt_path: string; spec_sha: string }, string[]>(
      `SELECT job,repo,prompt_path,spec_sha FROM run WHERE ${clauses.join(' AND ')}
       ORDER BY started_at DESC`,
    )
    .iterate(...parameters)
  const builder = 'contextBuilder' in declaration ? declaration.contextBuilder : null
  const checkout = checkoutContext(database)
  const commits = new Set<string>()
  const subjects: BacktestSubject[] = []
  let alreadyAnswered = 0
  for (const row of rows) {
    if (subjects.length >= options.limit) break
    const subjectKind = `spec:${row.job}`
    if (answered(subjectKind, row.spec_sha)) {
      alreadyAnswered += 1
      continue
    }
    if (!existsSync(row.prompt_path)) continue
    const spec = readFileSync(row.prompt_path, 'utf8')
    let state: BacktestSubject['state'] = spec
    if (builder) {
      const context = row.repo ? checkout(row.repo) : null
      if (!context) continue
      if (context.commit) commits.add(`${row.repo}:${context.commit}`)
      state = builder(spec, context.read)
    }
    subjects.push({ subjectKind, subjectRef: row.spec_sha, state })
  }
  return { subjects, alreadyAnswered, commits: [...commits] }
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
      if (subjects.length >= options.limit) return { subjects, alreadyAnswered, commits: [] }
      if (seen.has(pair.subjectRef)) continue
      seen.add(pair.subjectRef)
      if (answered('finding-pair', pair.subjectRef)) {
        alreadyAnswered += 1
        continue
      }
      subjects.push({ subjectKind: 'finding-pair', subjectRef: pair.subjectRef, state: pair.state })
    }
  }
  return { subjects, alreadyAnswered, commits: [] }
}

const SOURCES: Record<BacktestDeclaration['backtest'], SubjectSource> = {
  'spec-runs': specRunSubjects,
  'finding-pairs': findingPairSubjects,
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
  if (!declaration) {
    const ids = [...new Set(TYPED_QUESTION_DECLARATIONS.map((candidate) => candidate.id))]
    throw new Error(
      `undeclared typed question ${JSON.stringify(options.question)} v${options.version}; declared ids: ${ids.join(', ')}`,
    )
  }
  const sourced = SOURCES[declaration.backtest](
    database,
    declaration,
    options,
    answeredFor(database, declaration),
  )
  for (const commit of sourced.commits) presentation.log(`context commit ${commit}`)
  const pending = sourced.subjects
  let next = 0
  let errors = 0
  await Promise.all(
    Array.from(
      { length: Math.min(FINDING_DUPLICATE_ASK_CONCURRENCY, pending.length) },
      async () => {
        for (;;) {
          const subject = pending[next++]
          if (!subject) return
          const answer = await ask({ question: declaration, ...subject })
          if (!answer) errors += 1
        }
      },
    ),
  )
  presentation.log(
    `asked ${pending.length}; already answered ${sourced.alreadyAnswered}; errors ${errors}`,
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
