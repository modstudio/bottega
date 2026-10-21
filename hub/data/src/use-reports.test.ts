import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { QueryClientProvider } from '@tanstack/react-query'
import type * as TestingLibrary from '@testing-library/react/pure'
import { createElement, type ReactNode } from 'react'
import { queryClient } from './client.ts'
import { useHostedReports } from './use-reports.ts'

let testing: typeof TestingLibrary
let registeredFetch: typeof globalThis.fetch
let requests: { procedure: string; input: unknown }[]

const windowInput = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' }
const project = 'workshop'
const people = [
  { userId: '11111111-1111-4111-8111-111111111111', name: 'One', email: 'one@example.com' },
  { userId: '22222222-2222-4222-8222-222222222222', name: 'Two', email: 'two@example.com' },
]

beforeAll(async () => {
  registeredFetch = globalThis.fetch
  globalThis.fetch = fakeFetch as typeof globalThis.fetch
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
})

function fakeFetch(input: string | URL | Request) {
  const url = new URL(String(input), 'http://localhost')
  const procedures = url.pathname.slice(url.pathname.indexOf('/trpc/') + 6).split(',')
  const encoded = JSON.parse(url.searchParams.get('input') ?? '{}') as Record<string, unknown>
  const response = procedures.map((procedure, index) => {
    const procedureInput = encoded[String(index)]
    requests.push({ procedure, input: procedureInput })
    const data =
      procedure === 'record.projects'
        ? [{ name: 'another-project', color: null, colorDark: null }]
        : procedure === 'record.measurePeople'
          ? people
          : null
    return { result: { data } }
  })
  return Promise.resolve(
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children)

function inputsFor(procedure: string) {
  return requests
    .filter((request) => request.procedure === procedure)
    .map((request) => request.input)
}

test('space reports request space measures', async () => {
  requests = []
  testing.renderHook(
    () => useHostedReports(windowInput, { kind: 'space', chosenProject: '', chosenPerson: '' }),
    { wrapper },
  )

  await testing.waitFor(() =>
    expect(inputsFor('record.measures')).toContainEqual({
      ...windowInput,
      scope: { kind: 'space' },
    }),
  )
})

test('project reports scope measures and people to the chosen project', async () => {
  requests = []
  testing.renderHook(
    () =>
      useHostedReports(windowInput, {
        kind: 'project',
        chosenProject: project,
        chosenPerson: '',
      }),
    { wrapper },
  )

  await testing.waitFor(() => {
    expect(inputsFor('record.measures')).toContainEqual({
      ...windowInput,
      scope: { kind: 'project', project },
    })
    expect(inputsFor('record.measurePeople')).toContainEqual({ ...windowInput, project })
  })
})

test('project reports request per-person measures within the project', async () => {
  requests = []
  testing.renderHook(
    () =>
      useHostedReports(windowInput, {
        kind: 'project',
        chosenProject: project,
        chosenPerson: '',
      }),
    { wrapper },
  )

  await testing.waitFor(() => {
    const measureInputs = inputsFor('record.measures')
    for (const person of people) {
      expect(measureInputs).toContainEqual({
        ...windowInput,
        scope: { kind: 'person', userId: person.userId, project },
      })
    }
  })
})
