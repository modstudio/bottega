// concern: contract
/** Lazily loads Ajv and adapts strict JSON Schema validation to worker-reply leniency. */

import { loadAjvValidator } from '../transport/ajv-validator-loader.ts'
import {
  contractValidationFailures,
  type SchemaValidatorPort,
  schemaCompileFailure,
} from './contract-reply.ts'

type CompiledReplyValidator = ReturnType<ReturnType<typeof loadAjvValidator>['compile']>

const compiledReplyValidators = new WeakMap<object, CompiledReplyValidator>()

const schemaMapKeywords = [
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
] as const
const schemaArrayKeywords = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const
const schemaKeywords = [
  'contains',
  'else',
  'if',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
] as const

function withoutAdditionalProperties(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return schema
  const copy = { ...(schema as Record<string, unknown>) }
  delete copy.additionalProperties
  for (const keyword of schemaMapKeywords) {
    const children = copy[keyword]
    if (children === null || typeof children !== 'object' || Array.isArray(children)) continue
    copy[keyword] = Object.fromEntries(
      Object.entries(children).map(([name, child]) => [name, withoutAdditionalProperties(child)]),
    )
  }
  for (const keyword of schemaArrayKeywords) {
    if (Array.isArray(copy[keyword])) {
      copy[keyword] = copy[keyword].map(withoutAdditionalProperties)
    }
  }
  const items = copy.items
  if (Array.isArray(items)) copy.items = items.map(withoutAdditionalProperties)
  else if (items !== undefined) copy.items = withoutAdditionalProperties(items)
  for (const keyword of schemaKeywords) {
    if (copy[keyword] !== undefined) copy[keyword] = withoutAdditionalProperties(copy[keyword])
  }
  return copy
}

/**
 * Validate worker replies without enforcing `additionalProperties` at any
 * depth. A worker that adds a stray key has not stopped doing the work.
 */
export const valueMatchesReplySchema: SchemaValidatorPort = (value, schema) => {
  let validate = compiledReplyValidators.get(schema)
  if (!validate) {
    const validator = loadAjvValidator()
    try {
      validate = validator.compile(withoutAdditionalProperties(schema) as object)
      compiledReplyValidators.set(schema, validate)
    } catch (error) {
      return {
        ok: false,
        failures: [schemaCompileFailure(error)],
      }
    }
  }
  return validate(value)
    ? { ok: true }
    : { ok: false, failures: contractValidationFailures(validate.errors) }
}
