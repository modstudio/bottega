import { describe, expect, test } from 'bun:test'
import { coordinatorErrorTail, isRoutingRefusal } from './run-coordinator-log.ts'

describe('coordinatorErrorTail', () => {
  test('preserves a routing refusal even when its reason looks secret-shaped', () => {
    const refusal =
      'no eligible agent for job "implement"\ngrok: disabled — Not signed in token=abc'
    expect(isRoutingRefusal(refusal)).toBe(true)
    expect(coordinatorErrorTail(refusal)).toBe(refusal)
  })
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
