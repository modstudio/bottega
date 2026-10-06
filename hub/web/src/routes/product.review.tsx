import { createFileRoute } from '@tanstack/react-router'
import { ReviewPage } from '@/site/pages'
import { requireHostedSite, siteHead } from '@/site/route'
export const Route = createFileRoute('/product/review')({
  beforeLoad: requireHostedSite,
  component: ReviewPage,
  head: siteHead,
})
