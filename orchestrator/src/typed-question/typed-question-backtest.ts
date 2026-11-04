// concern: typed-question-backtest
/** Replays declared typed questions over their declared historical subjects. */

import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
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
import { TYPED_QUESTION_DECLARATIONS, typedQuestionReport } from './typed-question-report.ts'
import { askTypedQuestion } from './typed-question-service.ts'

type BacktestDeclaration = TypedQuestion & {
  backtestSource(sources: {
    specRuns(): Promise<unknown>
    findingPairs(): Promise<unknown>
  }): Promise<unknown>
  contextBuilder?: (
    spec: string,
    readFile: (path: string) => string | null,
  ) => Record<string, unknown>
}

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

function projectReader(path: string): (relativePath: string) => string | null {
  return (relativePath) => {
    try {
      const root = realpathSync(path)
      const candidate = realpathSync(resolve(root, relativePath))
      const fromRoot = relative(root, candidate)
      if (
        fromRoot.startsWith('..') ||
        resolve(root, fromRoot) !== candidate ||
        !statSync(candidate).isFile()
      )
        return null
      return readFileSync(candidate, 'utf8')
    } catch {
      return null
    }
  }
}

function hasAnswer(database: Database, question: TypedQuestion, subject: BacktestSubject): boolean {
  return Boolean(
    database
      .query(
        `SELECT 1 FROM typed_question_answer
          WHERE question_id=? AND question_version=? AND subject_kind=? AND subject_ref=?
            AND answer_json IS NOT NULL AND error IS NULL LIMIT 1`,
      )
      .get(question.id, question.version, subject.subjectKind, subject.subjectRef),
  )
}

function specSubjects(
  database: Database,
  declaration: BacktestDeclaration,
  options: BacktestOptions,
): { subjects: BacktestSubject[]; commits: string[] } {
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
    .query(
      `SELECT job,repo,prompt_path,spec_sha FROM run WHERE ${clauses.join(' AND ')}
       ORDER BY started_at DESC`,
    )
    .all(...parameters) as {
    job: string
    repo: string | null
    prompt_path: string
    spec_sha: string
  }[]
  const commits = new Set<string>()
  const subjects = rows.flatMap((row): BacktestSubject[] => {
    if (!existsSync(row.prompt_path)) return []
    const spec = readFileSync(row.prompt_path, 'utf8')
    let state: BacktestSubject['state'] = spec
    if (declaration.contextBuilder) {
      if (!row.repo) return []
      const project = projectByName(row.repo, database)
      if (!project) return []
      const commit = gitContext(project.path, 'rev-parse', '--verify', 'HEAD^{commit}')
      if (commit) commits.add(`${row.repo}:${commit}`)
      state = declaration.contextBuilder(spec, projectReader(project.path))
    }
    return [{ subjectKind: `spec:${row.job}`, subjectRef: row.spec_sha, state }]
  })
  return { subjects, commits: [...commits] }
}

export function findingBacktestSubjects(database: Database): BacktestSubject[] {
  const runs = database
    .query(
      `SELECT DISTINCT lens.run_record_id AS id,run.number
         FROM review_lens lens JOIN run ON run.record_id=lens.run_record_id
        ORDER BY run.number DESC`,
    )
    .all() as { id: string }[]
  const seen = new Set<string>()
  const subjects: BacktestSubject[] = []
  for (const run of runs) {
    for (const pair of selectFindingDuplicatePairs(
      run.id,
      findingRows(database, run.id),
      new Map(),
    )) {
      const key = `${pair.subjectRef}\0${pair.stateSha}`
      if (seen.has(key)) continue
      seen.add(key)
      subjects.push({ subjectKind: 'finding-pair', subjectRef: pair.subjectRef, state: pair.state })
    }
  }
  return subjects
}

export async function typedQuestionBacktest(
  options: BacktestOptions,
  presentation: { log(value: string): void },
  database: Database = db(true),
  ask: typeof askTypedQuestion = askTypedQuestion,
): Promise<void> {
  const declarations = TYPED_QUESTION_DECLARATIONS as readonly BacktestDeclaration[]
  const declaration = declarations.find(
    (candidate) => candidate.id === options.question && candidate.version === options.version,
  )
  if (!declaration) {
    const ids = [...new Set(declarations.map((candidate) => candidate.id))].join(', ')
    throw new Error(
      `undeclared typed question ${JSON.stringify(options.question)}; declared ids: ${ids}`,
    )
  }
  const loaded = (await declaration.backtestSource({
    specRuns: async () => specSubjects(database, declaration, options),
    findingPairs: async () => ({ subjects: findingBacktestSubjects(database), commits: [] }),
  })) as { subjects: BacktestSubject[]; commits: string[] }
  for (const commit of loaded.commits) presentation.log(`context commit ${commit}`)
  const candidates = loaded.subjects.slice(0, options.limit)
  const unanswered = candidates.filter((subject) => !hasAnswer(database, declaration, subject))
  let next = 0
  let errors = 0
  await Promise.all(
    Array.from(
      { length: Math.min(FINDING_DUPLICATE_ASK_CONCURRENCY, unanswered.length) },
      async () => {
        for (;;) {
          const subject = unanswered[next++]
          if (!subject) return
          const answer = await ask({ question: declaration, ...subject })
          if (!answer) errors += 1
        }
      },
    ),
  )
  presentation.log(
    `asked ${unanswered.length}; already answered ${candidates.length - unanswered.length}; errors ${errors}`,
  )
  const blocks = typedQuestionReport(
    { question: declaration.id, job: options.job },
    database,
  ).filter((candidate) => candidate.questionVersion === declaration.version)
  for (const block of blocks) {
    renderTypedQuestionBlock(block, presentation)
  }
}

export function backtestLimit(value: string | undefined): number {
  const limit = Number(value ?? 50)
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('--limit must be a positive integer')
  return limit
}
