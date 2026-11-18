// concern: record-caller
/** Owns the bounded caller identity attached to hosted record requests. */

import { AsyncLocalStorage } from 'node:async_hooks'

export const CALLER_ENVIRONMENT_KEY = 'BOTTEGA_CALLER'
export const CALLER_TOKEN_MAX_LENGTH = 64

const CALLER_TOKEN = /^[A-Za-z0-9:_/.-]+$/
const callerScope = new AsyncLocalStorage<string>()
let processCallerToken: string | undefined

export function callerToken(
  scopeValue: string | undefined,
  environmentValue: string | undefined,
): string {
  const candidate = scopeValue ?? environmentValue
  return candidate && candidate.length <= CALLER_TOKEN_MAX_LENGTH && CALLER_TOKEN.test(candidate)
    ? candidate
    : 'unknown'
}

export function cliCallerEnvironmentValue(
  parentValue: string | undefined,
  commandPath: readonly string[],
): string {
  return parentValue ?? `cli:${commandPath.join('/')}`
}

export function recordCallerToken(environment: NodeJS.ProcessEnv = process.env): string {
  const scoped = callerScope.getStore()
  if (scoped !== undefined) return callerToken(scoped, undefined)
  if (environment !== process.env) return callerToken(undefined, environment[CALLER_ENVIRONMENT_KEY])
  processCallerToken ??= callerToken(undefined, environment[CALLER_ENVIRONMENT_KEY])
  return processCallerToken
}

export function withRecordCaller<T>(value: string, work: () => T): T {
  return callerScope.run(value, work)
}
