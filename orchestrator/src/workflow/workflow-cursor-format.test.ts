import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  renderWorkflowCursorLine,
  WORKFLOW_CURSOR_QUESTION_SUMMARY_CHARS,
} from './workflow-cursor-format.ts'

const row = {
  id: 1145,
  workflow_slug: 'plan-task',
  mode_slug: 'default',
  workflow_key: 'DEV-1983',
  project: PLATFORM_SLUG,
  ordinal: 2,
  total_steps: 5,
  step_slug: 'signoff',
  state: 'awaiting-ruling',
  next_slug: 'implement',
}

describe('workflow cursor line', () => {
  test('summarizes a multiline ruling question and points to its full text', () => {
    const line = renderWorkflowCursorLine({
      ...row,
      question_number: 4010,
      question: `Should the workflow cursor line carry the complete design-signoff question even when the operator only needs its point, or should it use a bounded title?
The full wording remains available from the question inbox for the operator who needs the premise and alternatives.
This third line makes the reproduction roughly three hundred characters long.`,
    })

    expect(line).not.toContain('\n')
    expect(line).toContain('question q4010: ')
    expect(line).toContain(` (full text: ${PLATFORM_SLUG} question inbox)`)
    const summary = line.match(/question q4010: (.*) \(full text:/)?.[1]
    expect(summary).toBeDefined()
    expect(Array.from(summary!).length).toBeLessThanOrEqual(WORKFLOW_CURSOR_QUESTION_SUMMARY_CHARS)
    expect(summary).toEndWith('…')
  })

  test('leaves a cursor without a question unchanged', () => {
    expect(renderWorkflowCursorLine(row)).toBe(
      `cursor 1145 plan-task default DEV-1983 ${PLATFORM_SLUG} step 3/5 signoff awaiting-ruling next: implement`,
    )
  })
})
