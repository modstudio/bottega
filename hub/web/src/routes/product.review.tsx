import { createFileRoute } from '@tanstack/react-router'
import { ReviewPage } from '@/site/pages'
import { requireHostedSite } from '@/site/route'
export const Route = createFileRoute('/product/review')({
  beforeLoad: requireHostedSite,
  component: ReviewPage,
  head: () => ({
    meta: [
      { title: 'Bottega' },
      {
        name: 'description',
        content:
          'You keep every decision. Workers do the rest. Bottega runs the whole task lifecycle for coding agents: declared workflows, multi-lens review on a budget, a board across every project.',
      },
    ],
  }),
})
