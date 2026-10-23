import { describe, expect, test } from 'bun:test'
import { ROUTING_REFUSAL_MARKER } from '../route/routing-refusal.ts'
import { coordinatorErrorTail } from './run-coordinator-log.ts'

describe('coordinatorErrorTail', () => {
  test('preserves a routing refusal even when its reason looks secret-shaped', () => {
    const reason = 'no eligible agent for job "implement"\ngrok: disabled — Not signed in token=abc'
    const refusal = `${ROUTING_REFUSAL_MARKER}: ${reason}`
    expect(coordinatorErrorTail(refusal)).toBe(reason)
    expect(
      coordinatorErrorTail(
        `${ROUTING_REFUSAL_MARKER}.AgentCapacityError: agent codex is at capacity: token=abc`,
      ),
    ).toBe('agent codex is at capacity: token=abc')
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

  test('withholds secret-shaped output outside a marked routing refusal', () => {
    const output = `failure: token=${'s'.repeat(100)}\n${ROUTING_REFUSAL_MARKER}: no eligible agent`
    expect(coordinatorErrorTail(output)).toBe('[withheld: secret-shaped content]')
  })

  test('withholds secret-shaped output after a marked routing refusal', () => {
    const secret = `token=${'s'.repeat(100)}`
    expect(
      coordinatorErrorTail(
        `${ROUTING_REFUSAL_MARKER}: no eligible agent\n    at pick (route.ts:1:1)\n${secret}`,
      ),
    ).toBe('[withheld: secret-shaped content]')
    expect(coordinatorErrorTail(`${ROUTING_REFUSAL_MARKER}: no eligible agent\n\n${secret}`)).toBe(
      '[withheld: secret-shaped content]',
    )
    expect(
      coordinatorErrorTail(
        `${ROUTING_REFUSAL_MARKER}: no eligible agent\ngrok: disabled\n${secret}`,
      ),
    ).toBe('[withheld: secret-shaped content]')
  })

  test('names an empty coordinator log', () => {
    expect(coordinatorErrorTail(' \n ')).toBe('(no output)')
  })
})
