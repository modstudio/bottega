import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decidePreflight, preflightRungs, type ReleasePreflightRung } from './release-preflight.ts'

const rungs: ReleasePreflightRung[] = [
  {
    name: 'hosted-hub',
    branch: 'main',
    preflight: 'scripts/deploy/hosted-preflight hub',
    live: 'read hub endpoint',
    requiredWhenChanged: ['hub/**'],
  },
]

describe('release preflight', () => {
  test('a change requiring no rung produces nothing to probe', () => {
    expect(preflightRungs(rungs, ['docs/guide.md'], new Map(), 'main')).toEqual([])
  })

  test('expired credentials on a required rung refuse with the probe remedy', () => {
    const decision = decidePreflight([
      {
        rung: 'hosted-hub',
        preflight: {
          ok: false,
          stderr:
            'REFUSE: fly could not list secrets for the hosted app; run fly auth login (or restore Fly access) and retry',
        },
        live: { ok: true, stderr: '' },
      },
    ])
    expect(decision.ok).toBeFalse()
    if (decision.ok) return
    expect(decision.refusal).toContain('hosted-hub')
    expect(decision.refusal).toContain('credentials probe')
    expect(decision.refusal).toContain('fly auth login')
    expect(decision.refusal).toEndWith(`then ${PLATFORM_SLUG} pr merge <target> --release-required`)
  })

  test('a rung without a credential preflight proceeds after its live probe with a notice', () => {
    expect(decidePreflight([{ rung: 'production', live: { ok: true, stderr: '' } }])).toEqual({
      ok: true,
      notices: ['credentials not checked for production'],
    })
  })

  test('a failing live probe refuses', () => {
    const decision = decidePreflight([
      {
        rung: 'hosted-hub',
        preflight: { ok: true, stderr: '' },
        live: { ok: false, stderr: 'curl: endpoint unavailable' },
      },
    ])
    expect(decision.ok).toBeFalse()
    if (decision.ok) return
    expect(decision.refusal).toContain('endpoint probe')
    expect(decision.refusal).toContain('curl: endpoint unavailable')
  })
})
