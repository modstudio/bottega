import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { queryClient, trpc } from '@bottega/hub-data/client'
import { useArticleSave, useCurrentArticle } from '@bottega/hub-data/docs/actions'
import { useStoredDocument } from '@bottega/hub-data/docs/use-docs'
import { QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import type * as TestingLibrary from '@testing-library/react/pure'
import type userEventLibrary from '@testing-library/user-event'
import { useMemo } from 'react'
import { isScope } from '../docs/scope.ts'
import type { DocsDoc } from '../docs/types.ts'
import { DocsPage } from './-docs-page.tsx'

let testing: typeof TestingLibrary
let userEvent: typeof userEventLibrary
let registeredFetch: typeof globalThis.fetch
let fetchHandler: (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost' })
  registeredFetch = globalThis.fetch
  globalThis.fetch = ((...args) => fetchHandler(...args)) as typeof globalThis.fetch
  testing = await import('@testing-library/react/pure')
  userEvent = (await import('@testing-library/user-event')).default
})

afterEach(() => {
  testing.cleanup()
  queryClient.clear()
  window.localStorage.clear()
})

afterAll(async () => {
  globalThis.fetch = registeredFetch
  await GlobalRegistrator.unregister()
})

const doc: DocsDoc = {
  id: 'doc-1',
  slug: 'article',
  title: 'Article title',
  body: 'Article body',
  parentId: null,
  position: 0,
  updatedAt: '2026-10-15T12:00:00.000Z',
  scope: 'project',
  subject: 'workshop',
  projectName: 'workshop',
  audiences: ['internal'],
  status: 'current',
  kind: 'article',
  summarySource: 'derived',
  replacementSlug: null,
}

function seedQuery(key: readonly unknown[], value: unknown) {
  queryClient.setQueryData(key, value)
}

function seedLocalDoc() {
  seedQuery(trpc.doc.tree.queryOptions({}).queryKey, { items: [doc] })
  const address = { scope: 'project' as const, subject: 'workshop', slug: 'article' }
  seedQuery(trpc.doc.read.queryOptions(address).queryKey, doc)
  seedQuery(trpc.doc.get.queryOptions(address).queryKey, {
    title: doc.title,
    body: doc.body,
    revision: 'revision-1',
  })
  seedQuery(trpc.doc.history.queryOptions(address).queryKey, [])
  seedQuery(trpc.subject.list.queryOptions({ project: 'workshop' }).queryKey, [])
}

function docsRouter() {
  const root = createRootRoute({ component: Outlet })
  const docs = createRoute({ getParentRoute: () => root, path: 'docs', component: DocsPage })
  const detail = createRoute({
    getParentRoute: () => docs,
    path: '$scope/$subject/$slug',
    validateSearch: (search: Record<string, unknown>) => ({
      edit: search.edit === true || search.edit === 'true',
    }),
    component: () => null,
  })
  const destination = createRoute({
    getParentRoute: () => root,
    path: 'destination',
    component: () => <p>Destination reached</p>,
  })
  return createRouter({
    routeTree: root.addChildren([docs.addChildren([detail]), destination]),
    history: createMemoryHistory({
      initialEntries: ['/docs/project/workshop/article?edit=true'],
    }),
  })
}

test('unsaved edits block navigation until the reader discards them', async () => {
  fetchHandler = (() => {
    throw new Error('the seeded docs route must not fetch')
  }) as typeof fetchHandler
  seedLocalDoc()
  const router = docsRouter()
  await router.load()
  testing.render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  const user = userEvent.setup()
  const title = await testing.screen.findByLabelText('Title')
  console.log('leave:title')
  await user.clear(title)
  await user.type(title, 'Changed title')
  console.log('leave:changed')

  const navigate = router.navigate as unknown as (options: { to: string }) => Promise<void>
  void navigate({ to: '/destination' })
  expect(await testing.screen.findByText('Discard unsaved changes?')).toBeTruthy()
  console.log('leave:blocked')
  expect(router.state.location.pathname).toBe('/docs/project/workshop/article')

  await user.click(testing.screen.getByRole('button', { name: 'Keep editing' }))
  console.log('leave:kept')
  expect(testing.screen.queryByText('Discard unsaved changes?')).toBeNull()
  expect(router.state.location.pathname).toBe('/docs/project/workshop/article')

  void navigate({ to: '/destination' })
  await user.click(await testing.screen.findByRole('button', { name: 'Discard' }))
  console.log('leave:discarded')
  expect(await testing.screen.findByText('Destination reached')).toBeTruthy()
  expect(router.state.location.pathname).toBe('/destination')
})

const hostedDoc = {
  ...doc,
  id: '01990000-0000-7000-8000-000000000001',
  spaceId: '01990000-0000-7000-8000-000000000002',
}
const oldRevision = '01990000-0000-7000-8000-000000000003'
const newRevision = '01990000-0000-7000-8000-000000000004'

function trpcResponse(json: unknown, status = 200) {
  return new Response(JSON.stringify([{ result: { data: { json } } }]), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function useHostedArticleActions() {
  const stored = useStoredDocument(hostedDoc, 'hosted', true, isScope)
  const save = useArticleSave('hosted', hostedDoc, stored?.revision, isScope)
  const reload = useCurrentArticle('hosted', hostedDoc, isScope, save.reset)
  return useMemo(() => ({ stored, save, reload }), [stored, save, reload])
}

describe('hosted conflict recovery', () => {
  test('reload clears the conflict and the next save uses the refreshed revision', async () => {
    seedQuery(trpc.record.doc.queryOptions({ id: hostedDoc.id }).queryKey, hostedDoc)
    seedQuery(
      trpc.record.docRevisions.queryOptions({ id: hostedDoc.id }).queryKey,
      { items: [{ id: oldRevision }] },
    )
    const saveRevisions: string[] = []
    let saves = 0
    fetchHandler = async (input, init) => {
      const url = String(input)
      if (url.includes('record.saveDoc')) {
        const body = JSON.parse(String(init?.body)) as { 0: { json: { expectedRevision: string } } }
        saveRevisions.push(body[0].json.expectedRevision)
        saves += 1
        if (saves === 1) {
          return new Response(
            JSON.stringify([
              {
                error: {
                  json: {
                    message: 'revision conflict',
                    code: -32009,
                    data: { code: 'CONFLICT', httpStatus: 409, path: 'record.saveDoc' },
                  },
                },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return trpcResponse({ revision: newRevision })
      }
      if (url.includes('record.docRevisions'))
        return trpcResponse({ items: [{ id: newRevision }] })
      if (url.includes('record.doc'))
        return trpcResponse({ ...hostedDoc, title: 'Current title', body: 'Current body' })
      throw new Error(`unexpected request ${url}`)
    }

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const rendered = testing.renderHook(useHostedArticleActions, { wrapper })
    expect(rendered.result.current.stored?.revision).toBe(oldRevision)
    console.log('save refused', rendered.result.current.save.refused)
    await testing.act(() =>
      rendered.result.current.save.run({ title: 'Mine', body: 'Mine', reason: 'First save' }),
    )
    console.log(rendered.result.current.save.error, saveRevisions)
    expect(rendered.result.current.save.conflict).toBeTrue()

    await testing.act(() => rendered.result.current.reload())
    expect(rendered.result.current.save.conflict).toBeFalse()
    expect(rendered.result.current.stored?.revision).toBe(newRevision)

    await testing.act(() =>
      rendered.result.current.save.run({ title: 'Mine', body: 'Mine', reason: 'Second save' }),
    )
    expect(saveRevisions).toEqual([oldRevision, newRevision])
  })
})
