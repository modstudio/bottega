import { expect, test } from 'bun:test'
import { agentCommand, agentReadinessPresentation } from './agent-commands.ts'
import { removeAgent } from './agent-registry.ts'

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

test('agent add persists job and concurrency flags', async () => {
  const output: string[] = []
  try {
    await agentCommand(
      [
        'agent',
        'add',
        'add-flags-test',
        '--harness',
        'codex',
        '--backend',
        'vendor',
        '--model',
        'test-model',
        '--jobs',
        'file-question',
        '--prefer',
        'file-question',
        '--max-concurrent',
        '1',
      ],
      { log: (value) => output.push(value), setExitCode: () => {} },
    )

    expect(JSON.parse(output[0]!)).toMatchObject({
      jobs: '["file-question"]',
      preferred_jobs: '["file-question"]',
      max_concurrent: 1,
    })
  } finally {
    removeAgent('add-flags-test')
  }
})
