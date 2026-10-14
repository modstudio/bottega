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
    runExec: call('runExec'),
    askProxy: call('askProxy'),
    retrievalSearch: async (argv) => {
      calls.push(`retrievalSearch ${argv.join(' ')}`)
    },
    checkAttribution: call('checkAttribution'),
    schemaCheck: call('schemaCheck'),
  }
}

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
