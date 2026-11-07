import { describe, expect, test } from 'bun:test'
import { READER_SCHEMA } from './contract.ts'
import {
  CONTRACT_FAILURE_LIMIT,
  type ContractValidationFailure,
  contractValidationFailures,
  parseWorkerReplyWithCount,
} from './contract-reply.ts'
import { valueMatchesReplySchema } from './contract-reply-validator.ts'

describe('worker contract validation failures', () => {
  test('a missing required field names its path and keyword', () => {
    const result = valueMatchesReplySchema(
      {},
      {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    )

    expect(result).toEqual({
      ok: false,
      failures: ["/ required: must have required property 'name'"],
    })
  })

  test('a wrong type names its path and keyword', () => {
    const result = valueMatchesReplySchema(
      { count: 'two' },
      { type: 'object', properties: { count: { type: 'number' } } },
    )

    expect(result).toEqual({
      ok: false,
      failures: ['/count type: must be number'],
    })
  })

  test('a schema compile failure names the compiler error', () => {
    const result = valueMatchesReplySchema({}, { type: 'not-a-json-schema-type' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failures[0]).toMatch(/^schema did not compile: /)
  })

  test('non-JSON input keeps the parse error from the rejected candidate', () => {
    const result = parseWorkerReplyWithCount('not JSON', READER_SCHEMA, valueMatchesReplySchema)

    expect(result.reply).toBeNull()
    expect(result.failures[0]).toMatch(/^not JSON: /)
  })

  test('failure rendering keeps the limit and counts what was left out', () => {
    const errors: ContractValidationFailure[] = Array.from(
      { length: CONTRACT_FAILURE_LIMIT + 3 },
      (_, index) => ({
        instancePath: `/field${index}`,
        keyword: 'type',
        message: 'must be string',
      }),
    )

    const failures = contractValidationFailures(errors)
    expect(failures).toHaveLength(CONTRACT_FAILURE_LIMIT)
    expect(failures.at(-1)).toBe(
      `/field${CONTRACT_FAILURE_LIMIT - 1} type: must be string; 3 more failures left out`,
    )
  })
})
