import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { type BinaryEntries, dispatchBinary } from './dispatch.ts'

function entries(calls: string[]): BinaryEntries {
  const call = (owner: string) => async (argv: string[]) => {
    calls.push(`${owner} ${argv.join(' ')}`)
    return 0
  }
  return {
    orch: call('orchestrator:'),
    hub: call('hub:'),
    orchOutbox: async () => [],
    hubOutbox: async () => [],
    hubOutboxSummaryLines: async () => [],
    runExec: call('runExec'),
    askProxy: call('askProxy'),
    retrievalSearch: async (argv) => {
      calls.push(`retrievalSearch ${argv.join(' ')}`)
    },
    checkAttribution: call('checkAttribution'),
    schemaCheck: call('schemaCheck'),
  }
}

test('record outbox combines owner-qualified rows and routes qualified actions', async () => {
  const calls: string[] = []
  const dispatch = entries(calls)
  dispatch.orchOutbox = async () => [{ id: 7, kind: 'score' }]
  let hubRows: Record<string, unknown>[] = [{ id: 'change-1', table_name: 'task' }]
  dispatch.hubOutbox = async () => {
    const snapshot = hubRows
    hubRows = []
    return snapshot
  }
  dispatch.hubOutboxSummaryLines = async (rows) => [`hub summary rows=${rows.length}`]
  const lines: string[] = []
  const originalLog = console.log
  console.log = (value) => lines.push(String(value))
  try {
    expect(await dispatchBinary(['record', 'outbox', '--json'], dispatch, () => '')).toBe(0)
    expect(JSON.parse(lines[0]!)).toEqual([
      { id: 'orch:7', kind: 'score', owner: 'orch' },
      { id: 'hub:change-1', table_name: 'task', owner: 'hub' },
    ])
    lines.length = 0
    hubRows = [{ id: 'change-1', table_name: 'task' }]
    expect(await dispatchBinary(['record', 'outbox'], dispatch, () => '')).toBe(0)
    expect(lines[0]).toBe('hub summary rows=1')
  } finally {
    console.log = originalLog
  }
  expect(
    await dispatchBinary(['record', 'outbox', 'retry', 'hub:change-1'], dispatch, () => ''),
  ).toBe(0)
  expect(calls).toEqual(['hub: outbox retry change-1'])
})

test('record outbox trace reaches the hub owner with its public route', async () => {
  const calls: string[] = []
  const dispatch = entries(calls)
  dispatch.hub = async (argv, invocation) => {
    calls.push(
      `${argv.join(' ')} | ${invocation?.ownerPath.join(' ')} -> ${invocation?.publicPath.join(' ')}`,
    )
    return 0
  }
  expect(
    await dispatchBinary(['record', 'outbox', 'trace', '--row', 'entry-1'], dispatch, () => ''),
  ).toBe(0)
  expect(calls).toEqual(['outbox trace --row entry-1 | outbox trace -> record outbox trace'])
})

test('record outbox refuses bare ids and hands every verb to the owning command', async () => {
  const errors: string[] = []
  const calls: string[] = []
  const originalError = console.error
  console.error = (value) => errors.push(String(value))
  try {
    expect(
      await dispatchBinary(['record', 'outbox', 'retry', '17'], entries(calls), () => ''),
    ).toBe(2)
    await dispatchBinary(['record', 'outbox', 'discard', 'orch:17'], entries(calls), () => '')
    for (const malformed of ['orch:1e2', 'orch:0x10'])
      expect(
        await dispatchBinary(['record', 'outbox', 'retry', malformed], entries(calls), () => ''),
      ).toBe(2)
  } finally {
    console.error = originalError
  }
  expect(errors[0]).toContain(`${PLATFORM_SLUG} record outbox`)
  expect(errors[1]).toContain('decimal row numbers')
  expect(calls).toEqual(['orchestrator: record outbox discard 17'])
})

test('routes public and composite commands with unchanged remaining arguments', async () => {
  const calls: string[] = []
  const dispatch = entries(calls)
  expect(await dispatchBinary(['run', 'result', '42', '--json'], dispatch, () => '')).toBe(0)
  expect(await dispatchBinary(['machine', 'doctor'], dispatch, () => '')).toBe(0)
  expect(calls).toEqual(['orchestrator: result 42 --json', 'orchestrator: doctor', 'hub: doctor'])
})

test('unknown groups fail without entering a concern', async () => {
  const calls: string[] = []
  expect(await dispatchBinary(['unknown'], entries(calls), () => '')).toBe(2)
  expect(calls).toEqual([])
})

test.each(['orch', 'hub'] as const)('does not route a %s leading token', async (legacy) => {
  const calls: string[] = []
  const errors: string[] = []
  const originalError = console.error
  console.error = (value) => errors.push(String(value))
  try {
    expect(await dispatchBinary([legacy, 'jobs'], entries(calls), () => '')).toBe(2)
  } finally {
    console.error = originalError
  }
  expect(calls).toEqual([])
  expect(errors.some((line) => line.includes('unknown command'))).toBe(true)
})

test.each([
  [7, 0, 7],
  [0, 9, 9],
] as const)(
  'machine doctor reports either owner failure and runs both',
  async (orch, hub, result) => {
    const calls: string[] = []
    const dispatch = entries(calls)
    dispatch.orch = async (argv) => {
      calls.push(`orchestrator: ${argv.join(' ')}`)
      return orch
    }
    dispatch.hub = async (argv) => {
      calls.push(`hub: ${argv.join(' ')}`)
      return hub
    }
    expect(await dispatchBinary(['machine', 'doctor'], dispatch, () => '')).toBe(result)
    expect(calls).toEqual(['orchestrator: doctor', 'hub: doctor'])
  },
)

test('composite options reach only the owner that declares them', async () => {
  const calls: string[] = []
  expect(
    await dispatchBinary(
      ['record', 'sync', '--backfill', '--since', '2026-01-01T00:00:00Z'],
      entries(calls),
      () => '',
    ),
  ).toBe(0)
  expect(calls).toEqual([
    'orchestrator: sync --backfill',
    'hub: collect --since 2026-01-01T00:00:00Z',
  ])
})

test('composites fail fast except for doctor and never start collect watch', async () => {
  const calls: string[] = []
  const dispatch = entries(calls)
  dispatch.orch = async (argv) => {
    calls.push(`orchestrator: ${argv.join(' ')}`)
    return 7
  }
  expect(await dispatchBinary(['record', 'sync'], dispatch, () => '')).toBe(7)
  expect(calls).toEqual(['orchestrator: sync'])
  expect(await dispatchBinary(['record', 'sync', '--watch'], entries([]), () => '')).toBe(2)
})
