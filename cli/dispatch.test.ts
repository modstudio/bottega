import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { type BinaryEntries, dispatchBinary } from './dispatch.ts'

function entries(calls: string[]): BinaryEntries {
  const call = (owner: string) => async (argv: string[]) => {
    calls.push(`${owner} ${argv.join(' ')}`)
    return 0
  }
  return {
    orch: call('orch'),
    hub: call('hub'),
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
    expect(
      await dispatchBinary(['record', 'outbox', '--json'], PLATFORM_SLUG, dispatch, () => ''),
    ).toBe(0)
    expect(JSON.parse(lines[0]!)).toEqual([
      { id: 'orch:7', kind: 'score', owner: 'orch' },
      { id: 'hub:change-1', table_name: 'task', owner: 'hub' },
    ])
    lines.length = 0
    hubRows = [{ id: 'change-1', table_name: 'task' }]
    expect(await dispatchBinary(['record', 'outbox'], PLATFORM_SLUG, dispatch, () => '')).toBe(0)
    expect(lines[0]).toBe('hub summary rows=1')
  } finally {
    console.log = originalLog
  }
  expect(
    await dispatchBinary(
      ['record', 'outbox', 'retry', 'hub:change-1'],
      PLATFORM_SLUG,
      dispatch,
      () => '',
    ),
  ).toBe(0)
  expect(calls).toEqual(['hub outbox retry change-1'])
})

test('record outbox refuses bare ids and hands every verb to the owning command', async () => {
  const errors: string[] = []
  const calls: string[] = []
  const originalError = console.error
  console.error = (value) => errors.push(String(value))
  try {
    expect(
      await dispatchBinary(
        ['record', 'outbox', 'retry', '17'],
        PLATFORM_SLUG,
        entries(calls),
        () => '',
      ),
    ).toBe(2)
    await dispatchBinary(
      ['record', 'outbox', 'discard', 'orch:17'],
      PLATFORM_SLUG,
      entries(calls),
      () => '',
    )
    for (const malformed of ['orch:1e2', 'orch:0x10'])
      expect(
        await dispatchBinary(
          ['record', 'outbox', 'retry', malformed],
          PLATFORM_SLUG,
          entries(calls),
          () => '',
        ),
      ).toBe(2)
  } finally {
    console.error = originalError
  }
  expect(errors[0]).toContain(`${PLATFORM_SLUG} record outbox`)
  expect(errors[1]).toContain('decimal row numbers')
  expect(calls).toEqual(['orch record outbox discard 17'])
})

test('routes public and composite commands with unchanged remaining arguments', async () => {
  const calls: string[] = []
  const dispatch = entries(calls)
  expect(
    await dispatchBinary(['run', 'result', '42', '--json'], PLATFORM_SLUG, dispatch, () => ''),
  ).toBe(0)
  expect(await dispatchBinary(['machine', 'doctor'], PLATFORM_SLUG, dispatch, () => '')).toBe(0)
  expect(calls).toEqual(['orch result 42 --json', 'orch doctor', 'hub doctor'])
})

test('unknown groups fail without entering a concern', async () => {
  const calls: string[] = []
  expect(await dispatchBinary(['unknown'], PLATFORM_SLUG, entries(calls), () => '')).toBe(2)
  expect(calls).toEqual([])
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
      calls.push(`orch ${argv.join(' ')}`)
      return orch
    }
    dispatch.hub = async (argv) => {
      calls.push(`hub ${argv.join(' ')}`)
      return hub
    }
    expect(await dispatchBinary(['machine', 'doctor'], PLATFORM_SLUG, dispatch, () => '')).toBe(
      result,
    )
    expect(calls).toEqual(['orch doctor', 'hub doctor'])
  },
)

test('composite options reach only the owner that declares them', async () => {
  const calls: string[] = []
  expect(
    await dispatchBinary(
      ['record', 'sync', '--backfill', '--since', '2026-01-01T00:00:00Z'],
      PLATFORM_SLUG,
      entries(calls),
      () => '',
    ),
  ).toBe(0)
  expect(calls).toEqual(['orch sync --backfill', 'hub collect --since 2026-01-01T00:00:00Z'])
})

test('composites fail fast except for doctor and never start collect watch', async () => {
  const calls: string[] = []
  const dispatch = entries(calls)
  dispatch.orch = async (argv) => {
    calls.push(`orch ${argv.join(' ')}`)
    return 7
  }
  expect(await dispatchBinary(['record', 'sync'], PLATFORM_SLUG, dispatch, () => '')).toBe(7)
  expect(calls).toEqual(['orch sync'])
  expect(
    await dispatchBinary(['record', 'sync', '--watch'], PLATFORM_SLUG, entries([]), () => ''),
  ).toBe(2)
})
