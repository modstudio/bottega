import { createFileRoute, Outlet } from '@tanstack/react-router'
import { DocsPage } from '@/docs/page'
import { isScope } from '@/docs/scope'
import { hostedOrigin } from '@/lib/hub-mode'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'
import { DOC_SCOPES, type DocScope } from '../../../../shared/docs.ts'

export { DOC_SCOPES, type DocScope, isScope }

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
