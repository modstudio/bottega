import { describe, expect, test } from 'bun:test'
import {
  type CursorValue,
  decideConditionalAdvance,
  decideCursorStart,
  decideCursorTransition,
  decideStepOutcome,
} from './workflow-cursor-transition.ts'

const cursor = (ordinal: number, stepSlug: string, state: CursorValue['state'] = 'running') => ({
  ordinal,
  stepSlug,
  state,
})

describe('workflow cursor transition', () => {
  test('requires, validates, and refuses undeclared close outcomes', () => {
    expect(decideStepOutcome('choose', ['yes', 'no'], undefined)).toEqual({
      action: 'refuse',
      message: 'step "choose" requires --outcome <slug>; allowed values: yes, no',
    })
    expect(decideStepOutcome('choose', ['yes', 'no'], 'maybe')).toMatchObject({
      action: 'refuse',
    })
    expect(decideStepOutcome('choose', ['yes', 'no'], 'yes')).toEqual({ action: 'allow' })
    expect(decideStepOutcome('plain', undefined, 'yes')).toMatchObject({ action: 'refuse' })
  })

  test('skips an unmet conditional chain and stops at the next eligible step', () => {
    const steps = [
      { slug: 'choose' },
      { slug: 'one', when: { step: 'choose', outcome: ['yes'] } },
      { slug: 'two', when: { step: 'choose', outcome: ['yes'] } },
      { slug: 'finish' },
    ]
    expect(decideConditionalAdvance(steps, [{ slug: 'choose', outcome: 'no' }], 1)).toEqual({
      ordinal: 3,
      skipped: [
        { ordinal: 1, step: steps[1]! },
        { ordinal: 2, step: steps[2]! },
      ],
    })
    expect(
      decideConditionalAdvance(steps.slice(0, 2), [{ slug: 'choose', outcome: 'no' }], 1),
    ).toEqual({ ordinal: null, skipped: [{ ordinal: 1, step: steps[1]! }] })
  })
  test('retires terminal cursors before starting and reuses active cursors', () => {
    expect(decideCursorStart(null)).toBe('insert')
    expect(decideCursorStart('running')).toBe('reuse')
    expect(decideCursorStart('awaiting-ruling')).toBe('reuse')
    expect(decideCursorStart('done')).toBe('retire')
    expect(decideCursorStart('abandoned')).toBe('retire')
  })

  test('serves the current and earlier steps without allowing a skip', () => {
    expect(
      decideCursorTransition(cursor(2, 'two'), {
        kind: 'serve',
        ordinal: 2,
        slug: 'two',
      }),
    ).toMatchObject({ action: 'serve', move: false })
    expect(
      decideCursorTransition(cursor(2, 'two'), {
        kind: 'serve',
        ordinal: 1,
        slug: 'one',
      }),
    ).toMatchObject({ action: 'serve', move: false })
    expect(
      decideCursorTransition(cursor(2, 'two'), {
        kind: 'serve',
        ordinal: 4,
        slug: 'four',
      }),
    ).toEqual({ action: 'refuse', reason: 'ahead' })
  })

  test('refuses the step immediately ahead of the cursor', () => {
    expect(
      decideCursorTransition(cursor(2, 'two'), {
        kind: 'serve',
        ordinal: 3,
        slug: 'three',
      }),
    ).toEqual({ action: 'refuse', reason: 'ahead' })
  })

  test('requires compose before a later step but permits step one', () => {
    expect(
      decideCursorTransition(null, {
        kind: 'serve',
        ordinal: 0,
        slug: 'one',
      }).action,
    ).toBe('serve')
    expect(
      decideCursorTransition(null, {
        kind: 'serve',
        ordinal: 1,
        slug: 'two',
      }),
    ).toEqual({ action: 'refuse', reason: 'compose-first' })
  })

  test('finishes the last step, refuses terminal cursors, and advances from awaiting-ruling', () => {
    expect(
      decideCursorTransition(cursor(2, 'three'), { kind: 'next', total: 3, nextSlug: null }),
    ).toEqual({ action: 'finish' })
    expect(
      decideCursorTransition(cursor(2, 'three', 'done'), {
        kind: 'next',
        total: 3,
        nextSlug: null,
      }),
    ).toEqual({ action: 'refuse', reason: 'state' })
    expect(
      decideCursorTransition(cursor(1, 'two', 'abandoned'), {
        kind: 'serve',
        ordinal: 1,
        slug: 'two',
      }),
    ).toEqual({ action: 'refuse', reason: 'state' })
    expect(
      decideCursorTransition(cursor(1, 'two', 'abandoned'), {
        kind: 'next',
        total: 3,
        nextSlug: 'three',
      }),
    ).toEqual({ action: 'refuse', reason: 'state' })
    expect(
      decideCursorTransition(cursor(1, 'two', 'awaiting-ruling'), {
        kind: 'next',
        total: 3,
        nextSlug: 'three',
      }),
    ).toMatchObject({ action: 'serve', ordinal: 2, slug: 'three' })
  })
})
