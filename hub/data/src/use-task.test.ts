import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { QueryClientProvider } from '@tanstack/react-query'
import type * as TestingLibrary from '@testing-library/react/pure'
import { createElement, type ReactNode } from 'react'
import { queryClient } from './client.ts'
import { useTask } from './use-task.ts'

let testing: typeof TestingLibrary
let registeredFetch: typeof globalThis.fetch
let fetchHandler: typeof globalThis.fetch

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost' })
  registeredFetch = globalThis.fetch
  globalThis.fetch = ((...args) => fetchHandler(...args)) as typeof globalThis.fetch
  window.fetch = globalThis.fetch
  testing = await import('@testing-library/react/pure')
})

afterEach(() => {
  testing.cleanup()
  queryClient.clear()
})

afterAll(async () => {
  globalThis.fetch = registeredFetch
  window.fetch = registeredFetch
  await GlobalRegistrator.unregister()
})

const capability = { allowed: true as const }
const detail = (bodyVersion: string) => ({
  task: {
    key: 'DEV-1',
    recordId: 'record-1',
    project: 'workshop',
    title: 'Task',
    status: 'open',
    statusCategory: 'open',
    parentKey: null,
    body: 'body',
    assignee: null,
    source: 'local',
    sourceProtocol: null,
    updatedAt: '2026-10-16T12:00:00.000Z',
    spaceName: null,
  },
  bodyVersion,
  comments: [],
  documents: [],
  statusEvents: [],
  runs: [],
  measures: null,
  measureCoverage: null,
  capabilities: {
    setTitle: capability,
    setStatus: capability,
    setBody: capability,
    comment: capability,
    documents: capability,
    statusVocabulary: ['open'],
  },
})

const trpcResponse = (value: unknown) =>
  new Response(JSON.stringify([{ result: { data: value } }]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

test('task body conflict reload clears conflict and the next save uses the refreshed version', async () => {
  let reads = 0
  let saves = 0
  const versions: string[] = []
  fetchHandler = (async (input, init) => {
    const url = String(input)
    if (url.includes('work.task')) {
      reads++
      return trpcResponse(detail(reads === 1 ? 'old-version' : 'new-version'))
    }
    if (url.includes('work.setBody')) {
      const body = JSON.parse(String(init?.body)) as { 0: { expectedVersion: string } }
      versions.push(body[0].expectedVersion)
      saves++
      if (saves === 1) {
        return new Response(
          JSON.stringify([
            {
              error: {
                message: 'body conflict',
                code: -32009,
                data: { code: 'CONFLICT', httpStatus: 409, path: 'work.setBody' },
              },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return trpcResponse({})
    }
    throw new Error(`unexpected request ${url}`)
  }) as typeof globalThis.fetch

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  const rendered = testing.renderHook(() => useTask('DEV-1', 'record-1'), { wrapper })
  await testing.waitFor(() =>
    expect(rendered.result.current.detail?.bodyVersion).toBe('old-version'),
  )

  await testing.act(() => rendered.result.current.actions.setBody.run('first edit'))
  await testing.waitFor(() => expect(rendered.result.current.actions.setBody.conflict).toBeTrue())

  await testing.act(() => rendered.result.current.actions.setBody.reload())
  await testing.waitFor(() => {
    expect(rendered.result.current.actions.setBody.conflict).toBeFalse()
    expect(rendered.result.current.detail?.bodyVersion).toBe('new-version')
  })

  await testing.act(() => rendered.result.current.actions.setBody.run('second edit'))
  expect(versions).toEqual(['old-version', 'new-version'])
})

test('a draft whose body conflicts saves no title', async () => {
  const writes: string[] = []
  fetchHandler = (async (input) => {
    const url = String(input)
    if (url.includes('work.task')) return trpcResponse(detail('old-version'))
    if (url.includes('work.setTitle')) {
      writes.push('title')
      return trpcResponse({})
    }
    if (url.includes('work.setBody')) {
      writes.push('body')
      return new Response(
        JSON.stringify([
          {
            error: {
              message: 'body conflict',
              code: -32009,
              data: { code: 'CONFLICT', httpStatus: 409, path: 'work.setBody' },
            },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    throw new Error(`unexpected request ${url}`)
  }) as typeof globalThis.fetch

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  const rendered = testing.renderHook(() => useTask('DEV-1', 'record-1'), { wrapper })
  await testing.waitFor(() => expect(rendered.result.current.detail).not.toBeNull())

  let saved: boolean | undefined
  await testing.act(async () => {
    saved = await rendered.result.current.actions.saveDraft.run({
      title: 'Renamed',
      body: 'edited body',
    })
  })
  expect(saved).toBeFalse()
  expect(writes).toEqual(['body'])
  await testing.waitFor(() => expect(rendered.result.current.actions.saveDraft.conflict).toBeTrue())
})
