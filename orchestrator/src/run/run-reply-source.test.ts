import { describe, expect, test } from 'bun:test'
import type { JsonSchema, SchemaValidatorPort } from '../contract/contract-reply.ts'
import { valueMatchesReplySchema } from '../contract/contract-reply-validator.ts'
import { valueMatchesStrictSchema } from '../transport/transport.ts'
import {
  collectReplySource,
  decideReplySource,
  type ReplySourceFacts,
  type ReplySourceRuling,
} from './run-reply-source.ts'

const baseFacts: ReplySourceFacts = {
  replyFile: { present: false },
  contract: 'none',
  fallback: { text: 'transport result', matches: false },
}

describe('reply source ruling', () => {
  const cases: Array<{
    name: string
    facts: ReplySourceFacts
    expected: ReplySourceRuling
  }> = [
    {
      name: 'file-presence mutation: a matching text reply file unwraps its answer',
      facts: {
        ...baseFacts,
        replyFile: {
          present: true,
          text: '{"answer":"file answer"}',
          matches: true,
          parsed: { answer: 'file answer' },
        },
        contract: 'text',
      },
      expected: {
        output: 'file answer',
        replyFileError: null,
        replyFilePresent: true,
        replyFileValue: { answer: 'file answer' },
        rewriteOutputFile: true,
      },
    },
    {
      name: 'contract-match mutation: a nonmatching reply file reports its original text',
      facts: {
        ...baseFacts,
        replyFile: {
          present: true,
          text: '{"wrong":"shape"}',
          matches: false,
          parsed: { wrong: 'shape' },
        },
        contract: 'text',
      },
      expected: {
        output: '{"wrong":"shape"}',
        replyFileError: 'reply.json did not match the worker contract:\n{"wrong":"shape"}',
        replyFilePresent: true,
        replyFileValue: { wrong: 'shape' },
        rewriteOutputFile: true,
      },
    },
    {
      name: 'a matching custom reply file keeps its text',
      facts: {
        ...baseFacts,
        replyFile: { present: true, text: '{"count":2}', matches: true, parsed: { count: 2 } },
        contract: 'custom',
      },
      expected: {
        output: '{"count":2}',
        replyFileError: null,
        replyFilePresent: true,
        replyFileValue: { count: 2 },
        rewriteOutputFile: true,
      },
    },
    {
      name: 'a matching text fallback unwraps and rewrites',
      facts: {
        ...baseFacts,
        contract: 'text',
        fallback: { text: '{"answer":"fallback answer"}', matches: true },
      },
      expected: {
        output: 'fallback answer',
        replyFileError: null,
        replyFilePresent: false,
        replyFileValue: null,
        rewriteOutputFile: true,
      },
    },
    {
      name: 'a nonmatching text fallback reports the missing file and rewrites',
      facts: { ...baseFacts, contract: 'text' },
      expected: {
        output: 'transport result',
        replyFileError:
          'reply.json missing; final message reply did not match the worker contract:\ntransport result',
        replyFilePresent: false,
        replyFileValue: null,
        rewriteOutputFile: true,
      },
    },
    {
      name: 'a nonmatching custom fallback reports the schema mismatch without rewriting',
      facts: {
        ...baseFacts,
        contract: 'custom',
        fallback: { text: '{"count":"two"}', matches: false },
      },
      expected: {
        output: '{"count":"two"}',
        replyFileError:
          'reply.json missing; final message reply did not match the worker contract:\n{"count":"two"}',
        replyFilePresent: false,
        replyFileValue: null,
        rewriteOutputFile: false,
      },
    },
    {
      name: 'a matching custom fallback is accepted without rewriting',
      facts: {
        ...baseFacts,
        contract: 'custom',
        fallback: { text: '{"count":2}', matches: true },
      },
      expected: {
        output: '{"count":2}',
        replyFileError: null,
        replyFilePresent: false,
        replyFileValue: null,
        rewriteOutputFile: false,
      },
    },
    {
      name: 'a nonmatching dialect fallback reports the missing file without rewriting',
      facts: baseFacts,
      expected: {
        output: 'transport result',
        replyFileError:
          'reply.json missing; final message reply did not match the worker contract:\ntransport result',
        replyFilePresent: false,
        replyFileValue: null,
        rewriteOutputFile: false,
      },
    },
  ]

  for (const row of cases) {
    test(row.name, () => expect(decideReplySource(row.facts)).toEqual(row.expected))
  }
})

const fullJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['integer', 'number', 'boolean', 'nothing', 'rows', 'choice'],
  properties: {
    integer: { type: 'integer' },
    number: { type: 'number' },
    boolean: { type: 'boolean' },
    nothing: { type: 'null' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n'],
        properties: { n: { type: 'integer' } },
      },
    },
    choice: { type: 'string', enum: ['accepted', 'rejected'] },
  },
} as const

const fullJsonReply = {
  integer: 2,
  number: 2.5,
  boolean: true,
  nothing: null,
  rows: [{ n: 3, nestedExtra: 'kept' }],
  choice: 'accepted',
  extra: 'kept',
}

const unusedDialect = {
  schema: fullJsonSchema,
  schemaName: 'fullJsonSchema',
  parse: () => ({ reply: null, contractObjects: 0 }),
}

function customReply(value: unknown, validatesSchema?: SchemaValidatorPort) {
  return collectReplySource({
    replyFileText: JSON.stringify(value),
    fallbackText: '',
    contract: 'custom',
    dialect: unusedDialect,
    schema: fullJsonSchema,
    validatesSchema,
  })
}

function oldIntegerTypeofBehavior(value: unknown, schema: JsonSchema): boolean {
  if (!valueMatchesReplySchema(value, schema)) return false
  if (schema.type === 'integer') {
    const javascriptType: string = typeof value
    return javascriptType === schema.type
  }
  if (Array.isArray(value) && schema.items) {
    return value.every((item) => oldIntegerTypeofBehavior(item, schema.items!))
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(schema.properties ?? {}).every(
      ([key, child]) =>
        !Object.hasOwn(value, key) ||
        oldIntegerTypeofBehavior((value as Record<string, unknown>)[key], child),
    )
  }
  return true
}

describe('custom reply-file schema validation', () => {
  test('Ajv accepts JSON Schema primitives, nested objects, arrays, and enums', () => {
    expect(customReply(fullJsonReply).replyFileError).toBeNull()
    expect(customReply({ ...fullJsonReply, integer: '2' }).replyFileError).toContain(
      'did not match',
    )
  })

  test('reply-file leniency removes additionalProperties at every depth', () => {
    expect(customReply(fullJsonReply).replyFileError).toBeNull()
    expect(valueMatchesStrictSchema(fullJsonSchema, fullJsonReply)).toBe(false)
  })

  test('mutation: the old typeof behavior rejects the valid integer reply', () => {
    expect(customReply(fullJsonReply, oldIntegerTypeofBehavior).replyFileError).toContain(
      'did not match',
    )
  })
})
