import type { Meta, StoryObj } from '@storybook/react-vite'
import { Badge, type Tone } from './badge'

const meta: Meta = { title: 'Primitives/Badge', component: Badge }
export default meta
type Story = StoryObj<typeof meta>
const tones: Tone[] = ['neutral', 'success', 'warning', 'error', 'info', 'progress']

export const Tones: Story = {
  render: () => (
    <>
      {tones.map((tone) => (
        <Badge key={tone} tone={tone}>
          {tone}
        </Badge>
      ))}
    </>
  ),
}
export const States: Story = {
  render: () => (
    <>
      <Badge emphasis="solid">solid</Badge>
      <Badge dot>live</Badge>
      <Badge identifier>DEV-1378</Badge>
      <Badge icon={false}>without icon</Badge>
    </>
  ),
}
