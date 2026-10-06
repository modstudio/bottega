import { createFileRoute } from '@tanstack/react-router'
import { requireHostedSite, siteHead } from '@/site/route'
import { WorkflowsPage } from '@/site/workflows'
export const Route = createFileRoute('/product/workflows')({
  beforeLoad: requireHostedSite,
  component: WorkflowsPage,
  head: siteHead,
})
