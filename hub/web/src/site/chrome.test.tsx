import { expect, test } from 'bun:test'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { SiteHeader } from './chrome.tsx'

async function renderHeader(identity: 'signed-in' | 'signed-out', appSignInHref?: string) {
  const root = createRootRoute({
    component: () => <SiteHeader identity={identity} appSignInHref={appSignInHref} />,
  })
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

test('public-site sign in and open-app actions use full app navigations', async () => {
  const appSignIn = 'https://app.example.test/sign-in'
  const signedOut = await renderHeader('signed-out', appSignIn)
  expect(signedOut).toContain(`<a href="${appSignIn}">Sign in</a>`)
  const signedIn = await renderHeader('signed-in', appSignIn)
  expect(signedIn).toContain(`<a href="${appSignIn}">Open app</a>`)
})

test('site header offers the app to signed-in visitors', async () => {
  const html = await renderHeader('signed-in')
  expect(html).toContain('href="/flight"')
  expect(html).toContain('Open app')
  expect(html).not.toContain('Sign in')
})

test('mobile navigation trigger exposes its dialog relationship and state', async () => {
  const html = await renderHeader('signed-out')
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain('aria-controls="site-mobile-menu"')
  expect(html).toContain('id="site-mobile-menu"')
  expect(html).toContain('aria-label="Product navigation"')
})
