import { createFileRoute } from '@tanstack/react-router'
import { WorkflowsPage } from '@/site/pages'
import { requireHostedSite } from '@/site/route'
export const Route = createFileRoute('/product/workflows')({
  beforeLoad: requireHostedSite,
  component: WorkflowsPage,
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
