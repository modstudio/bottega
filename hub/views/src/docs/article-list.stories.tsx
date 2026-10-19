import type { Meta, StoryObj } from '@storybook/react-vite'
import { ArticleList } from './article-list'

const rows = [
  {
    item: {
      id: 'guide',
      slug: 'guide',
      title: 'First run',
      parentId: null,
      position: 0,
      updatedAt: '2026-10-18T12:00:00Z',
      scope: 'global' as const,
      subject: null,
      audiences: ['internal'] as ['internal'],
      status: 'current' as const,
      kind: 'article' as const,
      summary: 'Dispatch a first run.',
      summarySource: 'written' as const,
      replacementSlug: null,
      delivery: 'demand' as const,
    },
    depth: 0 as const,
    linked: true,
  },
]
const meta = {
  title: 'Views/Docs/ArticleList',
  component: ArticleList,
  args: {
    rows,
    renderLink: (_item, children) => <a href="#guide">{children}</a>,
  },
} satisfies Meta<typeof ArticleList>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
