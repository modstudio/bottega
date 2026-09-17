import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'
import { resolveGateTimingDirectory } from './gate-timing-directory.ts'
import { STATE_HOME_ENV } from './state-directory.ts'

const fixtures: string[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

describe('gate timing directory', () => {
  test('main checkout retains timings below the explicit state root', () => {
    const checkout = mkdtempSync(join(tmpdir(), 'gate-main-'))
    fixtures.push(checkout)
    mkdirSync(join(checkout, '.git'))
    expect(resolveGateTimingDirectory(checkout, { [STATE_HOME_ENV]: '/tmp/gate-state' })).toBe(
      '/tmp/gate-state/orchestrator/runs/gate-timings',
    )
  })

  test('linked checkout isolates timings below the OS temporary directory', () => {
    const checkout = mkdtempSync(join(tmpdir(), 'gate-linked-'))
    fixtures.push(checkout)
    writeFileSync(join(checkout, '.git'), 'gitdir: /tmp/main/.git/worktrees/test\n')
    const resolved = resolveGateTimingDirectory(checkout, {
      [STATE_HOME_ENV]: '/tmp/must-not-be-used',
    })
    expect(resolved.startsWith(join(tmpdir(), `${PLATFORM_SLUG}-gate-timings`))).toBe(true)
    expect(resolved).not.toContain('/tmp/must-not-be-used')
  })
})
