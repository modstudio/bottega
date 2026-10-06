import { createFileRoute } from '@tanstack/react-router'
import { WorkflowsPage } from '@/site/pages'
import { requireHostedSite, siteHead } from '@/site/route'
export const Route = createFileRoute('/product/workflows')({
  beforeLoad: requireHostedSite,
  component: WorkflowsPage,
  head: siteHead,
})
