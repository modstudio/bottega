import { expect, test } from 'bun:test'
import {
  type ContextBriefCursorLine,
  contextBriefWorktreePath,
  formatContextBriefCursorLine,
  formatContextBriefRunLine,
} from './context-brief-format.ts'

const cursor = (overrides: Partial<ContextBriefCursorLine> = {}): ContextBriefCursorLine => ({
  number: 1702,
  key: 'DEV-2304',
  workflow: 'ship-task',
  mode: 'default',
  step: 4,
  totalSteps: 9,
  stepSlug: 'review',
  branch: 'DEV-2304-work',
  worktree: '.claude/worktrees/orch-run',
  tip: '1a2b3c4',
  pr: 1995,
  questionNumber: 6406,
  runs: [35465],
  ...overrides,
})

test('renders every cursor handle in the approved order', () => {
  expect(formatContextBriefCursorLine(cursor())).toBe(
    'cursor 1702 DEV-2304 ship-task default step 4/9 review · branch DEV-2304-work · worktree .claude/worktrees/orch-run · tip 1a2b3c4 · pr 1995, awaiting q6406, runs 35465',
  )
})

test('renders a cursor without optional handles or separators', () => {
  expect(
    formatContextBriefCursorLine(
      cursor({
        number: 885,
        key: 'DEV-2324',
        workflow: 'plan-task',
        mode: 'feature',
        step: 5,
        totalSteps: 11,
        stepSlug: 'prior-art',
        branch: null,
        worktree: null,
        tip: null,
        pr: null,
        questionNumber: null,
        runs: [],
      }),
    ),
  ).toBe('cursor 885 DEV-2324 plan-task feature step 5/11 prior-art')
})

test('shortens only worktrees beneath the registered main checkout', () => {
  expect(contextBriefWorktreePath('/x/project/.claude/worktrees/run', '/x/project')).toBe(
    '.claude/worktrees/run',
  )
  expect(contextBriefWorktreePath('/trees/run', '/x/project')).toBe('/trees/run')
  expect(contextBriefWorktreePath('/x/project-other/run', '/x/project')).toBe(
    '/x/project-other/run',
  )
})

test('renders a run label with whitespace collapsed onto one line', () => {
  expect(
    formatContextBriefRunLine({
      number: 31111,
      job: 'review',
      status: 'asking',
      label: '  Read\n\n  the\tbrief  ',
    }),
  ).toBe('unbound run 31111 review asking · Read the brief')
})
