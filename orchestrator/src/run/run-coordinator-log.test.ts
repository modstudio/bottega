import { describe, expect, test } from 'bun:test'
import { coordinatorErrorTail } from './run-coordinator-log.ts'

describe('coordinatorErrorTail', () => {
  test('keeps the bounded end of coordinator output', () => {
    const tail = coordinatorErrorTail(`first line\n${'x'.repeat(100)}\nlast line`, 64)
    expect(tail.length).toBe(64)
    expect(tail).toEndWith('last line')
    expect(tail).not.toContain('first line')
  })

  test('withholds secret-shaped coordinator output before bounding it', () => {
    expect(coordinatorErrorTail(`failure: token=${'s'.repeat(100)}`, 24)).toBe(
      '[withheld: secret-shaped content]',
    )
  })

  test('names an empty coordinator log', () => {
    expect(coordinatorErrorTail(' \n ')).toBe('(no output)')
  })
})
