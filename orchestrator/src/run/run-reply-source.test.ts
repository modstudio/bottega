import { describe, expect, test } from 'bun:test'
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
  fallback: { text: 'transport result', matches: false, failures: ['not JSON: unexpected token'] },
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
          failures: [],
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
          failures: ['/ required: must have required property answer'],
          parsed: { wrong: 'shape' },
        },
        contract: 'text',
      },
      expected: {
        output: '{"wrong":"shape"}',
        replyFileError:
          'reply.json did not match the worker contract: / required: must have required property answer\n{"wrong":"shape"}',
        replyFilePresent: true,
        replyFileValue: { wrong: 'shape' },
        rewriteOutputFile: true,
      },
    },
    {
      name: 'a matching custom reply file keeps its text',
      facts: {
        ...baseFacts,
        replyFile: {
          present: true,
          text: '{"count":2}',
          matches: true,
          failures: [],
          parsed: { count: 2 },
        },
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
        fallback: { text: '{"answer":"fallback answer"}', matches: true, failures: [] },
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
          'reply.json missing; final message reply did not match the worker contract: not JSON: unexpected token\ntransport result',
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
        fallback: {
          text: '{"count":"two"}',
          matches: false,
          failures: ['/count type: must be number'],
        },
      },
      expected: {
        output: '{"count":"two"}',
        replyFileError:
          'reply.json missing; final message reply did not match the worker contract: /count type: must be number\n{"count":"two"}',
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
        fallback: { text: '{"count":2}', matches: true, failures: [] },
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
          'reply.json missing; final message reply did not match the worker contract: not JSON: unexpected token\ntransport result',
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
  required: ['integer', 'number', 'boolean', 'nothing', 'rows', 'choice', 'additionalProperties'],
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
    additionalProperties: { type: 'string' },
  },
} as const

const fullJsonReply = {
  integer: 2,
  number: 2.5,
  boolean: true,
  nothing: null,
  rows: [{ n: 3, nestedExtra: 'kept' }],
  choice: 'accepted',
  additionalProperties: 'a property name, not the schema keyword',
  extra: 'kept',
}

const unusedDialect = {
  schema: fullJsonSchema,
  schemaName: 'fullJsonSchema',
  parse: () => ({ reply: null, contractObjects: 0, failures: [] }),
}

function customReply(value: unknown) {
  return collectReplySource({
    replyFileText: JSON.stringify(value),
    fallbackText: '',
    contract: 'custom',
    dialect: unusedDialect,
    schema: fullJsonSchema,
  })
}

describe('custom reply-file schema validation', () => {
  test('Ajv accepts JSON Schema primitives, nested objects, arrays, and enums', () => {
    expect(customReply(fullJsonReply).replyFileError).toBeNull()
    expect(customReply({ ...fullJsonReply, integer: '2' }).replyFileError).toContain(
      'did not match',
    )
  })

  test('reply-file leniency removes additionalProperties at every depth', () => {
    expect(valueMatchesStrictSchema(fullJsonSchema, fullJsonReply).ok).toBe(false)
  })
})
