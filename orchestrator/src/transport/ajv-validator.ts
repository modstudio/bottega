// concern: ajv-validator
/** Owns construction of the embedded Ajv validator. Must not know transports, agents, or contracts. */
import Ajv2020 from 'ajv/dist/2020.js'

type AjvValidationFailure = {
  instancePath: string
  keyword: string
  message?: string
}

type AjvValidateFunction = {
  (value: unknown): boolean
  errors?: readonly AjvValidationFailure[] | null
}

export type AjvValidator = { compile(schema: object): AjvValidateFunction }

export function createStrictSchemaValidator(): AjvValidator {
  return new Ajv2020({ strict: false })
}
