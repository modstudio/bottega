import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideOutboundRefusal, probeVerdict } from './confinement-filesystem-probe.ts'

const ran = { status: 'ran', reason: 'exit 0' } as const

describe('decideOutboundRefusal', () => {
  test.each([
    [{ status: 403 }, { refused: true, reason: 'refused: status 403' }],
    [{ errorCode: 'ECONNRESET' }, { refused: true, reason: 'refused: connection reset' }],
    [{ status: 200 }, { refused: false, reason: 'status 200' }],
    [{ status: 502 }, { refused: false, reason: 'status 502' }],
    [{ errorCode: 'TimeoutError' }, { refused: false, reason: 'error TimeoutError' }],
    [{ errorCode: 'AbortError' }, { refused: false, reason: 'error AbortError' }],
    [{ errorCode: 'UNKNOWN' }, { refused: false, reason: 'error UNKNOWN' }],
  ] as const)('decides whether %o proves proxy refusal', (input, expected) => {
    expect(decideOutboundRefusal(input)).toEqual(expected)
  })
})

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

  test('reports a missing expected-readable target as not covered and names it', () => {
    expect(
      probeVerdict(
        [{ name: 'running package.json', path: '/missing/package.json', expected: 'readable' }],
        { 'running package.json': 'denied' },
        { command: ran },
        ['running package.json'],
      ),
    ).toEqual({
      status: 'not covered',
      reason: 'expected-readable target missing on the host: running package.json',
    })
  })

  test('reports a readable denied target even when an expected-readable target is missing', () => {
    expect(
      probeVerdict(
        [
          { name: 'secret', path: '/secret', expected: 'denied' },
          { name: 'running package.json', path: '/missing/package.json', expected: 'readable' },
        ],
        { secret: 'readable', 'running package.json': 'denied' },
        { command: ran },
        ['running package.json'],
      ),
    ).toEqual({
      status: 'readable',
      reason:
        'one or more denied paths were unexpectedly readable; expected-readable target missing on the host: running package.json',
    })
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
