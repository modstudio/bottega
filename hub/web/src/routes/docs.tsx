import { createFileRoute, Outlet } from '@tanstack/react-router'
import { DocsPage } from '@/docs/page'
import { DOC_SCOPES, type DocScope } from '../../../../shared/docs.ts'

export { DOC_SCOPES, type DocScope }

function isScope(value: string): value is DocScope {
  return (DOC_SCOPES as readonly string[]).includes(value)
}

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

export { isScope }
