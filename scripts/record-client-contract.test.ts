import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Glob } from 'bun'
import {
  CURRENT_CONTRACT_PATH,
  createRecordingTransport,
  generateRecordClientContract,
  RELEASED_CONTRACT_DIRECTORY,
  type RecordClientContractEntry,
  recordClientContractApp,
  serializeRecordClientContract,
} from './record-client-contract.ts'

test('the recording transport captures a normalized in-process request', async () => {
  const entries: RecordClientContractEntry[] = []
  const transport = createRecordingTransport(entries, () => 'transport.sample')
  await transport('https://record.example.test/v1/board/changes?after=0', {
    headers: { 'x-record-space': 'space-a' },
  })
  expect(entries).toEqual([
    {
      sample: 'transport.sample',
      method: 'GET',
      path: '/v1/board/changes',
      query: [['after', '0']],
      body: null,
      recordSpace: true,
      status: 200,
    },
  ])
})

function routeRegistered(
  app: ReturnType<typeof recordClientContractApp>,
  entry: RecordClientContractEntry,
) {
  const matches = app.router.match(entry.method, entry.path) as unknown as [
    Array<[[unknown, { method: string; path: string }], unknown]>,
  ]
  return matches[0].some((match) => {
    const route = match[0][1]
    return route.method === entry.method || route.path === '/api/auth/*'
  })
}

async function replay(version: string, entries: RecordClientContractEntry[]): Promise<string[]> {
  const app = recordClientContractApp()
  const failures: string[] = []
  for (const entry of entries) {
    const label = `${version} ${entry.sample} ${entry.method} ${entry.path}`
    if (!routeRegistered(app, entry)) {
      failures.push(`${label}: route is no longer registered`)
      continue
    }
    const url = new URL(entry.path, 'https://record.example.test')
    for (const [name, value] of entry.query) url.searchParams.append(name, value)
    const headers = new Headers({ authorization: 'Bearer contract-token' })
    if (entry.recordSpace) headers.set('x-record-space', 'space-a')
    if (entry.body !== null) headers.set('content-type', 'application/json')
    const response = await app.request(
      new Request(url, {
        method: entry.method,
        headers,
        body: entry.body === null ? undefined : JSON.stringify(entry.body),
      }),
    )
    if ([400, 405, 415, 422].includes(response.status) && response.status !== entry.status)
      failures.push(`${label}: recorded ${entry.status}, replayed ${response.status}`)
    await response.body?.cancel().catch(() => undefined)
  }
  return failures
}

test('the current record client contract is fresh', async () => {
  const generated = serializeRecordClientContract(await generateRecordClientContract())
  expect(generated, 'run bun scripts/record-client-contract.ts --update').toBe(
    readFileSync(CURRENT_CONTRACT_PATH, 'utf8'),
  )
})

test('released record client contracts replay against the current server', async () => {
  const failures: string[] = []
  for await (const file of new Glob('*.json').scan(RELEASED_CONTRACT_DIRECTORY)) {
    const version = file.replace(/\.json$/, '')
    const entries = JSON.parse(
      readFileSync(resolve(RELEASED_CONTRACT_DIRECTORY, file), 'utf8'),
    ) as RecordClientContractEntry[]
    failures.push(...(await replay(version, entries)))
  }
  expect(failures).toEqual([])
})
