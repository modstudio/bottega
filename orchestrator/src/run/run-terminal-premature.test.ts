import { describe, expect, test } from 'bun:test'
import type { ReaderReply, ReviewReply, WorkerReply } from '../contract/contract.ts'
import { applyPrematureFinalFailure } from '../evidence/premature-final.ts'
import { terminalPrematureFinalRefusal } from './run-terminal-premature.ts'

describe('premature final terminal integration', () => {
  test('classifies run 16785 ok-status final-message fallback with no changes', () => {
    const fallbackRefusal = terminalPrematureFinalRefusal({
      readerReply: null,
      parsedReview: null,
      contract: {
        status: 'done',
        summary:
          'Started DEV-1546: reading the full spec, task, and current question-answer parsing…',
        files_changed: null,
        change_guide: null,
        questions: null,
        deviations: null,
        blockers: null,
        tests: null,
      } satisfies WorkerReply,
      measuredFiles: [],
      workerEvents: [],
      acceptedQuestionCount: 0,
      exitCode: 0,
    })

    expect(fallbackRefusal?.failureKind).toBe('premature-final')
    expect(
      applyPrematureFinalFailure(
        {
          status: 'ok',
          failureKind: null,
          error: 'reply.json missing; used final-message fallback',
        },
        fallbackRefusal,
      ),
    ).toEqual({
      status: 'failed',
      failureKind: 'premature-final',
      error:
        'premature final: the agent ended its turn with opening narration and no work ' +
        '(Started DEV-1546: reading the full spec, task, and current question-answer parsing……)',
    })
  })

  test('classifies run 16934 when opening narration is in tests.detail', () => {
    const refusal = terminalPrematureFinalRefusal({
      readerReply: null,
      parsedReview: null,
      contract: {
        status: 'done',
        summary:
          'I will implement DEV-1556 so the heartbeat reports BLOCKED only for questions this session can answer now, then verify with the specified tests.',
        files_changed: null,
        change_guide: null,
        questions: null,
        deviations: null,
        blockers: null,
        tests: {
          command: null,
          ran: false,
          passed: null,
          detail: 'Starting: read the full prompt, task, and current heartbeat/inbox code.',
        },
      } satisfies WorkerReply,
      measuredFiles: [],
      workerEvents: [],
      acceptedQuestionCount: 0,
      exitCode: 0,
    })

    expect(refusal?.failureKind).toBe('premature-final')
  })

  test('classifies run 7175 blocked reader diagnosis with no delivered deliverable', () => {
    const readerReply: ReaderReply = {
      deliverables: [
        {
          name: 'diagnosis',
          status: 'blocked',
          content:
            'Starting DEV-1016 diagnosis: reading the full prompt, task, and outbox contract sources.',
        },
      ],
      narrative:
        'Reader started. Gathering the full prompt, task DEV-1016, and outbox payload contracts before answering the four questions.',
      files_written: [],
    }
    expect(
      terminalPrematureFinalRefusal({
        readerReply,
        parsedReview: null,
        contract: null,
        measuredFiles: [],
        workerEvents: [],
        acceptedQuestionCount: 0,
        exitCode: 0,
      })?.failureKind,
    ).toBe('premature-final')
  })

  test('classifies an empty review through a real parsed review reply', () => {
    const parsedReview: ReviewReply = {
      findings: [
        {
          severity: 'placeholder',
          location: 'pending',
          evidence: 'Review not started; gathering the task and diff.',
          proposed_correction: 'complete the review',
        },
      ],
      provenance: {
        reviewed_commit: 'abc123',
        standards_read: [],
        model_used: 'grok',
        files_covered: [],
        commands_run: [],
        mcp_tools: [],
        docs_read: [],
        could_not_verify: [],
        substitutes: [],
        canon_source: 'unknown',
      },
    }
    expect(
      terminalPrematureFinalRefusal({
        readerReply: null,
        parsedReview,
        contract: null,
        measuredFiles: [],
        workerEvents: [],
        acceptedQuestionCount: 0,
        exitCode: 0,
      })?.failureKind,
    ).toBe('premature-final')
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
