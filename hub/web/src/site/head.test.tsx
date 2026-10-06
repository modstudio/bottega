import { expect, test } from 'bun:test'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  HeadContent,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { siteHead } from './route.ts'

test('marketing home metadata reaches the document head', async () => {
  const root = createRootRoute({
    component: () => (
      <html lang="en">
        <head>
          <HeadContent />
        </head>
        <body>
          <Outlet />
        </body>
      </html>
    ),
  })
  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    head: siteHead,
    component: () => <main>Marketing home</main>,
  })
  const router = createRouter({
    routeTree: root.addChildren([home]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()

  const document = renderToStaticMarkup(<RouterProvider router={router} />)
  expect(document).toContain(`<title>Bottega</title>`)
  expect(document).toContain(
    '<meta name="description" content="You keep every decision. Workers do the rest.',
  )
})
