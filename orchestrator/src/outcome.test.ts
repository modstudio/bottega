import { describe, expect, test } from 'bun:test'
import {
  decideOutcome,
  isSchemaEnvelopeReply,
  type OutcomeInputs,
  SCHEMA_ENVELOPE_ERROR_PREFIX,
  schemaEnvelopeContractError,
} from './outcome.ts'

const base: OutcomeInputs = {
  idleKilled: false,
  completedReply: false,
  collectedAsking: false,
  acceptedQuestions: false,
  acpVendorStop: false,
  acpFailureKind: 'other',
  replyFileError: false,
  replyFilePresent: false,
  outputCeilingReached: false,
  timedOut: false,
  completedReplyAtTimeout: false,
  replyError: false,
  replyErrorFailureKind: 'other',
  nonAnswer: false,
  nonAnswerFailureKind: 'other',
  contractStatus: null,
  exitCode: 0,
  completedContractFailureKind: 'other',
  missingRequiredContract: false,
  missingContractFailureKind: 'other',
  outputPresent: true,
  defaultFailureKind: 'other',
}

describe('outcome decision', () => {
  test.each([
    [
      'ACP vendor stop outranks an invalid reply file',
      {
        acpVendorStop: true,
        acpFailureKind: 'quota',
        replyFileError: true,
        replyFilePresent: true,
      },
      { status: 'failed', failureKind: 'quota' },
    ],
    [
      'an invalid reply file outranks transport questions',
      {
        replyFileError: true,
        replyFilePresent: true,
        collectedAsking: true,
      },
      { status: 'failed', failureKind: 'contract' },
    ],
    [
      'a refused contract keeps its null failure kind after a non-zero exit',
      {
        contractStatus: 'refused',
        exitCode: 1,
      },
      { status: 'failed', failureKind: null },
    ],
  ] as const)('%s', (_name, facts, expected) => {
    expect(decideOutcome({ ...base, ...facts })).toEqual(expected)
  })
})

describe('schema envelope reply detection', () => {
  const schema = {
    required: ['findings', 'provenance'],
  }

  test('detects the expected schema envelope', () => {
    const envelope = {
      type: 'object',
      required: ['findings', 'provenance'],
      properties: { findings: { type: 'array' }, provenance: { type: 'object' } },
    }
    expect(isSchemaEnvelopeReply(envelope, schema)).toBe(true)
    expect(schemaEnvelopeContractError('existing validation error', envelope, schema)).toBe(
      `${SCHEMA_ENVELOPE_ERROR_PREFIX}reply.json held the schema itself rather than an instance of it. existing validation error`,
    )
  })

  test('does not detect an ordinary invalid reply', () => {
    expect(isSchemaEnvelopeReply({ findings: 'not-an-array' }, schema)).toBe(false)
  })

  test('does not detect a valid reply', () => {
    expect(isSchemaEnvelopeReply({ findings: [], provenance: {} }, schema)).toBe(false)
  })
})
