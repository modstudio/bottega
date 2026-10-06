import { createFileRoute, Outlet } from '@tanstack/react-router'
import { DocsPage } from '@/docs/page'
import { isScope } from '@/docs/scope'
import { DOC_SCOPES, type DocScope } from '../../../../shared/docs.ts'

export { DOC_SCOPES, type DocScope, isScope }

export const Route = createFileRoute('/docs')({
  component: DocsLayout,
})

function DocsLayout() {
  return (
    <>
      <DocsPage />
      <Outlet />
    </>
  )
}
