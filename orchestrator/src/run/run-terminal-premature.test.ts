import { describe, expect, test } from 'bun:test'
import type { WorkerReply } from '../contract/contract.ts'
import type { PrematureFinalRefusal } from '../evidence/premature-final.ts'
import type { TerminalOutcome } from './run-terminal-precedence.ts'
import {
  applyPrematureFinalFailure,
  terminalPrematureFinalRefusal,
} from './run-terminal-premature.ts'

const refusal: PrematureFinalRefusal = {
  failureKind: 'premature-final',
  error: 'premature final: the agent ended its turn with opening narration and no work (Starting…)',
}

describe('premature final terminal integration', () => {
  test('preserves a prior truncated outcome', () => {
    const truncated: TerminalOutcome = {
      status: 'failed',
      failureKind: 'truncated',
      error: 'vendor terminated stream',
    }

    expect(applyPrematureFinalFailure(truncated, refusal)).toEqual(truncated)
  })

  test('takes precedence over an already-unevidenced empty review', () => {
    expect(
      applyPrematureFinalFailure(
        {
          status: 'failed',
          failureKind: 'unevidenced',
          error: 'clean review has no supporting evidence',
        },
        refusal,
      ),
    ).toEqual({ status: 'failed', failureKind: 'premature-final', error: refusal.error })
  })

  test('takes precedence over the empty done writer fallback', () => {
    expect(
      applyPrematureFinalFailure(
        { status: 'failed', failureKind: 'other', error: 'reported done with no change' },
        refusal,
      ),
    ).toEqual({ status: 'failed', failureKind: 'premature-final', error: refusal.error })
  })

  test('does not classify a done writer when its diff was not measured', () => {
    expect(
      terminalPrematureFinalRefusal({
        readerReply: null,
        parsedReview: null,
        contract: {
          status: 'done',
          summary: 'Before writing the change, I will read the implementation.',
          files_changed: [],
          change_guide: null,
          questions: null,
          deviations: null,
          blockers: null,
          tests: null,
        } satisfies WorkerReply,
        measuredFiles: null,
        workerEvents: [],
        acceptedQuestionCount: 0,
        exitCode: 0,
      }),
    ).toBeNull()
  })
})
