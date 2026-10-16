import type { Meta, StoryObj } from '@storybook/react-vite'
import { Separator } from './separator'

const meta: Meta = { title: 'Primitives/Separator', component: Separator } satisfies Meta<
  typeof Separator
>
export default meta
export const Horizontal: StoryObj<typeof meta> = { args: {} }
export const Vertical: StoryObj<typeof meta> = {
  args: { orientation: 'vertical' },
  decorators: [(story) => <div style={{ height: 80 }}>{story()}</div>],
}
