import { createFileRoute } from '@tanstack/react-router'
import { WorkersPage } from '@/site/pages'
import { requireHostedSite, siteHead } from '@/site/route'
export const Route = createFileRoute('/product/workers')({
  beforeLoad: requireHostedSite,
  component: WorkersPage,
  head: siteHead,
})
