import { hostedApiFetch } from '../bounded-fetch.ts'
// concern: typed-question-client
/** Calls the TypeSafe typed-question API without exposing its credential. */

import { PLATFORM_SLUG } from '../brand.ts'
import { ConfigClientError } from '../config-client.ts'
import { RECORD_IDENTITY_MEMO_MAX_AGE_MS } from '../config-read-memo.ts'
import { credentialIdentityPath } from '../credential.ts'
import { resolveActiveSpaceCredentialValue } from '../credential-value.ts'
import { processMemo } from '../process-memo.ts'
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
/** The command that configures the credential this client reads; every remedy names it. */
export const TYPESAFE_CREDENTIAL_SET_COMMAND = `${PLATFORM_SLUG} credential set ${credentialIdentityPath(
  TYPESAFE_CREDENTIAL.provider,
  TYPESAFE_CREDENTIAL.name,
  TYPESAFE_CREDENTIAL.type,
)}`
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
  resolveCredential(): Promise<
    { kind: 'resolved'; value: string; version?: number } | { kind: 'missing' }
  >
  invalidateCredential?(refused: { value: string; version?: number }): void
  fetch(input: string, init: RequestInit): Promise<Response>
  sleep?(ms: number): Promise<void>
  random?(): number
}

export function typedQuestionClientDependencies(
  resolveCredential: TypedQuestionClientDependencies['resolveCredential'],
  fetch: TypedQuestionClientDependencies['fetch'],
): TypedQuestionClientDependencies {
  let loads = 0
  const credential = processMemo(
    async () => ({
      ...(await resolveCredential()),
      version: ++loads,
    }),
    {
      maxAgeMs: RECORD_IDENTITY_MEMO_MAX_AGE_MS,
    },
  )
  return {
    resolveCredential: credential.get,
    invalidateCredential: (refused) =>
      credential.clearIf((result) => result.version === refused.version),
    fetch,
    sleep: (ms) => Bun.sleep(ms),
    random: Math.random,
  }
}

const clientDependencies = typedQuestionClientDependencies(
  () => resolveTypesafeCredential(resolveActiveSpaceCredentialValue),
  (input, init) => hostedApiFetch(input, init),
)

/** Begin the process-memoized credential read so later typed questions can share it. */
export function startTypedQuestionCredentialResolution(): void {
  void clientDependencies.resolveCredential().catch(() => undefined)
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

type CredentialResolution =
  | { kind: 'key'; value: string; version?: number }
  | { kind: 'missing-key' }
  | { kind: 'key-resolution' }

type CredentialKey = { value: string; version?: number }

function credentialResolutionFailure(
  result: Exclude<CredentialResolution, { kind: 'key' }>,
  started: number,
): TypedQuestionsClientResult {
  return result.kind === 'missing-key'
    ? result
    : { kind: 'error', error: 'key_resolution', latencyMs: elapsed(started) }
}

async function resolveKey(
  dependencies: TypedQuestionClientDependencies,
): Promise<CredentialResolution> {
  try {
    const credential = await dependencies.resolveCredential()
    if (credential.kind === 'resolved')
      return { kind: 'key', value: credential.value, version: credential.version }
    return { kind: 'missing-key' }
  } catch {
    return { kind: 'key-resolution' }
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

type CredentialRequestResult =
  | {
      kind: 'response'
      response: Response | 'timeout' | 'transport'
      key: CredentialKey
      refreshed: boolean
    }
  | Exclude<CredentialResolution, { kind: 'key' }>

async function sendWithCredentialRefresh(
  key: CredentialKey,
  body: string,
  dependencies: TypedQuestionClientDependencies,
  allowRefresh: boolean,
): Promise<CredentialRequestResult> {
  const response = await sendRequest(key.value, body, dependencies.fetch)
  if (
    !allowRefresh ||
    typeof response === 'string' ||
    (response.status !== 401 && response.status !== 403)
  )
    return { kind: 'response', response, key, refreshed: false }

  dependencies.invalidateCredential?.(key)
  const resolved = await resolveKey(dependencies)
  if (resolved.kind !== 'key') return resolved
  return {
    kind: 'response',
    response: await sendRequest(resolved.value, body, dependencies.fetch),
    key: resolved,
    refreshed: true,
  }
}

async function responseResult(
  questions: readonly TypedQuestion[],
  response: Response | 'timeout' | 'transport',
  started: number,
): Promise<TypedQuestionsClientResult> {
  if (typeof response === 'string')
    return { kind: 'error', error: response, latencyMs: elapsed(started) }
  if (!response.ok)
    return { kind: 'error', error: `http_${response.status}`, latencyMs: elapsed(started) }
  const parsed = await parsedAnswers(questions, response)
  return parsed
    ? { kind: 'answer', ...parsed, latencyMs: elapsed(started) }
    : { kind: 'error', error: 'unparsable_body', latencyMs: elapsed(started) }
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

/**
 * Ask with the process-wide cached credential, refresh it once on a 401 or 403,
 * and retry bounded transient failures with backoff.
 */
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

/**
 * Resolve the key once and ask every question sharing the supplied state.
 * A 401 or 403 clears that cached key, resolves once more, and resends once before
 * returning the second HTTP refusal.
 */
export async function askTypedQuestionsClient(
  questions: readonly TypedQuestion[],
  state: string | Record<string, unknown>,
  dependencies: TypedQuestionClientDependencies = clientDependencies,
): Promise<TypedQuestionsClientResult> {
  const started = performance.now()
  const resolved = await resolveKey(dependencies)
  if (resolved.kind !== 'key') return credentialResolutionFailure(resolved, started)
  let key: CredentialKey = resolved
  const body = JSON.stringify({
    model: JEV_MODEL,
    state,
    questions: Object.fromEntries(
      questions.map((question) => [question.id, questionBody(question)]),
    ),
  })
  const sleep = dependencies.sleep ?? clientDependencies.sleep!
  const random = dependencies.random ?? clientDependencies.random!
  let authRetried = false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sent = await sendWithCredentialRefresh(key, body, dependencies, !authRetried)
    if (sent.kind !== 'response') return credentialResolutionFailure(sent, started)
    const response = sent.response
    key = sent.key
    authRetried ||= sent.refreshed
    if (retryable(response) && attempt < 2) {
      await sleep(retryDelay(response, attempt, random))
      continue
    }
    return responseResult(questions, response, started)
  }
  throw new Error('unreachable typed-question retry loop')
}
