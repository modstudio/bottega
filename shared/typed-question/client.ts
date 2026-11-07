import { hostedApiFetch } from '../bounded-fetch.ts'
// concern: typed-question-client
/** Calls the TypeSafe typed-question API without exposing its credential. */

import { readEnvValuesWithHosted } from '../env-source.ts'
import type { TypedQuestion } from './registry.ts'

const TYPED_QUESTION_TIMEOUT_MS = 5_000
const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const TYPESAFE_KEY = 'TYPESAFE_KEY'

type NoulAnswer = { noul: number }
type ChoiceAnswer = {
  choice: string
  confidence: number
  probabilities: Record<string, number>
}
type ScoreAnswer = {
  score: number
  confidence: number
  legend: Record<string, string>
  probabilities: Record<string, number>
}
export type TypedQuestionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

/** A recorded answer's noul probability; a choice answer or unreadable JSON carries none. */
export function noulProbability(answerJson: string): number | null {
  let answer: TypedQuestionAnswer
  try {
    answer = JSON.parse(answerJson) as TypedQuestionAnswer
  } catch {
    return null
  }
  return 'noul' in answer && typeof answer.noul === 'number' ? answer.noul : null
}

export type TypedQuestionClientResult =
  | { kind: 'missing-key' }
  | {
      kind: 'answer'
      answer: TypedQuestionAnswer
      model: string
      inputTokens: number
      latencyMs: number
    }
  | { kind: 'error'; error: string; latencyMs: number }

type TypedQuestionClientDependencies = {
  resolve: typeof readEnvValuesWithHosted
  fetch(input: string, init: RequestInit): Promise<Response>
}

const clientDependencies: TypedQuestionClientDependencies = {
  resolve: readEnvValuesWithHosted,
  fetch: (input, init) => hostedApiFetch(input, init),
}

function finiteProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function questionBody(question: TypedQuestion): Record<string, unknown> {
  return {
    type: question.type,
    instructions: question.instructions,
    ...('criteria' in question && question.criteria ? { criteria: question.criteria } : {}),
  }
}

function parseAnswer(
  question: TypedQuestion,
  body: unknown,
): {
  answer: TypedQuestionAnswer
  model: string
  inputTokens: number
} | null {
  if (!body || typeof body !== 'object') return null
  const response = body as Record<string, unknown>
  const answers = response.answers
  const usage = response.usage
  if (
    typeof response.model !== 'string' ||
    !answers ||
    typeof answers !== 'object' ||
    !usage ||
    typeof usage !== 'object'
  )
    return null
  const inputTokens = (usage as Record<string, unknown>).input_tokens
  if (!Number.isInteger(inputTokens) || (inputTokens as number) < 0) return null
  const raw = (answers as Record<string, unknown>)[question.id]
  if (!raw || typeof raw !== 'object') return null
  const values = raw as Record<string, unknown>
  if (question.type === 'noul') {
    if (!finiteProbability(values.noul)) return null
    return {
      answer: { noul: values.noul },
      model: response.model,
      inputTokens: inputTokens as number,
    }
  }
  if (question.type === 'score') {
    const levelKeys = question.criteria.map((_, index) => String(index))
    if (
      typeof values.score !== 'number' ||
      !Number.isFinite(values.score) ||
      (values.score as number) < 0 ||
      (values.score as number) > question.criteria.length - 1 ||
      !finiteProbability(values.confidence) ||
      !values.legend ||
      typeof values.legend !== 'object' ||
      !values.probabilities ||
      typeof values.probabilities !== 'object'
    )
      return null
    const legend = values.legend as Record<string, unknown>
    const probabilities = values.probabilities as Record<string, unknown>
    if (
      levelKeys.some(
        (key) => typeof legend[key] !== 'string' || !finiteProbability(probabilities[key]),
      ) ||
      Object.keys(legend).some((key) => !levelKeys.includes(key)) ||
      Object.keys(probabilities).some((key) => !levelKeys.includes(key))
    )
      return null
    return {
      answer: {
        score: values.score as number,
        confidence: values.confidence,
        legend: legend as Record<string, string>,
        probabilities: probabilities as Record<string, number>,
      },
      model: response.model,
      inputTokens: inputTokens as number,
    }
  }
  if (
    typeof values.choice !== 'string' ||
    !(values.choice in question.criteria) ||
    !finiteProbability(values.confidence) ||
    !values.probabilities ||
    typeof values.probabilities !== 'object'
  )
    return null
  const probabilities = values.probabilities as Record<string, unknown>
  if (
    Object.keys(question.criteria).some((label) => !finiteProbability(probabilities[label])) ||
    Object.keys(probabilities).some((label) => !(label in question.criteria))
  )
    return null
  return {
    answer: {
      choice: values.choice,
      confidence: values.confidence,
      probabilities: probabilities as Record<string, number>,
    },
    model: response.model,
    inputTokens: inputTokens as number,
  }
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started))
}

async function resolveKey(
  dependencies: TypedQuestionClientDependencies,
): Promise<{ kind: 'key'; value: string } | { kind: 'missing-key' } | { kind: 'error' }> {
  try {
    const key = (await dependencies.resolve([TYPESAFE_KEY]))[TYPESAFE_KEY]
    return key ? { kind: 'key', value: key } : { kind: 'missing-key' }
  } catch {
    return { kind: 'error' }
  }
}

async function sendRequest(
  key: string,
  body: string,
  fetch: TypedQuestionClientDependencies['fetch'],
): Promise<Response | 'timeout' | 'transport'> {
  try {
    return await fetch(TYPESAFE_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(TYPED_QUESTION_TIMEOUT_MS),
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'transport'
  }
}

async function parsedAnswer(question: TypedQuestion, response: Response) {
  try {
    return parseAnswer(question, await response.json())
  } catch {
    return null
  }
}

/** Resolve the key at call time, make one bounded request, and retry only rate backoff statuses. */
export async function askTypedQuestionClient(
  question: TypedQuestion,
  state: string | Record<string, unknown>,
  dependencies: TypedQuestionClientDependencies = clientDependencies,
): Promise<TypedQuestionClientResult> {
  const started = performance.now()
  const resolved = await resolveKey(dependencies)
  if (resolved.kind === 'error') {
    return { kind: 'error', error: 'key_resolution', latencyMs: elapsed(started) }
  }
  if (resolved.kind === 'missing-key') return resolved
  const body = JSON.stringify({
    model: 'jev-latest',
    state,
    questions: { [question.id]: questionBody(question) },
  })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await sendRequest(resolved.value, body, dependencies.fetch)
    if (typeof response === 'string')
      return { kind: 'error', error: response, latencyMs: elapsed(started) }
    if (!response.ok) {
      if ((response.status === 429 || response.status === 529) && attempt === 0) continue
      return { kind: 'error', error: `http_${response.status}`, latencyMs: elapsed(started) }
    }
    const parsed = await parsedAnswer(question, response)
    if (!parsed) return { kind: 'error', error: 'unparsable_body', latencyMs: elapsed(started) }
    return { kind: 'answer', ...parsed, latencyMs: elapsed(started) }
  }
  return { kind: 'error', error: 'transport', latencyMs: elapsed(started) }
}
