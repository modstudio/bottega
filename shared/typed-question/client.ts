import { hostedApiFetch } from '../bounded-fetch.ts'
// concern: typed-question-client
/** Calls the TypeSafe typed-question API without exposing its credential. */

import { ConfigClientError } from '../config-client.ts'
import { resolveActiveSpaceCredentialValue } from '../credential-value.ts'
import type { TypedQuestion } from './registry.ts'

const TYPED_QUESTION_TIMEOUT_MS = 5_000
const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const TYPESAFE_CREDENTIAL = {
  provider: 'typesafe',
  name: null,
  type: 'api-key',
  mode: 'default',
  environment: 'local',
} as const
const JEV_MODEL = 'jev-1.14.0'

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

export type TypedQuestionsClientResult =
  | { kind: 'missing-key' }
  | {
      kind: 'answer'
      answers: Record<string, TypedQuestionAnswer>
      model: string
      inputTokens: number
      latencyMs: number
    }
  | { kind: 'error'; error: string; latencyMs: number }

export type TypedQuestionClientDependencies = {
  resolveCredential(): Promise<{ kind: 'resolved'; value: string } | { kind: 'missing' }>
  fetch(input: string, init: RequestInit): Promise<Response>
  sleep?(ms: number): Promise<void>
  random?(): number
}

const clientDependencies: TypedQuestionClientDependencies = {
  resolveCredential: () => resolveTypesafeCredential(resolveActiveSpaceCredentialValue),
  fetch: (input, init) => hostedApiFetch(input, init),
  sleep: (ms) => Bun.sleep(ms),
  random: Math.random,
}

type ActiveSpaceCredentialResolver = typeof resolveActiveSpaceCredentialValue

export async function resolveTypesafeCredential(
  resolveActiveSpace: ActiveSpaceCredentialResolver,
): Promise<{ kind: 'resolved'; value: string } | { kind: 'missing' }> {
  try {
    const result = await resolveActiveSpace(TYPESAFE_CREDENTIAL)
    return result.kind === 'refused'
      ? { kind: 'missing' as const }
      : { kind: 'resolved' as const, value: result.value }
  } catch (error) {
    if (error instanceof ConfigClientError && error.reason === 'not-configured')
      return { kind: 'missing' }
    throw error
  }
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

function parseQuestionAnswer(question: TypedQuestion, raw: unknown): TypedQuestionAnswer | null {
  if (!raw || typeof raw !== 'object') return null
  const values = raw as Record<string, unknown>
  if (question.type === 'noul') {
    if (!finiteProbability(values.noul)) return null
    return { noul: values.noul }
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
      score: values.score as number,
      confidence: values.confidence,
      legend: legend as Record<string, string>,
      probabilities: probabilities as Record<string, number>,
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
    choice: values.choice,
    confidence: values.confidence,
    probabilities: probabilities as Record<string, number>,
  }
}

function parseAnswers(questions: readonly TypedQuestion[], body: unknown) {
  if (!body || typeof body !== 'object') return null
  const response = body as Record<string, unknown>
  const rawAnswers = response.answers
  const usage = response.usage
  if (
    typeof response.model !== 'string' ||
    !rawAnswers ||
    typeof rawAnswers !== 'object' ||
    !usage ||
    typeof usage !== 'object'
  )
    return null
  const inputTokens = (usage as Record<string, unknown>).input_tokens
  if (!Number.isInteger(inputTokens) || (inputTokens as number) < 0) return null
  const answers: Record<string, TypedQuestionAnswer> = {}
  for (const question of questions) {
    const answer = parseQuestionAnswer(
      question,
      (rawAnswers as Record<string, unknown>)[question.id],
    )
    if (answer) answers[question.id] = answer
  }
  return { answers, model: response.model, inputTokens: inputTokens as number }
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started))
}

