import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type WorkflowHistoryParityInput,
  workflowHistoryParityDiagnosis,
} from './record-history-parity.ts'
import type { HistoryUploadFingerprint } from './record-history-upload.ts'

const fingerprint: HistoryUploadFingerprint = [
  { table: 'workflow_step_text', count: 2, maxRowid: 2 },
]

function input(patch: Partial<WorkflowHistoryParityInput> = {}): WorkflowHistoryParityInput {
  return {
    local: {
      workflow_step_text: new Set(['step']),
      workflow_text_copy: new Set(['copy']),
      question_mutation_audit: new Set(['audit']),
      task_flow: new Set(['flow']),
      workflow_cursor: new Set(['cursor']),
    },
    present: {
      workflow_step_text: new Set(['step']),
      workflow_text_copy: new Set(['copy']),
      question_mutation_audit: new Set(['audit']),
      task_flow: new Set(['flow']),
      workflow_cursor: new Set(['cursor']),
      questionAuditIdentities: new Set(),
    },
    references: {
      obligationCursor: new Map(),
      stepTextCursor: new Map([['step', 'cursor']]),
      textCopyCursor: new Map([['copy', 'cursor']]),
      auditQuestion: new Map([['audit', 'question']]),
      auditIdentity: new Map(),
      questionCursor: new Map([['question', 'cursor']]),
      cursorFlow: new Map([['cursor', 'flow']]),
      cursorHandoff: new Map(),
      flowOpenCursor: new Map([['flow', 'cursor']]),
    },
    heldFlowIds: new Set(),
    heldQuestionIds: new Set(),
    storedFingerprint: fingerprint,
    currentFingerprint: fingerprint,
    states: {
      workflow_cursor: new Map([['cursor', 'running']]),
      task_flow: new Map([['flow', 'open']]),
    },
    ...patch,
  }
}

test('all workflow-history rows present report ok and pass', () => {
  const diagnosis = workflowHistoryParityDiagnosis(input())

  expect(diagnosis.failed).toBe(false)
  expect(diagnosis.lines).toEqual([
    'workflow history workflow_step_text: 1 local; 1 on the record — ok',
    'workflow history workflow_text_copy: 1 local; 1 on the record — ok',
    'workflow history question_mutation_audit: 1 local; 1 on the record — ok',
    'workflow history task_flow: 1 local; 1 on the record — ok',
    'workflow history workflow_cursor: 1 local; 1 on the record — ok',
  ])
})

test('held plus skipped warns for held rows and fails for skipped rows', () => {
  const diagnosis = workflowHistoryParityDiagnosis(
    input({
      local: {
        workflow_step_text: new Set(['held-step', 'skipped-step']),
        workflow_text_copy: new Set(),
        question_mutation_audit: new Set(),
        task_flow: new Set(),
        workflow_cursor: new Set(),
      },
      present: {
        workflow_step_text: new Set(),
        workflow_text_copy: new Set(),
        question_mutation_audit: new Set(),
        task_flow: new Set(),
        workflow_cursor: new Set(),
        questionAuditIdentities: new Set(),
      },
      references: {
        ...input().references,
        stepTextCursor: new Map([
          ['held-step', 'held-cursor'],
          ['skipped-step', 'skipped-cursor'],
        ]),
        cursorFlow: new Map([
          ['held-cursor', 'held-flow'],
          ['skipped-cursor', 'other-flow'],
        ]),
      },
      heldFlowIds: new Set(['held-flow']),
    }),
  )

  expect(diagnosis.failed).toBe(true)
  expect(diagnosis.lines).toContain(
    '  warning: workflow history workflow_step_text: held 1 (no command clears this yet)',
  )
  expect(diagnosis.lines.join('\n')).toContain(
    `causes: skipped 1 (no command clears this yet); pending 0 (run \`${PLATFORM_SLUG} record sync\`)`,
  )
})

test('held plus pending warns for held rows and fails for pending rows', () => {
  const diagnosis = workflowHistoryParityDiagnosis(
    input({
      local: {
        workflow_step_text: new Set(['held-step', 'pending-step']),
        workflow_text_copy: new Set(),
        question_mutation_audit: new Set(),
        task_flow: new Set(),
        workflow_cursor: new Set(),
      },
      present: {
        workflow_step_text: new Set(),
        workflow_text_copy: new Set(),
        question_mutation_audit: new Set(),
        task_flow: new Set(),
        workflow_cursor: new Set(),
        questionAuditIdentities: new Set(),
      },
      references: {
        ...input().references,
        stepTextCursor: new Map([
          ['held-step', 'held-cursor'],
          ['pending-step', 'pending-cursor'],
        ]),
        cursorFlow: new Map([
          ['held-cursor', 'held-flow'],
          ['pending-cursor', 'other-flow'],
        ]),
      },
      heldFlowIds: new Set(['held-flow']),
      storedFingerprint: [{ table: 'workflow_step_text', count: 1, maxRowid: 1 }],
    }),
  )

  expect(diagnosis.failed).toBe(true)
  expect(diagnosis.lines).toContain(
    '  warning: workflow history workflow_step_text: held 1 (no command clears this yet)',
  )
  expect(diagnosis.lines.join('\n')).toContain(
    `causes: skipped 0 (no command clears this yet); pending 1 (run \`${PLATFORM_SLUG} record sync\`)`,
  )
})

test('held-only rows warn without failing or describing the table as failed', () => {
  const diagnosis = workflowHistoryParityDiagnosis(
    input({
      present: {
        ...input().present,
        workflow_step_text: new Set(),
      },
      heldFlowIds: new Set(['flow']),
    }),
  )

  expect(diagnosis.failed).toBe(false)
  expect(diagnosis.lines).toContain(
    'workflow history workflow_step_text: 1 local; 0 on the record — held locally',
  )
  expect(diagnosis.lines).toContain(
    '  warning: workflow history workflow_step_text: held 1 (no command clears this yet)',
  )
  expect(diagnosis.lines.join('\n')).not.toContain('missing from the record')
})

test('question audit identity on the record counts an audit stored under another id', () => {
  const diagnosis = workflowHistoryParityDiagnosis(
    input({
      present: {
        ...input().present,
        question_mutation_audit: new Set(),
        questionAuditIdentities: new Set(['question|rule|1764028800000']),
      },
      references: {
        ...input().references,
        auditIdentity: new Map([
          ['audit', { questionId: 'question', action: 'rule', at: '2025-11-25T00:00:00.000Z' }],
        ]),
      },
    }),
  )

  expect(diagnosis.failed).toBe(false)
  expect(diagnosis.lines).toContain(
    'workflow history question_mutation_audit: 1 local; 1 on the record — ok',
  )
})

test('missing cursors split by local state', () => {
  const diagnosis = workflowHistoryParityDiagnosis(
    input({
      local: {
        ...input().local,
        workflow_cursor: new Set(['cursor-a', 'cursor-b']),
      },
      present: {
        ...input().present,
        workflow_cursor: new Set(),
      },
      states: {
        ...input().states,
        workflow_cursor: new Map([
          ['cursor-a', 'running'],
          ['cursor-b', 'awaiting-ruling'],
        ]),
      },
    }),
  )

  expect(diagnosis.failed).toBe(true)
  expect(diagnosis.lines).toContain('  local states: awaiting-ruling 1, running 1')
})
