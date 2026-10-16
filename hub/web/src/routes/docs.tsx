import { hostedOrigin } from '@bottega/hub-data/hub-mode'
import { createFileRoute, Outlet } from '@tanstack/react-router'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'
import { DocsPage } from './-docs-page'

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