async function resolveKey(
  dependencies: TypedQuestionClientDependencies,
): Promise<{ kind: 'key'; value: string } | { kind: 'missing-key' } | { kind: 'error' }> {
  try {
    const credential = await dependencies.resolveCredential()
    if (credential.kind === 'resolved') return { kind: 'key', value: credential.value }
    return { kind: 'missing-key' }
  } catch {
    return { kind: 'error' }
  }
}

async function sendRequest(
  key: string,
  body: string,
  transport: TypedQuestionClientDependencies['fetch'],
): Promise<Response | 'timeout' | 'transport'> {
  try {
    return await transport(TYPESAFE_ENDPOINT, {
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

async function parsedAnswers(questions: readonly TypedQuestion[], response: Response) {
  try {
    return parseAnswers(questions, await response.json())
  } catch {
    return null
  }
}

function retryable(result: Response | 'timeout' | 'transport'): boolean {
  return (
    typeof result === 'string' ||
    result.status === 408 ||
    result.status === 429 ||
    (result.status >= 500 && result.status <= 599)
  )
}

function numericHeader(response: Response, name: string): number | null {
  const value = response.headers.get(name)?.trim()
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return null
  return Number(value)
}

function retryDelay(
  result: Response | 'timeout' | 'transport',
  retry: number,
  random: () => number,
): number {
  if (typeof result !== 'string') {
    const milliseconds = numericHeader(result, 'retry-after-ms')
    if (milliseconds !== null) return Math.min(5_000, milliseconds)
    const seconds = numericHeader(result, 'retry-after')
    if (seconds !== null) return Math.min(5_000, seconds * 1_000)
  }
  return Math.min(5_000, 500 * 2 ** retry * (0.75 + random() * 0.5))
}

/** Resolve the key at call time and retry bounded transient failures with backoff. */
export async function askTypedQuestionClient(
  question: TypedQuestion,
  state: string | Record<string, unknown>,
  dependencies: TypedQuestionClientDependencies = clientDependencies,
): Promise<TypedQuestionClientResult> {
  const result = await askTypedQuestionsClient([question], state, dependencies)
  if (result.kind !== 'answer') return result
  const answer = result.answers[question.id]
  return answer
    ? { ...result, answer }
    : { kind: 'error', error: 'unparsable_body', latencyMs: result.latencyMs }
}

/** Resolve the key once and ask every question sharing the supplied state. */
export async function askTypedQuestionsClient(
  questions: readonly TypedQuestion[],
  state: string | Record<string, unknown>,
  dependencies: TypedQuestionClientDependencies = clientDependencies,
): Promise<TypedQuestionsClientResult> {
  const started = performance.now()
  const resolved = await resolveKey(dependencies)
  if (resolved.kind === 'error') {
    return { kind: 'error', error: 'key_resolution', latencyMs: elapsed(started) }
  }
  if (resolved.kind === 'missing-key') return resolved
  const body = JSON.stringify({
    model: JEV_MODEL,
    state,
    questions: Object.fromEntries(
      questions.map((question) => [question.id, questionBody(question)]),
    ),
  })
  const sleep = dependencies.sleep ?? clientDependencies.sleep!
  const random = dependencies.random ?? clientDependencies.random!
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await sendRequest(resolved.value, body, dependencies.fetch)
    if (retryable(response) && attempt < 2) {
      await sleep(retryDelay(response, attempt, random))
      continue
    }
    if (typeof response === 'string')
      return { kind: 'error', error: response, latencyMs: elapsed(started) }
    if (!response.ok) {
      return { kind: 'error', error: `http_${response.status}`, latencyMs: elapsed(started) }
    }
    const parsed = await parsedAnswers(questions, response)
    if (!parsed) return { kind: 'error', error: 'unparsable_body', latencyMs: elapsed(started) }
    return { kind: 'answer', ...parsed, latencyMs: elapsed(started) }
  }
  throw new Error('unreachable typed-question retry loop')
}
