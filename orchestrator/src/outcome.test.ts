import { describe, expect, test } from 'bun:test'
import { decideOutcome, type OutcomeInputs } from './outcome.ts'

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
