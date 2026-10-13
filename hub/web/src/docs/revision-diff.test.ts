import { describe, expect, test } from 'bun:test'
import { revisionComparison, shapeRevisionDiff } from './revision-diff.ts'

describe('revision comparison', () => {
  test('compares an older revision with the next newer revision and the newest with current', () => {
    expect(revisionComparison([30, 20, 10], 10)).toEqual({ kind: 'revision', id: 20 })
    expect(revisionComparison([30, 20, 10], 20)).toEqual({ kind: 'revision', id: 30 })
    expect(revisionComparison([30, 20, 10], 30)).toEqual({ kind: 'current' })
    expect(revisionComparison([30, 20, 10], 99)).toBeNull()
    expect(revisionComparison(['new', 'old'], 'old')).toEqual({ kind: 'revision', id: 'new' })
  })
})

describe('revision diff shaping', () => {
  test('keeps bounded context and numbers added and removed lines in their respective bodies', () => {
    const version = ['zero', 'one', 'two', 'old', 'four', 'five', 'six', 'seven'].join('\n')
    const replacement = [
      'zero',
      'one',
      'two',
      'new a',
      'new b',
      'four',
      'five',
      'six',
      'seven',
    ].join('\n')

    expect(shapeRevisionDiff(version, replacement)).toEqual({
      identical: false,
      hunks: [
        [
          { kind: 'context', mark: ' ', number: 1, text: 'zero' },
          { kind: 'context', mark: ' ', number: 2, text: 'one' },
          { kind: 'context', mark: ' ', number: 3, text: 'two' },
          { kind: 'removed', mark: '-', number: 4, text: 'old' },
          { kind: 'added', mark: '+', number: 4, text: 'new a' },
          { kind: 'added', mark: '+', number: 5, text: 'new b' },
          { kind: 'context', mark: ' ', number: 6, text: 'four' },
          { kind: 'context', mark: ' ', number: 7, text: 'five' },
          { kind: 'context', mark: ' ', number: 8, text: 'six' },
        ],
      ],
    })
  })

  test('reports identical bodies without hunks', () => {
    expect(shapeRevisionDiff('same\n', 'same\n')).toEqual({ identical: true, hunks: [] })
  })
})
