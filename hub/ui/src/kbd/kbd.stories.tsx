import type { Meta, StoryObj } from '@storybook/react-vite'
import { Kbd } from './kbd'

const meta: Meta = { title: 'Primitives/Kbd', component: Kbd }
export default meta
export const Shortcut: StoryObj<typeof meta> = { args: { children: '⌘K' } }
