// concern: record-caller
/** Owns the bounded caller identity attached to hosted record requests. */

import { AsyncLocalStorage } from 'node:async_hooks'
import { PLATFORM_SLUG } from './brand.ts'

export const CALLER_ENVIRONMENT_KEY = 'BOTTEGA_CALLER'
export const CALLER_HEADER_NAME = `x-${PLATFORM_SLUG}-caller`
export const CALLER_TOKEN_MAX_LENGTH = 64

const CALLER_TOKEN = /^[A-Za-z0-9:_/.-]+$/
const callerScope = new AsyncLocalStorage<string>()

export function callerLineage(own: string, parent: string | undefined): string {
  return `${own}${parent ? `.${parent}` : ''}`.slice(0, CALLER_TOKEN_MAX_LENGTH)
}

function validCallerToken(value: string | undefined): value is string {
  return Boolean(value && value.length <= CALLER_TOKEN_MAX_LENGTH && CALLER_TOKEN.test(value))
}

export function callerToken(
  scopeValue: string | undefined,
  environmentValue: string | undefined,
): string {
  const candidate = scopeValue ?? environmentValue
  return validCallerToken(candidate) ? candidate : 'unknown'
}

/** Preserve absence for access-log sampling, but make every supplied invalid value explicit. */
export function loggedCallerToken(headerValue: string | null): string | null {
  if (headerValue === null) return null
  return validCallerToken(headerValue) ? headerValue : 'invalid'
}

export function inboundCaller(headerValue: string | null): {
  logged: string | null
  scope: string
} {
  const logged = loggedCallerToken(headerValue)
  return {
    logged,
    scope: headerValue !== null && validCallerToken(headerValue) ? headerValue : 'hub:server',
  }
}

export function recordCallerToken(environment: NodeJS.ProcessEnv = process.env): string {
  const scoped = callerScope.getStore()
  return callerToken(scoped, environment[CALLER_ENVIRONMENT_KEY])
}

export function withRecordCaller<T>(value: string, work: () => T): T {
  return callerScope.run(value, work)
}
