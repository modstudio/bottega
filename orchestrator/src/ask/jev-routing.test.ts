import { describe, expect, test } from 'bun:test'
import { routeJevAnswer } from './jev-routing.ts'

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
      }),
    ).toEqual({ action: 'apply', value: 'a', confidence: 0.9 })
  })

  test('user rulings and a disabled auto-rule always escalate', () => {
    const answer = { choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } }
    expect(
      routeJevAnswer({ question: choice, answer, threshold: 0.9, rulings: 'user', autoRule: true })
        .action,
    ).toBe('escalate')
    expect(
      routeJevAnswer({
        question: choice,
        answer,
        threshold: 0.9,
        rulings: 'agent',
        autoRule: false,
      }).action,
    ).toBe('escalate')
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
      }),
    ).toEqual({ action: 'escalate', confidence: null })
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
      }),
    ).toEqual({ action: 'apply', value: false, confidence: 0.95 })
  })
})
