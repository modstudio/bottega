import type { Meta, StoryObj } from '@storybook/react-vite'
import { Identifier } from './identifier'

const meta: Meta = { title: 'Primitives/Identifier', component: Identifier } satisfies Meta<
  typeof Identifier
>
export default meta
export const Default: StoryObj<typeof meta> = { args: { children: 'DEV-1378' } }
