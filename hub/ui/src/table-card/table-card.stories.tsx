import type { Meta, StoryObj } from '@storybook/react-vite'
import { TableCard } from './table-card'

const meta: Meta = { title: 'Layout/TableCard', component: TableCard }
export default meta
export const Full: StoryObj<typeof meta> = {
  args: {
    heading: 'Recent runs',
    search: <input aria-label="Search runs" />,
    filters: <button type="button">Project</button>,
    filtersActive: 1,
    actions: <button type="button">Start run</button>,
    meta: '24 runs',
    footer: 'Page 1',
    children: <div>DEV-1378 · running</div>,
  },
}
export const WithPanel: StoryObj<typeof meta> = {
  args: {
    heading: 'Tasks',
    children: <div>DEV-1378</div>,
    panel: <aside aria-label="Task detail">Storybook catalog</aside>,
  },
}
