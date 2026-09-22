import { describe, expect, test } from 'bun:test'
import type { FailureKind } from '../failure/failure.ts'
import {
  applyConfinementPrecedence,
  applyVendorTermination,
  type TerminalOutcome,
} from './run-terminal-precedence.ts'

type Case = {
  name: string
  outcome: TerminalOutcome
  questions: string[]
  vendorTerminationError: string | null
  preConfinement: string | null
  confinementUnverifiedError: string | null
  overlappingError: string | null
  expectedOutcome: TerminalOutcome
  expectedQuestions: string[]
  expectedPreConfinement: string | null
}

const ok: TerminalOutcome = { status: 'ok', failureKind: null, error: null }
const asking: TerminalOutcome = { status: 'asking', failureKind: null, error: null }
const truncated: TerminalOutcome = {
  status: 'failed',
  failureKind: 'truncated',
  error: 'vendor terminated stream',
}

describe('terminal outcome precedence', () => {
  test.each([
    {
      name: 'a done contract with questions and a termination marker is truncated',
      outcome: ok,
      questions: ['Which table?'],
      vendorTerminationError: 'vendor terminated stream',
      preConfinement: null,
      confinementUnverifiedError: null,
      overlappingError: null,
      expectedOutcome: truncated,
      expectedQuestions: [],
      expectedPreConfinement: null,
    },
    {
      name: 'an ok outcome with a confinement failure records the prior outcome',
      outcome: ok,
      questions: [],
      vendorTerminationError: null,
      preConfinement: null,
      confinementUnverifiedError: 'confinement could not be verified',
      overlappingError: null,
      expectedOutcome: {
        status: 'failed',
        failureKind: 'confinement_unverified' as FailureKind,
        error: 'confinement could not be verified',
      },
      expectedQuestions: [],
      expectedPreConfinement: JSON.stringify(ok),
    },
    {
      name: 'an asking outcome with an overlapping event is escaped',
      outcome: asking,
      questions: ['Which table?'],
      vendorTerminationError: null,
      preConfinement: null,
      confinementUnverifiedError: null,
      overlappingError: 'checkout overlap',
      expectedOutcome: {
        status: 'failed',
        failureKind: 'escaped' as FailureKind,
        error: 'checkout overlap',
      },
      expectedQuestions: ['Which table?'],
      expectedPreConfinement: JSON.stringify(asking),
    },
    {
      name: 'confinement failure outranks a termination marker',
      outcome: ok,
      questions: ['Which table?'],
      vendorTerminationError: 'vendor terminated stream',
      preConfinement: null,
      confinementUnverifiedError: 'confinement could not be verified',
      overlappingError: null,
      expectedOutcome: {
        status: 'failed',
        failureKind: 'confinement_unverified' as FailureKind,
        error: 'confinement could not be verified',
      },
      expectedQuestions: [],
      expectedPreConfinement: JSON.stringify(truncated),
    },
    {
      name: 'no precedence facts leave the outcome untouched',
      outcome: ok,
      questions: ['Which table?'],
      vendorTerminationError: null,
      preConfinement: 'existing snapshot',
      confinementUnverifiedError: null,
      overlappingError: null,
      expectedOutcome: ok,
      expectedQuestions: ['Which table?'],
      expectedPreConfinement: 'existing snapshot',
    },
    {
      name: 'confinement failure outranks an overlapping event',
      outcome: asking,
      questions: ['Which table?'],
      vendorTerminationError: null,
      preConfinement: null,
      confinementUnverifiedError: 'confinement could not be verified',
      overlappingError: 'checkout overlap',
      expectedOutcome: {
        status: 'failed',
        failureKind: 'confinement_unverified' as FailureKind,
        error: 'confinement could not be verified',
      },
      expectedQuestions: ['Which table?'],
      expectedPreConfinement: JSON.stringify(asking),
    },
  ] satisfies Case[])('$name', (facts) => {
    const vendor = applyVendorTermination({
      outcome: facts.outcome,
      vendorTerminationError: facts.vendorTerminationError,
      acceptedQuestions: facts.questions,
    })
    const confinement = applyConfinementPrecedence({
      outcome: vendor.outcome,
      preConfinement: facts.preConfinement,
      confinementUnverifiedError: facts.confinementUnverifiedError,
      overlappingError: facts.overlappingError,
    })

    expect(confinement.outcome).toEqual(facts.expectedOutcome)
    expect(vendor.acceptedQuestions).toEqual(facts.expectedQuestions)
    expect(confinement.preConfinement).toBe(facts.expectedPreConfinement)
  })
})
