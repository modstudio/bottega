import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveInjection } from './project-injection.ts'
import { validateProjectSettings } from './projects.ts'

test('refuses a write state absent from the state map (mutation: skip absent write-state validation)', () => {
  const problems = validateProjectSettings(
    {
      tracker: {
        protocol: 'workspace-mcp',
        states: { complete: 'done' },
        writeStates: { done: 'missing' },
      },
    },
    'strict',
  )

  expect(problems).toEqual([
    expect.stringContaining(
      'tracker.writeStates.done: value "missing" is not a key of tracker.states',
    ),
  ])
  expect(problems[0]).toContain(`${PLATFORM_SLUG} project set <name> --settings`)
  expect(problems[0]).toContain('"states":{"missing":"done"}')
  expect(problems[0]).toContain('"writeStates"')
})

test('refuses a write state mapped to another category (mutation: skip mismatched write-state validation)', () => {
  expect(
    validateProjectSettings(
      {
        tracker: {
          protocol: 'workspace-mcp',
          states: { reviewing: 'review' },
          writeStates: { done: 'reviewing' },
        },
      },
      'strict',
    ),
  ).toEqual([
    expect.stringContaining(
      'tracker.writeStates.done: value "reviewing" maps to "review", not "done"',
    ),
  ])
})

test('accepts a write state mapped to its category (mutation: reject every write-state selection)', () => {
  expect(
    validateProjectSettings(
      {
        tracker: {
          protocol: 'workspace-mcp',
          states: { complete: 'done' },
          writeStates: { done: 'complete' },
        },
      },
      'strict',
    ),
  ).toEqual([])
})

test('uses an explicit write state over an earlier raw state (mutation: ignore writeStates)', () => {
  const tracker = resolveInjection(
    {
      name: 'fixture',
      stack: 'node',
      settings: {
        tracker: {
          protocol: 'workspace-mcp',
          states: { completed: 'done', complete: 'done' },
          writeStates: { done: 'complete' },
        },
      },
    },
    ['tracker'],
  ).tracker

  expect(tracker.states.done).toBe('complete')
})

test('refuses ambiguous write states without a selection (mutation: restore first-match resolution)', () => {
  expect(() =>
    resolveInjection(
      {
        name: 'fixture',
        stack: 'node',
        settings: {
          tracker: {
            protocol: 'workspace-mcp',
            states: { completed: 'done', complete: 'done' },
          },
        },
      },
      ['tracker'],
    ),
  ).toThrow(
    `project fixture tracker has several done states (completed, complete) but no writeStates.done selection; set it with: ${PLATFORM_SLUG} project set fixture --settings`,
  )
})

test('keeps the sole raw write state (mutation: omit the unselected raw state)', () => {
  const tracker = resolveInjection(
    {
      name: 'fixture',
      stack: 'node',
      settings: {
        tracker: { protocol: 'workspace-mcp', states: { complete: 'done' } },
      },
    },
    ['tracker'],
  ).tracker

  expect(tracker.states.done).toBe('complete')
})
