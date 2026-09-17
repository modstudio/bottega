import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'
import { resolveGateTimingDirectory } from './gate-timing-directory.ts'
import { STATE_HOME_ENV } from './state-directory.ts'

describe('gate timing directory', () => {
  test('main checkout retains timings below the explicit state root', () => {
    expect(
      resolveGateTimingDirectory(
        '/checkout/main',
        false,
        { [STATE_HOME_ENV]: '/tmp/gate-state' },
        '/temporary',
      ),
    ).toBe('/tmp/gate-state/orchestrator/runs/gate-timings')
  })

  test('linked checkout isolates timings below the OS temporary directory', () => {
    const resolved = resolveGateTimingDirectory(
      '/checkout/linked',
      true,
      { [STATE_HOME_ENV]: '/tmp/must-not-be-used' },
      '/temporary',
    )
    expect(resolved.startsWith(join('/temporary', `${PLATFORM_SLUG}-gate-timings`))).toBe(true)
    expect(resolved).not.toContain('/tmp/must-not-be-used')
  })
})
