import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { QueryClientProvider } from '@tanstack/react-query'
import type * as TestingLibrary from '@testing-library/react/pure'
import { createElement, type ReactNode } from 'react'
import { queryClient } from './client.ts'
import { useTaskList } from './use-task-list.ts'

let testing: typeof TestingLibrary
let registeredFetch: typeof globalThis.fetch
let requests: string[]

beforeAll(async () => {
  registeredFetch = globalThis.fetch
  testing = await import('@testing-library/react/pure')
})

afterEach(() => {
  testing.cleanup()
  queryClient.clear()
})

afterAll(() => {
  globalThis.fetch = registeredFetch
  window.fetch = registeredFetch
})

const input = {
  hours: 24 as const,
  filters: { agent: '', project: '', source: '' },
}

const trpcResponse = () =>
  new Response(JSON.stringify([{ result: { data: {} } }]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

function recordRequests() {
  requests = []
  globalThis.fetch = (async (request) => {
    requests.push(String(request))
    return trpcResponse()
  }) as typeof globalThis.fetch
  window.fetch = globalThis.fetch
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children)

test('local flight reaches only work.flight', async () => {
  recordRequests()
  testing.renderHook(() => useTaskList('flight', input, true), { wrapper })
  await testing.waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toContain('work.flight')
  expect(requests[0]).not.toContain('work.done')
  expect(requests[0]).not.toContain('record.')
})

test('local done reaches only work.done', async () => {
  recordRequests()
  testing.renderHook(() => useTaskList('done', input, true), { wrapper })
  await testing.waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toContain('work.done')
  expect(requests[0]).not.toContain('work.flight')
  expect(requests[0]).not.toContain('record.')
})

test('pausing stops polling and unpausing resumes it', async () => {
  recordRequests()
  const rendered = testing.renderHook(
    ({ paused }: { paused: boolean }) => useTaskList('flight', input, paused, 20),
    { wrapper, initialProps: { paused: true } },
  )
  await testing.waitFor(() => expect(requests).toHaveLength(1))
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(requests).toHaveLength(1)

  rendered.rerender({ paused: false })
  await testing.waitFor(() => expect(requests.length).toBeGreaterThan(1))
  expect(requests.every((request) => request.includes('work.flight'))).toBeTrue()
})
