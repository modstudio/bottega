import { valueMatchesStrictSchema } from '../transport/transport.ts'

const MATCHING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string', enum: ['ok'] } },
}

/** Prove the compiled binary can validate a value against a strict schema with no vendor. */
export function checkStrictSchemaMain(): number {
  try {
    if (!valueMatchesStrictSchema(MATCHING_SCHEMA, { status: 'ok' })) {
      console.error('strict schema validator rejected a matching value')
      return 1
    }
    console.log('strict schema ok')
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) process.exitCode = checkStrictSchemaMain()
