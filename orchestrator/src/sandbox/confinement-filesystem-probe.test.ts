import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexWriterProbeOutput } from './confinement-codex-writer-probe.ts'
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

describe('Codex writer git cells', () => {
  test('records packed-refs operations as intended refusals', () => {
    const { commands } = codexWriterProbeOutput(`pwd=ran
git-status=ran
git-commit=ran
git-log=ran
git-branch-delete=refused
git-pack-refs=refused`)

    expect(commands['git branch -d']).toEqual({
      status: 'refused',
      reason: 'packed-refs.lock: Operation not permitted',
    })
    expect(commands['git pack-refs']).toEqual({
      status: 'refused',
      reason: 'packed-refs.lock: Operation not permitted',
    })
  })

  test('fails a packed-refs cell when the command succeeds', () => {
    const { commands } = codexWriterProbeOutput('git-branch-delete=ran\ngit-pack-refs=ran')

    expect(commands['git branch -d']?.status).toBe('failed')
    expect(commands['git pack-refs']?.status).toBe('failed')
  })
})
