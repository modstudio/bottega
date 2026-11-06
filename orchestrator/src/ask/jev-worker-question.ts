// concern: worker-question-jev
/** Adapts stored worker questions to the shared TypeSafe client. */

import type { Database } from 'bun:sqlite'
import { readMachineValue } from '../../../shared/machine-config.ts'
import {
  askTypedQuestionClient,
  type TypedQuestionClientResult,
} from '../../../shared/typed-question/client.ts'
import type { TypedQuestion } from '../../../shared/typed-question/registry.ts'
import type { WorkerQuestion } from '../../../shared/worker-question.ts'
import { db, nowIso } from '../database/db.ts'
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

function pick(result: Extract<TypedQuestionClientResult, { kind: 'answer' }>): unknown {
  if ('choice' in result.answer) return result.answer.choice
  if ('score' in result.answer) return result.answer.score
  return result.answer.noul >= 0.5
}

function probabilities(result: Extract<TypedQuestionClientResult, { kind: 'answer' }>) {
  if ('probabilities' in result.answer) return result.answer.probabilities
  return { yes: result.answer.noul, no: 1 - result.answer.noul }
}

export async function preAnswerWorkerQuestion(input: {
  recordId: string
  runId: string
  question: WorkerQuestion
  client?: typeof askTypedQuestionClient
  database?: Database
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
    database
      .query('UPDATE question SET jev_error=? WHERE record_id=?')
      .run(
        result.kind === 'missing-key' ? 'skipped: TYPESAFE_KEY is not configured' : result.error,
        input.recordId,
      )
    return { applied: false }
  }
  const threshold = Number(readMachineValue('jev.confidence_threshold'))
  const rulings = run.repo
    ? (await resolveProjectAutonomy(run.repo, undefined, undefined, [], {}, undefined, database))
        .rulings.value
    : 'user'
  const decision = routeJevAnswer({
    question: input.question,
    answer: result.answer,
    threshold,
    rulings,
    autoRule: readMachineValue('jev.auto_rule') === 'on',
  })
  database
    .query(
      `UPDATE question SET jev_pick=?,jev_confidence=?,jev_probabilities=?,jev_model=?,jev_input_tokens=? WHERE record_id=?`,
    )
    .run(
      JSON.stringify(pick(result)),
      decision.confidence,
      JSON.stringify(probabilities(result)),
      result.model,
      result.inputTokens,
      input.recordId,
    )
  if (decision.action !== 'apply') return { applied: false }
  const value = decision.value
  database
    .query(
      `UPDATE question SET answer=?,answer_value=?,answered_at=?,answered_by='jev',answered_by_kind='jev',answerer_kind='agent',answer_channel='live',revision=revision+1 WHERE record_id=?`,
    )
    .run(String(value), JSON.stringify(value), nowIso(), input.recordId)
  return { applied: true, value }
}
