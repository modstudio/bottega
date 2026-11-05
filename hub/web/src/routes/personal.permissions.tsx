import { createFileRoute } from '@tanstack/react-router'
import { PersonalPermissionsPage } from './-personal-permissions'

export const Route = createFileRoute('/personal/permissions')({
  component: PersonalPermissionsPage,
})
