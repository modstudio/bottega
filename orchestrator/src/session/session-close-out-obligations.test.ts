import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  landedTaskIdentities,
  sessionCloseOutObligations,
} from './session-close-out-obligations.ts'

describe('session close-out obligations', () => {
  test('pending score roots name the run, agent, job, label, and score remedy', () => {
    expect(
      sessionCloseOutObligations({
        pendingScores: [
          {
            record_id: 'run-record-id',
            agent: 'codex',
            job: 'implement',
            prompt_head: 'DEV-2227 slice',
            status: 'ok',
            failure_kind: null,
          },
        ],
        landedTasks: [],
      }),
    ).toEqual([
      {
        item: 'unscored run run-record-id',
        reason: 'codex/implement has no current score',
        evidence: 'DEV-2227 slice',
        remedy: `${PLATFORM_SLUG} score run-record-id none`,
      },
    ])
  })

  test('landed tasks union owned-run and recording-session records, skip, and deduplicate', () => {
    expect(
      landedTaskIdentities({
        session: 'closing-session',
        ownedRunRecordIds: new Set(['owned-run', 'owned-duplicate']),
        rows: [
          {
            project: 'alpha',
            branch: 'owned',
            recordingSession: 'other-session',
            runRecordId: 'owned-run',
            taskKey: 'DEV-1',
          },
          {
            project: 'alpha',
            branch: 'recorded',
            recordingSession: 'closing-session',
            runRecordId: 'other-run',
            taskKey: 'DEV-2',
          },
          {
            project: 'alpha',
            branch: 'duplicate',
            recordingSession: 'closing-session',
            runRecordId: 'owned-duplicate',
            taskKey: 'DEV-1',
          },
          {
            project: 'beta',
            branch: 'same-key-other-project',
            recordingSession: 'closing-session',
            runRecordId: 'other-run',
            taskKey: 'DEV-1',
          },
          {
            project: 'alpha',
            branch: 'recorded-unkeyed',
            recordingSession: 'closing-session',
            runRecordId: null,
            taskKey: null,
          },
          {
            project: 'alpha',
            branch: 'unrelated',
            recordingSession: 'other-session',
            runRecordId: 'other-run',
            taskKey: 'DEV-3',
          },
        ],
      }),
    ).toEqual([
      { project: 'alpha', taskKey: 'DEV-1' },
      { project: 'alpha', taskKey: 'DEV-2' },
      { project: 'beta', taskKey: 'DEV-1' },
    ])
  })

  test('closed landed tasks pass while open and unverified observations remain', () => {
    expect(
      sessionCloseOutObligations({
        pendingScores: [],
        landedTasks: [
          {
            project: 'alpha',
            taskKey: 'DEV-1',
            observation: { category: 'done', verified: true, detail: 'done' },
          },
          {
            project: 'alpha',
            taskKey: 'DEV-2',
            observation: { category: 'dropped', verified: true, detail: 'cancelled' },
          },
          {
            project: 'alpha',
            taskKey: 'DEV-3',
            observation: { category: 'active', verified: true, detail: 'in progress' },
          },
          {
            project: 'alpha',
            taskKey: 'DEV-4',
            observation: {
              category: null,
              verified: false,
              detail: 'unverified (missing status category)',
            },
          },
          {
            project: 'alpha',
            taskKey: 'DEV-4',
            observation: { category: 'done', verified: true, detail: 'done' },
          },
        ],
      }),
    ).toEqual([
      {
        item: 'landed task alpha:DEV-3',
        reason: 'task is active',
        evidence: 'in progress',
        remedy: `${PLATFORM_SLUG} task set DEV-3 --project alpha --status done`,
      },
      {
        item: 'landed task alpha:DEV-4',
        reason: 'task status could not be verified',
        evidence: 'unverified (missing status category)',
        remedy: `${PLATFORM_SLUG} task set DEV-4 --project alpha --status done`,
      },
    ])
  })
})
