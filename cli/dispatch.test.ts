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
