// concern: worker-question-jev
/** Adapts stored worker questions to the shared TypeSafe client. */

import type { Database } from 'bun:sqlite'
import { readMachineValue } from '../../../shared/machine-config.ts'
import {
  askTypedQuestionClient,
} from '../../../shared/typed-question/client.ts'
import type { TypedQuestion } from '../../../shared/typed-question/registry.ts'
import type { WorkerQuestion } from './worker-question.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { applyQuestionAnswer } from '../run/question-answer.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import {
  type AnswerChannel,
  QUESTION_DELIVERY_MODE_LIVE,
  QUESTION_DELIVERY_OUTCOME_DELIVERED,
} from '../run/question-vocabulary.ts'
import { resolveProjectAutonomy } from '../workflow/autonomy-scopes.ts'
import { routeJevAnswer } from './jev-routing.ts'

type RunContext = { job: string; launch_key: string | null; repo: string | null }

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
      question.options.map(({ name, criteria }) => [name, criteria ?? name]),
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
  readMachine?: typeof readMachineValue
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
    writeTransaction(() => {
      database
        .query('UPDATE question SET jev_error=? WHERE record_id=?')
        .run(
          result.kind === 'missing-key'
            ? 'skipped: TYPESAFE_API_KEY is not configured'
            : result.error,
          input.recordId,
        )
      enqueueQuestionRecord(database, input.recordId)
    }, database)
    return { applied: false }
  }
  const readMachine = input.readMachine ?? readMachineValue
  const threshold = Number(readMachine('jev.confidence_threshold'))
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    const raw = readMachine('jev.confidence_threshold')
    const error = `invalid jev.confidence_threshold ${JSON.stringify(raw)}; run bottega machine config set jev.confidence_threshold <0-1>`
    writeTransaction(() => {
      database.query('UPDATE question SET jev_error=? WHERE record_id=?').run(error, input.recordId)
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
    database
      .query(
        `UPDATE question SET jev_pick=?,jev_confidence=?,jev_probabilities=?,jev_model=?,jev_input_tokens=?,jev_error=NULL WHERE record_id=?`,
      )
      .run(
        decision.pick === null ? null : JSON.stringify(decision.pick),
        decision.confidence,
        decision.probabilities === null ? null : JSON.stringify(decision.probabilities),
        result.model,
        result.inputTokens,
        input.recordId,
      )
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
    } else enqueueQuestionRecord(database, input.recordId)
  }, database)
  return decision.action === 'apply'
    ? { applied: true, value: decision.value }
    : { applied: false }
}
