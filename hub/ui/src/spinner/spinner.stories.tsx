import type { Meta, StoryObj } from '@storybook/react-vite'
import { Spinner } from './spinner'

const meta: Meta = { title: 'Primitives/Spinner', component: Spinner }
export default meta
export const Loading: StoryObj<typeof meta> = { args: { label: 'Loading runs' } }
export const Decorative: StoryObj<typeof meta> = { args: {} }
