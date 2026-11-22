import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { RELEASE_LIVE_READING_TIMEOUT_MS } from './live-reading.ts'
import {
  decidePreflight,
  missingLiveProbeResult,
  preflightRungs,
  type ReleasePreflightRung,
  type ReleaseProbeCapture,
} from './release-preflight.ts'
import { runProbe } from './release-preflight-adapter.ts'

const rungs: ReleasePreflightRung[] = [
  {
    name: 'hosted-hub',
    branch: 'main',
    preflight: 'scripts/deploy/hosted-preflight hub',
    live: 'read hub endpoint',
    requiredWhenChanged: ['hub/**'],
  },
]

function capture(
  command: string,
  overrides: Partial<Omit<ReleaseProbeCapture, 'command'>> = {},
): ReleaseProbeCapture {
  return {
    command,
    exitCode: 0,
    output: '',
    timedOut: false,
    timeoutMs: RELEASE_LIVE_READING_TIMEOUT_MS,
    ...overrides,
  }
}

describe('release preflight', () => {
  test('a change requiring no rung produces nothing to probe', () => {
    expect(preflightRungs(rungs, ['docs/guide.md'], new Map(), 'main')).toEqual([])
  })

  test('expired credentials on a required rung refuse with the probe remedy', () => {
    const command = 'scripts/deploy/hosted-preflight hub'
    const decision = decidePreflight([
      {
        rung: 'hosted-hub',
        preflight: capture(command, {
          exitCode: 1,
          output:
            'REFUSE: fly could not list secrets for the hosted app; run fly auth login (or restore Fly access) and retry',
        }),
        live: capture('read hub endpoint'),
      },
    ])
    expect(decision.ok).toBeFalse()
    if (decision.ok) return
    expect(decision.refusal).toContain('hosted-hub')
    expect(decision.refusal).toContain('credentials probe')
    expect(decision.refusal).toContain(JSON.stringify(command))
    expect(decision.refusal).toContain('fly auth login')
    expect(decision.refusal).toEndWith(`then ${PLATFORM_SLUG} pr merge <target> --release-required`)
  })

  test('a rung without a credential preflight proceeds after its live probe with a notice', () => {
    expect(decidePreflight([{ rung: 'production', live: capture('read endpoint') }])).toEqual({
      ok: true,
      notices: ['credentials not checked for production'],
    })
  })

  test('a failing live probe names its command and uses a generic command remedy', () => {
    const command = 'curl -fsS https://hub.example/live'
    const decision = decidePreflight([
      {
        rung: 'hosted-hub',
        preflight: capture('check credentials'),
        live: capture(command, { exitCode: 22, output: 'curl: endpoint unavailable' }),
      },
    ])
    expect(decision.ok).toBeFalse()
    if (decision.ok) return
    expect(decision.refusal).toContain('endpoint probe')
    expect(decision.refusal).toContain(JSON.stringify(command))
    expect(decision.refusal).toContain('curl: endpoint unavailable')
    expect(decision.refusal).toContain(`cleared by: make \`${command}\` succeed`)
  })

  test('a failed probe with empty output names its exit code instead of stderr absence', () => {
    const decision = decidePreflight([
      { rung: 'hosted-hub', live: capture('read endpoint', { exitCode: 7 }) },
    ])
    expect(decision.ok).toBeFalse()
    if (decision.ok) return
    expect(decision.refusal).toContain('exited 7 with no output')
    expect(decision.refusal).not.toContain('(no stderr)')
  })

  test('a timed-out probe names the shared live-reading timeout', () => {
    const decision = decidePreflight([
      {
        rung: 'hosted-hub',
        live: capture('read endpoint', { exitCode: -1, timedOut: true }),
      },
    ])
    expect(decision.ok).toBeFalse()
    if (decision.ok) return
    expect(decision.refusal).toContain(`timed out after ${RELEASE_LIVE_READING_TIMEOUT_MS}ms`)
  })

  test('a required rung without a live declaration names the register edit', () => {
    const rung: ReleasePreflightRung = {
      name: 'production',
      branch: 'main',
      requiredWhenChanged: ['hub/**'],
    }
    const decision = decidePreflight([missingLiveProbeResult('fixture', rung, [rung])])
    expect(decision.ok).toBeFalse()
    if (decision.ok) return
    expect(decision.refusal).toContain('release rung production')
    expect(decision.refusal).toContain('declare live or liveVersion')
    expect(decision.refusal).toContain(`${PLATFORM_SLUG} project set fixture --settings`)
  })

  test('probe capture redacts secret-shaped command output', () => {
    const result = runProbe('check credentials', '/fixture', () => ({
      exitCode: 1,
      output: 'failed token=credential',
      timedOut: false,
    }))
    expect(result?.output).toBe('failed [withheld: assignment]')
  })
})
