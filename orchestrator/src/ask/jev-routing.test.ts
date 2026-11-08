import { describe, expect, test } from 'bun:test'
import { routeJevAnswer as route } from './jev-routing.ts'

const routeJevAnswer = (
  input: Omit<
    Parameters<typeof route>[0],
    'fits' | 'orderFlipped' | 'bothOrdersAnswered' | 'fitThreshold'
  > &
    Partial<
      Pick<
        Parameters<typeof route>[0],
        'fits' | 'orderFlipped' | 'bothOrdersAnswered' | 'fitThreshold'
      >
    >,
) => route({ fits: 1, orderFlipped: false, bothOrdersAnswered: true, fitThreshold: 0.7, ...input })

const choice = {
  kind: 'choice' as const,
  question: 'Which?',
  why: 'Changes it.',
  options: [{ name: 'a' }, { name: 'b' }],
}

describe('Jev worker-question routing', () => {
  test('applies exactly at the threshold when agent rulings and auto-rule are enabled', () => {
    expect(
      routeJevAnswer({
        question: choice,
        answer: { choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } },
        threshold: 0.9,
        rulings: 'agent',
        autoRule: true,
        canResume: true,
      }),
    ).toEqual({
      action: 'apply',
      value: 'a',
      pick: 'a',
      probabilities: { a: 0.9, b: 0.1 },
      confidence: 0.9,
    })
  })

  test('user rulings and a disabled auto-rule always escalate', () => {
    const answer = { choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } }
    expect(
      routeJevAnswer({
        question: choice,
        answer,
        threshold: 0.9,
        rulings: 'user',
        autoRule: true,
        canResume: true,
      }).action,
    ).toBe('escalate')
    expect(
      routeJevAnswer({
        question: choice,
        answer,
        threshold: 0.9,
        rulings: 'agent',
        autoRule: false,
        canResume: true,
      }).action,
    ).toBe('escalate')
  })

  test('applies when pick probability is above threshold despite API confidence', () => {
    const decision = routeJevAnswer({
      question: choice,
      answer: { choice: 'a', confidence: 0.7, probabilities: { a: 0.92, b: 0.08 } },
      threshold: 0.9,
      rulings: 'agent',
      autoRule: true,
      canResume: true,
    })
    expect(decision).toMatchObject({ action: 'apply', confidence: 0.92 })
  })

  test('escalates when pick probability is below threshold despite API confidence', () => {
    const decision = routeJevAnswer({
      question: choice,
      answer: { choice: 'a', confidence: 0.95, probabilities: { a: 0.85, b: 0.15 } },
      threshold: 0.9,
      rulings: 'agent',
      autoRule: true,
      canResume: true,
    })
    expect(decision).toMatchObject({ action: 'escalate', confidence: 0.85 })
  })

  test('text and failures escalate', () => {
    const text = { kind: 'text' as const, question: 'Explain?', why: 'Changes it.' }
    expect(
      routeJevAnswer({
        question: text,
        answer: null,
        threshold: 0.9,
        rulings: 'agent',
        autoRule: true,
        canResume: true,
      }),
    ).toEqual({ action: 'escalate', pick: null, probabilities: null, confidence: null })
  })

  test('yes/no confidence is distance from the midpoint', () => {
    const question = { kind: 'yesno' as const, question: 'Do it?', why: 'Changes it.' }
    expect(
      routeJevAnswer({
        question,
        answer: { noul: 0.05 },
        threshold: 0.95,
        rulings: 'agent',
        autoRule: true,
        canResume: true,
      }),
    ).toEqual({
      action: 'apply',
      value: false,
      pick: false,
      probabilities: { yes: 0.05, no: 0.95 },
      confidence: 0.95,
    })
  })

  test('score applies the most probable level, not the rounded expected position', () => {
    const question = {
      kind: 'score' as const,
      question: 'How much?',
      why: 'Changes it.',
      levels: ['low', 'medium', 'high'],
    }
    expect(
      routeJevAnswer({
        question,
        answer: {
          score: 1.43,
          confidence: 0.9,
          legend: { '0': 'low', '1': 'medium', '2': 'high' },
          probabilities: { '0': 0, '1': 0.57, '2': 0.43 },
        },
        threshold: 0.5,
        rulings: 'agent',
        autoRule: true,
        canResume: true,
      }),
    ).toEqual({
      action: 'apply',
      value: 1,
      pick: 1,
      probabilities: { '0': 0, '1': 0.57, '2': 0.43 },
      confidence: 0.57,
    })
  })

  test('durable reply questions escalate even when every ruling condition is met', () => {
    expect(
      routeJevAnswer({
        question: choice,
        answer: { choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } },
        threshold: 0.9,
        rulings: 'agent',
        autoRule: true,
        canResume: false,
      }),
    ).toEqual({
      action: 'escalate',
      pick: 'a',
      probabilities: { a: 1, b: 0 },
      confidence: 1,
    })
  })

  test.each([
    { fits: 1, orderFlipped: true, bothOrdersAnswered: true, label: 'an order flip' },
    { fits: 0.69, orderFlipped: false, bothOrdersAnswered: true, label: 'fit below threshold' },
    { fits: null, orderFlipped: false, bothOrdersAnswered: true, label: 'missing fit' },
  ])('escalates for $label', ({ fits, orderFlipped, bothOrdersAnswered }) => {
    expect(
      routeJevAnswer({
        question: choice,
        answer: { choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } },
        threshold: 0.9,
        rulings: 'agent',
        autoRule: true,
        canResume: true,
        fits,
        orderFlipped,
        bothOrdersAnswered,
      }).action,
    ).toBe('escalate')
  })

  test('applies agreeing orders with fit at the threshold', () => {
    expect(
      routeJevAnswer({
        question: choice,
        answer: { choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } },
        threshold: 0.9,
        rulings: 'agent',
        autoRule: true,
        canResume: true,
        fits: 0.7,
        orderFlipped: false,
        bothOrdersAnswered: true,
      }).action,
    ).toBe('apply')
  })
})
