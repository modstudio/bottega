import { createFileRoute } from '@tanstack/react-router'
import { PersonalInstructionsPage } from './-personal-instructions'

export const Route = createFileRoute('/personal/instructions')({
  component: PersonalInstructionsPage,
})
