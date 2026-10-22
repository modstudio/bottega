import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { candidates, pick } from '../route/route.ts'
import { agentCommand, agentReadinessPresentation } from './agent-commands.ts'
import { refreshAgents, removeAgent } from './agent-registry.ts'

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
    `installed but not probed — ${PLATFORM_SLUG} agent show probe newcomer`,
    'disabled — retired after replacement',
    'ready',
  ])
})

test('agent add persists job, concurrency, and metered-routing flags', async () => {
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
        '--route-metered',
        'true',
        '--trains-on-inputs',
        'true',
      ],
      { log: (value) => output.push(value), setExitCode: () => {} },
    )

    expect(JSON.parse(output[0]!)).toMatchObject({
      jobs: '["file-question"]',
      preferred_jobs: '["file-question"]',
      max_concurrent: 1,
      route_metered: 1,
      trains_on_inputs: 1,
    })
  } finally {
    removeAgent('add-flags-test')
  }
})

test('agent commands store and clear only an endpoint secret name', async () => {
  const output: string[] = []
  try {
    await agentCommand(
      [
        'agent',
        'add',
        'endpoint-key-test',
        '--harness',
        'goose',
        '--backend',
        'vendor',
        '--model',
        'test-model',
        '--base-url',
        'https://example.test/v1',
        '--api-key-secret',
        'SEALED_ENDPOINT_KEY',
      ],
      { log: (value) => output.push(value), setExitCode: () => {} },
    )
    expect(JSON.parse(output.pop()!)).toMatchObject({ api_key_secret: 'SEALED_ENDPOINT_KEY' })

    await agentCommand(['agent', 'set', 'endpoint-key-test', '--clear-api-key-secret'], {
      log: (value) => output.push(value),
      setExitCode: () => {},
    })
    expect(JSON.parse(output.pop()!)).toMatchObject({ api_key_secret: null })
  } finally {
    removeAgent('endpoint-key-test')
  }
})

test('a keyed add defaults to metered, stays out of automatic routing, and may be named', async () => {
  const name = 'keyed-routing-test'
  const output: string[] = []
  try {
    await agentCommand(
      [
        'agent',
        'add',
        name,
        '--harness',
        'codex',
        '--backend',
        'vendor',
        '--model',
        'test-model',
        '--base-url',
        'https://example.test/v1',
        '--api-key-secret',
        'SEALED_ENDPOINT_KEY',
        '--context-tokens',
        '200000',
      ],
      { log: (value) => output.push(value), setExitCode: () => {} },
    )
    expect(JSON.parse(output[0]!)).toMatchObject({ billing: 'metered' })
    const row = db().query('SELECT caps FROM agent WHERE name=?').get(name) as { caps: string }
    db()
      .query('UPDATE agent SET caps=?,probed_at=?,probe_result=? WHERE name=?')
      .run(
        JSON.stringify({ ...JSON.parse(row.caps), replyFile: true }),
        '2026-01-01T00:00:00.000Z',
        JSON.stringify({ ok: true }),
        name,
      )
    refreshAgents()
    expect(candidates('summarize').find((candidate) => candidate.agent === name)).toMatchObject({
      eligible: false,
      why: 'metered billing is not opted in for automatic routing',
    })
    expect(pick('summarize', name)).toEqual({ agent: name, reason: 'explicit --agent' })
  } finally {
    removeAgent(name)
  }
})

test('agent set accepts validated billing values', async () => {
  const output: string[] = []
  try {
    await agentCommand(
      [
        'agent',
        'add',
        'billing-set-test',
        '--harness',
        'codex',
        '--backend',
        'vendor',
        '--model',
        'test-model',
      ],
      { log: (value) => output.push(value), setExitCode: () => {} },
    )
    await agentCommand(['agent', 'set', 'billing-set-test', '--billing', 'free'], {
      log: (value) => output.push(value),
      setExitCode: () => {},
    })
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ billing: 'free' })
    await expect(
      agentCommand(['agent', 'set', 'billing-set-test', '--billing', 'invalid'], {
        log: () => {},
        setExitCode: () => {},
      }),
    ).rejects.toThrow('unknown billing "invalid"')
  } finally {
    removeAgent('billing-set-test')
  }
})

test('agent set validates and clears the metered-routing opt-in', async () => {
  const output: string[] = []
  try {
    await agentCommand(
      [
        'agent',
        'add',
        'metered-route-set-test',
        '--harness',
        'codex',
        '--backend',
        'vendor',
        '--model',
        'test-model',
        '--route-metered',
        'true',
      ],
      { log: (value) => output.push(value), setExitCode: () => {} },
    )
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ route_metered: 1 })
    await agentCommand(['agent', 'set', 'metered-route-set-test', '--route-metered', 'false'], {
      log: (value) => output.push(value),
      setExitCode: () => {},
    })
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ route_metered: 0 })
    await expect(
      agentCommand(['agent', 'set', 'metered-route-set-test', '--route-metered', 'sometimes'], {
        log: () => {},
        setExitCode: () => {},
      }),
    ).rejects.toThrow('--route-metered must be true or false')
  } finally {
    removeAgent('metered-route-set-test')
  }
})
