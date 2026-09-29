import { describe, expect, test } from 'bun:test'
import type { WorkerReply } from '../contract/contract.ts'
import type { PrematureFinalRefusal } from '../evidence/premature-final.ts'
import {
  applyPrematureFinalFailure,
  terminalPrematureFinalRefusal,
} from './run-terminal-premature.ts'

const refusal: PrematureFinalRefusal = {
  failureKind: 'unevidenced',
  error: 'premature final: the agent ended its turn with opening narration and no work (Starting…)',
}

describe('premature final terminal integration', () => {
  test('preserves a prior truncated outcome', () => {
    const truncated = {
      status: 'failed',
      failureKind: 'truncated',
      error: 'vendor terminated stream',
    }

    expect(applyPrematureFinalFailure(truncated, refusal)).toEqual(truncated)
  })

  test('replaces only the error of an already-unevidenced empty review', () => {
    expect(
      applyPrematureFinalFailure(
        {
          status: 'failed',
          failureKind: 'unevidenced',
          error: 'clean review has no supporting evidence',
        },
        refusal,
      ),
    ).toEqual({ status: 'failed', failureKind: 'unevidenced', error: refusal.error })
  })

  test('does not classify a done writer when its diff was not measured', () => {
    expect(
      terminalPrematureFinalRefusal({
        readerJob: false,
        output: '',
        parsedReview: null,
        contract: {
          status: 'done',
          summary: 'Before writing the change, I will read the implementation.',
          files_changed: [],
          questions: null,
          deviations: null,
          blockers: null,
          tests: null,
        } satisfies WorkerReply,
        measuredFiles: null,
        workerEvents: [],
        acceptedQuestionCount: 0,
        exitCode: 0,
        latencyMs: 1,
      }),
    ).toBeNull()
  })
})
