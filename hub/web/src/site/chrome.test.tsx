import { expect, test } from 'bun:test'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { SiteHeader } from './chrome.tsx'

async function renderHeader(identity: 'signed-in' | 'signed-out') {
  const root = createRootRoute({ component: () => <SiteHeader identity={identity} /> })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

test('site header offers sign in to signed-out visitors', async () => {
  const html = await renderHeader('signed-out')
  expect(html).toContain('href="/sign-in"')
  expect(html).toContain('Sign in')
  expect(html).not.toContain('Open app')
})

test('site header offers the app to signed-in visitors', async () => {
  const html = await renderHeader('signed-in')
  expect(html).toContain('href="/flight"')
  expect(html).toContain('Open app')
  expect(html).not.toContain('Sign in')
})
