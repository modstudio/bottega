// concern: worker-question-jev
/** Adapts stored worker questions to one shared TypeSafe request. */
import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { readMachineValue } from '../../../shared/machine-config.ts'
import {
  askTypedQuestionsClient,
  type TypedQuestionAnswer,
} from '../../../shared/typed-question/client.ts'
import type { TypedQuestion } from '../../../shared/typed-question/registry.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { applyQuestionAnswer } from '../run/question-answer.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import {
  type AnswerChannel,
  QUESTION_DELIVERY_MODE_LIVE,
  QUESTION_DELIVERY_OUTCOME_DELIVERED,
} from '../run/question-vocabulary.ts'
import { auditRunMutation, runMutationAuthority } from '../run/run-authority.ts'
import { runRootRecord } from '../run/run-root-record.ts'
import { resolveProjectAutonomy } from '../workflow/autonomy-scopes.ts'
import { combineJevChoice } from './jev-choice-combination.ts'
import { jevThresholds, routeJevAnswer } from './jev-routing.ts'
import type { WorkerQuestion } from './worker-question.ts'

const JEV_WORKER_QUESTION_VERSION = 2
const JEV_STATE_TEXT_LIMIT = 48_000
const CUT_MARKER = '\n[Content cut at JEV_STATE_TEXT_LIMIT.]'
type RunContext = {
  job: string
  launch_key: string | null
  repo: string | null
  prompt_path: string | null
  parent_run_record_id: string | null
  root_prompt_path: string | null
}
type BatchAnswer = Extract<Awaited<ReturnType<typeof askTypedQuestionsClient>>, { kind: 'answer' }>
type PreAnswerQuestion = {
  recordId: string
  question: WorkerQuestion
}
type PreAnswerContext = {
  runId: string
  database?: Database
  canResume: boolean
  answerChannel: AnswerChannel
  readMachine?: (
    key: 'jev.confidence_threshold' | 'jev.fit_threshold' | 'jev.auto_rule',
  ) => string | number
  resolveRulings?: () => Promise<'agent' | 'user'>
}
type PreAnswerInput = PreAnswerContext &
  PreAnswerQuestion & { client?: typeof askTypedQuestionsClient }
type BatchInput = PreAnswerContext & {
  questions: readonly PreAnswerQuestion[]
  client?: typeof askTypedQuestionsClient
}
type PreAnswerResult = { applied: boolean; value?: string | boolean | number }

