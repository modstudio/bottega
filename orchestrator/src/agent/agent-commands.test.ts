import { expect, test } from 'bun:test'
import { agentReadinessPresentation } from './agent-commands.ts'

test('agent presentation distinguishes installation, probe, disabled, and ready states', () => {
  const fixed = [
    {
      name: 'missing',
      enabled: true,
      disabledReason: null,
      executableFound: false,
      probedAt: null,
      available: false,
      unavailableReason: 'not installed',
    },
    {
      name: 'newcomer',
      enabled: true,
      disabledReason: null,
      executableFound: true,
      probedAt: null,
      available: true,
      unavailableReason: null,
    },
    {
      name: 'retired',
      enabled: false,
      disabledReason: 'retired after replacement',
      executableFound: true,
      probedAt: '2026-10-05T00:00:00.000Z',
      available: false,
      unavailableReason: 'disabled — retired after replacement',
    },
    {
      name: 'usable',
      enabled: true,
      disabledReason: null,
      executableFound: true,
      probedAt: '2026-10-05T00:00:00.000Z',
      available: true,
      unavailableReason: null,
    },
  ]

  expect(fixed.map(agentReadinessPresentation)).toEqual([
    'not installed',
    'installed but not probed — orch agent probe newcomer',
    'disabled — retired after replacement',
    'ready',
  ])
})
