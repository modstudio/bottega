import { createFileRoute } from '@tanstack/react-router'
import { BoardPage } from '@/site/pages'
import { requireHostedSite, siteHead } from '@/site/route'
export const Route = createFileRoute('/product/board')({
  beforeLoad: requireHostedSite,
  component: BoardPage,
  head: siteHead,
})