function cappedFile(path: string | null): string | undefined {
  if (!path) return undefined
  try {
    const content = readFileSync(path, 'utf8')
    return content.length <= JEV_STATE_TEXT_LIMIT
      ? content
      : `${content.slice(0, JEV_STATE_TEXT_LIMIT)}${CUT_MARKER}`
  } catch {
    return undefined
  }
}
function storeJevError(database: Database, recordId: string, error: string): void {
  writeTransaction(() => {
    database
      .query('UPDATE question SET jev_question_version=?,jev_error=? WHERE record_id=?')
      .run(JEV_WORKER_QUESTION_VERSION, error, recordId)
    enqueueQuestionRecord(database, recordId)
  }, database)
}
function choiceAnswerIds(recordId: string) {
  return {
    forward: `${recordId}:forward`,
    reversed: `${recordId}:reversed`,
    fits: `${recordId}:fits`,
  }
}
function workerWhyKey(number: number): string {
  return String(number)
}
function questionsFor(recordId: string, number: number, question: WorkerQuestion): TypedQuestion[] {
  if (question.kind === 'text') return []
  const whyKey = workerWhyKey(number)
  const instructions = `${question.question}\nUse \`spec\`, \`turn\` when present (it is the later instruction and overrides \`spec\`), and \`worker.why[${JSON.stringify(whyKey)}]\`.`
  const common = { version: JEV_WORKER_QUESTION_VERSION, instructions, threshold: 0 }
  if (question.kind === 'yesno')
    return [
      {
        ...common,
        id: recordId,
        type: 'noul',
        criteria: question.criteria
          ? { true: question.criteria.yes, false: question.criteria.no }
          : undefined,
      },
    ]
  if (question.kind === 'score')
    return [{ ...common, id: recordId, type: 'score', criteria: question.levels }]
  const criteria = Object.fromEntries(
    question.options.map((option) => [
      option.name,
      ('criteria' in option ? option.criteria : undefined) ?? option.name,
    ]),
  )
  const ids = choiceAnswerIds(recordId)
  return [
    { ...common, id: ids.forward, type: 'choice', criteria },
    {
      ...common,
      id: ids.reversed,
      type: 'choice',
      criteria: Object.fromEntries(Object.entries(criteria).reverse()),
    },
    {
      ...common,
      id: ids.fits,
      type: 'noul',
      criteria: {
        true: 'One listed option describes what the worker should do.',
        false: 'None fits and the architect must give different direction.',
      },
    },
  ]
}
function combinedAnswer(
  recordId: string,
  question: WorkerQuestion,
  answers: Record<string, TypedQuestionAnswer>,
) {
  if (question.kind !== 'choice')
    return {
      answer: answers[recordId] ?? null,
      fits: null,
      orderFlipped: null,
      bothOrdersAnswered: true,
    }
  const ids = choiceAnswerIds(recordId)
  return combineJevChoice({
    options: question.options.map(({ name }) => name),
    forward: answers[ids.forward],
    reversed: answers[ids.reversed],
    fits: answers[ids.fits],
  })
}
function expectedAnswerIds(recordId: string, question: WorkerQuestion): string[] {
  if (question.kind !== 'choice') return [recordId]
  const ids = choiceAnswerIds(recordId)
  return [ids.forward, ids.reversed, ids.fits]
}
function storeAdvice(
  database: Database,
  input: PreAnswerInput,
  decision: ReturnType<typeof routeJevAnswer>,
  result: BatchAnswer,
  inputTokens: number,
  fits: number | null,
  orderFlipped: boolean | null,
  error: string | null,
): void {
  database
    .query(
      `UPDATE question SET jev_question_version=?,jev_pick=?,jev_confidence=?,jev_probabilities=?,jev_model=?,jev_input_tokens=?,jev_fits=?,jev_order_flipped=?,jev_error=? WHERE record_id=?`,
    )
    .run(
      JEV_WORKER_QUESTION_VERSION,
      decision.pick === null ? null : JSON.stringify(decision.pick),
      decision.confidence,
      decision.probabilities === null ? null : JSON.stringify(decision.probabilities),
      result.model,
      inputTokens,
      fits,
      orderFlipped === null ? null : Number(orderFlipped),
      error,
      input.recordId,
    )
}
async function resolvedRulings(
  input: PreAnswerInput,
  run: RunContext,
  database: Database,
  configError: string | null,
): Promise<'agent' | 'user'> {
  if (configError) return 'user'
  if (input.resolveRulings) return input.resolveRulings()
  if (!run.repo) return 'user'
  return (await resolveProjectAutonomy(run.repo, undefined, undefined, [], {}, undefined, database))
    .rulings.value
}
async function routeAndStore(
  input: PreAnswerInput,
  run: RunContext,
  result: BatchAnswer,
  inputTokens: number,
): Promise<PreAnswerResult> {
  const database = input.database ?? db()
  const combined = combinedAnswer(input.recordId, input.question, result.answers)
  const readMachine = input.readMachine ?? readMachineValue
  const thresholds = jevThresholds(readMachine)
  const configError = thresholds.ok ? null : thresholds.error
  const missingIds = expectedAnswerIds(input.recordId, input.question).filter(
    (id) => result.answers[id] === undefined,
  )
  const answerError = missingIds.length
    ? `Jev response omitted expected answer ids: ${missingIds.join(', ')}`
    : null
  const jevError = [configError, answerError].filter(Boolean).join('; ') || null
  try {
    const rulings = await resolvedRulings(input, run, database, jevError)
    const decision = routeJevAnswer({
      question: input.question,
      answer: combined.answer,
      threshold: jevError || !thresholds.ok ? 1 : thresholds.threshold,
      fitThreshold: jevError || !thresholds.ok ? 1 : thresholds.fitThreshold,
      fits: combined.fits,
      orderFlipped: combined.orderFlipped,
      bothOrdersAnswered: combined.bothOrdersAnswered,
      rulings,
      autoRule: !jevError && readMachine('jev.auto_rule') === 'on',
      canResume: input.canResume,
    })
    let applied = false
    writeTransaction(() => {
      storeAdvice(
        database,
        input,
        decision,
        result,
        inputTokens,
        combined.fits,
        input.question.kind === 'choice' ? combined.orderFlipped : null,
        jevError,
      )
      if (decision.action === 'apply') {
        applied = applyQuestionAnswer({
          database,
          questionId: input.recordId,
          answer: String(decision.value),
          value: decision.value,
          answeredAt: nowIso(),
          answeredBy: 'jev',
          answeredByName: null,
          answeredByKind: 'jev',
          answererKind: 'agent',
          channel: input.answerChannel,
          deliveryPendingAt: null,
          delivery: {
            runId: input.runId,
            mode: QUESTION_DELIVERY_MODE_LIVE,
            outcome: QUESTION_DELIVERY_OUTCOME_DELIVERED,
          },
        })
        if (applied)
          auditRunMutation(
            runMutationAuthority(database, input.runId),
            'answer',
            'Jev auto-ruling',
            database,
          )
      } else enqueueQuestionRecord(database, input.recordId)
    }, database)
    if (decision.action === 'apply' && !applied) {
      storeJevError(
        database,
        input.recordId,
        'question was answered or closed while Jev was deciding',
      )
      return { applied: false }
    }
    return decision.action === 'apply'
      ? { applied: true, value: decision.value }
      : { applied: false }
  } catch (error) {
    storeJevError(database, input.recordId, String(error))
    return { applied: false }
  }
}
export async function preAnswerWorkerQuestions(input: BatchInput): Promise<PreAnswerResult[]> {
  if (!input.questions.length) return []
  const results = input.questions.map((): PreAnswerResult => ({ applied: false }))
  const eligible = input.questions
    .map((question, index) => ({ question, index }))
    .filter(({ question }) => question.question.kind !== 'text')
  if (!eligible.length) return results
  const database = input.database ?? db()
  const storeBatchError = (error: string) => {
    for (const { question } of eligible) {
      try {
        storeJevError(database, question.recordId, error)
      } catch {
        // A missing question row cannot be annotated, but must not block escalation.
      }
    }
  }
  try {
    const current = database
      .query<Omit<RunContext, 'root_prompt_path'>, [string]>(
        `SELECT job,launch_key,repo,prompt_path,parent_run_record_id FROM run WHERE record_id=?`,
      )
      .get(input.runId)
    if (!current) {
      storeBatchError(`run ${input.runId} was not found while preparing Jev advice`)
      return results
    }
    const root = runRootRecord(input.runId, database)
    const rootPrompt = root
      ? (database
          .query<{ prompt_path: string | null }, [string]>(
            'SELECT prompt_path FROM run WHERE record_id=?',
          )
          .get(root.rootRunId)?.prompt_path ?? null)
      : null
    const run: RunContext = { ...current, root_prompt_path: rootPrompt }
    const numbered = eligible.map(({ question, index }) => {
      const row = database
        .query('SELECT number FROM question WHERE record_id=?')
        .get(question.recordId) as { number: number } | null
      if (!row) throw new Error(`question ${question.recordId} was not found`)
      return { question, index, number: row.number }
    })
    const state: Record<string, unknown> = {
      worker: {
        why: Object.fromEntries(
          numbered.map(({ question, number }) => [workerWhyKey(number), question.question.why]),
        ),
      },
      run: { task: run.launch_key ?? 'none', job: run.job },
    }
    const spec = cappedFile(run.root_prompt_path)
    const turn = run.parent_run_record_id ? cappedFile(run.prompt_path) : undefined
    if (spec !== undefined) state.spec = spec
    if (turn !== undefined) state.turn = turn
    const questions = numbered.flatMap(({ question, number }) =>
      questionsFor(question.recordId, number, question.question),
    )
    const response = await (input.client ?? askTypedQuestionsClient)(questions, state)
    if (response.kind !== 'answer') {
      storeBatchError(
        response.kind === 'missing-key'
          ? `skipped: typesafe/api-key credential is not configured; run ${PLATFORM_SLUG} credential set typesafe/api-key`
          : response.error,
      )
      return results
    }
    const share = Math.floor(response.inputTokens / eligible.length)
    const remainder = response.inputTokens % eligible.length
    const routed = await Promise.all(
      numbered.map(({ question }, index) =>
        routeAndStore(
          { ...input, ...question },
          run,
          response,
          share + (index === 0 ? remainder : 0),
        ),
      ),
    )
    numbered.forEach(({ index }, routedIndex) => {
      results[index] = routed[routedIndex]!
    })
    return results
  } catch (error) {
    storeBatchError(error instanceof Error ? error.message : String(error))
    return results
  }
}
export async function preAnswerWorkerQuestion(input: PreAnswerInput): Promise<PreAnswerResult> {
  const { recordId, question, ...context } = input
  return (await preAnswerWorkerQuestions({ ...context, questions: [{ recordId, question }] }))[0]!
}
