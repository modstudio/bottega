import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  foreignCursorOwnerNotice,
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
  test('shows the latest repin versions', () => {
    const line = renderWorkflowCursorLine({
      id: 12,
      workflow_slug: 'fix-defect',
      mode_slug: 'single',
      workflow_key: 'DEV-12',
      project: 'fixture',
      ordinal: 2,
      total_steps: 4,
      step_slug: 'close-task',
      state: 'running',
      next_slug: 'finished',
      closed: JSON.stringify([
        {
          event: 'repinned',
          workflow: { from: 3, to: 4 },
          catalogue: { from: 8, to: 9 },
          reason: 'new close outcome',
          callerSession: 'session-one',
          at: '2026-11-20T00:00:00.000Z',
        },
      ]),
    })
    expect(line).toContain('repinned workflow 3->4 catalogue 8->9')
  })

  test('a foreign owner notice names the owner and the keyed compose takeover', () => {
    expect(
      foreignCursorOwnerNotice(
        {
          id: 17,
          session_id: 'owner-session',
          workflow_slug: 'ship-task',
          workflow_key: 'DEV-2370',
          project: 'fixture',
          mode_slug: 'default',
          args: JSON.stringify({ key: 'DEV-2370', worktree: '/tmp/work tree' }),
        },
        'reader-session',
      ),
    ).toBe(
      `Notice: this cursor is owned by session owner-session. Take it over with: ${PLATFORM_SLUG} workflow compose ship-task --project fixture --mode default --arg key=DEV-2370 --arg 'worktree=/tmp/work tree'`,
    )
  })

  test('a keyless foreign cursor remedy abandons by owner before composing a replacement', () => {
    expect(
      foreignCursorOwnerNotice(
        {
          id: 17,
          session_id: 'owner session',
          workflow_slug: 'explore',
          workflow_key: '',
          project: 'fixture project',
          mode_slug: 'default',
          args: '{}',
        },
        'reader-session',
      ),
    ).toBe(
      `Notice: this cursor is owned by session owner session. Take it over with: ${PLATFORM_SLUG} workflow abandon --cursor 17 --project 'fixture project' --owner-session 'owner session'; then compose a new cursor with: ${PLATFORM_SLUG} workflow compose explore --project 'fixture project' --mode default`,
    )
  })

  test('a sessionless reader receives no unusable takeover notice', () => {
    expect(
      foreignCursorOwnerNotice(
        {
          id: 17,
          session_id: 'owner-session',
          workflow_slug: 'ship-task',
          workflow_key: 'DEV-2370',
          project: 'fixture',
          mode_slug: 'default',
          args: JSON.stringify({ key: 'DEV-2370' }),
        },
        null,
      ),
    ).toBeUndefined()
  })

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
    const unchanged = `cursor 1145 plan-task default DEV-1983 ${PLATFORM_SLUG} step 3/5 signoff awaiting-ruling next: implement`
    expect(
      renderWorkflowCursorLine({
        ...row,
        handed_off_from_number: 7,
        handed_off_from_workflow: 'explore',
      }),
    ).toBe(`${unchanged} handed off from explore cursor 7`)
    expect(
      renderWorkflowCursorLine({
        ...row,
        handed_off_from_number: null,
        handed_off_from_workflow: null,
      }),
    ).toBe(unchanged)
  })
})
