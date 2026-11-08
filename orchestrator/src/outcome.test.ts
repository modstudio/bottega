import { describe, expect, test } from 'bun:test'
import type { WorkerQuestionInput } from './ask/worker-question.ts'
import {
  decideOutcome,
  finalizeWorkerReply,
  isSchemaEnvelopeReply,
  type OutcomeInputs,
  SCHEMA_ENVELOPE_ERROR_PREFIX,
  schemaEnvelopeContractError,
} from './outcome.ts'

describe('worker question finalization regression', () => {
  const finalize = (question: WorkerQuestionInput) =>
    finalizeWorkerReply({
      reply: { status: 'asking', questions: [question] },
      measuredFiles: [],
      turnChanged: false,
      status: 'asking',
      failureKind: null,
      error: null,
    })

  test('run 29914 prose recommendation remains an answerable asking outcome', () => {
    const result = finalize({
      kind: 'choice',
      question: 'Which option?',
      why: 'The implementation depends on the selection.',
      options: ['one', 'two'],
      recommendation: 'I recommend one because it is safer.',
    })

    expect(result).toMatchObject({ status: 'asking', failureKind: null })
    expect(result.acceptedQuestions).toHaveLength(1)
    expect(result.acceptedQuestions[0]).not.toHaveProperty('recommendation')
  })

  test('a placeholder remains a contract failure and names its drop reason', () => {
    const result = finalize({ question: 'placeholder', why: 'A reason was claimed.' })

    expect(result).toMatchObject({ status: 'failed', failureKind: 'contract' })
    expect(result.error).toContain('"placeholder" (question is generic)')
  })

  test('a punctuation-only question names the empty drop reason', () => {
    const result = finalize({ question: '...', why: 'A reason was claimed.' })

    expect(result).toMatchObject({ status: 'failed', failureKind: 'contract' })
    expect(result.error).toContain('"..." (question is empty)')
  })
})

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
  gooseVendorFailureKind: null,
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
    [
      'a Goose vendor failure outranks a missing-file contract mismatch',
      {
        replyFileError: true,
        gooseVendorFailureKind: 'billing',
      },
      { status: 'failed', failureKind: 'billing' },
    ],
    [
      'a classified missing writer contract keeps its failure kind',
      {
        missingRequiredContract: true,
        missingContractFailureKind: 'quota',
      },
      { status: 'failed', failureKind: 'quota' },
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
    expect(
      isSchemaEnvelopeReply(
        { type: 'object', properties: { findings: { type: 'array' } } },
        schema,
      ),
    ).toBe(false)
  })

  test('does not detect a valid reply', () => {
    expect(isSchemaEnvelopeReply({ findings: [], provenance: {} }, schema)).toBe(false)
  })
})
