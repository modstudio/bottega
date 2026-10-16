import type { Meta, StoryObj } from '@storybook/react-vite'
import { ProjectName } from './project-mark'

const meta: Meta = { title: 'Patterns/ProjectName', component: ProjectName } satisfies Meta<
  typeof ProjectName
>
export default meta
export const Default: StoryObj<typeof meta> = { args: { name: 'Atelier', color: '#315cbd' } }
