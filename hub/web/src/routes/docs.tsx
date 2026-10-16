import { createFileRoute, Outlet } from '@tanstack/react-router'
import { DocsPage } from './-docs-page'
import { hostedOrigin } from '@bottega/hub-data/hub-mode'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'

export const Route = createFileRoute('/docs')({
  component: DocsLayout,
  head: () => (hostedOrigin().kind === 'public' ? { meta: [{ title: PLATFORM_NAME }] } : {}),
})

function DocsLayout() {
  return (
    <>
      <DocsPage />
      <Outlet />
    </>
  )
}
