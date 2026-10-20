import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { DocsReading } from './reading'

const onSelect = fn()
const doc = {
  id: 'guide',
  slug: 'guide',
  title: 'First run',
  parentId: null,
  position: 0,
  updatedAt: '2026-10-18T12:00:00Z',
  scope: 'global',
  subject: null,
  audiences: ['customer'] as ['customer'],
  status: 'current' as const,
  kind: 'article' as const,
  summarySource: 'derived' as const,
  replacementSlug: null,
  delivery: 'demand' as const,
  body: '## Start\n\nDispatch a run.',
}
const next = { ...doc, id: 'next', slug: 'next', title: 'Next step' }
const meta = {
  title: 'Views/Docs/Reading',
  component: DocsReading,
  parameters: { layout: 'fullscreen' },
  args: {
    doc,
    crumbs: [],
    around: { previous: null, next },
    onSelect,
    replacement: null,
    pending: false,
    wide: false,
    onWide: fn(),
    signedIn: false,
    audience: 'customer',
    tree: [],
    renderLink: (_item, children) => <a href="#guide">{children}</a>,
  },
} satisfies Meta<typeof DocsReading>
export default meta
type Story = StoryObj<typeof meta>
export const CanonFrontmatter: Story = {
  args: {
    doc: {
      ...doc,
      title: 'Docs',
      body: '---\ndescription: Docs, canon store, resume briefs and the project register.\npaths:\n  - orchestrator/src/**/docs.ts\n  - orchestrator/src/**/canon*.ts\n---\n\n# Docs\n\nOperator docs are markdown facts about an installation.',
    },
  },
}
export const ResumeBriefFrontmatter: Story = {
  args: {
    doc: {
      ...doc,
      title: 'Sync redesign',
      body: '---\nstatus: open\nepic: DEV-1208\ntask: DEV-1214\nproject: workshop\nwritten: 2026-10-20T15:40:00Z\n---\n\n# Sync redesign\n\n## Next action\n\n**NEXT ACTION: specify K7b-2 from DEV-1214/13.**',
    },
  },
}
export const OpensNext: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: /Next step/ }))
    await expect(onSelect).toHaveBeenCalledWith(next)
  },
}
