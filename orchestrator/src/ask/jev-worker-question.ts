// concern: worker-question-jev
/** Adapts stored worker questions to the shared TypeSafe client. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { readMachineValue } from '../../../shared/machine-config.ts'
import { askTypedQuestionClient } from '../../../shared/typed-question/client.ts'
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
import { resolveProjectAutonomy } from '../workflow/autonomy-scopes.ts'
import { routeJevAnswer } from './jev-routing.ts'
import type { WorkerQuestion } from './worker-question.ts'

type RunContext = { job: string; launch_key: string | null; repo: string | null }

type JevAnswer = Extract<Awaited<ReturnType<typeof askTypedQuestionClient>>, { kind: 'answer' }>

function storeJevError(database: Database, recordId: string, error: string): void {
  writeTransaction(() => {
    database.query('UPDATE question SET jev_error=? WHERE record_id=?').run(error, recordId)
    enqueueQuestionRecord(database, recordId)
  }, database)
}

function storeJevAdvice(
  database: Database,
  recordId: string,
  decision: ReturnType<typeof routeJevAnswer>,
  result: JevAnswer,
  error: string | null,
): void {
  database
    .query(
      `UPDATE question SET jev_pick=?,jev_confidence=?,jev_probabilities=?,jev_model=?,jev_input_tokens=?,jev_error=? WHERE record_id=?`,
    )
    .run(
      decision.pick === null ? null : JSON.stringify(decision.pick),
      decision.confidence,
      decision.probabilities === null ? null : JSON.stringify(decision.probabilities),
      result.model,
      result.inputTokens,
      error,
      recordId,
    )
}

function jevQuestion(id: string, question: WorkerQuestion): TypedQuestion | null {
  const common = { id, version: 1, instructions: question.question, threshold: 0 }
  if (question.kind === 'text') return null
  if (question.kind === 'yesno')
    return {
      ...common,
      type: 'noul',
      criteria: question.criteria
        ? { true: question.criteria.yes, false: question.criteria.no }
        : undefined,
    }
  if (question.kind === 'score') return { ...common, type: 'score', criteria: question.levels }
  return {
    ...common,
    type: 'choice',
    criteria: Object.fromEntries(
      question.options.map((option) => [
        option.name,
        ('criteria' in option ? option.criteria : undefined) ?? option.name,
      ]),
    ),
  }
}

export async function preAnswerWorkerQuestion(input: {
  recordId: string
  runId: string
  question: WorkerQuestion
  client?: typeof askTypedQuestionClient
  database?: Database
  canResume: boolean
  answerChannel: AnswerChannel
  readMachine?: (key: 'jev.confidence_threshold' | 'jev.auto_rule') => string | number
  resolveRulings?: () => Promise<'agent' | 'user'>
}): Promise<{ applied: boolean; value?: string | boolean | number }> {
  const typed = jevQuestion(input.recordId, input.question)
  if (!typed) return { applied: false }
  const database = input.database ?? db()
  const run = database
    .query('SELECT job,launch_key,repo FROM run WHERE record_id=?')
    .get(input.runId) as RunContext | null
  if (!run) return { applied: false }
  const result = await (input.client ?? askTypedQuestionClient)(
    typed,
    `${input.question.why}\ntask: ${run.launch_key ?? 'none'}\njob: ${run.job}`,
  )
  if (result.kind !== 'answer') {
    storeJevError(
      database,
      input.recordId,
      result.kind === 'missing-key' ? 'skipped: TYPESAFE_KEY is not configured' : result.error,
    )
    return { applied: false }
  }
  const readMachine = input.readMachine ?? readMachineValue
  const threshold = Number(readMachine('jev.confidence_threshold'))
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    const raw = readMachine('jev.confidence_threshold')
    const error = `invalid jev.confidence_threshold ${JSON.stringify(raw)}; run ${PLATFORM_SLUG} machine config set jev.confidence_threshold <0-1>`
    const advice = routeJevAnswer({
      question: input.question,
      answer: result.answer,
      threshold: 1,
      rulings: 'user',
      autoRule: false,
      canResume: false,
    })
    writeTransaction(() => {
      storeJevAdvice(database, input.recordId, advice, result, error)
      enqueueQuestionRecord(database, input.recordId)
    }, database)
    return { applied: false }
  }
  const rulings = input.resolveRulings
    ? await input.resolveRulings()
    : run.repo
      ? (await resolveProjectAutonomy(run.repo, undefined, undefined, [], {}, undefined, database))
          .rulings.value
      : 'user'
  const decision = routeJevAnswer({
    question: input.question,
    answer: result.answer,
    threshold,
    rulings,
    autoRule: readMachine('jev.auto_rule') === 'on',
    canResume: input.canResume,
  })
  writeTransaction(() => {
    storeJevAdvice(database, input.recordId, decision, result, null)
    if (decision.action === 'apply') {
      const at = nowIso()
      applyQuestionAnswer({
        database,
        questionId: input.recordId,
        answer: String(decision.value),
        value: decision.value,
        answeredAt: at,
        answeredBy: 'jev',
        answeredByName: null,
        answeredByKind: 'jev',
        answererKind: 'agent',
        channel: input.answerChannel,
        deliveryPendingAt: at,
        delivery: {
          runId: input.runId,
          mode: QUESTION_DELIVERY_MODE_LIVE,
          outcome: QUESTION_DELIVERY_OUTCOME_DELIVERED,
        },
      })
      auditRunMutation(
        runMutationAuthority(database, input.runId),
        'answer',
        'Jev auto-ruling',
        database,
      )
    } else enqueueQuestionRecord(database, input.recordId)
  }, database)
  return decision.action === 'apply' ? { applied: true, value: decision.value } : { applied: false }
}
