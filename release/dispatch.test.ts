import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { BOTTEGA_ENTRY_PROTOCOL } from '../shared/self-spawn.ts'
import { dispatchBinary } from './dispatch.ts'

test('top-level help succeeds without dispatching a store-owning concern', async () => {
  const unreachable = async (): Promise<never> => {
    throw new Error('help dispatched an entry')
  }
  const entries = {
    orch: unreachable,
    hub: unreachable,
    runExec: unreachable,
    askProxy: unreachable,
    retrievalSearch: unreachable,
  }
  expect(
    await dispatchBinary(['--help'], PLATFORM_SLUG, entries, () => 'unreachable version'),
  ).toBe(0)
})

test('hidden subcommands route their unchanged arguments without appearing in usage', async () => {
  const calls: Array<{ entry: string; argv: string[] }> = []
  const dispatch = {
    orch: async (argv: string[]) => {
      calls.push({ entry: 'orch', argv })
      return 10
    },
    hub: async (argv: string[]) => {
      calls.push({ entry: 'hub', argv })
      return 11
    },
    runExec: async (argv: string[]) => {
      calls.push({ entry: 'run-exec', argv })
      return 12
    },
    askProxy: async (argv: string[]) => {
      calls.push({ entry: 'ask-proxy', argv })
      return 13
    },
    retrievalSearch: async (argv: string[]) => {
      calls.push({ entry: 'retrieval-search', argv })
    },
  }
  const invokedAs = join('/tmp', PLATFORM_SLUG)
  const runExec = BOTTEGA_ENTRY_PROTOCOL['run-exec'].compiledArguments[0]
  const askProxy = BOTTEGA_ENTRY_PROTOCOL['ask-proxy'].compiledArguments[0]
  const retrievalSearch = BOTTEGA_ENTRY_PROTOCOL['retrieval-search'].compiledArguments[0]

  expect(
    await dispatchBinary([runExec, '1', 'prompt', 'job'], invokedAs, dispatch, () => 'test'),
  ).toBe(12)
  expect(await dispatchBinary([askProxy, 'ignored'], invokedAs, dispatch, () => 'test')).toBe(13)
  expect(
    await dispatchBinary([retrievalSearch, 'query', '--json'], invokedAs, dispatch, () => 'test'),
  ).toBe(0)
  expect(calls).toEqual([
    { entry: 'run-exec', argv: ['1', 'prompt', 'job'] },
    { entry: 'ask-proxy', argv: ['ignored'] },
    { entry: 'retrieval-search', argv: ['query', '--json'] },
  ])
})
