import { createFileRoute } from '@tanstack/react-router'
import { ContextPage } from '@/site/pages'
import { requireHostedSite, siteHead } from '@/site/route'
export const Route = createFileRoute('/product/context')({
  beforeLoad: requireHostedSite,
  component: ContextPage,
  head: siteHead,
})
