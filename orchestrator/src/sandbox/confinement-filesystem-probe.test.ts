import { describe, expect, test } from 'bun:test'
import { probeVerdict } from './confinement-filesystem-probe.ts'

const ran = { status: 'ran', reason: 'exit 0' } as const

describe('probeVerdict', () => {
  test('reports an unexpectedly readable denied target', () => {
    expect(
      probeVerdict(
        [{ name: 'secret', path: '/secret', expected: 'denied' }],
        { secret: 'readable' },
        ran,
      ),
    ).toEqual({ status: 'readable' })
  })

  test('reports an unexpectedly denied readable target', () => {
    expect(
      probeVerdict(
        [{ name: 'tree', path: '/tree', expected: 'readable' }],
        { tree: 'denied' },
        ran,
      ),
    ).toEqual({ status: 'failed', reason: 'one or more expected-readable paths were denied' })
  })

  test('reports a failed command after expected path measurements', () => {
    expect(
      probeVerdict(
        [{ name: 'secret', path: '/secret', expected: 'denied' }],
        { secret: 'denied' },
        { status: 'failed', reason: 'exit 1' },
      ),
    ).toEqual({ status: 'failed', reason: 'the real CLI verb failed' })
  })

  test('reports a missing measurement as not covered', () => {
    expect(
      probeVerdict(
        [{ name: 'secret', path: '/secret', expected: 'denied' }],
        { secret: 'not covered' },
        ran,
      ),
    ).toEqual({
      status: 'not covered',
      reason: 'one or more filesystem probe output lines were missing',
    })
  })

  test('reports all expected measurements as denied', () => {
    expect(
      probeVerdict(
        [
          { name: 'secret', path: '/secret', expected: 'denied' },
          { name: 'tree', path: '/tree', expected: 'readable' },
        ],
        { secret: 'denied', tree: 'readable' },
        ran,
      ),
    ).toEqual({ status: 'denied' })
  })
})
