import type { Meta, StoryObj } from '@storybook/react-vite'
import { Callout } from './callout'

const meta: Meta = { title: 'Patterns/Callout', component: Callout }
export default meta
export const Tones: StoryObj<typeof meta> = {
  render: () => (
    <>
      {(['neutral', 'success', 'warning', 'error', 'info', 'progress'] as const).map((tone) => (
        <Callout key={tone} tone={tone} title={`${tone} note`}>
          Plausible supporting detail.
        </Callout>
      ))}
    </>
  ),
}
