// concern: ajv-validator
/** Owns construction of the embedded Ajv validator. Must not know transports, agents, or contracts. */
import Ajv2020 from 'ajv/dist/2020.js'

export type AjvValidator = { compile(schema: object): (value: unknown) => boolean }

export function createStrictSchemaValidator(): AjvValidator {
  return new Ajv2020({ strict: false })
}
