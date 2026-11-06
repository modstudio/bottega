// concern: contract
/** Lazily loads Ajv and adapts strict JSON Schema validation to worker-reply leniency. */

import type { AjvValidator } from '../transport/ajv-validator.ts'
import type { SchemaValidatorPort } from './contract-reply.ts'

let schemaValidator: AjvValidator | null = null
const compiledReplyValidators = new WeakMap<object, (value: unknown) => boolean>()

export function loadAjvValidator(): AjvValidator {
  if (schemaValidator) return schemaValidator
  // Loaded here, not at module load: doctor and every reporting command reach
  // the reply contract, and hermetic linked-tree fixtures carry no
  // orchestrator/node_modules. Ajv belongs only on a schema-validation path.
  try {
    const loaded =
      require('../transport/ajv-validator.ts') as typeof import('../transport/ajv-validator.ts')
    schemaValidator = loaded.createStrictSchemaValidator()
    return schemaValidator
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to load or construct the strict schema validator: ${cause}`)
  }
}

function withoutAdditionalProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAdditionalProperties)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'additionalProperties')
      .map(([key, child]) => [key, withoutAdditionalProperties(child)]),
  )
}

/**
 * Validate worker replies without enforcing `additionalProperties` at any
 * depth. A worker that adds a stray key has not stopped doing the work.
 */
export const valueMatchesReplySchema: SchemaValidatorPort = (value, schema) => {
  let validate = compiledReplyValidators.get(schema)
  if (!validate) {
    try {
      validate = loadAjvValidator().compile(withoutAdditionalProperties(schema) as object)
      compiledReplyValidators.set(schema, validate)
    } catch {
      return false
    }
  }
  return validate(value)
}
