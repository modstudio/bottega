// concern: ajv-validator
/** Owns construction of the embedded Ajv validator. Must not know transports, agents, or contracts. */
import Ajv2020 from 'ajv/dist/2020.js'

export const CONTRACT_FAILURE_LIMIT = 5

export type SchemaValidationResult = { ok: true } | { ok: false; failures: string[] }

export type AjvValidationFailure = {
  instancePath: string
  keyword: string
  message?: string
}

export type AjvValidateFunction = {
  (value: unknown): boolean
  errors?: readonly AjvValidationFailure[] | null
}

export type AjvValidator = { compile(schema: object): AjvValidateFunction }

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ajvFailures(errors: readonly AjvValidationFailure[] | null | undefined): string[] {
  const failures = (errors ?? []).slice(0, CONTRACT_FAILURE_LIMIT).map((error) => {
    const path = error.instancePath || '/'
    return `${path} ${error.keyword}: ${error.message ?? 'validation failed'}`
  })
  const omitted = (errors?.length ?? 0) - failures.length
  if (omitted > 0 && failures.length > 0) {
    failures[failures.length - 1] += `; ${omitted} more failure${omitted === 1 ? '' : 's'} left out`
  }
  return failures
}

export function createStrictSchemaValidator(): AjvValidator {
  return new Ajv2020({ strict: false })
}
