import { createFileRoute } from '@tanstack/react-router'
import { DocStorePage } from '@/site/doc-store'
import { requireHostedSite, siteHead } from '@/site/route'
export const Route = createFileRoute('/product/doc-store')({
  beforeLoad: requireHostedSite,
  component: DocStorePage,
  head: siteHead,
})
