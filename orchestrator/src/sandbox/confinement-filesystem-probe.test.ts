import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeVerdict } from './confinement-filesystem-probe.ts'

const ran = { status: 'ran', reason: 'exit 0' } as const

test('confinement probe command and report labels contain no literal task key', () => {
  for (const file of ['confinement-filesystem-probe.ts', 'confinement-report.ts']) {
    const source = readFileSync(join(import.meta.dir, file), 'utf8')
    expect(source).not.toMatch(/[A-Z]+-[0-9]+/)
  }
})

describe('probeVerdict', () => {
  test('reports an unexpectedly readable denied target', () => {
    expect(
      probeVerdict(
        [{ name: 'secret', path: '/secret', expected: 'denied' }],
        { secret: 'readable' },
        { command: ran },
      ),
    ).toEqual({
      status: 'readable',
      reason: 'one or more denied paths were unexpectedly readable',
    })
  })

  test('reports an unexpectedly denied readable target', () => {
    expect(
      probeVerdict(
        [{ name: 'tree', path: '/tree', expected: 'readable' }],
        { tree: 'denied' },
        { command: ran },
      ),
    ).toEqual({ status: 'failed', reason: 'one or more expected-readable paths were denied' })
  })

  test('reports a failed command after expected path measurements', () => {
    expect(
      probeVerdict(
        [{ name: 'secret', path: '/secret', expected: 'denied' }],
        { secret: 'denied' },
        { command: { status: 'failed', reason: 'exit 1' } },
      ),
    ).toEqual({ status: 'failed', reason: 'command cell command failed: exit 1' })
  })

  test('reports a missing measurement as not covered', () => {
    expect(
      probeVerdict(
        [{ name: 'secret', path: '/secret', expected: 'denied' }],
        { secret: 'not covered' },
        { command: ran },
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
        { command: ran },
      ),
    ).toEqual({ status: 'denied' })
  })

  test('keeps a readable breach reason when a command cell also fails', () => {
    expect(
      probeVerdict(
        [{ name: 'secret', path: '/secret', expected: 'denied' }],
        { secret: 'readable' },
        { network: { status: 'failed', reason: 'exit 1' } },
      ),
    ).toEqual({
      status: 'readable',
      reason: 'one or more denied paths were unexpectedly readable',
    })
  })

  test('names the failed command cell after successful filesystem measurements', () => {
    expect(
      probeVerdict(
        [{ name: 'secret', path: '/secret', expected: 'denied' }],
        { secret: 'denied' },
        { 'non-loopback outbound': { status: 'failed', reason: 'exit 1' } },
      ),
    ).toEqual({
      status: 'failed',
      reason: 'command cell non-loopback outbound failed: exit 1',
    })
  })
})
