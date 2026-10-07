import { createFileRoute } from '@tanstack/react-router'
import { ReviewPage } from '@/site/review'
import { requireHostedSite, siteHead } from '@/site/route'
export const Route = createFileRoute('/product/review')({
  beforeLoad: requireHostedSite,
  component: ReviewPage,
  head: siteHead,
})
