import { describe, expect, test } from 'bun:test'
import {
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
        },
        contract: 'text',
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
        replyFile: { present: true, text: '{"wrong":"shape"}', matches: false },
        contract: 'text',
      },
      expected: {
        output: '{"wrong":"shape"}',
        replyFileError: 'reply.json did not match the worker contract:\n{"wrong":"shape"}',
        replyFilePresent: true,
        rewriteOutputFile: true,
      },
    },
    {
      name: 'a matching custom reply file keeps its text',
      facts: {
        ...baseFacts,
        replyFile: { present: true, text: '{"count":2}', matches: true },
        contract: 'custom',
      },
      expected: {
        output: '{"count":2}',
        replyFileError: null,
        replyFilePresent: true,
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
        rewriteOutputFile: true,
      },
    },
    {
      name: 'a nonmatching text fallback keeps prose and rewrites',
      facts: { ...baseFacts, contract: 'text' },
      expected: {
        output: 'transport result',
        replyFileError: null,
        replyFilePresent: false,
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
        replyFileError: 'reply did not match the worker contract:\n{"count":"two"}',
        replyFilePresent: false,
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
        rewriteOutputFile: false,
      },
    },
    {
      name: 'no contract leaves the fallback untouched and does not rewrite',
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
