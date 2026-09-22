import { describe, expect, test } from 'bun:test'
import { type ReplyDialect, TEXT_REPLY_SCHEMA, validatesSchema } from '../contract/contract.ts'
import {
  decideReplySource,
  type ReplySourceFacts,
  type ReplySourceRuling,
} from './run-reply-source.ts'

const dialect: ReplyDialect = {
  schema: TEXT_REPLY_SCHEMA,
  schemaName: 'text-reply',
  parse(text) {
    try {
      const value = JSON.parse(text)
      return validatesSchema(value, TEXT_REPLY_SCHEMA)
        ? { reply: value, contractObjects: 1 }
        : { reply: null, contractObjects: 0 }
    } catch {
      return { reply: null, contractObjects: 0 }
    }
  },
}

const customSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['count'],
  properties: { count: { type: 'number' } },
} as const

const baseFacts: ReplySourceFacts = {
  transportOutput: 'transport result',
  replyFile: { present: false },
  validationSchema: null,
  customSchema: false,
  textContract: false,
  dialect,
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
        replyFile: { present: true, text: '{"answer":"file answer"}' },
        validationSchema: TEXT_REPLY_SCHEMA,
        textContract: true,
      },
      expected: {
        output: 'file answer',
        replyFileError: null,
        replyFilePresent: true,
        rewriteOutputFile: true,
      },
    },
    {
      name: 'contract-match mutation: a nonmatching reply file reports its original text',
      facts: {
        ...baseFacts,
        replyFile: { present: true, text: '{"wrong":"shape"}' },
        validationSchema: TEXT_REPLY_SCHEMA,
        textContract: true,
      },
      expected: {
        output: '{"wrong":"shape"}',
        replyFileError: 'reply.json did not match the worker contract:\n{"wrong":"shape"}',
        replyFilePresent: true,
        rewriteOutputFile: true,
      },
    },
    {
      name: 'a matching custom-schema reply file remains the public output',
      facts: {
        ...baseFacts,
        replyFile: { present: true, text: '{"count":2}' },
        validationSchema: customSchema,
        customSchema: true,
      },
      expected: {
        output: '{"count":2}',
        replyFileError: null,
        replyFilePresent: true,
        rewriteOutputFile: true,
      },
    },
    {
      name: 'a conforming text fallback unwraps its answer',
      facts: {
        ...baseFacts,
        transportOutput: '{"answer":"fallback answer"}',
        textContract: true,
      },
      expected: {
        output: 'fallback answer',
        replyFileError: null,
        replyFilePresent: false,
        rewriteOutputFile: true,
      },
    },
    {
      name: 'legacy prose under a text contract remains readable',
      facts: { ...baseFacts, textContract: true },
      expected: {
        output: 'transport result',
        replyFileError: null,
        replyFilePresent: false,
        rewriteOutputFile: true,
      },
    },
    {
      name: 'a custom-schema fallback mismatch reports the transport output',
      facts: {
        ...baseFacts,
        transportOutput: '{"count":"two"}',
        validationSchema: customSchema,
        customSchema: true,
      },
      expected: {
        output: '{"count":"two"}',
        replyFileError: 'reply did not match the worker contract:\n{"count":"two"}',
        replyFilePresent: false,
        rewriteOutputFile: false,
      },
    },
    {
      name: 'a matching custom-schema fallback is accepted',
      facts: {
        ...baseFacts,
        transportOutput: '{"count":2}',
        validationSchema: customSchema,
        customSchema: true,
      },
      expected: {
        output: '{"count":2}',
        replyFileError: null,
        replyFilePresent: false,
        rewriteOutputFile: false,
      },
    },
    {
      name: 'a fallback without a contract remains untouched and is not rewritten',
      facts: baseFacts,
      expected: {
        output: 'transport result',
        replyFileError: null,
        replyFilePresent: false,
        rewriteOutputFile: false,
      },
    },
  ]

  for (const row of cases) {
    test(row.name, () => expect(decideReplySource(row.facts)).toEqual(row.expected))
  }
})
