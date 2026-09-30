import type { FailureKind } from '../failure/failure.ts'
import type { OutcomeStatus } from '../outcome.ts'

export type TerminalOutcome = {
  status: OutcomeStatus
  failureKind: FailureKind | null
  error: string | null
}

export type VendorTerminationFacts<Question> = {
  outcome: TerminalOutcome
  vendorTerminationError: string | null
  acceptedQuestions: Question[]
}

export type VendorTerminationRuling<Question> = {
  outcome: TerminalOutcome
  acceptedQuestions: Question[]
}

/**
 * A raw stdout/stderr stream ending in a vendor termination marker means the
 * vendor killed the session. Whatever else the run appears to be — an ACP stop
 * reason, a schema mismatch, a parsed question, a worker contract reporting
 * done — is an artifact of a stream that was cut off. Vendor truncation
 * therefore outranks every vendor-derived classification. It does NOT outrank
 * confinement (escaped, confinement_unverified), which outranks everything by
 * existing design.
 */
export function applyVendorTermination<Question>(
  facts: VendorTerminationFacts<Question>,
): VendorTerminationRuling<Question> {
  if (!facts.vendorTerminationError) {
    return { outcome: facts.outcome, acceptedQuestions: facts.acceptedQuestions }
  }
  return {
    outcome: {
      status: 'failed',
      failureKind: 'truncated',
      error: facts.vendorTerminationError,
    },
    acceptedQuestions: [],
  }
}

export type ConfinementPrecedenceFacts = {
  outcome: TerminalOutcome
  preConfinement: string | null
  confinementUnverifiedError: string | null
  overlappingError: string | null
}

export type ConfinementPrecedenceRuling = {
  outcome: TerminalOutcome
  preConfinement: string | null
}

/**
 * This post-process fact outranks every vendor exit or reply outcome. The
 * reply and diff remain stored, but an escaped write can never be an ok or
 * asking run and never inherits a failover-eligible vendor failure.
 */
export function applyConfinementPrecedence(
  facts: ConfinementPrecedenceFacts,
): ConfinementPrecedenceRuling {
  if (facts.confinementUnverifiedError) {
    return {
      preConfinement: JSON.stringify(facts.outcome),
      outcome: {
        status: 'failed',
        failureKind: 'confinement_unverified',
        error: facts.confinementUnverifiedError,
      },
    }
  }
  if (facts.overlappingError) {
    return {
      preConfinement: JSON.stringify(facts.outcome),
      outcome: {
        status: 'failed',
        failureKind: 'escaped',
        error: facts.overlappingError,
      },
    }
  }
  return { outcome: facts.outcome, preConfinement: facts.preConfinement }
}
