import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { AppShell, type NavSection, type RenderLink } from './app-shell'

const Mark = () => <span aria-hidden>◆</span>
const Icon = () => <span aria-hidden>•</span>
const nav: NavSection[] = [
  {
    id: 'work',
    entries: [
      { to: '/runs', label: 'Runs', icon: Icon },
      { label: 'Knowledge', icon: Icon, items: [{ to: '/docs', label: 'Docs', icon: Icon }] },
    ],
  },
]
const renderLink: RenderLink = (item, props) => (
  <a
    href={item.to}
    className={props.className}
    onClick={(event) => {
      event.preventDefault()
      props.onClick?.()
    }}
  >
    {props.children}
  </a>
)
const meta: Meta = {
  title: 'Layout/AppShell',
  component: AppShell,
  args: {
    name: 'Atelier',
    mark: <Mark />,
    nav,
    renderLink,
    isActive: (to: string) => to === '/runs',
    topbar: <button type="button">Refresh</button>,
    railFooter: <span>Local</span>,
    storageKey: 'storybook:rail',
    children: <p>Dashboard content</p>,
  },
}
export default meta
export const Open: StoryObj<typeof meta> = {}
export const ForcedCollapsed: StoryObj<typeof meta> = { args: { collapsed: true } }
export const Keyboard: StoryObj<typeof meta> = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = canvas.getByRole('button', { name: 'Collapse navigation' })
    toggle.focus()
    await userEvent.keyboard('{Enter}')
    const expand = canvas.getByRole('button', { name: 'Expand navigation' })
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
  },
}
