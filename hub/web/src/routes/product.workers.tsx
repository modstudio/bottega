import { createFileRoute } from '@tanstack/react-router'
import { requireHostedSite, siteHead } from '@/site/route'
import { WorkersPage } from '@/site/workers'
export const Route = createFileRoute('/product/workers')({
  beforeLoad: requireHostedSite,
  component: WorkersPage,
  head: siteHead,
})
