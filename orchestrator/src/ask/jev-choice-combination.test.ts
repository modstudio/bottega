import { describe, expect, test } from 'bun:test'
import { combineJevChoice } from './jev-choice-combination.ts'

const answer = (choice: string, a: number, b: number) => ({
  choice,
  confidence: Math.max(a, b),
  probabilities: { a, b },
})

describe('Jev choice combination', () => {
  test('averages orders and keeps the averaged pick probability as confidence', () => {
    const combined = combineJevChoice({
      options: ['a', 'b'],
      forward: answer('a', 0.8, 0.2),
      reversed: answer('a', 0.6, 0.4),
    })
    expect(combined.answer?.choice).toBe('a')
    expect(combined.answer?.probabilities.a).toBeCloseTo(0.7)
    expect(combined.answer?.probabilities.b).toBeCloseTo(0.3)
    expect(combined.answer?.confidence).toBeCloseTo(0.7)
    expect(combined).toMatchObject({ orderFlipped: false, bothOrdersAnswered: true })
  })

  test('takes the forward pick when averaged probabilities tie', () => {
    expect(
      combineJevChoice({
        options: ['a', 'b'],
        forward: answer('a', 0.8, 0.2),
        reversed: answer('b', 0.2, 0.8),
      }).answer?.choice,
    ).toBe('a')
  })

  test('reports an order flip', () => {
    expect(
      combineJevChoice({
        options: ['a', 'b'],
        forward: answer('a', 0.7, 0.3),
        reversed: answer('b', 0.4, 0.6),
      }).orderFlipped,
    ).toBe(true)
  })

  test('keeps the available advice when one order is missing', () => {
    expect(combineJevChoice({ options: ['a', 'b'], reversed: answer('b', 0.2, 0.8) })).toEqual({
      answer: answer('b', 0.2, 0.8),
      fits: null,
      orderFlipped: null,
      bothOrdersAnswered: false,
    })
  })
})
